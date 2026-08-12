// backtest.js - the historical replay harness, SPEC 14.
//
// The dataset here is SYNTHETIC and generated in this file from a seeded
// generator, so the suite is hermetic, fast and identical on every machine. It
// is written in the same CSV shape as the public per-gameweek archive that
// scripts/fetch-history.mjs downloads, and it goes through the same
// parseMergedGw -> buildDataset -> replaySeason path the real seasons do.
//
// The two tests that matter most are the two that can fail silently anywhere
// else:
//
//   "the replay cannot see a gameweek it has not played yet", which mutates
//   every row after the replay window and asserts nothing moves, and
//
//   the SPEC 14.4 anti no-op guard, which injects a future-only column into the
//   feature builder and asserts the result DOES move. A backtest that scores a
//   constant would pass every other test in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import {
  parseCsv,
  parseMergedGw,
  buildDataset,
  createAccumulator,
  gameStateAt,
  actualPoints,
  actualMinutes,
  applyAutoSubs,
  scoreGameweek,
  naiveProjections,
  replaySeason,
  compareStrategies,
  STRATEGIES,
  BACKTEST_VERSION,
  BACKTEST_PARAMS,
} from '../js/engine/backtest.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULES = buildRules(JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8')));

// ---------------------------------------------------------------------------
// A synthetic season in the archive's own CSV shape
// ---------------------------------------------------------------------------

const CLUBS = 10;
const SEASON_GWS = 6;
const SHAPE = [[1, 'GK'], [2, 'DEF'], [2, 'MID'], [1, 'FWD']];
const CLUB_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];

// mulberry32: deterministic, dependency free, and well enough mixed that a
// low seed does not produce a run of identical draws (which would quietly make
// every player in the dataset play every minute).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticPlayers() {
  const out = [];
  for (let club = 1; club <= CLUBS; club++) {
    let n = 0;
    for (const [count, position] of SHAPE) {
      for (let i = 0; i < count; i++) {
        n += 1;
        const id = club * 10 + n;
        out.push({
          id,
          club,
          position,
          // One name carries a comma and a quote, because the archive's do and a
          // split on "," silently drops those rows.
          name: club === 1 && n === 1 ? `O'Hara, "Sam"` : `${CLUB_NAMES[club - 1]} ${position}${i + 1}`,
          quality: ((id * 7) % 10) / 10,
        });
      }
    }
  }
  return out;
}

// A round robin rotation, so opponents differ every gameweek and the strength
// model has something to fit.
function pairsFor(gw) {
  const rot = [1, ...Array.from({ length: CLUBS - 1 }, (_, i) => ((i + gw - 1) % (CLUBS - 1)) + 2)];
  const out = [];
  for (let i = 0; i < CLUBS / 2; i++) out.push([rot[i], rot[CLUBS - 1 - i]]);
  return out;
}

const HEADER = [
  'name', 'position', 'team', 'element', 'fixture', 'opponent_team', 'was_home', 'kickoff_time',
  'minutes', 'starts', 'total_points', 'value', 'selected', 'bonus', 'bps', 'saves',
  'goals_scored', 'assists', 'clean_sheets', 'goals_conceded', 'yellow_cards', 'red_cards',
  'own_goals', 'penalties_saved', 'penalties_missed', 'expected_goals', 'expected_assists',
  'expected_goals_conceded', 'team_h_score', 'team_a_score', 'GW',
];

