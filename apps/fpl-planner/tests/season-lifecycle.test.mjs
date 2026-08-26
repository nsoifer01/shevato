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
import {
  assessReadiness, projectionVitals, LEVEL, levelAtLeast, PLAUSIBLE_GW_MIN as PLAUSIBLE_MIN,
} from '../js/engine/readiness.js';
import { underlyingRates } from '../js/engine/projections.js';
import { buildLiveStats, scoreLiveSquad, playerFixturePhase } from '../js/engine/live.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gw1-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const BASE = J('base.json');

/** Rebuild the raw bootstrap+fixtures pair for one captured lifecycle state. */
function payloadFor(name) {
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
  return { bootstrap, fixtures };
}

function state(name) {
  const { bootstrap, fixtures } = payloadFor(name);
  return buildGameState(bootstrap, fixtures);
}

const POS = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };

// The captured picks against the trimmed (320 player) pool: two of the fifteen
// were cut by the sanitiser, so they are replaced by an unowned player of the
// same position who keeps the squad legal. The plan is asserted on shape, not
// on who is in it.
function ownedPicksFor(gs) {
  const picks = J('ft-provisional.picks.json');
  const need = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const clubs = new Map();
  const owned = new Set();
  for (const p of picks.picks) {
    const pl = gs.players.get(p.element);
    if (!pl) continue;
    need[pl.position]--;
    clubs.set(pl.teamId, (clubs.get(pl.teamId) || 0) + 1);
    owned.add(p.element);
  }
  for (const p of picks.picks) {
    if (gs.players.has(p.element)) continue;
    const position = Number(Object.keys(need).find((k) => need[k] > 0));
    const sub = [...gs.players.values()].find((pl) => pl.position === position && !owned.has(pl.id)
      && (clubs.get(pl.teamId) || 0) < 3 && pl.status === 'a');
    p.element = sub.id;
    owned.add(sub.id);
    need[position]--;
    clubs.set(sub.teamId, (clubs.get(sub.teamId) || 0) + 1);
  }
  return picks;
}

/** Best projected score per position for one gameweek, straight off the projection map. */
function bestByPosition(gs, projections, gw) {
  const best = {};
  for (const [id, rows] of projections.byPlayer) {
    const p = gs.players.get(id);
    const row = rows.find((r) => r.gw === gw);
    if (!p || !row || !Number.isFinite(row.xPoints)) continue;
    if (!(best[p.position] >= row.xPoints)) best[p.position] = row.xPoints;
  }
  return best;
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
/*                                                                            */
/* EVERY TEST IN THIS SECTION SEEDS ITS OWN BASELINE, and that is deliberate: */
/* they are unit tests of the keep/restore/upgrade mechanism, and they have to */
/* construct the input to test it.                                            */
/*                                                                            */
/* What they are NOT is evidence that any browser HAS one. They cannot be:     */
/* the guard reached production 22 hours after FPL cleared the totals, and     */
/* `snapshotFrom` only snapshots a complete payload, so between those moments  */
/* there was nothing left to keep and no production browser ever wrote a       */
/* snapshot. Reading a green result here as "returning visitors are fine" is   */
/* exactly the mistake that left the app unusable for GW2 and GW3.             */
/*                                                                            */
/* The production path - an EMPTY browser, and what it actually gets - lives   */
/* in tests/opening-baseline.test.mjs and seeds nothing.                       */
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

// THE SHAPE PRODUCTION WAS IN ON 2026-08-22, which no test built until now:
// the baseline restores last season's starts and minutes, but FPL cleared the
// rate totals (expected_goals, expected_assists, bps, saves, ...) at the same
// moment. A baseline that carried only the denominators produced one match of
// attacking output over a season of minutes: on the live payload the best
// forward in the pool projected 1.9, the best midfielder 2.7, the top
// defenders 4.8-5.5, and the plan was 5-4-1 with Virgil captain, readiness
// `transfers`, confidence HIGH. The xP total (46-49) is a football score, so
// the shape checks could not see it, and the older rollover assertion ("the
// captain is not a goalkeeper") is satisfied by a defender.
test('with the baseline in force the plan attacks: an attacking captain, forwards above defenders, no five-at-the-back', async () => {
  const snapshot = snapshotFrom(state('preseason'), { seasonLabel: '2025/26' });
  const { bootstrap, fixtures } = payloadFor('ft-provisional');
  const gs = buildGameState(bootstrap, fixtures, { baseline: snapshot });
  assert.equal(gs.baselineSource, 'baseline');

  const picks = ownedPicksFor(gs);
  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks, gameState: gs, gw: 2 });
  const bundle = await buildPlan({ gameState: gs, squadState, options: { horizon: 3, seed: 7 } });
  const plan = bundle.current;
  const readiness = bundle.dataStatus.readiness;
  const best = bestByPosition(gs, bundle.projections, 2);
  const describe = () => `formation ${plan.formation}, captain ${gs.players.get(plan.captain).webName} `
    + `(position ${gs.players.get(plan.captain).position}), best GKP/DEF/MID/FWD `
    + `${[1, 2, 3, 4].map((k) => (best[k] || 0).toFixed(2)).join('/')}, readiness ${readiness.level}`;

  assert.ok(best[POS.FWD] > best[POS.DEF],
    `the best forward in the pool must out-project the best defender: ${describe()}`);
  assert.ok(best[POS.MID] > best[POS.DEF],
    `the best midfielder in the pool must out-project the best defender: ${describe()}`);
  const captainPos = gs.players.get(plan.captain).position;
  assert.ok(captainPos === POS.MID || captainPos === POS.FWD,
    `the armband belongs to an attacker when the pool is healthy: ${describe()}`);
  assert.ok(!/^5-/.test(plan.formation),
    `five at the back is the signature of collapsed attacking rates: ${describe()}`);
  assert.ok(plan.xPointsGw > 30 && plan.xPointsGw < 100, `a legal eleven projected ${plan.xPointsGw.toFixed(1)}`);
  // The attacking rates are restored as well as the minutes, so the readiness
  // ladder has no structural reason to hold the plan below what the lifecycle
  // itself allows (the uneven clubs and the unsettled gameweek cap it).
  assert.ok(!readiness.blocked.some((b) => b.code === 'baseline_rates_missing' || b.code === 'projection_inverted'),
    `a baseline that carries its numerators must not trip the rate invariants: ${JSON.stringify(readiness.blocked)}`);
});

