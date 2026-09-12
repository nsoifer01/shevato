import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkQuota, DEFAULT_LIMITS, MONTHLY_BUDGET, resetAtFor, monthBucketOf,
} from '../lib/tp-assist-quota.mjs';

const HOUR = 3600000;
const DAY = 86400000;
// A fixed "now" that sits cleanly inside one hour bucket and one day bucket.
const T0 = 100 * DAY + 5 * HOUR; // day bucket 100, some hour within it

// Run n allowed calls in a row for one client, threading usage through, and
// return the final usage blob. Asserts every call is allowed.
function drain(n, clientId, now, usage = {}) {
  for (let i = 0; i < n; i++) {
    const r = checkQuota(usage, clientId, now);
    assert.equal(r.allowed, true, `call ${i + 1} should be allowed`);
    usage = r.usage;
  }
  return usage;
}

test('allows a call under every limit and reserves the slot', () => {
  const r = checkQuota({}, 'alice', T0);
  assert.equal(r.allowed, true);
  assert.equal(r.usage.clientHour.alice, 1);
  assert.equal(r.usage.clientDay.alice, 1);
  assert.equal(r.usage.globalDay, 1);
});

test('rejects exactly at the per-client hourly limit', () => {
  const usage = drain(DEFAULT_LIMITS.perClientHour, 'alice', T0);
  assert.equal(usage.clientHour.alice, DEFAULT_LIMITS.perClientHour);
  const r = checkQuota(usage, 'alice', T0);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'client_hour');
  // a rejection must not increment any counter
  assert.equal(r.usage.clientHour.alice, DEFAULT_LIMITS.perClientHour);
  assert.equal(r.usage.globalDay, DEFAULT_LIMITS.perClientHour);
});

test('rejects exactly at the per-client daily limit (across hours)', () => {
  let usage = {};
  let now = T0;
  // Spread perClientDay calls over enough hours to never hit the hourly cap.
  for (let i = 0; i < DEFAULT_LIMITS.perClientDay; i++) {
    if (i > 0 && i % DEFAULT_LIMITS.perClientHour === 0) now += HOUR; // new hour bucket
    const r = checkQuota(usage, 'alice', now);
    assert.equal(r.allowed, true, `spread call ${i + 1} allowed`);
    usage = r.usage;
  }
  assert.equal(usage.clientDay.alice, DEFAULT_LIMITS.perClientDay);
  now += HOUR; // fresh hour so only the daily cap can bite
  const r = checkQuota(usage, 'alice', now);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'client_day');
});

test('rejects exactly at the global daily limit before any client cap', () => {
  let usage = {};
  let now = T0;
  let served = 0;
  // Many distinct clients, one hour each, until the global cap is reached.
  // perClientHour caps each client, so rotate clients and hours.
  let clientN = 0;
  while (served < DEFAULT_LIMITS.globalDay) {
    const client = 'c' + clientN;
    const room = Math.min(DEFAULT_LIMITS.perClientHour, DEFAULT_LIMITS.globalDay - served);
    for (let i = 0; i < room; i++) {
      const r = checkQuota(usage, client, now);
      assert.equal(r.allowed, true, `global fill served ${served + 1}`);
      usage = r.usage;
      served++;
    }
    clientN++;
  }
  assert.equal(usage.globalDay, DEFAULT_LIMITS.globalDay);
  // A brand-new client (well under its own caps) is still rejected globally.
  const r = checkQuota(usage, 'fresh-client', now);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'global_day');
});

test('hourly counter rolls over into the next hour bucket', () => {
  const usage = drain(DEFAULT_LIMITS.perClientHour, 'alice', T0);
  const blocked = checkQuota(usage, 'alice', T0);
  assert.equal(blocked.allowed, false);
  // One hour later the hourly window resets, but the daily counter survives.
  const next = checkQuota(usage, 'alice', T0 + HOUR);
  assert.equal(next.allowed, true);
  assert.equal(next.usage.clientHour.alice, 1);
  assert.equal(next.usage.clientDay.alice, DEFAULT_LIMITS.perClientHour + 1);
});

test('daily counters roll over into the next day bucket', () => {
  let usage = drain(DEFAULT_LIMITS.perClientHour, 'alice', T0);
  usage = drain(DEFAULT_LIMITS.perClientHour, 'bob', T0, usage);
  assert.equal(usage.globalDay, 2 * DEFAULT_LIMITS.perClientHour);
  // Next day: client-day, hour, and global counters all reset.
  const r = checkQuota(usage, 'alice', T0 + DAY);
  assert.equal(r.allowed, true);
  assert.equal(r.usage.clientHour.alice, 1);
  assert.equal(r.usage.clientDay.alice, 1);
  assert.equal(r.usage.globalDay, 1);
});

test('prunes stale buckets so the usage blob does not grow unbounded', () => {
  // Yesterday's blob carrying many client entries.
  const stale = {
    hourBucket: Math.floor((T0 - DAY) / HOUR),
    dayBucket: Math.floor((T0 - DAY) / DAY),
    clientHour: { a: 3, b: 4, c: 5 },
    clientDay: { a: 9, b: 9, c: 9, d: 9 },
    globalDay: 200,
  };
  const r = checkQuota(stale, 'newcomer', T0);
  assert.equal(r.allowed, true);
  // Yesterday's maps are dropped; only today's newcomer remains.
  assert.deepEqual(Object.keys(r.usage.clientHour), ['newcomer']);
  assert.deepEqual(Object.keys(r.usage.clientDay), ['newcomer']);
  assert.equal(r.usage.globalDay, 1);
  assert.equal(r.usage.hourBucket, Math.floor(T0 / HOUR));
  assert.equal(r.usage.dayBucket, Math.floor(T0 / DAY));
});

