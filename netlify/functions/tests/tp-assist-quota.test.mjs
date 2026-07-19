import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuota, DEFAULT_LIMITS } from '../lib/tp-assist-quota.mjs';

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
