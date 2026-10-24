// The probe's freshness promise per proxy path, and the exit code of the CLI
// probe (scripts/evidence-probe.mjs) for every way it can fail. Both from the
// 2026-10-16 follow-up audit: a Free Hit turned a correct run red because a
// finished gameweek's picks were held to the hour, and `--entry none` (what
// FPL_HEALTH_ENTRY=none means on Netlify) asked FPL for entry "none".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProbe, freshLimitSeconds, FRESH_PROXY_SECONDS, FINISHED_PICKS_FRESH_SECONDS, updateWindowAt, UPDATE_WINDOW_MS } from '../scripts/lib/probe.mjs';
import { FINISHED_PICKS_TTL_SECONDS, POST_DEADLINE_WINDOW_MS } from '../../../netlify/functions/lib/fpl-cache.mjs';
import { BOOTSTRAP, FIXTURES, ENTRIES, FETCHED_AT } from './helpers/gw7-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadShipped = async () => JSON.parse(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'));
const CURRENT = BOOTSTRAP.events.find((e) => e.is_current).id;

test('a finished gameweek\'s picks may be as old as the proxy keeps them; everything else is held to the hour', () => {
  assert.equal(FINISHED_PICKS_FRESH_SECONDS, FINISHED_PICKS_TTL_SECONDS, 'the probe and the proxy agree on a finished gameweek\'s day');
  assert.equal(freshLimitSeconds(`entry/1/event/${CURRENT - 1}/picks`, CURRENT), FINISHED_PICKS_FRESH_SECONDS);
  for (const name of ['bootstrap-static', 'fixtures', 'entry/1', 'entry/1/history', 'entry/1/transfers', `entry/1/event/${CURRENT}/picks`, `entry/1/event/${CURRENT + 1}/picks`]) {
    assert.equal(freshLimitSeconds(name, CURRENT), FRESH_PROXY_SECONDS, name);
  }
  assert.equal(freshLimitSeconds('entry/1/event/1/picks', undefined), FRESH_PROXY_SECONDS, 'no current gameweek known: the strict limit');
});

test('the freshness checks judge each response by its own path', async () => {
  const h = (age) => new Headers({ 'cache-control': 'no-store', 'x-fpl-stale': 'false', 'x-fpl-age-seconds': String(age) });
  const SIX_HOURS = 6 * 3600;
  const responses = {
    'bootstrap-static': h(30),
    fixtures: h(30),
    [`entry/1/event/${CURRENT - 1}/picks`]: h(SIX_HOURS),
    [`entry/2/event/${CURRENT - 1}/picks`]: h(25 * 3600),
    [`entry/1/event/${CURRENT}/picks`]: h(SIX_HOURS),
    'entry/1/history': h(2 * 3600),
  };
  const r = await runProbe({ bootstrap: BOOTSTRAP, fixtures: FIXTURES, fetchedAt: FETCHED_AT, now: FETCHED_AT, source: 'proxy', responses, loadShipped });
  const verdict = Object.fromEntries(r.checks.filter((c) => / fresh and uncached/.test(c.name))
    .map((c) => [c.name.replace('the proxy serves ', '').replace(' fresh and uncached by browsers', ''), c.ok]));
  assert.deepEqual(verdict, {
    'bootstrap-static': true,
    fixtures: true,
    [`entry/1/event/${CURRENT - 1}/picks`]: true,
    [`entry/2/event/${CURRENT - 1}/picks`]: false,
    [`entry/1/event/${CURRENT}/picks`]: false,
    'entry/1/history': false,
  });
});

/* ------------------------------------------------ the CLI's exit codes */

// The CLI runs as itself, in a child process, with the global fetch replaced
// by a preload that answers from files: FPL as the GitHub workflow reads it
// (`--direct`), judged at the fixture's own clock (`--now`).
const PROBE = join(APP, 'scripts', 'evidence-probe.mjs');
const ID = '111';
const FH = ENTRIES['free-hit'];
const healthyRoutes = () => ({
  'bootstrap-static': { body: BOOTSTRAP },
  fixtures: { body: FIXTURES },
  [`entry/${ID}`]: { body: { ...FH.entry, id: Number(ID) } },
  [`entry/${ID}/history`]: { body: FH.history },
  [`entry/${ID}/transfers`]: { body: FH.transfers },
  [`entry/${ID}/event/${CURRENT}/picks`]: { body: FH.picks },
  [`entry/${ID}/event/${CURRENT - 1}/picks`]: { body: FH.revertPicks },
});
const PRELOAD = `data:text/javascript,${encodeURIComponent(`
  import { readFileSync, appendFileSync } from 'node:fs';
  const cfg = JSON.parse(readFileSync(process.env.FAKE_FPL, 'utf8'));
  globalThis.fetch = async (url) => {
    appendFileSync(process.env.FAKE_FPL + '.calls', url + '\\n');
    if (cfg.network) throw new TypeError('fetch failed');
    const path = String(url).replace('https://fantasy.premierleague.com/api/', '').replace(/\\/$/, '');
    const r = cfg.routes[path];
    if (!r) return new Response('{"detail":"Not found."}', { status: 404 });
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  };
  if (cfg.planThrows) performance.now = () => { throw new Error('the plan threw'); };
