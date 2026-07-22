import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuota, releaseQuota, DEFAULT_LIMITS, OWNER_LIMITS } from '../lib/tp-places-quota.mjs';
import { clampBody, ownerTokenMatches } from '../tp-places.mjs';

// The owner tier: requests carrying the ownerToken secret are governed by
// OWNER_LIMITS and spend against separate owner buckets. Two properties are
// load-bearing and pinned here: the owner can never exhaust the PUBLIC
// allowance (visitors keep working however hard the owner plans), and the
// owner tier is still a HARD ceiling (a leaked token cannot run an unbounded
// bill).

const NOW = 1780000000000; // fixed instant so every call lands in one bucket
const DAY = Math.floor(NOW / 86400000);
const MONTH = new Date(NOW).toISOString().slice(0, 7);

// ---------- tier bucket separation ----------

test('owner spend lands in the owner buckets and leaves the public ones at zero', () => {
  const q = checkQuota({}, 'owner-browser', NOW, 5, OWNER_LIMITS, 'owner');
  assert.equal(q.allowed, true);
  assert.equal(q.usage.ownerDay, 5);
  assert.equal(q.usage.ownerMonth, 5);
  assert.equal(q.usage.globalDay, 0);
  assert.equal(q.usage.globalMonth, 0);
});

test('public spend leaves the owner buckets alone', () => {
  const q = checkQuota({}, 'visitor', NOW, 5);
  assert.equal(q.usage.globalDay, 5);
  assert.equal(q.usage.ownerDay, 0);
  assert.equal(q.usage.ownerMonth, 0);
});

test('a maxed-out owner cannot lock ordinary visitors out', () => {
  // The whole reason the buckets are split: the owner burning their entire
  // daily and monthly allowance must not move the public counters an inch.
  const usage = { dayBucket: DAY, monthBucket: MONTH, ownerDay: OWNER_LIMITS.globalDay, ownerMonth: OWNER_LIMITS.globalMonth };
  const visitor = checkQuota(usage, 'visitor', NOW, 5);
  assert.equal(visitor.allowed, true);
  assert.equal(visitor.granted, 5);
});

test('a maxed-out public pool does not throttle the owner', () => {
  const usage = { dayBucket: DAY, monthBucket: MONTH, globalDay: DEFAULT_LIMITS.globalDay, globalMonth: DEFAULT_LIMITS.globalMonth };
  const owner = checkQuota(usage, 'owner-browser', NOW, 5, OWNER_LIMITS, 'owner');
  assert.equal(owner.allowed, true);
  assert.equal(owner.granted, 5);
});

// ---------- the owner ceiling is hard ----------

test('the owner monthly cap is a hard ceiling, not a suggestion', () => {
  // A leaked token gets at most OWNER_LIMITS.globalMonth billed lookups a
  // month; past that, 429 like anyone else.
  const usage = { monthBucket: MONTH, ownerMonth: OWNER_LIMITS.globalMonth };
  const q = checkQuota(usage, 'thief', NOW, 1, OWNER_LIMITS, 'owner');
  assert.equal(q.allowed, false);
  assert.equal(q.scope, 'global_month');
});

test('owner limits are an order of magnitude up but still finite', () => {
  // 3,000/month = 1,000 free + 2,000 paid = $40 absolute worst case. If this
  // assertion starts failing because the numbers grew, reread that sentence
  // before merging.
  assert.deepEqual(OWNER_LIMITS, {
    perClientHour: 300,
    perClientDay: 600,
    globalDay: 1000,
    globalMonth: 3000,
  });
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    assert.ok(OWNER_LIMITS[k] > DEFAULT_LIMITS[k], k + ' is above the public limit');
    assert.ok(Number.isFinite(OWNER_LIMITS[k]), k + ' is finite');
  }
});

// ---------- release symmetry ----------

test('an owner release refunds the owner buckets, never the public ones', () => {
  const reserved = checkQuota({}, 'owner-browser', NOW, 5, OWNER_LIMITS, 'owner').usage;
  const after = releaseQuota(reserved, 'owner-browser', NOW, 3, 'owner');
  assert.equal(after.ownerDay, 2);
  assert.equal(after.ownerMonth, 2);
  assert.equal(after.globalDay, 0);
  assert.equal(after.clientHour['owner-browser'], 2);
});

test('owner buckets prune on rollover like the public ones', () => {
  const spent = checkQuota({}, 'owner-browser', NOW, 5, OWNER_LIMITS, 'owner').usage;
  const nextDay = checkQuota(spent, 'owner-browser', NOW + 86400000, 1, OWNER_LIMITS, 'owner');
  assert.equal(nextDay.usage.ownerDay, 1, 'day bucket reset');
  assert.equal(nextDay.usage.ownerMonth, 6, 'same calendar month keeps counting');
});

// ---------- token plumbing ----------

test('clampBody passes the owner token through, clamped, and defaults it empty', () => {
  const withToken = clampBody({ clientId: 'c1', queries: ['Ichiran Shibuya'], ownerToken: '  tok-123  ' });
  assert.equal(withToken.ownerToken, 'tok-123');
  const oversized = clampBody({ clientId: 'c1', queries: ['Ichiran Shibuya'], ownerToken: 'x'.repeat(5000) });
  assert.equal(oversized.ownerToken.length, 200);
  const absent = clampBody({ clientId: 'c1', queries: ['Ichiran Shibuya'] });
  assert.equal(absent.ok, true);
  assert.equal(absent.ownerToken, '');
  const junk = clampBody({ clientId: 'c1', queries: ['Ichiran Shibuya'], ownerToken: 42 });
  assert.equal(junk.ownerToken, '');
});

test('ownerTokenMatches accepts only an exact match against a configured token', () => {
  assert.equal(ownerTokenMatches('secret-abc', 'secret-abc'), true);
  assert.equal(ownerTokenMatches('secret-abd', 'secret-abc'), false);
  assert.equal(ownerTokenMatches('secret-ab', 'secret-abc'), false, 'prefix is not a match');
});

test('no configured token means no owner tier, whatever the request sends', () => {
  // An unset ownerToken in the config blob must be unmatchable, especially by
  // the obvious guesses.
  assert.equal(ownerTokenMatches('', ''), false);
  assert.equal(ownerTokenMatches('anything', ''), false);
  assert.equal(ownerTokenMatches('anything', undefined), false);
  assert.equal(ownerTokenMatches('', 'secret-abc'), false);
  assert.equal(ownerTokenMatches(undefined, 'secret-abc'), false);
});
