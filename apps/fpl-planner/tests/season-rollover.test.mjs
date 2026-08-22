// The season-statistics rollover: the four payload states, and what each one
// must mean.
//
// WHY THIS FILE EXISTS
//
// A start rate is `starts / matches`. The numerator comes from
// bootstrap-static.elements and the denominator from the finished fixture list,
// and until this was fixed nothing checked they described the same season. FPL
// rolls the two over at different moments, so the opening gameweek passes
// through states where they disagree:
//
//   last season's totals + one finished fixture  ->  34 starts / 1 match -> 1.000
//   totals already zeroed + no finished fixture  ->  0 starts / 38       -> nothing
//
// Both are silent. Every probability stays inside [0,1], every projection stays
// finite, and the whole suite stays green while the planner captains a
// goalkeeper on a 20 point gameweek. So these tests assert what the numbers
// MEAN: that start rates vary, that a legal eleven projects a plausible total,
// and that a payload carrying no evidence is reported as such instead of being
// projected from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { goalkeeperPositionId } from '../js/engine/validate.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (n) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${n}.json`), 'utf8'));
const NAMES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const base = assembleSampleBundle(Object.fromEntries(NAMES.map(n => [n, sample(n)])));
const clone = (v) => JSON.parse(JSON.stringify(v));

// Season-total fields FPL zeroes when it rolls a season over.
const TOTAL_FIELDS = ['minutes', 'starts', 'total_points', 'goals_scored', 'assists', 'clean_sheets',
  'goals_conceded', 'bonus', 'bps', 'saves', 'yellow_cards', 'red_cards', 'own_goals',
  'penalties_saved', 'penalties_missed', 'clearances_blocks_interceptions', 'recoveries',
  'tackles', 'defensive_contribution'];
const RATE_FIELDS = ['expected_goals', 'expected_assists', 'expected_goal_involvements',
  'expected_goals_conceded', 'expected_goals_per_90', 'expected_assists_per_90',
  'expected_goal_involvements_per_90', 'expected_goals_conceded_per_90', 'saves_per_90',
  'goals_conceded_per_90', 'starts_per_90', 'clean_sheets_per_90', 'defensive_contribution_per_90'];

