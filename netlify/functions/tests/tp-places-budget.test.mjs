import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateUsage } from '../lib/tp-places-usage.mjs';
import {
  checkQuota, releaseQuota, budgetStatus, resetAtFor,
  MONTHLY_BUDGET, DEFAULT_LIMITS, OWNER_LIMITS,
} from '../lib/tp-places-quota.mjs';

// THE MONTHLY BUDGET: the one guard between this app and a Google invoice.
//
// Google gives 1,000 complimentary Place Details Enterprise calls per calendar
// month per project. Before this, the public pool (1,500) and the owner pool
// (3,000) were independent, so between them they could authorise 4,500 calls
// against ONE 1,000-call allowance - which is how August 2026 reached 2,915
// billed calls and $38.30 of usage (absorbed by a promotional credit that
// expires 2026-10-18). These tests pin the guard that makes that impossible.

const T = Date.UTC(2026, 7, 17, 12, 0, 0);   // mid-August, mid-day, mid-hour

// Big per-tier shape limits so these tests only ever exercise the shared
// budget; the hour/day caps have their own suite.
const wide = { perClientHour: 1e6, perClientDay: 1e6, globalDay: 1e6, globalMonth: 1e6 };

// ---------- the budget binds, for everyone ----------

test('a lookup under the budget is allowed and moves the shared counter', () => {
  const q = checkQuota({}, 'c1', T, 5, wide);
  assert.equal(q.allowed, true);
  assert.equal(q.granted, 5);
  assert.equal(q.usage.billedMonth, 5, 'the shared counter is what tracks the bill');
});

test('at the budget the request is refused BEFORE Google is ever called', () => {
  // checkQuota is pure math run inside the reservation, ahead of any upstream
  // call, which is the whole point: the guard cannot depend on Google telling
  // us afterwards, because billing lags by about a day.
  const spent = { monthBucket: monthOf(T), billedMonth: MONTHLY_BUDGET };
  const q = checkQuota(spent, 'c1', T, 1, wide);
  assert.equal(q.allowed, false);
  assert.equal(q.scope, 'free_month');
  assert.equal(q.granted, 0);
});

test('a partial grant stops exactly at the budget, never one call past it', () => {
  const spent = { monthBucket: monthOf(T), billedMonth: MONTHLY_BUDGET - 3 };
  const q = checkQuota(spent, 'c1', T, 10, wide);
  assert.equal(q.granted, 3, 'only the three remaining calls are authorised');
  assert.equal(q.usage.billedMonth, MONTHLY_BUDGET);
});

test('owner traffic alone cannot exceed the shared budget', () => {
  let u = {};
  for (let i = 0; i < 40; i++) {
    u = checkQuota(u, 'owner', T + i * 86400000, 1e6, OWNER_LIMITS, 'owner').usage;
  }
  assert.ok(u.billedMonth <= MONTHLY_BUDGET, `owner reached ${u.billedMonth}`);
});

test('public traffic alone cannot exceed the shared budget', () => {
  let u = {};
  for (let i = 0; i < 200; i++) {
    u = checkQuota(u, 'visitor-' + i, T + i * 3600000, 1e6, DEFAULT_LIMITS, 'public').usage;
  }
  assert.ok(u.billedMonth <= MONTHLY_BUDGET, `public reached ${u.billedMonth}`);
});

test('owner and public COMBINED cannot exceed the shared budget', () => {
  // The August 2026 loophole in one test: two tiers, two pools, one Google
  // allowance. Alternate them and confirm the total is what is capped.
  let u = {};
  for (let i = 0; i < 300; i++) {
    const owner = i % 2 === 0;
    u = checkQuota(u, owner ? 'owner' : 'visitor-' + i, T + i * 3600000, 20,
      owner ? OWNER_LIMITS : DEFAULT_LIMITS, owner ? 'owner' : 'public').usage;
  }
  assert.ok(u.billedMonth <= MONTHLY_BUDGET, `combined reached ${u.billedMonth}`);
  assert.equal(u.billedMonth, u.ownerMonth + u.globalMonth,
    'the shared counter is exactly the sum of the two tiers');
});

test('the owner cannot starve visitors out of the whole month', () => {
  let u = {};
  for (let i = 0; i < 40; i++) u = checkQuota(u, 'owner', T + i * 86400000, 1e6, OWNER_LIMITS, 'owner').usage;
  const left = MONTHLY_BUDGET - u.billedMonth;
  assert.ok(left >= 200, `only ${left} left for visitors after a maximal owner month`);
  const visitor = checkQuota(u, 'visitor', T, 1, DEFAULT_LIMITS, 'public');
  assert.equal(visitor.allowed, true, 'a visitor can still get a rating');
});

// ---------- release ----------

test('releasing unspent reservations gives the budget back', () => {
  const q = checkQuota({}, 'c1', T, 12, wide);
  assert.equal(q.usage.billedMonth, 12);
  const after = releaseQuota(q.usage, 'c1', T, 9, 'public');
  assert.equal(after.billedMonth, 3, 'only what was actually billed stays counted');
});

test('a double release cannot mint free calls', () => {
  const q = checkQuota({}, 'c1', T, 5, wide);
  let u = releaseQuota(q.usage, 'c1', T, 5, 'public');
  u = releaseQuota(u, 'c1', T, 5, 'public');
  assert.equal(u.billedMonth, 0, 'never below zero');
});

// ---------- month rollover and persistence ----------

const monthOf = (t) => new Date(t - 8 * 3600000).toISOString().slice(0, 7);

