// The FPL proxy's cache-miss quota.
//
// THE HOLE THIS CLOSES (2026-09 audit). fpl.mjs had an origin check (a
// forgeable header - the repo's own apps/fpl-planner/scripts/evidence-probe.mjs
// spoofs it), a GET check and an anchored path allowlist, and then nothing at
// all. A proof of concept walked 500 distinct `entry/<n>/history` paths and got
// 500 upstream fetches and 500 permanent blob keys out of it. The path
// cardinality is attacker-chosen across roughly 11 million real FPL team ids,
// and varying the id defeats the edge cache too, so neither the CDN nor the
// blob cache bounds any of it.
//
// The properties that matter, in the order they matter, are each pinned below:
//
//   1. A CACHE HIT IS FREE. A manager reloading, and a thousand visitors asking
//      for the same public bootstrap, must cost no quota at all. That is why
//      the claim is wrapped around the UPSTREAM FETCH rather than sitting at
//      the top of the handler: serveFpl calls fetchUpstream only on a miss.
//   2. Cache-miss fetches are bounded per network per window.
//   3. A second network is untouched by the first one's spending.
//   4. Quota infrastructure failure SERVES. Unlike tp-places, no money rides on
//      this endpoint; availability does, and a counter that cannot be read must
//      never become an outage.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { claimUpstreamSlot, quotaExceeded } from '../fpl.mjs';
import { checkQuota, resetAtFor, DEFAULT_LIMITS, QUOTA_KEY } from '../lib/fpl-quota.mjs';
import { serveFpl, cacheKey, TTL } from '../lib/fpl-cache.mjs';
import { networkBucket } from '../lib/tp-client-identity.mjs';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const NOW = Date.parse('2026-09-11T12:00:00Z');

// ------------------------------------------------------------------ math ---

const SMALL = { perNetworkHour: 3, perNetworkDay: 5 };

test('repeated cache misses from one network are bounded by the hour cap', () => {
  let usage = {};
  for (let i = 0; i < SMALL.perNetworkHour; i++) {
    const q = checkQuota(usage, 'net-a', NOW, SMALL);
    assert.equal(q.allowed, true, `fetch ${i + 1} of the allowance`);
    usage = q.usage;
  }
  const over = checkQuota(usage, 'net-a', NOW, SMALL);
  assert.equal(over.allowed, false);
  assert.equal(over.scope, 'network_hour');
  // A rejection must not move the counters, or a refused caller would still be
  // pushing everyone else towards the cap.
  assert.equal(over.usage.networkHour['net-a'], SMALL.perNetworkHour);
});

test('the day cap bounds a slow drip that never trips the hour cap', () => {
  let usage = {};
  // Start at the day boundary, so all 24 hourly steps land in ONE day bucket:
  // the point is that the hour cap never speaks, not that the day rolls over.
  let now = Date.parse('2026-09-11T00:00:00Z');
  let allowed = 0;
  // One fetch an hour for a whole day: every hour bucket is fresh, so only the
  // day cap can stop this. Without it, an attacker paces at 1/hour forever.
  for (let h = 0; h < 24; h++) {
    const q = checkQuota(usage, 'net-a', now, SMALL);
    if (q.allowed) allowed += 1;
    usage = q.usage;
    if (!q.allowed) assert.equal(q.scope, 'network_day');
    now += HOUR_MS;
  }
  assert.equal(allowed, SMALL.perNetworkDay);
});

test('a second network is completely unaffected by the first one spending out', () => {
  let usage = {};
  for (let i = 0; i < SMALL.perNetworkDay; i++) usage = checkQuota(usage, 'net-a', NOW, SMALL).usage;
  assert.equal(checkQuota(usage, 'net-a', NOW, SMALL).allowed, false, 'the greedy network is done');
  assert.equal(checkQuota(usage, 'net-b', NOW, SMALL).allowed, true, 'the honest one is not');
});

test('no address means no network dimension, and that fails OPEN', () => {
  // networkBucket returns '' for a request the platform gave no address for (a
  // local netlify dev session, an unusual proxy). Metering nothing is the right
  // answer: a limiter that becomes an outage when a header is missing is worse
  // than the abuse it guards against.
  let usage = {};
  for (let i = 0; i < 50; i++) {
    const q = checkQuota(usage, '', NOW, SMALL);
    assert.equal(q.allowed, true);
    usage = q.usage;
  }
  assert.deepEqual({ ...usage.networkHour }, {}, 'nothing was counted at all');
});