// Build one of the four payload states.
//
//   carried  : last season's totals still in the payload
//   zeroed   : FPL has rolled the totals over, nothing played yet
//   rolled   : current-season totals consistent with the fixtures played
//
// `inPlayFixtures` opens the fifth state, observed live on 2026-08-21: the
// totals have been rolled over AND the opening match is under way, so a
// handful of players carry this season's minutes while no fixture has
// finished. See the test that uses it for why it is not any of the other four.
function world({ totals, finishedGws = 0, planGw = 1, inPlayFixtures = 0 }) {
  const bootstrap = clone(base.bootstrap);
  const fixtures = clone(base.fixtures);

  const gws = [...new Set(fixtures.map(f => f.event))].filter(Boolean).sort((a, b) => a - b);
  const played = new Set(gws.slice(0, finishedGws));
  for (const f of fixtures) {
    const on = played.has(f.event);
    f.finished = on;
    f.finished_provisional = on;
    f.started = on;
    if (!on) { f.team_h_score = null; f.team_a_score = null; }
    else { f.team_h_score = f.team_h_score ?? 1; f.team_a_score = f.team_a_score ?? 0; }
  }

  for (const e of bootstrap.events) {
    e.finished = played.has(e.id);
    e.data_checked = played.has(e.id);
    e.is_current = false;
    e.is_next = false;
    e.is_previous = false;
  }
  const target = bootstrap.events.find(e => e.id === planGw);
  if (target) target.is_next = true;

  if (totals === 'zeroed') {
    for (const el of bootstrap.elements) {
      for (const k of TOTAL_FIELDS) el[k] = 0;
      for (const k of RATE_FIELDS) el[k] = '0.0';
    }
  } else if (totals === 'rolled') {
    // Totals that genuinely belong to the finished fixtures.
    //
    // The sample's own element totals are FULL-SEASON sized even though it
    // declares twelve gameweeks played, so the scale factor has to come from
    // the minutes themselves rather than from its currentEvent: a player with
    // 3330 minutes has played 37 matches whatever the fixture list says.
    let implied = 1;
    for (const el of bootstrap.elements) implied = Math.max(implied, Math.ceil((el.minutes || 0) / 90));
    const scale = finishedGws / implied;
    for (const el of bootstrap.elements) {
      el.starts = Math.min(finishedGws, Math.round((el.starts || 0) * scale));
      el.minutes = Math.min(finishedGws * 90, Math.round((el.minutes || 0) * scale));
      for (const k of ['total_points', 'goals_scored', 'assists', 'clean_sheets', 'goals_conceded', 'bonus', 'bps', 'saves']) {
        el[k] = Math.round((el[k] || 0) * scale);
      }
      // The expected_* SEASON totals scale with the minutes too. Leaving them
      // full-sized against four matches of minutes would multiply every per-90
      // rate by nine and project a 167 point gameweek, which is the fixture
      // lying rather than the engine.
      for (const k of ['expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded']) {
        el[k] = (parseFloat(el[k] || 0) * scale).toFixed(2);
      }
    }
  }
  // 'carried' leaves the sample's full-season totals in place.

  // A match under way on top of rolled-over totals: the fixture has STARTED but
  // not finished, and only the players of the two clubs in it carry a minute.
  // This is what FPL actually served at 19:30 UTC on 2026-08-21 - 22 players of
  // 600, one club pair, no finished fixture anywhere.
  if (inPlayFixtures > 0) {
    const gw1 = fixtures.filter(f => f.event === gws[0]).slice(0, inPlayFixtures);
    const clubs = new Set();
    for (const f of gw1) {
      f.started = true;
      f.finished = false;
      f.finished_provisional = false;
      clubs.add(f.team_h);
      clubs.add(f.team_a);
    }
    const perClub = new Map();
    for (const el of bootstrap.elements) {
      if (!clubs.has(el.team)) continue;
      const seen = perClub.get(el.team) || 0;
      if (seen >= 11) continue;          // eleven starters a side, as a match has
      perClub.set(el.team, seen + 1);
      el.starts = 1;
      el.minutes = 90;
    }
  }

  // Pinned to the sample's own capture time, like every other fixture in the
  // suite: `new Date()` here made this the wall clock's business, and a test
  // whose inputs move with the clock cannot fail reproducibly.
  const gameState = buildGameState(bootstrap, fixtures, { fetchedAt: base.fetchedAt });
  return { gameState, bootstrap, fixtures };
}

const P = (gs, id) => gs.players.get(id);

// pStart across the pool a planner actually cares about.
function startStats(gameState, gw) {
  const strength = buildStrength(gameState, { asOfGw: gw });
  const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
  const pool = [...gameState.players.values()]
    .sort((a, b) => b.selectedByPercent - a.selectedByPercent)
    .slice(0, 200);
  const ps = [];
  const xps = [];
  for (const p of pool) {
    const row = projections.get(p.id, gw);
    if (!row) continue;
    if (Number.isFinite(row.pStart)) ps.push(row.pStart);
    if (Number.isFinite(row.xPoints)) xps.push(row.xPoints);
  }
  ps.sort((a, b) => a - b);
  xps.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.floor(arr.length * f)];
  return {
    n: ps.length,
    median: q(ps, 0.5),
    p90: q(ps, 0.9),
    pinned: ps.filter(v => v >= 0.9999).length,
    distinct: new Set(ps.map(v => v.toFixed(3))).size,
    xpMedian: q(xps, 0.5),
    xpMax: xps[xps.length - 1],
    projections,
  };
}

/* ------------------------------------------------------ evidence classifier */

