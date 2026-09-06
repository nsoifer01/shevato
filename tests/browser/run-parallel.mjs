#!/usr/bin/env node
// Runs the browser estate as several shards AT ONCE on this machine.
//
//   npm run test:browser:parallel              # 4 shards
//   npm run test:browser:parallel -- --shards=6
//   npm run test:browser:parallel -- --only=trip-planner
//
// Why this exists: run.mjs walks its suites one at a time in one browser, so
// a full local pass is ~25 minutes of mostly waiting while nine cores idle.
// CI already solves this by putting the shards on four machines. This does the
// same thing on one machine, which is safe for exactly the reason the CI
// comment gives - each shard needs its OWN static server and its OWN Chrome,
// and gets them here from a per-shard port pair.
//
// What makes it safe, stated so it stays true:
//   - Ports. Each shard gets BROWSER_TEST_PORT and BROWSER_TEST_CDP_PORT of
//     its own, away from run.mjs's defaults (8099/9222) so a plain
//     `npm run test:browser` can be running beside this. Every port is
//     bind-tested on BOTH stacks before anything starts, because the failure
//     mode of a busy CDP port is not an error - it is two runs silently
//     driving each other's browser and reporting a green pass.
//   - Profiles. run.mjs already gives each Chrome its own mkdtemp
//     --user-data-dir, so localStorage, service workers and CacheStorage are
//     per shard. Nothing is shared.
//   - The filesystem. Suites write only to unique temp dirs (perf.mjs) and to
//     .screenshots/<suite>/<check-name>.png on failure. A check runs in
//     exactly one shard, so two shards cannot write the same artifact.
//   - The partition. run.mjs's shard split is total by construction, so the
//     shards together run the list once and only once.
//
// Output: each shard's log is written in full to its own file and the
// interesting lines are streamed live with a [n] prefix. Failures from every
// shard are collected and reprinted at the end, so one scroll answers "what
// broke?" without reading four interleaved logs.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RUNNER = path.join(HERE, 'run.mjs');

const USAGE = 'usage: run-parallel.mjs [--shards=<n>] [--only=<path-substring>] [--port-base=<n>] [--cdp-base=<n>]';

// Deliberately NOT 8099/9222: those are run.mjs's defaults, and a developer
// running the serial command in another terminal must not collide with this.
// 8080 and 8081 are reserved on the owner's machine and are never candidates.
let shards = 4;
let only = null;
let portBase = 8300;
let cdpBase = 9330;
const passthrough = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--shards=')) shards = Number(a.slice('--shards='.length));
  else if (a.startsWith('--port-base=')) portBase = Number(a.slice('--port-base='.length));
  else if (a.startsWith('--cdp-base=')) cdpBase = Number(a.slice('--cdp-base='.length));
  else if (a.startsWith('--only=')) { only = a.slice('--only='.length); passthrough.push(a); }
  else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(2); }
}
if (!Number.isInteger(shards) || shards < 1 || shards > 16) {
  console.error(`--shards=${shards} must be a whole number from 1 to 16.\n${USAGE}`);
  process.exit(2);
}

// Each shard is one Chrome plus one Python server. More shards than cores
// makes them contend and reports timings that mean nothing, so say so rather
// than silently producing a slow, noisy run.
const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
if (shards > cores) {
  console.error(`refusing to start ${shards} shards on ${cores} cores: they would contend `
    + `and the run would be slower, not faster. Use --shards=${cores} or fewer.`);
  process.exit(2);
}

// Both stacks, same reason run.mjs gives: a leftover headless Chrome commonly
// listens on ::1 while 127.0.0.1 still binds, so an IPv4-only check declares a
// busy port free and the shard then attaches to a stranger's browser.
const bindable = (port, host) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, host);
});
const portFree = async (port) => (await bindable(port, '127.0.0.1')) && (await bindable(port, '::1'));

const plan = [];
for (let i = 1; i <= shards; i++) {
  plan.push({ index: i, port: portBase + i, cdpPort: cdpBase + i });
}

