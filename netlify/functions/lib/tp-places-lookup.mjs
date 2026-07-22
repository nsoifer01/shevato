// The tp-places resolution pipeline: query -> place ID -> rating payload, with
// the two caches in between. Kept out of the handler and given injected `cache`
// / `findPlaceId` / `fetchDetails` so node:test can drive every branch (hit,
// miss, no match, budget exhaustion, upstream failure) with no Blobs context
// and no billed calls.
//
// CACHING (Google Maps Platform terms, not a performance preference):
//   Places API policies, "Exceptions from caching restrictions": "the place ID
//   ... is exempt from the caching restrictions. You can therefore store place
//   ID values indefinitely." That is why the query -> place ID map is the layer
//   we lean on, and why it gets a long TTL.
//   Everything else is governed by Google Maps Platform Terms of Service
//   3.2.3(b) No Caching ("Customer will not cache Google Maps Content except as
//   expressly permitted under the Maps Service Specific Terms"), and Maps
//   Service Specific Terms 14.3 expressly permits only latitude/longitude, for
//   30 days. Ratings and display names are NOT covered, so the rating layer is
//   a deliberately short-lived request cache, not storage.
//   SET TO 0 (2026-07-20, legal review): 24 hours was a reading of the terms,
//   and 0 is the only reading that needs no interpretation. Ratings and display
//   names are now never reused across requests; the place-ID layer above still
//   absorbs the expensive half of the lookup, and the billed-call ceiling is
//   unchanged because the per-client and global quotas bound it, not this TTL.
export const PLACE_ID_TTL_MS = 30 * 86400000;
export const RATING_TTL_MS = 0;

// Cache the fact that a query resolves to nothing too, or every render of a
// day plan re-pays for the same failed search. Shorter than the place-ID TTL
// because a genuinely new venue should become findable within the week.
export const NO_MATCH_TTL_MS = 7 * 86400000;

import { isGenericQuery, matchConfidence, normalizeQuery } from './tp-places-match.mjs';

function fresh(entry, ttl, now) {
  return !!entry && typeof entry.at === 'number' && (now - entry.at) < ttl;
}

export function idCacheKey(query) {
  // The normalized form is the cache key, so "Ichiran (Shibuya)" and
  // "ichiran shibuya" share one entry and one billed lookup.
  return 'id:' + normalizeQuery(query).replace(/ /g, '+');
}

export function detailsCacheKey(placeId) {
  return 'pd:' + placeId;
}

// Resolve one query. Returns { result, spent } where spent is 1 when a billed
// Place Details call was made. `claim()` takes a slot from the batch budget and
// returns falsy when the budget is gone; it is called as late as possible so
// cache hits never consume one.
async function resolveOne(query, { cache, findPlaceId, fetchDetails, now, claim }) {
  // (1) Category, not a venue: never worth a call, never a correct answer.
  if (isGenericQuery(query)) {
    return { result: { query, status: 'no_match', reason: 'generic_query' }, spent: 0 };
  }

  // (2) Place ID: cached indefinitely-eligible content, refreshed monthly so a
  // closed or moved venue eventually re-resolves.
  const idKey = idCacheKey(query);
  const cachedId = await cache.get(idKey);
  let placeId = null;
  let searched = false;
  if (fresh(cachedId, cachedId && cachedId.placeId ? PLACE_ID_TTL_MS : NO_MATCH_TTL_MS, now)) {
    if (!cachedId.placeId) {
      return { result: { query, status: 'no_match', reason: cachedId.reason || 'not_found' }, spent: 0 };
    }
    placeId = cachedId.placeId;
  } else {
    searched = true;
  }

  // (3) Ratings: short-lived cache, checked before any spend.
  if (placeId) {
    const cachedDetails = await cache.get(detailsCacheKey(placeId));
    if (fresh(cachedDetails, RATING_TTL_MS, now)) {
      return { result: fromDetails(query, cachedDetails.place), spent: 0 };
    }
  }

  // (4) Everything past here costs money.
  if (!claim()) {
    return { result: { query, status: 'unavailable', reason: 'quota' }, spent: 0 };
  }

  if (searched) {
    // Text Search with an ID-only field mask is the "Text Search Essentials
    // (IDs Only)" SKU: unlimited, no charge. The billed step is (5).
    let found;
    try {
      found = await findPlaceId(query);
    } catch {
      return { result: { query, status: 'unavailable', reason: 'upstream' }, spent: 0 };
    }
    if (!found) {
      await cache.set(idKey, { placeId: null, reason: 'not_found', at: now });
      return { result: { query, status: 'no_match', reason: 'not_found' }, spent: 0 };
    }
    placeId = found;
    await cache.set(idKey, { placeId, at: now });
  }

  // (5) Place Details, Enterprise SKU. This is the $0.02.
  let place;
  try {
    place = await fetchDetails(placeId);
  } catch {
    return { result: { query, status: 'unavailable', reason: 'upstream' }, spent: 1 };
  }
  if (!place) {
    return { result: { query, status: 'unavailable', reason: 'upstream' }, spent: 1 };
  }
  await cache.set(detailsCacheKey(placeId), { place, at: now });
  return { result: fromDetails(query, place), spent: 1 };
}

// Shape the client-facing result and apply the post-filter. A place whose name
// the query does not account for is a DIFFERENT business that Text Search fell
// back to, and a confident-looking wrong rating is the failure mode this whole
// function exists to prevent.
function fromDetails(query, place) {
  const name = (place && place.name) || '';
  const { score, confident } = matchConfidence(query, name);
  if (!confident) return { query, status: 'no_match', reason: 'low_confidence' };
  if (typeof place.rating !== 'number') return { query, status: 'no_match', reason: 'unrated' };
  return {
    query,
    status: 'ok',
    name,
    rating: place.rating,
    userRatingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : 0,
    mapsUri: place.mapsUri || '',
    confidence: score,
  };
}

// Resolve a whole batch. Queries run in parallel (the batch is capped at 12 by
// the handler), sharing one billed budget: each query claims a slot only at the
// moment it is about to spend, so a batch can never exceed the quota reserved
// for it, and cache hits leave the budget untouched for the queries that need
// it. The claim counter is safe without locking because the decrement is
// synchronous on a single-threaded event loop.
export async function resolveQueries({ queries, cache, findPlaceId, fetchDetails, now, budget }) {
  let left = Math.max(0, budget);
  const claim = () => (left > 0 ? (left -= 1, true) : false);
  const settled = await Promise.all(queries.map(q =>
    resolveOne(q, { cache, findPlaceId, fetchDetails, now, claim })));

  // The caller reserved `budget` up front; `spent` is what was actually billed,
  // and the difference is released so a cached itinerary costs no quota.
  const spent = settled.reduce((n, s) => n + s.spent, 0);
  return { results: settled.map(s => s.result), spent };
}
