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
import { snapshotWaits, waitsSince } from './cdp.mjs';

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
  'apps/trip-planner/e2e/assistant-identity.mjs',
  'apps/trip-planner/e2e/schedule-slots.mjs',
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
  // 172 before 2026-09-05; +1 for the mobile menu open/close JS-error check
  // added with the `wasOpen` fix.
  'tests/browser/suites/site.mjs': 173,
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
// Measured cost of each suite, in seconds, from GitHub-runner logs (two
// consecutive runs on 2026-09-05 agreed to within 0.5s on every entry, so
// these are stable enough to schedule against). They exist for ONE reason:
// a round-robin split balances suite COUNT, and the costs here differ by two
// orders of magnitude, so counting suites put 20.3 minutes of work on shard 3
// while shards 1, 2 and 4 finished in 8-9 and sat idle. The estate's wall
// clock is its slowest shard, so balancing by cost is worth more than any
// number of extra runners.
//
// A suite missing from this table is charged DEFAULT_SECONDS. That is a
// scheduling hint only: an entry being stale or absent can make a shard
// uneven, never wrong, because the partition below is total regardless of
// what the numbers say. Refresh them from the timing table this runner
// prints at the end of every run.
const DEFAULT_SECONDS = 90;
const SUITE_SECONDS = {
  // 501 -> 101 with the same-document navigation fix in cdp.mjs (see FINDINGS,
  // "A fragment-only goto() used to cost 21 seconds"), then -> 81 once
  // seedAndReload stopped needing three navigations per boot to seed a
  // 347-game fixture. All 53 checks pass at every step.
  'apps/maptap-rivals/e2e/audit-2026-08.mjs': 82,
  'tests/browser/suites/a11y.mjs': 209,
  'apps/trip-planner/e2e/audit-fixes.mjs': 176,
  'apps/gym-tracker/e2e/audit-2026-08.mjs': 151,
  'tests/browser/suites/visual.mjs': 148,
  'apps/gym-tracker/e2e/units-migration.mjs': 130,
  // 118 without the rising-shows dataset, 120 with it.
  'tests/browser/suites/apps.mjs': 120,
  'apps/mario-kart/e2e/audit-2026-08.mjs': 113,
  'tests/browser/suites/site.mjs': 111,
  'apps/trip-planner/e2e/trips-sync.mjs': 107,
  'apps/maptap-rivals/e2e/quality.mjs': 101,
  'apps/trip-planner/e2e/ui.mjs': 97,
  'apps/trip-planner/e2e/places.mjs': 95,
  'apps/fpl-planner/e2e/lifecycle.mjs': 92,
  'apps/trip-planner/e2e/audit-2026-08.mjs': 91,
  'apps/fpl-planner/e2e/audit-2026-08.mjs': 76,
  // 76 without the rising-shows dataset, 77 with its three budget rows.
  'tests/browser/suites/perf.mjs': 77,
  'apps/fpl-planner/e2e/scenario.mjs': 69,
  'apps/trip-planner/e2e/assistant.mjs': 63,
  // Measured on 2026-09-05, the round that added it.
  'apps/trip-planner/e2e/assistant-identity.mjs': 41,
  // Measured on 2026-09-06, the schedule-validity round (23.6s locally).
  'apps/trip-planner/e2e/schedule-slots.mjs': 31,
  'apps/trip-planner/e2e/qa-fixes.mjs': 53,
  'apps/trip-planner/e2e/views.mjs': 49,
  'apps/trip-planner/e2e/core.mjs': 45,
  'apps/football-h2h/e2e/audit-2026-08.mjs': 42,
  'apps/trip-planner/e2e/share.mjs': 18,
  'tests/browser/suites/pwa-gym.mjs': 12,
  'apps/fpl-planner/e2e/free-hit.mjs': 8,
  'apps/trip-planner/e2e/pwa.mjs': 5,
  // Was 0 on a runner while the dataset was absent and every check skipped.
  // browser-tests.yml now fetches and caches it, so this is the measured cost
  // with the data present (40.3s locally). If the fetch fails the suite skips
  // and costs nothing, which makes a shard uneven, never wrong.
  'apps/rising-shows/e2e/audit-2026-08.mjs': 45,
};

