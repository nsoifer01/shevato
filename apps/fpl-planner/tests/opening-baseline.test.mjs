// THE OPENING-SEASON BASELINE, and the production failure it exists to fix.
//
// WHY THIS FILE EXISTS
//
// The 2026-08-21 repair kept the last complete payload a browser had seen, so
// that FPL clearing the element totals at a rollover could not collapse the
// projections. It was correct and it helped nobody, because of an ordering
// nothing in the code could see:
//
//   2026-08-21 18:04 UTC   FPL clears every element total
//   2026-08-22 16:04 UTC   the guard that keeps a baseline reaches production
//
// `snapshotFrom` only ever returns a snapshot of a COMPLETE payload, and after
// the wipe there were none. So no browser ever wrote `fplPlannerSeasonBaseline`,
// every visitor resolved to `source: 'none'`, and the app refused to plan until
// three matches per club - the whole of GW2 and GW3. The bug was invisible to
// every existing test because they all SEEDED a snapshot into storage first,
// which is a state production could not reach.
//
// So the first test below is the one that would have caught it: the real
// finalised GW1 payload, an EMPTY browser, and the question "does a first-time
// visitor get a plan". Everything after it guards the ways a shipped baseline
// could go wrong - the wrong season, a truncated file, one that outstays its
// welcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { gameweekLifecycle } from '../js/engine/lifecycle.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import {
  resolveBaseline, validateOpeningBaseline, validateKeptSnapshot, snapshotFrom,
  baselineIsSuperseded, assessBaseline, seasonsBehind, OPENING_BASELINE_KIND,
  SNAPSHOT_VERSION, RATE_FIELDS,
} from '../js/engine/baseline.js';
import { assessReadiness, projectionVitals, levelAtLeast, LEVEL } from '../js/engine/readiness.js';
import { loadOpeningBaseline, openingBaselineApplies, resetOpeningBaselineCache, OPENING_BASELINE_FILE } from '../js/data/opening-baseline.js';
import { noticeKinds } from '../js/ui/plan-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'gw1-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const BASE = J('base.json');

/** The asset as it actually ships. Every test here reads the committed file. */
const SHIPPED = JSON.parse(readFileSync(join(HERE, '..', 'data', OPENING_BASELINE_FILE), 'utf8'));

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
  return {
    bootstrap: {
      events: delta.events,
      game_settings: BASE.game_settings,
      game_config: BASE.game_config,
      phases: BASE.phases,
      teams: BASE.teams,
      element_types: BASE.element_types,
      total_players: BASE.total_players,
      elements,
    },
    fixtures,
  };
}

const state = (name) => {
  const { bootstrap, fixtures } = payloadFor(name);
  return buildGameState(bootstrap, fixtures);
};

/** The same payload with a baseline applied, the way app.js rebuilds it. */
function stateWith(name, baseline) {
  const { bootstrap, fixtures } = payloadFor(name);
  return buildGameState(bootstrap, fixtures, { baseline });
}

/** A payload relabelled as a different season, for the future-season guards. */
function relabelled(name, seasonPath, { deadline = null } = {}) {
  const { bootstrap, fixtures } = payloadFor(name);
  const next = {
    ...bootstrap,
    game_config: {
      ...bootstrap.game_config,
      settings: { ...bootstrap.game_config.settings, static_content_url: seasonPath },
    },
    events: deadline
      ? bootstrap.events.map((e) => (e.id === 1 ? { ...e, deadline_time: deadline } : e))
      : bootstrap.events,
  };
  return buildGameState(next, fixtures);
}

const POS = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };

