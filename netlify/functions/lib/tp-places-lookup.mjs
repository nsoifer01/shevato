// The tp-places resolution pipeline: query -> place ID -> rating payload, with
// the two caches in between. Kept out of the handler and given injected `cache`
// / `findPlaceId` / `fetchDetails` so node:test can drive every branch (hit,
// miss, no match, budget exhaustion, upstream failure) with no Blobs context
// and no billed calls.
//
// CACHING. What may be stored is set by Google's terms, not by what would be
// convenient. Re-derived field by field from the LIVE terms on 2026-09-06 (the
// third check; 2026-07-20 and 2026-08-17 before it) because "our comment says
// so" is not a source. What those documents say today, quoted:
//
//   ToS 3.2.3(b) No Caching: "Customer will not cache Google Maps Content
//     except as expressly permitted under the Maps Service Specific Terms."
//   ToS 3.2.3(a) No Scraping: "Customer will not: (i) pre-fetch, index, store,
//     reshare, or rehost Google Maps Content outside the services; ... (iii)
//     copy and save business names, addresses, or user reviews".
//   SST A.3 Google ID Caching: "Customer may cache the Google ID values from
//     the Services that return such field and allow caching ... For example,
//     Customer may cache (a) place_id from Places API".
//   SST 14 (Places API, Legacy and New) grants exactly ONE caching permission,
//     14.3: "Customer may temporarily cache latitude and longitude values from
//     the Places API for up to 30 consecutive calendar days, after which
//     Customer must delete the cached latitude and longitude values."
//
// SO: place ID indefinitely, lat/lng for up to 30 consecutive CALENDAR days
// (this app holds them 29 x 24h, because a full 30 x 24h started after midnight
// spans thirty-one dates - see VENUE_TTL_MS in trip-logic.js), and NOTHING
// ELSE. That is a
// deliberate omission rather than a gap, and the proof is one section further
// down the same document: SST 16.2 gives the Pollen API a TABLE of per-content
// caching periods (365 days for today's forecast, 24 hours for forecasts and
// heatmaps). Google writes field-level caching grants when it means them.
// Section 14 names one field class. Ratings, review counts, display names,
// addresses, opening hours, types and the Maps URI are not among them, and
// names/addresses/reviews are additionally called out by 3.2.3(a)(iii).
//
// Hence RATING_TTL_MS = 0, and it is not a tuning knob. Holding a response in
// memory to paint the elements that asked for it is not caching (the DOM holds
// the same rating); writing it anywhere that outlives the request is. The
// place-ID layer absorbs the free half of the lookup, and the billed-call
// ceiling is bounded by the quotas, not by this TTL.
//
// The Maps URI needs no storage anyway: it is derivable from the place ID,
// which we ARE allowed to keep.
// HOW LONG A QUERY IS TAKEN TO MEAN A PLACE - which is NOT the same question
// as how long a place ID may be stored, and conflating the two is how this
// number gets argued about.
//
// SST A.3 lets us keep a place ID indefinitely, and we do: the ID stamped on an
// itinerary item never expires (normalizePlaceRecord in trip-logic.js keeps
// `id` forever and expires only the coordinates beside it). What expires here
// is something else entirely - our INFERENCE that a particular piece of free
// text, in a particular area, means that place. Google's permission to store an
// ID says nothing about whether that inference is still true.
//
// It stops being true in ways a stored ID cannot notice: a business is replaced
// at the same address by a different one with a NEW place ID, a second branch
// opens and the query now names it better, a venue closes while Google keeps
// serving the dead entity, a name changes, an ambiguous query becomes
// resolvable. Every one of those is fixed by asking Text Search again, and by
// nothing else.
//
// SO WHY NOT LONGER, given the ID itself may be kept forever? Because a longer
// window buys exactly nothing. MEASURED 2026-09-06 against this pipeline: a hot
// mapping and a cold one both bill ONE Place Details call on the next request.
// The only thing this TTL moves is the Text Search, which is the free,
// unlimited Essentials (IDs Only) SKU at $0.00 - the billed call happens either
// way, because a rating may not be cached and must be re-fetched every time. So
// lengthening this is a pure loss: no money saved, and a strictly wider window
// in which a replaced or re-branched venue is served from a stale inference.
//
// Thirty days is also comfortably inside Google's own staleness guidance -
// developers.google.com/maps/documentation/places/web-service/place-id says
// "Place IDs may change over time" and recommends refreshing IDs more than 12
// months old - so this refreshes an ID twelve times more often than Google asks,
// for free.
export const PLACE_ID_TTL_MS = 30 * 86400000;
export const RATING_TTL_MS = 0;

// Cache the fact that a query resolves to nothing too, or every render of a
// day plan re-pays for the same failed search. Shorter than the place-ID TTL
// because a genuinely new venue should become findable within the week.
export const NO_MATCH_TTL_MS = 7 * 86400000;

