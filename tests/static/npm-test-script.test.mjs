// The `test` script in package.json is the one definition of what the unit
// estate runs, locally and on CI, and the coverage runner copies its suite list.
//
// On 2026-09-14 an edit raising --test-timeout dropped the space after the
// number, which glued the first glob onto the flag:
// `--test-timeout=600000"apps/gym-tracker/tests/**/*.test.*"`. Node then ran
// no Gym Tracker test at all (5,720 tests instead of 6,804) and treated the
// timeout as absent, and every test that did run passed. Only the per-file
// report's "files are unbounded" line gave it away. These checks make that a
// failure instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** { bound, globs } from a `test` script, or throws naming the token that does not fit. */
export function parseTestScript(script) {
  const tokens = String(script).match(/"[^"]*"|\S+/g) || [];
  assert.deepEqual(tokens.slice(0, 2), ['node', '--test'], `the script must start "node --test": ${script}`);
  const m = /^--test-timeout=(\d+)$/.exec(tokens[2] || '');
  assert.ok(m, `the third token must be --test-timeout=<ms> on its own, got ${JSON.stringify(tokens[2])}`);
  const globs = tokens.slice(3);
  for (const g of globs) {
    assert.match(g, /^"[^"\s]+\/\*\*\/\*\.test\.\*"$/, `every remaining token must be one quoted test glob, got ${g}`);
  }
  return { bound: Number(m[1]), globs: globs.map((g) => g.slice(1, -1)) };
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

test('the npm test script is node --test, a numeric per-file bound, then only quoted globs', () => {
  const { bound, globs } = parseTestScript(pkg.scripts.test);
  assert.ok(bound >= 60000, `a per-file bound of ${bound} ms would kill the heavy FPL files`);
  assert.ok(globs.length >= 12, `only ${globs.length} globs`);
  assert.equal(new Set(globs).size, globs.length, 'no glob listed twice');
});

test('THE REGRESSION: a flag glued to the first glob is refused', () => {
  const glued = 'node --test --test-timeout=600000"apps/gym-tracker/tests/**/*.test.*" "apps/arena/tests/**/*.test.*"';
  assert.throws(() => parseTestScript(glued), /--test-timeout=<ms> on its own/);
});

test('the coverage runner measures exactly the suites npm test runs', () => {
  const run = readFileSync(join(REPO_ROOT, 'tests/coverage/run.mjs'), 'utf8');
  const block = /const SUITE_DIRS = \[([\s\S]*?)\];/.exec(run);
  assert.ok(block, 'tests/coverage/run.mjs must still define SUITE_DIRS');
  const covered = [...block[1].matchAll(/'([^']+)'/g)].map((m) => `${m[1]}**/*.test.*`);
  assert.deepEqual([...covered].sort(), [...parseTestScript(pkg.scripts.test).globs].sort());
});
