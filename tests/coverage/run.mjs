#!/usr/bin/env node
// Coverage runner for the unit/integration estate.
//
//   npm run test:coverage
//
// Node 20 ships --experimental-test-coverage but not the threshold flags
// (those arrived in Node 22), so this wrapper runs the same suite list as
// `npm test` under coverage, parses the per-file table out of the TAP
// output, and enforces per-area floors itself. It writes a readable report
// to .coverage/summary.md (gitignored) and exits non-zero if any area falls
// below its floor or any test fails.
//
// Notes on the numbers:
// - Test files themselves are excluded from every figure below.
// - Only files a test actually loads appear in V8 coverage at all. Files
//   with zero coverage because nothing imports them are invisible here;
//   the browser suite covers much of that surface instead. Treat these
//   figures as "coverage of the unit-testable layer", not of the site.
// - Per-area aggregates are line-count weighted (each file's percentages
//   weighted by its on-disk line count), which tracks the executable-line
//   weighting closely enough to be stable over time.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// Same directories as the package.json `test` script; keep in sync.
const SUITE_DIRS = [
  'apps/gym-tracker/tests/', 'apps/football-h2h/tests/', 'apps/fpl-planner/tests/',
  'apps/rising-shows/tests/', 'apps/mario-kart/tests/', 'apps/arena/tests/',
  'apps/maptap-rivals/tests/', 'apps/trip-planner/tests/',
  'netlify/functions/tests/', 'sync-system/tests/', 'assets/js/tests/', 'tests/static/',
];

// Area -> path prefix used to bucket per-file rows.
const AREAS = [
  ['arena', 'apps/arena/'],
  ['football-h2h', 'apps/football-h2h/'],
  ['fpl-planner', 'apps/fpl-planner/'],
  ['gym-tracker', 'apps/gym-tracker/'],
  ['maptap-rivals', 'apps/maptap-rivals/'],
  ['mario-kart', 'apps/mario-kart/'],
  ['rising-shows', 'apps/rising-shows/'],
  ['trip-planner', 'apps/trip-planner/'],
  ['netlify-functions', 'netlify/'],
  ['sync-system', 'sync-system/'],
  ['site-shared', 'assets/'],
];

// Line-coverage floors per area, set from the measured 2026-08-15 baseline
// minus a small working margin. Raising a floor is always fine; lowering one
// needs a written justification in TESTING-AUDIT.md. The floors are on the
// line-weighted LINE percentage of covered source files in that area.
const FLOORS = JSON.parse(await readFile(path.join(HERE, 'floors.json'), 'utf8'));

function runCoverage() {
  return new Promise((resolve) => {
    const args = ['--test', '--experimental-test-coverage', ...SUITE_DIRS];
    const child = spawn(process.execPath, args, { cwd: REPO });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function parseTable(out) {
  // Rows look like:
  // # apps/foo/js/bar.js | 99.62 | 79.34 | 100.00 | 351-352
  const rows = [];
  let inTable = false;
  const summary = {};
  for (const line of out.split('\n')) {
    if (line.includes('start of coverage report')) { inTable = true; continue; }
    if (line.includes('end of coverage report')) { inTable = false; continue; }
    const m = /^# tests (\d+)|^# pass (\d+)|^# fail (\d+)|^# skipped (\d+)|^# todo (\d+)/.exec(line);
    if (m) {
      if (m[1] != null) summary.tests = Number(m[1]);
      if (m[2] != null) summary.pass = Number(m[2]);
      if (m[3] != null) summary.fail = Number(m[3]);
      if (m[4] != null) summary.skipped = Number(m[4]);
      if (m[5] != null) summary.todo = Number(m[5]);
    }
    if (!inTable) continue;
    const r = /^#\s+([^|]+?)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/.exec(line);
    if (!r) continue;
    const file = r[1].trim();
    if (file === 'file' || file === 'all files') {
      if (file === 'all files') summary.allFiles = { line: +r[2], branch: +r[3], funcs: +r[4] };
      continue;
    }
    rows.push({ file, line: +r[2], branch: +r[3], funcs: +r[4] });
  }
  return { rows, summary };
}

const isTestFile = (f) =>
  /(^|\/)tests?\//.test(f) || /\.test\.(js|cjs|mjs)$/.test(f) || /(^|\/)e2e\//.test(f)
  || /tests\/(helpers|fixtures)\//.test(f);

async function lineCount(file) {
  try { return (await readFile(path.join(REPO, file), 'utf8')).split('\n').length; }
  catch { return 0; }
}

const { code, out } = await runCoverage();
const { rows, summary } = parseTable(out);
const srcRows = rows.filter((r) => !isTestFile(r.file));
for (const r of srcRows) r.lines = await lineCount(r.file);

function aggregate(list) {
  const w = list.reduce((a, r) => a + r.lines, 0) || 1;
  const wavg = (k) => list.reduce((a, r) => a + r[k] * r.lines, 0) / w;
  return { files: list.length, line: wavg('line'), branch: wavg('branch'), funcs: wavg('funcs') };
}

const report = [];
report.push('# Unit/integration coverage (source files only, test files excluded)');
report.push('');
report.push(`Generated by tests/coverage/run.mjs. Tests: ${summary.tests ?? '?'} `
  + `(pass ${summary.pass ?? '?'}, fail ${summary.fail ?? '?'}, skipped ${summary.skipped ?? '?'}, todo ${summary.todo ?? '?'}).`);
report.push('');
report.push('| Area | Files | Line % | Branch % | Funcs % | Floor (line) | Status |');
report.push('|---|---|---|---|---|---|---|');

let floorsFailed = 0;
const areaStats = {};
for (const [area, prefix] of AREAS) {
  const list = srcRows.filter((r) => r.file.startsWith(prefix));
  if (!list.length) continue;
  const a = aggregate(list);
  areaStats[area] = a;
  const floor = FLOORS[area];
  const ok = floor == null || a.line >= floor;
  if (!ok) floorsFailed++;
  report.push(`| ${area} | ${a.files} | ${a.line.toFixed(2)} | ${a.branch.toFixed(2)} | ${a.funcs.toFixed(2)} | ${floor ?? '-'} | ${ok ? 'ok' : 'BELOW FLOOR'} |`);
}
const total = aggregate(srcRows);
report.push(`| **total** | ${total.files} | ${total.line.toFixed(2)} | ${total.branch.toFixed(2)} | ${total.funcs.toFixed(2)} | - | - |`);
report.push('');
report.push('## Per-file (source files, ascending by line coverage)');
report.push('');
report.push('| File | Line % | Branch % | Funcs % |');
report.push('|---|---|---|---|');
for (const r of [...srcRows].sort((a, b) => a.line - b.line)) {
  report.push(`| ${r.file} | ${r.line.toFixed(2)} | ${r.branch.toFixed(2)} | ${r.funcs.toFixed(2)} |`);
}
report.push('');

await mkdir(path.join(REPO, '.coverage'), { recursive: true });
await writeFile(path.join(REPO, '.coverage', 'summary.md'), report.join('\n'));

console.log(report.slice(0, 20).join('\n'));
console.log(`\nFull report: .coverage/summary.md (${srcRows.length} source files)`);
if (summary.fail) console.error(`\nFAIL: ${summary.fail} test(s) failed under coverage.`);
if (floorsFailed) console.error(`FAIL: ${floorsFailed} area(s) below their line-coverage floor.`);
process.exit(summary.fail || floorsFailed || code ? 1 : 0);
