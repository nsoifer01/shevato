import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveQueries, idCacheKey, detailsCacheKey,
  PLACE_ID_TTL_MS, RATING_TTL_MS, NO_MATCH_TTL_MS,
} from '../lib/tp-places-lookup.mjs';

// Every billed call in this app is a Place Details Enterprise call, so these
// tests are as much about money as about correctness: a cache that misses is a
// charge, and a match that is wrong is a lie on a candidate card.

const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);

function memCache(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    reads: [],
    async get(key) { this.reads.push(key); return map.has(key) ? map.get(key) : null; },
    async set(key, entry) { map.set(key, entry); },
  };
}

function spies({ id = 'place-1', place = { name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 12043, mapsUri: 'https://maps.google.com/?cid=1' } } = {}) {
  const calls = { search: [], details: [] };
  return {
    calls,
    findPlaceId: async q => { calls.search.push(q); return id; },
    fetchDetails: async pid => { calls.details.push(pid); return place; },
  };
}

const run = (queries, cache, s, budget = 10) =>
  resolveQueries({ queries, cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget });

test('a cold query searches, fetches details and returns the rating', async () => {
  const cache = memCache();
  const s = spies();
  const { results, spent } = await run(['Ichiran Ramen Shibuya Tokyo'], cache, s);
  assert.deepEqual(results[0], {
    query: 'Ichiran Ramen Shibuya Tokyo',
    status: 'ok',
    name: 'Ichiran Shibuya',
    rating: 4.2,
    userRatingCount: 12043,
    mapsUri: 'https://maps.google.com/?cid=1',
    confidence: 1,
  });
  assert.equal(spent, 1, 'one billed Place Details call');
  assert.equal(s.calls.search.length, 1);
});

test('a category query never reaches Google at all', async () => {
  // This is both a cost guard and a correctness guard: Text Search would answer
  // "Convenience Store (Konbini) Breakfast" with one arbitrary shop.
  const cache = memCache();
  const s = spies();
  const { results, spent } = await run(['Convenience Store (Konbini) Breakfast'], cache, s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'generic_query');
  assert.equal(spent, 0);
  assert.equal(s.calls.search.length, 0);
  assert.equal(cache.reads.length, 0, 'not even a cache read is needed');
});

// Google's caching exception covers the place ID (indefinitely) and lat/long
// (30 days). It does NOT cover the name, rating or review count, so
// RATING_TTL_MS is 0 and a stored rating is stale the instant it is written.
// This test exists to keep it that way: if someone reintroduces a rating TTL to
// save calls, the reuse shows up here as a missing details call.
test('a rating is never reused from cache, however fresh, but the place ID is', async () => {
  const cache = memCache({
    [idCacheKey('Ichiran Ramen Shibuya Tokyo')]: { placeId: 'place-1', at: NOW - 1000 },
    [detailsCacheKey('place-1')]: { place: { name: 'Ichiran Shibuya', rating: 4.4, userRatingCount: 9, mapsUri: 'u' }, at: NOW },
  });
  const s = spies();
  const { results, spent } = await run(['Ichiran Ramen Shibuya Tokyo'], cache, s);
  assert.equal(results[0].rating, 4.2, 'the freshly fetched rating, not the cached 4.4');
  assert.equal(spent, 1, 'the details call is always billed');
  assert.equal(s.calls.search.length, 0, 'the cached place ID still saves the search');
  assert.equal(s.calls.details.length, 1);
});

test('a fresh place ID with a stale rating re-fetches details but not the search', async () => {
  // The place ID layer is the one Google lets us keep, so an expiring rating
  // must not throw away the free-search saving too.
  const cache = memCache({
    [idCacheKey('Ichiran Ramen Shibuya Tokyo')]: { placeId: 'place-1', at: NOW - 1000 },
    [detailsCacheKey('place-1')]: { place: { name: 'Ichiran Shibuya', rating: 4.4, userRatingCount: 9, mapsUri: 'u' }, at: NOW - RATING_TTL_MS - 1 },
  });
  const s = spies();
  const { results, spent } = await run(['Ichiran Ramen Shibuya Tokyo'], cache, s);
  assert.equal(results[0].rating, 4.2, 'the freshly fetched rating');
  assert.equal(spent, 1);
  assert.equal(s.calls.search.length, 0, 'the cached place ID was reused');
  assert.equal(s.calls.details.length, 1);
});

test('an expired place ID is searched again', async () => {
  const cache = memCache({
    [idCacheKey('Ichiran Ramen Shibuya Tokyo')]: { placeId: 'old-place', at: NOW - PLACE_ID_TTL_MS - 1 },
  });
  const s = spies();
  await run(['Ichiran Ramen Shibuya Tokyo'], cache, s);
  assert.equal(s.calls.search.length, 1);
  assert.deepEqual(s.calls.details, ['place-1']);
});

