import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../fpl.mjs';
import {
  canonicalPath, pathKind, ttlSeconds, cacheKey, nextDeadlineFrom, serveFpl,
  TTL, DEADLINE_KEY, DEADLINE_TTL_SECONDS, UPSTREAM_BASE, ALLOWED_PATHS,
} from '../lib/fpl-cache.mjs';

// The handler tests exercise only the paths that return BEFORE any Blob I/O:
// the origin guard, the method guard and the allowlist. The cache pipeline is
// covered below through serveFpl, which takes an injected store and fetch, so
// the whole serve path is tested without a live Netlify Blobs context.

function req(pathParam, { origin = 'https://shevato.com', referer, method = 'GET' } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (referer) headers.Referer = referer;
  const url = 'https://shevato.com/.netlify/functions/fpl'
    + (pathParam === undefined ? '' : `?path=${encodeURIComponent(pathParam)}`);
  return new Request(url, { method, headers });
}

// ---------------------------------------------------------------- guards ----

test('rejects a request with no origin or referer', async () => {
  const res = await handler(req('bootstrap-static', { origin: null }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden');
});

test('rejects a foreign origin', async () => {
  // Without this the endpoint is an open proxy anyone can point a scraper at,
  // and FPL rate-limits by the caller's IP, which would be ours.
  const res = await handler(req('bootstrap-static', { origin: 'https://evil.example.com' }));
  assert.equal(res.status, 403);
});

test('rejects plain http on the production hostname', async () => {
  assert.equal((await handler(req('bootstrap-static', { origin: 'http://shevato.com' }))).status, 403);
});

test('accepts localhost and the referer fallback', async () => {
  // A valid origin with a bad path must reach the 400 allowlist, proving the
  // guard let it through rather than 403.
  assert.equal((await handler(req('nope', { origin: 'http://localhost:8081' }))).status, 400);
  assert.equal((await handler(req('nope', { origin: null, referer: 'https://shevato.com/apps/fpl-planner/' }))).status, 400);
});

test('rejects any method but GET', async () => {
  const res = await handler(req('bootstrap-static', { method: 'POST' }));
  assert.equal(res.status, 405);
});

test('a non-allowlisted path is refused before any upstream or blob call', async () => {
  for (const bad of ['me', 'my-team/1', 'entry/abc', 'entry/1/history/extra', '../admin', 'bootstrap-static/x', '']) {
    const res = await handler(req(bad));
    assert.equal(res.status, 400, `path ${bad}`);
    assert.equal((await res.json()).error, 'path_not_allowed');
  }
  assert.equal((await handler(req(undefined))).status, 400, 'a missing path parameter');
});

test('no guard response leaks anything but a bare error code', async () => {
  const responses = await Promise.all([
    handler(req('bootstrap-static', { origin: null })),
    handler(req('bootstrap-static', { origin: 'https://evil.example.com' })),
    handler(req('bootstrap-static', { method: 'DELETE' })),
    handler(req('me')),
  ]);
  for (const res of responses) {
    assert.match(await res.text(), /^\{"error":"[a-z_]+"\}$/);
  }
});

// ---------------------------------------------------------------- allowlist -

test('the allowlist admits exactly the endpoints the app reads', () => {
  const allowed = [
    'bootstrap-static', 'fixtures', 'entry/1', 'entry/4231987/history',
    'entry/4231987/transfers', 'entry/4231987/event/6/picks',
    'element-summary/328', 'event/12/live',
  ];
  for (const p of allowed) assert.equal(canonicalPath(p), p, p);
  // Leading and trailing slashes are the same endpoint.
  assert.equal(canonicalPath('/fixtures/'), 'fixtures');
  assert.equal(canonicalPath('  entry/12/history  '), 'entry/12/history');
});

test('the allowlist is anchored, so nothing can be smuggled past it', () => {
  const rejected = [
    'entry/1/history/../../admin', 'bootstrap-static?x=1', 'xbootstrap-static',
    'bootstrap-staticx', 'entry/-1', 'entry/1.5', 'entry//history', 'entry/1/event/x/picks',
    'my-team/1', 'leagues-classic/314/standings', '', '   ', null, undefined, 42, {},
  ];
  for (const p of rejected) assert.equal(canonicalPath(p), null, String(p));
  for (const { re } of ALLOWED_PATHS) {
    assert.equal(re.source.startsWith('^') && re.source.endsWith('$'), true, `unanchored: ${re}`);
  }
});

test('write endpoints and anything needing an FPL login are simply not reachable', () => {
  for (const p of ['my-team/1', 'transfers', 'me', 'entry/1/transfers/latest']) {
    assert.equal(canonicalPath(p), null);
  }
});

// ---------------------------------------------------------------- TTL -------

test('each endpoint gets a TTL that matches how fast it changes', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  assert.equal(pathKind('bootstrap-static'), 'bootstrap');
  assert.equal(ttlSeconds('bootstrap-static', { now }), TTL.bootstrap);
  assert.equal(ttlSeconds('fixtures', { now }), TTL.fixtures);
  assert.equal(ttlSeconds('entry/1/history', { now }), TTL.entry);
  assert.equal(ttlSeconds('element-summary/1', { now }), TTL['element-summary']);
  assert.equal(ttlSeconds('event/1/live', { now }), TTL.live);
});

test('every TTL collapses in the six hours before a deadline', () => {
  // Prices, injury news and free transfer counts all matter to the minute at
  // that point, and a ten-minute-old bootstrap can cost a manager a transfer.
  const deadline = '2026-08-21T17:30:00Z';
  const at = (iso) => ttlSeconds('bootstrap-static', { now: Date.parse(iso), nextDeadline: deadline });
  assert.equal(at('2026-08-21T10:00:00Z'), TTL.bootstrap, 'more than 6 hours out, normal TTL');
  assert.equal(at('2026-08-21T11:29:00Z'), TTL.bootstrap);
  assert.equal(at('2026-08-21T11:31:00Z'), DEADLINE_TTL_SECONDS);
  assert.equal(at('2026-08-21T17:29:00Z'), DEADLINE_TTL_SECONDS);
  assert.equal(at('2026-08-21T17:31:00Z'), TTL.bootstrap, 'after the deadline the rush is over');
  // Shortening never lengthens a TTL that was already shorter.
  assert.equal(ttlSeconds('event/1/live', { now: Date.parse('2026-08-21T17:00:00Z'), nextDeadline: deadline }), TTL.live);
  assert.equal(ttlSeconds('bootstrap-static', { now: Date.parse('2026-08-21T17:00:00Z'), nextDeadline: 'not a date' }), TTL.bootstrap);
});

test('the next deadline is the earliest one still in the future', () => {
  const events = [
    { deadline_time: '2026-08-21T17:30:00Z' },
    { deadline_time: '2026-08-28T17:30:00Z' },
    { deadline_time: null },
  ];
  assert.equal(nextDeadlineFrom({ events }, Date.parse('2026-08-10T00:00:00Z')), '2026-08-21T17:30:00.000Z');
  assert.equal(nextDeadlineFrom({ events }, Date.parse('2026-08-22T00:00:00Z')), '2026-08-28T17:30:00.000Z');
  assert.equal(nextDeadlineFrom({ events }, Date.parse('2027-08-22T00:00:00Z')), null);
  assert.equal(nextDeadlineFrom({}, Date.now()), null);
});

test('cache keys are distinct per endpoint', () => {
  const keys = ['bootstrap-static', 'fixtures', 'entry/1', 'entry/1/history', 'entry/1/event/6/picks']
    .map(cacheKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.every(k => !k.includes('/')), true, 'blob keys do not read as a directory tree');
});

// ---------------------------------------------------------------- pipeline --

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async setJSON(key, value) { map.set(key, structuredClone(value)); },
  };
}

