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
  runScheduledProbe, statusOf, slotOf, githubDispatchAlert, openStrongStore, HEALTH_STORE, STALE_AFTER_HOURS, UNFINISHED_AFTER_MS,
} from '../lib/fpl-health-run.mjs';
import { ARCHIVE_STORE } from '../lib/fpl-archive-stage.mjs';
import { assess, readStatus, reconcile } from '../../../apps/fpl-planner/scripts/health-monitor.mjs';
import { handleStatus } from '../fpl-health-status.mjs';
import { config } from '../fpl-health.mjs';
import { deadlinePayload } from '../../../apps/fpl-planner/tests/helpers/xp-calibration-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..', 'apps', 'fpl-planner');
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
// `bootstrapHeaders` overrides the proxy's headers on bootstrap-static (a
// stale copy); `fplFetch` replaces FPL itself.
function production({ proxyStatus = 200, bootstrap = SAMPLE.bootstrap, fplStatus = 200, bootstrapHeaders = null, fplFetch = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.includes('/.netlify/functions/fpl?path=')) {
      if (proxyStatus !== 200) return new Response('{}', { status: proxyStatus });
      const path = decodeURIComponent(url.split('path=')[1]);
      const body = path === 'bootstrap-static' ? bootstrap : SAMPLE.fixtures;
      const headers = path === 'bootstrap-static' && bootstrapHeaders ? { ...healthyHeaders, ...bootstrapHeaders } : healthyHeaders;
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    if (url.endsWith('/apps/fpl-planner/data/opening-baseline.json')) {
      return new Response(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'), { status: 200 });
    }
    if (url.startsWith('https://fantasy.premierleague.com/')) return fplFetch ? fplFetch(url, init) : new Response('{}', { status: fplStatus });
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
  assert.deepEqual(gh.calls[0], { method: 'POST', path: '/dispatches', body: { ref: 'master', inputs: { mode: 'monitor', expect_at: NOW } }, auth: 'Bearer t' });

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

test('a corrupt staged manifest fails the archive check rather than reading as healthy', async () => {
  const corrupt = { async getWithMetadata() { return { data: { archive: 'x' }, etag: 'e1' }; } };
  const r = await runScheduledProbe({ store: memoryStore(), fetchImpl: production(), now: () => NOW, archiveStore: corrupt });
  const f = r.failed.find((x) => x.name === 'the deadline archive holds the captures due by now');
  assert.ok(f && /the staged manifest is malformed: it has no entries list/.test(f.saw), JSON.stringify(r.failed));
});

// Netlify Blobs as it behaves (its README: edge reads drift up to 60 seconds).
// A strong store reads what was last written; the default (eventual) store
// reads what had propagated when `propagate()` was last called.
function laggingBlobs() {
  const primary = memoryStore();
  let seen = new Map();
  const opened = [];
  const eventual = {
    async get(k) { return seen.has(k) ? structuredClone(seen.get(k)) : null; },
    async getWithMetadata(k) { return seen.has(k) ? { data: structuredClone(seen.get(k)), etag: 'stale' } : null; },
    setJSON: (...a) => primary.setJSON(...a),
  };
  const getStore = (opts) => {
    opened.push(opts);
    return opts && typeof opts === 'object' && opts.consistency === 'strong' ? primary : eventual;
  };
  return { getStore, opened, propagate() { seen = new Map(primary.map); } };
}

// Earlier slots: the fixture's clock is an hour before the GW4 deadline, so a
// run after NOW would rightly fail "the next deadline is in the future".
const slotsBefore = (n) => new Date(Date.parse(NOW) - n * 6 * 3600e3).toISOString();
const staleBootstrap = { 'x-fpl-stale': 'true', 'x-fpl-age-seconds': '21603' };

test('14 October, reproduced: an eventually consistent read serves the old failure after the recovery is stored; the strong store does not', async () => {
  const blobs = laggingBlobs();
  const writer = openStrongStore(blobs.getStore, HEALTH_STORE);
  // 06:41: the proxy serves a six-hour-old stale bootstrap; the run fails.
  const failedAt = slotsBefore(1);
  const failed = await runScheduledProbe({ store: writer, fetchImpl: production({ bootstrapHeaders: staleBootstrap }), now: () => failedAt });
  assert.equal(failed.ok, false);
  blobs.propagate();
  // 12:41: healthy, stored, and the recovery check reads 12 seconds later.
  const recoveredAt = NOW;
  const recovered = await runScheduledProbe({ store: writer, fetchImpl: production(), now: () => recoveredAt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.failed));
  const readAt = Date.parse(recoveredAt) + 27e3;

  const eventual = await handleStatus(req(), blobs.getStore(HEALTH_STORE), readAt);
  const before = await eventual.json();
  assert.equal(eventual.status, 503, 'the old bug: the default store still shows the failure');
  assert.equal(before.latest.at, failedAt);

  const strong = await handleStatus(req(), openStrongStore(blobs.getStore, HEALTH_STORE), readAt);
  assert.equal(strong.status, 200);
  assert.equal((await strong.json()).latest.at, recoveredAt);
});

test('every Netlify entry point of the health probe opens its stores with strong consistency', () => {
  const opened = [];
  openStrongStore((o) => { opened.push(o); return {}; }, HEALTH_STORE);
  assert.deepEqual(opened, [{ name: HEALTH_STORE, consistency: 'strong' }]);
  // The entry points import @netlify/blobs themselves, so their wiring is read
  // from source: no store is opened any other way.
  for (const [file, stores] of [['fpl-health-status.mjs', ['HEALTH_STORE']], ['fpl-health.mjs', ['HEALTH_STORE', 'ARCHIVE_STORE']]]) {
    const src = readFileSync(join(HERE, '..', file), 'utf8');
    assert.equal((src.match(/getStore\(/g) || []).length, 0, `${file} calls getStore directly`);
    for (const name of stores) assert.ok(src.includes(`openStrongStore(getStore, ${name})`), `${file} opens ${name} strongly`);
  }
  assert.equal(ARCHIVE_STORE, 'fpl-archive');
});

test('a stale proxy answer asks FPL once and puts what FPL said on the failed check; a healthy run asks FPL nothing', async () => {
  const healthy = production();
  await runScheduledProbe({ store: memoryStore(), fetchImpl: healthy, now: () => NOW });
  assert.equal(healthy.calls.filter((u) => u.startsWith('https://fantasy.premierleague.com/')).length, 0);

  const signals = [];
  const stale = production({ bootstrapHeaders: staleBootstrap, fplFetch: (url, init) => { signals.push(init.signal); return new Response('<html>The game is being updated.</html>', { status: 503 }); } });
  const r = await runScheduledProbe({ store: memoryStore(), fetchImpl: stale, now: () => NOW });
  assert.equal(stale.calls.filter((u) => u.startsWith('https://fantasy.premierleague.com/')).length, 1);
  assert.ok(signals[0] instanceof AbortSignal, 'the direct question is bounded by a timeout');
  const f = r.failed.find((x) => x.name === 'the proxy serves bootstrap-static fresh and uncached by browsers');
  assert.match(f.saw, /stale true, age 21603s; FPL itself answered 503 in \d+ ms$/);
  assert.ok(r.lines.some((l) => /^upstream +FPL itself answered 503 in \d+ ms \(asked directly after the proxy served bootstrap-static stale\)$/.test(l)), r.lines.join('\n'));

  const hung = production({ bootstrapHeaders: staleBootstrap, fplFetch: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
  const t = await runScheduledProbe({ store: memoryStore(), fetchImpl: hung, now: () => NOW });
  assert.match(t.failed.find((x) => x.name.startsWith('the proxy serves bootstrap-static')).saw, /FPL itself is unreachable after \d+ ms \(The operation was aborted due to timeout\)$/);
});

// The whole chain on fakes: Netlify probe -> stored status -> dispatch (with
// expect_at) -> the monitor reading the status endpoint -> the incident issue.
test('the chain end to end: a failure opens one incident, the recovery check closes it, and an endpoint still behind never closes it or repeats the old failure', async () => {
  const blobs = laggingBlobs();
  const writer = openStrongStore(blobs.getStore, HEALTH_STORE);
  const dispatched = [];
  const alert = githubDispatchAlert({ token: 't', repo: 'o/r', fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/dispatches')) { dispatched.push(JSON.parse(init.body).inputs); return new Response(null, { status: 204 }); }
    return new Response('{}', { status: 200 });
  } });
  const issues = [];
  const api = async (path, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const res = (status, b) => new Response(b === undefined ? null : JSON.stringify(b), { status });
    if (path.startsWith('/issues?state=open')) return res(200, issues.filter((i) => i.state === 'open'));
    if (path === '/issues' && method === 'POST') { const i = { number: issues.length + 1, title: body.title, body: body.body, state: 'open', comments: [] }; issues.push(i); return res(201, i); }
    const m = path.match(/^\/issues\/(\d+)(\/comments)?/);
    const issue = issues.find((i) => i.number === Number(m[1]));
    if (m[2]) { if (method === 'POST') { issue.comments.push({ body: body.body }); return res(201, {}); } return res(200, issue.comments); }
    Object.assign(issue, body); return res(200, issue);
  };
  // The monitor as the workflow runs it, against an endpoint opened `opener`'s way.
  const monitor = async (expectAt, nowMs, opener) => {
    const statusFetch = async () => handleStatus(req(), opener(), nowMs);
    const reading = await readStatus('https://shevato.com/.netlify/functions/fpl-health-status', statusFetch, { expectAt, sleep: async () => {} });
    const { problems, latest } = assess({ ...reading, nowMs, expectAt });
    return { problems, ...(await reconcile({ problems, latest, api, nowIso: new Date(nowMs).toISOString() })) };
  };
  const strong = () => openStrongStore(blobs.getStore, HEALTH_STORE);
  const eventual = () => blobs.getStore(HEALTH_STORE);

  // A healthy baseline, then a genuine failure: opened at once.
  await runScheduledProbe({ store: writer, fetchImpl: production(), now: () => slotsBefore(3), alert });
  const failAt = slotsBefore(2);
  await runScheduledProbe({ store: writer, fetchImpl: production({ bootstrapHeaders: staleBootstrap, fplStatus: 503 }), now: () => failAt, alert });
  assert.deepEqual(dispatched.at(-1), { mode: 'monitor', expect_at: failAt });
  const opened = await monitor(dispatched.at(-1).expect_at, Date.parse(failAt) + 30e3, strong);
  assert.equal(opened.action, 'opened');
  assert.match(issues[0].body, /FPL itself answered 503/);
  blobs.propagate();

  // The recovery is stored and dispatches a recovery check.
  const okAt = slotsBefore(1);
  await runScheduledProbe({ store: writer, fetchImpl: production(), now: () => okAt, alert });
  assert.deepEqual(dispatched.at(-1), { mode: 'monitor', expect_at: okAt });

  // An endpoint that is still behind (the 14 October read): red, the incident
  // stays open, and it is not told the old failure is still happening.
  const behind = await monitor(okAt, Date.parse(okAt) + 30e3, eventual);
  assert.deepEqual(behind.problems.map((p) => p.key), ['status-behind']);
  assert.equal(issues[0].state, 'open');

  // The strong endpoint shows the recovery: closed.
  const closed = await monitor(okAt, Date.parse(okAt) + 30e3, strong);
  assert.equal(closed.action, 'closed');
  assert.equal(issues[0].state, 'closed');
  assert.equal(issues.length, 1, 'one incident, never a duplicate');

  // A recovery check never hides a failure that is still current.
  const againAt = NOW;
  await runScheduledProbe({ store: writer, fetchImpl: production({ proxyStatus: 503 }), now: () => againAt, alert });
  const reopened = await monitor(dispatched.at(-1).expect_at, Date.parse(againAt) + 30e3, strong);
  assert.equal(reopened.action, 'opened');
  assert.equal(issues.filter((i) => i.state === 'open').length, 1);
});
