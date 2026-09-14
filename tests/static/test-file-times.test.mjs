// scripts/test-file-times.mjs: the per-file cost report printed by the unit job
// and the coverage runner.
//
// The bound it reports against, `--test-timeout`, is per FILE, not per test.
// PR #542 set it at 180 s as though it bounded each test, and the weekly
// coverage run then killed two FPL files whose tests were all passing
// (2026-09-14). Events below are the shapes node 22 emits, measured with a
// probe reporter: top-level tests at nesting 0 carrying their absolute file,
// and an extra entry named by the file's relative path only when the file
// itself failed or timed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import testFileTimes, { boundFromArgv, fileTimes, formatFileTimes } from '../../scripts/test-file-times.mjs';

const ROOT = '/work/shevato';
const F1 = `${ROOT}/apps/fpl-planner/tests/backtest.test.mjs`;
const F2 = `${ROOT}/tests/static/sitemap.test.mjs`;
const pass = (file, name, ms, nesting = 0) => ({ type: 'test:pass', data: { file, name, nesting, details: { duration_ms: ms, type: 'test' } } });
const timedOutFile = (file, name, ms) => ({
  type: 'test:fail',
  data: { file, name, nesting: 0, details: { duration_ms: ms, type: 'test', error: { failureType: 'testTimeoutFailure' } } },
});

test('a file costs the sum of its top-level tests; nested subtests are already inside their parent', () => {
  const times = fileTimes([
    pass(F1, 'replays a season', 31000),
    pass(F1, 'a nested case', 9000, 1),
    pass(F1, 'the three baselines', 54000),
    pass(F2, 'every sitemap URL resolves', 120),
    { type: 'test:diagnostic', data: { message: 'tests 3' } },
  ]);
  assert.deepEqual(times.get(F1), { ms: 85000, timedOut: false });
  assert.deepEqual(times.get(F2), { ms: 120, timedOut: false });
});

test('a file the bound killed reports its wall time and is marked, even with a test still running', () => {
  const times = fileTimes([
    pass(F1, 'replays a season', 31000),
    timedOutFile(F1, 'apps/fpl-planner/tests/backtest.test.mjs', 180003),
  ]);
  assert.deepEqual(times.get(F1), { ms: 180003, timedOut: true });
});

test('the report ranks files slowest first against the bound, repo-relative', () => {
  const md = formatFileTimes(new Map([
    [F2, { ms: 120, timedOut: false }],
    [F1, { ms: 90000, timedOut: false }],
  ]), { boundMs: 180000, root: ROOT });
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| File') && !l.startsWith('| ---'));
  assert.deepEqual(rows, [
    '| apps/fpl-planner/tests/backtest.test.mjs | 90.0 s | 50% |',
    '| tests/static/sitemap.test.mjs | 0.1 s | 0% |',
  ]);
  assert.match(md, /bounds each file, all its tests together, at 180 s/);
  assert.match(formatFileTimes(new Map([[F1, { ms: 180003, timedOut: true }]]), { boundMs: 180000, root: ROOT }), /\| 180\.0 s \| TIMED OUT \|/);
  assert.match(formatFileTimes(new Map(), { boundMs: null }), /files are unbounded/);
});

test('the bound is read from the runner\'s own flags, in either spelling', () => {
  assert.equal(boundFromArgv(['--test', '--test-timeout=180000']), 180000);
  assert.equal(boundFromArgv(['--test-timeout', '600000', '--test']), 600000);
  assert.equal(boundFromArgv(['--test']), null);
});

test('as a reporter it consumes the event stream and yields one Markdown table', async () => {
  async function* source() {
    yield pass(F1, 'replays a season', 2000);
    yield { type: 'test:start', data: { file: F1, name: 'x', nesting: 0 } };
  }
  const out = [];
  for await (const chunk of testFileTimes(source())) out.push(chunk);
  assert.equal(out.length, 1);
  assert.match(out[0], /backtest\.test\.mjs \| 2\.0 s/);
});