`)}`;

function runCli(dir, name, cfg, args) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(cfg));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', PRELOAD, PROBE, '--direct', '--now', FETCHED_AT, ...args], {
      env: { ...process.env, FAKE_FPL: file }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let calls = [];
      try { calls = readFileSync(`${file}.calls`, 'utf8').trim().split('\n').filter(Boolean); } catch { /* no fetch at all */ }
      resolve({ code, out, calls });
    });
  });
}

test('every way the CLI probe can fail exits non-zero and names what failed; "--entry none" probes without a manager', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fpl-probe-cli-'));
  try {
    const refusedRoutes = healthyRoutes();
    refusedRoutes[`entry/${ID}`] = { status: 403, body: '<html>Access Denied</html>' };
    const missingRoutes = healthyRoutes();
    delete missingRoutes[`entry/${ID}`];
    const unplayed = FIXTURES.map((f) => (f.event === CURRENT - 1 ? { ...f, finished: false, finished_provisional: false } : f));
    const cases = {
      none: [{ routes: healthyRoutes() }, ['--entry', 'none']],
      network: [{ routes: healthyRoutes(), network: true }, ['--entry', ID]],
      entry404: [{ routes: missingRoutes }, ['--entry', ID]],
      entry403: [{ routes: refusedRoutes }, ['--entry', ID]],
      planThrows: [{ routes: healthyRoutes(), planThrows: true }, ['--entry', 'none']],
      invariant: [{ routes: { ...healthyRoutes(), fixtures: { body: unplayed } } }, ['--entry', 'none']],
      notAnId: [{ routes: healthyRoutes() }, ['--entry', 'abc']],
    };
    const runs = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, [cfg, args]]) => [name, await runCli(dir, name, cfg, args)])));

    assert.equal(runs.none.code, 0, runs.none.out);
    assert.ok(!runs.none.calls.some((u) => u.includes('/entry/')), 'no manager is read');

    assert.notEqual(runs.network.code, 0);
    assert.match(runs.network.out, /FAIL {2}the probe runs to completion\n.*fetch failed/);
    assert.notEqual(runs.entry404.code, 0);
    assert.match(runs.entry404.out, new RegExp(`FAIL {2}the proxy serves entry ${ID}\\n.*entry/${ID}: HTTP 404`));
    assert.notEqual(runs.entry403.code, 0);
    assert.match(runs.entry403.out, new RegExp(`entry/${ID}: HTTP 403`));
    assert.notEqual(runs.planThrows.code, 0);
    assert.match(runs.planThrows.out, /FAIL {2}the probe runs to completion\n.*the plan threw/);
    assert.notEqual(runs.invariant.code, 0);
    assert.match(runs.invariant.out, /FAIL {2}every fixture of a finished gameweek has been played/);

    assert.notEqual(runs.notAnId.code, 0);
    assert.match(runs.notAnId.out, /FAIL {2}the entry to probe is an FPL team id\n.*--entry "abc"/);
    assert.deepEqual(runs.notAnId.calls, [], 'refused before anything is fetched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// FPL's update after a deadline: the probes' window is the proxy's
// post-deadline hour (not imported: the GitHub workflow checks out
// apps/fpl-planner alone), judged from the most recent passed deadline.
test('the update window is the hour after the most recent passed deadline, as the proxy reckons it', () => {
  assert.equal(UPDATE_WINDOW_MS, POST_DEADLINE_WINDOW_MS, 'the probes and the proxy agree on the hour after a deadline');
  const D = Date.parse('2026-10-23T17:30:00Z');
  const deadlines = ['2026-10-31T11:00:00Z', 'not a date', null, '2026-10-17T10:00:00Z', '2026-10-23T17:30:00Z'];
  assert.equal(updateWindowAt(deadlines, D - 1), null, 'before the deadline');
  assert.deepEqual(updateWindowAt(deadlines, D), { deadline: '2026-10-23T17:30:00.000Z', until: '2026-10-23T18:30:00.000Z' });
  assert.equal(updateWindowAt(deadlines, D + 5000).deadline, '2026-10-23T17:30:00.000Z', 'the most recent, in any order');
  assert.ok(updateWindowAt(deadlines, D + UPDATE_WINDOW_MS - 1));
  assert.equal(updateWindowAt(deadlines, D + UPDATE_WINDOW_MS), null, 'closed at the hour');
  assert.equal(updateWindowAt([], D), null);
  assert.equal(updateWindowAt(undefined, D), null);
});