test('the payload states are told apart from the data itself', () => {
  const carriedPre = seasonEvidence(world({ totals: 'carried', finishedGws: 0 }).gameState);
  assert.equal(carriedPre.kind, 'previous-season');
  assert.equal(carriedPre.teamMatches, base.bootstrap.events.length,
    'with nothing played, last season is measured over a full season of gameweeks');

  const carriedLive = seasonEvidence(world({ totals: 'carried', finishedGws: 1 }).gameState);
  assert.equal(carriedLive.kind, 'previous-season',
    'one finished fixture does not turn last season\'s totals into this season\'s');
  assert.ok(carriedLive.teamMatches > 1,
    'so the denominator must not collapse to the single match played');

  const zeroed = seasonEvidence(world({ totals: 'zeroed', finishedGws: 0 }).gameState);
  assert.equal(zeroed.kind, 'none', 'no totals and no fixtures is no evidence at all');

  const rolled = seasonEvidence(world({ totals: 'rolled', finishedGws: 3 }).gameState);
  assert.equal(rolled.kind, 'current-season');
  assert.equal(rolled.teamMatches, 3);
});

/* ------------------------------------------------------------- the states */

test('last season totals, nothing played: start rates vary and look like football', () => {
  const { gameState } = world({ totals: 'carried', finishedGws: 0 });
  const s = startStats(gameState, 1);
  assert.ok(s.median > 0.3 && s.median < 0.95, `median pStart ${s.median}`);
  assert.ok(s.pinned / s.n < 0.15, `${s.pinned}/${s.n} pinned at 1.000`);
  assert.ok(s.distinct > 40, `only ${s.distinct} distinct start rates: a constant is legal but wrong`);
});

test('last season totals with the first fixture played does NOT pin start rates at one', () => {
  // The bug: 34 starts over 1 finished match reads as a certainty for most of
  // the pool, and every projection inflates with it.
  const { gameState } = world({ totals: 'carried', finishedGws: 1 });
  const s = startStats(gameState, 2);
  assert.ok(s.median < 0.95, `median pStart ${s.median} (pinned would be 1.000)`);
  assert.ok(s.pinned / s.n < 0.15, `${s.pinned}/${s.n} of the pool pinned at 1.000`);
  assert.ok(s.distinct > 40, `only ${s.distinct} distinct start rates`);
});

test('rolled-over totals after real fixtures behave normally', () => {
  const { gameState } = world({ totals: 'rolled', finishedGws: 4 });
  const s = startStats(gameState, 5);
  assert.ok(s.median > 0.2 && s.median < 0.98, `median pStart ${s.median}`);
  assert.ok(s.distinct > 20, `only ${s.distinct} distinct start rates`);
});

test('a payload with no evidence at all is reported, not projected from', async () => {
  const { gameState } = world({ totals: 'zeroed', finishedGws: 0 });
  const ev = seasonEvidence(gameState);
  assert.equal(ev.kind, 'none');

  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState, gw: 1 });
  const bundle = await buildPlan({ gameState, squadState, options: { horizon: 3 } });

  // The plan still builds (a legal squad is always buildable), but it must
  // carry the fact that there was nothing to project from, so the UI can
  // refuse to present it as a confident recommendation.
  assert.equal(bundle.dataStatus.evidence.kind, 'none');
  assert.equal(bundle.dataStatus.evidence.usable, false);
  assert.match(bundle.dataStatus.evidence.message, /nothing to project from|no played minutes/i);
});

// THE FIFTH STATE, and the one that shipped broken (observed live 2026-08-21).
//
// FPL cleared every element total at 18:04 UTC, the moment GW1 went current,
// and the opening match kicked off at 19:00. That leaves a payload the other
// four cases never produce: totals belonging to THIS season, a handful of
// players carrying minutes, and not one finished fixture.
//
// `none` did not fire, because it requires `withMinutes === 0` and 22 players
// had minutes. `previous-season` fired instead, because `maxPlayed === 0` was
// read as "nothing has been played, so these totals must be last season's" -
// true every previous August, false the instant the totals are wiped. So 578
// of 600 players were measured as non-starters over a 38 gameweek denominator,
// every projection collapsed, and production recommended selling the one
// player in the squad who had actually started the match (Rice, 1 start read
// as 1/38) for one who had never played (Cherki, who still had the untouched
// price prior). Playing was being punished.
//
// The payload carries no usable evidence and must say so.
test('rolled-over totals with a match in play are not last season, and are not projected from', async () => {
  const { gameState } = world({ totals: 'zeroed', finishedGws: 0, inPlayFixtures: 1 });

  const withMinutes = [...gameState.players.values()].filter(p => p.minutes > 0).length;
  assert.ok(withMinutes > 0, 'the fixture must actually put minutes on the payload');
  assert.ok(withMinutes < gameState.players.size / 4,
    'a match in play touches a fraction of the pool; a full season of totals touches most of it');

  const ev = seasonEvidence(gameState);
  assert.equal(ev.kind, 'none',
    'cleared totals plus a live match are not last season\'s totals');
  assert.equal(ev.usable, false);

  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState, gw: 2 });
  const bundle = await buildPlan({ gameState, squadState, options: { horizon: 3 } });
  assert.equal(bundle.dataStatus.evidence.usable, false,
    'the plan must be withheld rather than presented from nothing');
});