function upstream(handlerFn) {
  const calls = [];
  const fn = async (url) => { calls.push(url); return handlerFn(url); };
  fn.calls = calls;
  return fn;
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
const NOW = Date.parse('2026-08-10T12:00:00Z');

test('a cache miss fetches upstream, stores the result and reports it as a miss', async () => {
  const store = memoryStore();
  const fetchUpstream = upstream(() => ok({ total_players: 5 }));
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { total_players: 5 });
  assert.equal(res.cache, 'miss');
  assert.equal(res.stale, false);
  assert.equal(res.ageSeconds, 0);
  assert.equal(fetchUpstream.calls[0], UPSTREAM_BASE + 'fixtures/');
  assert.deepEqual(store.map.get(cacheKey('fixtures')).body, { total_players: 5 });
});

test('a thousand visitors inside the TTL cost one upstream fetch', async () => {
  const store = memoryStore();
  const fetchUpstream = upstream(() => ok({ n: 1 }));
  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: NOW });
  const later = await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: NOW + 9 * 60 * 1000 });

  assert.equal(fetchUpstream.calls.length, 1);
  assert.equal(later.cache, 'hit');
  assert.equal(later.ageSeconds, 540);
  assert.equal(later.stale, false);
});

test('an expired entry is refetched', async () => {
  const store = memoryStore();
  let n = 0;
  const fetchUpstream = upstream(() => ok({ n: ++n }));
  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: NOW });
  const res = await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: NOW + 11 * 60 * 1000 });
  assert.equal(res.cache, 'miss');
  assert.deepEqual(res.body, { n: 2 });
});