// The instant this file reconstructs: 2026-08-25, GW1 finalised and signed
// off, GW2's deadline still ahead. Every fixture here carries the REAL
// 2026/27 deadlines (GW1 2026-08-21 17:30 UTC, GW2 2026-08-28 17:30 UTC),
// and `gameweekLifecycle` reads the wall clock unless told otherwise, so an
// unpinned call made the assertion describe the calendar rather than the
// payload: it passed until 2026-08-28 17:30 UTC and from then on asserted
// GW2 against an engine correctly answering GW3. Everything else in the
// scenario below is already pinned to GW2 by hand (buildStrength asOfGw,
// buildProjections gwFrom/gwTo, buildSquadState gw), so the clock was the
// one input allowed to drift away from the rest. season-lifecycle.test.mjs
// and ui-confidence.test.mjs pin `now` for the same reason.
const AS_OF = Date.parse('2026-08-25T00:00:00Z');

// The captured picks against the trimmed (320 player) pool: two of the fifteen
// were cut by the sanitiser, so they are replaced by an unowned player of the
// same position who keeps the squad legal. The plan is asserted on shape, not
// on who is in it. Same helper as season-lifecycle.test.mjs, for the same
// reason.
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

/* ------------------------------------------------------- the production bug */

test('THE BUG: a first-time visitor after GW1, with an empty browser and no shipped baseline, is refused', () => {
  // This is production as it stood on 2026-08-25: GW1 finalised, every club
  // one match old, and a browser that never had the chance to keep a snapshot.
  const gs = state('gw1-complete');
  assert.equal(gs.events[0].finished, true, 'the fixture is a FINALISED gameweek');
  assert.equal(gs.events[0].dataChecked, true);

  const resolved = resolveBaseline(gs, null);
  assert.equal(resolved.source, 'none', 'with no snapshot and no shipped asset there is nothing to project from');
  assert.equal(seasonEvidence(gs).usable, false, 'and the payload alone is refused');
});

test('THE FIX: the same visitor, same empty browser, gets a real GW2 plan from the shipped baseline', async () => {
  const gs0 = state('gw1-complete');
  const resolved = resolveBaseline(gs0, null, { shipped: SHIPPED });
  assert.equal(resolved.source, 'baseline');
  assert.equal(resolved.origin, 'shipped', 'the baseline in force is the one shipped with the app');
  assert.equal(resolved.rates, 'carried', 'and it carries the rate numerators, not just minutes');

  const gs = stateWith('gw1-complete', resolved.snapshot);
  assert.equal(gs.baselineSource, 'baseline');
  assert.equal(gs.baselineOrigin, 'shipped');

  const evidence = seasonEvidence(gs);
  assert.equal(evidence.usable, true, 'the blended payload IS projectable');
  assert.equal(evidence.kind, 'previous-season');

  const lifecycle = gameweekLifecycle(gs, { now: AS_OF });
  assert.equal(lifecycle.planGw, 2, 'and the gameweek being planned is GW2, not GW1');

  const strength = buildStrength(gs, { asOfGw: 2 });
  const projections = buildProjections({ gameState: gs, strength, gwFrom: 2, gwTo: 2 });
  const rows = [];
  for (const [, list] of projections.byPlayer) {
    const row = list.find((r) => r.gw === 2);
    if (row) rows.push({ ...row, position: gs.players.get(row.playerId).position });
  }

  // The numbers have to be football, not merely finite. Each of these is a
  // symptom the 2026-08-21 collapse actually produced.
  const vitals = projectionVitals(rows);
  assert.ok(vitals.best11 > 30 && vitals.best11 < 100, `best eleven ${vitals.best11} is a football score`);
  assert.equal(vitals.attackInverted, false, 'forwards and midfielders are not projecting below defenders');
  const starts = rows.map((r) => r.pStart).sort((a, b) => a - b);
  const median = starts[Math.floor(starts.length / 2)];
  assert.ok(median > 0.3 && median < 0.95, `start-rate median ${median} is not pinned`);
  assert.equal(starts.filter((v) => v >= 0.9999).length, 0, 'nobody is a certain starter');

  // And the app is allowed to act on them.
  const readiness = assessReadiness({
    evidence,
    lifecycle,
    vitals,
    baseline: { source: gs.baselineSource, rates: gs.baselineRates },
  });
  assert.ok(levelAtLeast(readiness.level, LEVEL.TRANSFERS),
    `readiness ${readiness.level} allows a transfer recommendation`);

  const squadState = buildSquadState({
    entry: { summary_overall_points: 44 },
    history: { current: [{ event: 1, points: 44, total_points: 44, event_transfers: 0, event_transfers_cost: 0 }], past: [], chips: [] },
    transfers: [],
    picks: ownedPicksFor(gs),
    gameState: gs,
    gw: 2,
  });
  const plan = await buildPlan({ gameState: gs, squadState, options: { horizon: 3 } });
  assert.equal(plan.current.gw, 2, 'the plan is for GW2');
  assert.ok(plan.current.xPointsGw > 30 && plan.current.xPointsGw < 100,
    `plan projects ${plan.current.xPointsGw} points`);
  assert.notEqual(gs.players.get(plan.current.captain).position, POS.GKP,
    'the captain is not a goalkeeper');
  assert.equal(plan.current.startingXI.length, 11);
});

