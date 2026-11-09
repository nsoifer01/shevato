// The mutation check's TABLE, checked on every `npm test`.
//
// scripts/mutation-check.mjs runs weekly (scheduled.yml, `mutation`): it is a
// full test-file run per mutant, too slow for a pull request. But the table it
// runs is exact text, and a refactor that moves or rewrites a guarded line
// would only be noticed by that weekly run, a week after the pull request that
// caused it merged. Everything that can go wrong with the table WITHOUT running
// a mutant is checked here, in milliseconds: every `find` still occurs exactly
// once in its file (so the mutant still mutates the line it names), every
// replacement actually changes something, and every mapped test file exists.
// If this goes red after a refactor, update the mutant's `find`/`replace` to
// the new code and re-run `npm run test:mutation:fpl -- --only <id>` to prove
// the tests still kill it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  MUTANTS, REPO_ROOT, COPY_PATHS, FILE_COST_SECONDS, occurrences, failingTestOn, packShards, mutantCostSeconds, run,
} from '../scripts/mutation-check.mjs';

test('the mutant table is well-formed: unique ids, every field present, a dated guard', () => {
  assert.ok(MUTANTS.length >= 20, `the curated table has ${MUTANTS.length} mutants`);
  const ids = new Set();
  for (const m of MUTANTS) {
    assert.match(m.id, /^[a-z0-9-]+$/, `id "${m.id}" is a plain slug (it is passed to --only)`);
    assert.ok(!ids.has(m.id), `id "${m.id}" is unique`);
    ids.add(m.id);
    for (const k of ['file', 'find', 'replace', 'guards']) {
      assert.equal(typeof m[k], 'string', `${m.id}.${k} is a string`);
    }
    assert.ok(m.find.length > 0, `${m.id}.find is not empty`);
    assert.notEqual(m.find, m.replace, `${m.id} changes the code`);
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0, `${m.id} maps at least one test file`);
    assert.ok(m.guards.length > 20, `${m.id} says what rule it guards`);
    assert.match(m.guards, /\d{4}-\d{2}-\d{2}/, `${m.id} dates its guard, so a reader knows which defect or audit it came from`);
  }
});

test('every find occurs exactly once in its file, so a refactor fails here and not silently', () => {
  for (const m of MUTANTS) {
    const abs = join(REPO_ROOT, m.file);
    assert.ok(existsSync(abs), `${m.id}: ${m.file} exists`);
    const n = occurrences(readFileSync(abs, 'utf8'), m.find);
    assert.equal(n, 1, `${m.id}: find occurs ${n} times in ${m.file} (expected exactly 1)`);
  }
});

test('every mapped test file exists, and every mutated or tested file is in the working copy', () => {
  const copied = COPY_PATHS.map(c => c.path);
  const inCopy = (p) => copied.some(root => p === root || p.startsWith(`${root}/`));
  for (const m of MUTANTS) {
    assert.ok(inCopy(m.file), `${m.id}: ${m.file} is copied into the working copy`);
    for (const t of m.tests) {
      assert.ok(existsSync(join(REPO_ROOT, t)), `${m.id}: ${t} exists`);
      assert.match(t, /\.test\.mjs$/, `${m.id}: ${t} is a test file`);
      assert.ok(inCopy(t), `${m.id}: ${t} is copied into the working copy`);
    }
  }
});

test('occurrences counts non-overlapping matches', () => {
  assert.equal(occurrences('a b a b a', 'a'), 3);
  assert.equal(occurrences('aaaa', 'aa'), 2);
  assert.equal(occurrences('abc', 'x'), 0);
  assert.equal(occurrences('abc', ''), 0);
});

test('a failing test ends a run, but a failing todo or skip does not', () => {
  assert.equal(failingTestOn('not ok 3 - the rule holds'), 'the rule holds');
  assert.equal(failingTestOn('    not ok 1 - a nested case'), 'a nested case');
  assert.equal(failingTestOn('ok 3 - the rule holds'), null);
  assert.equal(failingTestOn('not ok 4 - known gap # TODO pinned'), null);
  assert.equal(failingTestOn('not ok 5 - not here # SKIP no data'), null);
  assert.equal(failingTestOn('# not ok in a comment'), null);
});

test('the first failing test stops the run and takes every child process with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-run-'));
  try {
    const pidFile = join(dir, 'child.pid');
    const script = join(dir, 'parent.mjs');
    writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      console.log('ok 1 - fine');
      console.log('not ok 2 - the killer');
      setInterval(() => {}, 1000);
    `);
    const res = await run(process.execPath, [script], dir, 60000, { stopOnFailure: true });
    assert.equal(res.failedTest, 'the killer');
    assert.equal(res.timedOut, false);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
    const until = Date.now() + 10000;
    while (!gone() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.ok(gone(), 'the grandchild was killed with the run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every mutant lands in exactly one shard, the same way every time', () => {
  for (const n of [1, 2, 3, 7]) {
    const shards = packShards(MUTANTS, n);
    assert.equal(shards.length, n);
    const ids = shards.flatMap((s) => s.mutants.map((m) => m.id)).sort();
    assert.deepEqual(ids, MUTANTS.map((m) => m.id).sort());
    assert.deepEqual(packShards([...MUTANTS].reverse(), n).map((s) => s.mutants.map((m) => m.id)), shards.map((s) => s.mutants.map((m) => m.id)));
  }
});

test('every mapped test file has a measured cost', () => {
  const missing = new Set(MUTANTS.flatMap((m) => m.tests).map((t) => basename(t, '.test.mjs')).filter((n) => !(n in FILE_COST_SECONDS)));
  assert.deepEqual([...missing], [], 'time the file and add it to FILE_COST_SECONDS');
});

test('the table fits the weekly job, so outgrowing it fails here and not on the schedule', () => {
  // A shard's cost is split over two workers on a 4-core runner. Measured on
  // GitHub on 2026-11-09, a shard of 1,465 cost-seconds took 549 s, 0.75 of
  // cost / 2 (stopping at the first failure saves some). The factor of 1.2 is
  // 1.6 times that measurement: headroom for a slower runner and the baseline.
  const yml = readFileSync(join(REPO_ROOT, '.github/workflows/scheduled.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\n  mutation:'), yml.indexOf('\n  fpl-archive:'));
  const limit = Number(/timeout-minutes: (\d+)/.exec(job)[1]) * 60;
  const shardCount = /shard: \[([\d, ]+)\]/.exec(job)[1].split(',').length;
  assert.match(job, /--shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/, 'the job passes its shard');
  const heaviest = Math.max(...packShards(MUTANTS, shardCount).map((s) => s.cost));
  assert.ok((heaviest / 2) * 1.2 <= limit, `heaviest shard ${heaviest} s against a ${limit} s limit: add a shard`);
  assert.equal(MUTANTS.reduce((n, m) => n + mutantCostSeconds(m), 0) > 0, true);
});

test('no mutant is judged by a CPU budget, which a busy runner can fail by itself', () => {
  for (const m of MUTANTS) {
    for (const t of m.tests) {
      assert.doesNotMatch(readFileSync(join(REPO_ROOT, t), 'utf8'), /assertCpuBudget\(t,/, `${m.id}: ${t}`);
    }
  }
});
