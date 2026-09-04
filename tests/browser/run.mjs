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
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// 8080 and 8081 are reserved on the maintainer's machine; never default to them.
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
  'apps/trip-planner/e2e/audit-fixes.mjs',
  'apps/trip-planner/e2e/pwa.mjs',
  'apps/gym-tracker/e2e/units-migration.mjs',
  'apps/fpl-planner/e2e/scenario.mjs',
  'apps/fpl-planner/e2e/lifecycle.mjs',
  // --- 2026-08-22 remediation round: per-app audit suites -----------------
  // Each app owns apps/<app>/e2e/audit-2026-08.mjs, holding the regressions
  // for the defects that round fixed (renderer escaping with hostile strings,
  // two-tab writes, destructive-action undo, import sanitising, seeded axe
  // scans, tablet geometry). One line per app, alphabetical. They are NOT
  // pinned in EXPECTED_CHECKS: like the trip-planner and fpl-planner suites,
  // their check counts are their owners' to change. Arena's equivalent needs
  // the Firebase emulators, so it stays in apps/arena/e2e/emulator.mjs behind
  // `npm run test:arena:emulator`.
  // -----------------------------------------------------------------------
  'apps/football-h2h/e2e/audit-2026-08.mjs',
  'apps/fpl-planner/e2e/audit-2026-08.mjs',
  'apps/gym-tracker/e2e/audit-2026-08.mjs',
  'apps/maptap-rivals/e2e/audit-2026-08.mjs',
  'apps/mario-kart/e2e/audit-2026-08.mjs',
  'apps/rising-shows/e2e/audit-2026-08.mjs',
  'apps/trip-planner/e2e/audit-2026-08.mjs',
  'apps/maptap-rivals/e2e/quality.mjs',
  // The Free Hit revert, driven across the chip gameweek and the one after.
  'apps/fpl-planner/e2e/free-hit.mjs',
];

// --only=<substring> runs the suites whose path contains it; --shard=<i>/<n>
// runs one nth of them; --headed opens a visible browser window for local
// debugging. Anything else is rejected so a typo cannot silently run the wrong
// subset.
const USAGE = 'usage: run.mjs [--only=<path-substring>] [--shard=<i>/<n>] [--headed]';
const args = process.argv.slice(2);
let only = null, headed = false, shard = null;
for (const a of args) {
  if (a.startsWith('--only=')) only = a.slice('--only='.length);
  else if (a.startsWith('--shard=')) shard = a.slice('--shard='.length);
  else if (a === '--headed') headed = true;
  else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(2); }
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
  // Re-measured after the 2026-08-23 merge, which brought together two
  // independent rounds of checks: site 157 -> 170, a11y 74 -> 79 and
  // visual 86 -> 103. Both sides' additions are kept, so the totals are
  // the union, not a replacement.
  // 170 before 2026-09-03; the two vacuous "contact form" checks became
  // three real ones (contact routes, no page-level form, auth fields
  // labelled), so +1.
  // 171 before 2026-09-04; moadon-alef's default language moved from English
  // to Hebrew (the page is Hebrew-targeted and its title, description and
  // Open Graph tags always were), so the default-language check was rewritten
  // and a second one added for switching AWAY from the default, which is now
  // the direction that has to unwind the RTL layout. +1.
  'tests/browser/suites/site.mjs': 172,
  // 103 from master, plus the two Rising Shows highlight-badge checks added
  // in this branch.
  'tests/browser/suites/apps.mjs': 105,
  // 72 from master's B7/B8 keyboard + touch-target blocks, plus the two
  // seeded MapTap Rivals state scans added in this branch.
  'tests/browser/suites/a11y.mjs': 79,
  'tests/browser/suites/visual.mjs': 103,
  'tests/browser/suites/perf.mjs': 51,
  'tests/browser/suites/pwa-gym.mjs': 14,
  // 56 from the 2026-08-22 audit pass, plus, added 2026-08-23: 15 modal/header
  // stacking checks, 3 route-change checks, 30 overflow checks (6 views x 7
  // widths), 5 UTC+12 rendered-day checks, 3 stale-matrix-selection checks and
  // 8 parity-card checks.
  // Pinned because this suite's axe scans now contain their own failures
  // instead of aborting the run, so a shrunken run would otherwise look green.
  // Plus 6 "Sync all rivals" checks (progress counter, run totals, me-only
  // days, the predictions actual, the already-up-to-date rerun, JS errors).
  'apps/maptap-rivals/e2e/quality.mjs': 126,
  // Deliberately NOT pinned: apps/rising-shows/e2e/audit-2026-08.mjs emits 51
  // checks when the dataset is on disk and 11 skip entries when it is not, so
  // a single number cannot describe both environments. The zero-run guard
  // below is what protects it instead.
};