test('the budget resets on the billing month boundary, and not before', () => {
  const exhausted = { monthBucket: monthOf(T), billedMonth: MONTHLY_BUDGET };
  // Late in the month: still refused.
  assert.equal(checkQuota(exhausted, 'c', Date.UTC(2026, 7, 31, 23, 0, 0), 1, wide).allowed, false);
  // UTC midnight on the 1st is NOT the boundary - Google is still counting.
  assert.equal(checkQuota(exhausted, 'c', Date.UTC(2026, 8, 1, 0, 30, 0), 1, wide).allowed, false);
  // 08:00Z on the 1st is.
  const fresh = checkQuota(exhausted, 'c', Date.UTC(2026, 8, 1, 8, 0, 0), 1, wide);
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.usage.billedMonth, 1);
});

test('usage survives a restart because it lives in the blob, not in memory', async () => {
  // The counters are read from and written to the shared store on every
  // request, so "restart" is simply a second process reading the same blob.
  const store = memStore();
  const spend = async (n) => updateUsage(store, 'usage', (u) => {
    const q = checkQuota(u, 'c', T, n, wide);
    return { write: q.allowed ? q.usage : null, result: q };
  });
  await spend(100);
  await spend(100);
  assert.equal(store.peek('usage').billedMonth, 200);
  // A "redeploy": brand new code path, same store, no in-process state.
  await spend(50);
  assert.equal(store.peek('usage').billedMonth, 250, 'a restart does not reset the month');
});

// ---------- concurrency ----------

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
    peek(key) { const e = map.get(key); return e ? JSON.parse(e.json) : null; },
  };
  return store;
}

// Holds every reader until n have arrived, so all n read the SAME counters and
// the SAME etag before any of them writes: the exact interleaving that a plain
// read-modify-write would lose money on.
function barrier(n) {
  let arrived = 0, release;
  const open = new Promise((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    else await open;
  };
}

test('concurrent requests at the edge of the budget cannot overshoot it', async () => {
  // 50 simultaneous batches of 12 arriving while the counter sits 10 below the
  // ceiling. Every one of them reads "10 left" before any of them writes.
  const store = memStore();
  const start = MONTHLY_BUDGET - 10;
  await store.setJSON('usage', { monthBucket: monthOf(T), billedMonth: start }, { onlyIfNew: true });
  store.gate = barrier(50);

  const runs = Array.from({ length: 50 }, (_, i) => updateUsage(store, 'usage', (u) => {
    const q = checkQuota(u, 'client-' + i, T, 12, wide);
    return { write: q.allowed ? q.usage : null, result: q };
  }));
  const settled = await Promise.all(runs);

  const final = store.peek('usage');
  assert.ok(final.billedMonth <= MONTHLY_BUDGET,
    `billedMonth ${final.billedMonth} must never exceed ${MONTHLY_BUDGET}`);
  const granted = settled.reduce((n, r) => n + ((r.ok && r.result && r.result.granted) || 0), 0);
  assert.ok(granted <= 10, `${granted} calls authorised but only 10 were left`);
  // And the ones that lost the race were refused, not silently served.
  assert.ok(settled.some((r) => !r.ok || !r.result.allowed), 'somebody was turned away');
});

test('concurrent owner and public requests share one ceiling', async () => {
  const store = memStore();
  await store.setJSON('usage', { monthBucket: monthOf(T), billedMonth: MONTHLY_BUDGET - 6 }, { onlyIfNew: true });
  store.gate = barrier(20);
  const runs = Array.from({ length: 20 }, (_, i) => {
    const owner = i % 2 === 0;
    return updateUsage(store, 'usage', (u) => {
      const q = checkQuota(u, 'c' + i, T, 5, owner ? OWNER_LIMITS : DEFAULT_LIMITS, owner ? 'owner' : 'public');
      return { write: q.allowed ? q.usage : null, result: q };
    });
  });
  await Promise.all(runs);
  assert.ok(store.peek('usage').billedMonth <= MONTHLY_BUDGET);
});

// ---------- observability ----------

test('budgetStatus reports the month without leaking anything sensitive', () => {
  const q = checkQuota({}, 'some-client-id', T, 40, OWNER_LIMITS, 'owner');
  const s = budgetStatus(q.usage, T);
  assert.equal(s.month, monthOf(T));
  assert.equal(s.monthlyBudget, MONTHLY_BUDGET);
  assert.equal(s.billedMonth, 40);
  assert.equal(s.remaining, MONTHLY_BUDGET - 40);
  assert.equal(s.exhausted, false);
  assert.equal(s.owner.month, 40);
  assert.equal(s.public.month, 0);
  assert.equal(s.resetsAt, new Date(resetAtFor('free_month', T)).toISOString());
  assert.equal(s.clientsSeenThisDay, 1);
  // No key, no token, no client identifiers anywhere in the payload.
  const json = JSON.stringify(s);
  assert.ok(!json.includes('some-client-id'), 'client ids do not travel');
  assert.ok(!/key|token|secret/i.test(json), 'nothing key-shaped in the status: ' + json);
});

test('budgetStatus reports a stale month as spent-nothing, not last month total', () => {
  const stale = { monthBucket: '2026-01', billedMonth: 900, ownerMonth: 900 };
  const s = budgetStatus(stale, T);
  assert.equal(s.billedMonth, 0);
  assert.equal(s.remaining, MONTHLY_BUDGET);
  assert.equal(s.exhausted, false);
});

test('budgetStatus flags exhaustion, which is what the owner wants to see', () => {
  const s = budgetStatus({ monthBucket: monthOf(T), billedMonth: MONTHLY_BUDGET }, T);
  assert.equal(s.exhausted, true);
  assert.equal(s.remaining, 0);
});