// How long a REJECTION is remembered. A query whose place Google found but the
// gates refused (wrong branch, different business, wrong kind of place) used to
// remember only the rejected place ID, which is the worst of both worlds: the
// ID cache guaranteed the next request would fetch Details for a candidate we
// already knew we would refuse, pay the Enterprise SKU for it, and answer
// `no_match` again - once per page load, for the thirty days of the ID TTL.
// Measured on 2026-09-06 against the real pipeline: one wrong-area venue, one
// billed call per request, forever.
//
// THIS TTL IS NOT A LEGAL QUESTION, and it is worth saying so because the two
// TTLs above are. A tombstone stores no Google Maps Content: the key is our own
// query string, the verdict is our own reason word, and the only Google value
// in it is a place ID, which SST A.3 lets us keep indefinitely. Nothing here is
// a name, a rating, an address or an hours line.
//
// So the length is decided by one risk only: OUR judgment changes, and a
// remembered refusal keeps a fixed gate from reaching the card. The Ko Phi Phi
// round (2026-09-05) is the worst case on record - a bad anchor made the gates
// refuse every correct venue in a region - and a long tombstone would have kept
// those cards blank long after the fix shipped.
//
// That risk is answered directly by JUDGE_VERSION below rather than by keeping
// the window short and paying for it every day. With the version in the
// signature, changing a gate retires every tombstone the moment the deploy goes
// out, so the window can be as long as the verdict is actually stable: seven
// days, the same as a no-match, and in any case bounded above by the 30-day
// place-ID TTL, after which the query is re-searched from scratch anyway.
export const REJECT_TTL_MS = 7 * 86400000;

// BUMP THIS WHENEVER A GATE CHANGES ITS MIND - matchConfidence, verifyArea,
// typeMismatch, or judge() itself. It rides in the rejection signature, so a
// bump makes every stored verdict stop matching and every refused venue get
// looked at again with the new logic. It is what makes a long REJECT_TTL_MS
// safe: without it, the choice is between paying to re-learn the same refusal
// every day and shipping a gate fix that takes a week to reach a traveller.
//
// YOU CANNOT FORGET. `tests/tp-places-judge-version.test.mjs` hashes the gate
// sources and fails if they move without this being reconsidered, because a
// forgotten bump is otherwise SILENT - nothing looks wrong while travellers are
// shown refusals the current code would not have reached, for up to a week.
// Comment-only edits are ignored by that hash, so the commentary this repo runs
// on can be rewritten freely.
export const JUDGE_VERSION = 'j1';

import {
  isGenericQuery, matchConfidence, normalizeQuery,
  normalizeArea, verifyArea, resolutionConfidence, addressTextOf,
  typeMismatch, foodTypeOf,
  AREA_BIAS_KM,
} from './tp-places-match.mjs';
// ONE definition of "is this place open then", shared with the browser. The
// client re-runs the same function on the same normalized hours when the answer
// arrives, so this filter is a saving (it stops a round handing back a shut
// restaurant) and never a source of truth.
import TripLogic from '../../../apps/trip-planner/js/trip-logic.js';

function fresh(entry, ttl, now) {
  return !!entry && typeof entry.at === 'number' && (now - entry.at) < ttl;
}

// The AREA is part of the key, and that is not an optimisation.
// "Royce Chocolate" resolves to a Hokkaido flagship for one traveller and to a
// Tokyo Station counter for another; a key that holds only the query would
// serve the first answer to the second traveller for thirty days, which is the
// 809 km bug with a cache in front of it. `areaCacheKey` collapses an area to a
// coarse token - the city name, or the expected point rounded to ~11 km - so
// two lookups in the same city still share one billed call while two cities
// never collide.
export function areaCacheKey(area) {
  if (!area) return '';
  if (area.city) return normalizeQuery(area.city).replace(/ /g, '+');
  if (area.point) return `${area.point.lat.toFixed(1)},${area.point.lon.toFixed(1)}`;
  if (area.country) return normalizeQuery(area.country).replace(/ /g, '+');
  return '';
}

export function idCacheKey(query, area) {
  // The normalized form is the cache key, so "Ichiran (Shibuya)" and
  // "ichiran shibuya" share one entry and one billed lookup.
  const a = areaCacheKey(area);
  return 'id:' + normalizeQuery(query).replace(/ /g, '+') + (a ? '@' + a : '');
}

export function detailsCacheKey(placeId) {
  return 'pd:' + placeId;
}

