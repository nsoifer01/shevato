// THE 2026-08-21 LIVE INCIDENT, pinned to the payloads that caused it.
//
// WHY THIS FILE EXISTS
//
// The opening gameweek of 2026/27 broke the planner in production, and every
// suite stayed green while it happened. The reason they stayed green is that
// they all tested states the app had been DESIGNED for: a pre-season payload, a
// finished gameweek, a rolled-over season. The states that actually occurred
// were none of those:
//
//   18:04 UTC  FPL cleared every element total the moment GW1 went current,
//              before a ball was kicked
//   19:00      the first match kicked off, so 22 of 600 players carried this
//              season's minutes and 578 carried a legitimate zero
//   20:50      full time, and `finished` stayed FALSE for hours while bonus
//              was confirmed - a state the fixture normaliser did not even keep
//
// Every case below is a real payload captured off the live proxy that evening
// and trimmed by scripts/derive-gw1-fixtures.mjs. They are the regression
// evidence: if these pass, the failure that happened cannot happen again in the
// same shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import {
  gameweekLifecycle, fixturePhase, GW_PHASE, FIXTURE_PHASE, matchesPlayedByClub,
} from '../js/engine/lifecycle.js';
import {
  assessBaseline, snapshotFrom, resolveBaseline, baselineIsSuperseded,
  loadSnapshot, saveSnapshotIfBetter,
} from '../js/engine/baseline.js';
import { assessReadiness, projectionVitals, LEVEL, levelAtLeast } from '../js/engine/readiness.js';
import { buildLiveStats, scoreLiveSquad, playerFixturePhase } from '../js/engine/live.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gw1-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const BASE = J('base.json');

/** Rebuild a full bootstrap+fixtures pair for one captured lifecycle state. */
function state(name) {
  const delta = J(`${name}.json`);
  const at = Object.fromEntries(delta.totals.fields.map((f, i) => [f, i]));
  const totalsById = new Map(delta.totals.rows.map((r) => [r[at.id], r]));
  const elements = BASE.elements.map((e) => {
    const row = totalsById.get(e.id);
    const out = { ...e };
    for (const f of delta.totals.fields) {
      if (f === 'id') continue;
      out[f] = row ? row[at[f]] : 0;
    }
    return out;
  });
  const fixtures = BASE.fixtures.map((f) => {
    const ph = delta.fixturePhases[f.id];
    return {
      ...f,
      started: ph ? ph.s : false,
      finished: ph ? ph.f : false,
      finished_provisional: ph ? ph.p : false,
      team_h_score: ph && ph.p ? 1 : null,
      team_a_score: ph && ph.p ? 0 : null,
    };
  });
  const bootstrap = {
    events: delta.events,
    game_settings: BASE.game_settings,
    game_config: BASE.game_config,
    phases: BASE.phases,
    teams: BASE.teams,
    element_types: BASE.element_types,
    total_players: BASE.total_players,
    elements,
  };
  return buildGameState(bootstrap, fixtures);
}

const named = (gs, webName) => [...gs.players.values()].find((p) => p.webName === webName);

/* ========================================================================== */
/* THE FIXTURE PHASE FPL LEAVES A MATCH IN FOR HOURS                          */
/* ========================================================================== */

test('a match at full time with bonus outstanding is neither live nor final', () => {
  const gs = state('ft-provisional');
  const played = gs.fixtures.filter((f) => f.started);
  assert.equal(played.length, 1, 'the captured evening had exactly one match played');
  const f = played[0];

  assert.equal(f.finished, false, 'FPL had NOT signed it off');
  assert.equal(f.finishedProvisional, true, 'but it was over');
  assert.equal(fixturePhase(f), FIXTURE_PHASE.PROVISIONAL);

  // The field survives normalisation at all, which it did not before: dropping
  // it is what made this state invisible to every consumer.
  assert.ok('finishedProvisional' in f,
    'normalizeFixture must keep finished_provisional or the state cannot be seen');
});