// Longest-processing-time-first bin packing: walk the suites heaviest first
// and hand each to whichever shard is currently least loaded. For a spread
// like this one it lands within a few percent of the best possible split,
// and unlike round-robin it cannot put the two heaviest suites on the same
// runner.
//
// The partition is still TOTAL by construction - every suite is placed into
// exactly one bin, once - which is the property that actually matters,
// because a suite belonging to no shard would report nothing and read as
// green. The assertion below states it rather than trusting the loop.
function partitionByCost(suites, total) {
  const bins = Array.from({ length: total }, () => ({ load: 0, suites: [] }));
  const cost = (s) => (SUITE_SECONDS[s] == null ? DEFAULT_SECONDS : SUITE_SECONDS[s]);
  const order = suites.map((s, i) => ({ s, i }))
    // Heaviest first; ties broken by list position so the split is
    // deterministic and a re-run of the same commit produces the same shards.
    .sort((a, b) => (cost(b.s) - cost(a.s)) || (a.i - b.i));
  for (const { s } of order) {
    let pick = bins[0];
    for (const b of bins) if (b.load < pick.load) pick = b;
    pick.suites.push(s);
    pick.load += cost(s);
  }
  const placed = bins.reduce((n, b) => n + b.suites.length, 0);
  if (placed !== suites.length) {
    throw new Error(`shard partition lost suites: placed ${placed} of ${suites.length}`);
  }
  // Back into list order inside each shard, so a shard's log reads the same
  // way the SUITES list does.
  const rank = new Map(suites.map((s, i) => [s, i]));
  for (const b of bins) b.suites.sort((a, c) => rank.get(a) - rank.get(c));
  return bins;
}

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
  const bins = partitionByCost(selected, total);
  toRun = bins[index - 1].suites;
  shardLabel = ` (shard ${index}/${total})`;
  if (!toRun.length) {
    // A shard with nothing to run exits 0 and reads as a pass. Say so instead.
    console.error(`--shard=${shard} selects no suite: ${selected.length} suites cannot fill ${total} shards.`);
    process.exit(2);
  }
  // Printed so a CI log says exactly what this runner was responsible for;
  // the four logs side by side are the audit that the estate was fully run.
  console.log(`shard ${index}/${total}: ${toRun.length} of ${selected.length} suites`
    + `, ~${bins[index - 1].load}s of measured work`);
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

// Timing. Kept beside the results so the run can say where its wall clock
// went: shard balance and every "is this sleep worth it?" question are
// answered from these numbers rather than from counting sleep() literals in
// the source, which cannot see how often a loop ran.
const startupMs = { server: 0, browser: 0, teardown: 0 };
const timings = [];

async function startAll() {
  for (const [port, what, envVar] of [[PORT, 'static server', 'BROWSER_TEST_PORT'], [CDP_PORT, 'Chrome DevTools', 'BROWSER_TEST_CDP_PORT']]) {
    if (!(await portFree(port))) {
      throw new Error(`port ${port} is already in use, so this run would drive somebody else's ${what} `
        + `instead of its own and could report a pass for code it never loaded. `
        + `Stop whatever is on ${port}, or set ${envVar} to a free port.`);
    }
  }
  let t0 = Date.now();
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: REPO, stdio: 'ignore' });
  await waitFor(() => httpOk(`${BASE}/home.html`), 20000, 'static server');
  startupMs.server = Date.now() - t0;
  t0 = Date.now();

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
  startupMs.browser = Date.now() - t0;
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
  const tearStart = Date.now();
  for (const p of [chrome, server]) { try { p && p.kill(); } catch {} }
  // Wait for real exits before removing the profile dir: Chrome still holds
  // files open right after kill(), and rm-ing under it raced (EBUSY/ENOTEMPTY
  // or a half-deleted profile left behind).
  await Promise.all([waitForExit(chrome, 5000), waitForExit(server, 5000)]);
  if (profileDir) { try { await rm(profileDir, { recursive: true, force: true }); } catch {} }
  startupMs.teardown = Date.now() - tearStart;
}