// WHAT A REMEMBERED REJECTION IS ALLOWED TO ANSWER FOR.
//
// `idCacheKey` covers the normalized query and a COARSE area - the city name,
// or the point rounded to ~11 km. The gates read two things it does not: the
// meal slot (`typeMismatch` uses it to know that "Anna's Restaurant" is a
// request to eat) and the exact point/radius (`verifyArea` measures against
// them). Replaying a verdict that depended on either would answer a question
// nobody asked: a venue refused as the wrong KIND for breakfast is not refused
// for a traveller who asked about it with no meal slot at all.
//
// So a tombstone carries a signature of exactly those un-keyed inputs and is
// only honoured when they match. The point is rounded to the same 1 decimal
// (~11 km) `areaCacheKey` already uses, and the radius gate is 150 km wide, so
// two hotels in one city share a signature and a lookup - while a different
// city, a different meal slot or a re-anchored day gets its own verdict.
export function rejectionSignature(area, meal) {
  const m = typeof meal === 'string' ? meal.trim().toLowerCase() : '';
  const p = area && area.point
    ? `${area.point.lat.toFixed(1)},${area.point.lon.toFixed(1)}`
    : '';
  const r = area && Number.isFinite(area.radiusKm) ? Math.round(area.radiusKm) : '';
  return `${JUDGE_VERSION}|${m}|${p}|${r}`;
}

// A CACHE KEY HOLDS MORE THAN ONE VERDICT, because a venue is asked about in
// more than one voice. The same restaurant reaches this function as a food
// candidate carrying a meal slot and as a plain itinerary row carrying none,
// and those are two signatures (see rejectionSignature). With a single slot the
// two overwrote each other turn by turn, so every other request paid to reach a
// refusal it had already reached - the exact waste the tombstone exists to stop.
//
// Bounded hard at three: this rides in the same small blob as the place ID, it
// is keyed by a query that only ever has a handful of sensible signatures, and
// an unbounded list in a cache entry is how the `pd:` blobs got away from us.
export const REJECT_SIGNATURES_MAX = 3;

// Tolerates the single-object form written before this shipped, so entries
// already in the production store keep working rather than being re-bought.
function rejectionList(entry) {
  const r = entry && entry.rejected;
  if (Array.isArray(r)) return r.filter(x => x && typeof x === 'object');
  return r && typeof r === 'object' ? [r] : [];
}

function readRejection(entry, sig, now) {
  for (const r of rejectionList(entry)) {
    if (r.sig === sig && fresh(r, REJECT_TTL_MS, now)) return r;
  }
  return null;
}

function writeRejection(entry, veto, now) {
  const kept = rejectionList(entry)
    .filter(r => r.sig !== veto.sig && fresh(r, REJECT_TTL_MS, now));
  return [veto, ...kept].slice(0, REJECT_SIGNATURES_MAX);
}

