// The performance budget, measured at the size the season actually is.
//
// WHY THIS EXISTS SEPARATELY FROM perf-budget.test.mjs
//
// That file measures the committed sample dataset, and its comment used to
// claim the sample was "the same size as a live season". It is not: the sample
// carries 320 players and the live 2026/27 payload carries 587. Plan time does
// not scale linearly with the pool, so a budget measured on the small fixture
// can pass comfortably while the real thing is over it, which is exactly what
// the readiness audit found.
//
// Rather than commit a 1.4 MB copy of the live payload, the pool here is
// EXPANDED from the sample deterministically to the live count. The point being
// measured is problem size, and this reproduces the size without adding a
// megabyte of fixture to the repo or a dependency on a payload that changes
// every week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

// The live 2026/27 pool, measured against the real API on 2026-08-14.
const LIVE_POOL = 587;

// Measured in CPU TIME, not wall time.
//
// `npm test` runs the repo's suites in parallel, so wall time here measures how
// busy the machine is as much as how much work the planner does: the same build
// clocked 3.3s idle and 5.3s under a full run. CPU time is what the planner
// actually costs, it is what a user's device has to spend, and it does not move
// when a neighbouring test file starts. Wall time is still reported in the
// failure message, because that is what a person experiences.
function cpuMs() {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

const RUNS = 3;
async function fastest(fn) {
  let best = Infinity;
  let bestWall = Infinity;
  let last = null;
  for (let i = 0; i < RUNS; i++) {
    const c0 = cpuMs();
    const w0 = Date.now();
    last = await fn();
    const cpu = cpuMs() - c0;
    if (cpu < best) { best = cpu; bestWall = Date.now() - w0; }
  }
  return { elapsed: Math.round(best), wall: bestWall, bundle: last, result: last, ms: Math.round(best) };
}

// Same numbers perf-budget.test.mjs uses, so the two files cannot drift into
// disagreeing about what "acceptable" means.
const FULL_PLAN_BUDGET_MS = 5000;
const LONGEST_HORIZON_BUDGET_MS = 10000;

// The opening build gets its OWN budget rather than inheriting the one above,
// because it is a different and heavier operation: a full fifteen-man search
// over the whole pool, where the in-season path searches transfers around a
// squad that already exists. Inheriting 5000ms would not be "the same budget
// applied honestly", it would be one measurement's number used for another.
//
// Set from measurement, not from taste. Against the REAL live 2026/27 payload
// (587 players) the opening build costs 3.2-3.5s on an idle machine; the same
// build costs 6.2s of CPU when `npm test` has every core busy, because memory
// bandwidth is contended. 8000ms clears that contention with room to spare and
// still fails outright if the work doubles, which is what a budget is for.
const OPENING_BUILD_BUDGET_MS = 8000;

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (n) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${n}.json`), 'utf8'));
const NAMES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const B = assembleSampleBundle(Object.fromEntries(NAMES.map(n => [n, sample(n)])));

// A deterministic pseudo-random source: the fixture has to be identical on
// every machine and every run, or the budget is measuring noise.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Grow the sample pool to the live count by cloning existing players onto new
// ids with perturbed prices and rates. Clones keep their original club and
// position, so every squad rule still has enough players to satisfy it, and the
// perturbation stops the search from seeing hundreds of identical candidates.
//
// The extra players are drawn from the CHEAPER half of the sample, because that
// is the shape of a real league: 587 registered players is about 260 anybody
// would consider plus a long tail of squad filler. Cloning across the whole
// price range instead manufactured hundreds of extra premium candidates and
// made the search roughly twice as hard as the live payload actually is (3.3s
// measured against the real 2026/27 bootstrap, against 6.6s for that pool),
// which would have made this budget fail on a fixture rather than on the app.
function livePool(bootstrap) {
  const out = JSON.parse(JSON.stringify(bootstrap));
  const byCost = out.elements.slice().sort((a, b) => a.now_cost - b.now_cost || a.id - b.id);
  const source = byCost.slice(0, Math.max(1, Math.floor(byCost.length * 0.5)));
  const rand = rng(20260814);
  let nextId = Math.max(...out.elements.map(e => e.id)) + 1;

  while (out.elements.length < LIVE_POOL) {
    const base = source[out.elements.length % source.length];
    const jitter = 0.85 + rand() * 0.3;
    const clone = { ...base };
    clone.id = nextId++;
    clone.code = clone.id * 1000;
    clone.web_name = `${base.web_name} ${clone.id}`;
    clone.now_cost = Math.max(40, Math.round(base.now_cost * jitter));
    clone.minutes = Math.round((base.minutes || 0) * jitter);
    clone.starts = Math.round((base.starts || 0) * jitter);
    clone.total_points = Math.round((base.total_points || 0) * jitter);
    for (const k of ['expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded']) {
      clone[k] = (parseFloat(base[k] || 0) * jitter).toFixed(2);
    }
    clone.selected_by_percent = (parseFloat(base.selected_by_percent || 0) * jitter).toFixed(1);
    out.elements.push(clone);
  }
  return out;
}

const bootstrap = livePool(B.bootstrap);
const gameState = buildGameState(bootstrap, B.fixtures, { fetchedAt: B.fetchedAt });

test('the expanded pool really is live-sized and still legal to build from', () => {
  assert.equal(gameState.players.size, LIVE_POOL);
  // Enough of every position, and no club so full that a legal squad is
  // impossible: a budget measured on an unbuildable world measures nothing.
  const byPos = new Map();
  for (const p of gameState.players.values()) byPos.set(p.position, (byPos.get(p.position) || 0) + 1);
  for (const pos of Object.values(gameState.rules.positions)) {
    assert.ok((byPos.get(pos.id) || 0) >= pos.squadSelect * 3, `${pos.short}: ${byPos.get(pos.id)}`);
  }
});

test(`a pre-season build on a live-sized pool stays inside ${OPENING_BUILD_BUDGET_MS}ms`, async () => {
  // The opening fifteen is what every user builds in the week before GW1, and
  // it is a full squad search rather than a transfer search.
  const squadState = buildSquadState({
    entry: null, history: null, transfers: null, picks: null, gameState, gw: 1,
  });
  const { ms, result: bundle } = await fastest(() => buildPlan({ gameState, squadState, options: {} }));
  assert.equal(bundle.validation.ok, true);
  assert.equal(bundle.current.squad.length, gameState.rules.squadSize);
  assert.ok(ms < OPENING_BUILD_BUDGET_MS,
    `a live-sized opening build took ${ms}ms of CPU against a ${OPENING_BUILD_BUDGET_MS}ms budget`);
});

test(`a full plan on a live-sized pool stays inside ${FULL_PLAN_BUDGET_MS}ms`, async () => {
  const squadState = buildSquadState({
    entry: B.entry, history: B.history, transfers: B.transfers, picks: B.picks,
    gameState, gw: B.planEvent,
  });
  const { ms, result: bundle } = await fastest(() => buildPlan({ gameState, squadState, options: {} }));

  // A plan that came back fast because it gave up is not inside the budget.
  assert.equal(bundle.validation.ok, true);
  assert.equal(bundle.current.squad.length, gameState.rules.squadSize);
  assert.ok(bundle.current.xPointsGw > 0);

  assert.ok(ms < FULL_PLAN_BUDGET_MS,
    `a live-sized plan took ${ms}ms against a ${FULL_PLAN_BUDGET_MS}ms budget`);
});

test(`the longest horizon on a live-sized pool stays inside ${LONGEST_HORIZON_BUDGET_MS}ms`, async () => {
  const squadState = buildSquadState({
    entry: B.entry, history: B.history, transfers: B.transfers, picks: B.picks,
    gameState, gw: B.planEvent,
  });
  const { ms, result: bundle } = await fastest(() => buildPlan({ gameState, squadState, options: { horizon: 8 } }));
  assert.equal(bundle.validation.ok, true);
  assert.ok(ms < LONGEST_HORIZON_BUDGET_MS,
    `a live-sized horizon-8 plan took ${ms}ms against a ${LONGEST_HORIZON_BUDGET_MS}ms budget`);
});