// The symptom, stated as a standing invariant rather than as a classification.
//
// Withholding is what makes the fifth state safe; it is NOT a repair of the
// projections underneath, which still read one start against a full-season
// denominator and rank a player who has just played BELOW one who never has.
// So the two layers are asserted together: either this payload is refused, or
// having played is not evidence against a player. Whoever later makes this
// state usable again - a heavier price prior, or last season's totals kept
// across the rollover - fails this test until the asymmetry is fixed too, which
// is the order those changes have to happen in.
test('either a cleared-totals payload is refused, or having played is not held against a player', async () => {
  const { gameState } = world({ totals: 'zeroed', finishedGws: 0, inPlayFixtures: 1 });

  if (!seasonEvidence(gameState).usable) return;     // refused: the invariant holds by construction

  const strength = buildStrength(gameState, { asOfGw: 2 });
  const projections = buildProjections(gameState, { asOfGw: 2, strength });
  const started = [], unplayed = [];
  for (const p of gameState.players.values()) {
    const xp = projections.get(p.id);
    if (!xp || !Number.isFinite(xp.xPoints)) continue;
    // Like for like: midfielders in a price band that starts football matches.
    if (p.position !== 3 || p.nowCost < 65) continue;
    ((p.starts || 0) > 0 ? started : unplayed).push(xp.xPoints);
  }
  if (!started.length || !unplayed.length) return;
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  assert.ok(med(started) >= med(unplayed),
    `a midfielder who started projects ${med(started).toFixed(2)} while one who has never played projects ` +
    `${med(unplayed).toFixed(2)}: starting a match cannot be evidence against a player`);
});

/* --------------------------------------------- the sport-arithmetic checks */

test('a legal eleven projects a plausible gameweek total in every usable state', async () => {
  for (const [label, opts, gw] of [
    ['last season totals, nothing played', { totals: 'carried', finishedGws: 0 }, 1],
    ['last season totals, one fixture played', { totals: 'carried', finishedGws: 1 }, 2],
    ['rolled totals after four gameweeks', { totals: 'rolled', finishedGws: 4 }, 5],
  ]) {
    const { gameState } = world({ ...opts, planGw: gw });
    const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState, gw });
    const bundle = await buildPlan({ gameState, squadState, options: { horizon: 3 } });
    const plan = bundle.current;

    // An FPL gameweek is not 20 points and it is not 120. This is the assertion
    // that would have caught the collapse: it is a fact about the sport, not
    // about the program.
    assert.ok(plan.xPointsGw > 30 && plan.xPointsGw < 100,
      `${label}: a legal eleven projected ${plan.xPointsGw.toFixed(1)} points`);

    // When every outfield projection collapses toward the appearance floor, the
    // safest-minutes player wins the armband and that player is a goalkeeper.
    const gkId = goalkeeperPositionId(gameState.rules);
    assert.notEqual(P(gameState, plan.captain).position, gkId,
      `${label}: the captain is a goalkeeper, which only happens when outfield projections have collapsed`);
    assert.equal(bundle.dataStatus.evidence.usable, true, `${label}: evidence should be usable`);
  }
});

test('the projected pool keeps a real spread rather than collapsing to one number', () => {
  const { gameState } = world({ totals: 'carried', finishedGws: 1 });
  const s = startStats(gameState, 2);
  // A collapsed pool has almost no spread between its middle and its top.
  assert.ok(s.xpMax - s.xpMedian > 1.5,
    `top projection ${s.xpMax.toFixed(2)} is barely above the median ${s.xpMedian.toFixed(2)}`);
});
