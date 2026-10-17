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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MUTANTS, REPO_ROOT, COPY_PATHS, occurrences } from '../scripts/mutation-check.mjs';

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
