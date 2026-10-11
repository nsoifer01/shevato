// The FPL Planner health probe on Netlify's scheduler
// (netlify/functions/fpl-health.mjs, lib/fpl-health-run.mjs) and its status
// endpoint (fpl-health-status.mjs). Hermetic: a committed real payload
// stands in for production behind a fake proxy, the store is in memory, and
// GitHub's API is a recorder. The incident issue itself is the workflow's
// (apps/fpl-planner/tests/health-monitor.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runScheduledProbe, statusOf, slotOf, githubDispatchAlert, STALE_AFTER_HOURS, UNFINISHED_AFTER_MS,
} from '../lib/fpl-health-run.mjs';
import { handleStatus } from '../fpl-health-status.mjs';
import { config } from '../fpl-health.mjs';
import { deadlinePayload } from '../../../apps/fpl-planner/tests/helpers/xp-calibration-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'fpl-planner');
// The real 2026/27 gameweek 4 deadline payload (tests/fixtures/xp-calibration-2026),
// a healthy production state. The synthetic demo sample is NOT one: it carries
// last season's totals beside twelve finished gameweeks, which the probe
// rightly calls an in-season payload read as last season.
const SAMPLE = deadlinePayload(4);
const NOW = SAMPLE.fetchedAt;

function memoryStore() {
  const map = new Map();
  const etags = new Map();
  let n = 0;
  return {
    map,
    async get(k) { return map.has(k) ? structuredClone(map.get(k)) : null; },
    async getWithMetadata(k) { return map.has(k) ? { data: structuredClone(map.get(k)), etag: etags.get(k) } : null; },
    async setJSON(k, v, opts = {}) {
      if (opts.onlyIfNew && map.has(k)) return { modified: false };
      if (opts.onlyIfMatch && etags.get(k) !== opts.onlyIfMatch) return { modified: false };
      map.set(k, structuredClone(v));
      etags.set(k, `e${++n}`);
      return { modified: true };
    },
  };
}

const healthyHeaders = { 'cache-control': 'no-store', 'x-fpl-stale': 'false', 'x-fpl-age-seconds': '30', 'content-type': 'application/json' };