/* ------------------------------------------------- the asset is real data */

test('the shipped baseline is a real captured season, and says where it came from', () => {
  assert.equal(SHIPPED.kind, OPENING_BASELINE_KIND);
  assert.ok(SHIPPED.version >= SNAPSHOT_VERSION, 'it carries the rate numerators');
  assert.equal(SHIPPED.appliesToSeason, '2026/27');
  assert.equal(SHIPPED.coversSeason, '2025/26');
  assert.equal(SHIPPED.firstDeadline, '2026-08-21T17:30:00Z');

  // Provenance is not decoration: without it a committed data file is
  // indistinguishable from invented numbers a year from now.
  const p = SHIPPED.provenance || {};
  assert.ok(p.source, 'names the payload it came from');
  assert.match(p.sourceSha256 || '', /^[0-9a-f]{64}$/, 'pins that payload by hash');
  assert.ok(p.capturedFrom && p.builtBy, 'says where it was captured and what built it');
  assert.ok(Date.parse(SHIPPED.capturedAt) < Date.parse(SHIPPED.firstDeadline) + 60 * 60 * 1000,
    'captured around the opening deadline, before the totals were cleared');

  // The aggregate is a claim about the rows; the rows have to back it up.
  const rows = Object.values(SHIPPED.totals);
  assert.ok(rows.length >= SHIPPED.aggregate.active, 'every active player has a row');
  const starts = rows.reduce((s, r) => s + (r.s || 0), 0);
  const minutes = rows.reduce((s, r) => s + (r.m || 0), 0);
  assert.equal(starts, SHIPPED.aggregate.starts, 'the stated start total is the sum of the rows');
  assert.equal(minutes, SHIPPED.aggregate.minutes);
  assert.ok(starts / SHIPPED.aggregate.active > 10, 'a season of appearances per active player');

  // Every row carries FPL's permanent player id, because element ids are
  // reassigned between seasons and a join on them matches noise.
  assert.equal(rows.filter((r) => r.c == null).length, 0, 'every row carries a player code');
  // ...and the numerators, or the rates it restores would be divided by a
  // denominator they do not belong to.
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const k of ['xg', 'xa', 'bps']) assert.ok(keys.has(k), `rows carry ${k}`);
  assert.ok(Object.keys(RATE_FIELDS).some((k) => keys.has(k)));
});

test('the shipped baseline is accepted for the season it was captured in', () => {
  const gs = state('gw1-complete');
  assert.deepEqual(validateOpeningBaseline(SHIPPED, gs), { ok: true, reasons: [] });
});

/* ------------------------------------------------------- the season guards */

test('a FUTURE season cannot silently reuse this baseline', () => {
  const next = relabelled('gw1-complete', 'https://x/plfpl-production/2027_28/');
  const check = validateOpeningBaseline(SHIPPED, next);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.includes('shipped_wrong_season'), check.reasons.join(','));

  // ...and the refusal is what the app acts on, not a warning it ignores.
  const resolved = resolveBaseline(next, null, { shipped: SHIPPED });
  assert.equal(resolved.source, 'none', 'a stale baseline is not a baseline');
  assert.ok(resolved.rejected.includes('shipped_wrong_season'));
});