test('a query Google cannot resolve is remembered as a no-match', async () => {
  const cache = memCache();
  const s = { calls: { search: [] }, findPlaceId: async q => { s.calls.search.push(q); return null; }, fetchDetails: async () => { throw new Error('must not be called'); } };
  const { results, spent } = await run(['Bar Mitzvah Place That Closed'], cache, s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'not_found');
  assert.equal(spent, 0, 'the free search found nothing, so nothing was billed');
  assert.ok(cache.map.has(idCacheKey('Bar Mitzvah Place That Closed')));
});

test('a cached no-match is honoured until it expires', async () => {
  const key = idCacheKey('Somewhere Nonexistent Venue');
  const warm = memCache({ [key]: { placeId: null, reason: 'not_found', at: NOW - 1000 } });
  const s = spies();
  const a = await run(['Somewhere Nonexistent Venue'], warm, s);
  assert.equal(a.results[0].reason, 'not_found');
  assert.equal(s.calls.search.length, 0);

  const stale = memCache({ [key]: { placeId: null, reason: 'not_found', at: NOW - NO_MATCH_TTL_MS - 1 } });
  await run(['Somewhere Nonexistent Venue'], stale, s);
  assert.equal(s.calls.search.length, 1, 'a new venue gets another chance after the TTL');
});

test('a place whose name the query does not account for is refused', async () => {
  // The failure this whole module exists to prevent: Text Search falls back to
  // a different restaurant and the traveller reads its 4.5 as a fact about the
  // one on the card.
  const cache = memCache();
  const s = spies({ place: { name: 'Gonpachi Nishi-Azabu', rating: 4.5, userRatingCount: 900, mapsUri: 'u' } });
  const { results } = await run(['Ichiran Ramen Shibuya Tokyo'], cache, s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'low_confidence');
  assert.equal(results[0].rating, undefined, 'no rating leaks out on a rejected match');
});

test('a matched place with no rating yet reports unrated, not zero stars', async () => {
  const cache = memCache();
  const s = spies({ place: { name: 'Ichiran Shibuya', rating: null, userRatingCount: 0, mapsUri: 'u' } });
  const { results } = await run(['Ichiran Shibuya'], cache, s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'unrated');
});

test('a cached place ID saves the search call but still spends on details', async () => {
  // Ratings can never come from cache, so both queries cost a details call and
  // a budget of 2 is the honest minimum here. What the place-ID cache still
  // buys is the search: only the uncached query pays for one.
  const cache = memCache({
    [idCacheKey('Ichiran Shibuya')]: { placeId: 'place-1', at: NOW },
    [detailsCacheKey('place-1')]: { place: { name: 'Ichiran Shibuya', rating: 4.4, userRatingCount: 9, mapsUri: 'u' }, at: NOW },
  });
  // Both queries name the same venue so the single shared spy place is a
  // correct answer for either one; the only difference between them is that
  // one has a cached place ID and the other does not.
  const s = spies();
  const { results, spent } = await run(['Ichiran Shibuya', 'Ichiran Ramen Shibuya Tokyo'], cache, s, 2);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].status, 'ok');
  assert.equal(spent, 2, 'every rating is billed, cached place ID or not');
  assert.equal(s.calls.search.length, 1, 'only the uncached query needed a search');
  assert.equal(s.calls.details.length, 2);
});

test('queries past the budget come back unavailable rather than wrong or missing', async () => {
  const cache = memCache();
  const s = spies();
  const { results, spent } = await run(['Ichiran Shibuya', 'Nabezo Shinjuku'], cache, s, 1);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].status, 'unavailable');
  assert.equal(results[1].reason, 'quota');
  assert.equal(spent, 1, 'the budget was never exceeded');
});

test('an upstream failure degrades to unavailable and is not cached', async () => {
  const cache = memCache();
  const s = { findPlaceId: async () => { throw new Error('boom'); }, fetchDetails: async () => null };
  const { results, spent } = await run(['Ichiran Shibuya'], cache, s);
  assert.equal(results[0].status, 'unavailable');
  assert.equal(results[0].reason, 'upstream');
  assert.equal(spent, 0);
  assert.equal(cache.map.size, 0, 'a transient error must not poison the cache for a month');
});

test('the cache key is the normalized query, so spelling noise shares one entry', async () => {
  assert.equal(idCacheKey('Ichiran (Shibuya)'), idCacheKey('ichiran shibuya'));
  assert.equal(idCacheKey('  Ichiran   Shibuya  '), idCacheKey('Ichiran Shibuya'));
});

test('the rating TTL stays inside a day, unlike the place ID TTL', () => {
  // Google Maps Platform ToS 3.2.3(b) permits caching only as the Service
  // Specific Terms allow, and 14.3 covers lat/lng alone; place IDs are
  // separately exempt. So ratings get a short request cache and IDs get a long
  // one, and nothing here may quietly flip that around.
  assert.ok(RATING_TTL_MS <= 86400000);
  assert.ok(PLACE_ID_TTL_MS > RATING_TTL_MS);
});