function syntheticCsv({ gws = SEASON_GWS, seed = 1 } = {}) {
  const roster = syntheticPlayers();
  const lines = [HEADER.join(',')];
  let fixtureId = 0;

  for (let gw = 1; gw <= gws; gw++) {
    for (const [home, away] of pairsFor(gw)) {
      fixtureId += 1;
      const match = rng(fixtureId * 977 + gw * 31 + seed);
      const homeScore = Math.floor(match() * 4);
      const awayScore = Math.floor(match() * 3);

      for (const [club, isHome] of [[home, true], [away, false]]) {
        for (const p of roster.filter(x => x.club === club)) {
          const r = rng(p.id * 131 + gw * 17 + seed);
          const minutes = r() < 0.12 ? 0 : (r() < 0.85 ? 90 : 30);
          const goals = minutes > 0 && r() < p.quality * 0.4 ? 1 : 0;
          const assists = minutes > 0 && r() < p.quality * 0.3 ? 1 : 0;
          const conceded = isHome ? awayScore : homeScore;
          const cleanSheet = minutes >= 60 && conceded === 0 ? 1 : 0;
          const goalPoints = { GK: 10, DEF: 6, MID: 5, FWD: 4 }[p.position];
          const csPoints = { GK: 4, DEF: 4, MID: 1, FWD: 0 }[p.position];
          const points = minutes === 0
            ? 0
            : (minutes >= 60 ? 2 : 1) + goals * goalPoints + assists * 3 + cleanSheet * csPoints;

          lines.push([
            `"${p.name.replace(/"/g, '""')}"`,
            p.position,
            CLUB_NAMES[p.club - 1],
            p.id,
            fixtureId,
            isHome ? away : home,
            isHome ? 'True' : 'False',
            `2024-08-0${gw}T14:00:00Z`,
            minutes,
            minutes >= 60 ? 1 : 0,
            points,
            40 + Math.round(p.quality * 60),
            Math.round(1000 * (1 + p.quality * 50)),
            0,
            minutes,
            0,
            goals,
            assists,
            cleanSheet,
            conceded,
            0, 0, 0, 0, 0,
            (p.quality * 0.3).toFixed(2),
            (p.quality * 0.2).toFixed(2),
            (conceded * 0.9).toFixed(2),
            homeScore,
            awayScore,
            gw,
          ].join(','));
        }
      }
    }
  }
  return lines.join('\n');
}

const CSV = syntheticCsv();
const DATASET = buildDataset({ csv: CSV, season: 'synthetic-1' });

// ---------------------------------------------------------------------------
// CSV and dataset
// ---------------------------------------------------------------------------

test('the CSV reader keeps fields that contain commas and quotes', () => {
  const { header, rows } = parseCsv('a,b,c\n1,"two, and a half","he said ""no"""\n4,5,6\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [
    ['1', 'two, and a half', 'he said "no"'],
    ['4', '5', '6'],
  ]);
});

test('rows this planner cannot select are dropped rather than projected', () => {
  const csv = [
    HEADER.join(','),
    '"Manager, A",AM,Alpha,900,1,2,True,2024-08-01T14:00:00Z,0,0,6,150,10,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1',
    '"Striker, B",FWD,Alpha,901,1,2,True,2024-08-01T14:00:00Z,90,1,7,150,10,0,20,0,1,0,0,1,0,0,0,0,0,0.4,0.1,1.2,1,0,1',
  ].join('\n');
  const rows = parseMergedGw(csv);
  assert.equal(rows.length, 1, 'the assistant manager row is not a player');
  assert.equal(rows[0].playerId, 901);
  assert.equal(rows[0].position, 4);
  assert.equal(rows[0].minutes, 90);
  assert.equal(rows[0].totalPoints, 7);
  assert.equal(rows[0].valueTenths, 150);
  assert.equal(rows[0].wasHome, true);
  assert.equal(rows[0].xG, 0.4);
});

test('the dataset recovers club ids and fixtures from the rows themselves', () => {
  assert.equal(DATASET.maxGw, SEASON_GWS);
  assert.equal(DATASET.players.size, CLUBS * 6);
  assert.equal(DATASET.teams.size, CLUBS);
  assert.equal(DATASET.fixtures.length, (CLUBS / 2) * SEASON_GWS);

  for (const f of DATASET.fixtures) {
    assert.ok(DATASET.teams.has(f.teamH), 'home club resolved');
    assert.ok(DATASET.teams.has(f.teamA), 'away club resolved');
    assert.notEqual(f.teamH, f.teamA);
  }
  // Every club plays exactly once a gameweek in this generator.
  for (let gw = 1; gw <= SEASON_GWS; gw++) {
    const playing = DATASET.fixtures.filter(f => f.event === gw).flatMap(f => [f.teamH, f.teamA]);
    assert.equal(new Set(playing).size, CLUBS, `gameweek ${gw}`);
  }

  const quoted = [...DATASET.players.values()].find(p => p.name.includes('"Sam"'));
  assert.ok(quoted, 'the awkward name survived the parser');
});

// ---------------------------------------------------------------------------
// Pre-deadline state
// ---------------------------------------------------------------------------

