// How much work one transfer search does, counted, not timed.
//
// The CPU budgets (helpers/cpu-budget.mjs) measure time, and on GitHub's
// runners the same healthy search cost 575 to 1211 ms by CPU model, so a
// slowdown has to be 1.3 to 2.8 times before the 1600 ms ceiling fires. The
// regressions this planner has actually had were the search doing more work:
// the exact re-rank (2026-08-17), and elevens sent to simulation that a bound
// could prune (FINDINGS "elevenAutosubBound"). V8 counts every function call
// exactly when precise coverage is on, and for this deterministic search the
// count is the same on every machine (measured 2026-11-10, local and on
// GitHub), so it catches extra work of 20% or more anywhere.
//
// What it cannot see: the same calls each getting slower. The CPU budgets
// remain the guard for that. Under V8 coverage it is skipped: taking precise
// coverage here would reset the counts the coverage run is collecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { buildSquadState } from '../js/engine/squad.js';
import { searchTransfers } from '../js/engine/transfers.js';
import { validatePlan } from '../js/engine/validate.js';
import { assembleSampleBundle } from '../js/data/sample.js';
import { underCoverage } from './helpers/cpu-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Engine function calls for the search below, measured 2026-11-10. A change
// that moves it outside the band is a change to the search's cost: re-measure
// (the failure message prints the count) and update it with the reason.
export const SEARCH_CALLS = 5734158;
export const BAND = { below: 0.8, above: 1.2 };

/** Calls into js/engine/ during `fn`, summed over every named engine function. */
export async function engineCalls(fn) {
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    await session.post('Profiler.takePreciseCoverage');
    const value = fn();
    const { result } = await session.post('Profiler.takePreciseCoverage');
    let calls = 0;
    for (const script of result) {
      if (!script.url.includes('/fpl-planner/js/engine/')) continue;
      for (const f of script.functions) if (f.functionName) calls += f.ranges[0].count;
    }
    return { calls, value };
  } finally {
    await session.post('Profiler.stopPreciseCoverage').catch(() => {});
    session.disconnect();
  }
}

test('one transfer search over the sample does the work it did, within a fifth', { skip: underCoverage() && 'precise coverage would reset the coverage run' }, async (t) => {
  const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const files = Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(join(HERE, '..', 'data', 'sample', `${n}.json`), 'utf8'))]));
  const bundle = assembleSampleBundle(files);
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const strength = buildStrength(gameState, { asOfGw: bundle.currentEvent });
  const projections = buildProjections({ gameState, strength, gwFrom: bundle.planEvent, gwTo: bundle.planEvent + 4 });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers, picks: bundle.picks, gameState, gw: bundle.planEvent,
  });

  const { calls, value: plans } = await engineCalls(() => searchTransfers({ squadState, projections, gameState, rules: gameState.rules, horizon: 5 }));
  t.diagnostic(`engine calls: ${calls} (baseline ${SEARCH_CALLS}, ${(calls / SEARCH_CALLS).toFixed(3)} times)`);
  assert.ok(calls <= SEARCH_CALLS * BAND.above, `the search made ${calls} engine calls, over ${BAND.above} times the ${SEARCH_CALLS} it made`);
  assert.ok(calls >= SEARCH_CALLS * BAND.below, `the search made ${calls} engine calls, under ${BAND.below} times the ${SEARCH_CALLS} it made: if it is a real saving, lower the baseline`);
  // Less work is no saving if it returns nothing, or something illegal.
  assert.ok(plans.length > 1);
  for (const plan of plans) assert.deepEqual(validatePlan(plan, squadState, gameState, gameState.rules).violations, []);
});