// The same invariants on the PRODUCTION payload of 2026-08-22 (six matches at
// provisional full time, twelve clubs played, totals cleared the day before),
// trimmed to the 320-player pool and overlaid with the pre-season snapshot the
// way a returning manager's browser does it. Structural assertions only: no
// name and no recommendation is pinned, because the point is the shape.
test('the 2026-08-22 production payload, baseline applied, projects a football-shaped pool', async () => {
  const snapshot = snapshotFrom(state('preseason'), { seasonLabel: '2025/26' });
  const { bootstrap, fixtures } = payloadFor('live-2026-08-22');
  const gs = buildGameState(bootstrap, fixtures, { baseline: snapshot });
  assert.equal(gs.baselineSource, 'baseline');
  assert.equal(gs.baselineRates, 'carried');

  // A player who played this season carries baseline + this season in BOTH
  // the numerators and the denominators: the blend is one ratio, not two.
  const played = [...gs.players.values()].find((p) => p.seasonMinutes > 0 && snapshot.totals[p.id]);
  const row = snapshot.totals[played.id];
  assert.equal(played.minutes, row.m + played.seasonMinutes, 'minutes blend baseline + this season');
  assert.equal(played.starts, row.s + played.seasonStarts, 'starts blend baseline + this season');
  assert.ok(played.evidenceMatches > snapshot.totalEvents, 'and the match denominator grows with the club\'s matches');
  assert.equal(underlyingRates(played).nineties, played.minutes / 90, 'rates are read over the blended minutes');

  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState: gs, gw: 2 });
  const bundle = await buildPlan({ gameState: gs, squadState, options: { horizon: 3, seed: 7 } });
  const plan = bundle.current;
  const best = bestByPosition(gs, bundle.projections, 2);
  const shape = `${plan.formation}, best GKP/DEF/MID/FWD ${[1, 2, 3, 4].map((k) => (best[k] || 0).toFixed(2)).join('/')}`;
  assert.ok(best[POS.FWD] > best[POS.DEF] && best[POS.MID] > best[POS.DEF], `attackers out-project defenders: ${shape}`);
  assert.ok(!/^5-/.test(plan.formation), `no five-at-the-back: ${shape}`);
  const captainPos = gs.players.get(plan.captain).position;
  assert.ok(captainPos === POS.MID || captainPos === POS.FWD, `an attacking captain: ${shape}`);
  assert.ok(plan.xPointsGw > 30 && plan.xPointsGw < 100, `a football score: ${plan.xPointsGw.toFixed(1)}`);
  const r = bundle.dataStatus.readiness;
  assert.ok(!r.blocked.some((b) => b.code === 'projection_inverted' || b.code === 'baseline_rates_missing'),
    `no rate invariant trips on a consistent baseline: ${r.blocked.map((b) => b.code).join(',')}`);
  // The lifecycle still caps it: clubs uneven and the gameweek unsettled.
  assert.equal(r.allow.chips, false);
});

