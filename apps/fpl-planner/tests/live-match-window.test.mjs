// ONE LIVE MATCH READ THE WHOLE LEAGUE AS LAST SEASON (GW4 of 2026/27).
//
// WHY THIS FILE EXISTS
//
// On 2026-09-13, with Manchester United v Manchester City in the second half,
// every projection in the app sat between 0.3 and 0.5 points, the best eleven in
// the game projected 6.4 and recommendations were paused. Nothing upstream was
// wrong. FPL credits `starts` and `minutes` from kickoff, so the ever-present
// starters of that match carried four starts, while the engine counted only the
// three matches their clubs had PLAYED OUT. Thirteen players "had started more
// matches than their club had played", twelve was the quorum for "these totals
// are last season's", and every start rate in the league was divided by 38
// instead of 4.
//
// It had been true of every GW4 match window since the first kickoff after the
// opening baseline retired (2026-09-12 14:00 UTC), and the whole suite was green
// throughout, because no test held a payload with a match in play after the
// season's third round. So these tests hold the real one, rebuild every other
// kickoff window of the gameweek from FPL's own live stats, and assert what the
// numbers MEAN: that a match being played cannot move the league.
//
// The fixtures are derived by scripts/derive-gw4-fixtures.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import * as lifecycleModule from '../js/engine/lifecycle.js';
import {
  assessReadiness, projectionVitals, pausedHeadline, levelAtLeast, LEVEL,
  PLAUSIBLE_GW_MIN, MIN_TOP_MEDIAN_GAP,
} from '../js/engine/readiness.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

const { gameweekLifecycle, matchesPlayedByClub } = lifecycleModule;

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gw4-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const BASE = J('base.json');
const CAPTURED = J('in-play.json');
const GW = 4;
const CAPTURED_AT = '2026-09-13T16:27:00Z';
const NOW = Date.parse(CAPTURED_AT);

const teamId = (short) => BASE.teams.find((t) => t.short_name === short).id;
const MUN = teamId('MUN');
const MCI = teamId('MCI');

/* ------------------------------------------------------------ the payloads */

/**
 * The raw bootstrap + fixtures pair for a captured state.
 *
 * `rewind` takes the listed fixtures' live stats back out of the season totals,
 * which is exactly the state before they kicked off. `phases` overrides a
 * fixture's flags (`null` means not yet kicked off). `element` rewrites each
 * raw element last, for the bad-data cases.
 */
