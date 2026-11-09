// CPU-time budgets, and why they are not compared under V8 coverage.
//
// The planner's performance budgets (SPEC 13.4) are CPU-time ceilings asserted
// on every `npm test`, the uninstrumented run every pull request makes, which
// is where they measure the planner. The weekly coverage run
// (`npm run test:coverage`) executes the same tests with V8 coverage
// instrumentation, and then the instrumentation dominates the cost: on
// 2026-09-14 a GitHub runner measured a live-sized plan at 10062 ms of CPU
// against its 10000 ms budget and a transfer search at 2315 ms against 1500,
// while the same run's uninstrumented unit job passed both. Coverage slows this
// code unevenly (one test file 2.5 times, another 8 times), so no scaled
// budget would mean anything either.
//
// Under coverage the work still runs, every assertion about its OUTPUT still
// holds, and the measured cost is printed as a diagnostic; only the comparison
// with the ceiling is left to the uninstrumented run.
//
// Node's test runner sets NODE_V8_COVERAGE for every test file it runs with
// --experimental-test-coverage (verified 2026-09-14), as every other V8
// coverage tool does, and that variable is exactly the condition that matters.
import assert from 'node:assert/strict';

export const underCoverage = (env = process.env) => Boolean(env.NODE_V8_COVERAGE);

/**
 * The ceiling for this run: the tighter one when the budget files have a runner
 * to themselves (`node scripts/test-shard.mjs budgets`, CI's test-budgets job).
 * Measured there on 2026-11-09 (24 samples on GitHub, at least four CPU models), the worst
 * healthy costs were 1195, 3412, 6437 and 9238 ms; each ceiling is about 1.3
 * times that. The shared ceiling is for `npm test`, where the neighbours inflate
 * the same work by up to two times and only a large regression can be told apart.
 */
export const budgetMs = (sharedMs, aloneMs, env = process.env) => (env.CPU_BUDGETS_ALONE === '1' ? aloneMs : sharedMs);

/**
 * The cost to judge a repeated measurement by: its cheapest run. Noise on a
 * shared runner (JIT and GC threads, a busy neighbour) only ever ADDS CPU time,
 * so the minimum is the closest reading of what the work costs, and a real
 * slowdown still raises it. A median does not do this: on 2026-11-09 one
 * process measured the same search at 2260, 2016 and 1491 ms, and the median
 * failed a 2000 ms budget sized from a 1509 ms measurement.
 */
export const cheapestRunMs = (timings) => Math.min(...timings);

/**
 * Assert `ms < budgetMs`, unless the process is collecting V8 coverage.
 * Returns true when the budget was compared, false when it was only reported.
 */
export function assertCpuBudget(t, ms, budgetMs, message, env = process.env) {
  if (underCoverage(env)) {
    // The measurement and the budget, not `message`: that is the FAILURE
    // sentence ("... over the budget"), and it would misreport a run inside it.
    t.diagnostic(`CPU budget not compared under V8 coverage: ${Math.round(ms)} ms measured against a ${budgetMs} ms budget`);
    return false;
  }
  t.diagnostic(`CPU budget compared: ${Math.round(ms)} ms measured against a ${budgetMs} ms budget`);
  assert.ok(ms < budgetMs, message);
  return true;
}
