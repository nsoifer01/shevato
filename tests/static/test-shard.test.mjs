// scripts/test-shard.mjs, which splits `npm test` into the CI `test-shard`
// halves. The property that matters is that the halves together are exactly
// `npm test`: a file in no half is a file CI never runs, and nothing else
// would notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, FILE_SECONDS, testScript, testFiles, partition } from '../../scripts/test-shard.mjs';

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const { flags, globs } = testScript(PKG);
const FILES = testFiles(globs);

test('the halves run the "test" script\'s own flags and globs', () => {
  assert.ok(flags.some((f) => f.startsWith('--test-timeout=')), 'the per-file bound travels with the files');
  assert.ok(globs.length >= 10, globs.join(' '));
  assert.ok(FILES.length > 300, `${FILES.length} files`);
  assert.ok(FILES.includes('tests/static/test-shard.test.mjs'), 'this file is one of them');
});

test('for every share count, the shares together hold every file exactly once', () => {
  for (const n of [1, 2, 3, 4]) {
    const all = partition(FILES, n).flatMap((b) => b.files);
    assert.equal(all.length, FILES.length, `n=${n}`);
    assert.deepEqual([...all].sort(), FILES, `n=${n}`);
  }
});

test('two halves are balanced and never carry the three heaviest files together', () => {
  const [a, b] = partition(FILES, 2);
  assert.ok(Math.abs(a.load - b.load) <= Math.max(...Object.values(FILE_SECONDS)) / 2, `${a.load} vs ${b.load}`);
  const heavy = Object.entries(FILE_SECONDS).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([f]) => f);
  for (const share of [a, b]) assert.ok(heavy.filter((f) => share.files.includes(f)).length < 3, share.files.join(' '));
  // Deterministic: the same tree always gives the same halves.
  assert.deepEqual(partition(FILES, 2), partition([...FILES].reverse(), 2));
});

test('every cost entry names a file npm test still runs', () => {
  for (const f of Object.keys(FILE_SECONDS)) {
    assert.ok(existsSync(join(REPO_ROOT, f)) && FILES.includes(f), `stale cost entry: ${f}`);
  }
});

test('a "test" script of another shape is refused rather than misread', () => {
  assert.throws(() => testScript({ scripts: { test: 'jest' } }), /is not `node --test/);
});