test('prunes the hour map but keeps the day map within the same day', () => {
  const usage = drain(3, 'alice', T0);
  // Same day, later hour: hourly map resets, daily map persists.
  const r = checkQuota(usage, 'alice', T0 + HOUR);
  assert.equal(r.usage.clientHour.alice, 1);
  assert.equal(r.usage.clientDay.alice, 4);
  assert.equal(r.usage.globalDay, 4);
});

test('a clientId of "__proto__" is capped exactly like any other client', () => {
  // clientId is client-minted. On a plain-object counter map, "__proto__"
  // reads Object.prototype (truthy, so every >= cap compare coerces to false)
  // and its increment silently no-ops, so that one name never hit a per-client
  // cap at all. The maps are null-prototype now; this pins it.
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty']) {
    let usage = {};
    for (let i = 0; i < DEFAULT_LIMITS.perClientHour; i++) {
      const r = checkQuota(usage, id, T0);
      assert.equal(r.allowed, true, `${id} call ${i + 1} allowed`);
      usage = r.usage;
    }
    const over = checkQuota(usage, id, T0);
    assert.equal(over.allowed, false, `${id} must hit the hourly cap`);
    assert.equal(over.scope, 'client_hour');
  }
  // and the poisoned key must not leak onto other clients' reads
  const one = checkQuota({}, '__proto__', T0).usage;
  assert.equal(checkQuota(one, 'innocent', T0).usage.clientHour.innocent, 1);
});

// ------------------------------------------------------- the monthly cap ----
//
// WHY A MONTH BUCKET EXISTS HERE. An hour cap and a day cap cannot bound a
// month: 400 a day is 12,000 a month, every one of them a billed Gemini turn if
// the key's Cloud project has billing enabled. tp-places grew exactly this
// dimension for exactly this reason (MONTHLY_BUDGET / billedMonth there), and
// these pin the same property for the assistant.

test('the monthly budget is what actually bounds a month, not 30 x globalDay', () => {
  assert.ok(MONTHLY_BUDGET < 30 * DEFAULT_LIMITS.globalDay,
    'a month of full days must not be reachable, or the month cap says nothing');
  assert.ok(MONTHLY_BUDGET > DEFAULT_LIMITS.globalDay,
    'but one heavy day must never exhaust the month on its own');
});

test('rejects at the monthly budget even with every other bucket fresh', () => {
  // A fresh hour, a fresh day, a brand-new client: only the month can refuse.
  const spent = {
    monthBucket: monthBucketOf(T0),
    globalMonth: MONTHLY_BUDGET,
  };
  const r = checkQuota(spent, 'fresh-client', T0);
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'global_month');
  assert.equal(r.usage.globalMonth, MONTHLY_BUDGET, 'a rejection moves nothing');
});

test('the month counter survives a day rollover, which is the whole point', () => {
  let usage = drain(DEFAULT_LIMITS.perClientHour, 'alice', T0);
  assert.equal(usage.globalMonth, DEFAULT_LIMITS.perClientHour);
  const nextDay = checkQuota(usage, 'alice', T0 + DAY);
  assert.equal(nextDay.usage.globalDay, 1, 'the day reset');
  assert.equal(nextDay.usage.globalMonth, DEFAULT_LIMITS.perClientHour + 1, 'the month did not');
});

test('the month counter resets when the billing month turns', () => {
  const inJan = Date.parse('2027-01-20T12:00:00Z');
  const inFeb = Date.parse('2027-02-20T12:00:00Z');
  const spent = { monthBucket: monthBucketOf(inJan), globalMonth: MONTHLY_BUDGET };
  assert.equal(checkQuota(spent, 'alice', inJan).allowed, false);
  const feb = checkQuota(spent, 'alice', inFeb);
  assert.equal(feb.allowed, true);
  assert.equal(feb.usage.globalMonth, 1, 'January is gone, not carried');
});

test('the month boundary is never EARLIER than a provider month, in either convention', () => {
  // The reset is shifted 8 hours after UTC, so it lands at 08:00Z on the 1st:
  // aligned with midnight Pacific in winter, an hour late in summer, and late
  // against a plain UTC month. Late is the only safe direction - resetting
  // early would hand out a fresh budget while the provider was still counting
  // the old month.
  const lastSecondUtc = Date.parse('2027-03-01T00:00:00Z');   // UTC says March
  const justBeforeShift = Date.parse('2027-03-01T07:59:59Z');
  const afterShift = Date.parse('2027-03-01T08:00:01Z');
  assert.equal(monthBucketOf(lastSecondUtc), monthBucketOf(justBeforeShift),
    'still counting February after the UTC month turned');
  assert.notEqual(monthBucketOf(justBeforeShift), monthBucketOf(afterShift));
});

test('resetAtFor names the edge each bucket refills on, including the month', () => {
  assert.equal(resetAtFor('client_hour', T0), (Math.floor(T0 / HOUR) + 1) * HOUR);
  assert.equal(resetAtFor('network_hour', T0), (Math.floor(T0 / HOUR) + 1) * HOUR);
  for (const scope of ['client_day', 'network_day', 'global_day']) {
    assert.equal(resetAtFor(scope, T0), (Math.floor(T0 / DAY) + 1) * DAY, scope);
  }
  // The month reset is the SHIFTED boundary, so what is promised is what the
  // counter actually honours.
  const jan = Date.parse('2027-01-20T12:00:00Z');
  assert.equal(resetAtFor('global_month', jan), Date.parse('2027-02-01T08:00:00Z'));
  // Contention clears in seconds; it is not a bucket edge at all.
  assert.ok(resetAtFor('contention', T0) - T0 <= 5000);
  assert.ok(resetAtFor('whatever', T0) > T0);
});