test('stale buckets are pruned, so the blob cannot grow without bound', () => {
  let usage = {};
  for (let i = 0; i < SMALL.perNetworkHour; i++) usage = checkQuota(usage, 'net-a', NOW, SMALL).usage;
  assert.equal(checkQuota(usage, 'net-a', NOW, SMALL).allowed, false);

  const nextHour = checkQuota(usage, 'net-a', NOW + HOUR_MS, SMALL);
  assert.equal(nextHour.allowed, true, 'the hour bucket refilled');
  assert.equal(Object.keys(nextHour.usage.networkHour).length, 1, 'last hour is gone, not carried');

  const nextDay = checkQuota({ ...usage }, 'net-a', NOW + DAY_MS, SMALL);
  assert.deepEqual({ ...nextDay.usage.networkDay }, { 'net-a': 1 }, 'the day map started over too');
});

test('a network id that collides with a prototype key is still just a key', () => {
  // networkBucket only ever produces hex, so this cannot happen today; it is
  // pinned because the same class of bug (a plain object literal and an
  // attacker-influenced key) is called out in both sibling quota modules.
  let usage = {};
  for (let i = 0; i < SMALL.perNetworkHour; i++) usage = checkQuota(usage, '__proto__', NOW, SMALL).usage;
  assert.equal(checkQuota(usage, '__proto__', NOW, SMALL).allowed, false);
});

test('resetAtFor names the edge each bucket actually refills on', () => {
  assert.equal(resetAtFor('network_hour', NOW), (Math.floor(NOW / HOUR_MS) + 1) * HOUR_MS);
  assert.equal(resetAtFor('network_day', NOW), (Math.floor(NOW / DAY_MS) + 1) * DAY_MS);
  assert.ok(resetAtFor('anything-else', NOW) > NOW, 'an unknown scope still gets a finite wait');
});

test('the shipped caps sit well above a real planner session', () => {
  // The arithmetic is written out in lib/fpl-quota.mjs. The floor asserted here
  // is the part that must not be tightened by accident: one live gameweek hour
  // is already ~60 misses on `event/<gw>/live` alone (60s TTL), plus a boot of
  // ~16 distinct paths, plus refreshes.
  assert.ok(DEFAULT_LIMITS.perNetworkHour >= 250, 'an hour of live polling plus a boot must fit twice over');
  assert.ok(DEFAULT_LIMITS.perNetworkDay >= 4 * DEFAULT_LIMITS.perNetworkHour);
});

// ------------------------------------------------------------------ seam ---

function memStore(initial = {}) {
  let seq = 0;
  const map = new Map();
  for (const [k, v] of Object.entries(initial)) map.set(k, { json: JSON.stringify(v), etag: '"e' + (++seq) + '"' });
  return {
    map,
    async get(key) { const e = map.get(key); return e ? JSON.parse(e.json) : null; },
    async getWithMetadata(key) { const e = map.get(key); return e ? { data: JSON.parse(e.json), etag: e.etag } : null; },
    async setJSON(key, value, cond = {}) {
      const e = map.get(key);
      if (cond.onlyIfNew && e) return { modified: false };
      if (cond.onlyIfMatch !== undefined && (!e || e.etag !== cond.onlyIfMatch)) return { modified: false };
      map.set(key, { json: JSON.stringify(value), etag: '"e' + (++seq) + '"' });
      return { modified: true };
    },
    peek(key) { const e = map.get(key); return e ? JSON.parse(e.json) : null; },
  };
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('THE POINT: a cache HIT never touches the quota', async () => {
  const store = memStore();
  let claims = 0;
  const metered = async (url) => {
    const slot = await claimUpstreamSlot(store, 'net-a', NOW);
    assert.equal(slot.allowed, true);
    claims += 1;
    return ok({ url });
  };

  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream: metered, now: NOW });
  for (let i = 1; i <= 20; i++) {
    const res = await serveFpl({ path: 'bootstrap-static', store, fetchUpstream: metered, now: NOW + i * 1000 });
    assert.equal(res.cache, 'hit', 'inside the TTL');
  }
  assert.equal(claims, 1, 'twenty reloads, one upstream fetch, one unit of quota');
  assert.equal(store.peek(QUOTA_KEY).networkHour['net-a'], 1);
  assert.ok(store.map.has(cacheKey('bootstrap-static')));
  assert.ok(TTL.bootstrap > 20, 'the loop above stayed inside the TTL');
});

