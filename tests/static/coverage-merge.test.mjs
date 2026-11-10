// The coverage shards are judged as one run (tests/coverage/run.mjs --merge).
// The expected numbers here come from Node's own coverage of a complete,
// unsharded run of the same fixture, never from the merge code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeShards, parseLcov, shardProblems } from '../coverage/lib.mjs';
import { partition, testFiles } from '../../scripts/test-shard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SOURCE = `export function onlyA(x) {
  if (x > 0) {
    return 'positive';
  }
  return 'other';
}

export function onlyB(x) {
  return x === 1
    ? 'one'
    : 'many';
}

export function both() { return 'both'; }

export function nobody() {
  return 'never';
}
`;

// Two test files that exercise different parts of the module, and one that
// also loads a second instance of it through a query string.
const TESTS = {
  'a.test.mjs': `import { test } from 'node:test';
import { onlyA, both } from './module.mjs';
test('a', () => { onlyA(1); both(); });
`,
  'b.test.mjs': `import { test } from 'node:test';
import { onlyB, both } from './module.mjs';
import './only-in-b.mjs';
test('b', () => { onlyB(1); both(); });
`,
  'c.test.mjs': `import { test } from 'node:test';
test('c', async () => {
  const again = await import('./module.mjs?instance=2');
  again.onlyA(-1);
  again.onlyB(2);
});
`,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-merge-'));
  writeFileSync(join(dir, 'module.mjs'), SOURCE);
  writeFileSync(join(dir, 'only-in-b.mjs'), 'export const loaded = true;\n');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [name, body] of Object.entries(TESTS)) writeFileSync(join(dir, name), body);
  return dir;
}

function lcovOf(dir, files) {
  const out = join(dir, `${files.join('-')}.lcov`);
  execFileSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${out}`, ...files], {
    cwd: dir,
    env: { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: undefined, NODE_TEST_CONTEXT: undefined },
    stdio: 'ignore',
  });
  return readFileSync(out, 'utf8');
}

const summary = (tests, fail = 0) => ({ tests, pass: tests - fail, fail, skipped: 0, todo: 0 });
const lcovBody = 'SF:a.js\nDA:1,1\nend_of_record\n';
const shard = (n, files, over = {}) => ({ shard: n, total: 2, sha: 'abc', files, summary: summary(files.length), failures: [], code: 0, lcov: lcovBody, ...over });
const rowsByFile = (rows) => Object.fromEntries(rows.filter((r) => !r.file.endsWith('.test.mjs')).map((r) => [r.file, r]));

test('every way of splitting the fixture across shards gives the unsharded coverage', () => {
  const dir = fixture();
  try {
    const whole = rowsByFile(parseLcov(lcovOf(dir, Object.keys(TESTS)), dir));
    assert.ok(whole['module.mjs'].line > 0 && whole['module.mjs'].line < 100, 'the fixture has both covered and uncovered lines');
    assert.equal(whole['only-in-b.mjs'].line, 100);
    for (const split of [
      [['a.test.mjs'], ['b.test.mjs'], ['c.test.mjs']],
      [['a.test.mjs', 'b.test.mjs'], ['c.test.mjs']],
      [['a.test.mjs', 'c.test.mjs'], ['b.test.mjs']],
    ]) {
      const manifests = split.map((files, i) => ({ shard: i + 1, total: split.length, summary: summary(1), failures: [], code: 0, lcov: lcovOf(dir, files) }));
      const merged = rowsByFile(parseLcov(mergeShards(manifests).lcov, dir));
      assert.deepEqual(Object.keys(merged).sort(), Object.keys(whole).sort(), JSON.stringify(split));
      for (const file of Object.keys(whole)) {
        assert.equal(merged[file].line, whole[file].line, `${file} line %, split ${JSON.stringify(split)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('counts add up, failures are kept, and any shard failing fails the merge', () => {
  const failure = { name: 'x', error: 'boom', location: 'a.test.mjs:1' };
  const m = mergeShards([
    shard(2, ['b'], { summary: summary(3, 1), failures: [failure], code: 1 }),
    shard(1, ['a'], { summary: summary(5) }),
  ]);
  assert.deepEqual(m.summary, { tests: 8, pass: 7, fail: 1, skipped: 0, todo: 0 });
  assert.deepEqual(m.failures, [failure]);
  assert.equal(m.code, 1);
  assert.equal(m.lcov, `${lcovBody}\n${lcovBody}`);
  assert.equal(mergeShards([shard(1, ['a']), shard(2, ['b'])]).code, 0);
});

test('complete shards have no problems', () => {
  assert.deepEqual(shardProblems([shard(1, ['a']), shard(2, ['b'])], ['a', 'b'], 2), []);
});

for (const [name, manifests, expected] of [
  ['a missing shard', [shard(1, ['a', 'b'])], /shard 2: no result/],
  ['no shards at all', [], /shard 1: no result/],
  ['a test file in no shard', [shard(1, ['a']), shard(2, [])], /b: ran in no shard/],
  ['a test file in two shards', [shard(1, ['a', 'b']), shard(2, ['b'])], /b: ran in shards 1 and 2/],
  ['a file outside the estate', [shard(1, ['a', 'b']), shard(2, ['z'])], /ran z, which is not in the test estate/],
  ['an empty LCOV report', [shard(1, ['a']), shard(2, ['b'], { lcov: '' })], /shard 2: its LCOV report is missing or empty/],
  ['a truncated summary', [shard(1, ['a']), shard(2, ['b'], { summary: { tests: 1 } })], /shard 2: its test summary has no pass count/],
  ['a different commit', [shard(1, ['a']), shard(2, ['b'], { sha: 'def' })], /different commits/],
  ['no commit named', [shard(1, ['a'], { sha: '' }), shard(2, ['b'], { sha: '' })], /names no commit/],
  ['a shard from another split', [shard(1, ['a']), shard(2, ['b'], { total: 3 })], /run as one of 3, expected 2/],
]) {
  test(`the merge refuses ${name}`, () => {
    assert.match(shardProblems(manifests, ['a', 'b'], 2).join('\n'), expected);
  });
}

test('the shards of the real estate hold every coverage test file exactly once', () => {
  const run = readFileSync(join(REPO_ROOT, 'tests/coverage/run.mjs'), 'utf8');
  const dirs = [...run.slice(run.indexOf('const SUITE_DIRS'), run.indexOf('const SUITE_GLOBS')).matchAll(/'([^']+\/)'/g)].map((m) => m[1]);
  const files = testFiles(dirs.map((d) => `${d}**/*.test.*`));
  assert.ok(files.length > 300, `${files.length} files`);
  const costs = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/coverage/file-seconds.json'), 'utf8'));
  for (const n of [1, 2, 3, 4]) {
    assert.deepEqual(partition(files, n, costs).flatMap((b) => b.files).sort(), files, `n=${n}`);
  }
});

test('the weekly job runs and merges the same number of shards', () => {
  const yml = readFileSync(join(REPO_ROOT, '.github/workflows/scheduled.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\n  coverage-shard:'), yml.indexOf('\n  cross-browser:'));
  const shards = /shard: \[([\d, ]+)\]/.exec(job)[1].split(',').length;
  assert.match(job, new RegExp(`--merge \\.coverage/shards --total ${shards}\\b`));
  assert.match(job, /--shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/);
  assert.match(job, /needs: coverage-shard\n\s+if: always\(\)/, 'the verdict must run when a shard fails');
  assert.doesNotMatch(job, /continue-on-error/);
});