// Resolve one entry. Returns { result, spent } where spent counts billed Place
// Details calls. `claim()` takes a slot from the batch budget and returns falsy
// when the budget is gone; it is called as late as possible so cache hits never
// consume one.
//
// An entry is { id, query, area }: `id` is the client's own cache key and is
// echoed back untouched so a response can never be re-keyed onto the wrong
// card, and `area` is the itinerary context the query is expected to resolve
// inside (see normalizeArea).
async function resolveOne(entry, { cache, findPlaceId, now, claim, details, log }) {
  const { id, query, area, meal } = entry;
  const reply = extra => ({ id, query, ...extra });
  const sig = rejectionSignature(area, meal);

  // (1) Category, not a venue: never worth a call, never a correct answer.
  if (isGenericQuery(query)) {
    return { result: reply({ status: 'no_match', reason: 'generic_query' }), spent: 0 };
  }

  // (2) Place ID: cached indefinitely-eligible content, refreshed monthly so a
  // closed or moved venue eventually re-resolves. Keyed by query AND area.
  const idKey = idCacheKey(query, area);
  const cachedId = await cache.get(idKey);
  let placeId = null;
  let searched = false;
  // The stamp the place ID was FIRST written with. A rejection must not renew
  // it: the 30-day TTL is what eventually re-resolves a venue that moved or
  // closed, and refreshing it every time we refuse the same candidate would
  // pin a wrong answer in place for as long as anyone kept asking.
  let placeIdAt = now;
  if (fresh(cachedId, cachedId && cachedId.placeId ? PLACE_ID_TTL_MS : NO_MATCH_TTL_MS, now)) {
    if (!cachedId.placeId) {
      return { result: reply({ status: 'no_match', reason: cachedId.reason || 'not_found' }), spent: 0 };
    }
    placeId = cachedId.placeId;
    placeIdAt = cachedId.at;
    // (2b) We have already looked at this exact candidate, for this exact
    // question, and refused it. Fetching its Details again cannot change the
    // answer - it can only cost $0.02 to reach the same one.
    const veto = readRejection(cachedId, sig, now);
    if (veto) {
      return { result: reply({ status: 'no_match', reason: veto.reason || 'wrong_area' }), spent: 0 };
    }
  } else {
    searched = true;
  }

  // (3) There is deliberately NO rating cache layer here. RATING_TTL_MS is 0
  // (see the legal note above), which made the old read dead code - and the
  // matching write was worse than dead: it persisted name/rating/mapsUri
  // payloads into the blob store forever, unread, exactly the content the
  // terms say may not be stored. Both sides are gone; the place-ID layer
  // above is the whole cache.

  // (4) The free half. THE BUDGET IS NOT CLAIMED HERE, and that moved: it used
  // to be taken before this search, which meant a query claimed a slot before
  // anyone knew whether it would need one. Two spellings of one venue then took
  // two slots to make one billed call, and in a partially granted batch the
  // second slot was taken from a DIFFERENT venue that had to pay for its own.
  // The claim now sits against the billed call, so a slot means exactly one
  // Place Details request. The price is that a batch which runs out of budget
  // mid-way still finishes its free searches; they are the unlimited $0.00
  // Essentials SKU, and a batch granted nothing at all never reaches this
  // function (the handler answers 429 first).
  if (searched) {
    // Text Search with an ID-only field mask is the "Text Search Essentials
    // (IDs Only)" SKU: unlimited, no charge. The billed step is (5).
    // `locationBias` is a REQUEST parameter, not a field, so biasing the search
    // towards the itinerary's own area changes neither the SKU nor the price -
    // it just stops Google answering a Tokyo question with Hokkaido's flagship.
    let found;
    try {
      found = await findPlaceId(query, biasFor(area));
    } catch {
      return { result: reply({ status: 'unavailable', reason: 'upstream' }), spent: 0 };
    }
    if (!found) {
      await cache.set(idKey, { placeId: null, reason: 'not_found', at: now });
      return { result: reply({ status: 'no_match', reason: 'not_found' }), spent: 0 };
    }
    placeId = found;
    await cache.set(idKey, { placeId, at: now });
  }

  // (5) Place Details, Enterprise SKU. This is the $0.02 - once per PLACE, not
  // once per spelling of it (see `details` in resolveQueries).
  const first = await details(placeId, claim);
  if (first.denied) {
    return { result: reply({ status: 'unavailable', reason: 'quota' }), spent: 0 };
  }
  let spent = first.billed ? 1 : 0;
  const place = first.place;
  if (!place) {
    return { result: reply({ status: 'unavailable', reason: 'upstream' }), spent };
  }
  let judged = judge(query, place, placeId, area, meal);
  logDecision(log, { query, area, placeId, place, judged, attempt: 1 });

  // (6) THE SECOND LOOK. A candidate rejected for being in the wrong part of
  // the world is not the end of the question - it usually means Text Search
  // answered a chain name with its most famous branch. Asking again with the
  // city spelled into the query, and with the search RESTRICTED rather than
  // merely biased, is the geographically constrained lookup the first attempt
  // should have been. Bounded to exactly one retry: a second wrong answer is
  // evidence the place is not findable, not an invitation to keep paying.
  //
  // The retry costs one more Place Details call, so it takes a budget slot of
  // its own and simply does not happen when the batch has none left.
  // A candidate that could not be CONFIRMED gets the same second look as one
  // that was refused. Both are the same question - "is this the branch in the
  // traveller's area?" - and the first attempt failed to answer it either way.
  if ((judged.rejectedOnArea || judged.unconfirmed) && area && (area.city || area.point)) {
    const retryQuery = refineQuery(query, area);
    // Worth a second look when EITHER half of the question changes: the text
    // (the city spelled in) or the search itself (restricted rather than
    // biased). Requiring a changed query alone would skip the commonest case
    // of all - a mapsQuery that already names the city, which is exactly what
    // "Royce' Chocolate Tokyo Station" is, and exactly the one that failed.
    const worthRetrying = retryQuery !== query || !!area.point;
    if (worthRetrying) {
      let retryId = null;
      try { retryId = await findPlaceId(retryQuery, biasFor(area, true)); }
      catch { retryId = null; }
      if (retryId && retryId !== placeId) {
        const again = await details(retryId, claim);
        const retryPlace = again.denied ? null : again.place;
        if (retryPlace) {
          if (again.billed) spent += 1;
          const second = judge(query, retryPlace, retryId, area, meal);
          logDecision(log, { query, area, placeId: retryId, place: retryPlace, judged: second, attempt: 2 });
          if (second.result.status !== 'no_match') {
            // The refined lookup is the answer for this query from now on.
            await cache.set(idKey, { placeId: retryId, at: now });
            return { result: reply(second.result), spent };
          }
          // The second look found a DIFFERENT place and refused that one too.
          // It is the more informative verdict (the restricted search is the
          // question we meant to ask), so it is the one remembered, against the
          // ID it actually judged.
          judged = second;
          placeId = retryId;
          placeIdAt = now;
        }
      }
    }
  }

  // (7) REMEMBER A REFUSAL, so the next request does not pay to be refused
  // again. Only a GATE rejection is remembered: `unrated` is a successful
  // resolution that happens to have no star, and it carries the identity,
  // coordinates and hours the client needs, so replaying it as a bare
  // tombstone would blind the rows that depend on them.
  if (judged.rejected) {
    await cache.set(idKey, {
      placeId,
      at: placeIdAt,
      // Verdicts carry forward only while they are verdicts about THE SAME
      // candidate. A place ID that was re-searched after its 30 days, or
      // replaced by the second look, is a different place that nothing has
      // judged yet, and a fresh refusal of the OLD one must not veto it
      // unseen - the signature says which question was asked, not which place
      // answered it.
      rejected: writeRejection(
        cachedId && cachedId.placeId === placeId ? cachedId : null,
        { reason: judged.result.reason, sig, at: now },
        now,
      ),
    });
  }

  return { result: reply(judged.result), spent };
}

