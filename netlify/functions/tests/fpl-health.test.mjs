// The FPL Planner health probe on Netlify's scheduler
// (netlify/functions/fpl-health.mjs, lib/fpl-health-run.mjs) and its status
// endpoint (fpl-health-status.mjs). Hermetic: a committed real payload
// stands in for production behind a fake proxy, the store is in memory, and
// GitHub's API is a recorder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runScheduledProbe, statusOf, slotOf, githubIssueAlert, STALE_AFTER_HOURS, ISSUE_MARKER,
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

test('with a token, a failure opens one GitHub issue, a repeat comments on it, a recovery closes it', async () => {
  const issues = [];
  const calls = [];
  const gh = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url.replace('https://api.github.com/repos/o/r', '')}`);
    if (url.endsWith('/issues?state=open&per_page=100')) return new Response(JSON.stringify(issues.filter((i) => i.state === 'open')), { status: 200 });
    if (url.endsWith('/issues') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      issues.push({ number: 7, title: body.title, state: 'open' });
      return new Response('{}', { status: 201 });
    }
    if (url.endsWith('/issues/7') && init.method === 'PATCH') { issues[0].state = 'closed'; return new Response('{}', { status: 200 }); }
    return new Response('{}', { status: 201 });
  };
  const alert = githubIssueAlert({ token: 't', repo: 'o/r', fetchImpl: gh });
  const red = { at: NOW, slot: 's', ok: false, failed: [{ name: 'x', saw: 'a', expected: 'b' }] };
  await alert({ latest: red });
  await alert({ latest: red });
  await alert({ latest: { ...red, ok: true, failed: [] } });
  assert.deepEqual(calls, [
    'GET /issues?state=open&per_page=100', 'POST /issues',
    'GET /issues?state=open&per_page=100', 'POST /issues/7/comments',
    'GET /issues?state=open&per_page=100', 'POST /issues/7/comments', 'PATCH /issues/7',
  ]);
  assert.ok(issues[0].title.startsWith(ISSUE_MARKER));
  assert.equal(githubIssueAlert({ token: '' }), null, 'inert without a token');
});

test('a run whose alert fails still stores its result', async () => {
  const store = memoryStore();
  const r = await runScheduledProbe({
    store, fetchImpl: production({ proxyStatus: 500 }), now: () => NOW,
    alert: async () => { throw new Error('GitHub down'); },
  });
  assert.equal(r.ok, false);
  assert.equal(store.map.get('latest').ok, false);
});

test('it runs every six hours on Netlify\'s scheduler, and the status endpoint is read-only', async () => {
  assert.equal(config.schedule, '41 */6 * * *');
  assert.equal((await handleStatus(req('', 'POST'), memoryStore())).status, 405);
});
