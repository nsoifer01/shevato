// helpers/cpu-budget.mjs: the planner's CPU budgets are compared on every
// uninstrumented run and only reported under V8 coverage. See the helper for
// the measurements (the weekly coverage job failed two budgets on 2026-09-14
// that the same run's plain unit job passed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCpuBudget, underCoverage } from './helpers/cpu-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fakeT = () => ({ diagnostics: [], diagnostic(m) { this.diagnostics.push(m); } });
const PLAIN = {};
const COVERED = { NODE_V8_COVERAGE: '/tmp/node-coverage-x' };

test('without coverage a cost over the budget fails with its message', () => {
  assert.throws(() => assertCpuBudget(fakeT(), 10062, 10000, 'a live-sized plan took 10062ms', PLAIN),
    (e) => e instanceof assert.AssertionError && /a live-sized plan took 10062ms/.test(e.message));
});

test('without coverage a cost inside the budget passes and says it was compared', () => {
  const t = fakeT();
  assert.equal(assertCpuBudget(t, 9000, 10000, 'fine', PLAIN), true);
  assert.deepEqual(t.diagnostics, []);
});

test('the boundary is strict, as the budgets always were', () => {
  assert.throws(() => assertCpuBudget(fakeT(), 10000, 10000, 'at the line', PLAIN));
});

test('under V8 coverage the cost is reported, not compared', () => {
  const t = fakeT();
  assert.equal(assertCpuBudget(t, 2315, 1500, 'transfer search took 2315 ms CPU', COVERED), false);
  assert.equal(t.diagnostics.length, 1);
  assert.equal(t.diagnostics[0], 'CPU budget not compared under V8 coverage: 2315 ms measured against a 1500 ms budget');
});

test('under coverage a run inside its budget is not reported as over it', () => {
  // The failure message says "over the budget"; the diagnostic must not reuse it.
  const t = fakeT();
  assertCpuBudget(t, 8423, 16000, 'an 8-gameweek plan took 8423ms, over the 16000ms budget', COVERED);
  assert.doesNotMatch(t.diagnostics[0], /\bover\b/, '"coverage" is fine; the word "over" is not');
  assert.match(t.diagnostics[0], /8423 ms measured against a 16000 ms budget/);
});

test('coverage is read from NODE_V8_COVERAGE, and an empty value is not coverage', () => {
  assert.equal(underCoverage(COVERED), true);
  assert.equal(underCoverage(PLAIN), false);
  assert.equal(underCoverage({ NODE_V8_COVERAGE: '' }), false);
});

test('every CPU budget in these tests goes through assertCpuBudget', () => {
  // A raw `assert.ok(ms < SOME_BUDGET_MS)` would fail the coverage run again,
  // and dropping the comparison instead would stop the plain run enforcing it.
  const raw = [];
  let helped = 0;
  for (const f of readdirSync(HERE).filter((n) => n.endsWith('.test.mjs') && n !== 'cpu-budget.test.mjs')) {
    const src = readFileSync(join(HERE, f), 'utf8');
    if (/assert\.ok\(\s*[\w.]+\s*<\s*[A-Z_]*BUDGET[A-Z_]*\b/.test(src)) raw.push(f);
    helped += (src.match(/assertCpuBudget\(t,/g) || []).length;
  }
  assert.deepEqual(raw, [], 'compare budgets with assertCpuBudget');
  assert.equal(helped, 6, 'the six budgets: invariants x2, perf-budget x1, perf-live-size x3');
});
