// The replay's production evidence regime: what production knew at each
// deadline, rebuilt from the archive and resolved by the app's own code.
//
// WHY THIS FILE EXISTS
//
// Until 2026-09-16 the replay assembled its GameState directly and seeded half
// of the previous season into every total for the whole season. Production has
// never done that: it reads bootstrap-static, and engine/world.js decides which
// previous-season record stands in. Every tuning experiment was therefore
// measured in a regime production does not run, and the xP audit of that day
// found production projecting every nailed starter to play 64% to 76% of the
// time from gameweek 4, a state no replay had produced.
//
// These tests pin the three things the regime must be:
//
//   1. THE SAME RESOLUTION. The replay's state at a deadline is exactly what
//      `resolveGameState` makes of the rebuilt payloads, so a replay-only tweak
//      cannot creep in between the two.
//   2. THE SAME PAYLOADS. Gameweek 1 is the pre-season payload (last season's
//      totals, nothing played); every later deadline carries this season's
//      totals over the matches before it and nothing after.
//   3. THE SAME PREVIOUS SEASON. It reaches the resolver as an opening-baseline
//      asset the production validator accepts for that season and no other.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import {
  buildDataset, createAccumulator, productionGameStateAt, deadlinePayload, priorSeasonAsset,
  preseasonTotalsFor, eventDeadlines, replaySeason, EVIDENCE_REGIMES,
} from '../js/engine/backtest.js';
import { buildGameState } from '../js/engine/normalize.js';
import { resolveGameState, openingBaselineApplies } from '../js/engine/world.js';
import { validateOpeningBaseline } from '../js/engine/baseline.js';
import { seasonEvidence } from '../js/engine/minutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULES = buildRules(JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8')));

const CLUBS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const SQUAD = 16;
const GWS = 38;

// A full-length season, because the resolver's judgements (is this payload a
// season of its own, has every club played three matches) are claims about a
// 38-gameweek league and a six-gameweek toy answers them differently.
function seasonRows({ year, rotate = 0, newcomer = false }) {
  const rows = [];
  let fixtureId = 0;
  for (let gw = 1; gw <= GWS; gw++) {
    const day = new Date(Date.UTC(year, 7, 10) + (gw - 1) * 7 * 86400000).toISOString();
    for (let pair = 0; pair < CLUBS.length / 2; pair++) {
      fixtureId++;
      const home = ((pair * 2 + gw) % CLUBS.length) + 1;
      const away = ((pair * 2 + 1 + gw) % CLUBS.length) + 1;
      for (const [club, isHome] of [[home, true], [away, false]]) {
        for (let n = 1; n <= SQUAD; n++) {
          // A newcomer replaces squad member 16 of Alpha in the second season.
          const name = newcomer && club === 1 && n === SQUAD ? 'Alpha Newcomer' : `${CLUBS[club - 1]} ${n}`;
          const rank = ((n + gw + rotate) % SQUAD) + 1;
          const minutes = rank <= 11 ? 90 : rank <= 13 ? 20 : 0;
          rows.push({
            gw,
            playerId: club * 100 + n,
            name,
            position: n <= 2 ? 1 : n <= 7 ? 2 : n <= 12 ? 3 : 4,
            teamName: CLUBS[club - 1],
            opponentTeam: isHome ? away : home,
            fixtureId,
            wasHome: isHome,
            kickoff: day,
            minutes,
            starts: rank <= 11 ? 1 : 0,
            totalPoints: minutes ? 2 : 0,
            valueTenths: 40 + n,
            selected: 100000 - n * 1000,
            bonus: rank === 1 ? 3 : 0,
            bps: minutes ? 20 : 0,
            saves: 0,
            goalsScored: rank === 2 ? 1 : 0,
            assists: rank === 3 ? 1 : 0,
            cleanSheets: 0,
            goalsConceded: 1,
            yellowCards: 0,
            redCards: 0,
            ownGoals: 0,
            penaltiesSaved: 0,
            penaltiesMissed: 0,
            xG: minutes ? 0.1 : 0,
            xA: minutes ? 0.05 : 0,
            xGC: minutes ? 1.2 : 0,
            teamHScore: 1,
            teamAScore: 1,
          });
        }
      }
    }
  }
  return rows;
}

const PRIOR = buildDataset({ rows: seasonRows({ year: 2024 }), season: '2024-25' });
const CURRENT = buildDataset({ rows: seasonRows({ year: 2025, rotate: 5, newcomer: true }), season: '2025-26' });
const ASSET = priorSeasonAsset(CURRENT, PRIOR, { firstDeadline: eventDeadlines(CURRENT).get(1) });
const PRESEASON = preseasonTotalsFor(CURRENT, PRIOR);

function stateAt(gw) {
  const accumulator = createAccumulator(CURRENT, {});
  for (let g = 1; g < gw; g++) accumulator.absorb(g);
  return productionGameStateAt(CURRENT, gw, { rules: RULES, accumulator, preseasonTotals: PRESEASON, asset: ASSET });
}

const sumRows = (dataset, playerId, beforeGw, field) => dataset.players.get(playerId).rows
  .filter(r => r.gw < beforeGw)
  .reduce((s, r) => s + r[field], 0);

