// The daily prune of the FPL proxy's per-manager cache keys
// (netlify/functions/fpl-cache-prune.mjs): it deletes only stale per-manager
// copies and expired leases, never a shared key, the deadline meta or the
// quota counters, and it stops at its per-run cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pruneFplCache, PRUNE, config } from '../fpl-cache-prune.mjs';
import { cacheKey, leaseKey, DEADLINE_KEY } from '../lib/fpl-cache.mjs';
import { QUOTA_KEY } from '../lib/fpl-quota.mjs';

const NOW = Date.parse('2026-10-10T04:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400e3).toISOString();

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async delete(key) { map.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: 'x' })) };
    },
  };
}

test('stale per-manager copies and expired leases go; everything shared stays', async () => {
  const store = memoryStore({
    [cacheKey('entry/1/history')]: { fetchedAt: daysAgo(30), body: {} },
    [cacheKey('entry/1/event/3/picks')]: { fetchedAt: daysAgo(15), body: {} },
    [cacheKey('entry/2/history')]: { fetchedAt: daysAgo(2), body: {} },
    [cacheKey('bootstrap-static')]: { fetchedAt: daysAgo(400), body: {} },
    [cacheKey('fixtures')]: { fetchedAt: daysAgo(400), body: {} },
    [cacheKey('event/3/live')]: { fetchedAt: daysAgo(400), body: {} },
    [leaseKey(cacheKey('entry/1/history'))]: { owner: 'a', expiresAt: NOW - 2 * 3600e3 },
    [leaseKey(cacheKey('bootstrap-static'))]: { owner: 'b', expiresAt: NOW + 10e3 },
    [DEADLINE_KEY]: { nextDeadline: daysAgo(-1), lastDeadline: daysAgo(6), currentEvent: 5 },
    [QUOTA_KEY]: { hourBucket: 1, dayBucket: 1 },
  });
  const stats = await pruneFplCache(store, { now: NOW });
  assert.deepEqual([...store.map.keys()].sort(), [
    cacheKey('bootstrap-static'),
    cacheKey('entry/2/history'),
    cacheKey('event/3/live'),
    cacheKey('fixtures'),
    DEADLINE_KEY,
    leaseKey(cacheKey('bootstrap-static')),
    QUOTA_KEY,
  ].sort());
  assert.equal(stats.deleted, 3);
  assert.equal(stats.capped, false);
});

test('an unreadable or shapeless value is kept, never guessed at', async () => {
  const store = memoryStore({
    [cacheKey('entry/9/history')]: 'not an object',
    [cacheKey('entry/9/transfers')]: { body: {} },
  });
  const stats = await pruneFplCache(store, { now: NOW });
  assert.equal(store.map.size, 2);
  assert.equal(stats.deleted, 0);
});

test('a large backlog is cleared a capped batch a day, oldest keys first by name', async () => {
  const initial = {};
  for (let i = 0; i < 25; i++) initial[cacheKey(`entry/${1000 + i}/history`)] = { fetchedAt: daysAgo(60), body: {} };
  const store = memoryStore(initial);
  const first = await pruneFplCache(store, { now: NOW, limits: { ...PRUNE, maxDeletesPerRun: 10 } });
  assert.equal(first.deleted, 10);
  assert.equal(first.capped, true);
  assert.equal(store.map.size, 15);
  await pruneFplCache(store, { now: NOW, limits: { ...PRUNE, maxDeletesPerRun: 10 } });
  await pruneFplCache(store, { now: NOW, limits: { ...PRUNE, maxDeletesPerRun: 10 } });
  assert.equal(store.map.size, 0);
});

test('it is a daily Netlify scheduled function', () => {
  assert.match(config.schedule, /^\d+ \d+ \* \* \*$/);
});