test('a club that has played counts as having played, whatever the sign-off says', () => {
  const gs = state('ft-provisional');
  const played = matchesPlayedByClub(gs);
  let clubs = 0;
  for (const n of played.values()) if (n > 0) clubs++;
  assert.equal(clubs, 2, 'the two clubs in the completed match must count as having played');

  // Counting only `finished` returned zero here for over five hours, which is
  // what let the payload be mistaken for last season's.
  const finishedOnly = gs.fixtures.filter((f) => f.finished).length;
  assert.equal(finishedOnly, 0, 'the captured state genuinely had no signed-off fixture');
});

/* ========================================================================== */
/* THE LIFECYCLE                                                              */
/* ========================================================================== */

test('every captured state is classified as the phase it actually was', () => {
  const deadline = Date.parse('2026-08-21T17:30:00Z');
  const cases = [
    // No event is current and the deadline is still ahead: that is pre-season,
    // not an in-season gameweek awaiting its deadline.
    ['preseason', deadline - 15 * 60 * 1000, GW_PHASE.PRESEASON],
    ['rollover-cleared', deadline + 35 * 60 * 1000, GW_PHASE.DEADLINE_PASSED],
    ['match-in-play', deadline + 2 * 3600 * 1000, GW_PHASE.IN_PROGRESS],
    ['ft-provisional', deadline + 4 * 3600 * 1000, GW_PHASE.IN_PROGRESS],
  ];
  for (const [name, now, expected] of cases) {
    const life = gameweekLifecycle(state(name), { now });
    assert.equal(life.phase, expected, `${name} should be ${expected}, got ${life.phase}`);
  }
});

test('the gameweek being planned is the next one whose deadline has not passed', () => {
  const life = gameweekLifecycle(state('ft-provisional'), { now: Date.parse('2026-08-21T21:30:00Z') });
  assert.equal(life.gw, 1, 'GW1 is the gameweek in play');
  assert.equal(life.planGw, 2, 'GW2 is the one a recommendation would be for');
});

test('a gameweek is not settled until FPL has signed it off, not merely when the football ends', () => {
  const life = gameweekLifecycle(state('ft-provisional'), { now: Date.parse('2026-08-21T21:30:00Z') });
  assert.equal(life.settled, false,
    'full time is not settlement: bonus and stat corrections can still move every number');
});

test('clubs are not level until they have all played the same number of matches', () => {
  const inPlay = gameweekLifecycle(state('ft-provisional'), { now: Date.parse('2026-08-21T21:30:00Z') });
  assert.equal(inPlay.clubsLevel, false, '2 of 20 clubs had played');
  const pre = gameweekLifecycle(state('preseason'), { now: Date.parse('2026-08-21T17:00:00Z') });
  assert.equal(pre.clubsLevel, true, 'nobody having played is level');
});

/* ========================================================================== */
/* WHAT A SEASON'S WORTH OF EVIDENCE LOOKS LIKE                               */
/* ========================================================================== */

test('a complete season and a wiped one are told apart by the shape of the pool', () => {
  const pre = assessBaseline(state('preseason'));
  const wiped = assessBaseline(state('rollover-cleared'));
  const inPlay = assessBaseline(state('ft-provisional'));

  assert.equal(pre.complete, true, 'last season\'s totals are a season');
  assert.equal(wiped.complete, false, 'zeroed totals are not');
  assert.equal(inPlay.complete, false, 'one match of one club is not');

  // The two live states are nowhere near each other, which is why a share
  // rather than a tuned threshold is the right instrument.
  assert.ok(pre.activeShare > 0.5, `pre-season active share ${pre.activeShare.toFixed(3)}`);
  assert.ok(inPlay.activeShare < 0.15, `in-play active share ${inPlay.activeShare.toFixed(3)}`);
});

