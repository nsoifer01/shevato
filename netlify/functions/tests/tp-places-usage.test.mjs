import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateUsage, MAX_CAS_ATTEMPTS } from '../lib/tp-places-usage.mjs';
import { checkQuota, releaseQuota } from '../lib/tp-places-quota.mjs';

// In-memory stand-in for the conditional-write surface of a Netlify blob
// store: getWithMetadata hands out an opaque etag, setJSON honours
// onlyIfMatch / onlyIfNew exactly like the real thing (the write lands only
// when the precondition still holds), and every landed write mints a fresh
// etag. Reads and writes are counted so tests can pin how much work a path
// performed.
function memStore() {
  let seq = 0;
  const map = new Map();
  const store = {
    reads: 0,
    writes: 0,
    gate: null,
    async getWithMetadata(key) {
      store.reads += 1;
      if (store.gate) await store.gate();
      const e = map.get(key);
      return e ? { data: JSON.parse(e.json), etag: e.etag, metadata: {} } : null;
    },
    async setJSON(key, value, cond = {}) {
      store.writes += 1;
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

// Barrier that holds every reader until n of them have arrived, so all n
// concurrent updates read the SAME counters and the SAME etag before any of
// them writes: the exact interleaving the conditional write exists to
// survive, made deterministic instead of hoped-for. Retry rounds after the
// first pass through freely.
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

const NOW = 1780000000000; // fixed instant so every call lands in one bucket

function reserve(store, clientId, cost) {
  return updateUsage(store, 'usage', usage => {
    const q = checkQuota(usage, clientId, NOW, cost);
    return { write: q.allowed ? q.usage : null, result: q };
  });
}

test('colliding reservations all land: no spend is lost to the race', async () => {
  // THE BUG THIS FILE EXISTS FOR. With plain get + setJSON, all four writers
  // read the same counters and the last write wins: the blob ends at 1 and
  // three reservations of real-money budget simply vanish. Four writers with
  // MAX_CAS_ATTEMPTS 5 is also guaranteed to converge (a writer can lose one
  // race per other writer at most), so this cannot flake.
  const store = memStore();
  store.gate = collisionGate(4);
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, (_, i) => reserve(store, 'client-' + i, 1)));

  assert.ok(outcomes.every(o => o.ok && o.result.allowed));
  const usage = store.peek('usage');
  assert.equal(usage.globalDay, 4);
  assert.equal(usage.globalMonth, 4);
  // And the race genuinely happened: it took more writes than winners.
  assert.ok(store.writes > 4, 'expected lost CAS rounds, got a serial run');
});

test('first-ever writers race on onlyIfNew and both land', async () => {
  // The blob does not exist until the first reservation creates it, so the
  // very first collision has no etag to compare: both writers must claim
  // "still missing", exactly one create wins, and the loser retries against
  // the winner's counters instead of clobbering them.
  const store = memStore();
  store.gate = collisionGate(2);
  const outcomes = await Promise.all([
    reserve(store, 'client-a', 2),
    reserve(store, 'client-b', 3),
  ]);
  assert.ok(outcomes.every(o => o.ok && o.result.allowed));
  assert.equal(store.peek('usage').globalDay, 5);
});

test('a rejected reservation reads the counters but never writes', async () => {
  // checkQuota with granted 0 returns pruned counters; persisting them would
  // be a pointless write on every 429 and a CAS conflict for real traffic.
  const store = memStore();
  await store.setJSON('usage', { hourBucket: 0 });
  const before = store.writes;
  const out = await updateUsage(store, 'usage', () => ({ write: null, result: 'denied' }));
  assert.equal(out.ok, true);
  assert.equal(out.result, 'denied');
  assert.equal(store.writes, before);
});

test('sustained contention gives up after MAX_CAS_ATTEMPTS and reports it', async () => {
  // A store whose etag is always stale by the time the write arrives: the
  // caller must learn the reservation never landed (and fail closed), not
  // spend against a counter that was never moved.
  const store = memStore();
  const realSet = store.setJSON;
  store.setJSON = async (key, value) => {
    await realSet.call(store, key, { poisoned: true }); // someone else always wins
    store.writes -= 1;
    return { modified: false };
  };
  const out = await reserve(store, 'client-a', 1);
  assert.equal(out.ok, false);
  assert.equal(store.reads, MAX_CAS_ATTEMPTS);
});

test('a colliding release still subtracts exactly its own slots', async () => {
  // Two batches that were all cache hits hand back their reservations at the
  // same moment; each release must subtract from the other's result, not from
  // the counters both read before either wrote.
  const store = memStore();
  await reserve(store, 'client-a', 4);
  await reserve(store, 'client-b', 4);
  assert.equal(store.peek('usage').globalDay, 8);

  store.gate = collisionGate(2);
  const release = id => updateUsage(store, 'usage', latest =>
    ({ write: releaseQuota(latest, id, NOW, 3) }));
  const outcomes = await Promise.all([release('client-a'), release('client-b')]);

  assert.ok(outcomes.every(o => o.ok));
  const usage = store.peek('usage');
  assert.equal(usage.globalDay, 2);
  assert.equal(usage.clientHour['client-a'], 1);
  assert.equal(usage.clientHour['client-b'], 1);
});

test('partial grants under collision never overrun the cap', async () => {
  // Three concurrent batches of 8 against a global-day cap of 20: whatever
  // order the CAS settles them in, the grants must sum to at most the cap,
  // and the counter must equal exactly what was granted.
  const limits = { perClientHour: 100, perClientDay: 100, globalDay: 20, globalMonth: 100 };
  const store = memStore();
  store.gate = collisionGate(3);
  const outcomes = await Promise.all(Array.from({ length: 3 }, (_, i) =>
    updateUsage(store, 'usage', usage => {
      const q = checkQuota(usage, 'client-' + i, NOW, 8, limits);
      return { write: q.allowed ? q.usage : null, result: q };
    })));

  const granted = outcomes.reduce((n, o) => n + (o.ok ? o.result.granted : 0), 0);
  assert.equal(granted, 20, 'the cap is filled exactly, never overrun');
  assert.equal(store.peek('usage').globalDay, 20);
});