test('fetching the bootstrap records the deadline, which then shortens every other TTL', async () => {
  const store = memoryStore();
  const bootstrap = { events: [{ deadline_time: new Date(NOW + 60 * 60 * 1000).toISOString() }] };
  const fetchUpstream = upstream(() => ok(bootstrap));
  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: NOW });
  assert.equal(store.map.get(DEADLINE_KEY).nextDeadline, new Date(NOW + 3600000).toISOString());

  // An entry cached 3 minutes ago would normally still be fresh (5 min TTL),
  // but an hour before the deadline it is not.
  store.map.set(cacheKey('entry/1'), { fetchedAt: new Date(NOW - 3 * 60 * 1000).toISOString(), body: { old: true } });
  const res = await serveFpl({ path: 'entry/1', store, fetchUpstream, now: NOW });
  assert.equal(res.cache, 'miss', 'the deadline window forced a refresh');
});

test('an upstream outage serves the last good copy, clearly marked stale', async () => {
  const store = memoryStore();
  await serveFpl({ path: 'fixtures', store, fetchUpstream: upstream(() => ok({ n: 1 })), now: NOW });

  const down = upstream(() => { throw new Error('ECONNRESET'); });
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream: down, now: NOW + 3 * 3600 * 1000 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { n: 1 }, 'the real last-known payload, never a fabricated one');
  assert.equal(res.stale, true);
  assert.equal(res.ageSeconds, 3 * 3600);
});

test('a 500 from upstream is an outage too', async () => {
  const store = memoryStore();
  await serveFpl({ path: 'fixtures', store, fetchUpstream: upstream(() => ok({ n: 1 })), now: NOW });
  const res = await serveFpl({
    path: 'fixtures', store, now: NOW + 3600 * 1000,
    fetchUpstream: upstream(() => new Response('upstream boom', { status: 503 })),
  });
  assert.equal(res.stale, true);
  assert.deepEqual(res.body, { n: 1 });
});

test('an outage with nothing cached says so instead of inventing data', async () => {
  const res = await serveFpl({
    path: 'bootstrap-static', store: memoryStore(), now: NOW,
    fetchUpstream: upstream(() => { throw new Error('ECONNRESET'); }),
  });
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: 'upstream_unavailable' });
  assert.equal(res.stale, false);
});

test('an unknown team id passes through as a 404 and is never cached', async () => {
  // "That team does not exist" is a real answer the onboarding screen needs.
  // Caching it would keep a newly created team unreachable for the whole TTL.
  const store = memoryStore();
  const fetchUpstream = upstream(() => new Response('{"detail":"Not found."}', { status: 404 }));
  const res = await serveFpl({ path: 'entry/999999999', store, fetchUpstream, now: NOW });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
  assert.equal(store.map.size, 0);
});

test('a corrupt cache entry is ignored rather than served', async () => {
  const store = memoryStore({ [cacheKey('fixtures')]: { fetchedAt: 'nonsense' } });
  const fetchUpstream = upstream(() => ok({ n: 1 }));
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(res.cache, 'miss');
  assert.deepEqual(res.body, { n: 1 });
});