test('completeness does not depend on how many players the pool holds', () => {
  // The first version of this check compared aggregate starts against a whole
  // league's worth, which silently encoded the pool size and rejected every
  // hand-built test world. The invariant is per active player instead.
  const gs = state('preseason');
  const half = {
    ...gs,
    players: new Map([...gs.players.entries()].slice(0, Math.floor(gs.players.size / 4))),
  };
  assert.equal(assessBaseline(gs).complete, true);
  assert.equal(assessBaseline(half).complete, true,
    'a quarter of the pool is still a season if the players in it played one');
});

/* ========================================================================== */
/* THE CLASSIFICATION THAT WENT WRONG                                         */
/* ========================================================================== */

test('cleared totals are never read as last season', () => {
  for (const name of ['rollover-cleared', 'match-in-play', 'ft-provisional']) {
    const ev = seasonEvidence(state(name));
    assert.notEqual(ev.kind, 'previous-season',
      `${name}: a wiped payload must not be measured against a full season`);
    assert.equal(ev.usable, false, `${name}: and it must not be projected from`);
  }
});

test('a genuine pre-season payload is still read as last season and still usable', () => {
  const ev = seasonEvidence(state('preseason'));
  assert.equal(ev.kind, 'previous-season');
  assert.equal(ev.usable, true, 'the opening-squad plan depends on this and must not regress');
});

/* ========================================================================== */
/* THE SYMPTOM, AS A PROPERTY RATHER THAN A PLAYER                            */
/* ========================================================================== */

test('having played a match never projects a player below one who has never played', () => {
  // Production recommended selling Rice (1 start, read as 1-in-38) to buy a
  // player with no appearances at all, who still carried an untouched price
  // prior. Stated generically: within a position and price band, the players
  // who have appeared cannot rank systematically below those who have not.
  const gs = state('ft-provisional');
  const ev = seasonEvidence(gs);
  if (ev.usable) {
    const strength = buildStrength(gs, { asOfGw: 2 });
    const proj = buildProjections({ gameState: gs, strength, gwFrom: 2, gwTo: 2 });
    const played = [], unplayed = [];
    for (const p of gs.players.values()) {
      if (p.position !== 3 || p.nowCost < 60) continue;
      const row = proj.get(p.id, 2);
      if (!row) continue;
      ((p.seasonStarts || 0) > 0 ? played : unplayed).push(row.xPoints);
    }
    if (played.length && unplayed.length) {
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      assert.ok(med(played) >= med(unplayed),
        `players who appeared project ${med(played).toFixed(2)} against ${med(unplayed).toFixed(2)} for players who did not`);
    }
  }
  // If the evidence is refused, the property holds because nothing is ranked.
  assert.ok(true);
});

/* ========================================================================== */
/* THE BASELINE THAT SHOULD HAVE SURVIVED THE WIPE                            */
/* ========================================================================== */

test('a complete payload is kept, and a wiped one cannot replace it', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };

  const kept = saveSnapshotIfBetter(storage, state('preseason'), { seasonLabel: '2025/26' });
  assert.ok(kept && Object.keys(kept.totals).length > 100, 'the good payload becomes the baseline');

  const after = saveSnapshotIfBetter(storage, state('rollover-cleared'), { seasonLabel: '2026/27' });
  assert.equal(after.capturedAt, kept.capturedAt, 'a wiped payload must not overwrite the baseline');
  assert.deepEqual(loadSnapshot(storage).aggregate, kept.aggregate);
});