test('the state handed to the planner at a gameweek contains nothing from that gameweek onwards', () => {
  const GW = 4;
  const accumulator = createAccumulator(DATASET);
  for (let gw = 1; gw < GW; gw++) accumulator.absorb(gw);
  const gameState = gameStateAt(DATASET, GW, { rules: RULES, accumulator });

  for (const player of gameState.players.values()) {
    const source = DATASET.players.get(player.id);
    const before = source.rows.filter(r => r.gw < GW);
    assert.equal(player.minutes, before.reduce((s, r) => s + r.minutes, 0), `${player.webName} minutes`);
    assert.equal(player.totalPoints, before.reduce((s, r) => s + r.totalPoints, 0), `${player.webName} points`);
    assert.equal(player.goalsScored, before.reduce((s, r) => s + r.goalsScored, 0));
    // Price and ownership DO lock at the deadline, which is the one documented
    // exception, so they are read at the gameweek itself.
    const priceRow = source.rows.filter(r => r.gw <= GW).pop();
    assert.equal(player.nowCost, priceRow.valueTenths);
  }

  for (const f of gameState.fixtures) {
    if (f.event < GW) {
      assert.equal(f.finished, true);
      assert.ok(f.teamHScore !== null, 'a played fixture has its score');
    } else {
      assert.equal(f.finished, false);
      assert.equal(f.teamHScore, null, `gameweek ${f.event} score must be invisible at gameweek ${GW}`);
      assert.equal(f.teamAScore, null);
    }
  }

  assert.equal(gameState.nextEvent, GW);
  assert.equal(gameState.currentEvent, GW - 1);
  assert.equal(gameState.events.find(e => e.id === GW).finished, false);
  assert.equal(gameState.events.find(e => e.id === GW - 1).finished, true);
});

test('asking for a state the accumulator has already absorbed is refused, loudly', () => {
  const accumulator = createAccumulator(DATASET);
  accumulator.absorb(1);
  accumulator.absorb(2);
  assert.throws(
    () => gameStateAt(DATASET, 2, { rules: RULES, accumulator }),
    /post deadline outcomes/,
  );
  assert.doesNotThrow(() => gameStateAt(DATASET, 3, { rules: RULES, accumulator }));
});

test('the previous season seeds the opening gameweek, and only the opening state', () => {
  const prior = buildDataset({ csv: syntheticCsv({ gws: 3, seed: 99 }), season: 'prior' });
  const withPrior = createAccumulator(DATASET, { priorDataset: prior });
  const without = createAccumulator(DATASET);

  const sample = [...DATASET.players.values()][0];
  const seeded = withPrior.totalsFor(sample.id);
  const empty = without.totalsFor(sample.id);
  assert.equal(empty.minutes, 0, 'with no prior season a player starts the season blank');
  assert.ok(seeded.minutes > 0, 'with one, he carries last season forward');

  const priorMinutes = prior.players.get(sample.id).rows.reduce((s, r) => s + r.minutes, 0);
  assert.ok(Math.abs(seeded.minutes - priorMinutes * BACKTEST_PARAMS.priorSeasonWeight) < 1e-9);
});

// ---------------------------------------------------------------------------
// Auto-substitutions
// ---------------------------------------------------------------------------

// A 4-4-2 built out of position ids, with a bench of one keeper and three
// outfielders, which is the shape every FPL squad has.
function lineupFixture() {
  const positions = new Map([
    [1, 1], [2, 2], [3, 2], [4, 2], [5, 2], [6, 3], [7, 3], [8, 3], [9, 3], [10, 4], [11, 4],
    [12, 1], [13, 2], [14, 3], [15, 4],
  ]);
  return {
    startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    bench: { gk: 12, order: [13, 14, 15] },
    positionOf: id => positions.get(id),
  };
}

test('an auto-substitution fires when a starter does not play and the formation survives it', () => {
  const { startingXI, bench, positionOf } = lineupFixture();
  const blanked = 6;
  const { finalXI, subs } = applyAutoSubs({
    startingXI,
    bench,
    positionOf,
    minutesOf: id => (id === blanked ? 0 : 90),
    rules: RULES,
  });

  assert.deepEqual(subs, [{ out: blanked, in: 13 }], 'the first bench player who keeps the eleven legal comes on');
  assert.ok(finalXI.includes(13));
  assert.ok(!finalXI.includes(blanked));
  assert.equal(finalXI.length, 11);
});