test('the replay state at a deadline is exactly what the app resolves from the same payloads', () => {
  for (const gw of [1, 2, 3, 4, 10]) {
    const { gameState, bootstrap, fixtures } = stateAt(gw);
    const first = buildGameState(bootstrap, fixtures, { fetchedAt: new Date(0).toISOString() });
    const shipped = openingBaselineApplies(first) ? ASSET : null;
    const app = resolveGameState(first, { bootstrap, fixtures, kept: null, shipped }).gameState;
    assert.equal(gameState.baselineSource, app.baselineSource, `gw${gw} baseline source`);
    for (const [id, player] of app.players) {
      const replayed = gameState.players.get(id);
      for (const field of ['starts', 'minutes', 'xG', 'xA', 'bps', 'bonus', 'evidenceMatches', 'seasonStarts']) {
        assert.equal(replayed[field], player[field], `gw${gw} player ${id} ${field}`);
      }
    }
  }
});

test('gameweek 1 is the pre-season payload: last season\'s totals, nothing played', () => {
  const { gameState, bootstrap } = stateAt(1);
  assert.equal(gameState.seasonStarted, false);
  assert.equal(seasonEvidence(gameState).kind, 'previous-season');
  const returning = bootstrap.elements.find(e => e.web_name === 'Bravo 3');
  const priorId = [...PRIOR.players.values()].find(p => p.name === 'Bravo 3').id;
  assert.equal(returning.minutes, sumRows(PRIOR, priorId, GWS + 1, 'minutes'));
  const newcomer = bootstrap.elements.find(e => e.web_name === 'Alpha Newcomer');
  assert.equal(newcomer.minutes, 0, 'a player with no previous season carries nothing into it');
});

test('from gameweek 2 the payload carries this season\'s totals over the matches before the deadline', () => {
  for (const gw of [2, 5, 20]) {
    const { bootstrap } = stateAt(gw);
    for (const e of bootstrap.elements) {
      assert.equal(e.starts, sumRows(CURRENT, e.id, gw, 'starts'), `gw${gw} ${e.web_name} starts`);
      assert.equal(e.minutes, sumRows(CURRENT, e.id, gw, 'minutes'), `gw${gw} ${e.web_name} minutes`);
    }
  }
});

test('nothing at or after the deadline reaches a payload', () => {
  const accumulator = createAccumulator(CURRENT, {});
  for (let g = 1; g < 6; g++) accumulator.absorb(g);
  const before = deadlinePayload(CURRENT, 6, { rules: RULES, accumulator });
  const mutatedRows = seasonRows({ year: 2025, rotate: 5, newcomer: true }).map(r => (r.gw >= 6
    ? { ...r, minutes: 90, starts: 1, xG: 9, teamHScore: 7 }
    : r));
  const mutated = buildDataset({ rows: mutatedRows, season: '2025-26' });
  const acc2 = createAccumulator(mutated, {});
  for (let g = 1; g < 6; g++) acc2.absorb(g);
  const after = deadlinePayload(mutated, 6, { rules: RULES, accumulator: acc2 });
  assert.deepEqual(after.bootstrap.elements, before.bootstrap.elements);
  assert.deepEqual(after.fixtures, before.fixtures);
  assert.throws(() => deadlinePayload(CURRENT, 5, { rules: RULES, accumulator }), /absorbed gameweek 5/);
});

test('the previous season reaches the resolver as an asset production accepts for that season only', () => {
  const { gameState } = stateAt(2);
  const first = buildGameState(stateAt(2).bootstrap, stateAt(2).fixtures, {});
  assert.deepEqual(validateOpeningBaseline(ASSET, first), { ok: true, reasons: [] });
  assert.equal(gameState.baselineSource, 'baseline');
  assert.equal(gameState.baselineOrigin, 'shipped');

  const nextSeason = buildDataset({ rows: seasonRows({ year: 2026 }), season: '2026-27' });
  const later = createAccumulator(nextSeason, {});
  later.absorb(1);
  const payload = deadlinePayload(nextSeason, 2, { rules: RULES, accumulator: later });
  const other = buildGameState(payload.bootstrap, payload.fixtures, {});
  assert.equal(validateOpeningBaseline(ASSET, other).ok, false, 'an asset for 2025/26 is refused by 2026/27');
});

test('the replay runs end to end in the production regime and reports it', async () => {
  const report = await replaySeason({
    dataset: CURRENT,
    season: '2025-26',
    strategy: 'hold',
    rules: { ...RULES, chips: [] },
    opts: { gwFrom: 1, gwTo: 5, priorDataset: PRIOR, evidenceRegime: EVIDENCE_REGIMES.PRODUCTION },
  });
  assert.equal(report.opts.evidenceRegime, 'production');
  assert.equal(report.gws.length, 5);
  assert.ok(report.gws.every(g => Number.isFinite(g.projectedPoints)));
});

test('a seeding weight is refused in the production regime rather than silently ignored', async () => {
  // Ignored, every arm of a weight sweep would be the same replay and the sweep
  // would report a clean null.
  await assert.rejects(replaySeason({
    dataset: CURRENT,
    season: '2025-26',
    strategy: 'hold',
    rules: { ...RULES, chips: [] },
    opts: { gwFrom: 1, gwTo: 2, priorDataset: PRIOR, evidenceRegime: EVIDENCE_REGIMES.PRODUCTION, priorSeasonWeight: 0.25 },
  }), /priorSeasonWeight only exists in the seeded evidence regime/);
});

test('the app resolves its world through the same engine function the replay calls', () => {
  const app = readFileSync(join(here, '..', 'js', 'app.js'), 'utf8');
  assert.match(app, /import \{ resolveGameState \} from '\.\/engine\/world\.js'/);
  assert.match(app, /state\.gameState = resolveGameState\(first, \{/);
  assert.doesNotMatch(app, /resolveBaseline\(/, 'app.js must not resolve a baseline on its own again');
});
