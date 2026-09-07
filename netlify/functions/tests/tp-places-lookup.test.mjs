import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveQueries, idCacheKey, detailsCacheKey,
  PLACE_ID_TTL_MS, RATING_TTL_MS, NO_MATCH_TTL_MS, REJECT_TTL_MS,
  JUDGE_VERSION, rejectionSignature, REJECT_SIGNATURES_MAX,
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
    id: 'Ichiran Ramen Shibuya Tokyo',
    query: 'Ichiran Ramen Shibuya Tokyo',
    status: 'ok',
    name: 'Ichiran Shibuya',
    rating: 4.2,
    userRatingCount: 12043,
    mapsUri: 'https://maps.google.com/?cid=1',
    // No itinerary context was supplied, so the wrong-branch gate had nothing
    // to check: `verified` is false and the confidence is capped below the
    // verified threshold rather than reported as a full 1.
    placeId: 'place-1',
    verified: false,
    areaBasis: 'none',
    confidence: 0.5,
  });
  assert.equal(spent, 1, 'one billed Place Details call');
  assert.equal(s.calls.search.length, 1);
  // The legal line (2026-07-20 review): name/rating payloads may never be
  // STORED, only the place ID. The store must therefore end this lookup
  // holding exactly the id entry and no 'pd:' details blob - the old write
  // persisted Google Maps content indefinitely with nothing ever reading it.
  assert.deepEqual([...cache.map.keys()], [idCacheKey('Ichiran Ramen Shibuya Tokyo')],
    'only the place ID is persisted, never the details payload');
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
  //
  // TWO DIFFERENT VENUES on purpose. They used to be two spellings of one, and
  // that made this test agree with a bug: two spellings resolve to ONE place
  // ID and must now cost ONE billed call (see the dedup tests below). What this
  // test is actually about is the search/details split, which needs two places.
  const cache = memCache({
    [idCacheKey('Ichiran Shibuya')]: { placeId: 'place-1', at: NOW },
    [detailsCacheKey('place-1')]: { place: { name: 'Ichiran Shibuya', rating: 4.4, userRatingCount: 9, mapsUri: 'u' }, at: NOW },
  });
  const calls = { search: [], details: [] };
  const s = {
    calls,
    findPlaceId: async q => { calls.search.push(q); return 'place-2'; },
    fetchDetails: async pid => {
      calls.details.push(pid);
      return pid === 'place-1'
        ? { name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 12043, mapsUri: 'https://maps.google.com/?cid=1' }
        : { name: 'Nabezo Shinjuku', rating: 4.0, userRatingCount: 800, mapsUri: 'https://maps.google.com/?cid=2' };
    },
  };
  const { results, spent } = await run(['Ichiran Shibuya', 'Nabezo Shinjuku'], cache, s, 2);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].status, 'ok');
  assert.equal(spent, 2, 'every rating is billed, cached place ID or not');
  assert.equal(s.calls.search.length, 1, 'only the uncached query needed a search');
  assert.equal(s.calls.details.length, 2);
});