test('the bench goalkeeper only ever replaces the goalkeeper', () => {
  const { startingXI, bench, positionOf } = lineupFixture();

  // The starting keeper blanks: the reserve keeper comes on.
  const keeperOut = applyAutoSubs({
    startingXI, bench, positionOf, minutesOf: id => (id === 1 ? 0 : 90), rules: RULES,
  });
  assert.deepEqual(keeperOut.subs, [{ out: 1, in: 12 }]);

  // An outfielder blanks while the reserve keeper is the only bench player who
  // played: nobody comes on, because a keeper cannot fill an outfield slot
  // without breaking the one-keeper rule.
  const benched = new Set([13, 14, 15]);
  const outfieldOut = applyAutoSubs({
    startingXI,
    bench,
    positionOf,
    minutesOf: id => (id === 10 || benched.has(id) ? 0 : 90),
    rules: RULES,
  });
  assert.deepEqual(outfieldOut.subs, []);
  assert.deepEqual(outfieldOut.finalXI, startingXI);

  // And the reverse: the keeper blanks and only outfielders are available.
  const noKeeper = applyAutoSubs({
    startingXI,
    bench,
    positionOf,
    minutesOf: id => (id === 1 || id === 12 ? 0 : 90),
    rules: RULES,
  });
  assert.deepEqual(noKeeper.subs, [], 'an outfielder never takes the goalkeeper slot');
  assert.ok(noKeeper.finalXI.includes(1));
});

test('a substitution that would make the formation illegal is skipped', () => {
  // A 3-4-3, where losing a defender to a midfielder would leave two at the
  // back and no legal formation.
  const positions = new Map([
    [1, 1], [2, 2], [3, 2], [4, 2], [5, 3], [6, 3], [7, 3], [8, 3], [9, 4], [10, 4], [11, 4],
    [12, 1], [13, 3], [14, 3], [15, 4],
  ]);
  const startingXI = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const bench = { gk: 12, order: [13, 14, 15] };

  const { finalXI, subs } = applyAutoSubs({
    startingXI,
    bench,
    positionOf: id => positions.get(id),
    minutesOf: id => (id === 2 ? 0 : 90),
    rules: RULES,
  });
  assert.deepEqual(subs, [], 'no bench player can replace the third defender legally');
  assert.deepEqual(finalXI, startingXI);
});

test('each bench player can only come on once, in bench order', () => {
  const { startingXI, bench, positionOf } = lineupFixture();
  const blanks = new Set([6, 7]);
  const { subs, finalXI } = applyAutoSubs({
    startingXI,
    bench,
    positionOf,
    // Only the first outfield bench player actually played.
    minutesOf: id => (blanks.has(id) ? 0 : (id === 14 || id === 15 ? 0 : 90)),
    rules: RULES,
  });
  assert.equal(subs.length, 1);
  assert.deepEqual(subs, [{ out: 6, in: 13 }]);
  assert.equal(new Set(finalXI).size, 11, 'nobody appears twice');
});

// ---------------------------------------------------------------------------
// Scoring a gameweek against what actually happened
// ---------------------------------------------------------------------------

function scoringDataset({ minutes, points }) {
  const positions = { 1: 1, 2: 2, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4, 12: 1, 13: 2, 14: 3, 15: 4 };
  const rows = Object.keys(positions).map(Number).map(id => ({
    gw: 1,
    playerId: id,
    name: `Player ${id}`,
    position: positions[id],
    teamName: id % 2 ? 'Alpha' : 'Bravo',
    opponentTeam: id % 2 ? 2 : 1,
    fixtureId: 1,
    wasHome: id % 2 === 1,
    kickoff: '2024-08-01T14:00:00Z',
    minutes: minutes[id] ?? 90,
    starts: 1,
    totalPoints: points[id] ?? 2,
    valueTenths: 50,
    selected: 1000,
    bonus: 0,
    bps: 10,
    saves: 0,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    yellowCards: 0,
    redCards: 0,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    xG: 0,
    xA: 0,
    xGC: 0,
    teamHScore: 1,
    teamAScore: 0,
  }));
  return buildDataset({ rows, season: 'scoring' });
}

const scoringPlan = (over = {}) => ({
  gw: 1,
  chip: null,
  transfersOut: [],
  transfersIn: [],
  transferCount: 0,
  hits: 0,
  hitCostPoints: 0,
  squad: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  bench: { gk: 12, order: [13, 14, 15] },
  captain: 10,
  viceCaptain: 11,
  ...over,
});