// The upstream search hint. A bias steers ranking; a restriction excludes.
// The first attempt biases (a venue just outside the box must still be
// findable); the retry restricts, because by then we know an unrestricted
// search returns the wrong hemisphere.
function biasFor(area, restrict = false) {
  if (!area || !area.point) return null;
  return {
    lat: area.point.lat,
    lon: area.point.lon,
    radiusM: Math.round((restrict ? area.radiusKm : Math.min(AREA_BIAS_KM, area.radiusKm)) * 1000),
    restrict,
  };
}

// The query the retry asks. Spelling the expected city into the text is what
// turns "Royce Chocolate Tokyo Station" (which Google reads as a chain) into a
// question about one branch. Skipped when the query already says it.
function refineQuery(query, area) {
  const city = (area && area.city) || '';
  if (!city) return query;
  if (normalizeQuery(query).includes(normalizeQuery(city))) return query;
  return `${query}, ${city}`.slice(0, 200);
}

// Both gates, in one place, so no caller can apply one and forget the other.
// A place whose NAME the query does not account for is a different business
// (matchConfidence); a place whose LOCATION the itinerary does not account for
// is a different branch (verifyArea). Either failure is a no_match, and the
// reason says which, because "low_confidence" and "wrong_area" call for
// completely different fixes.
function judge(query, place, placeId, area, meal) {
  const name = (place && place.name) || '';
  // The area rides along so a city named in the query is read as the search
  // hint it is, never as a discriminator competing with the place's own name.
  const { score, confident } = matchConfidence(query, name, area);
  if (!confident) {
    return {
      rejectedOnArea: false, unconfirmed: false, area: null, rejected: true,
      result: { status: 'no_match', reason: 'low_confidence' },
    };
  }
  // THE THIRD GATE. The name gate answers "same words?" and the area gate
  // answers "same place on earth?" - and "Maya Bay" -> "Maya Bay Tours" passes
  // both, because the tour desk's name CONTAINS the query (matchConfidence
  // scores containment 1.00) and the desk is nearer than the beach. What
  // separates them is what they ARE. Rejected outright rather than shown with a
  // caveat, for the same reason a wrong branch is: a rating, an hours line and
  // a pin for a booking office presented as a lagoon are lies the traveller has
  // no way to check.
  const badType = typeMismatch(query, place, area, meal);
  if (badType) {
    return {
      rejectedOnArea: false, unconfirmed: false, area: null, rejected: true,
      result: { status: 'no_match', reason: 'type_mismatch', detail: badType },
    };
  }
  const at = coords(place);
  const verdict = verifyArea({ ...place, ...at }, area);
  const confidence = resolutionConfidence(score, verdict);
  if (!verdict.ok) {
    return {
      rejectedOnArea: true, unconfirmed: false, area: verdict, rejected: true,
      result: { status: 'no_match', reason: 'wrong_area' },
    };
  }
  return {
    rejectedOnArea: false,
    // The place is a real Maps entity whose name the query accounts for, but
    // nothing could confirm it is the branch in the traveller's area. Worth a
    // second look; NOT worth discarding.
    unconfirmed: !verdict.checked,
    area: verdict,
    result: fromDetails(place, placeId, verdict, confidence),
  };
}

