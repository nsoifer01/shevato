// The browser shard packer's cost table (SUITE_SECONDS in
// tests/browser/run.mjs) names exactly the suites in SUITES.
//
// A suite missing from the table is not an error at run time: it is charged a
// default and the partition stays total, so nothing fails. It just skews the
// shards, and the slowest shard IS the browser gate's wall clock. That is how
// csp.mjs ran for weeks at a guessed 90 s against a measured 59 s. A stale
// entry for a suite that no longer exists is the same drift the other way.
// Checked by reading run.mjs as text, because importing it runs the estate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(join(REPO, 'tests/browser/run.mjs'), 'utf8');

function block(name, open, close) {
  const start = src.indexOf(`const ${name} = ${open}`);
  assert.ok(start >= 0, `run.mjs no longer declares ${name}`);
  const end = src.indexOf(`\n${close};`, start);
  assert.ok(end > start, `could not find the end of ${name}`);
  // Comments out, so a path mentioned in prose is not read as an entry.
  return src.slice(start, end).replace(/\/\/[^\n]*/g, '');
}

const suites = [...block('SUITES', '[', ']').matchAll(/'([^']+\.mjs)'/g)].map((m) => m[1]);
const costed = [...block('SUITE_SECONDS', '{', '}').matchAll(/'([^']+\.mjs)':\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);

test('every suite has a measured cost, and every cost belongs to a suite', () => {
  assert.ok(suites.length >= 20, `SUITES parsed to ${suites.length} entries; the parser broke`);
  const costs = new Map(costed);
  assert.deepEqual(suites.filter((s) => !costs.has(s)), [],
    'add a measured cost to SUITE_SECONDS (run.mjs prints each suite\'s time at the end of every run)');
  assert.deepEqual(costed.map(([s]) => s).filter((s) => !suites.includes(s)), [],
    'remove the cost of a suite that is no longer in SUITES');
});

test('no suite is listed twice', () => {
  assert.equal(new Set(suites).size, suites.length);
  assert.equal(new Set(costed.map(([s]) => s)).size, costed.length);
});