test('queries past the budget come back unavailable rather than wrong or missing', async () => {
  // TWO DISTINCT PLACES, so the budget is what runs out. With one shared place
  // ID the second query would join the first's billed call for free and never
  // reach the budget at all - which is the dedup working, not this test's
  // subject.
  const cache = memCache();
  const s = {
    calls: { search: [], details: [] },
    findPlaceId: async q => (/Nabezo/.test(q) ? 'place-2' : 'place-1'),
    fetchDetails: async pid => ({
      name: pid === 'place-1' ? 'Ichiran Shibuya' : 'Nabezo Shinjuku',
      rating: 4.2, userRatingCount: 12043, mapsUri: 'https://maps.google.com/?cid=1',
    }),
  };
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

test('coordinates ride along on a confident match, rated or not', async () => {
  // `location` is an Essentials field on a request already billed at
  // Enterprise for the rating, so this costs nothing extra; it is what lets the
  // client show how far a venue is from the hotel without a second lookup.
  const s = spies({ place: { name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 10, mapsUri: 'u', lat: 35.6595, lon: 139.7005 } });
  const ok = (await run(['Ichiran Shibuya Tokyo'], memCache(), s)).results[0];
  assert.equal(ok.status, 'ok');
  assert.equal(ok.lat, 35.6595);
  assert.equal(ok.lon, 139.7005);

  // an unrated venue is still a real place with a real position
  const un = spies({ place: { name: 'Ichiran Shibuya', rating: null, userRatingCount: 0, mapsUri: 'u', lat: 35.6595, lon: 139.7005 } });
  const unrated = (await run(['Ichiran Shibuya Tokyo'], memCache(), un)).results[0];
  assert.equal(unrated.status, 'no_match');
  assert.equal(unrated.reason, 'unrated');
  assert.equal(unrated.lat, 35.6595);

  // a low-confidence hit is a DIFFERENT business: no rating, and no position
  const wrong = spies({ place: { name: 'Gonpachi Nishi-Azabu', rating: 4.5, userRatingCount: 900, mapsUri: 'u', lat: 35.66, lon: 139.72 } });
  const bad = (await run(['Ichiran Shibuya Tokyo'], memCache(), wrong)).results[0];
  assert.equal(bad.reason, 'low_confidence');
  assert.equal('lat' in bad, false);

  // and a place whose coordinates are absent or impossible simply travels without
  const junk = spies({ place: { name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 10, mapsUri: 'u', lat: 999, lon: 0 } });
  assert.equal('lat' in (await run(['Ichiran Shibuya Tokyo'], memCache(), junk)).results[0], false);
});

// ---------------------------------------------------------------------------
// THE CACHING CONTRACT (2026-09-06 round).
//
// Every billed call is a Place Details Enterprise call, so the questions below
// are money questions: which layer answers without paying, which one may not
// exist at all (ratings, by the terms), and which failures must never be paid
// for twice.
// ---------------------------------------------------------------------------

const TOKYO = { city: 'Tokyo', country: 'Japan', lat: 35.68, lon: 139.76 };
const HOKKAIDO = { latitude: 42.79, longitude: 141.66 };

// A spy whose search maps each query to whatever place ID the test says, so a
// batch can contain several spellings of one venue AND several real venues.
function router({ ids, places }) {
  const calls = { search: [], details: [] };
  return {
    calls,
    findPlaceId: async q => { calls.search.push(q); return ids[q] === undefined ? 'p-default' : ids[q]; },
    fetchDetails: async pid => { calls.details.push(pid); return places[pid] || null; },
  };
}

const RATED = {
  name: 'The Mango Garden', rating: 4.8, userRatingCount: 3770,
  mapsUri: 'https://maps.google.com/?cid=9', lat: 35.681, lon: 139.762,
};

test('a cache miss searches, fetches and leaves the place ID behind', async () => {
  const cache = memCache();
  const s = router({ ids: { 'The Mango Garden Tokyo': 'mango' }, places: { mango: RATED } });
  const { results, spent } = await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].rating, 4.8);
  assert.equal(results[0].userRatingCount, 3770);
  assert.equal(results[0].placeId, 'mango');
  assert.equal(spent, 1);
  const entry = cache.map.get(idCacheKey('The Mango Garden Tokyo', { city: 'Tokyo' }));
  assert.equal(entry.placeId, 'mango', 'the place ID is the one layer that persists');
  assert.equal('rating' in entry, false, 'a rating is never written to the store');
  assert.equal('name' in entry, false, 'nor a display name');
});

