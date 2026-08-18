import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuota, releaseQuota, resetAtFor, DEFAULT_LIMITS } from '../lib/tp-places-quota.mjs';
import { quotaExceeded } from '../tp-places.mjs';

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
  // entries, not deepEqual on the object: the client maps are deliberately
  // null-prototype (see pruneUsage), which deepStrictEqual distinguishes
  assert.deepEqual({ ...r.usage.clientHour }, { c1: 1 });
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

test('the month counter resets on the billing boundary, never before Google', () => {
  // Google's complimentary allowance resets per calendar month on the BILLING
  // ACCOUNT's clock, not ours. Resetting earlier than Google would hand out a
  // fresh budget while Google was still counting the old month, which is the
  // one direction that can produce a bill, so the bucket rolls at 08:00Z on
  // the 1st (00:00 PST exactly, 01:00 PDT i.e. an hour late).
  let u = {};
  for (let i = 0; i < 12; i++) u = checkQuota(u, 'c' + i, Date.UTC(2026, 6, 31, 23, 0, 0), 1, monthOnly).usage;

  // Still July's budget at UTC midnight, which is where a naive UTC month
  // would have reset and started spending Google's already-used allowance.
  const utcMidnight = checkQuota(u, 'cx', Date.UTC(2026, 7, 1, 0, 30, 0), 1, monthOnly);
  assert.equal(utcMidnight.allowed, false, 'UTC midnight must NOT open a new month');
  assert.equal(utcMidnight.scope, 'global_month');

  // Just before the shifted boundary: still closed.
  assert.equal(checkQuota(u, 'cx', Date.UTC(2026, 7, 1, 7, 59, 0), 1, monthOnly).allowed, false);

  // At 08:00Z on the 1st the new month opens.
  const august = checkQuota(u, 'cx', Date.UTC(2026, 7, 1, 8, 0, 0), 1, monthOnly);
  assert.equal(august.allowed, true);
  assert.equal(august.usage.globalMonth, 1);
  assert.equal(august.usage.billedMonth, 1, 'the shared budget rolls with it');
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

test('a clientId of "__proto__" is capped exactly like any other client', () => {
  // Same hole as tp-assist-quota: on a plain-object map "__proto__" made the
  // remaining-room subtraction NaN (never shrinking a grant) and its increment
  // a no-op, so that clientId had no per-client cap. Null-prototype maps fix
  // it; this pins the cap and the release path both.
  let usage = {};
  const a = checkQuota(usage, '__proto__', T0, 5, limits);
  assert.equal(a.granted, 5);
  usage = a.usage;
  assert.equal(usage.clientHour['__proto__'], 5, 'the reservation actually lands');
  const b = checkQuota(usage, '__proto__', T0, 5, limits);
  assert.equal(b.granted, 0, 'the hourly cap of 5 binds for __proto__ too');
  assert.equal(b.allowed, false);
  const released = releaseQuota(usage, '__proto__', T0, 2);
  assert.equal(released.clientHour['__proto__'], 3, 'release moves the same counter');
});

// ---------- telling the client WHEN, not just NO ----------
//
// Every 429 in production on 2026-08-17 carried a scope and nothing else, so
// the browser guessed a flat hour for all of them: it wasted most of the next
// hour bucket after a client_hour rejection, and re-asked a monthly cap 24
// times a day. resetAtFor is the answer the client now gets told.

test('resetAtFor names the moment the rejecting bucket next refills', () => {
  // 10:59 UTC: an hour-scoped rejection clears in ONE minute, not in an hour.
  const t = Date.UTC(2026, 7, 17, 10, 59, 0);
  assert.equal(resetAtFor('client_hour', t), Date.UTC(2026, 7, 17, 11, 0, 0));
  assert.equal(resetAtFor('client_day', t), Date.UTC(2026, 7, 18, 0, 0, 0));
  assert.equal(resetAtFor('global_day', t), Date.UTC(2026, 7, 18, 0, 0, 0));
  // The month reset follows the SHIFTED boundary the counter actually honours.
  assert.equal(resetAtFor('global_month', t), Date.UTC(2026, 8, 1, 8, 0, 0));
  assert.equal(resetAtFor('free_month', t), Date.UTC(2026, 8, 1, 8, 0, 0));
  // Contention is the one genuinely transient scope and clears in seconds.
  assert.ok(resetAtFor('contention', t) - t <= 5000);
  // An unknown scope must still be finite and forward-looking.
  assert.ok(resetAtFor('mystery', t) > t);
});

test('resetAtFor is consistent with the buckets checkQuota actually uses', () => {
  const t = Date.UTC(2026, 7, 17, 10, 59, 0);
  // Spend the hour cap, then confirm the reported reset really does open it.
  const spent = checkQuota({}, 'c1', t, limits.perClientHour, limits).usage;
  const blocked = checkQuota(spent, 'c1', t, 1, limits);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'client_hour');
  const at = resetAtFor(blocked.scope, t);
  assert.equal(checkQuota(spent, 'c1', at, 1, limits).allowed, true,
    'the moment the response promised is the moment the bucket really opens');
});

test('a 429 carries the scope, the reset instant and a Retry-After header', async () => {
  const t = Date.UTC(2026, 7, 17, 10, 59, 0);
  const res = quotaExceeded('client_hour', t);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.scope, 'client_hour');
  assert.equal(body.resetAt, Date.UTC(2026, 7, 17, 11, 0, 0));
});

test('Retry-After is never zero or negative, whatever the scope', async () => {
  const t = Date.UTC(2026, 7, 17, 10, 59, 59, 900);
  for (const scope of ['client_hour', 'client_day', 'global_day', 'global_month', 'contention', '']) {
    const res = quotaExceeded(scope, t);
    const secs = Number(res.headers.get('Retry-After'));
    assert.ok(Number.isFinite(secs) && secs >= 1, `${scope} -> ${secs}`);
  }
});
