#!/usr/bin/env node
// Browser regression runner.
//
// Starts a static server and a headless Chrome, runs every suite against them,
// then tears both down and exits non-zero if anything failed.
//
// Run with: npm run test:browser
//
// This is deliberately NOT part of `npm test`. It needs Chromium on the machine
// and takes minutes rather than seconds, so CI keeps running the fast unit
// suites while this stays an explicit local/pre-release check.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// 8080 and 8083 are reserved on the maintainer's machine; never default to them.
const PORT = Number(process.env.BROWSER_TEST_PORT || 8099);
const CDP_PORT = Number(process.env.BROWSER_TEST_CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;

// Suite paths are repo-relative so app-local suites can live beside their app.
// The trip-planner E2E suites under apps/trip-planner/e2e/ are permanent
// regression protection for that app's browser workflows; run them alone with
//   npm run test:trip-planner:e2e        (equivalent to --only=trip-planner)
// The fpl-planner suites under apps/fpl-planner/e2e/ do the same for that app's
// interactive scenario workflow and its gameweek lifecycle:
//   npm run test:fpl-planner:e2e         (equivalent to --only=fpl-planner)
// The maptap-rivals suite under apps/maptap-rivals/e2e/ pins the 2026-08-22
// audit round (seeded a11y, keyboard, 390px containment, import safety):
//   npm run test:maptap-rivals:e2e       (equivalent to --only=maptap-rivals)
const SUITES = [
  'tests/browser/suites/site.mjs',
  'tests/browser/suites/apps.mjs',
  'tests/browser/suites/a11y.mjs',
  'tests/browser/suites/visual.mjs',
  'tests/browser/suites/perf.mjs',
  'tests/browser/suites/pwa-gym.mjs',
  'apps/trip-planner/e2e/core.mjs',
  'apps/trip-planner/e2e/trips-sync.mjs',
  'apps/trip-planner/e2e/share.mjs',
  'apps/trip-planner/e2e/views.mjs',
  'apps/trip-planner/e2e/ui.mjs',
  'apps/trip-planner/e2e/places.mjs',
  'apps/trip-planner/e2e/assistant.mjs',
  'apps/trip-planner/e2e/qa-fixes.mjs',
  'apps/trip-planner/e2e/pwa.mjs',
  'apps/gym-tracker/e2e/units-migration.mjs',
  'apps/fpl-planner/e2e/scenario.mjs',
  'apps/fpl-planner/e2e/lifecycle.mjs',
  'apps/maptap-rivals/e2e/quality.mjs',
];

// --only=<substring> runs the suites whose path contains it; --headed opens a
// visible browser window for local debugging. Anything else is rejected so a
// typo cannot silently run the wrong subset.
const args = process.argv.slice(2);
let only = null, headed = false;
for (const a of args) {
  if (a.startsWith('--only=')) only = a.slice('--only='.length);
  else if (a === '--headed') headed = true;
  else { console.error(`unknown argument: ${a}\nusage: run.mjs [--only=<path-substring>] [--headed]`); process.exit(2); }
}
// Pinned check counts per suite. A suite that silently loses checks (an early
// return, a refactor that drops a loop, a throw swallowed inside the suite)
// still "passes" everything it did run; comparing against a pinned total turns
// that silent shrinkage into an explicit failure. All six harness-owned
// suites are pinned, plus the app-owned maptap-rivals suite by its owner's
// choice; trip-planner and fpl-planner are not, by theirs. Adding or removing
// a check on purpose means updating the pinned number in the same change.
// apps.mjs note: the count is invariant whether or not the rising-shows
// dataset is fetched (the skip path emits the same number of entries).
const EXPECTED_CHECKS = {
  'tests/browser/suites/site.mjs': 157,
  'tests/browser/suites/apps.mjs': 101,
  // 72 from master's B7/B8 keyboard + touch-target blocks, plus the two
  // seeded MapTap Rivals state scans added in this branch.
  'tests/browser/suites/a11y.mjs': 74,
  'tests/browser/suites/visual.mjs': 86,
  'tests/browser/suites/perf.mjs': 41,
  'tests/browser/suites/pwa-gym.mjs': 14,
  // 56 from the 2026-08-22 audit pass, plus the 15 modal/header stacking
  // checks added 2026-08-23. Pinned because this suite's axe scans now
  // contain their own failures instead of aborting the run, so a shrunken
  // run would otherwise look green.
  'apps/maptap-rivals/e2e/quality.mjs': 71,
};

const selected = only ? SUITES.filter((p) => p.includes(only)) : SUITES;
if (!selected.length) { console.error(`--only=${only} matches no suite. Suites:\n  ${SUITES.join('\n  ')}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(check, timeoutMs, label) {
  return (async () => {
    const start = Date.now();
    for (;;) {
      if (await check()) return true;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
      await sleep(250);
    }
  })();
}

const httpOk = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode > 0); });
  req.on('error', () => resolve(false));
  req.setTimeout(1500, () => { req.destroy(); resolve(false); });
});

let server, chrome, profileDir;

async function startAll() {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: REPO, stdio: 'ignore' });
  await waitFor(() => httpOk(`${BASE}/home.html`), 20000, 'static server');

  profileDir = await mkdtemp(path.join(tmpdir(), 'shevato-browser-test-'));
  const bin = process.env.CHROME_BIN || 'chromium';
  chrome = spawn(bin, [
    ...(headed ? [] : ['--headless=new']),
    '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    // Blackhole analytics so a blocked beacon never looks like an app error.
    '--host-resolver-rules=MAP www.googletagmanager.com 127.0.0.1:1, MAP *.google-analytics.com 127.0.0.1:1',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', (e) => { console.error(`\nCould not launch "${bin}": ${e.message}\nSet CHROME_BIN to a Chrome/Chromium binary.`); });
  await waitFor(() => httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`), 30000, 'headless Chrome');
}

