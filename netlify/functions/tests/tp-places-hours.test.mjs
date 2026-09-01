import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETAILS_FIELD_MASK } from '../tp-places.mjs';
import { resolveQueries, idCacheKey } from '../lib/tp-places-lookup.mjs';
import TripLogic from '../../../apps/trip-planner/js/trip-logic.js';

// Opening hours ride the EXISTING Place Details lookup: same request, same
// Enterprise SKU, same quota accounting, zero extra calls. These tests pin
// that contract - the field mask, the passthrough, the confidence gate, the
// unchanged spend, and the rule that no hours payload is ever written to the
// durable blob cache (Google's caching terms cover no hours field).

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);

const HOURS = {
  always: false,
  periods: [{ open: { day: 6, min: 960 }, close: { day: 6, min: 1380 } }],
  special: [],
};

function memCache(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, entry) { map.set(key, entry); },
  };
}

function spies(place) {
  const calls = { search: [], details: [] };
  return {
    calls,
    findPlaceId: async q => { calls.search.push(q); return 'place-1'; },
    fetchDetails: async pid => { calls.details.push(pid); return place; },
  };
}

const run = (queries, cache, s, budget = 10) =>
  resolveQueries({ queries, cache, findPlaceId: s.findPlaceId, fetchDetails: s.fetchDetails, now: NOW, budget });

test('the details field mask asks for both hours fields and nothing above Enterprise', () => {
  // Exact pin, not a substring check: any drift in this string is a billing
  // change and must be a deliberate edit here as well. regularOpeningHours and
  // currentOpeningHours are Place Details Enterprise fields (verified against
  // the data-fields doc 2026-08-21), the tier `rating` already bills, so this
  // mask costs exactly what the pre-hours mask cost.
  // formattedAddress and addressComponents are Place Details ESSENTIALS
  // fields, two tiers below Enterprise, so they ride the same billed call for
  // nothing (2026-08-27, the wrong-branch gate). Any drift in this string is a
  // billing change and must be a deliberate edit here as well.
  assert.equal(DETAILS_FIELD_MASK,
    'displayName,googleMapsUri,rating,userRatingCount,location,formattedAddress,'
    + 'addressComponents,regularOpeningHours,currentOpeningHours');
});

test('hours ride the ok result, and the lookup still spends exactly one call', async () => {
  const cache = memCache();
  const s = spies({ name: 'Above The Grid', rating: 4.6, userRatingCount: 812, mapsUri: 'https://maps.google.com/?cid=1', hours: HOURS });
  const { results, spent } = await run(['Above The Grid Louisville'], cache, s);
  assert.equal(results[0].status, 'ok');
  assert.deepEqual(results[0].hours, HOURS);
  assert.equal(spent, 1, 'hours add no billed call: one Place Details, as before');
  assert.equal(s.calls.search.length, 1, 'and no extra search either');
  assert.equal(s.calls.details.length, 1);
});

test('an unrated confident match still carries its hours', async () => {
  const cache = memCache();
  const s = spies({ name: 'Above The Grid', rating: null, userRatingCount: 0, mapsUri: '', hours: HOURS });
  const { results } = await run(['Above The Grid Louisville'], cache, s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'unrated');
  assert.deepEqual(results[0].hours, HOURS);
});

test('a low-confidence match gets no hours: a different business would lie', async () => {
  const cache = memCache();
  const s = spies({ name: 'Completely Different Bistro', rating: 4.9, userRatingCount: 3, mapsUri: 'u', hours: HOURS });
  const { results } = await run(['Above The Grid Louisville'], cache, s);
  assert.equal(results[0].status, 'no_match');
  assert.equal(results[0].reason, 'low_confidence');
  assert.equal(results[0].hours, undefined);
});

test('a place with no hours answers without them: absent, never fabricated', async () => {
  const cache = memCache();
  const s = spies({ name: 'Above The Grid', rating: 4.6, userRatingCount: 812, mapsUri: 'u', hours: null });
  const { results } = await run(['Above The Grid Louisville'], cache, s);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].hours, undefined);
});

test('the durable cache never stores an hours payload, only the place ID', async () => {
  const cache = memCache();
  const s = spies({ name: 'Above The Grid', rating: 4.6, userRatingCount: 812, mapsUri: 'u', hours: HOURS });
  await run(['Above The Grid Louisville'], cache, s);
  assert.deepEqual([...cache.map.keys()], [idCacheKey('Above The Grid Louisville')]);
  const stored = cache.map.get(idCacheKey('Above The Grid Louisville'));
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'placeId'],
    'the id entry holds the id and its timestamp, no Google content');
});

test('the server normalizer and the client validator agree on the wire shape', () => {
  // What normalizeGoogleHours emits must survive the client's sanitizeHours
  // unchanged; a drift between the two would silently turn verified hours into
  // "unknown" on every card.
  const normalized = TripLogic.normalizeGoogleHours(
    {
      periods: [
        { open: { day: 6, hour: 16, minute: 0 }, close: { day: 6, hour: 23, minute: 0 } },
        { open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
      ],
    },
    { periods: [{ open: { day: 6, hour: 16, minute: 0, date: { year: 2026, month: 8, day: 29 } }, close: { day: 6, hour: 20, minute: 0, date: { year: 2026, month: 8, day: 29 } } }] },
  );
  assert.ok(normalized);
  assert.deepEqual(TripLogic.sanitizeHours(normalized), normalized);
});