// Suites that may legitimately run with every check skipped. Being on this
// list is not free: the runner still reports it, loudly, in the summary.
const ZERO_RUN_ALLOWED = new Set([
  // The Rising Shows dataset is a 34 MB gitignored release asset, so this
  // suite genuinely cannot run on a GitHub runner today. Listed here so the
  // exemption is visible rather than silently tolerated.
  'apps/rising-shows/e2e/audit-2026-08.mjs',
]);

// Suites that ran with nothing asserted, filled in during the run.
const zeroRunSuites = [];

const selected = only ? SUITES.filter((p) => p.includes(only)) : SUITES;
if (!selected.length) { console.error(`--only=${only} matches no suite. Suites:\n  ${SUITES.join('\n  ')}`); process.exit(2); }

// Sharding. The estate is walked one suite at a time in one browser, so the
// only way to make it finish faster is to put the suites on more machines.
// --shard=2/4 says "this is runner 2 of 4"; the CI matrix starts one job per
// shard and each runs its own static server and its own Chrome, which is also
// why sharding is safe here and two runs on ONE machine are not (they would
// share CDP 9222 and silently drive each other's browser).
//
// Round-robin (index % n), NOT contiguous blocks: the list groups related
// suites together (ten trip-planner ones in a row, seven per-app audit ones)
// and related suites cost about the same, so blocks would hand one runner most
// of the slow work while another finished early. Striding interleaves them.
//
// The partition is total by construction: every suite has exactly one index,
// so shards 1..n together run the list once and only once. That is the
// property that matters, because a suite belonging to no shard would report
// nothing and read as green. The workflow derives <n> from the matrix size
// itself (`strategy.job-total`) rather than repeating the number, so the index
// and the total cannot drift apart in a half-finished edit.
let toRun = selected;
let shardLabel = '';
if (shard !== null) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
  if (!m) {
    console.error(`--shard=${shard} is not <i>/<n> with positive whole numbers (1-based).\n${USAGE}`);
    process.exit(2);
  }
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (index > total) {
    console.error(`--shard=${shard}: there is no shard ${index} of ${total}.`);
    process.exit(2);
  }
  toRun = selected.filter((_, i) => i % total === index - 1);
  shardLabel = ` (shard ${index}/${total})`;
  if (!toRun.length) {
    // A shard with nothing to run exits 0 and reads as a pass. Say so instead.
    console.error(`--shard=${shard} selects no suite: ${selected.length} suites cannot fill ${total} shards.`);
    process.exit(2);
  }
  // Printed so a CI log says exactly what this runner was responsible for;
  // the four logs side by side are the audit that the estate was fully run.
  console.log(`shard ${index}/${total}: ${toRun.length} of ${selected.length} suites`);
  for (const p of toRun) console.log(`  ${p}`);
}

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

// Something else already listening is NOT our server, and every suite would
// then run against whatever it serves - another checkout, an older build, a
// different branch - while reporting a clean pass. That is not hypothetical:
// during the 2026-08-22 audit a long-running server on the default port made a
// full trip-planner run report 512/512 green against code that did not contain
// the change under test, because our own python server failed to bind and
// httpOk cheerfully answered from the stranger. The same applies to the CDP
// port: we would drive somebody else's browser. Bind-test both and say so.
const bindable = (port, host) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, host);
});
// BOTH stacks: a leftover headless Chrome commonly listens on ::1 while
// 127.0.0.1 still binds, so an IPv4-only check declares the port free and the
// run then attaches to that browser and dies with it half an estate later.
const portFree = async (port) => (await bindable(port, '127.0.0.1')) && (await bindable(port, '::1'));