test('a gameweek is scored on the eleven that finished it, doubling the captain', () => {
  const dataset = scoringDataset({ minutes: {}, points: { 10: 12 } });
  const scored = scoreGameweek({ dataset, gw: 1, plan: scoringPlan(), rules: RULES });

  const xi = 10 * 2 + 12;
  assert.equal(scored.xiPoints, xi);
  assert.equal(scored.captain, 10);
  assert.equal(scored.captainBase, 12);
  assert.equal(scored.captainExtra, 12, 'the armband is worth one more copy');
  assert.equal(scored.points, xi + 12);
  assert.equal(scored.netPoints, scored.points);
  assert.equal(scored.benchPoints, 2 * 4);
  assert.equal(scored.captainFromVice, false);
  assert.ok(Math.abs(scored.captaincyValue - (12 - xi / 11)) < 1e-9, 'captaincy value is measured against the same eleven');
});

test('the vice captain takes the armband when the captain does not play', () => {
  const dataset = scoringDataset({ minutes: { 10: 0 }, points: { 10: 0, 11: 9 } });
  const scored = scoreGameweek({ dataset, gw: 1, plan: scoringPlan(), rules: RULES });

  assert.equal(scored.captain, 11);
  assert.equal(scored.captainFromVice, true);
  assert.equal(scored.captainBase, 9);
  assert.equal(scored.captainExtra, 9);
  // The absent captain is replaced by the first bench player whose arrival
  // leaves a legal formation, which is the defender in bench slot 1 (4-4-2
  // becomes 5-4-1), not the forward waiting in slot 3.
  assert.deepEqual(scored.autoSubs, [{ out: 10, in: 13 }]);
});

test('a triple captain triples and a bench boost pays the bench, with no substitutions', () => {
  const dataset = scoringDataset({ minutes: { 6: 0 }, points: { 10: 10, 6: 0 } });

  const tripled = scoreGameweek({ dataset, gw: 1, plan: scoringPlan({ chip: '3xc' }), rules: RULES });
  assert.equal(tripled.captainExtra, 20, 'three copies in total');

  const boosted = scoreGameweek({ dataset, gw: 1, plan: scoringPlan({ chip: 'bboost' }), rules: RULES });
  assert.deepEqual(boosted.autoSubs, [], 'all fifteen play, so there is nothing to substitute');
  assert.equal(boosted.benchPoints, 8);
  assert.equal(boosted.points, boosted.xiPoints + boosted.benchPoints + boosted.captainExtra);

  const plain = scoreGameweek({ dataset, gw: 1, plan: scoringPlan(), rules: RULES });
  assert.ok(boosted.points > plain.points, 'the chip is worth the bench');
});

test('a hit is charged against the gameweek that took it', () => {
  const dataset = scoringDataset({ minutes: {}, points: {} });
  const scored = scoreGameweek({
    dataset, gw: 1, plan: scoringPlan({ transferCount: 2, hits: 1, hitCostPoints: 4 }), rules: RULES,
  });
  assert.equal(scored.hitCostPoints, 4);
  assert.equal(scored.netPoints, scored.points - 4);
});

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

const replay = (strategy, opts = {}) => replaySeason({
  dataset: DATASET,
  season: 'synthetic-1',
  strategy,
  rules: RULES,
  opts: { gwFrom: 1, gwTo: SEASON_GWS, horizon: 3, poolSize: CLUBS * 6, ...opts },
});