test('several spellings of one venue cost ONE billed call, not one each', async () => {
  // THE BUG THIS PINS (measured 2026-09-06): a day plan names the same venue in
  // more than one voice, the free ID search collapses them onto one place, and
  // every spelling used to buy its own $0.02 Place Details call.
  const cache = memCache();
  const s = router({
    ids: {
      'The Mango Garden': 'mango',
      'The Mango Garden, Tokyo': 'mango',
      'Mango Garden restaurant': 'mango',
    },
    places: { mango: RATED },
  });
  const { results, spent } = await resolveQueries({
    queries: [
      { q: 'The Mango Garden', id: 'k1', ...TOKYO },
      { q: 'The Mango Garden, Tokyo', id: 'k2', ...TOKYO },
      { q: 'Mango Garden restaurant', id: 'k3', ...TOKYO },
    ],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(s.calls.search.length, 3, 'the ID search is the free SKU, so each query still asks');
  assert.equal(s.calls.details.length, 1, 'ONE billed call for one place');
  assert.equal(spent, 1);
  // and every card still gets its own complete answer, keyed to its own id
  assert.deepEqual(results.map(r => r.id), ['k1', 'k2', 'k3']);
  for (const r of results) {
    assert.equal(r.status, 'ok');
    assert.equal(r.rating, 4.8);
    assert.equal(r.userRatingCount, 3770);
    assert.equal(r.placeId, 'mango');
  }
});

test('a shared billed call hands its budget slot back for a query that needs one', async () => {
  // The dedup must RELEASE, not merely skip: a joiner holding a slot it never
  // spent would starve the one real lookup left in a tight batch.
  const cache = memCache();
  const other = { name: 'Nabezo Shinjuku', rating: 4.1, userRatingCount: 900, mapsUri: 'https://maps.google.com/?cid=8' };
  const s = router({
    ids: { 'Mango Garden': 'mango', 'The Mango Garden': 'mango', 'Nabezo Shinjuku': 'nabezo' },
    places: { mango: RATED, nabezo: other },
  });
  const { results, spent } = await resolveQueries({
    queries: [
      { q: 'Mango Garden', id: 'k1', ...TOKYO },
      { q: 'The Mango Garden', id: 'k2', ...TOKYO },
      { q: 'Nabezo Shinjuku', id: 'k3', ...TOKYO },
    ],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 2,
  });
  assert.equal(spent, 2, 'two places, two calls');
  assert.equal(results.map(r => r.status).join(','), 'ok,ok,ok', 'nobody was starved by a slot nobody spent');
});

test('two different places never share a rating, however alike the queries', async () => {
  const cache = memCache();
  const a = { name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 12043, mapsUri: 'https://maps.google.com/?cid=1' };
  const b = { name: 'Ichiran Shinjuku', rating: 3.9, userRatingCount: 210, mapsUri: 'https://maps.google.com/?cid=2' };
  const s = router({ ids: { 'Ichiran Shibuya': 'p-a', 'Ichiran Shinjuku': 'p-b' }, places: { 'p-a': a, 'p-b': b } });
  const { results } = await resolveQueries({
    queries: [{ q: 'Ichiran Shibuya', id: 'k1', ...TOKYO }, { q: 'Ichiran Shinjuku', id: 'k2', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(results[0].placeId, 'p-a');
  assert.equal(results[0].rating, 4.2);
  assert.equal(results[0].userRatingCount, 12043);
  assert.equal(results[1].placeId, 'p-b');
  assert.equal(results[1].rating, 3.9);
  assert.equal(results[1].userRatingCount, 210);
});

test('a refused candidate is refused for free the next time, not re-bought', async () => {
  // THE BUG THIS PINS (measured 2026-09-06): the place-ID cache kept the
  // REJECTED id for thirty days, so every later request fetched Details for a
  // candidate we already knew we would refuse, paid the Enterprise SKU, and
  // answered `no_match` again.
  const cache = memCache();
  const flagship = { name: "ROYCE' Chocolate World", rating: 4.4, userRatingCount: 900, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  const s = router({ ids: {}, places: { 'p-default': flagship } });
  const q = [{ q: "Royce' Chocolate Tokyo Station", id: 'r1', ...TOKYO, radiusKm: 40 }];
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 5 };

  const first = await resolveQueries({ ...opts, queries: q, now: NOW });
  assert.equal(first.results[0].status, 'no_match');
  assert.equal(first.results[0].reason, 'wrong_area');
  assert.equal(first.spent, 1, 'the first look has to be paid for');

  const billedAfterFirst = s.calls.details.length;
  const again = await resolveQueries({ ...opts, queries: q, now: NOW + 3600000 });
  assert.equal(again.results[0].status, 'no_match');
  assert.equal(again.results[0].reason, 'wrong_area', 'the same honest answer');
  assert.equal(again.spent, 0, 'and this time it cost nothing');
  assert.equal(s.calls.details.length, billedAfterFirst, 'no second Place Details call');
});

test('a remembered refusal expires in a day, so a fix reaches the card', async () => {
  // A rejection is OUR verdict, and ours moves with the code (the Ko Phi Phi
  // anchor bug refused every correct venue in a region). It must not outlive a
  // deploy by a month, which is why it is not on the 30-day place-ID clock.
  const cache = memCache();
  const flagship = { name: "ROYCE' Chocolate World", rating: 4.4, userRatingCount: 900, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  const s = router({ ids: {}, places: { 'p-default': flagship } });
  const q = [{ q: "Royce' Chocolate Tokyo Station", id: 'r1', ...TOKYO, radiusKm: 40 }];
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 5 };

  await resolveQueries({ ...opts, queries: q, now: NOW });
  // one millisecond inside the window: still free
  const inside = await resolveQueries({ ...opts, queries: q, now: NOW + REJECT_TTL_MS - 1 });
  assert.equal(inside.spent, 0);
  // one millisecond past it: looked at again
  const outside = await resolveQueries({ ...opts, queries: q, now: NOW + REJECT_TTL_MS });
  assert.equal(outside.spent, 1, 'the verdict is re-earned once the window passes');
  assert.ok(REJECT_TTL_MS < PLACE_ID_TTL_MS, 'and it never outlives the place ID it is filed against');
});

test('a refusal is not replayed for a question it was never asked', async () => {
  // The cache key holds the query and a COARSE area. The gates also read the
  // meal slot, which the key does not, so a venue refused as the wrong KIND for
  // breakfast must not answer for a traveller who named no meal at all.
  const cache = memCache();
  const desk = {
    name: 'Maya Bay Tours', rating: 4.6, userRatingCount: 300, mapsUri: 'u',
    lat: 35.681, lon: 139.762, primaryType: 'travel_agency', types: ['travel_agency'],
  };
  const s = router({ ids: {}, places: { 'p-default': desk } });
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 9, now: NOW };

  const meal = await resolveQueries({ ...opts, queries: [{ q: 'Maya Bay', id: 'm1', ...TOKYO, meal: 'lunch' }] });
  assert.equal(meal.results[0].status, 'no_match');
  assert.equal(meal.results[0].reason, 'type_mismatch');

  // same query, same city, NO meal slot: a different question, so it is asked
  const plain = await resolveQueries({ ...opts, queries: [{ q: 'Maya Bay', id: 'm2', ...TOKYO }] });
  assert.equal(plain.spent, 1, 'the un-keyed input changed, so the verdict is not reused');
  // and the original question is still answered for free
  const repeat = await resolveQueries({ ...opts, queries: [{ q: 'Maya Bay', id: 'm1', ...TOKYO, meal: 'lunch' }] });
  assert.equal(repeat.spent, 0);
  assert.equal(repeat.results[0].reason, 'type_mismatch');
});

test('a remembered refusal does not renew the place ID it is filed against', async () => {
  // The 30-day ID TTL is what eventually re-resolves a venue that moved or
  // closed. Refreshing it on every refusal would pin the wrong answer in place
  // for as long as anyone kept asking.
  const cache = memCache();
  const flagship = { name: "ROYCE' Chocolate World", rating: 4.4, userRatingCount: 900, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  const s = router({ ids: {}, places: { 'p-default': flagship } });
  const q = [{ q: "Royce' Chocolate Tokyo Station", id: 'r1', ...TOKYO, radiusKm: 40 }];
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 5 };
  const key = idCacheKey("Royce' Chocolate Tokyo Station", { city: 'Tokyo' });

  await resolveQueries({ ...opts, queries: q, now: NOW });
  assert.equal(cache.map.get(key).at, NOW);
  // a day later the verdict is re-earned and rewritten...
  await resolveQueries({ ...opts, queries: q, now: NOW + REJECT_TTL_MS });
  assert.equal(cache.map.get(key).at, NOW, 'the place ID keeps its ORIGINAL stamp');
  assert.equal(cache.map.get(key).rejected[0].at, NOW + REJECT_TTL_MS, 'only the verdict is restamped');
});

test('a failed Place Details call is never remembered as a refusal', async () => {
  // Google being down is not a verdict about a venue. Caching it would turn a
  // five-minute outage into a day of blank cards.
  const cache = memCache();
  const s = {
    calls: { details: [] },
    findPlaceId: async () => 'mango',
    fetchDetails: async () => { throw new Error('503 from Google'); },
  };
  const { results, spent } = await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(results[0].status, 'unavailable', 'a failure is transient, never a no_match');
  assert.equal(results[0].reason, 'upstream');
  assert.equal('rating' in results[0], false, 'and NEVER a fabricated rating');
  assert.equal(spent, 1, 'Google may have billed it, so it is counted');
  const entry = cache.map.get(idCacheKey('The Mango Garden Tokyo', { city: 'Tokyo' }));
  assert.equal(entry.placeId, 'mango', 'the place ID it did resolve is kept');
  assert.equal('rejected' in entry, false, 'but no verdict was reached, so none is stored');
});

test('a partial Google response yields unrated, and keeps the identity with it', async () => {
  // A place with no star is a RESOLVED place: the row still deserves its
  // position and its link. What it must never get is a zero rating.
  const cache = memCache();
  const s = router({
    ids: { 'The Mango Garden Tokyo': 'mango' },
    places: { mango: { name: 'The Mango Garden', rating: null, userRatingCount: 0, mapsUri: 'u', lat: 35.681, lon: 139.762 } },
  });
  const { results } = await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'unrated');
  assert.equal(results[0].placeId, 'mango');
  assert.equal(results[0].lat, 35.681);
  assert.equal('rating' in results[0], false, 'absent, not zero');
  const entry = cache.map.get(idCacheKey('The Mango Garden Tokyo', { city: 'Tokyo' }));
  assert.equal('rejected' in entry, false, 'unrated is a resolution, not a refusal to remember');
});

test('a rating and its review count only ever travel together', async () => {
  const cache = memCache();
  const s = router({
    ids: { 'The Mango Garden Tokyo': 'mango' },
    places: { mango: { ...RATED, userRatingCount: 'not a number' } },
  });
  const { results } = await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].rating, 4.8);
  assert.equal(results[0].userRatingCount, 0, 'a junk count reads as none, never as another venue\'s');
  assert.equal(results[0].placeId, 'mango', 'and both stay attached to the record that verified them');
});

test('what reaches the store is a place ID and our own verdict, never Google content', async () => {
  // The field-by-field rule, re-derived from the live terms on 2026-09-06:
  // SST A.3 permits the place ID indefinitely, SST 14.3 permits lat/lng for 30
  // days, and Places SST 14 grants nothing else - while ToS 3.2.3(a)(iii) names
  // business names, addresses and user reviews outright. This test is the
  // runtime half of that rule: whatever else changes, these keys must not
  // appear in a stored entry.
  const cache = memCache();
  const rich = {
    name: 'The Mango Garden', rating: 4.8, userRatingCount: 3770,
    mapsUri: 'https://maps.google.com/?cid=9', lat: 35.681, lon: 139.762,
    address: '1 Chome, Chiyoda, Tokyo', addressComponents: [{ longText: 'Tokyo' }],
    types: ['restaurant'], primaryType: 'restaurant',
    hours: { always: false, periods: [], special: [] },
  };
  const s = router({ ids: { 'The Mango Garden Tokyo': 'mango' }, places: { mango: rich } });
  await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO, meal: 'dinner' }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  const banned = ['name', 'rating', 'userRatingCount', 'mapsUri', 'address',
    'addressComponents', 'hours', 'types', 'primaryType', 'lat', 'lon', 'place'];
  for (const [key, entry] of cache.map) {
    const text = JSON.stringify(entry);
    for (const field of banned) {
      assert.equal(field in entry, false, `${key} must not store ${field}`);
    }
    assert.equal(/Mango Garden|Chiyoda|4\.8|3770/.test(text), false,
      `${key} leaked Google Maps Content: ${text}`);
  }
});

test('changing a gate retires every remembered refusal', async () => {
  // This is what buys the seven-day window. A stored verdict is only honoured
  // while the logic that reached it is the logic still running, so a gate fix
  // reaches the traveller on deploy rather than a week later.
  const cache = memCache();
  const flagship = { name: "ROYCE' Chocolate World", rating: 4.4, userRatingCount: 900, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  const s = router({ ids: {}, places: { 'p-default': flagship } });
  const q = [{ q: "Royce' Chocolate Tokyo Station", id: 'r1', ...TOKYO, radiusKm: 40 }];
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 5 };

  await resolveQueries({ ...opts, queries: q, now: NOW });
  const key = idCacheKey("Royce' Chocolate Tokyo Station", { city: 'Tokyo' });
  const stored = cache.map.get(key).rejected[0];
  assert.ok(stored.sig.startsWith(JUDGE_VERSION + '|'), 'the verdict records which logic reached it');

  // the deploy that changes a gate: same query, same area, older signature
  cache.map.set(key, {
    ...cache.map.get(key),
    rejected: [{ ...stored, sig: stored.sig.replace(JUDGE_VERSION, 'j0') }],
  });
  const after = await resolveQueries({ ...opts, queries: q, now: NOW + 60000 });
  assert.equal(after.spent, 1, 'a verdict from superseded logic is re-earned, not replayed');
});

test('the signature separates every input the cache key does not carry', () => {
  const base = { city: 'Tokyo', point: { lat: 35.68, lon: 139.76 }, radiusKm: 150 };
  const sig = rejectionSignature(base, '');
  assert.notEqual(sig, rejectionSignature(base, 'breakfast'), 'the meal slot');
  assert.notEqual(sig, rejectionSignature({ ...base, point: { lat: 7.73, lon: 98.77 } }, ''), 'a re-anchored day');
  assert.notEqual(sig, rejectionSignature({ ...base, radiusKm: 40 }, ''), 'a different radius');
  // ...and holds steady for the jitter that must NOT cost a second lookup
  assert.equal(sig, rejectionSignature({ ...base, point: { lat: 35.6812, lon: 139.7643 } }, ''),
    'two hotels in one city are one question');
});

test('a remembered refusal never outlives the place ID it is filed against', () => {
  // After the ID TTL the query is searched again from scratch and may resolve
  // somewhere else entirely, so a verdict about the old candidate must already
  // have expired.
  assert.ok(REJECT_TTL_MS < PLACE_ID_TTL_MS);
  assert.equal(REJECT_TTL_MS, NO_MATCH_TTL_MS, 'a refusal and a no-match are the same kind of answer');
});

test('only THREE signatures are kept, so a cache entry cannot grow without bound', async () => {
  const cache = memCache();
  const desk = {
    name: 'Maya Bay Tours', rating: 4.6, userRatingCount: 300, mapsUri: 'u',
    lat: 35.681, lon: 139.762, primaryType: 'travel_agency', types: ['travel_agency'],
  };
  const s = router({ ids: {}, places: { 'p-default': desk } });
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 20, now: NOW };
  for (const meal of ['breakfast', 'brunch', 'lunch', 'dinner', 'drinks']) {
    await resolveQueries({ ...opts, queries: [{ q: 'Maya Bay', id: 'm', ...TOKYO, meal }] });
  }
  const entry = cache.map.get(idCacheKey('Maya Bay', { city: 'Tokyo' }));
  assert.equal(entry.rejected.length, REJECT_SIGNATURES_MAX);
  assert.equal(entry.rejected[0].sig, rejectionSignature({ city: 'Tokyo', point: { lat: 35.68, lon: 139.76 }, radiusKm: 150 }, 'drinks'),
    'newest first, so the question just asked is the one answered free');
});

