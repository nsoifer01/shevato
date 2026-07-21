import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuota, releaseQuota, DEFAULT_LIMITS } from '../lib/tp-places-quota.mjs';

// These limits guard real money: every granted slot is a billed Place Details
// Enterprise call ($0.02 once the 1,000 free monthly calls are gone). The tests
// below pin the properties that keep that bill bounded, not the arithmetic.

const T0 = Date.UTC(2026, 6, 19, 12, 0, 0);
const HOUR = 3600000;
const DAY = 86400000;
const limits = { perClientHour: 5, perClientDay: 8, globalDay: 10, globalMonth: 12 };

test('the monthly cap bounds the worst-case bill to about ten dollars', () => {
  // 1,000 complimentary Place Details Enterprise calls per calendar month, then
  // $20 per 1,000. If this default ever grows, the owner's card grows with it.
  const paid = DEFAULT_LIMITS.globalMonth - 1000;
  assert.ok(paid * 0.02 <= 10, 'monthly cap must keep worst-case spend at or under $10');
});

test('a single lookup reserves one slot in every bucket', () => {
  const r = checkQuota({}, 'c1', T0, 1, limits);
  assert.equal(r.allowed, true);
  assert.equal(r.granted, 1);
  assert.deepEqual(r.usage.clientHour, { c1: 1 });
  assert.equal(r.usage.globalDay, 1);
  assert.equal(r.usage.globalMonth, 1);
});

test('a batch reserves its whole cost, not one', () => {
  // The whole point of the cost parameter: one HTTP request can be twelve
  // billed calls, and counting it as one would let a client spend 12x its cap.
  const r = checkQuota({}, 'c1', T0, 4, limits);
  assert.equal(r.granted, 4);
  assert.equal(r.usage.globalDay, 4);
});

test('an oversized batch gets a partial grant rather than a rejection', () => {
  // Four cards with ratings beats seven cards with none.
  let u = checkQuota({}, 'c1', T0, 3, limits).usage;
  const r = checkQuota(u, 'c1', T0, 7, limits);
  assert.equal(r.allowed, true);
  assert.equal(r.granted, 2, 'perClientHour 5 leaves room for 2 more');
  assert.equal(r.scope, 'client_hour');
});

test('a client with no room left is rejected with the scope that blocked it', () => {
  let u = {};
  for (let i = 0; i < 5; i++) u = checkQuota(u, 'c1', T0, 1, limits).usage;
  const r = checkQuota(u, 'c1', T0, 1, limits);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'client_hour');
  assert.equal(r.granted, 0);
});

test('the tightest cap wins when several are close', () => {
  let u = {};
  for (const id of ['a', 'b']) u = checkQuota(u, id, T0, 5, limits).usage;
  // globalDay 10 is now full even though client c1 has spent nothing.
  const r = checkQuota(u, 'c1', T0, 1, limits);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'global_day');
});

test('the hourly client cap resets after an hour but the daily one does not', () => {
  let u = {};
  for (let i = 0; i < 5; i++) u = checkQuota(u, 'c1', T0, 1, limits).usage;
  const later = checkQuota(u, 'c1', T0 + HOUR, 1, limits);
  assert.equal(later.allowed, true);
  assert.equal(later.usage.clientDay.c1, 6, 'the day counter carried over');
});

// Only the month cap under test here, so the per-client and daily caps are
// opened up and cannot be what blocks the call.
const monthOnly = { perClientHour: 100, perClientDay: 100, globalDay: 100, globalMonth: 12 };

test('the daily cap resets the next day and the month counter carries', () => {
  let u = {};
  for (let i = 0; i < 8; i++) u = checkQuota(u, 'c1', T0, 1, monthOnly).usage;
  const next = checkQuota(u, 'c1', T0 + DAY, 1, monthOnly);
  assert.equal(next.allowed, true);
  assert.equal(next.usage.globalDay, 1);
  assert.equal(next.usage.globalMonth, 9, 'the month bucket is unchanged by a day rollover');
});

test('the month counter resets on the calendar boundary, matching Google', () => {
  // Google's complimentary allowance resets per calendar month, so a rolling
  // 30-day window would drift out of step with the thing it is protecting.
  let u = {};
  for (let i = 0; i < 12; i++) u = checkQuota(u, 'c' + i, Date.UTC(2026, 6, 31, 23, 0, 0), 1, monthOnly).usage;
  const blocked = checkQuota(u, 'cx', Date.UTC(2026, 6, 31, 23, 30, 0), 1, monthOnly);
  assert.equal(blocked.scope, 'global_month');
  const august = checkQuota(u, 'cx', Date.UTC(2026, 7, 1, 0, 30, 0), 1, monthOnly);
  assert.equal(august.allowed, true);
  assert.equal(august.usage.globalMonth, 1);
});

test('stale buckets are pruned so the usage blob cannot grow without bound', () => {
  let u = checkQuota({}, 'old-client', T0, 1, limits).usage;
  u = checkQuota(u, 'new-client', T0 + DAY, 1, limits).usage;
  assert.deepEqual(Object.keys(u.clientDay), ['new-client']);
  assert.deepEqual(Object.keys(u.clientHour), ['new-client']);
});

test('releasing unspent slots gives the quota back to the client', () => {
  // A batch of cache hits reserves up front and must cost the traveller
  // nothing, or browsing a cached itinerary would exhaust their allowance.
  const reserved = checkQuota({}, 'c1', T0, 5, limits).usage;
  const after = releaseQuota(reserved, 'c1', T0, 4);
  assert.equal(after.clientHour.c1, 1);
  assert.equal(after.clientDay.c1, 1);
  assert.equal(after.globalDay, 1);
  assert.equal(after.globalMonth, 1);
});

test('a release can never mint calls below zero', () => {
  const after = releaseQuota({}, 'c1', T0, 9);
  assert.equal(after.clientHour.c1, 0);
  assert.equal(after.globalMonth, 0);
});

test('releasing nothing is a no-op', () => {
  const reserved = checkQuota({}, 'c1', T0, 2, limits).usage;
  const after = releaseQuota(reserved, 'c1', T0, 0);
  assert.equal(after.globalDay, 2);
});