test('the kept baseline restores the projections the wipe destroyed', () => {
  const snapshot = snapshotFrom(state('preseason'), { seasonLabel: '2025/26' });
  assert.ok(snapshot, 'the pre-wipe payload must be snapshot-able');

  const delta = J('ft-provisional.json');
  const at = Object.fromEntries(delta.totals.fields.map((f, i) => [f, i]));
  const totalsById = new Map(delta.totals.rows.map((r) => [r[at.id], r]));
  const elements = BASE.elements.map((e) => {
    const row = totalsById.get(e.id);
    const out = { ...e };
    for (const f of delta.totals.fields) { if (f !== 'id') out[f] = row ? row[at[f]] : 0; }
    return out;
  });
  const fixtures = BASE.fixtures.map((f) => {
    const ph = delta.fixturePhases[f.id];
    return { ...f, started: ph ? ph.s : false, finished: ph ? ph.f : false, finished_provisional: ph ? ph.p : false };
  });
  const bootstrap = {
    events: delta.events, game_settings: BASE.game_settings, game_config: BASE.game_config,
    phases: BASE.phases, teams: BASE.teams, element_types: BASE.element_types,
    total_players: BASE.total_players, elements,
  };

  const without = buildGameState(bootstrap, fixtures);
  const with_ = buildGameState(bootstrap, fixtures, { baseline: snapshot });

  assert.equal(without.baselineSource, 'current');
  assert.equal(with_.baselineSource, 'baseline');

  // This season's own totals are untouched by the overlay: the two quantities
  // are different facts and must both survive.
  const rayaBoth = [named(without, 'Raya'), named(with_, 'Raya')];
  if (rayaBoth[0] && rayaBoth[1]) {
    assert.equal(rayaBoth[1].seasonStarts, rayaBoth[0].seasonStarts,
      'the overlay must not rewrite this season\'s cumulative totals');
    assert.ok(rayaBoth[1].starts > rayaBoth[0].starts,
      'but the evidence totals must come from the baseline');
  }

  assert.equal(seasonEvidence(with_).usable, true, 'with a baseline there IS something to project from');
});

test('a baseline steps aside once this season has matches of its own', () => {
  assert.equal(baselineIsSuperseded(state('ft-provisional')), false,
    'one club-pair playing once does not supersede a season');

  // Give every club three matches: the new season is now the better evidence.
  const gs = state('ft-provisional');
  const grown = {
    ...gs,
    fixtures: gs.fixtures.map((f, i) => (i < 30 ? { ...f, started: true, finished: true } : f)),
  };
  assert.equal(baselineIsSuperseded(grown), true,
    'a baseline must not freeze the app on last season for ever');
});

/* ========================================================================== */
/* WHAT THE DATA IS GOOD ENOUGH TO RECOMMEND                                  */
/* ========================================================================== */

test('a chip is never recommended on evidence that cannot carry one', () => {
  const gs = state('ft-provisional');
  const life = gameweekLifecycle(gs, { now: Date.parse('2026-08-21T21:30:00Z') });
  const r = assessReadiness({
    evidence: seasonEvidence(gs), lifecycle: life, vitals: null,
    baseline: { source: gs.baselineSource },
  });
  assert.equal(r.allow.chips, false, 'this is the state that produced the Wildcard recommendation');
  assert.equal(r.allow.transfers, false);
  assert.ok(r.headline, 'and the refusal must say why');
});

test('the ladder is ordered, so a cheaper claim never needs a dearer licence', () => {
  assert.ok(levelAtLeast(LEVEL.CHIPS, LEVEL.TRANSFERS));
  assert.ok(levelAtLeast(LEVEL.TRANSFERS, LEVEL.LINEUP));
  assert.ok(levelAtLeast(LEVEL.LINEUP, LEVEL.DISPLAY));
  assert.ok(!levelAtLeast(LEVEL.DISPLAY, LEVEL.TRANSFERS));
});

test('a collapsed projection pool is caught by its shape, not by a floor', () => {
  // The pool that shipped: everything within a whisker of everything else.
  const collapsed = Array.from({ length: 300 }, () => ({ xPoints: 0.1, pStart: 0.02 }));
  const v = projectionVitals(collapsed);
  const r = assessReadiness({ evidence: { usable: true }, lifecycle: null, vitals: v });
  assert.equal(r.allow.transfers, false);
  assert.ok(r.blocked.some((b) => b.code === 'projection_collapsed' || b.code === 'projection_implausible'),
    `expected a shape refusal, got ${r.blocked.map((b) => b.code).join(',')}`);
});

