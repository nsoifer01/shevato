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

const SUITES = ['site.mjs', 'apps.mjs'];

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
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    // Blackhole analytics so a blocked beacon never looks like an app error.
    '--host-resolver-rules=MAP www.googletagmanager.com 127.0.0.1:1, MAP *.google-analytics.com 127.0.0.1:1',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', (e) => { console.error(`\nCould not launch "${bin}": ${e.message}\nSet CHROME_BIN to a Chrome/Chromium binary.`); });
  await waitFor(() => httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`), 30000, 'headless Chrome');
}

async function stopAll() {
  for (const p of [chrome, server]) { try { p && p.kill(); } catch {} }
  await sleep(400);
  if (profileDir) { try { await rm(profileDir, { recursive: true, force: true }); } catch {} }
}

const results = [];
try {
  await startAll();
  for (const name of SUITES) {
    const mod = await import(path.join(HERE, 'suites', name));
    process.stdout.write(`\n--- ${name.replace('.mjs', '')} ---\n`);
    const r = await mod.run({ base: BASE, cdpPort: CDP_PORT });
    results.push(...r);
    for (const x of r) {
      if (!x.pass) console.log(`  FAIL ${x.name}${x.detail ? '  [' + x.detail + ']' : ''}`);
    }
    const f = r.filter((x) => !x.pass).length;
    console.log(`  ${r.length - f}/${r.length} passed`);
  }
} catch (e) {
  console.error('\nrunner error:', e.message);
  results.push({ name: 'runner completed', pass: false, detail: e.message });
} finally {
  await stopAll();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(52)}`);
console.log(`BROWSER REGRESSION: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? '  [' + f.detail + ']' : ''}`);
}
process.exit(failed.length ? 1 : 0);