// A fake production: the proxy serves the sample, the static site serves the
// shipped baseline, FPL itself answers `fplStatus`.
function production({ proxyStatus = 200, bootstrap = SAMPLE.bootstrap, fplStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/.netlify/functions/fpl?path=')) {
      if (proxyStatus !== 200) return new Response('{}', { status: proxyStatus });
      const path = decodeURIComponent(url.split('path=')[1]);
      const body = path === 'bootstrap-static' ? bootstrap : SAMPLE.fixtures;
      return new Response(JSON.stringify(body), { status: 200, headers: healthyHeaders });
    }
    if (url.endsWith('/apps/fpl-planner/data/opening-baseline.json')) {
      return new Response(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'), { status: 200 });
    }
    if (url.startsWith('https://fantasy.premierleague.com/')) return new Response('{}', { status: fplStatus });
    throw new Error(`unexpected fetch ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const req = (qs = '', method = 'GET') => new Request(`https://shevato.com/.netlify/functions/fpl-health-status${qs}`, { method });

test('a healthy run stores its result, its history and the reading change detection compares against', async () => {
  const store = memoryStore();
  const r = await runScheduledProbe({ store, fetchImpl: production(), now: () => NOW });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.ok(r.checks.length >= 15, `${r.checks.length} checks`);
  assert.ok(r.checks.some((c) => /the proxy serves bootstrap-static fresh/.test(c.name)), 'the proxy promises are checked');
  assert.deepEqual(store.map.get('latest').ok, true);
  assert.equal(store.map.get('history').length, 1);
  assert.ok(store.map.get('last-reading').best11 > 0);
  const res = await handleStatus(req(), store, Date.parse(NOW) + 3600e3);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('a second invocation in the same six-hour slot does nothing and asks nobody for anything', async () => {
  const store = memoryStore();
  await runScheduledProbe({ store, fetchImpl: production(), now: () => NOW });
  const again = production();
  const r = await runScheduledProbe({ store, fetchImpl: again, now: () => new Date(Date.parse(NOW) + 60e3).toISOString() });
  assert.match(r.skipped, /already probed/);
  assert.deepEqual(again.calls, []);
  assert.equal(slotOf('2026-10-10T12:41:00Z'), '2026-10-10T12');
  assert.equal(slotOf('2026-10-10T17:59:00Z'), '2026-10-10T12');
  assert.equal(slotOf('2026-10-10T18:00:00Z'), '2026-10-10T18');
});

test('a proxy outage is a failure that says which side broke, and the status endpoint turns red', async () => {
  const store = memoryStore();
  const r = await runScheduledProbe({ store, fetchImpl: production({ proxyStatus: 503, fplStatus: 200 }), now: () => NOW });
  assert.equal(r.ok, false);
  assert.match(r.failed[0].saw, /proxy HTTP 503; FPL itself answered 200/);
  const res = await handleStatus(req(), store, Date.parse(NOW));
  assert.equal(res.status, 503);
  assert.equal(store.map.has('last-reading'), false, 'a failed run is never the baseline for the next');
});

test('a malformed payload fails as itself, not as an exception three functions deep', async () => {
  const store = memoryStore();
  const r = await runScheduledProbe({ store, fetchImpl: production({ bootstrap: { error: 'The game is being updated.' } }), now: () => NOW });
  assert.equal(r.ok, false);
  assert.equal(r.failed[0].name, 'the payloads have the shape the app reads');
});

test('a scheduler that stops is a failure: the status endpoint goes red once the last run is stale', () => {
  const latest = { at: NOW, ok: true, failed: [] };
  assert.equal(statusOf(latest, Date.parse(NOW) + (STALE_AFTER_HOURS - 0.5) * 3600e3).status, 200);
  const stale = statusOf(latest, Date.parse(NOW) + (STALE_AFTER_HOURS + 0.5) * 3600e3);
  assert.equal(stale.status, 503);
  assert.match(stale.body.reason, /missed a slot/);
  assert.equal(statusOf(null).status, 503);
});

// A GitHub that records each call and answers `status` for the dispatch.
function github({ dispatchStatus = 204, checkStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method || 'GET', path: url.replace('https://api.github.com/repos/o/r/actions/workflows/fpl-health.yml', ''), body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (url.endsWith('/dispatches')) return new Response(null, { status: dispatchStatus });
    return new Response('{}', { status: checkStatus });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('with a token, a failure starts the incident workflow at once; a healthy steady state only checks the token', async () => {
  const gh = github();
  const alert = githubDispatchAlert({ token: 't', repo: 'o/r', fetchImpl: gh });
  const green = { at: NOW, slot: 's1', ok: true, failed: [] };
  const red = { ...green, ok: false, failed: [{ name: 'x', saw: 'a', expected: 'b' }] };

  assert.deepEqual(await alert({ latest: red, before: green }), { ok: true, dispatched: 'failure' });
  assert.deepEqual(gh.calls[0], { method: 'POST', path: '/dispatches', body: { ref: 'master', inputs: { mode: 'monitor' } }, auth: 'Bearer t' });

  // Recovery: the run before failed, so the workflow is started to close the issue.
  assert.deepEqual(await alert({ latest: green, before: red }), { ok: true, dispatched: 'recovery-check' });
  // And after a gap (the issue the backstop opened for staleness), and after an alert that failed.
  const old = { ...green, at: new Date(Date.parse(NOW) - (STALE_AFTER_HOURS + 1) * 3600e3).toISOString() };
  assert.equal((await alert({ latest: green, before: old })).dispatched, 'recovery-check');
  assert.equal((await alert({ latest: green, before: { ...green, alert: { ok: false, error: 'HTTP 401' } } })).dispatched, 'recovery-check');
  assert.equal((await alert({ latest: green, before: null })).dispatched, 'recovery-check');

  // Healthy after healthy: no workflow run, one read that proves the token still works.
  const n = gh.calls.length;
  assert.deepEqual(await alert({ latest: green, before: green }), { ok: true, dispatched: null });
  assert.deepEqual(gh.calls.slice(n).map((c) => `${c.method} ${c.path}`), ['GET ']);

  assert.equal(githubDispatchAlert({ token: '' }), null, 'inert without a token');
});

test('an expired token is recorded on the run, where the backstop reads it, and never fails the probe', async () => {
  const store = memoryStore();
  const r = await runScheduledProbe({
    store, fetchImpl: production(), now: () => NOW,
    alert: githubDispatchAlert({ token: 't', repo: 'o/r', fetchImpl: github({ checkStatus: 401, dispatchStatus: 401 }) }),
  });
  assert.equal(r.ok, true, 'the probe result is the probe\'s');
  assert.deepEqual(store.map.get('latest').alert, { ok: false, error: 'workflow dispatch: HTTP 401' });
  assert.equal(store.map.get('latest').ok, true);
});

test('a run killed before it stored anything turns the status red within minutes, and the next run reports it', async () => {
  const store = memoryStore();
  await runScheduledProbe({ store, fetchImpl: production(), now: () => NOW });
  // The next slot's run claims its slot and dies (Netlify's 30-second limit).
  const nextSlotAt = new Date(Date.parse(NOW) + 6 * 3600e3).toISOString();
  const killed = { ...store, setJSON: async (k, v, o) => { if (k !== 'slot') throw new Error('killed'); return store.setJSON(k, v, o); } };
  await assert.rejects(runScheduledProbe({ store: killed, fetchImpl: production(), now: () => nextSlotAt }));
  const claim = store.map.get('slot');
  assert.equal(claim.slot, slotOf(nextSlotAt));

  assert.equal(statusOf(store.map.get('latest'), Date.parse(nextSlotAt) + 60e3, claim).status, 200, 'a run still inside its time is not dead');
  const dead = statusOf(store.map.get('latest'), Date.parse(nextSlotAt) + UNFINISHED_AFTER_MS + 1, claim);
  assert.equal(dead.status, 503);
  assert.match(dead.body.reason, /never recorded a result/);
  const res = await handleStatus(req(), store, Date.parse(nextSlotAt) + UNFINISHED_AFTER_MS + 1);
  assert.equal(res.status, 503);

  // The run after that one fails on it, so the incident is raised even if nobody reads the status.
  const third = await runScheduledProbe({ store, fetchImpl: production(), now: () => new Date(Date.parse(nextSlotAt) + 6 * 3600e3).toISOString() });
  assert.equal(third.ok, false);
  // (Twelve hours on, the fixture's own deadline has passed too, which the probe rightly reports.)
  const lost = third.failed.find((f) => f.name === 'the previous scheduled run recorded its result');
  assert.ok(lost, JSON.stringify(third.failed));
  assert.match(lost.saw, new RegExp(`slot ${slotOf(nextSlotAt)}`));
});

test('a run whose alert fails still stores its result', async () => {
  const store = memoryStore();
  const r = await runScheduledProbe({
    store, fetchImpl: production({ proxyStatus: 500 }), now: () => NOW,
    alert: async () => { throw new Error('GitHub down'); },
  });
  assert.equal(r.ok, false);
  assert.equal(store.map.get('latest').ok, false);
  assert.deepEqual(store.map.get('latest').alert, { ok: false, error: 'GitHub down' });
});

test('it runs every six hours on Netlify\'s scheduler, and the status endpoint is read-only', async () => {
  assert.equal(config.schedule, '41 */6 * * *');
  assert.equal((await handleStatus(req('', 'POST'), memoryStore())).status, 405);
});

// The deadline archive's own scheduled function alerts nobody when it fails,
// and a deadline it misses is lost for good, so the probe (which alerts) also
// checks that the staged captures due by now exist. The fixture clock is an
// hour before the GW4 deadline, so a pre capture for GW4 is due.
test('a missing pre-deadline capture in the staged archive fails the run; a present one passes', async () => {
  const empty = memoryStore();
  const missed = await runScheduledProbe({ store: memoryStore(), fetchImpl: production(), now: () => NOW, archiveStore: empty });
  assert.equal(missed.ok, false);
  const f = missed.failed.find((x) => x.name === 'the deadline archive holds the captures due by now');
  assert.ok(f, JSON.stringify(missed.failed));
  assert.match(f.saw, /no pre-deadline capture for GW4, 1\.0h before its deadline/);

  const staged = memoryStore();
  await staged.setJSON('2026-27/manifest.json', { entries: [{ phase: 'pre', gw: 4, endpoint: 'bootstrap', capturedAt: '2026-09-12T09:07:00Z' }] });
  const kept = await runScheduledProbe({ store: memoryStore(), fetchImpl: production(), now: () => NOW, archiveStore: staged });
  assert.equal(kept.ok, true, JSON.stringify(kept.failed));
  assert.ok(kept.checks.some((c) => c.name === 'the deadline archive holds the captures due by now' && c.ok));
});

test('an unreadable staged archive fails the archive check rather than passing it', async () => {
  const broken = { async getWithMetadata() { throw new Error('blobs unavailable'); } };
  const r = await runScheduledProbe({ store: memoryStore(), fetchImpl: production(), now: () => NOW, archiveStore: broken });
  const f = r.failed.find((x) => x.name === 'the deadline archive holds the captures due by now');
  assert.ok(f && /could not read the staged archive: blobs unavailable/.test(f.saw), JSON.stringify(r.failed));
});