function payload(state = 'in-play', { rewind = [], phases = {}, element = null } = {}) {
  const delta = state === 'in-play' ? CAPTURED : J(`${state}.json`);
  const at = Object.fromEntries(delta.totals.fields.map((f, i) => [f, i]));
  const rows = new Map(delta.totals.rows.map((r) => [r[at.id], r]));
  const liveAt = Object.fromEntries(delta.live.fields.map((f, i) => [f, i]));
  const undo = new Set(rewind);
  const minus = new Map();
  for (const r of delta.live.rows) if (undo.has(r[liveAt.fixture])) minus.set(r[liveAt.id], r);

  const elements = BASE.elements.map((e) => {
    const row = rows.get(e.id);
    const out = { ...e };
    for (const f of delta.totals.fields) {
      if (f !== 'id') out[f] = row ? row[at[f]] : 0;
    }
    const m = minus.get(e.id);
    if (m) {
      for (const f of delta.live.fields) {
        if (f === 'id' || f === 'fixture') continue;
        const v = Number(out[f]) - Number(m[liveAt[f]]);
        // Expected goals travel as strings; everything else is a count. The
        // live read was taken three minutes after the bootstrap, so a minute or
        // two of a match in play can come out as a negative remainder.
        out[f] = typeof out[f] === 'string' ? v.toFixed(2)
          : (f === 'minutes' || f === 'starts') ? Math.max(0, v) : v;
      }
    }
    return element ? element(out) : out;
  });

  const fixtures = BASE.fixtures.map((f) => {
    const ph = f.id in phases ? phases[f.id] : (delta.fixturePhases[f.id] || null);
    const score = delta.scores[f.id] || [null, null];
    return {
      ...f,
      started: ph ? ph.s : false,
      finished: ph ? ph.f : false,
      finished_provisional: ph ? ph.p : false,
      team_h_score: ph ? score[0] : null,
      team_a_score: ph ? score[1] : null,
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

const world = ({ bootstrap, fixtures }) => buildGameState(bootstrap, fixtures, { fetchedAt: CAPTURED_AT });

// The GW4 fixtures that had kicked off when the payload was captured, and the
// distinct kickoff times they fall into.
const GW_FIXTURES = BASE.fixtures.filter((f) => f.event === GW && CAPTURED.fixturePhases[f.id]);
const SLOTS = [...new Set(GW_FIXTURES.map((f) => f.kickoff_time))].sort();

/**
 * One kickoff window of GW4, rebuilt from the capture.
 *
 *   before     the slot's matches have not kicked off and are not in the totals
 *   in-play    they are under way and FPL has credited them
 *   lag        FPL has credited them, but the fixture list (cached separately,
 *              for up to thirty minutes) still says they have not kicked off
 *   full-time  they are at provisional full time
 *
 * Every earlier slot is at provisional full time: each GW4 slot started after
 * the previous one had finished.
 */
const SLOT_PHASE = {
  before: null,
  'in-play': { s: true, p: false, f: false },
  lag: null,
  'full-time': { s: true, p: true, f: false },
};

function kickoffWindow(slot, mode) {
  const now = GW_FIXTURES.filter((f) => f.kickoff_time === slot).map((f) => f.id);
  const later = GW_FIXTURES.filter((f) => f.kickoff_time > slot).map((f) => f.id);
  const phases = {};
  for (const f of GW_FIXTURES) if (f.kickoff_time < slot) phases[f.id] = { s: true, p: true, f: false };
  for (const id of later) phases[id] = null;
  for (const id of now) phases[id] = SLOT_PHASE[mode];
  return {
    clubs: new Set(GW_FIXTURES.filter((f) => f.kickoff_time === slot).flatMap((f) => [f.team_h, f.team_a])),
    gameState: world(payload('in-play', { rewind: mode === 'before' ? [...later, ...now] : later, phases })),
  };
}

/* ------------------------------------------------------------- the reading */

function read(gs) {
  const lifecycle = gameweekLifecycle(gs, { now: NOW });
  const gw = lifecycle.planGw;
  const evidence = seasonEvidence(gs);
  const strength = buildStrength(gs, { asOfGw: gw });
  const projections = buildProjections({ gameState: gs, strength, gwFrom: gw, gwTo: gw });
  const rows = [];
  for (const [id, list] of projections.byPlayer) {
    const r = list.find((x) => x.gw === gw);
    if (r) rows.push({ ...r, id, position: gs.players.get(id).position });
  }
  const vitals = projectionVitals(rows);
  const readiness = assessReadiness({ evidence, lifecycle, vitals, baseline: { source: gs.baselineSource } });
  return { gs, gw, lifecycle, evidence, rows, byId: new Map(rows.map((r) => [r.id, r])), vitals, readiness };
}

const shapeBlocks = (r) => r.readiness.blocked.map((b) => b.code).filter((c) => c.startsWith('projection_'));

// The matches each club's totals include, computed here from the raw flags
// rather than asked of the engine, so the test is not the code checking itself.
function kickedOffByClub(gs) {
  const out = new Map([...gs.teams.keys()].map((t) => [t, 0]));
  for (const f of gs.fixtures) {
    if (!(f.started || f.finished || f.finishedProvisional)) continue;
    for (const t of [f.teamH, f.teamA]) out.set(t, out.get(t) + 1);
  }
  return out;
}

// Fit players who have started every match their club has kicked off, at least
// three of them. Whatever else a minutes model believes, these are starters.
function everPresents(gs) {
  const clubs = kickedOffByClub(gs);
  return [...gs.players.values()].filter((p) => {
    const n = clubs.get(p.teamId);
    return n >= 3 && p.starts === n && p.status === 'a' && p.chanceNext === null;
  });
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/* ======================================================================== */
/* THE PAYLOAD THAT WAS SERVED                                               */
/* ======================================================================== */

test('the payload served mid-match is this season, read over the matches each club has kicked off', () => {
  const gs = world(payload());
  const played = matchesPlayedByClub(gs);
  const kicked = kickedOffByClub(gs);
  // The state itself, so the test cannot quietly drift onto a different one.
  assert.equal(played.get(MUN), 3, 'MUN had played out three matches');
  assert.equal(kicked.get(MUN), 4, 'and kicked off a fourth');
  const over = [...gs.players.values()].filter((p) => p.starts > played.get(p.teamId));
  assert.ok(over.length >= 12,
    `${over.length} players carried more starts than their club had played out, which is the quorum that tripped`);

  const evidence = seasonEvidence(gs);
  assert.equal(evidence.kind, 'current-season',
    'a match being played is not a season boundary');
  assert.equal(evidence.usable, true);
  assert.ok(evidence.matchesByClub, 'every club carries its own denominator');
  for (const club of [MUN, MCI]) {
    assert.equal(evidence.matchesByClub.get(club), 4, `club ${club} is read over the match it is playing`);
  }
  for (const p of gs.players.values()) {
    assert.ok(p.starts <= evidence.matchesByClub.get(p.teamId),
      `${p.webName}: ${p.starts} starts cannot exceed his club's ${evidence.matchesByClub.get(p.teamId)} matches`);
  }
});

test('the payload served mid-match projects a football-shaped pool, not a 6.4 point eleven', () => {
  const r = read(world(payload()));
  assert.ok(r.vitals.best11 >= PLAUSIBLE_GW_MIN,
    `the best eleven projects ${r.vitals.best11.toFixed(1)} (production showed 6.4)`);
  assert.ok(r.vitals.topMedianGap >= MIN_TOP_MEDIAN_GAP, `spread ${r.vitals.topMedianGap.toFixed(2)}`);
  assert.deepEqual(shapeBlocks(r), [], 'no shape check should fire on a healthy pool');
  assert.ok(levelAtLeast(r.readiness.level, LEVEL.TRANSFERS), `readiness ${r.readiness.level}`);

  const nailed = everPresents(r.gs);
  assert.ok(nailed.length > 100, `${nailed.length} ever-presents`);
  const low = nailed.filter((p) => r.byId.get(p.id).pStart < 0.5);
  assert.deepEqual(low.map((p) => `${p.webName} ${r.byId.get(p.id).pStart.toFixed(3)}`), [],
    'a player who has started every match is not a one-in-ten starter');

  // "Unexpectedly tiny projections across the pool": the collapse put the
  // median xP of the most-owned players at a third of a point.
  const owned = [...r.gs.players.values()].sort((a, b) => b.selectedByPercent - a.selectedByPercent).slice(0, 150);
  const ownedMedian = median(owned.map((p) => r.byId.get(p.id).xPoints));
  assert.ok(ownedMedian > 1.5, `median xP of the 150 most-owned players is ${ownedMedian.toFixed(2)}`);
});

test('a plan built from the payload served mid-match is recommended, not paused', async () => {
  const gs = world(payload());
  const gw = gameweekLifecycle(gs, { now: NOW }).planGw;
  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState: gs, gw });
  const bundle = await buildPlan({ gameState: gs, squadState, options: { horizon: 3 }, now: NOW });
  const readiness = bundle.dataStatus.readiness;
  assert.notEqual(pausedHeadline(readiness), 'Recommendations paused', readiness.headline);
  assert.ok(bundle.current.xPointsGw >= PLAUSIBLE_GW_MIN,
    `the recommended eleven projects ${bundle.current.xPointsGw.toFixed(1)} (production showed 7.5)`);
});

test('the payload FPL served at full time reads as the one it served mid-match', () => {
  // The real thing, captured once MUN v MCI reached provisional full time,
  // rather than the in-play capture with its flags flipped.
  const mid = read(world(payload()));
  const ft = read(world(payload('full-time')));
  assert.equal(ft.evidence.kind, 'current-season');
  assert.equal(ft.evidence.matchesByClub.get(MUN), 4, 'MUN is read over the same four matches');
  assert.deepEqual(shapeBlocks(ft), []);
  const drift = Math.abs(ft.vitals.best11 - mid.vitals.best11) / mid.vitals.best11;
  assert.ok(drift < 0.05,
    `best eleven ${mid.vitals.best11.toFixed(1)} mid-match, ${ft.vitals.best11.toFixed(1)} at full time`);
});

/* ======================================================================== */
/* EVERY KICKOFF WINDOW OF THE GAMEWEEK                                      */
/* ======================================================================== */

test('the gameweek has the kickoff windows the incident ran through', () => {
  assert.equal(SLOTS.length, 5, SLOTS.join(', '));
  assert.equal(GW_FIXTURES.length, 9);
});

for (const slot of SLOTS) {
  test(`no match kicking off at ${slot} moves the league: in play, ahead of its fixture list, or at full time`, () => {
    const at = (mode) => ({ ...read(kickoffWindow(slot, mode).gameState), clubs: kickoffWindow(slot, mode).clubs });
    const before = at('before');
    const live = at('in-play');
    const lag = at('lag');
    const done = at('full-time');

    for (const [name, r] of [['before', before], ['in-play', live], ['lag', lag], ['full-time', done]]) {
      assert.equal(r.evidence.kind, 'current-season', `${name}: read as ${r.evidence.kind}`);
      assert.equal(r.evidence.usable, true, name);
      assert.deepEqual(shapeBlocks(r), [], `${name}: no shape check fires`);
    }

    const drift = Math.abs(live.vitals.best11 - before.vitals.best11) / before.vitals.best11;
    assert.ok(drift < 0.1,
      `best eleven ${before.vitals.best11.toFixed(1)} -> ${live.vitals.best11.toFixed(1)} at kickoff`);

    // A club's match can only move that club's players, apart from what the
    // position prior legitimately learns from it. Everyone else is read over
    // his own club's matches, which did not change. The bound is not tight on
    // purpose: ten clubs kicking off at once moves the pooled goalkeeper prior
    // enough to shift Raya by 0.037, and that shift is the same at full time,
    // so it is learning rather than a live-match effect. Reading the league
    // against its busiest club instead moves him 0.18, and every ever-present
    // at a club that has not kicked off with him, which is what this catches.
    let worst = { d: 0, who: '' };
    for (const p of live.gs.players.values()) {
      if (live.clubs.has(p.teamId)) continue;
      const d = Math.abs(live.byId.get(p.id).pStart - before.byId.get(p.id).pStart);
      if (d > worst.d) worst = { d, who: p.webName };
    }
    assert.ok(worst.d < 0.05,
      `${worst.who}'s start probability moved ${worst.d.toFixed(3)} because another club kicked off`);

    // Neither a fixture list that has not caught up nor the final whistle adds
    // anything to the totals FPL has already credited, so neither may change a
    // start probability. Only the price prior of a player who has not played
    // reads played-out matches, and he is excluded.
    const differs = (a, b) => [...a.gs.players.values()]
      .filter((p) => p.minutes > 0 && a.byId.get(p.id).pStart !== b.byId.get(p.id).pStart)
      .map((p) => `${p.webName} ${a.byId.get(p.id).pStart.toFixed(3)} vs ${b.byId.get(p.id).pStart.toFixed(3)}`);
    const stale = differs(lag, live);
    assert.deepEqual(stale.slice(0, 5), [], `${stale.length} start probabilities moved with a stale fixture list`);
    const whistle = differs(done, live);
    assert.deepEqual(whistle.slice(0, 5), [], `${whistle.length} start probabilities moved at the final whistle`);
  });
}

/* ======================================================================== */
/* THE SAFEGUARD, AND BAD UPSTREAM DATA                                      */
/* ======================================================================== */

test('the collapsed reading, if it ever comes back, still pauses every recommendation', async () => {
  // Force the exact misreading: every player measured against a full season.
  const gs = world(payload());
  for (const p of gs.players.values()) p.evidenceMatches = gs.rules.totalEvents;
  const r = read(gs);
  assert.ok(r.vitals.best11 < PLAUSIBLE_GW_MIN, `best eleven ${r.vitals.best11.toFixed(1)}`);
  const codes = r.readiness.blocked.map((b) => b.code);
  assert.ok(codes.includes('projection_implausible'), codes.join(','));
  assert.ok(codes.includes('projection_collapsed'), codes.join(','));
  assert.equal(r.readiness.level, LEVEL.DISPLAY);
  assert.equal(pausedHeadline(r.readiness), 'Recommendations paused');

  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState: gs, gw: r.gw });
  const bundle = await buildPlan({ gameState: gs, squadState, options: { horizon: 3 }, now: NOW });
  assert.equal(bundle.dataStatus.readiness.level, LEVEL.DISPLAY, 'the plan carries the pause');
  assert.equal((bundle.current.transfersOut || []).length, 0, 'and proposes no transfer');
});

test('season counts served as strings project exactly as the numbers do', () => {
  const COUNTS = ['minutes', 'starts', 'total_points', 'bonus', 'bps', 'saves', 'goals_scored', 'assists',
    'clean_sheets', 'goals_conceded', 'clearances_blocks_interceptions', 'recoveries', 'tackles',
    'defensive_contribution'];
  const numbers = read(world(payload()));
  const strings = read(world(payload('in-play', {
    element: (e) => { for (const k of COUNTS) e[k] = String(e[k]); return e; },
  })));
  assert.equal(strings.vitals.best11, numbers.vitals.best11,
    `"4" is not 4 to a sum: ${numbers.vitals.best11.toFixed(1)} became ${strings.vitals.best11.toFixed(1)}`);
});

test('missing projection inputs pause recommendations rather than make them', () => {
  const gw = gameweekLifecycle(world(payload()), { now: NOW }).planGw;

  const noFixtures = payload();
  noFixtures.fixtures = noFixtures.fixtures.filter((f) => f.event !== gw);
  const a = read(world(noFixtures));
  assert.equal(a.readiness.level, LEVEL.DISPLAY, `no fixtures for GW${gw}: ${a.readiness.level}`);

  const noTotals = read(world(payload('in-play', {
    element: (e) => ({ ...e, starts: null, minutes: null }),
  })));
  assert.equal(noTotals.readiness.level, LEVEL.DISPLAY, `no starts or minutes: ${noTotals.readiness.level}`);

  const empty = payload();
  empty.fixtures = [];
  const c = read(world(empty));
  assert.equal(c.evidence.usable, false, 'an empty fixture list is no evidence');
  assert.equal(c.readiness.level, LEVEL.DISPLAY);
});

test('the fixture list may trail the totals by one match, never by two', () => {
  // The lag window, with the live match's ever-presents credited one start
  // further still: totals two matches ahead of the fixture list are not a
  // cache that has not caught up, and must still read as a season boundary.
  const slot = GW_FIXTURES.find((f) => f.team_h === MUN || f.team_a === MUN).kickoff_time;
  const gs = kickoffWindow(slot, 'lag').gameState;
  const clubs = kickedOffByClub(gs);
  let pushed = 0;
  for (const p of gs.players.values()) {
    if ((p.teamId === MUN || p.teamId === MCI) && p.starts === clubs.get(p.teamId) + 1) {
      p.starts += 1;
      p.minutes += 90;
      pushed++;
    }
  }
  assert.ok(pushed >= 12, `${pushed} players pushed two matches ahead`);
  assert.equal(seasonEvidence(gs).kind, 'previous-season');
});

test('a fixture counts towards the totals from kickoff, and as played only from full time', () => {
  const { fixtureHasKickedOff, matchesKickedOffByClub } = lifecycleModule;
  assert.equal(typeof fixtureHasKickedOff, 'function', 'lifecycle names the kicked-off count');
  assert.equal(fixtureHasKickedOff({ started: false, finished: false, finishedProvisional: false }), false);
  assert.equal(fixtureHasKickedOff({ started: true, finished: false, finishedProvisional: false }), true);
  assert.equal(fixtureHasKickedOff({ started: true, finished: false, finishedProvisional: true }), true);
  assert.equal(fixtureHasKickedOff({ started: true, finished: true, finishedProvisional: true }), true);

  const gs = world(payload());
  const kicked = matchesKickedOffByClub(gs);
  const played = matchesPlayedByClub(gs);
  assert.deepEqual([kicked.get(MCI), played.get(MCI)], [4, 3], 'MCI mid-match');
  const LEE = teamId('LEE');
  assert.deepEqual([kicked.get(LEE), played.get(LEE)], [3, 3], 'LEE, not yet kicked off');
  assert.deepEqual(kicked, kickedOffByClub(gs), 'agrees with the raw flags for every club');
});