// Shape the client-facing result for a candidate that passed BOTH gates.
//
// `placeId` is the canonical identity, and it is the field that makes the
// recommendation card and the saved itinerary row the same place: the card
// records it, Add to trip persists it, and every later surface reads the place
// rather than re-searching a string. Google's caching policy singles the place
// ID out as the one value that may be stored indefinitely, which is exactly why
// it is the identity we keep and the name/rating/hours are not.
//
// `verified` says whether the area was actually CHECKED and agreed. It is not
// decoration: the client refuses to draw a distance, an hours line or a
// persisted coordinate from an unverified resolution, so nothing downstream can
// present an unchecked guess as a fact.
function fromDetails(place, placeId, verdict, confidence) {
  // The coordinates ride along on every accepted match, rated or not: they came
  // from the same billed Place Details call, they are the one field the caching
  // terms permit the client to store, and an unrated hole-in-the-wall still has
  // a position worth measuring a walk against.
  const at = coords(place);
  // Opening hours travel with every accepted match for the same reason, and are
  // passed through, never stored (no Google caching exception covers hours).
  const hours = place.hours && typeof place.hours === 'object' ? { hours: place.hours } : {};
  // And Google's own food type, for the same reason and under the same rule:
  // one allowlisted word, passed through, never stored. It is what lets a
  // breakfast slot prefer a breakfast place over an equally open steakhouse
  // without anyone reading words out of a venue's name.
  const ft = foodTypeOf(place);
  const food = ft ? { foodType: ft } : {};
  const identity = {
    placeId: placeId || '',
    verified: !!verdict.checked && verdict.ok,
    areaBasis: verdict.basis,
    confidence,
    ...at,
    ...hours,
    ...food,
  };
  if (typeof place.rating !== 'number') {
    return { status: 'no_match', reason: 'unrated', ...identity };
  }
  return {
    status: 'ok',
    name: (place && place.name) || '',
    rating: place.rating,
    userRatingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : 0,
    mapsUri: place.mapsUri || '',
    ...identity,
  };
}

// Absent, non-numeric or out-of-range coordinates simply do not travel: the
// client then falls back to its own lookup rather than trusting a bad point.
function coords(place) {
  const lat = place && place.lat, lon = place && place.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return {};
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return {};
  return { lat, lon };
}

// DEVELOPMENT VISIBILITY, function logs only. When a card looks wrong the
// question is always the same - what did Google return, and why was it kept or
// dropped - and before this the logs answered neither. One line per decision,
// carrying the query, the expected area, the candidate's identity, the verdict
// and the reason. No API key, no clientId, no traveller identifier: the query
// and the place are the whole record.
function logDecision(log, { query, area, placeId, place, judged, attempt }) {
  if (typeof log !== 'function') return;
  try {
    log({
      query,
      attempt,
      expected: area ? { city: area.city || '', country: area.country || '', point: area.point || null } : null,
      candidate: {
        placeId,
        name: (place && place.name) || '',
        address: addressTextOf(place).slice(0, 160),
        lat: place && place.lat, lon: place && place.lon,
      },
      verdict: judged.result.status === 'no_match'
        ? { kept: false, reason: judged.result.reason }
        : { kept: true, confidence: judged.result.confidence, basis: judged.result.areaBasis },
      area: judged.area,
    });
  } catch { /* logging must never break a lookup */ }
}

// Resolve a whole batch. Queries run in parallel (the batch is capped at 12 by
// the handler), sharing one billed budget: each query claims a slot only at the
// moment it is about to spend, so a batch can never exceed the quota reserved
// for it, and cache hits leave the budget untouched for the queries that need
// it. The claim counter is safe without locking because the decrement is
// synchronous on a single-threaded event loop.
export async function resolveQueries({ queries, cache, findPlaceId, fetchDetails, now, budget, log }) {
  let left = Math.max(0, budget);
  const claim = () => (left > 0 ? (left -= 1, true) : false);

  // ONE BILLED CALL PER PLACE, NOT PER SPELLING.
  //
  // The batch is deduplicated on the CLIENT's key before it is sent, which
  // catches the same string asked twice - and misses the case that actually
  // happens. A day plan names the same venue in more than one voice ("The
  // Mango Garden", "Mango Garden restaurant", "The Mango Garden, Ko Phi Phi"),
  // the free ID search maps all of them onto ONE place ID, and every one of
  // them then bought its own Place Details call at the Enterprise SKU.
  // Measured on 2026-09-06 against the real pipeline: three spellings, three
  // billed calls, $0.06 for one venue.
  //
  // A place ID resolved inside one request is asked about once and the answer
  // shared. This is not a cache and stores nothing: it lives for the length of
  // the request, exactly like the response object it feeds, so it is the same
  // permission the DOM has to hold a rating it is painting. The joiners still
  // run their OWN gates over the shared response - two queries can resolve to
  // one place and be judged differently, because the gates read the query text
  // and the meal slot, not just the place.
  const inFlight = new Map();
  const details = async (placeId, take) => {
    const joined = inFlight.get(placeId);
    // A joiner pays nothing and therefore claims nothing.
    if (joined) return { place: await joined, billed: false, denied: false };
    if (!take()) return { place: null, billed: false, denied: true };
    // Stored synchronously, before the first await, so two queries resolving
    // in the same tick cannot both start a request.
    const p = (async () => {
      try { return await fetchDetails(placeId); }
      catch { return null; }
    })();
    inFlight.set(placeId, p);
    return { place: await p, billed: true, denied: false };
  };

  const entries = (Array.isArray(queries) ? queries : []).map(toEntry).filter(Boolean);
  const settled = await Promise.all(entries.map(e =>
    resolveOne(e, { cache, findPlaceId, now, claim, details, log })));

  // The caller reserved `budget` up front; `spent` is what was actually billed,
  // and the difference is released so a cached itinerary costs no quota.
  const spent = settled.reduce((n, s) => n + s.spent, 0);
  return { results: settled.map(s => s.result), spent };
}