const httpOk = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode > 0); });
  req.on('error', () => resolve(false));
  req.setTimeout(1500, () => { req.destroy(); resolve(false); });
});

let server, chrome, profileDir;

async function startAll() {
  for (const [port, what, envVar] of [[PORT, 'static server', 'BROWSER_TEST_PORT'], [CDP_PORT, 'Chrome DevTools', 'BROWSER_TEST_CDP_PORT']]) {
    if (!(await portFree(port))) {
      throw new Error(`port ${port} is already in use, so this run would drive somebody else's ${what} `
        + `instead of its own and could report a pass for code it never loaded. `
        + `Stop whatever is on ${port}, or set ${envVar} to a free port.`);
    }
  }
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
  for (const name of toRun) {
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
    // A suite must return an ARRAY of checks. Returning a summary object
    // instead used to throw "Spread syntax requires ...iterable" out of the
    // loop below, which aborted the ENTIRE run at that suite: on 2026-08-23
    // that silently skipped all seven per-app audit suites, which were green
    // standalone and had simply never executed here. Fail that suite loudly
    // and keep going, the same way a suite that throws is contained.
    if (!Array.isArray(r)) {
      r = [{
        name: `${suiteName}: suite returned an array of checks`,
        pass: false,
        detail: `run() resolved with ${r === null ? 'null' : typeof r}; suites must return [{ name, pass, detail }]`,
      }];
    }
    if (EXPECTED_CHECKS[name] != null && r.length !== EXPECTED_CHECKS[name]) {
      r.push({
        name: `${suiteName}: expected ${EXPECTED_CHECKS[name]} checks, got ${r.length}`,
        pass: false,
        detail: 'a check was silently added or lost; update EXPECTED_CHECKS in run.mjs if intentional',
      });
    }
    // A suite that ASSERTED NOTHING is not a pass.
    //
    // Check-count pinning catches a suite that shrinks; it does not catch one
    // whose every check is a skip, because the checks are all still there.
    // The rising-shows suite has run `0/0 passed, 11 skipped` in CI since it
    // was written: the dataset is gitignored, so every assertion it owns has
    // never executed on a pull request, and a total collapse of that suite
    // would look exactly the same. Skips stay legitimate (a missing
    // precondition is not a failure) but a suite where NOTHING ran has to say
    // so out loud.
    const ranHere = r.filter((x) => !x.skipped).length;
    if (r.length > 0 && ranHere === 0) {
      zeroRunSuites.push(name);
      if (!ZERO_RUN_ALLOWED.has(name)) {
        r.push({
          name: `${suiteName}: every check skipped, so this suite protected nothing`,
          pass: false,
          detail: 'satisfy the suite\'s precondition, or add it to ZERO_RUN_ALLOWED in run.mjs with a reason',
        });
      }
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
console.log(`BROWSER REGRESSION${shardLabel}: ${ran - failed.length}/${ran} passed`
  + (skipped.length ? `, ${skipped.length} skipped` : ''));
if (skipped.length) {
  console.log('\nSkipped (precondition missing, not a failure):');
  for (const s of skipped) console.log(`  - ${s.name}${s.detail ? '  [' + s.detail + ']' : ''}`);
}
// Say it in the summary, not only in the per-suite line. A suite reading
// "0/0 passed" scrolls past as though it were a pass; naming it here is what
// makes "this app has no browser coverage on a pull request" visible to
// whoever reads the run.
if (zeroRunSuites.length) {
  console.log('\nAsserted NOTHING in this run (every check skipped):');
  for (const n of zeroRunSuites) {
    console.log(`  - ${n}${ZERO_RUN_ALLOWED.has(n) ? '  [known: precondition unavailable here]' : ''}`);
  }
}
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? '  [' + f.detail + ']' : ''}`);
}
process.exit(failed.length ? 1 : 0);