test('the same season label with a different opening deadline is refused too', () => {
  // A second, independent pin on the calendar. A payload that claims 2026/27
  // but opens on another date is not the season this asset was built for.
  const moved = relabelled('gw1-complete', 'https://x/plfpl-production/2026_27/', { deadline: '2027-08-13T17:30:00Z' });
  const check = validateOpeningBaseline(SHIPPED, moved);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.includes('shipped_wrong_calendar'), check.reasons.join(','));
});

test('a malformed or truncated baseline is refused rather than projected from', () => {
  const gs = state('gw1-complete');
  const cases = [
    ['no kind', { ...SHIPPED, kind: 'something-else' }, 'shipped_wrong_kind'],
    ['minutes-only version', { ...SHIPPED, version: 1 }, 'shipped_version_too_old'],
    ['no totals', { ...SHIPPED, totals: {} }, 'shipped_no_totals'],
    ['no season', { ...SHIPPED, appliesToSeason: null }, 'shipped_no_season'],
    ['no deadline', { ...SHIPPED, firstDeadline: null }, 'shipped_no_deadline'],
    ['wrong season length', { ...SHIPPED, totalEvents: 40 }, 'shipped_wrong_season_length'],
    ['too few active', { ...SHIPPED, aggregate: { ...SHIPPED.aggregate, active: 1 } }, 'shipped_too_few_active'],
    ['not a season of appearances', {
      ...SHIPPED,
      aggregate: { ...SHIPPED.aggregate, starts: SHIPPED.aggregate.active },
    }, 'shipped_not_a_season'],
    ['truncated rows', {
      ...SHIPPED,
      totals: Object.fromEntries(Object.entries(SHIPPED.totals).slice(0, 5)),
    }, 'shipped_totals_truncated'],
  ];
  for (const [name, asset, reason] of cases) {
    const check = validateOpeningBaseline(asset, gs);
    assert.equal(check.ok, false, `${name} is refused`);
    assert.ok(check.reasons.includes(reason), `${name}: expected ${reason}, got ${check.reasons.join(',')}`);
    assert.equal(resolveBaseline(gs, null, { shipped: asset }).source, 'none', `${name} does not reach the engine`);
  }
});

test('a garbage asset cannot throw its way into the app', () => {
  const gs = state('gw1-complete');
  for (const junk of [null, undefined, 0, '', 'nope', [], {}, { totals: null }]) {
    assert.doesNotThrow(() => validateOpeningBaseline(junk, gs));
    assert.equal(resolveBaseline(gs, null, { shipped: junk }).source, 'none');
  }
});

/* ------------------------------------------------------------- the ladder */

test('the ladder: a rates-carrying kept snapshot outranks the shipped one, which outranks a legacy snapshot', () => {
  const gs = state('gw1-complete');
  const kept = snapshotFrom(state('preseason'), { seasonLabel: '2026/27', capturedAt: '2026-08-21T17:00:00Z' });
  assert.ok(kept, 'the pre-season payload is a usable snapshot');

  const withKept = resolveBaseline(gs, kept, { shipped: SHIPPED });
  assert.equal(withKept.origin, 'kept', "this browser's own complete payload wins");

  const legacy = {
    ...kept,
    version: 1,
    totals: Object.fromEntries(Object.entries(kept.totals).map(([id, r]) => [id, { s: r.s, m: r.m, c: r.c }])),
  };
  const withLegacy = resolveBaseline(gs, legacy, { shipped: SHIPPED });
  assert.equal(withLegacy.origin, 'shipped', 'a minutes-only snapshot loses to an asset that carries the rates');
  assert.equal(withLegacy.rates, 'carried');

  // ...but a legacy snapshot is still better than nothing when there is no
  // asset to fall back to, which is the state the 2026-08-21 fix shipped in.
  const alone = resolveBaseline(gs, legacy);
  assert.equal(alone.origin, 'kept');
  assert.equal(alone.rates, 'missing');
});