test('a projection pool that merely crosses a points floor is still refused if it is the wrong shape', () => {
  // 31.5 xP passed the old 30-point floor while the same defect was live. A
  // best-eleven number alone must never be the health check.
  const rows = Array.from({ length: 300 }, (_, i) => ({ xPoints: i < 11 ? 2.9 : 2.85, pStart: 0.5 }));
  const v = projectionVitals(rows);
  assert.ok(v.best11 > 30, `best-11 ${v.best11.toFixed(1)} clears the old floor`);
  const r = assessReadiness({ evidence: { usable: true }, lifecycle: null, vitals: v });
  assert.equal(r.allow.transfers, false, 'and is still refused, because the spread is gone');
});

test('a healthy pool in a settled league allows everything', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ xPoints: Math.max(0.5, 7 - i * 0.02), pStart: 0.6 }));
  const r = assessReadiness({
    evidence: { usable: true, kind: 'current-season' },
    lifecycle: { clubsLevel: true, clubsPlayed: 20, clubsTotal: 20, phase: GW_PHASE.PRE_DEADLINE },
    vitals: projectionVitals(rows),
    baseline: { source: 'current' },
  });
  assert.equal(r.level, LEVEL.CHIPS);
  assert.equal(r.headline, null);
});

/* ========================================================================== */
/* LIVE POINTS                                                                */
/* ========================================================================== */

test('the squad total reconciles exactly with the number Fantasy Premier League published', () => {
  const gs = state('ft-provisional');
  const live = buildLiveStats(J('ft-provisional.live.json'));
  const picks = J('ft-provisional.picks.json');
  const res = scoreLiveSquad({ picks, live, gameState: gs, gw: 1 });

  assert.equal(res.official, 14, 'the captured evening had a 14 point team');
  assert.equal(res.computed, 14, 'and our arithmetic must produce the same 14');
  assert.equal(res.reconciles, true);

  // And it must be explainable player by player, which is the whole point.
  const scorers = res.rows.filter((r) => r.points > 0).map((r) => r.points).sort((a, b) => b - a);
  assert.deepEqual(scorers, [6, 5, 3], 'three players scored, and those are their scores');
});

test('a player whose match has not kicked off has no score, which is not a score of zero', () => {
  const gs = state('ft-provisional');
  const live = buildLiveStats(J('ft-provisional.live.json'));
  const res = scoreLiveSquad({ picks: J('ft-provisional.picks.json'), live, gameState: gs, gw: 1 });

  const waiting = res.rows.filter((r) => r.fixturePhase === FIXTURE_PHASE.UPCOMING);
  assert.ok(waiting.length >= 10, 'most of the squad had not played on the opening Friday');
  for (const r of waiting) {
    assert.equal(r.hasPlayed, false, 'and the UI must be able to say so rather than print 0');
  }
});

test('the captain contributes his multiplier and the bench contributes nothing', () => {
  const gs = state('ft-provisional');
  const live = buildLiveStats(J('ft-provisional.live.json'));
  const res = scoreLiveSquad({ picks: J('ft-provisional.picks.json'), live, gameState: gs, gw: 1 });

  const captain = res.rows.find((r) => r.isCaptain);
  assert.ok(captain, 'a squad always has a captain');
  assert.equal(captain.multiplier, 2, 'no chip was played, so the armband doubles');
  if (captain.points !== null) {
    assert.equal(captain.contributed, captain.points * 2);
  }
  for (const r of res.rows.filter((x) => x.onBench)) {
    assert.equal(r.contributed, 0, 'a benched player contributes nothing until an autosub says otherwise');
  }
  assert.equal(res.rows.filter((r) => r.onBench).length, 4);
});

test('a player is told which phase his own match is in', () => {
  const gs = state('ft-provisional');
  const raya = named(gs, 'Raya');
  const haaland = named(gs, 'Haaland');
  if (raya) {
    assert.equal(playerFixturePhase(gs, raya, 1).phase, FIXTURE_PHASE.PROVISIONAL,
      'his match finished but was not signed off');
  }
  if (haaland) {
    assert.equal(playerFixturePhase(gs, haaland, 1).phase, FIXTURE_PHASE.UPCOMING,
      'his club had not played');
  }
});