test('the planner replays a season and reports what SPEC 14.3 asks for', async () => {
  const report = await replay('planner');

  assert.equal(report.version, BACKTEST_VERSION);
  assert.equal(report.season, 'synthetic-1');
  assert.equal(report.strategy, 'planner');
  assert.equal(report.gws.length, SEASON_GWS);
  assert.deepEqual(report.gws.map(g => g.gw), [1, 2, 3, 4, 5, 6]);

  const totals = report.totals;
  assert.equal(totals.gwCount, SEASON_GWS);
  assert.equal(totals.seasonPoints, report.gws.reduce((s, g) => s + g.netPoints, 0));
  assert.ok(Math.abs(totals.meanGwPoints - totals.seasonPoints / SEASON_GWS) < 1e-9);
  assert.equal(totals.grossPoints - totals.hitPoints, totals.seasonPoints);
  assert.ok(totals.seasonPoints > 0);

  // Captaincy value, hit efficiency and chip value all have to be real numbers
  // or an honest null, never a placeholder.
  assert.ok(Number.isFinite(totals.captaincyValue));
  assert.ok(Number.isFinite(totals.captainPoints));
  assert.ok(totals.hitEfficiency === null || Number.isFinite(totals.hitEfficiency));
  assert.equal(totals.hitEfficiency === null, totals.hitPoints === 0);
  assert.ok(Array.isArray(totals.chips));
  for (const chip of totals.chips) {
    assert.ok(['wildcard', 'freehit', 'bboost', '3xc'].includes(chip.chip));
    assert.ok(chip.gw >= 1 && chip.gw <= SEASON_GWS);
    assert.ok(Number.isFinite(chip.value));
  }
  assert.equal(totals.chipPoints, totals.chips.reduce((s, c) => s + c.value, 0));

  // The projection bias is the harness telling on the model, so it has to be
  // measured rather than assumed to be zero.
  assert.ok(Number.isFinite(totals.projectionBias));
  assert.equal(
    Math.round(totals.projectionBias * 1e6),
    Math.round((report.gws.reduce((s, g) => s + (g.projectedPoints - g.points), 0) / SEASON_GWS) * 1e6),
  );

  // Every gameweek's decision is recorded, not just its score.
  for (const gw of report.gws) {
    assert.ok(Number.isFinite(gw.points));
    assert.ok(Number.isFinite(gw.projectedPoints));
    assert.ok(gw.captain !== null);
    assert.equal(typeof gw.captainName, 'string');
    assert.ok(gw.bankTenths >= 0, `bank must never go negative, gameweek ${gw.gw}`);
    assert.ok(Number.isInteger(gw.bankTenths), 'money stays in integer tenths through the replay');
  }

  // The run is reproducible from the report alone.
  assert.equal(report.opts.gwFrom, 1);
  assert.equal(report.opts.gwTo, SEASON_GWS);
  assert.equal(report.opts.horizon, 3);
  assert.equal(report.opts.risk, 'balanced');
  assert.equal(report.opts.seed, 1);
  assert.ok(JSON.parse(JSON.stringify(report)), 'the report is serializable');
});

test('a replayed season carries the free transfer allowance forward one gameweek at a time', async () => {
  // The replay used to seed the opening squad with a free transfer already
  // earned, so every gameweek after gameweek 1 ran one transfer rich. Nothing
  // caught it: each gameweek in isolation was legal. This walks the sequence.
  const report = await replay('planner');
  const rows = report.gws;

  // Gameweek 1 is before the first deadline: unlimited, reported as null
  // because JSON has no Infinity.
  assert.equal(rows[0].freeTransfers, null, 'the opening squad is built with unlimited transfers');
  assert.equal(rows[1].freeTransfers, 1, 'and gameweek 2 starts with exactly one, never two');

  for (let i = 1; i < rows.length - 1; i++) {
    const here = rows[i];
    const next = rows[i + 1];
    const chipFree = here.chip === 'wildcard' || here.chip === 'freehit';
    const kept = chipFree ? here.freeTransfers : Math.max(0, here.freeTransfers - here.transfers);
    assert.equal(
      next.freeTransfers,
      Math.min(RULES.maxFreeTransfers, kept + 1),
      `gameweek ${here.gw} to ${next.gw}: ${here.freeTransfers} banked, ${here.transfers} made, chip ${here.chip}`,
    );
    assert.ok(next.freeTransfers >= 0 && next.freeTransfers <= RULES.maxFreeTransfers);
    // And the hits charged are exactly the transfers the allowance did not cover.
    const expectedHits = chipFree ? 0 : Math.max(0, here.transfers - here.freeTransfers);
    assert.equal(here.hits, expectedHits, `gameweek ${here.gw} hits`);
    assert.equal(here.hitCostPoints, expectedHits * RULES.hitCost);
  }
});

