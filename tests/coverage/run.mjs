#!/usr/bin/env node
// Coverage runner for the unit/integration estate.
//
//   npm run test:coverage
//
// Node's own coverage thresholds are global, not per area, so this wrapper
// runs the same suite list as `npm test` under
// --experimental-test-coverage, reads per-file coverage from Node's LCOV reporter
// (.coverage/lcov.info), takes the test counts from the TAP stream, and
// enforces per-area floors itself. It writes a readable report to
// .coverage/summary.md (gitignored) and exits non-zero if any area falls
// below its floor or any test fails.
//
// Notes on the numbers:
// - A file loaded as several module instances (a `?page=N` re-import) is
//   measured as the UNION of its instances. The TAP table credits only one
//   instance per path, which is why it is not read; see parseLcov in lib.mjs.
// - Test files themselves are excluded from every figure below.
// - Only files a test actually loads appear in V8 coverage at all. Files
//   with zero coverage because nothing imports them are invisible here;
//   the browser suite covers much of that surface instead. Treat these
//   figures as "coverage of the unit-testable layer", not of the site.
// - Per-area aggregates are line-count weighted (each file's percentages
//   weighted by its on-disk line count), which tracks the executable-line
//   weighting closely enough to be stable over time.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLcov, parseTapSummary, isTestFile, aggregate, evaluateAreas } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const LCOV = path.join(REPO, '.coverage', 'lcov.info');

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

// Line-coverage floors per area, set from the measured 2026-08-15 baseline
// minus a small working margin. Raising a floor is always fine; lowering one
// needs a written justification in TESTING-AUDIT.md. The floors are on the
// line-weighted LINE percentage of covered source files in that area.
//
// site-shared gained a floor on 2026-09-07 (audit F21): assets/js became
// measurable when chart-a11y.js arrived with unit tests, and an area with
// coverage and no floor is an area that can quietly lose it.
//
// mario-kart still has NO floor, and that is not an oversight: not one of its
// source files is loaded by the unit estate (its tests build vm contexts,
// which V8 coverage does not attribute to the file), so there is no number to
// put a floor under. A floor over an empty set would read as coverage. What
// the audit actually asked for - that the gap be visible rather than absent -
// is the unmeasured-file inventory at the bottom of the report, which names
// every one of them.
const FLOORS = JSON.parse(await readFile(path.join(HERE, 'floors.json'), 'utf8'));

function runCoverage() {
  return new Promise((resolve) => {
    // TAP on stdout for the test counts, LCOV to a file for the coverage.
    // Same per-test bound as `npm test`: a hang fails with a name, not a job timeout.
    const args = ['--test', '--test-timeout=180000', '--experimental-test-coverage',
      '--test-reporter=tap', '--test-reporter-destination=stdout',
      '--test-reporter=lcov', `--test-reporter-destination=${LCOV}`,
      ...SUITE_GLOBS];
    const child = spawn(process.execPath, args, { cwd: REPO });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function lineCount(file) {
  try {
    const text = await readFile(path.join(REPO, file), 'utf8');
    // A final newline ends the last line; it does not start another one.
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch { return 0; }
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

// A report left over from an earlier run must never be read as this run's: if
// the reporter writes nothing, the rows come back empty and every floor fails.
await mkdir(path.join(REPO, '.coverage'), { recursive: true });
await rm(LCOV, { force: true });
const { code, out } = await runCoverage();
const summary = parseTapSummary(out);
let lcov = '';
try { lcov = await readFile(LCOV, 'utf8'); }
catch { console.error(`No LCOV report was written to ${path.relative(REPO, LCOV)}.`); }
const rows = parseLcov(lcov, REPO);
const srcRows = rows.filter((r) => !isTestFile(r.file));
for (const r of srcRows) r.lines = await lineCount(r.file);

const report = [];
report.push('# Unit/integration coverage (source files only, test files excluded)');
report.push('');
report.push(`Generated by tests/coverage/run.mjs. Tests: ${summary.tests ?? '?'} `
  + `(pass ${summary.pass ?? '?'}, fail ${summary.fail ?? '?'}, skipped ${summary.skipped ?? '?'}, todo ${summary.todo ?? '?'}).`);
report.push('');
report.push('| Area | Files | Line % | Branch % | Funcs % | Floor (line) | Status |');
report.push('|---|---|---|---|---|---|---|');

const { results: areaResults, failures: floorFailures } = evaluateAreas(srcRows, FLOORS);
for (const { area, stats: a, floor, ok } of areaResults) {
  if (!a) { report.push(`| ${area} | 0 | - | - | - | ${floor} | NOT MEASURED |`); continue; }
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
if (floorFailures.length) {
  console.error(`FAIL: ${floorFailures.length} area(s) failed their line-coverage floor:`);
  for (const f of floorFailures) console.error(`  ${f}`);
}
process.exit(summary.fail || floorFailures.length || code ? 1 : 0);
