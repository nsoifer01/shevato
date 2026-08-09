import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateUsage } from '../lib/blob-cas.mjs';
import { checkQuota, DEFAULT_LIMITS } from '../lib/tp-assist-quota.mjs';

// tp-assist's reservation used to be a plain get + setJSON: two parallel
// requests read the same counters, both passed checkQuota, and the later write
// erased the earlier reservation, so a concurrent burst overran the daily
// caps. The handler now composes checkQuota with the same etag-CAS helper
// tp-places uses; these tests pin that composition (the handler's step 5,
// reproduced verbatim in reserve() below) against deterministic collisions.

function memStore() {
  let seq = 0;
  const map = new Map();
  const store = {
    gate: null,
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

// Holds every reader until n have arrived, so all n concurrent reservations
// read the SAME counters and etag before any write: the interleaving the CAS
// exists to survive, made deterministic. Retry rounds pass through freely.
function collisionGate(n) {
  const waiting = [];
  let armed = true;
  return () => {
    if (!armed) return Promise.resolve();
    return new Promise(resolve => {
      waiting.push(resolve);
      if (waiting.length === n) {
        armed = false;
        waiting.forEach(r => r());
      }
    });
  };
}

const NOW = 1780000000000;

// The handler's reservation, verbatim.
function reserve(store, clientId) {
  return updateUsage(store, 'usage', usage => {
    const q = checkQuota(usage, clientId, NOW);
    return { write: q.allowed ? q.usage : null, result: q };
  });
}

test('colliding assist reservations all land: none is erased by the race', async () => {
  const store = memStore();
  store.gate = collisionGate(4);
  const results = await Promise.all(['a', 'b', 'c', 'd'].map(id => reserve(store, id)));
  assert.ok(results.every(r => r.ok && r.result.allowed));
  // Every reservation must be visible in the final counters. Under the old
  // plain write this ended at 1, with three grants unaccounted for.
  assert.equal(store.peek('usage').globalDay, 4);
});

test('a client at its hourly cap is rejected without moving the counters', async () => {
  const store = memStore();
  for (let i = 0; i < DEFAULT_LIMITS.perClientHour; i++) {
    const r = await reserve(store, 'greedy');
    assert.ok(r.ok && r.result.allowed);
  }
  const before = store.peek('usage');
  const rejected = await reserve(store, 'greedy');
  assert.ok(rejected.ok);
  assert.equal(rejected.result.allowed, false);
  assert.equal(rejected.result.scope, 'client_hour');
  // A rejection reads but must not write.
  assert.deepEqual(store.peek('usage'), before);
});

test('concurrent burst cannot overrun the cap; every grant is accounted for', async () => {
  const store = memStore();
  const n = DEFAULT_LIMITS.perClientHour + 5;
  store.gate = collisionGate(n);
  const results = await Promise.all(Array.from({ length: n }, () => reserve(store, 'burst')));
  const granted = results.filter(r => r.ok && r.result.allowed).length;
  // Some writers exhaust their CAS retries against this much deliberate
  // contention and fail closed (a 429 in the handler) rather than being
  // granted optimistically. That is the designed trade: the invariants are
  // that the cap is never overrun, and that every grant that was handed out
  // is visible in the landed counters, with none erased by the race.
  assert.ok(granted <= DEFAULT_LIMITS.perClientHour, `granted ${granted}`);
  assert.ok(granted > 0, 'contention must not starve everyone');
  assert.equal(store.peek('usage').clientHour.burst, granted);
  assert.equal(store.peek('usage').globalDay, granted);
});