test('an entry written before verdicts existed still works', async () => {
  // Production already holds `id:` blobs in the old { placeId, at } shape, and
  // the single-object form this shipped with. Neither may throw, and neither
  // may be re-bought for the sake of a schema.
  const cache = memCache();
  const rated = { name: 'The Mango Garden', rating: 4.8, userRatingCount: 3770, mapsUri: 'https://maps.google.com/?cid=9', lat: 35.681, lon: 139.762 };
  const s = router({ ids: {}, places: { mango: rated } });
  const key = idCacheKey('The Mango Garden Tokyo', { city: 'Tokyo' });
  cache.map.set(key, { placeId: 'mango', at: NOW });
  const old = await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(old.results[0].status, 'ok');
  assert.equal(old.results[0].rating, 4.8);

  // the single-object verdict form, honoured rather than discarded
  const sig = rejectionSignature({ city: 'Tokyo', point: { lat: 35.68, lon: 139.76 }, radiusKm: 150 }, '');
  cache.map.set(key, { placeId: 'mango', at: NOW, rejected: { reason: 'wrong_area', sig, at: NOW } });
  const legacy = await resolveQueries({
    queries: [{ q: 'The Mango Garden Tokyo', id: 'k1', ...TOKYO }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW + 1000, budget: 5,
  });
  assert.equal(legacy.spent, 0, 'the older shape is read, not re-bought');
  assert.equal(legacy.results[0].reason, 'wrong_area');
});

test('a verdict about one candidate never carries onto a different one', async () => {
  // After the place-ID TTL the query is searched afresh and may land somewhere
  // else entirely. A refusal of the OLD candidate is not evidence about the new
  // one, and must not veto it before anything has looked at it.
  const cache = memCache();
  const far = { name: 'Chain Cafe', rating: 4.4, userRatingCount: 90, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  const near = { name: 'Chain Cafe', rating: 4.5, userRatingCount: 120, mapsUri: 'https://maps.google.com/?cid=7', lat: 35.681, lon: 139.762 };
  let resolvesTo = 'far';
  const calls = { details: [] };
  const s = {
    findPlaceId: async () => resolvesTo,
    fetchDetails: async id => { calls.details.push(id); return id === 'far' ? far : near; },
  };
  const q = [{ q: 'Chain Cafe Marunouchi', id: 'c1', ...TOKYO, radiusKm: 40 }];
  const opts = { cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, budget: 5 };
  const key = idCacheKey('Chain Cafe Marunouchi', { city: 'Tokyo' });

  await resolveQueries({ ...opts, queries: q, now: NOW });
  assert.equal(cache.map.get(key).rejected.length, 1, 'the far branch was refused and remembered');

  // 30 days on, the ID is re-searched and the chain has opened nearby
  resolvesTo = 'near';
  const after = await resolveQueries({ ...opts, queries: q, now: NOW + PLACE_ID_TTL_MS });
  assert.equal(after.results[0].status, 'ok', 'the new candidate is judged, not vetoed unseen');
  assert.equal(after.results[0].placeId, 'near');
  assert.equal(cache.map.get(key).placeId, 'near');
  assert.equal('rejected' in cache.map.get(key), false, 'and the old verdict did not follow it');
});

test('when the second look is refused too, ITS id is the one kept', async () => {
  // The restricted retry is the better-posed question, so its candidate is the
  // one a later request should start from - otherwise the pair is re-bought
  // (original, then retry) every time the verdict expires.
  const cache = memCache();
  const far = { name: "Royce' Chocolate", rating: 4.4, userRatingCount: 900, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  const alsoWrong = { name: "Royce' Chocolate", rating: 4.2, userRatingCount: 50, mapsUri: 'u', lat: HOKKAIDO.latitude, lon: HOKKAIDO.longitude };
  let call = 0;
  const s = {
    findPlaceId: async () => (call++ === 0 ? 'first' : 'second'),
    fetchDetails: async id => (id === 'first' ? far : alsoWrong),
  };
  const { results, spent } = await resolveQueries({
    queries: [{ q: "Royce' Chocolate Tokyo Station", id: 'r1', ...TOKYO, radiusKm: 40 }],
    cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget: 5,
  });
  assert.equal(results[0].status, 'no_match');
  assert.equal(spent, 2, 'both looks were billed');
  const entry = cache.map.get(idCacheKey("Royce' Chocolate Tokyo Station", { city: 'Tokyo' }));
  assert.equal(entry.placeId, 'second', 'the refined candidate is canonical');
  assert.equal(entry.rejected.length, 1);
  assert.equal(entry.rejected[0].reason, 'wrong_area');
});

test('the query-to-place-ID mapping TTL costs nothing to shorten and nothing to lengthen', async () => {
  // The reason PLACE_ID_TTL_MS is a correctness dial and not a cost dial, kept
  // as a test because it is the argument that decides the number. A rating may
  // not be cached, so Place Details is billed on EVERY request; the mapping
  // only ever saves the free Essentials (IDs Only) search.
  const P = { name: 'Ichiran Shibuya', rating: 4.2, userRatingCount: 12043, mapsUri: 'https://maps.google.com/?cid=1', lat: 35.661, lon: 139.700 };
  const q = [{ q: 'Ichiran Shibuya', id: 'k1', ...TOKYO }];
  const measure = async (gap) => {
    const cache = memCache();
    let search = 0, billed = 0;
    const findPlaceId = async () => { search++; return 'p1'; };
    const fetchDetails = async () => { billed++; return P; };
    await resolveQueries({ queries: q, cache, findPlaceId, fetchDetails, now: NOW, budget: 5 });
    const s0 = search, b0 = billed;
    await resolveQueries({ queries: q, cache, findPlaceId, fetchDetails, now: NOW + gap, budget: 5 });
    return { search: search - s0, billed: billed - b0 };
  };
  const hot = await measure(3600000);
  const cold = await measure(PLACE_ID_TTL_MS + 1);
  assert.equal(hot.billed, 1, 'a hot mapping still pays for the rating');
  assert.equal(cold.billed, 1, 'and a cold one pays exactly the same');
  assert.equal(hot.search, 0);
  assert.equal(cold.search, 1, 'the only difference is the free search');
});