const busy = [];
for (const s of plan) {
  if (!(await portFree(s.port))) busy.push(`${s.port} (static server for shard ${s.index})`);
  if (!(await portFree(s.cdpPort))) busy.push(`${s.cdpPort} (Chrome DevTools for shard ${s.index})`);
}
if (busy.length) {
  console.error('these ports are already in use, so a shard would drive somebody else\'s server or browser:\n'
    + busy.map((b) => `  - ${b}`).join('\n')
    + `\nStop whatever is on them, or move the ranges with --port-base= / --cdp-base=.`);
  process.exit(2);
}

const logDir = await mkdtemp(path.join(os.tmpdir(), 'shevato-browser-parallel-'));
console.log(`browser estate: ${shards} shards in parallel on ${cores} cores`
  + (only ? `, --only=${only}` : '') + `\nlogs: ${logDir}\n`);

const started = Date.now();
const results = new Map();

// Lines worth seeing while it runs. The full log is on disk either way, so
// this is a progress feed, not the record.
const LIVE = /^(--- |\s+\d+\/\d+ passed|\s+FAIL |runner error|BROWSER REGRESSION|shard \d)/;

function runShard(s) {
  return new Promise((resolve) => {
    const logPath = path.join(logDir, `shard-${s.index}.log`);
    const log = createWriteStream(logPath);
    const child = spawn(process.execPath,
      ['--experimental-websocket', RUNNER, `--shard=${s.index}/${shards}`, ...passthrough], {
        cwd: REPO,
        env: {
          ...process.env,
          BROWSER_TEST_PORT: String(s.port),
          BROWSER_TEST_CDP_PORT: String(s.cdpPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    s.child = child;

    let tail = '';
    const fails = [];
    const onChunk = (buf) => {
      log.write(buf);
      tail += buf.toString();
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const line of lines) {
        if (/^\s+FAIL /.test(line)) fails.push(line.trim());
        if (LIVE.test(line)) console.log(`[${s.index}] ${line.trim()}`);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('close', (code) => {
      log.end();
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`[${s.index}] ${code === 0 ? 'PASSED' : `FAILED (exit ${code})`} after ${secs}s`);
      results.set(s.index, { code, fails, logPath });
      resolve();
    });
    child.on('error', (e) => {
      log.end();
      console.log(`[${s.index}] could not start: ${e.message}`);
      results.set(s.index, { code: 1, fails: [`shard ${s.index} could not start: ${e.message}`], logPath });
      resolve();
    });
  });
}

// A Ctrl-C must take the whole tree down. Without this the shards keep their
// Chromes and static servers alive, and the NEXT run refuses to start because
// its ports are busy - which reads as a bug in the harness.
let stopping = false;
const stopAll = () => {
  if (stopping) return;
  stopping = true;
  for (const s of plan) { try { s.child && s.child.kill('SIGTERM'); } catch {} }
};
process.on('SIGINT', () => { console.log('\nstopping shards...'); stopAll(); });
process.on('SIGTERM', stopAll);

await Promise.all(plan.map(runShard));

const elapsed = (Date.now() - started) / 1000;
const failedShards = [...results.entries()].filter(([, r]) => r.code !== 0);
const allFails = [...results.entries()].flatMap(([i, r]) => r.fails.map((f) => `[${i}] ${f}`));

console.log(`\n${'='.repeat(52)}`);
console.log(`BROWSER REGRESSION (parallel): ${shards - failedShards.length}/${shards} shards passed`
  + `  in ${(elapsed / 60).toFixed(1)} min`);
if (allFails.length) {
  console.log('\nFailures across every shard:');
  for (const f of allFails) console.log(`  ${f}`);
}
if (failedShards.length) {
  console.log('\nFull logs:');
  for (const [i, r] of failedShards) console.log(`  shard ${i}: ${r.logPath}`);
}
process.exit(failedShards.length ? 1 : 0);