// ------------------------------------------------------------- fail open ---

test('a quota store that cannot be READ serves the request', async () => {
  const broken = {
    async getWithMetadata() { throw new Error('Blobs incident'); },
    async setJSON() { throw new Error('Blobs incident'); },
  };
  const slot = await claimUpstreamSlot(broken, 'net-a', NOW);
  assert.equal(slot.allowed, true, 'availability wins here: no money rides on this endpoint');
});

test('a quota store that cannot be WRITTEN serves the request', async () => {
  // Sustained CAS contention. tp-places fails CLOSED on this because every
  // reservation there guards a card; this one fails OPEN, and the cost of that
  // is bounded: a burst that loses every CAS round overshoots the cap by the
  // number of racing writers and nothing more.
  const contended = {
    async getWithMetadata() { return { data: {}, etag: '"stale"' }; },
    async setJSON() { return { modified: false }; },
  };
  const slot = await claimUpstreamSlot(contended, 'net-a', NOW);
  assert.equal(slot.allowed, true);
});

test('no store at all (the Blobs-down fallback) means no metering', async () => {
  assert.equal((await claimUpstreamSlot(null, 'net-a', NOW)).allowed, true);
});

// --------------------------------------------------------------- refusal ---

test('a refusal is a 429 with Retry-After and resetAt, and is never edge-cached', async () => {
  const res = quotaExceeded('network_hour', NOW);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const seconds = Number(res.headers.get('retry-after'));
  assert.ok(Number.isInteger(seconds) && seconds > 0, 'Retry-After is whole seconds');
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.scope, 'network_hour');
  assert.equal(Date.parse(body.resetAt), resetAtFor('network_hour', NOW));
  // A 429 is per-NETWORK. Letting the CDN repeat it would refuse everybody
  // else who asks for that path until it expired.
  assert.equal(res.headers.get('netlify-cdn-cache-control'), 'no-store');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// ------------------------------------------------------------------- e2e ---

// The handler's store is not injectable (fplStore() calls getStore() on
// @netlify/blobs), so this redirects that one specifier to the in-memory CAS
// stub beside this file. It is named for tp-assist because that is where it was
// written, but it is a generic @netlify/blobs stand-in and the FPL store uses
// exactly the surface it implements.
let hooksOk = true;
try { register('./tp-assist-blobs-hooks.mjs', import.meta.url); } catch { hooksOk = false; }
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable' };

const STORE = 'fpl-planner';
function seedBlobs(entries = {}) {
  const map = new Map();
  let seq = 0;
  for (const [k, v] of Object.entries(entries)) map.set(k, { data: v, etag: 'etag-' + (++seq) });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq };
  return map;
}
const peek = (key) => {
  const e = globalThis.__tpAssistBlobStub.stores[STORE].get(key);
  return e ? e.data : null;
};

const ADDR = '203.0.113.7';
const OTHER = '198.51.100.9';
function req(path, addr = ADDR) {
  return new Request(`https://shevato.com/.netlify/functions/fpl?path=${encodeURIComponent(path)}`, {
    headers: { Origin: 'https://shevato.com', 'x-nf-client-connection-ip': addr },
  });
}

