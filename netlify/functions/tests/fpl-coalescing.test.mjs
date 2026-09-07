import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serveFpl, cacheKey, leaseKey, claimRefreshLease,
  TTL, STALE_SERVE_SECONDS, REFRESH_LEASE_SECONDS,
} from '../lib/fpl-cache.mjs';
import { edgeCachePolicy } from '../fpl.mjs';

// F11 (2026-09-05 audit): a popular key expiring must not fan a burst out to
// upstream.
//
// Netlify runs one function instance per request, so the browser's own
// single-flight dedupe protects one visitor and nothing else. Twenty browsers
// asking for `fixtures` the second its TTL lapses made twenty identical
// upstream calls - the audit measured exactly 20/20 - and each of them paid
// the full round trip for an answer nineteen of them did not need.
//
// The fix is a lease: an etag-conditional claim on a tiny blob that exactly
// one caller can win, with everyone else served the copy already in hand,
// marked stale. These pin that, and every way it must NOT wedge.

/**
 * In-memory stand-in for the conditional-write surface of a Netlify blob
 * store, matching blob-cas-usage.test.mjs: getWithMetadata hands out an
 * opaque etag and setJSON honours onlyIfMatch / onlyIfNew exactly like the
 * real thing.
 */
function memStore(initial = {}) {
  let seq = 0;
  const map = new Map();
  for (const [k, v] of Object.entries(initial)) {
    seq += 1;
    map.set(k, { json: JSON.stringify(v), etag: '"e' + seq + '"' });
  }
  const store = {
    gate: null,
    async get(key) {
      const e = map.get(key);
      return e ? JSON.parse(e.json) : null;
    },
    async getWithMetadata(key) {
      if (store.gate) await store.gate();
      const e = map.get(key);
      return e ? { data: JSON.parse(e.json), etag: e.etag, metadata: {} } : null;
    },
    async setJSON(key, value, cond = {}) {
      const e = map.get(key);
      if (cond.onlyIfNew && e) return { modified: false };
      if (cond.onlyIfMatch !== undefined && (!e || e.etag !== cond.onlyIfMatch)) return { modified: false };
      seq += 1;
      const etag = '"e' + seq + '"';
      map.set(key, { json: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
    peek(key) {
      const e = map.get(key);
      return e ? JSON.parse(e.json) : null;
    },
  };
  return store;
}

/** Holds every caller until n have arrived, so the race is real, not hoped for. */
function collisionGate(n) {
  const waiting = [];
  let armed = true;
  return () => {
    if (!armed) return Promise.resolve();
    return new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) { armed = false; waiting.forEach((r) => r()); }
    });
  };
}

const NOW = Date.parse('2026-08-10T12:00:00Z');
const FIXTURES = [{ id: 1, kickoff: 'soon' }];

function upstream(body = FIXTURES) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

/** A store holding a `fixtures` copy that expired `agoSeconds` ago. */
function expiredStore(agoSeconds = 1) {
  const fetchedAt = new Date(NOW - (TTL.fixtures + agoSeconds) * 1000).toISOString();
  return memStore({ [cacheKey('fixtures')]: { fetchedAt, body: FIXTURES } });
}

test('F11: twenty concurrent expired reads make ONE upstream call', async () => {
  const store = expiredStore();
  const fetchUpstream = upstream();
  store.gate = collisionGate(20);

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW, leaseId: `caller-${i}` })));

  assert.equal(fetchUpstream.calls.length, 1,
    `exactly one refresh owner; the audit measured 20 (got ${fetchUpstream.calls.length})`);
  assert.equal(results.filter((r) => r.coalesced).length, 19,
    'the other nineteen are answered from the copy already in hand');
  assert.ok(results.every((r) => r.status === 200), 'and nobody is made to wait or fail');
  assert.ok(results.filter((r) => r.coalesced).every((r) => r.stale === true),
    'a coalesced answer must SAY it is stale');
});

test('F11: the refresh owner still returns fresh data and writes the cache', async () => {
  const store = expiredStore();
  const fetchUpstream = upstream([{ id: 2 }]);
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(res.cache, 'miss');
  assert.equal(res.stale, false);
  assert.deepEqual(res.body, [{ id: 2 }]);
  assert.deepEqual(store.peek(cacheKey('fixtures')).body, [{ id: 2 }]);
});

test('F11: a lease that has expired is reclaimed - a crashed owner cannot wedge a key', async () => {
  const store = expiredStore();
  // Somebody claimed the refresh and never came back.
  await store.setJSON(leaseKey(cacheKey('fixtures')),
    { owner: 'ghost', expiresAt: NOW - 1 });
  const fetchUpstream = upstream();
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(fetchUpstream.calls.length, 1, 'the next caller takes over');
  assert.equal(res.stale, false);
});