test('a kept snapshot from two seasons ago is refused; last season\'s is not', () => {
  const gs = state('gw1-complete');                       // 2026/27
  const make = (seasonLabel) => ({
    ...snapshotFrom(state('preseason'), { seasonLabel, capturedAt: '2026-08-21T17:00:00Z' }),
  });

  assert.equal(validateKeptSnapshot(make('2026/27'), gs).ok, true, 'this season');
  assert.equal(validateKeptSnapshot(make('2025/26'), gs).ok, true, 'last season, which is what a baseline IS');

  const old = validateKeptSnapshot(make('2024/25'), gs);
  assert.equal(old.ok, false, 'two seasons back is a fiction, not a prior');
  assert.ok(old.reasons.includes('kept_snapshot_wrong_season'));

  const future = validateKeptSnapshot(make('2027/28'), gs);
  assert.equal(future.ok, false);
  assert.ok(future.reasons.includes('kept_snapshot_from_the_future'));

  assert.equal(seasonsBehind('2025/26', '2026/27'), 1);
  assert.equal(seasonsBehind('bad', '2026/27'), null);
});

test('an unlabelled snapshot is dated against the season it is being applied to', () => {
  // Every snapshot written before 2026-08-25 carries seasonLabel: null, so it
  // cannot be matched by label. It is placed in time instead.
  const gs = state('gw1-complete');                       // opens 2026-08-21
  const at = (capturedAt) => ({
    ...snapshotFrom(state('preseason'), { seasonLabel: null, capturedAt }),
    seasonLabel: null,
  });

  assert.equal(validateKeptSnapshot(at('2026-08-21T17:00:00Z'), gs).ok, true, 'captured at the deadline');
  assert.equal(validateKeptSnapshot(at('2026-07-01T00:00:00Z'), gs).ok, true, 'captured in pre-season');

  const ancient = validateKeptSnapshot(at('2024-09-01T00:00:00Z'), gs);
  assert.equal(ancient.ok, false, 'two years stale');
  assert.ok(ancient.reasons.includes('kept_snapshot_outside_season'));

  const undateable = validateKeptSnapshot({ ...at('2026-08-21T17:00:00Z'), capturedAt: null }, gs);
  assert.equal(undateable.ok, false, 'no label and no date cannot be placed at all');
  assert.ok(undateable.reasons.includes('kept_snapshot_undateable'));
});

/* --------------------------------------------------------- and it retires */

test('the shipped baseline retires the moment this season is evidence of its own', () => {
  // `baselineIsSuperseded` opens at three matches per club. Until then the
  // asset stands in; after it, the payload speaks for itself and the asset is
  // not consulted at all - which is what stops one committed file becoming a
  // permanent prior.
  const gs = state('gw1-complete');
  assert.equal(baselineIsSuperseded(gs), false, 'one match per club is not yet a season');
  assert.equal(resolveBaseline(gs, null, { shipped: SHIPPED }).source, 'baseline');

  const mature = matureSeason();
  assert.equal(baselineIsSuperseded(mature), true, 'three matches per club');
  const resolved = resolveBaseline(mature, null, { shipped: SHIPPED });
  assert.equal(resolved.source, 'current', 'this season is now the evidence');
  assert.equal(resolved.totals, null, 'and the shipped totals are not applied');
});

test('a mature season is untouched by any of this', () => {
  // The pre-season payload is a complete season in its own right, which is the
  // ordinary case for eleven months of the year.
  const gs = state('preseason');
  assert.equal(assessBaseline(gs).complete, true);
  const resolved = resolveBaseline(gs, null, { shipped: SHIPPED });
  assert.equal(resolved.source, 'current', 'a complete payload never needs a baseline');
  assert.equal(resolved.origin, undefined);
  assert.equal(openingBaselineApplies(gs, { assessment: assessBaseline(gs), superseded: false }), false,
    'and the asset is never even fetched');
});