// A batch entry may arrive as a bare string (an old client, or any caller that
// has no itinerary context to give) or as { q, id, city, country, lat, lon }.
// Both end up in the same shape, and a string simply resolves with no area -
// which the gates report as UNCHECKED rather than treating as verified.
export function toEntry(raw) {
  if (typeof raw === 'string') {
    const q = raw.trim();
    return q ? { id: q, query: q, area: null } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const query = typeof raw.q === 'string' ? raw.q.trim() : '';
  if (!query) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : query;
  // The meal slot the itinerary filed this query under, when it has one. It is
  // the only thing that can tell the type gate a query with no kind word in it
  // ("Anna's Restaurant") is asking for somewhere to eat.
  const meal = typeof raw.meal === 'string' ? raw.meal.slice(0, 20).trim() : '';
  return { id, query, area: normalizeArea(raw), meal };
}

// ---------- discovery: find CANDIDATES, not a named place ----------
// A different question from the rest of this file, and the difference decides
// which gates apply.
//
// resolveOne answers "the model named THIS venue - is the place Google returned
// the same business, in the right area?". Both gates apply, and the name gate
// is the important one.
//
// discoverPlaces answers "the traveller asked for chocolate shops in Tokyo -
// which real places are those?". Nobody named a venue, so there is no name to
// check: `matchConfidence("nama chocolate Tokyo", "Musee du Chocolat")` would
// reject every correct answer. What replaces it is that the SEARCH ITSELF is
// restricted to the area (Google cannot return outside the box) and every
// candidate is still put through verifyArea afterwards. Relevance comes from
// Google's own ranking, which is what it is good at; geography comes from us,
// which is what it got wrong.
//
// This exists so a recommendation that fails verification can be REPLACED with
// a real one deterministically, without spending another model turn inventing
// a venue name that might not exist either.

// Hard ceiling on billed Place Details calls for one discovery request. The
// search that produces the candidate IDs is free (IDs-only field mask); every
// candidate we then look at costs $0.02, so this is the real cost of a
// replacement round and it is deliberately small.
export const DISCOVERY_DETAILS_MAX = 4;
// A SCHEDULED search may look PAST venues that are shut at the hour it is
// filling, and looking past one costs its Place Details call: the hours only
// exist inside that response. So the number of candidates such a search may
// examine is larger than the number it may return, and it is its own constant
// rather than a bigger DISCOVERY_DETAILS_MAX, because the two bound different
// things (what the traveller is offered, and what the owner pays to look at).
// The scan stops the moment enough usable candidates are found, so the ceiling
// is only reached in an area where most venues really are closed then.
export const DISCOVERY_SCAN_MAX = 6;
// How many IDs to ask the free search for. More than we will fetch, because
// exclusions (already-recommended places) and rejections come out of this pool.
export const DISCOVERY_SEARCH_PAGE = 10;

/**
 * Returns up to `limit` VERIFIED candidates for a category-style query.
 *
 *   { query, area, limit, exclude }  ->  { results, spent }
 *
 * `exclude` is a set of place IDs already spoken for - the recommendations that
 * survived, and the ones already rejected - so a replacement can never be a
 * duplicate of either under a different display name.
 */
export async function discoverPlaces({
  query, area, limit, exclude, meal, schedule, findPlaceIds, fetchDetails, now, claim, log,
}) {
  const want = Math.max(1, Math.min(DISCOVERY_DETAILS_MAX, Number(limit) || 1));
  const skip = new Set(Array.isArray(exclude) ? exclude.filter(x => typeof x === 'string' && x) : []);
  const out = [];
  let spent = 0;
  // Counted so the caller can tell "this area has nothing else" from "this area
  // has plenty and none of it opens then", which are different sentences.
  let hoursRejected = 0;

  // The search is RESTRICTED, not biased. A biased discovery search is how the
  // original bug happened in the first place: ask the whole planet for a
  // chocolate shop and the famous one wins, wherever it is. Here we would
  // rather find nothing than find something in the wrong country.
  //
  // But `biasFor` can only build a rectangle from a COORDINATE, and returns
  // null without one - so a trip whose city was never geocoded was in fact
  // searching globally under a comment promising the opposite. `constrained`
  // makes that explicit: the strong form is the rectangle; the weak form is the
  // city spelled into the query text (which discoveryQueryFrom guarantees, and
  // which is the whole reason "seafood Kata Beach" answers with Kata Beach
  // seafood). With NEITHER, the search really is global and its candidates may
  // not be accepted on a verdict nothing could check.
  const box = biasFor(area, true);
  const constrained = !!box
    || !!(area && area.city && normalizeQuery(query).includes(normalizeQuery(area.city)));
  let ids = [];
  try {
    ids = (await findPlaceIds(query, box, DISCOVERY_SEARCH_PAGE)) || [];
  } catch {
    return { results: [], spent: 0, reason: 'upstream' };
  }
  const fresh = ids.filter(id => typeof id === 'string' && id && !skip.has(id));
  if (!fresh.length) return { results: [], spent: 0, reason: 'no_candidates' };

  for (const id of fresh) {
    if (out.length >= want) break;
    if (!claim()) break;                    // the batch budget is the ceiling
    let place;
    try { place = await fetchDetails(id); } catch { continue; }
    spent += 1;
    if (!place) continue;

    // The SAME geographic gate every named lookup passes through. A restricted
    // search should already have kept us in the area; this is the check that
    // makes that a guarantee rather than a hope.
    const at = coords(place);
    const verdict = verifyArea({ ...place, ...at }, area);
    // A verdict that CHECKED and disagreed is always fatal. A verdict nothing
    // could check is fatal only when the search itself was unconstrained: with
    // a rectangle, or with the city in the query text, Google has already
    // answered the geographic question and an administrative name that does not
    // match the traveller's word for the place is not grounds to drop a real
    // venue (see verifyArea's note on Railay/Ao Nang and Kata/Karon).
    if (!verdict.ok || (!verdict.checked && !constrained)) {
      logDecision(log, { query, area, placeId: id, place, attempt: 'discover',
        judged: { area: verdict, result: { status: 'no_match', reason: verdict.ok ? 'unconstrained_search' : 'wrong_area' } } });
      continue;
    }
    // The SAME type gate a named lookup passes through. Nobody named a venue
    // here, so the broker half is what carries: a traveller who asked for
    // seafood and got a dive-booking desk was answered with the wrong kind of
    // business, however well Google ranked it.
    const badType = typeMismatch(query, place, area, meal);
    if (badType) {
      logDecision(log, { query, area, placeId: id, place, attempt: 'discover',
        judged: { area: verdict, result: { status: 'no_match', reason: 'type_mismatch', detail: badType } } });
      continue;
    }

    // A candidate nobody has rated is a poor REPLACEMENT specifically: the
    // traveller asked for good places, and the whole reason this one is being
    // offered is that another failed. An unrated place is still a real place -
    // it just is not a recommendation.
    if (typeof place.rating !== 'number') continue;

    // THE SCHEDULE GATE. A replacement exists because the slot it is filling
    // has an hour attached, so a candidate that is shut at that hour is not a
    // replacement at all - it is the same failure again, bought a second time.
    // The Details response already holds the hours (same billed call), so this
    // costs nothing and lets the search walk further down the free ID page
    // instead of returning the first shut restaurant Google ranked highly.
    //
    // Hours UNKNOWN passes: it is not evidence of anything, and the client
    // ranks it behind every confirmed-open candidate and labels it on the card.
    // A future date is judged by the venue's weekly pattern for THAT weekday
    // (hoursDow parses the ISO date as UTC, so no machine's timezone can move
    // it); "open now" is never asked, because the trip is not now.
    if (schedule) {
      const hoursAt = TripLogic.hoursVerdict(place.hours, schedule.date, schedule.time, schedule.windowMin);
      if (hoursAt.status !== 'open' && hoursAt.status !== 'unknown') {
        hoursRejected += 1;
        logDecision(log, { query, area, placeId: id, place, attempt: 'discover',
          judged: { area: verdict, result: { status: 'no_match', reason: 'closed_at_requested_time', detail: hoursAt.status } } });
        continue;
      }
    }

    const confidence = resolutionConfidence(1, verdict);
    const result = fromDetails(place, id, verdict, confidence);
    logDecision(log, { query, area, placeId: id, place, attempt: 'discover',
      judged: { area: verdict, result } });
    out.push(result);
  }
  // Nothing survived, and hours are why: say so rather than let an empty list
  // be read as an empty neighbourhood.
  if (!out.length && hoursRejected) return { results: [], spent, reason: 'no_open_candidates' };
  return { results: out, spent };
}
