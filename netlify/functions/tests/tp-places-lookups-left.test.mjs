// "How many lookups could I make right now?" (2026-09-28).
//
// The Trip Planner's bulk "Load all Google ratings" warning states the
// caller's own headroom before they commit, so "this looks up 40 places" can
// be read against "you have 12 left". These pin that the number is computed
// exactly as the write path will enforce it, that the question spends and
// writes nothing, and that it answers with the caller's figure only.
import { register } from 'node:module';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let hooksOk = true;
try {
  register('./tp-assist-blobs-hooks.mjs', import.meta.url);
} catch {
  hooksOk = false;
}
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable; the handler needs the @netlify/blobs hook' };

const { default: handler, clampBody } = await import('../tp-places.mjs');
const { lookupsLeft, checkQuota, MONTHLY_BUDGET, DEFAULT_LIMITS, OWNER_LIMITS } = await import('../lib/tp-places-quota.mjs');

const T = Date.UTC(2026, 8, 20, 12, 30, 0);          // mid-September, mid-hour
const monthOf = (t) => new Date(t - 8 * 3600000).toISOString().slice(0, 7);
const dayOf = (t) => Math.floor(t / 86400000);
const hourOf = (t) => Math.floor(t / 3600000);
const usageAt = (t, over = {}) => ({
  monthBucket: monthOf(t), dayBucket: dayOf(t), hourBucket: hourOf(t),
  billedMonth: 0, globalDay: 0, globalMonth: 0, ownerDay: 0, ownerMonth: 0,
  clientHour: {}, clientDay: {}, networkHour: {}, networkDay: {}, ...over,
});

// ---------- the pure read ----------

test('a fresh month offers the tightest bucket, which for a visitor is the per-client hour', () => {
  const b = lookupsLeft({}, 'c1', T);
  assert.equal(b.left, DEFAULT_LIMITS.perClientHour);
  assert.equal(b.scope, 'client_hour');
  assert.equal(b.resetAt, (hourOf(T) + 1) * 3600000, 'the hour refills at the next hour');
});

test('the shared monthly budget binds when it is the smallest room', () => {
  const b = lookupsLeft(usageAt(T, { billedMonth: MONTHLY_BUDGET - 7 }), 'c1', T);
  assert.equal(b.left, 7);
  assert.equal(b.scope, 'free_month');
});

test('an exhausted month reads 0 and names free_month, as a 429 would', () => {
  const b = lookupsLeft(usageAt(T, { billedMonth: MONTHLY_BUDGET, globalMonth: 250 }), 'c1', T);
  assert.equal(b.left, 0);
  assert.equal(b.scope, 'free_month');
  assert.equal(new Date(b.resetAt).toISOString(), '2026-10-01T08:00:00.000Z');
});

test('the owner tier reads its own buckets', () => {
  const b = lookupsLeft(usageAt(T, { ownerMonth: OWNER_LIMITS.globalMonth - 3 }), 'o1', T, OWNER_LIMITS, 'owner');
  assert.equal(b.left, 3);
  assert.equal(b.scope, 'owner_month');
});

test('it is exactly what checkQuota would grant for a large ask', () => {
  // One definition of the room (quotaRoom) serves both, so the number shown
  // can never disagree with the number enforced.
  const cases = [
    usageAt(T),
    usageAt(T, { billedMonth: MONTHLY_BUDGET - 20 }),
    usageAt(T, { clientHour: { c1: 55 } }),
    usageAt(T, { globalDay: DEFAULT_LIMITS.globalDay - 2 }),
    usageAt(T, { networkDay: { n1: DEFAULT_LIMITS.perNetworkDay - 4 } }),
  ];
  for (const u of cases) {
    const shown = lookupsLeft(u, 'c1', T, DEFAULT_LIMITS, 'public', 'n1').left;
    const granted = checkQuota(u, 'c1', T, 10000, DEFAULT_LIMITS, 'public', 'n1').granted;
    assert.equal(shown, granted, JSON.stringify(u));
  }
});

test('the read never mutates what it was given', () => {
  const u = usageAt(T, { billedMonth: 5, clientHour: { c1: 3 } });
  const before = JSON.stringify(u);
  lookupsLeft(u, 'c1', T);
  assert.equal(JSON.stringify(u), before);
});

// ---------- the request shape ----------

test('clampBody accepts a budget question with no queries, and still requires a clientId', () => {
  const ok = clampBody({ clientId: 'c1', budget: true, ownerToken: ' t ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.budget, true);
  assert.deepEqual(ok.queries, []);
  assert.equal(ok.ownerToken, 't');
  assert.equal(clampBody({ budget: true }).ok, false, 'no clientId, no answer');
  assert.equal(clampBody({ clientId: 'c1', budget: 'yes' }).ok, false, 'only a literal true asks');
});

// ---------- the handler: reads, spends nothing, writes nothing ----------

const STORE = 'trip-planner-places';
let map, realFetch, upstream;
beforeEach(() => {
  map = new Map();
  map.set('config', { data: { placesKeyV2: 'test-key' }, etag: 'e1' });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq: 0 };
  upstream = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstream += 1; return new Response('{}', { status: 500 }); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const ask = (body, headers = {}) => handler(new Request('https://shevato.com/.netlify/functions/tp-places', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://shevato.com', 'x-nf-client-connection-ip': '203.0.113.9', ...headers },
  body: JSON.stringify(body),
}));

test('the handler answers the caller\'s own headroom and nothing else', opts, async () => {
  const now = Date.now();
  map.set('usage', { data: usageAt(now, { billedMonth: MONTHLY_BUDGET - 9, clientHour: { someoneElse: 40 } }), etag: 'u1' });
  const res = await ask({ clientId: 'c-me', budget: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['left', 'resetAt', 'scope']);
  assert.equal(body.left, 9);
  assert.equal(body.scope, 'free_month');
});

test('asking spends nothing, calls Google never, and writes no counter', opts, async () => {
  const now = Date.now();
  const u = usageAt(now, { billedMonth: 100 });
  map.set('usage', { data: u, etag: 'u1' });
  for (let i = 0; i < 5; i++) await ask({ clientId: 'c-me', budget: true });
  assert.equal(upstream, 0, 'no upstream call');
  assert.deepEqual(map.get('usage').data, u, 'the counters are untouched');
  assert.equal(map.get('usage').etag, 'u1', 'and never rewritten');
});

test('an exhausted month answers 0 with a 200, not a 429', opts, async () => {
  map.set('usage', { data: usageAt(Date.now(), { billedMonth: MONTHLY_BUDGET }), etag: 'u1' });
  const res = await ask({ clientId: 'c-me', budget: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).left, 0);
});

test('a foreign origin is refused before anything is read', opts, async () => {
  const res = await ask({ clientId: 'c-me', budget: true }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});
