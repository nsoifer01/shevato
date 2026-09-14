// Two guards on the coverage runner, tests/coverage/run.mjs, the only place
// the per-area line floors are enforced.
//
// 1. It must not pass when it measured nothing (2026-09-12 audit C-3). Its
//    input is a report Node writes, and that format has already changed under
//    it once: Node 22 turned the flat per-file TAP table into an indented tree,
//    and the report read 0.00% everywhere. When a parse breaks, the rows come
//    back empty. The runner used to skip every area with no rows before
//    comparing it to its floor, so a format change turned the weekly floors
//    job green while it enforced nothing at all.
//
// 2. A file loaded as more than one module instance is measured as the UNION
//    of its instances (2026-09-14). Node's TAP table credits one instance per
//    path, so sync-system/tests/sync-account-boundary.test.mjs, which imports a
//    fresh engine per test with `?page=N`, left storage-sync-robust.js reading
//    59.61% and failing the sync-system floor for lines its tests do run. The
//    runner now reads LCOV, which carries one record per instance, and merges.
//
// These feed the runner's own parsing and judging code canned output, so they
// run in milliseconds and never start the estate under coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, parseLcov, parseTapSummary, parseTapFailures, evaluateAreas, isTestFile } from '../coverage/lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FLOORS = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'coverage', 'floors.json'), 'utf8'));

const ROOT = '/work/shevato';
const da = (hits) => hits.map((h, i) => `DA:${i + 1},${h}`);

// The shape Node's lcov reporter writes when a test imports a module both
// plainly and as `import('./engine.js?page=1')`: two SF records with the SAME
// path, each carrying only its own instance's hits.
//   plain instance:   lines 1-4 run  -> 4/10 = 40%
//   ?page=1 instance: lines 1, 5-8   -> 5/10 = 50%
//   union:            lines 1-8      -> 8/10 = 80%  (the average would be 45%)
// Branch blocks are numbered per instance, so block 1 is line 3 in one and
// line 6 in the other; they are different branches. Unnamed functions are
// named by their index in each instance's own list, and only the second
// instance lists `retry`, so the arrow function on line 8 is `anonymous_2` in
// one record and `anonymous_3` in the other: still one function.
const LCOV = [
  'TN:',
  'SF:sync-system/engine.js',
  'FN:1,signIn', 'FN:5,signOut', 'FN:8,anonymous_2',
  'FNDA:3,signIn', 'FNDA:0,signOut', 'FNDA:0,anonymous_2', 'FNF:3', 'FNH:1',
  'BRDA:2,0,0,1', 'BRDA:3,1,0,0', 'BRF:2', 'BRH:1',
  ...da([1, 3, 3, 3, 0, 0, 0, 0, 0, 0]),
  'LH:4', 'LF:10', 'end_of_record',
  'SF:sync-system/engine.js',
  'FN:1,signIn', 'FN:5,signOut', 'FN:7,retry', 'FN:8,anonymous_3',
  'FNDA:0,signIn', 'FNDA:2,signOut', 'FNDA:2,retry', 'FNDA:1,anonymous_3', 'FNF:4', 'FNH:3',
  'BRDA:2,0,0,0', 'BRDA:6,1,0,2', 'BRF:2', 'BRH:1',
  ...da([1, 0, 0, 0, 2, 2, 2, 2, 0, 0]),
  'LH:5', 'LF:10', 'end_of_record',
  'SF:apps/arena/js/scoring.js',
  'FN:1,score', 'FNDA:6,score', 'FNF:1', 'FNH:1', 'BRF:0', 'BRH:0',
  ...da([1, 6, 6, 0]),
  'LH:3', 'LF:4', 'end_of_record',
  'SF:sync-system/tests/engine.test.mjs',
  ...da([1, 1]),
  'LH:2', 'LF:2', 'end_of_record',
].join('\n');

const TAP = [
  'TAP version 13',
  'ok 1 - something',
  '# tests 10',
  '# pass 9',
  '# fail 1',
  '# skipped 0',
  '# todo 0',
].join('\n');

const withLines = (rows) => rows.filter((r) => !isTestFile(r.file)).map((r) => ({ ...r, lines: 100 }));
const row = (rows, file) => rows.find((r) => r.file === file);

test('a file loaded as two module instances is measured as the union of their lines', () => {
  const rows = parseLcov(LCOV, ROOT);
  assert.deepEqual(rows.map((r) => r.file).sort(),
    ['apps/arena/js/scoring.js', 'sync-system/engine.js', 'sync-system/tests/engine.test.mjs'],
    'one row per file, not one per instance');
  const engine = row(rows, 'sync-system/engine.js');
  assert.equal(engine.line, 80, 'a line counts as covered when ANY instance ran it');
  for (const wrong of [40, 50, 45]) assert.notEqual(engine.line, wrong);
  assert.equal(engine.funcs, 100,
    'signIn, signOut, retry and the line-8 arrow were each called by some instance; keyed by name, '
    + 'anonymous_2 (never called) and anonymous_3 (called) would count as two functions and read 80%');
  assert.equal(engine.branch.toFixed(2), '66.67', 'branches merge by line, not by the per-instance block number');
  assert.equal(row(rows, 'apps/arena/js/scoring.js').line, 75, 'an unrelated file is not touched by the merge');
});