test('F11: past the stale window every caller refreshes rather than serving old numbers', async () => {
  // A refresh that keeps failing must degrade into the old behaviour, not
  // into a plan built on last gameweek's prices.
  const store = expiredStore(STALE_SERVE_SECONDS + 30);
  await store.setJSON(leaseKey(cacheKey('fixtures')),
    { owner: 'someone', expiresAt: NOW + 10_000 });
  const fetchUpstream = upstream();
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(fetchUpstream.calls.length, 1);
  assert.equal(res.coalesced, undefined);
});

test('F11: a cold key (nothing cached) is never coalesced - there is nothing to serve', async () => {
  const store = memStore();
  const fetchUpstream = upstream();
  const results = await Promise.all(Array.from({ length: 3 }, () =>
    serveFpl({ path: 'entry/7/history', store, fetchUpstream, now: NOW })));
  assert.ok(results.every((r) => r.status === 200 && !r.coalesced));
});

test('F11: independent keys do not block one another', async () => {
  const fetchedAt = new Date(NOW - (TTL.fixtures + 5) * 1000).toISOString();
  const store = memStore({
    [cacheKey('fixtures')]: { fetchedAt, body: FIXTURES },
    [cacheKey('bootstrap-static')]: { fetchedAt, body: { total_players: 5 } },
  });
  const fetchUpstream = upstream();
  await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: NOW });
  assert.equal(fetchUpstream.calls.length, 2, 'one lease per key, not one lease per store');
});

test('F11: the refresh owner failing upstream still serves the stale copy', async () => {
  const store = expiredStore();
  const fetchUpstream = async () => { throw new Error('upstream down'); };
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.stale, true);
  assert.deepEqual(res.body, FIXTURES);
});

test('F11: a store that cannot lease fails OPEN rather than failing the request', async () => {
  // A cache is an optimisation in front of a public API. Losing the
  // coalescing must cost extra upstream calls, never an error.
  const store = expiredStore();
  store.getWithMetadata = async () => { throw new Error('blobs incident'); };
  const fetchUpstream = upstream();
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.stale, false);
  assert.equal(fetchUpstream.calls.length, 1);
});

test('F11: claimRefreshLease admits exactly one of many simultaneous claimants', async () => {
  const store = memStore();
  store.gate = collisionGate(8);
  const won = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    claimRefreshLease(store, 'k', NOW, `c${i}`)));
  assert.equal(won.filter(Boolean).length, 1, `one winner, got ${won.filter(Boolean).length}`);
  assert.equal(store.peek(leaseKey('k')).expiresAt, NOW + REFRESH_LEASE_SECONDS * 1000);
});

test('F11: a fresh hit is still a fresh hit, and takes no lease at all', async () => {
  const store = memStore({
    [cacheKey('fixtures')]: { fetchedAt: new Date(NOW - 10_000).toISOString(), body: FIXTURES },
  });
  const fetchUpstream = upstream();
  const res = await serveFpl({ path: 'fixtures', store, fetchUpstream, now: NOW });
  assert.equal(res.cache, 'hit');
  assert.equal(res.stale, false);
  assert.equal(fetchUpstream.calls.length, 0);
  assert.equal(store.peek(leaseKey(cacheKey('fixtures'))), null);
});

// ------------------------------------------------------------ edge policy ---

test('F11: only a fresh 200 may be repeated by the edge', () => {
  assert.equal(edgeCachePolicy({ status: 200, stale: true, path: 'fixtures', ageSeconds: 0 }), 'no-store');
  assert.equal(edgeCachePolicy({ status: 503, stale: false, path: 'fixtures', ageSeconds: 0 }), 'no-store');
  assert.equal(edgeCachePolicy({ status: 404, stale: false, path: 'entry/1', ageSeconds: 0 }), 'no-store');
});

test('F11: the edge window is the REMAINING life of the copy, never longer', () => {
  const fresh = edgeCachePolicy({ status: 200, stale: false, path: 'fixtures', ageSeconds: 0 });
  assert.equal(fresh, `public, max-age=${TTL.fixtures}`);
  const half = edgeCachePolicy({ status: 200, stale: false, path: 'fixtures', ageSeconds: 900 });
  assert.equal(half, `public, max-age=${TTL.fixtures - 900}`);
  // About to expire: not worth pinning in front of the function.
  assert.equal(edgeCachePolicy({ status: 200, stale: false, path: 'fixtures', ageSeconds: TTL.fixtures - 1 }), 'no-store');
});