test('the three baselines are implemented, run, and are scored the same way', async () => {
  assert.deepEqual(Object.keys(STRATEGIES).sort(), ['fdr', 'greedy-xp', 'hold', 'planner']);

  const [planner, hold, greedy, fdr] = await Promise.all([
    replay('planner'), replay('hold'), replay('greedy-xp'), replay('fdr'),
  ]);

  for (const report of [hold, greedy, fdr]) {
    assert.equal(report.gws.length, SEASON_GWS);
    assert.ok(Number.isFinite(report.totals.seasonPoints));
    assert.ok(report.totals.seasonPoints > 0, `${report.strategy} scored nothing`);
    assert.equal(typeof report.label, 'string');
  }

  assert.equal(hold.totals.transfers, 0, 'the hold baseline builds a squad and never touches it');
  assert.equal(hold.totals.hits, 0);
  assert.equal(hold.opts.horizon, 3);

  // The naive baseline is a different decision rule, not a different amount of
  // legality: it fields legal elevens through the same optimizer.
  assert.notEqual(fdr.modelVersion, planner.modelVersion);
  assert.match(fdr.modelVersion, /naive-fdr-1$/);
  assert.match(planner.modelVersion, /analytic-1$/);

  const comparison = compareStrategies({ primary: planner, baselines: [hold, greedy, fdr] });
  assert.equal(comparison.version, BACKTEST_VERSION);
  assert.equal(comparison.primary.strategy, 'planner');
  assert.equal(comparison.primary.seasonPoints, planner.totals.seasonPoints);
  for (const report of [hold, greedy, fdr]) {
    const above = comparison.aboveBaseline[report.strategy];
    assert.equal(above.seasonPoints, report.totals.seasonPoints);
    assert.equal(above.delta, planner.totals.seasonPoints - report.totals.seasonPoints);
    assert.ok(Math.abs(above.meanGwDelta - (planner.totals.meanGwPoints - report.totals.meanGwPoints)) < 1e-9);
  }
});

test('the naive fixture difficulty projections are a decision rule, not a model', () => {
  const accumulator = createAccumulator(DATASET);
  for (let gw = 1; gw < 3; gw++) accumulator.absorb(gw);
  const gameState = gameStateAt(DATASET, 3, { rules: RULES, accumulator });
  const strength = { teams: new Map([...gameState.teams.keys()].map(id => [id, { attack: 1, defence: id === 1 ? 2 : 0.5 }])) };
  const set = naiveProjections({ gameState, strength, gwFrom: 3, gwTo: 4, playerIds: [...gameState.players.keys()] });

  assert.equal(set.modelVersion, 'naive-fdr-1');
  const row = set.get([...gameState.players.keys()][0], 3);
  assert.ok(row.xPoints >= 0);
  assert.equal(row.sd, 0, 'the naive rule has no distribution');
  assert.equal(row.confidence, 'low');
  assert.equal(set.get([...gameState.players.keys()][0], 9), null, 'out of range is null, not a guess');

  // Facing the weak defence is worth more than facing the strong one, and
  // nothing else moves the number.
  const facingWeak = [...gameState.players.values()].filter(p => {
    const f = gameState.fixtures.find(x => x.event === 3 && (x.teamH === p.teamId || x.teamA === p.teamId));
    return f && (f.teamH === 1 || f.teamA === 1) && p.teamId !== 1 && p.minutes > 0;
  });
  assert.ok(facingWeak.length > 0, 'the scenario needs someone facing club 1');
});

// ---------------------------------------------------------------------------
// Leakage, in both directions
// ---------------------------------------------------------------------------

test('the replay cannot see a gameweek it has not played yet', async () => {
  // Everything a deadline has not revealed, from the last gameweek of the
  // window onwards, is rewritten into nonsense: ten times the points, everybody
  // playing ninety minutes, three extra goals each, scorelines inverted. Price
  // and ownership are only tampered with AFTER the window, because those two do
  // lock at the deadline and the harness is documented as reading them.
  //
  // Every DECISION inside the window then has to be identical. The outcomes of
  // the last gameweek legitimately differ, since its results are what was
  // rewritten, so they are compared only for the gameweeks whose rows were left
  // alone.
  const LAST = 3;
  const rows = parseMergedGw(CSV);
  const tampered = rows.map((r) => {
    if (r.gw < LAST) return r;
    const future = r.gw > LAST;
    return {
      ...r,
      totalPoints: r.totalPoints * 10 + 5,
      minutes: 90,
      starts: 1,
      goalsScored: r.goalsScored + 3,
      assists: r.assists + 2,
      cleanSheets: 1,
      xG: r.xG + 5,
      xA: r.xA + 5,
      xGC: r.xGC + 5,
      teamHScore: r.teamAScore + 4,
      teamAScore: r.teamHScore + 4,
      valueTenths: future ? r.valueTenths + 30 : r.valueTenths,
      selected: future ? r.selected * 3 : r.selected,
    };
  });
  const tamperedDataset = buildDataset({ rows: tampered, season: 'synthetic-1' });

  const run = dataset => replaySeason({
    dataset, season: 'synthetic-1', strategy: 'planner', rules: RULES,
    opts: { gwFrom: 1, gwTo: LAST, horizon: 3, poolSize: CLUBS * 6 },
  });
  const clean = await run(DATASET);
  const dirty = await run(tamperedDataset);

  const decisions = report => report.gws.map(g => ({
    gw: g.gw,
    captain: g.captain,
    chip: g.chip,
    transfers: g.transfers,
    hits: g.hits,
    projectedPoints: g.projectedPoints,
    bankTenths: g.bankTenths,
    squadValueTenths: g.squadValueTenths,
    freeTransfers: g.freeTransfers,
  }));
  assert.deepEqual(decisions(dirty), decisions(clean), 'a result the deadline had not revealed changed a decision');

  const settled = report => report.gws.filter(g => g.gw < LAST);
  assert.deepEqual(settled(dirty), settled(clean), 'and the gameweeks that were left alone scored identically');
});

