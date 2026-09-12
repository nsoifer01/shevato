#!/usr/bin/env node
// Standalone runner for the Arena multiplayer emulator e2e (emulator.mjs).
//
//   npm run test:arena:emulator
//   ARENA_E2E_PORT=8137 ARENA_E2E_CDP_PORT=9337 node --experimental-websocket apps/arena/e2e/run-emulator.mjs
//
// Brings up everything the suite needs, in order: the Firebase emulators
// (Firestore + Auth + RTDB, via the pinned firebase-tools in
// tests-rules/emulator-harness.mjs), a static server over the repo, and a
// headless Chromium with a CDP port (same pattern as
// tests/browser/run.mjs, which deliberately does NOT know about this
// suite - the browser-suite coordinator owns that wiring). Tears all
// three down afterwards and exits non-zero on any failed check.
//
// Skips cleanly (exit 0 with a SKIP line) when Java or the emulator
// download is unavailable, mirroring the rules suite; set
// ARENA_RULES_REQUIRE=1 to turn that into a failure.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startEmulator } from '../tests-rules/emulator-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

// 8080/8081/8083 are reserved on the maintainer's machine; defaults stay clear.
const PORT = Number(process.env.ARENA_E2E_PORT || 8137);
// A second static server gives the suite a THIRD isolated origin
// (127.0.0.1:PORT, localhost:PORT, 127.0.0.1:PORT2 = three Firebase users)
// for the stranger-with-the-code and three-player scenarios.
const PORT2 = Number(process.env.ARENA_E2E_PORT2 || (PORT - 1));
const CDP_PORT = Number(process.env.ARENA_E2E_CDP_PORT || 9337);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpOk = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode > 0); });
  req.on('error', () => resolve(false));
  req.setTimeout(1500, () => { req.destroy(); resolve(false); });
});
async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

let server, server2, chrome, profileDir, emu;

async function stopAll() {
  for (const p of [chrome, server, server2]) { try { p && p.kill(); } catch { /* gone */ } }
  await sleep(500);
  if (profileDir) { try { await rm(profileDir, { recursive: true, force: true }); } catch { /* busy */ } }
  if (emu && emu.ok) await emu.stop();
}

// Ctrl-C, a killed CI step or a stopped background task used to leave the
// emulator, both static servers and a headless Chrome running, and the next
// run then SKIPPED on the busy port - which reads exactly like a finished
// run. startEmulator reaps our own leftovers now, but not leaking them is
// better: tear everything down on the way out, whatever the exit path.
let tearingDown = false;
const bail = (signal) => {
  if (tearingDown) return;
  tearingDown = true;
  console.log(`\n[run-emulator] ${signal}: tearing down emulators, servers and Chrome`);
  stopAll().then(() => process.exit(signal === 'SIGINT' ? 130 : 143),
    () => process.exit(143));
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => bail(sig));

let exitCode = 0;
try {
  // Emulators first: they are the slowest to come up and the suite skips
  // without them anyway. RTDB is included because the emulator seam
  // routes the page's rtdb handle to 127.0.0.1:9000, and the shared sync
  // scripts hold an RTDB reference.
  emu = await startEmulator({ repoRoot: REPO, only: ['firestore', 'auth', 'database'] });
  if (!emu.ok) {
    if (process.env.ARENA_RULES_REQUIRE) {
      console.error(`FAIL: emulators required but unavailable: ${emu.reason}`);
      process.exit(1);
    }
    console.log(`SKIP: emulators unavailable: ${emu.reason}`);
    process.exit(0);
  }

  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: REPO, stdio: 'ignore' });
  await waitFor(() => httpOk(`${BASE}/home.html`), 20000, 'static server');
  server2 = spawn('python3', ['-m', 'http.server', String(PORT2), '--bind', '127.0.0.1'],
    { cwd: REPO, stdio: 'ignore' });
  await waitFor(() => httpOk(`http://127.0.0.1:${PORT2}/home.html`), 20000, 'second static server');

  profileDir = await mkdtemp(path.join(tmpdir(), 'arena-emulator-e2e-'));
  const bin = process.env.CHROME_BIN || 'chromium';
  chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--host-resolver-rules=MAP www.googletagmanager.com 127.0.0.1:1, MAP *.google-analytics.com 127.0.0.1:1',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', (e) => console.error(`Could not launch "${bin}": ${e.message} (set CHROME_BIN)`));
  await waitFor(() => httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`), 30000, 'headless Chrome');

  const { run } = await import('./emulator.mjs');
  const results = await run({ base: BASE, cdpPort: CDP_PORT, base2: `http://127.0.0.1:${PORT2}` });

  // A suite that skipped ITSELF (its emulator probe gave up) is not a pass.
  // Under ARENA_RULES_REQUIRE that is the same hard failure a missing
  // emulator is: CI must never report this check green having run nothing.
  if (process.env.ARENA_RULES_REQUIRE && results.length > 0 && results.every((r) => r.skipped)) {
    results.push({ name: 'arena-emulator: the suite ran', pass: false,
      detail: `every check was skipped: ${results.map((r) => r.detail).filter(Boolean).join('; ').slice(0, 200)}` });
  }
  const failed = results.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.pass && r.skipped);
  for (const x of results) {
    if (!x.pass) console.log(`  FAIL ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
    else if (x.skipped) console.log(`  skip ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
    else console.log(`  ok   ${x.name}`);
  }
  console.log(`\nARENA EMULATOR E2E: ${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('runner error:', e && e.message || e);
  exitCode = 1;
} finally {
  await stopAll();
}
process.exit(exitCode);