test('the union decides the floor, not either instance', () => {
  const rows = withLines(parseLcov(LCOV, ROOT));
  assert.deepEqual(evaluateAreas(rows, { 'sync-system': 75, arena: 70 }).failures, [],
    '80% clears a floor of 75 that neither instance alone (40%, 50%) reaches');
  const { failures } = evaluateAreas(rows, { 'sync-system': 82 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^sync-system: line coverage 80\.00 is below its floor of 82$/);
});

test('test files never reach the measured rows', () => {
  const measured = withLines(parseLcov(LCOV, ROOT)).map((r) => r.file);
  assert.ok(!measured.includes('sync-system/tests/engine.test.mjs'));
});

test('SF paths resolve to the repo-relative keys the areas bucket by', () => {
  const lcov = ['SF:../shevato/assets/js/chart.js', 'DA:1,1', 'end_of_record',
    'SF:./netlify/functions/a.mjs', 'DA:1,0', 'end_of_record'].join('\n');
  assert.deepEqual(parseLcov(lcov, ROOT).map((r) => r.file), ['assets/js/chart.js', 'netlify/functions/a.mjs']);
});

test('parseTapSummary reads the run counts', () => {
  assert.deepEqual(parseTapSummary(TAP), { tests: 10, pass: 9, fail: 1, skipped: 0, todo: 0 });
});

for (const [label, out] of [
  ['empty output (no LCOV report was written)', ''],
  ['a report in a shape the parser does not know', LCOV.replace(/^SF:/gm, 'SOURCE:')],
  ['TAP output where the LCOV report should be', TAP],
]) {
  test(`coverage that parses to zero rows fails every floored area: ${label}`, () => {
    const rows = parseLcov(out, ROOT);
    assert.equal(rows.length, 0, 'precondition: this output yields no rows');
    const { failures } = evaluateAreas(withLines(rows), FLOORS);
    assert.ok(failures.length > 0, 'a run that measured nothing must not pass the floors');
    for (const area of Object.keys(FLOORS)) {
      assert.ok(failures.some((f) => f.startsWith(`${area}:`)), `${area} has a floor and no measured rows, so it must fail`);
    }
  });
}

test('an area with a floor fails when it alone measured nothing, even if others did', () => {
  const rows = withLines(parseLcov(LCOV, ROOT));
  const { failures } = evaluateAreas(rows, { arena: 70, 'trip-planner': 96 });
  assert.deepEqual(failures.map((f) => f.split(':')[0]), ['trip-planner']);
  assert.match(failures[0], /no measured/i, 'the message must say nothing was measured, not report a 0% number');
});

test('an area with no floor and no rows is not a failure', () => {
  // mario-kart has no floor by design (vm-loaded, invisible to V8 coverage).
  const rows = withLines(parseLcov(LCOV, ROOT));
  const { failures } = evaluateAreas(rows, { arena: 70 });
  assert.deepEqual(failures, []);
});

test('every floor in floors.json names an area the runner buckets', () => {
  // A floor keyed to a name AREAS does not know would never be compared.
  const known = new Set(AREAS.map(([area]) => area));
  const unknown = Object.keys(FLOORS).filter((area) => !known.has(area));
  assert.deepEqual(unknown, []);
});

// 3. A red run NAMES what failed (2026-09-14). The runner printed only
//    "FAIL: 2 test(s) failed under coverage", so the scheduled job's two
//    failures could not be identified without re-running the whole estate.
const TAP_WITH_FAILURES = `TAP version 13
# Subtest: a passing test
ok 1 - a passing test
  ---
  duration_ms: 1.2
  ...
# Subtest: a pre-season build on a live-sized pool stays inside 18000ms
not ok 2 - a pre-season build on a live-sized pool stays inside 18000ms
  ---
  duration_ms: 23001.5
  location: '/repo/apps/fpl-planner/tests/perf.test.mjs:40:1'
  failureType: 'testCodeFailure'
  error: |-
    took 23001 ms against a budget of 18000 ms
  code: 'ERR_ASSERTION'
  ...
# Subtest: a quarantined defect
not ok 3 - a quarantined defect # TODO KNOWN DEFECT: x
  ---
  duration_ms: 0.4
  location: '/repo/apps/x/tests/y.test.mjs:9:1'
  error: 'still broken'
  ...
# Subtest: a parent
    # Subtest: a nested case
    not ok 1 - a nested case
      ---
      duration_ms: 2
      location: '/repo/sync-system/tests/z.test.mjs:12:3'
      error: 'expected 1, got 2'
      ...
not ok 4 - a parent
  ---
  duration_ms: 3
  location: '/repo/sync-system/tests/z.test.mjs:10:1'
  error: '1 subtest failed'
  ...
# fail 2
`;

test('every failing test is named with its location and error; a TODO quarantine is not a failure', () => {
  const failures = parseTapFailures(TAP_WITH_FAILURES);
  assert.deepEqual(failures.map((f) => f.name), [
    'a pre-season build on a live-sized pool stays inside 18000ms',
    'a nested case',
    'a parent',
  ]);
  assert.equal(failures[0].error, 'took 23001 ms against a budget of 18000 ms', 'a |- block scalar carries the message on the next line');
  assert.equal(failures[0].location, '/repo/apps/fpl-planner/tests/perf.test.mjs:40:1');
  assert.equal(failures[1].error, 'expected 1, got 2');
  assert.deepEqual(parseTapFailures('TAP version 13\nok 1 - fine\n# fail 0\n'), []);
});