/** The same fixture with every club three matches in, so the baseline retires. */
function matureSeason() {
  const { bootstrap, fixtures } = payloadFor('gw1-complete');
  const perTeam = new Map();
  const played = fixtures.map((f) => {
    const n = Math.min(perTeam.get(f.team_h) || 0, perTeam.get(f.team_a) || 0);
    if (n >= 3) return f;
    perTeam.set(f.team_h, (perTeam.get(f.team_h) || 0) + 1);
    perTeam.set(f.team_a, (perTeam.get(f.team_a) || 0) + 1);
    return { ...f, started: true, finished: true, finished_provisional: true, team_h_score: 1, team_a_score: 0 };
  });
  return buildGameState(bootstrap, played);
}

/* ------------------------------------------------------------ the loader */

test('the loader fetches the asset once, and a missing file degrades to no baseline', async () => {
  resetOpeningBaselineCache();
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => SHIPPED }; };
  const first = await loadOpeningBaseline({ basePath: 'https://example.test/data/', fetchImpl: ok });
  assert.equal(first.baseline.kind, OPENING_BASELINE_KIND);
  await loadOpeningBaseline({ basePath: 'https://example.test/data/', fetchImpl: ok });
  assert.equal(calls, 1, 'a second plan in the same session does not refetch it');

  resetOpeningBaselineCache();
  const missing = await loadOpeningBaseline({
    basePath: 'https://example.test/data/',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(missing.baseline, null);
  assert.match(missing.reason, /404/);

  resetOpeningBaselineCache();
  const broken = await loadOpeningBaseline({
    basePath: 'https://example.test/data/',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(broken.baseline, null, 'a network failure is not an exception the app has to catch');
  assert.match(broken.reason, /offline/);
  resetOpeningBaselineCache();
});

test('the asset is only fetched in the state it exists for', () => {
  const rolled = state('gw1-complete');
  const complete = state('preseason');
  assert.equal(openingBaselineApplies(rolled, { assessment: assessBaseline(rolled), superseded: false }), true);
  assert.equal(openingBaselineApplies(rolled, { assessment: assessBaseline(rolled), superseded: true }), false,
    'not once this season supersedes it');
  assert.equal(openingBaselineApplies(complete, { assessment: assessBaseline(complete), superseded: false }), false,
    'not when the payload is a season already');
  assert.equal(openingBaselineApplies({ ...rolled, sample: true }, { assessment: assessBaseline(rolled), superseded: false }), false,
    'and never for the demo dataset');
});

/* ----------------------------------------------- GW1 updates the prior */

test('this season\'s one match updates the prior rather than replacing it or being ignored', () => {
  const raw = state('gw1-complete');
  const blended = stateWith('gw1-complete', SHIPPED);

  let checkedPlayer = 0;
  let checkedBenched = 0;
  for (const p of blended.players.values()) {
    const row = SHIPPED.totals[p.id] || Object.values(SHIPPED.totals).find((r) => r.c === p.code);
    if (!row) continue;
    const live = raw.players.get(p.id);

    // Ignored would be `p.starts === row.s`; replaced would be
    // `p.starts === live.seasonStarts`. It is neither: it is the sum.
    assert.equal(p.starts, row.s + live.seasonStarts, `${p.webName}: starts are baseline + this season`);
    assert.equal(p.minutes, row.m + live.seasonMinutes, `${p.webName}: minutes are baseline + this season`);

    // ...over a denominator that grew by exactly the matches his club played,
    // so the rate moves by one match's worth and not by a season's.
    assert.equal(p.evidenceMatches, SHIPPED.totalEvents + 1,
      `${p.webName}: 38 baseline gameweeks plus his club's one match`);

    if (live.seasonMinutes > 0) checkedPlayer++; else checkedBenched++;
  }
  assert.ok(checkedPlayer > 50, `${checkedPlayer} players who played GW1 were checked`);
  assert.ok(checkedBenched > 50, `${checkedBenched} players who did not were checked`);

  // The direction is the point: playing raises a start rate, missing lowers it.
  const rate = (p) => p.starts / p.evidenceMatches;
  const sample = [...blended.players.values()].filter((p) => {
    const row = SHIPPED.totals[p.id];
    return row && row.s > 20;
  });
  const started = sample.filter((p) => raw.players.get(p.id).seasonStarts > 0);
  const missed = sample.filter((p) => raw.players.get(p.id).seasonMinutes === 0);
  const cameOn = sample.filter((p) => {
    const live = raw.players.get(p.id);
    return live.seasonStarts === 0 && live.seasonMinutes > 0;
  });
  assert.ok(started.length && missed.length, 'both groups are populated');

  for (const p of started) {
    const before = SHIPPED.totals[p.id].s / SHIPPED.totalEvents;
    // An ever-present (38 of 38) is already at the ceiling and starting again
    // keeps him there; everyone else moves up. Both are the prior being
    // updated rather than discarded.
    if (before >= 1) assert.equal(rate(p), 1, `${p.webName} was ever-present and started again`);
    else assert.ok(rate(p) > before, `${p.webName} started GW1, so his start rate rose`);
  }
  for (const p of missed) {
    assert.ok(rate(p) < SHIPPED.totals[p.id].s / SHIPPED.totalEvents,
      `${p.webName} missed GW1, so his start rate fell`);
  }
  // A substitute gained minutes without a start, so his START rate falls while
  // his minutes rise. That is the model working, not a bug: the denominator
  // grew and the start numerator did not.
  for (const p of cameOn) {
    assert.ok(rate(p) < SHIPPED.totals[p.id].s / SHIPPED.totalEvents,
      `${p.webName} came off the bench, so his start rate fell`);
    assert.ok(p.minutes > SHIPPED.totals[p.id].m, `${p.webName} still gained the minutes he played`);
  }
});

/* -------------------------------------------------------- the UI state bug */

test('"Plan unchanged" cannot appear on a screen that is not showing a plan', () => {
  // The exact contradiction seen in production: the diff banner rendered above
  // "We are not showing a plan right now", because both withheld branches
  // called the notice builder and it only asked whether a diff EXISTED.
  const withheld = noticeKinds({ planShown: false, planChange: true, outdated: true, notice: true });
  assert.ok(!withheld.includes('plan-change'), withheld.join(','));
  assert.ok(!withheld.includes('outdated'));
  assert.ok(!withheld.includes('rebuilt'));

  // Notices about the DATA are true either way and stay.
  const both = noticeKinds({ planShown: false, sample: true, stale: true, squadWarnings: true, planChange: true });
  assert.deepEqual(both, ['sample', 'stale', 'squad-warnings']);
});

test('a screen that IS showing a plan gets exactly one plan notice, in priority order', () => {
  assert.deepEqual(noticeKinds({ planShown: true, planChange: true }), ['plan-change']);
  assert.deepEqual(noticeKinds({ planShown: true, outdated: true, planChange: true, notice: true }), ['outdated'],
    'an outdated plan outranks the diff: it is the one with an action attached');
  assert.deepEqual(noticeKinds({ planShown: true, planChange: true, notice: true }), ['plan-change'],
    'the diff says everything the generic notice says, and more');
  assert.deepEqual(noticeKinds({ planShown: true, notice: true }), ['rebuilt']);
  assert.deepEqual(noticeKinds({ planShown: true }), []);

  // Stale data and stale sources are one slot, not two.
  assert.deepEqual(noticeKinds({ planShown: true, stale: true, staleSources: true }), ['stale']);
  assert.deepEqual(noticeKinds({ planShown: true, staleSources: true }), ['stale-sources']);
});
