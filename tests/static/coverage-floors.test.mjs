// The coverage runner must not pass when it measured nothing (2026-09-12
// audit C-3).
//
// tests/coverage/run.mjs is the only place the per-area line floors are
// enforced, and its input is text scraped out of Node's TAP output. That
// scrape has already broken once: Node 22 turned the flat per-file table into
// an indented tree, and the report read 0.00% everywhere. When it breaks, the
// rows come back empty. The runner used to skip every area with no rows before
// comparing it to its floor, so a parser or output-format change turned the
// weekly floors job green while it enforced nothing at all.
//
// These feed the runner's own parsing and judging code canned output, so they
// run in milliseconds and never start the estate under coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, parseTable, evaluateAreas, isTestFile } from '../coverage/lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FLOORS = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'coverage', 'floors.json'), 'utf8'));

// The shape Node 22 prints (see parseTable's header comment).
const NODE22_TABLE = [
  '# start of coverage report',
  '# -----------------------------------------------------------',
  '# file                 | line % | branch % | funcs % | uncovered lines',
  '# -----------------------------------------------------------',
  '# apps                 |        |          |         | ',
  '#  arena               |        |          |         | ',
  '#   js                 |        |          |         | ',
  '#    scoring.js        |  97.50 |    90.00 |  100.00 | 12-13',
  '# sync-system          |        |          |         | ',
  '#  sync-helpers.js     |  40.00 |    50.00 |   50.00 | 1-60',
  '# all files            |  80.00 |    75.00 |   90.00 | ',
  '# -----------------------------------------------------------',
  '# end of coverage report',
  '# tests 10',
  '# pass 10',
  '# fail 0',
].join('\n');

const withLines = (rows) => rows.filter((r) => !isTestFile(r.file)).map((r) => ({ ...r, lines: 100 }));

test('parseTable reads the Node 22 tree into repo-relative paths', () => {
  const { rows, summary } = parseTable(NODE22_TABLE);
  assert.deepEqual(rows.map((r) => r.file), ['apps/arena/js/scoring.js', 'sync-system/sync-helpers.js']);
  assert.equal(summary.pass, 10);
});

test('an area below its floor fails', () => {
  const { failures } = evaluateAreas(withLines(parseTable(NODE22_TABLE).rows), { 'sync-system': 82 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /sync-system/);
});

for (const [label, out] of [
  ['empty output', ''],
  ['a table in a shape the parser does not know', NODE22_TABLE.replace(/\|/g, '│')],
  ['a run with no coverage report at all', '# tests 10\n# pass 10\n# fail 0\n'],
]) {
  test(`coverage that parses to zero rows fails every floored area: ${label}`, () => {
    const { rows } = parseTable(out);
    assert.equal(rows.length, 0, 'precondition: this output yields no rows');
    const { failures } = evaluateAreas(withLines(rows), FLOORS);
    assert.ok(failures.length > 0, 'a run that measured nothing must not pass the floors');
    for (const area of Object.keys(FLOORS)) {
      assert.ok(failures.some((f) => f.startsWith(`${area}:`)), `${area} has a floor and no measured rows, so it must fail`);
    }
  });
}

test('an area with a floor fails when it alone measured nothing, even if others did', () => {
  const rows = withLines(parseTable(NODE22_TABLE).rows);
  const { failures } = evaluateAreas(rows, { arena: 85, 'trip-planner': 96 });
  assert.deepEqual(failures.map((f) => f.split(':')[0]), ['trip-planner']);
  assert.match(failures[0], /no measured/i, 'the message must say nothing was measured, not report a 0% number');
});

test('an area with no floor and no rows is not a failure', () => {
  // mario-kart has no floor by design (vm-loaded, invisible to V8 coverage).
  const rows = withLines(parseTable(NODE22_TABLE).rows);
  const { failures } = evaluateAreas(rows, { arena: 85 });
  assert.deepEqual(failures, []);
});

test('every floor in floors.json names an area the runner buckets', () => {
  // A floor keyed to a name AREAS does not know would never be compared.
  const known = new Set(AREAS.map(([area]) => area));
  const unknown = Object.keys(FLOORS).filter((area) => !known.has(area));
  assert.deepEqual(unknown, []);
});