test('SPEC 14.4: injecting a future-only column into the feature builder changes the result', async () => {
  // The hook rewrites each player's underlying rates from what he is ABOUT to
  // score in the gameweek being planned, which is information the deadline has
  // not revealed. A harness that actually reads features has to move; a harness
  // that scores a constant, or that quietly ignores the game state it is handed,
  // would not. That is the whole point of this guard.
  const featureHook = (player, { gw, dataset }) => ({
    ...player,
    xG: player.xG + actualPoints(dataset, gw, player.id),
    per90: { ...player.per90, xG: player.per90.xG + actualPoints(dataset, gw, player.id) },
    minutes: Math.max(player.minutes, 90),
    starts: Math.max(player.starts, 1),
  });

  const honest = await replaySeason({
    dataset: DATASET, season: 'synthetic-1', strategy: 'planner', rules: RULES,
    opts: { gwFrom: 1, gwTo: 3, horizon: 3, poolSize: CLUBS * 6 },
  });
  const cheating = await replaySeason({
    dataset: DATASET, season: 'synthetic-1', strategy: 'planner', rules: RULES,
    opts: { gwFrom: 1, gwTo: 3, horizon: 3, poolSize: CLUBS * 6, featureHook },
  });

  assert.notDeepEqual(
    cheating.gws.map(g => ({ captain: g.captain, points: g.points, projected: g.projectedPoints })),
    honest.gws.map(g => ({ captain: g.captain, points: g.points, projected: g.projectedPoints })),
    'a future-only feature changed nothing, so the replay is not reading features at all',
  );
  assert.ok(
    cheating.totals.seasonPoints > honest.totals.seasonPoints,
    `knowing the answer should score better: ${cheating.totals.seasonPoints} vs ${honest.totals.seasonPoints}`,
  );
});

test('the same dataset and seed replay to the same report', async () => {
  const a = await replay('planner', { gwTo: 3 });
  const b = await replay('planner', { gwTo: 3 });
  assert.deepEqual(a.gws, b.gws);
  assert.deepEqual(a.totals, b.totals);
});

test('an unknown strategy fails loudly rather than scoring zero', async () => {
  await assert.rejects(
    () => replaySeason({ dataset: DATASET, season: 'x', strategy: 'vibes', rules: RULES }),
    /unknown strategy/,
  );
});

test('actual results are read per gameweek, summing a double gameweek', () => {
  const dataset = buildDataset({
    rows: [
      { gw: 1, playerId: 1, name: 'A', position: 3, teamName: 'Alpha', opponentTeam: 2, fixtureId: 1, wasHome: true, kickoff: null, minutes: 90, starts: 1, totalPoints: 6, valueTenths: 50, selected: 1, bonus: 0, bps: 0, saves: 0, goalsScored: 1, assists: 0, cleanSheets: 0, goalsConceded: 0, yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, xG: 0, xA: 0, xGC: 0, teamHScore: 1, teamAScore: 0 },
      { gw: 1, playerId: 1, name: 'A', position: 3, teamName: 'Alpha', opponentTeam: 3, fixtureId: 2, wasHome: false, kickoff: null, minutes: 60, starts: 1, totalPoints: 4, valueTenths: 50, selected: 1, bonus: 0, bps: 0, saves: 0, goalsScored: 0, assists: 1, cleanSheets: 0, goalsConceded: 1, yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, xG: 0, xA: 0, xGC: 0, teamHScore: 0, teamAScore: 1 },
    ],
    season: 'double',
  });
  assert.equal(actualPoints(dataset, 1, 1), 10, 'both fixtures count');
  assert.equal(actualMinutes(dataset, 1, 1), 150);
  assert.equal(actualPoints(dataset, 2, 1), 0, 'a gameweek he did not play is zero, not undefined');
  assert.equal(actualPoints(dataset, 1, 999), 0);
});