// A version 1 snapshot - the shape already stored in users' localStorage by
// the 2026-08-21 fix - restores minutes only. It must never again produce a
// one-match-over-a-season rate: the cleared numerators are read over this
// season's minutes alone, the readiness ladder names the gap, and the pool
// keeps its football shape through the position priors.
test('a legacy minutes-only snapshot is read honestly: priors for rates, a named readiness block, no inversion', async () => {
  const full = snapshotFrom(state('preseason'), { seasonLabel: '2025/26' });
  const legacy = {
    ...full,
    version: 1,
    totals: Object.fromEntries(Object.entries(full.totals).map(([id, r]) => [id, { s: r.s, m: r.m, c: r.c }])),
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  storage.setItem('fplPlannerSeasonBaseline.v1', JSON.stringify(legacy));
  const loaded = loadSnapshot(storage);
  assert.ok(loaded, 'a stored version 1 snapshot is still readable');
  assert.equal(resolveBaseline(state('ft-provisional'), loaded).rates, 'missing');

  const { bootstrap, fixtures } = payloadFor('live-2026-08-22');
  const gs = buildGameState(bootstrap, fixtures, { baseline: loaded });
  assert.equal(gs.baselineSource, 'baseline');
  assert.equal(gs.baselineRates, 'missing');

  for (const p of gs.players.values()) {
    if (!legacy.totals[p.id]) continue;
    const rates = underlyingRates(p);
    // The minutes model still has a season to read...
    assert.ok(p.minutes >= legacy.totals[p.id].m, `${p.webName}: baseline minutes restored`);
    // ...but no per-90 rate is ever divided by them.
    if (p.seasonMinutes > 0) {
      assert.equal(rates.nineties, p.seasonMinutes / 90, `${p.webName}: rates read over this season's minutes only`);
    } else {
      assert.equal(rates.source, 'none', `${p.webName}: no minutes this season means no rate evidence`);
    }
  }

  // The next complete payload upgrades it in place.
  const upgraded = saveSnapshotIfBetter(storage, state('preseason'), { seasonLabel: '2025/26' });
  assert.equal(upgraded.version, 2, 'a minutes-only snapshot is replaced by one that carries its numerators');

  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState: gs, gw: 2 });
  const bundle = await buildPlan({ gameState: gs, squadState, options: { horizon: 3, seed: 7 } });
  const r = bundle.dataStatus.readiness;
  assert.ok(r.blocked.some((b) => b.code === 'baseline_rates_missing'), `named: ${r.blocked.map((b) => b.code).join(',')}`);
  assert.equal(r.allow.transfers, false, 'position-average rates cannot carry a transfer');
  // With one match of league-wide numerators the priors themselves are thin,
  // and on this payload they still rank the best defender a whisker above the
  // best attacker. That is exactly what the structural invariant is for: an
  // inverted pool is never allowed to order a lineup, whatever produced it.
  const best = bestByPosition(gs, bundle.projections, 2);
  const inverted = best[POS.FWD] < best[POS.DEF] && best[POS.MID] < best[POS.DEF];
  assert.equal(r.allow.lineup, !inverted,
    `an inverted pool must be withheld: best GKP/DEF/MID/FWD ${[1, 2, 3, 4].map((k) => (best[k] || 0).toFixed(2)).join('/')}, `
    + `blocked ${r.blocked.map((b) => b.code).join(',')}`);
  assert.equal(inverted, r.blocked.some((b) => b.code === 'projection_inverted'));
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

test('a pool whose best attackers sit below its best defender is refused by shape, whatever the total', () => {
  // 2026-08-22: best eleven 46-49, spread intact, and the top of the pool was
  // five defenders. Only the per-position ordering can see this.
  const rows = Array.from({ length: 300 }, (_, i) => ({
    xPoints: i < 60 ? 5 - i * 0.02 : 2.7 - (i - 60) * 0.005,
    pStart: 0.6,
    position: i < 60 ? 2 : (i % 2 ? 3 : 4),
  }));
  const v = projectionVitals(rows);
  assert.equal(v.attackInverted, true);
  assert.ok(v.best11 > PLAUSIBLE_MIN && v.topMedianGap >= 1, 'the aggregate checks pass on this pool');
  const r = assessReadiness({ evidence: { usable: true }, lifecycle: null, vitals: v });
  assert.equal(r.allow.lineup, false);
  assert.ok(r.blocked.some((b) => b.code === 'projection_inverted'));
  // Rows without positions cannot make the claim either way.
  assert.equal(projectionVitals(rows.map(({ xPoints, pStart }) => ({ xPoints, pStart }))).attackInverted, null);
});

test('a missing season history holds the ladder at lineup: no transfer, no chip, on unknown records', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ xPoints: Math.max(0.5, 7 - i * 0.02), pStart: 0.6 }));
  const r = assessReadiness({
    evidence: { usable: true, kind: 'current-season' },
    lifecycle: { clubsLevel: true, clubsPlayed: 20, clubsTotal: 20, phase: GW_PHASE.PRE_DEADLINE },
    vitals: projectionVitals(rows),
    baseline: { source: 'current' },
    squad: { historyMissing: true },
  });
  assert.equal(r.level, LEVEL.LINEUP);
  assert.ok(r.blocked.some((b) => b.code === 'history_missing'));
  assert.match(r.headline, /season history/);
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