async function withFetchStub(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// A network already at its hourly cap, in the live buckets, so the handler
// reads it as current rather than pruning it as stale.
function spentUsage(addr, now = Date.now()) {
  const net = networkBucket(addr, now);
  return {
    hourBucket: Math.floor(now / HOUR_MS),
    dayBucket: Math.floor(now / DAY_MS),
    networkHour: { [net]: DEFAULT_LIMITS.perNetworkHour },
    networkDay: { [net]: DEFAULT_LIMITS.perNetworkHour },
  };
}

test('e2e: an exhausted network gets a 429 and never reaches upstream', opts, async () => {
  seedBlobs({ [QUOTA_KEY]: spentUsage(ADDR) });
  let upstreamCalls = 0;
  const res = await withFetchStub(
    async () => { upstreamCalls += 1; return ok({ n: 1 }); },
    () => handler(req('entry/4231987/history')),
  );
  assert.equal(res.status, 429);
  assert.equal(upstreamCalls, 0, 'the whole point: no upstream fetch, no new blob key');
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.scope, 'network_hour');
  assert.ok(res.headers.get('retry-after'));
  assert.equal(peek(cacheKey('entry/4231987/history')), null, 'nothing was cached for the refused path');
});

test('e2e: a second network is served while the first is exhausted', opts, async () => {
  seedBlobs({ [QUOTA_KEY]: spentUsage(ADDR) });
  const res = await withFetchStub(
    async () => ok({ n: 1 }),
    () => handler(req('entry/4231987/history', OTHER)),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-fpl-cache'), 'miss');
});

test('e2e: an exhausted network is still served whatever the cache already holds', opts, async () => {
  // Refusing quota must never be WORSE than the cache can be. A path already in
  // the cache costs nothing to serve, so it is served, 200, exactly as it would
  // be for anyone else.
  const fetchedAt = new Date(Date.now() - 5000).toISOString();
  seedBlobs({
    [QUOTA_KEY]: spentUsage(ADDR),
    [cacheKey('fixtures')]: { fetchedAt, body: { cached: true } },
  });
  const res = await withFetchStub(
    async () => { throw new Error('must not be called'); },
    () => handler(req('fixtures')),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cached: true });
  assert.equal(res.headers.get('x-fpl-cache'), 'hit');
});

test('e2e: distinct attacker-chosen paths are bounded, and the counter moves once per miss', opts, async () => {
  const now = Date.now();
  const net = networkBucket(ADDR, now);
  // Two units left in the hour bucket, so three distinct paths cost two
  // upstream fetches and a refusal.
  seedBlobs({
    [QUOTA_KEY]: {
      hourBucket: Math.floor(now / HOUR_MS),
      dayBucket: Math.floor(now / DAY_MS),
      networkHour: { [net]: DEFAULT_LIMITS.perNetworkHour - 2 },
      networkDay: { [net]: 0 },
    },
  });
  let upstreamCalls = 0;
  const statuses = await withFetchStub(
    async () => { upstreamCalls += 1; return ok({ n: upstreamCalls }); },
    async () => {
      const out = [];
      for (const id of [1, 2, 3]) out.push((await handler(req(`entry/${id}/history`))).status);
      return out;
    },
  );
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.equal(upstreamCalls, 2);
  assert.equal(peek(QUOTA_KEY).networkHour[net], DEFAULT_LIMITS.perNetworkHour);
});

test('e2e: a cache hit costs no quota at the handler level either', opts, async () => {
  const now = Date.now();
  const net = networkBucket(ADDR, now);
  seedBlobs({});
  await withFetchStub(async () => ok({ n: 1 }), async () => {
    await handler(req('bootstrap-static'));
    const after = peek(QUOTA_KEY).networkHour[net];
    assert.equal(after, 1, 'the miss cost one');
    for (let i = 0; i < 5; i++) {
      const res = await handler(req('bootstrap-static'));
      assert.equal(res.headers.get('x-fpl-cache'), 'hit');
    }
    assert.equal(peek(QUOTA_KEY).networkHour[net], after, 'five hits cost nothing');
  });
});

test('e2e: with no Blobs context at all the proxy still serves everything', opts, async () => {
  // fplStore() throws without a seeded stub, so the handler falls back to its
  // memoryStore and the quota store is gone with it. Every request is a miss
  // and every miss must still be served: losing the counter costs traffic, not
  // availability.
  delete globalThis.__tpAssistBlobStub;
  let upstreamCalls = 0;
  await withFetchStub(async () => { upstreamCalls += 1; return ok({ n: 1 }); }, async () => {
    for (let i = 0; i < 12; i++) {
      const res = await handler(req(`entry/${1000 + i}/history`));
      assert.equal(res.status, 200, `request ${i}`);
    }
  });
  assert.equal(upstreamCalls, 12);
});
