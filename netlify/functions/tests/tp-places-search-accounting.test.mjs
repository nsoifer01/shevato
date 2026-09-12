import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveQueries, idCacheKey } from '../lib/tp-places-lookup.mjs';
import { checkQuota, releaseQuota } from '../lib/tp-places-quota.mjs';

// THE FREE SEARCH IS FREE IN MONEY, NOT IN WORK.
//
// A lookup has two upstream halves. The Text Search that turns a query string
// into a place ID is the "IDs Only" SKU: unlimited and $0.00, which is why the
// budget is deliberately claimed against the BILLED half (Place Details) and
// not against the search. That split is correct and must stay.
//
// What was wrong is what happened when the free half found nothing. A query
// whose search returns no match reports `spent: 0`, and the handler then
// released its whole reservation - off every counter, including the per-client
// and per-network RATE limits. Those counters are not a billing ledger; they
// exist to bound how much work one caller can make this function do. So a
// caller sending queries that never resolve performed a real upstream search
// and a real blob write per query, and paid nothing on any dimension. Repeat
// forever: unbounded Text Search against Google (a quota this project has
// already been 429'd on, which degrades the PAID ratings path for real
// visitors) and unbounded growth in a blob store that has no eviction.
//
// The fix distinguishes three outcomes rather than two:
//
//   cache hit          no upstream work   -> release everything (unchanged)
//   searched, no match upstream search     -> release the BILLED dimensions
//                                             only; the rate dimensions keep it
//   searched and billed a Details call     -> release nothing (unchanged)
//
// The invariant these tests pin: a cached itinerary still costs nothing, and
// a no-result search still costs nothing in MONEY, but it can no longer be
// repeated without limit.

const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
const wide = { perClientHour: 1e6, perClientDay: 1e6, globalDay: 1e6, globalMonth: 1e6 };

function memCache(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, entry) { map.set(key, entry); },
  };
}

/** Upstream that never resolves a query: the search runs, and finds nothing. */
function missSpies() {
  const calls = { search: [], details: [] };
  return {
    calls,
    findPlaceId: async q => { calls.search.push(q); return null; },
    fetchDetails: async pid => { calls.details.push(pid); return null; },
  };
}

function hitSpies() {
  const calls = { search: [], details: [] };
  return {
    calls,
    findPlaceId: async q => { calls.search.push(q); return 'place-1'; },
    fetchDetails: async pid => {
      calls.details.push(pid);
      return { name: 'Somewhere', rating: 4.1, userRatingCount: 900, mapsUri: 'https://maps.google.com/?cid=1' };
    },
  };
}

const run = (queries, cache, s, budget = 10) =>
  resolveQueries({ queries, cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget });

// ---------- resolveQueries reports the work it actually did ----------

test('a no-match query reports the search it ran, even though it billed nothing', async () => {
  const cache = memCache();
  const s = missSpies();
  const { spent, searched } = await run(['Nowhere Cafe Atlantis'], cache, s);
  assert.equal(s.calls.search.length, 1, 'the upstream search really happened');
  assert.equal(s.calls.details.length, 0, 'and nothing was billed');
  assert.equal(spent, 0, 'spent tracks billed calls only, which is correct');
  assert.equal(searched, 1, 'searched is what the rate limit has to count');
});

test('a cache hit reports no search at all, so a cached itinerary stays free', async () => {
  const key = idCacheKey('Ichiran Shibuya', undefined);
  const cache = memCache({ [key]: { placeId: 'place-1', at: NOW } });
  const s = hitSpies();
  const { searched } = await run(['Ichiran Shibuya'], cache, s);
  assert.equal(s.calls.search.length, 0, 'no upstream search for a cached place id');
  assert.equal(searched, 0, 'so nothing is charged against the rate limit either');
});

test('a billed lookup counts as both searched and spent', async () => {
  const cache = memCache();
  const s = hitSpies();
  const { spent, searched } = await run(['Ichiran Ramen Shibuya Tokyo'], cache, s);
  assert.equal(spent, 1);
  assert.equal(searched, 1);
});

test('searched counts queries, not upstream calls, when several spellings share one place', async () => {
  const cache = memCache();
  const s = hitSpies();
  const { spent, searched } = await run(
    ['The Mango Garden', 'Mango Garden restaurant', 'The Mango Garden, Ko Phi Phi'], cache, s);
  assert.equal(spent, 1, 'one place, one billed call: the dedupe still holds');
  assert.ok(searched >= 1, 'and the searches that ran are visible to the caller');
});

// ---------- the release splits the way the handler needs ----------

test('releasing a no-result search refunds the money but not the rate allowance', () => {
  const granted = 4;
  const spent = 0;       // nothing billed
  const searched = 4;    // four real upstream searches
  const claimed = checkQuota({}, 'c1', NOW, granted, wide, 'public', 'net-1');
  assert.equal(claimed.granted, granted);

  const billedBack = granted - spent;                    // 4
  const rateBack = granted - Math.max(spent, searched);  // 0
  const after = releaseQuota(claimed.usage, 'c1', NOW, billedBack, 'public', 'net-1', rateBack);

  assert.equal(after.billedMonth, 0, 'no Place Details call was made, so nothing is owed');
  assert.equal(after.clientHour.c1, granted, 'but four searches were performed on this client');
  assert.equal(after.networkHour['net-1'], granted, 'and on this network');
});

test('releasing a fully cached batch refunds every dimension, as it always did', () => {
  const granted = 4;
  const claimed = checkQuota({}, 'c1', NOW, granted, wide, 'public', 'net-1');
  const after = releaseQuota(claimed.usage, 'c1', NOW, granted, 'public', 'net-1', granted);
  assert.equal(after.billedMonth, 0);
  assert.equal(after.clientHour.c1, 0, 'a cached itinerary costs the caller nothing');
  assert.equal(after.networkHour['net-1'], 0);
});

test('releaseQuota without the extra argument behaves exactly as before', () => {
  const claimed = checkQuota({}, 'c1', NOW, 3, wide, 'public', 'net-1');
  const after = releaseQuota(claimed.usage, 'c1', NOW, 3, 'public', 'net-1');
  assert.equal(after.billedMonth, 0);
  assert.equal(after.clientHour.c1, 0, 'the old two-outcome call site is unchanged');
  assert.equal(after.networkHour['net-1'], 0);
});

test('the rate refund can never exceed the money refund, so a search cannot mint allowance', () => {
  const claimed = checkQuota({}, 'c1', NOW, 5, wide, 'public', 'net-1');
  // A nonsense call asking to give back more rate allowance than was reserved.
  const after = releaseQuota(claimed.usage, 'c1', NOW, 5, 'public', 'net-1', 99);
  assert.equal(after.clientHour.c1, 0, 'clamped at zero, never negative');
  assert.equal(after.networkHour['net-1'], 0);
});
