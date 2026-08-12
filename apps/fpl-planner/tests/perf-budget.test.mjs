// A documented performance budget for FULL plan generation.
//
// invariants.test.mjs already budgets the transfer search on its own
// (TRANSFER_SEARCH_BUDGET_MS, 1500ms), but that is one step of five: lineup
// optimization, the captain choice, chip evaluation, alternatives and
// validation all run after it, and none of them were covered by a budget any
// test enforced. The status panel shows the user "Optimizer time" for the whole
// pipeline, so the whole pipeline is what needs a number it must stay under.
//
// Measured over the committed sample dataset (320 players, 380 fixtures), which
// is the same size as a live season. Observed on the development machine on
// 2026-08-12, three runs each:
//
//   horizon 3    613-801ms
//   horizon 5    1098-1536ms     <- the shipped default since 2026-08-12
//   horizon 8    1292-1480ms
//
// Moving the default from 3 to 5 roughly doubled it, which is the price of the
// +21.6 points a window that bought the change (registry entry 9). It runs in a
// Web Worker behind a loading state, so it costs a second of waiting rather than
// a frozen page.
//
// The GitHub CI runner is about twice as slow as the development machine: PR
// #374 measured a 3020 ms median for the default-horizon path. The budgets
// below are set from that CI observation with ~1.65x headroom, so routine
// runner noise passes and a genuine doubling of the work still fails. The
// same number lives in tests/invariants.test.mjs (PLAN_GENERATION_BUDGET_MS);
// keep the two equal - the 3000 left behind there from the horizon-3 era is
// what failed the PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

const FULL_PLAN_BUDGET_MS = 5000;
const LONGEST_HORIZON_BUDGET_MS = 10000;

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));

function realInputs() {
  const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const bundle = assembleSampleBundle(Object.fromEntries(names.map(n => [n, sample(n)])));
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers,
    picks: bundle.picks, gameState, gw: bundle.planEvent,
  });
  return { gameState, squadState, planEvent: bundle.planEvent };
}

// A plan that came in fast because it gave up is not inside the budget, it is
// broken, so every timing assertion checks the output too.
function assertComplete(plan, gw) {
  assert.equal(plan.gw, gw);
  assert.equal(plan.startingXI.length, 11);
  assert.equal(plan.squad.length, 15);
  assert.ok(plan.captain, 'a plan always names a captain');
  assert.ok(plan.viceCaptain);
  assert.ok(plan.explanation && plan.explanation.headline, 'a plan always says what to do');
}

test('full plan generation over a season-sized dataset stays inside its budget', async () => {
  const { gameState, squadState, planEvent } = realInputs();
  assert.ok(gameState.players.size >= 300, `sample dataset has only ${gameState.players.size} players`);
  assert.ok(gameState.fixtures.length >= 300);

  const started = Date.now();
  const bundle = await buildPlan({ gameState, squadState, options: {} });
  const elapsed = Date.now() - started;

  assertComplete(bundle.current, planEvent);
  assert.ok(
    elapsed < FULL_PLAN_BUDGET_MS,
    `full plan generation took ${elapsed}ms, over the ${FULL_PLAN_BUDGET_MS}ms budget`,
  );

  // The status panel reports this number to the user, so it has to be the real
  // cost of the run rather than a stamped-in constant.
  assert.ok(bundle.current.durationMs > 0);
  assert.ok(
    bundle.current.durationMs <= elapsed + 1,
    `reported ${bundle.current.durationMs}ms but the call took ${elapsed}ms`,
  );
});

test('the longest horizon the settings offer is still inside a budget', async () => {
  const { gameState, squadState, planEvent } = realInputs();

  const started = Date.now();
  const bundle = await buildPlan({ gameState, squadState, options: { horizon: 8 } });
  const elapsed = Date.now() - started;

  assertComplete(bundle.current, planEvent);
  // The budget covers the work the horizon actually asks for: this gameweek
  // plus seven planned ahead, not a horizon that was quietly truncated.
  assert.deepEqual(bundle.future.map(f => f.gw), [1, 2, 3, 4, 5, 6, 7].map(n => planEvent + n));
  assert.ok(
    elapsed < LONGEST_HORIZON_BUDGET_MS,
    `an 8-gameweek plan took ${elapsed}ms, over the ${LONGEST_HORIZON_BUDGET_MS}ms budget`,
  );
});

test('progress is reported for every stage the loading screen draws', async () => {
  const { gameState, squadState } = realInputs();
  const stages = [];
  await buildPlan({ gameState, squadState, options: {}, onProgress: (s) => stages.push(s.key) });
  assert.deepEqual(stages, ['load-team', 'analyze-players', 'project-fixtures', 'optimize-transfers', 'build-plan']);
});