// Waits for a spawned process to actually exit, bounded so a wedged process
// cannot hang teardown forever.
function waitForExit(p, timeoutMs) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((res) => p.once('exit', res)),
    sleep(timeoutMs),
  ]);
}

async function stopAll() {
  for (const p of [chrome, server]) { try { p && p.kill(); } catch {} }
  // Wait for real exits before removing the profile dir: Chrome still holds
  // files open right after kill(), and rm-ing under it raced (EBUSY/ENOTEMPTY
  // or a half-deleted profile left behind).
  await Promise.all([waitForExit(chrome, 5000), waitForExit(server, 5000)]);
  if (profileDir) { try { await rm(profileDir, { recursive: true, force: true }); } catch {} }
}

const results = [];
try {
  await startAll();
  for (const name of selected) {
    const suiteName = path.basename(name, '.mjs');
    process.stdout.write(`\n--- ${suiteName} ---\n`);
    // Each suite runs inside its own try/catch: one suite throwing (import
    // error included) records a single failure and the NEXT suite still runs,
    // instead of the whole remainder of the matrix being aborted.
    let r;
    try {
      const mod = await import(path.join(REPO, name));
      r = await mod.run({ base: BASE, cdpPort: CDP_PORT });
    } catch (e) {
      r = [{ name: `${suiteName}: suite completed`, pass: false, detail: String(e && e.message || e).slice(0, 200) }];
    }
    if (EXPECTED_CHECKS[name] != null && r.length !== EXPECTED_CHECKS[name]) {
      r.push({
        name: `${suiteName}: expected ${EXPECTED_CHECKS[name]} checks, got ${r.length}`,
        pass: false,
        detail: 'a check was silently added or lost; update EXPECTED_CHECKS in run.mjs if intentional',
      });
    }
    results.push(...r);
    for (const x of r) {
      if (!x.pass) console.log(`  FAIL ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
      else if (x.skipped) console.log(`  skip ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
    }
    const f = r.filter((x) => !x.pass).length;
    const sk = r.filter((x) => x.pass && x.skipped).length;
    console.log(`  ${r.length - f - sk}/${r.length - sk} passed${sk ? `, ${sk} skipped` : ''}`);
  }
} catch (e) {
  console.error('\nrunner error:', e.message);
  results.push({ name: 'runner completed', pass: false, detail: e.message });
} finally {
  await stopAll();
}

const failed = results.filter((r) => !r.pass);
const skipped = results.filter((r) => r.pass && r.skipped);
const ran = results.length - skipped.length;
console.log(`\n${'='.repeat(52)}`);
console.log(`BROWSER REGRESSION: ${ran - failed.length}/${ran} passed`
  + (skipped.length ? `, ${skipped.length} skipped` : ''));
if (skipped.length) {
  console.log('\nSkipped (precondition missing, not a failure):');
  for (const s of skipped) console.log(`  - ${s.name}${s.detail ? '  [' + s.detail + ']' : ''}`);
}
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? '  [' + f.detail + ']' : ''}`);
}
process.exit(failed.length ? 1 : 0);
