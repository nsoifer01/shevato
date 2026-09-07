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
//
// Glob patterns rather than bare directories: Node 22's test runner treats a
// positional DIRECTORY as a file to execute (it reports "Cannot find module
// .../apps/arena/tests" and exits 1), so the same change the `test` script
// needed applies here.
const SUITE_DIRS = [
  'apps/gym-tracker/tests/', 'apps/football-h2h/tests/', 'apps/fpl-planner/tests/',
  'apps/rising-shows/tests/', 'apps/mario-kart/tests/', 'apps/arena/tests/',
  'apps/maptap-rivals/tests/', 'apps/trip-planner/tests/',
  'netlify/functions/tests/', 'sync-system/tests/', 'assets/js/tests/', 'tests/static/',
];
const SUITE_GLOBS = SUITE_DIRS.map((d) => `${d}**/*.test.*`);

// Production files that no unit test imports.
//
// V8 coverage only reports files something LOADED, so a module nothing
// imports does not appear in the table at all - it is not 0%, it is absent,
// and an area's weighted average is computed as though it did not exist. That
// is how a large untested file can sit next to a healthy-looking percentage
// (2026-09-05 audit F21). The inventory below is walked from disk and
// subtracted from what coverage reported, so the report NAMES what it did not
// measure instead of quietly dropping it.
//
// Excluded from the inventory, with reasons: vendored third-party code, the
// generated data bundles, build scripts (run by the build, not by the app),
// and the e2e/test trees themselves.
const INVENTORY_ROOTS = [
  'apps/gym-tracker/js', 'apps/football-h2h', 'apps/fpl-planner/js',
  'apps/rising-shows/js', 'apps/mario-kart/js', 'apps/arena/js',
  'apps/maptap-rivals/js', 'apps/trip-planner/js',
  'netlify/functions', 'sync-system', 'assets/js',
];
const INVENTORY_SKIP = /(^|\/)(tests?|e2e|tests-rules|vendor|node_modules|scripts|experiments|data|fixtures|helpers)(\/|$)|\.min\.js$|\.test\.(js|cjs|mjs)$/;

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
    const args = ['--test', '--experimental-test-coverage', ...SUITE_GLOBS];
    const child = spawn(process.execPath, args, { cwd: REPO });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function parseTable(out) {
  // TWO TABLE SHAPES, because Node changed it.
  //
  // Node 20 printed one flat repo-relative path per row:
  //     # apps/foo/js/bar.js | 99.62 | 79.34 | 100.00 | 351-352
  //
  // Node 22 prints an indented TREE, where a directory row carries no
  // percentages and a file row's full path is its own name prefixed by the
  // directories above it at smaller indents:
  //     # apps                     |        |        |        |
  //     #  gym-tracker             |        |        |        |
  //     #   js                     |        |        |        |
  //     #    app.js                |  91.20 |  84.10 |  88.00 | 12-14
  //
  // Reading the second as though it were the first yields BASENAMES, every
  // area prefix matches nothing, and the report says 0.00% across the board
  // while claiming every production file is unmeasured. Both are parsed here
  // so the runner is not silently wrong on either runtime.
  const rows = [];
  let inTable = false;
  const summary = {};
  const stack = [];   // [{ indent, name }] for the Node 22 tree
  for (const line of out.split('\n')) {
    if (line.includes('start of coverage report')) { inTable = true; stack.length = 0; continue; }
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

    // `# ` then the (possibly indented) name, then the three percentage
    // columns. A directory row has them blank.
    const r = /^#(\s+)([^|]*?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/.exec(line);
    if (!r) continue;
    const indent = r[1].length;
    const name = r[2].trim();
    if (!name || name === 'file') continue;
    const isDir = r[3] === '' && r[4] === '' && r[5] === '';

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (isDir) { stack.push({ indent, name }); continue; }

    if (name === 'all files') {
      summary.allFiles = { line: +r[3], branch: +r[4], funcs: +r[5] };
      continue;
    }
    const file = [...stack.map((e) => e.name), name].join('/');
    rows.push({ file, line: +r[3], branch: +r[4], funcs: +r[5] });
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

/** Every production source file under INVENTORY_ROOTS, repo-relative. */
async function productionInventory() {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(path.join(REPO, dir), { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (INVENTORY_SKIP.test(rel)) continue;
      if (e.isDirectory()) await walk(rel);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) found.push(rel);
    }
  }
  for (const root of INVENTORY_ROOTS) await walk(root);
  return found;
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

// What coverage never saw. Not a floor - some of these are genuinely browser-
// only surface the CDP suite covers instead - but it has to be VISIBLE, or an
// untested module is indistinguishable from a well-tested one in every number
// above it.
const inventory = await productionInventory();
const measured = new Set(srcRows.map((r) => r.file));
const unmeasured = inventory.filter((f) => !measured.has(f));
report.push('## Production files no unit test loaded');
report.push('');
report.push(`${unmeasured.length} of ${inventory.length} production source files were never `
  + 'imported by the unit estate, so they appear in no percentage above. '
  + 'The browser suite covers much of this surface; anything here that it does '
  + 'not is untested.');
report.push('');
for (const f of unmeasured.sort()) report.push(`- ${f}`);
report.push('');

await mkdir(path.join(REPO, '.coverage'), { recursive: true });
await writeFile(path.join(REPO, '.coverage', 'summary.md'), report.join('\n'));

console.log(report.slice(0, 20).join('\n'));
console.log(`\nFull report: .coverage/summary.md (${srcRows.length} measured, `
  + `${unmeasured.length} of ${inventory.length} production files unmeasured)`);
if (summary.fail) console.error(`\nFAIL: ${summary.fail} test(s) failed under coverage.`);
if (floorsFailed) console.error(`FAIL: ${floorsFailed} area(s) below their line-coverage floor.`);
process.exit(summary.fail || floorsFailed || code ? 1 : 0);