const results = [];
try {
  await startAll();
  for (const name of toRun) {
    // App-qualified, because seven suites are named audit-2026-08.mjs and a
    // bare basename made every one of them print the same header - so a log
    // could not say which app's regressions had just failed.
    const suiteName = name.startsWith('apps/')
      ? `${name.split('/')[1]}/${path.basename(name, '.mjs')}`
      : path.basename(name, '.mjs');
    process.stdout.write(`\n--- ${suiteName} ---\n`);
    const suiteStart = Date.now();
    const waitsBefore = snapshotWaits();
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
    const elapsed = Date.now() - suiteStart;
    timings.push({ name, checks: r.length, ms: elapsed, ...waitsSince(waitsBefore) });
    console.log(`  ${r.length - f - sk}/${r.length - sk} passed${sk ? `, ${sk} skipped` : ''}`
      + `  (${(elapsed / 1000).toFixed(1)}s)`);
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

// Where the wall clock went. Printed on every run: the slowest-first order is
// how a shard split gets balanced by cost instead of by suite count, and the
// fixed-vs-poll split is how a fixed wait gets defended or removed on
// evidence. `fixed` is time spent sleeping whether or not the page was ready;
// `poll` is waitForExpr, which stops as soon as its condition is true; `nav`
// is Page.navigate to the load event.
if (timings.length) {
  const totalSuiteMs = timings.reduce((a, x) => a + x.ms, 0);
  const pad = (s, n) => String(s).padStart(n);
  console.log('\nTiming (slowest first):');
  console.log('  suite                                     checks     time    fixed     poll      nav   %run');
  for (const x of [...timings].sort((a, b) => b.ms - a.ms)) {
    const pct = totalSuiteMs ? (100 * x.ms / totalSuiteMs) : 0;
    console.log(`  ${x.name.replace(/^(tests\/browser\/suites|apps)\//, '').padEnd(40)}`
      + `${pad(x.checks, 7)}${pad((x.ms / 1000).toFixed(1) + 's', 9)}`
      + `${pad((x.fixedMs / 1000).toFixed(1) + 's', 9)}${pad((x.pollMs / 1000).toFixed(1) + 's', 9)}`
      + `${pad((x.navMs / 1000).toFixed(1) + 's', 9)}${pad(pct.toFixed(1), 7)}`);
  }
  const sum = (k) => timings.reduce((a, x) => a + x[k], 0);
  console.log(`  ${'TOTAL'.padEnd(40)}${pad(sum('checks'), 7)}`
    + `${pad((totalSuiteMs / 1000).toFixed(1) + 's', 9)}${pad((sum('fixedMs') / 1000).toFixed(1) + 's', 9)}`
    + `${pad((sum('pollMs') / 1000).toFixed(1) + 's', 9)}${pad((sum('navMs') / 1000).toFixed(1) + 's', 9)}`);
  console.log(`  startup: static server ${(startupMs.server / 1000).toFixed(1)}s, `
    + `browser ${(startupMs.browser / 1000).toFixed(1)}s, teardown ${(startupMs.teardown / 1000).toFixed(1)}s`
    + `  |  ${sum('gotos')} navigations, ${sum('polls')} condition waits`);
  if (process.env.BROWSER_TEST_TIMING_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.BROWSER_TEST_TIMING_JSON,
      JSON.stringify({ startupMs, timings }, null, 2));
    console.log(`  timings written to ${process.env.BROWSER_TEST_TIMING_JSON}`);
  }
}
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? '  [' + f.detail + ']' : ''}`);
}
process.exit(failed.length ? 1 : 0);
