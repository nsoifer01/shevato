'use strict';

// THE ROUND THIS FILE PINS (2026-08-27).
//
// Asked for three Nama-chocolate shops in Japan, the assistant returned:
//   "Shopping: Royce' Chocolate (Tokyo Station)"    -> 809 km from Tsukiji
//   "Shopping: Royce' Chocolate (Kyoto Takashimaya)" -> "No rating match" on
//                                                       the card, a rating in
//                                                       the agenda
//   "Shopping: Mary's Chocolate (Shinjuku)"
//
// Four separate defects, one shape: a place was identified by a STRING, a
// different string depending on which surface was asking, with no geography
// anywhere in the identity.
//
//   1. the resolution had no geographic gate, so a chain's most famous branch
//      answered a question about a different city (server side: see
//      netlify/functions/tests/tp-places-geo.test.mjs)
//   2. the card and the itinerary row derived DIFFERENT queries for the same
//      place, so they could disagree about whether it resolved at all
//   3. an unverified coordinate was persisted and drew a confident chip
//   4. the model invented a category prefix and the app rendered it verbatim
//
// Everything below is about the general system. Nothing asserts a distance in
// km to Tsukiji, a threshold tuned to Tokyo, or anything about chocolate.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

const TOKYO_POINT = { lat: 35.6812, lon: 139.7671 };
const KYOTO_POINT = { lat: 35.0116, lon: 135.7681 };
const CHITOSE_POINT = { lat: 42.7752, lon: 141.6926 };   // ROYCE' Chocolate World
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

// The cache-only geocode probe placeLookupFor takes, in the shape app.js
// injects it: a city name in, a point or null out. No network anywhere.
const cities = { Tokyo: TOKYO_POINT, Kyoto: KYOTO_POINT, Chitose: CHITOSE_POINT };
const ctx = (over = {}) => ({ resolvePoint: name => cities[name] || null, ...over });

// ---------- 1. ONE identity per place ----------

test('a proposal and the item it becomes resolve to the SAME key', () => {
  // This is the whole architecture in one assertion. proposalToItem copies
  // type/title/location/mapsQuery verbatim, so if both sides go through
  // placeLookupFor they cannot disagree - which is what stops one surface
  // saying "No rating match" while the other shows a rating.
  const fields = {
    type: 'activity', title: "Royce' Chocolate (Tokyo Station)", location: 'Tokyo',
    mapsQuery: "Royce' Chocolate Tokyo Station Marunouchi Tokyo", startDate: '2026-12-31',
  };
  const card = L.placeLookupFor(fields, ctx({ city: 'Tokyo' }));
  const item = L.placeLookupFor({ ...fields, id: 'i1', status: 'to-book' }, ctx({ city: 'Tokyo' }));
  assert.deepEqual(card, item);
  assert.ok(card.key);
});

test('the identity survives the meal split the accept path performs', () => {
  // The card holds "Dinner: Narisawa"; the saved item holds meal:'dinner' with
  // title:'Narisawa'. Both must key identically, because they are one place.
  const card = L.placeLookupFor(
    { type: 'activity', title: 'Dinner: Narisawa', location: 'Tokyo', startDate: '2026-12-31' }, ctx());
  const saved = L.placeLookupFor(
    { type: 'activity', title: 'Narisawa', meal: 'dinner', location: 'Tokyo', startDate: '2026-12-31' }, ctx());
  assert.equal(card.key, saved.key);
});

test('an invented category prefix does not change the identity either', () => {
  const withPrefix = L.placeLookupFor(
    { type: 'activity', title: "Shopping: Mary's Chocolate Shinjuku", location: 'Tokyo' }, ctx());
  const clean = L.placeLookupFor(
    { type: 'activity', title: "Mary's Chocolate Shinjuku", location: 'Tokyo' }, ctx());
  assert.equal(withPrefix.key, clean.key);
  assert.ok(!/shopping/i.test(withPrefix.query), 'and "shopping" never reaches the Maps query');
});

test('placeLookupFor answers WHICH PLACE, not "may this show a rating"', () => {
  // A "Return to hotel" leg names the booked hotel on purpose: its directions
  // link and its end of the day's distance chain both need that identity, so
  // the lookup resolves. Whether a row may wear a STAR is a separate question
  // the renderers ask with isPlaceType / isTravelLeg - conflating the two once
  // broke every leg's destination.
  const leg = L.placeLookupFor(
    { type: 'local', title: 'Return to hotel', mapsQuery: 'Hotel Okura Tokyo', location: 'Tokyo' }, ctx());
  assert.equal(leg.query, 'Hotel Okura Tokyo');
  assert.equal(L.isPlaceType({ type: 'local' }), false, 'and it is still not a place type');
  // Nothing is DERIVED for a non-place type, though: a leg with no mapsQuery
  // of its own has no place to name, and "Return to hotel Lisbon" is the
  // documented way to send someone to the wrong pin.
  for (const type of ['flight', 'transport', 'local', 'note']) {
    assert.equal(L.placeLookupFor({ type, title: 'Return to hotel', location: 'Lisbon' }, ctx()), null, type);
  }
});

// ---------- 2. the area is part of the identity ----------

test('CACHE ISOLATION: the same business in two cities gets two keys', () => {
  const tokyo = L.placeLookupFor({ type: 'activity', title: 'Takashimaya', location: 'Tokyo' }, ctx());
  const kyoto = L.placeLookupFor({ type: 'activity', title: 'Takashimaya', location: 'Kyoto' }, ctx());
  assert.notEqual(tokyo.key, kyoto.key);
  assert.match(tokyo.key, /@tokyo$/);
  assert.match(kyoto.key, /@kyoto$/);
  // Even when the two DO share their text - a model that spelled the branch
  // into mapsQuery and left `location` to carry the city - the area still
  // separates them, which is the case a query-only key could not tell apart.
  const a = L.placeLookupFor({ type: 'activity', title: 'X', mapsQuery: 'Takashimaya', location: 'Tokyo' }, ctx());
  const b = L.placeLookupFor({ type: 'activity', title: 'X', mapsQuery: 'Takashimaya', location: 'Kyoto' }, ctx());
  assert.equal(a.query, b.query);
  assert.notEqual(a.key, b.key);
});

test('the wire request carries the geography, not just the text', () => {
  const lookup = L.placeLookupFor(
    { type: 'activity', title: "Royce' Chocolate", location: 'Tokyo' }, ctx({ country: 'Japan' }));
  const req = L.placeLookupRequest(lookup);
  assert.equal(req.id, lookup.key);
  assert.equal(req.city, 'Tokyo');
  assert.equal(req.country, 'Japan');
  assert.equal(req.lat, TOKYO_POINT.lat);
});

test("the recommendation's OWN city outranks the day's", () => {
  // A Kyoto shop suggested on a day based in Osaka is a claim about Kyoto, and
  // Kyoto is what gets checked.
  const lookup = L.placeLookupFor(
    { type: 'activity', title: 'Takashimaya', location: 'Kyoto' }, ctx({ city: 'Osaka' }));
  assert.equal(lookup.area.city, 'Kyoto');
  assert.deepEqual({ lat: lookup.area.lat, lon: lookup.area.lon }, KYOTO_POINT);
});

test("the day's city answers when the recommendation names none", () => {
  const lookup = L.placeLookupFor(
    { type: 'activity', title: 'Nishiki Market', location: '', startDate: '2026-12-31' }, ctx({ city: 'Kyoto' }));
  assert.equal(lookup.area.city, 'Kyoto');
});

test('a city nothing has geocoded still constrains by name', () => {
  const lookup = L.placeLookupFor({ type: 'activity', title: 'Somewhere', location: 'Reykjavik' }, ctx());
  assert.equal(lookup.area.city, 'Reykjavik');
  assert.equal(lookup.area.lat, null, 'no point, but the name still travels for the address check');
  assert.equal(L.placeLookupRequest(lookup).lat, undefined);
});

// ---------- 3. only a VERIFIED resolution becomes durable ----------

test('an unverified resolution is never persisted', () => {
  const entry = { status: 'ok', placeId: 'ChIJhokkaido', verified: false, lat: CHITOSE_POINT.lat, lon: CHITOSE_POINT.lon };
  assert.equal(L.placeRecordFrom(entry, { city: 'Tokyo' }, NOW), null);
});

test('a verified resolution persists its ID, its point and the city it was checked against', () => {
  const entry = { status: 'ok', placeId: 'ChIJtokyo', verified: true, rating: 4.1, name: 'ROYCE Tokyo Station', lat: TOKYO_POINT.lat, lon: TOKYO_POINT.lon };
  const rec = L.placeRecordFrom(entry, { city: 'Tokyo' }, NOW);
  assert.deepEqual(rec, { id: 'ChIJtokyo', at: NOW, lat: TOKYO_POINT.lat, lon: TOKYO_POINT.lon, city: 'Tokyo' });
  // Google's caching terms: the place ID may be stored indefinitely and
  // lat/long for 30 days; the NAME, the RATING and the HOURS may not be stored
  // at all. Nothing of that kind may ever appear in this record.
  for (const k of ['name', 'rating', 'userRatingCount', 'hours', 'mapsUri']) {
    assert.equal(rec[k], undefined, `${k} must never be persisted`);
  }
});

test('PERSISTENCE BOUNDARY: a point that disagrees with the item city is refused', () => {
  // "name = Royce Tokyo Station, coordinates = Hokkaido" is the combination
  // this makes unstorable. The place ID survives - it is still a place, and a
  // fresh lookup can re-verify it - but the point that drew the chip does not.
  const rec = L.normalizePlaceRecord(
    { id: 'ChIJhokkaido', at: NOW, lat: CHITOSE_POINT.lat, lon: CHITOSE_POINT.lon, city: 'Tokyo' },
    { now: NOW, cityPoint: TOKYO_POINT });
  assert.equal(rec.id, 'ChIJhokkaido');
  assert.equal(rec.lat, undefined, 'no coordinate, so no distance chip and no wrong number');
});

test('a point that agrees with the item city is kept', () => {
  const rec = L.normalizePlaceRecord(
    { id: 'ChIJtokyo', at: NOW, lat: 35.66, lon: 139.7, city: 'Tokyo' },
    { now: NOW, cityPoint: TOKYO_POINT });
  assert.equal(rec.lat, 35.66);
});

test('an ungeocoded city cannot reject anything: silence is not evidence', () => {
  const rec = L.normalizePlaceRecord(
    { id: 'x', at: NOW, lat: 64.14, lon: -21.94, city: 'Reykjavik' }, { now: NOW, cityPoint: null });
  assert.equal(rec.lat, 64.14);
});

test('coordinates expire on the 30-day schedule the terms allow; the ID does not', () => {
  const stale = { id: 'x', at: NOW - (31 * 86400000), lat: 35.66, lon: 139.7, city: 'Tokyo' };
  const rec = L.normalizePlaceRecord(stale, { now: NOW, cityPoint: TOKYO_POINT });
  assert.equal(rec.id, 'x');
  assert.equal(rec.lat, undefined);
});

test('a malformed record is dropped rather than half-trusted', () => {
  assert.equal(L.normalizePlaceRecord(null, { now: NOW }), null);
  assert.equal(L.normalizePlaceRecord({ lat: 1, lon: 1 }, { now: NOW }), null, 'no ID is no place');
  assert.equal(L.normalizePlaceRecord({ id: '   ' }, { now: NOW }), null);
  const junk = L.normalizePlaceRecord({ id: 'x', at: NOW, lat: 'north', lon: {} }, { now: NOW });
  assert.equal(junk.lat, undefined);
});

test('plausiblePlacePoint is the same generic radius everywhere on earth', () => {
  // Tokyo vs Hokkaido: refused. Paris vs London: refused. Sydney vs a Sydney
  // suburb: kept. No city, no threshold and no continent is special-cased.
  assert.equal(L.plausiblePlacePoint(CHITOSE_POINT, TOKYO_POINT), false);
  assert.equal(L.plausiblePlacePoint({ lat: 51.5074, lon: -0.1419 }, { lat: 48.8566, lon: 2.3522 }), false);
  assert.equal(L.plausiblePlacePoint({ lat: -33.9, lon: 151.18 }, { lat: -33.8688, lon: 151.2093 }), true);
  assert.equal(L.plausiblePlacePoint({ lat: 35.4437, lon: 139.638 }, TOKYO_POINT), true, 'Yokohama is still Tokyo-area');
  assert.equal(L.plausiblePlacePoint(null, TOKYO_POINT), false);
});

// ---------- 4. what the session cache does with a response ----------

test('a verified result carries its identity into the session cache', () => {
  const [up] = L.placesCacheUpdates([{
    id: 'k@tokyo', query: 'Q', status: 'ok', name: 'ROYCE Tokyo Station',
    rating: 4.14, userRatingCount: 210, mapsUri: 'https://maps.google.com/?cid=2',
    placeId: 'ChIJtokyo', verified: true, areaBasis: 'point', confidence: 0.9,
    lat: TOKYO_POINT.lat, lon: TOKYO_POINT.lon,
  }]);
  assert.equal(up.key, 'k@tokyo', 'keyed by the id WE sent, never re-derived from the text');
  assert.equal(up.entry.placeId, 'ChIJtokyo');
  assert.equal(up.entry.verified, true);
  assert.equal(up.entry.rating, 4.1);
});

test('a wrong-area rejection is a tombstone with no metadata attached', () => {
  const [up] = L.placesCacheUpdates([{ id: 'k@tokyo', query: 'Q', status: 'no_match', reason: 'wrong_area' }]);
  assert.deepEqual(up, { key: 'k@tokyo', entry: { status: 'no_match', reason: 'wrong_area' } });
});

test('an unrated but verified place keeps its identity, its point and its hours', () => {
  const [up] = L.placesCacheUpdates([{
    id: 'k', query: 'Q', status: 'no_match', reason: 'unrated',
    placeId: 'ChIJtiny', verified: true, areaBasis: 'point', confidence: 0.8,
    lat: 35.0, lon: 135.77, hours: { always: true, periods: [], special: [] },
  }]);
  assert.equal(up.entry.placeId, 'ChIJtiny', 'no stars is not no place');
  assert.equal(up.entry.verified, true);
  assert.equal(up.entry.hours.always, true);
});

test('an unverified coordinate never reaches the 30-day venue store', () => {
  const out = L.placesLocationUpdates([
    { id: 'a', status: 'ok', lat: CHITOSE_POINT.lat, lon: CHITOSE_POINT.lon, verified: false },
    { id: 'b', status: 'ok', lat: TOKYO_POINT.lat, lon: TOKYO_POINT.lon, verified: true },
  ]);
  assert.deepEqual(out, [{ key: 'b', lat: TOKYO_POINT.lat, lon: TOKYO_POINT.lon }]);
});

// ---------- 5. the Maps URL ----------

test('a SEARCH url is never treated as a resolved place', () => {
  // The Kyoto card's link (google.com/maps/search/?api=1&query=...) worked when
  // clicked, which is exactly why it was mistaken for a verified match. A
  // search URL resolves to whatever Google feels like; only an entity URL is a
  // place, and only a place gets metadata.
  const link = L.assistMapsLink('Takashimaya Kyoto Store', undefined);
  assert.match(link.href, /\/maps\/search\/\?api=1/);
  assert.equal(link.resolved, false);
  assert.equal(link.label, '📍 Verify on Google Maps');
});

test('a verified place is OPENED, never "verified": the two states cannot coexist', () => {
  // The reported contradiction: a card showing "Verify on Google Maps" beside
  // information the app had already verified. The label now follows the
  // evidence.
  const link = L.assistMapsLink('Q', { status: 'ok', placeId: 'ChIJtokyo', verified: true, rating: 4.1, mapsUri: 'https://maps.google.com/?cid=2' });
  assert.equal(link.resolved, true);
  assert.equal(link.label, '📍 Open on Google Maps');
  assert.equal(link.href, 'https://www.google.com/maps/place/?q=place_id:ChIJtokyo',
    'the place ID, which cannot point at a different branch, beats the cached URL');
});

test('the Maps URL is built from the ID rather than stored', () => {
  assert.equal(L.placeMapsUrl({ id: 'ChIJ_a b' }), 'https://www.google.com/maps/place/?q=place_id:ChIJ_a%20b');
  assert.equal(L.placeMapsUrl({}), '');
  assert.equal(L.placeMapsUrl(null), '');
});

// ---------- 6. categories are metadata, never title text ----------

test('an unsupported category prefix never reaches a title', () => {
  const add = (title, extra = {}) => L.validateTripAction(
    { op: 'add', item: { type: 'activity', title, location: 'Tokyo', startDate: '2026-12-31', ...extra } },
    { items: [] });
  for (const [written, shown] of [
    ["Shopping: Royce' Chocolate (Tokyo Station)", "Royce' Chocolate (Tokyo Station)"],
    ["Shopping: Mary's Chocolate (Shinjuku)", "Mary's Chocolate (Shinjuku)"],
    ['Entertainment: Robot Restaurant', 'Robot Restaurant'],
    ['Activity: Senso-ji', 'Senso-ji'],
    ['Sightseeing: Meiji Jingu', 'Meiji Jingu'],
    ['Evening: Golden Gai', 'Golden Gai'],
  ]) {
    const r = add(written);
    assert.equal(r.ok, true, written);
    assert.equal(r.proposal.fields.title, shown, written);
    assert.equal(r.proposal.display.title, shown, 'and the card shows the clean name too');
    assert.equal(r.proposal.fields.meal, undefined, 'no category was invented to replace it');
  }
});

test('a title that merely CONTAINS a colon is left exactly as written', () => {
  // The cleaner is a closed list for this reason: these are names, not labels,
  // and eating half of one would be a worse bug than the one being fixed.
  for (const title of ['teamLab: Borderless', 'Tokyo: A Walking Day', 'Blue Note: Late Set', 'Bar 8: Hidden Door']) {
    const r = L.validateTripAction(
      { op: 'add', item: { type: 'activity', title, location: 'Tokyo', startDate: '2026-12-31' } }, { items: [] });
    assert.equal(r.proposal.fields.title, title, title);
  }
});

test('a food-ish prefix the app HAS a category for becomes that category', () => {
  // "Snack" and "Cafe" are real MEAL_META keys, so a chocolate stop lands in
  // food & drink with the right icon instead of wearing an invented label.
  for (const [title, meal, clean] of [
    ["Snack: Mary's Chocolate", 'snack', "Mary's Chocolate"],
    ['Dessert: Gion Tokuya', 'snack', 'Gion Tokuya'],
    ['Cafe: Blue Bottle Kiyosumi', 'cafe', 'Blue Bottle Kiyosumi'],
    ['Coffee: Fuglen Tokyo', 'cafe', 'Fuglen Tokyo'],
    ['Brunch: Bills Odaiba', 'brunch', 'Bills Odaiba'],
    ['Dinner: Narisawa', 'dinner', 'Narisawa'],
  ]) {
    const r = L.validateTripAction(
      { op: 'add', item: { type: 'activity', title, location: 'Tokyo', startDate: '2026-12-31' } }, { items: [] });
    assert.equal(r.proposal.fields.meal, meal, title);
    assert.equal(r.proposal.fields.title, clean, title);
    assert.equal(L.isMealKind(meal), true, `${meal} must be a real app category`);
  }
});

test('a model-supplied category is accepted only if the app actually has it', () => {
  const bad = L.validateTripAction(
    { op: 'add', item: { type: 'activity', title: 'X', meal: 'shopping', location: 'Tokyo', startDate: '2026-12-31' } }, { items: [] });
  assert.equal(bad.proposal.fields.meal, undefined);
  const proto = L.validateTripAction(
    { op: 'add', item: { type: 'activity', title: 'X', meal: '__proto__', location: 'Tokyo', startDate: '2026-12-31' } }, { items: [] });
  assert.equal(proto.proposal.fields.meal, undefined, 'the vocabulary is data, and __proto__ is not in it');
  const good = L.validateTripAction(
    { op: 'add', item: { type: 'activity', title: 'X', meal: 'snack', location: 'Tokyo', startDate: '2026-12-31' } }, { items: [] });
  assert.equal(good.proposal.fields.meal, 'snack');
});

test('a title that is nothing BUT an invented prefix still keeps a name', () => {
  const r = L.validateTripAction(
    { op: 'add', item: { type: 'activity', title: 'Shopping:', location: 'Tokyo', startDate: '2026-12-31' } }, { items: [] });
  assert.equal(r.ok, true);
  assert.equal(r.proposal.fields.title, 'Shopping:', 'blanking it would leave a nameless card');
});

// ---------- 7. what the model is told ----------

test('the prompt forbids inventing a category prefix, in both modes', () => {
  for (const mode of ['plan', 'chat']) {
    const p = L.buildAssistSystemPrompt({ trip: { name: 'T', items: [] }, mode });
    assert.match(p, /ONLY title prefixes that exist/, mode);
    assert.match(p, /"Shopping: "/, mode);
  }
});

test('the prompt forbids the model asserting place facts it cannot check', () => {
  const p = L.buildAssistSystemPrompt({ trip: { name: 'T', items: [] }, mode: 'plan' });
  for (const re of [
    /never state a star rating/i,
    /never write a Google Maps URL/i,
    /opening or closing times as fact/i,
    /set "location" to the CITY/i,
  ]) assert.match(p, re);
});

test('the four contract prefixes still appear verbatim in the prompt', () => {
  // The cleaner recognises more than the contract asks for, but the CONTRACT
  // is unchanged: what the model is told to write is still these four.
  const p = L.buildAssistSystemPrompt({ trip: { name: 'T', items: [] } });
  assert.deepEqual(L.mealTitlePrefixes(), ['Breakfast: ', 'Lunch: ', 'Dinner: ', 'Drinks: ']);
  for (const pre of L.mealTitlePrefixes()) assert.ok(p.includes(`"${pre}"`), pre);
});

// ---------- 8. batching keeps the geography ----------

test('planPlacesLookup keeps two cities apart and reserves each key once', () => {
  const tokyo = L.placeLookupFor({ type: 'activity', title: 'Takashimaya', location: 'Tokyo' }, ctx());
  const kyoto = L.placeLookupFor({ type: 'activity', title: 'Takashimaya', location: 'Kyoto' }, ctx());
  const { misses } = L.planPlacesLookup([tokyo, kyoto, tokyo], new Set());
  assert.equal(misses.length, 2, 'two questions, and the repeat collapses');
  assert.deepEqual(misses.map(m => m.area.city).sort(), ['Kyoto', 'Tokyo']);
});

test('a bare string still plans, and plans as context-free', () => {
  const { misses } = L.planPlacesLookup(['Ichiran Shibuya'], new Set());
  assert.equal(misses[0].key, 'ichiran shibuya');
  assert.equal(misses[0].area, null);
});

test('the queue puts the geography on the wire', async () => {
  const sent = [];
  const queue = L.createPlacesQueue({
    send: async reqs => {
      sent.push(reqs);
      return { ok: true, results: reqs.map(r => ({ id: r.id, query: r.q, status: 'ok', name: r.q, rating: 4, userRatingCount: 1, mapsUri: 'https://maps.google.com/?cid=1', placeId: 'p-' + r.id, verified: true })) };
    },
    schedule: fn => fn(),
  });
  const kyoto = L.placeLookupFor({ type: 'activity', title: 'Takashimaya', location: 'Kyoto' }, ctx());
  const tokyo = L.placeLookupFor({ type: 'activity', title: 'Takashimaya', location: 'Tokyo' }, ctx());
  queue.request([kyoto], { priority: 'urgent' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(sent[0][0].city, 'Kyoto');
  assert.equal(sent[0][0].lat, KYOTO_POINT.lat);
  assert.equal(sent[0][0].id, kyoto.key, 'the id is our own key, echoed back untouched');
  assert.equal(queue.get(kyoto.key).placeId, 'p-' + kyoto.key);
  assert.equal(queue.get(tokyo.key), undefined, 'and Tokyo learned nothing from it');
});

// ---------- 9. what leaves the browser ----------

test('the resolved place travels in a SHARE link', () => {
  // The far side must link at the same entity, not re-search the name - which
  // is the whole point of keeping an identity rather than a string.
  const trip = {
    name: 'T', currency: 'USD',
    items: [{
      id: 'a', type: 'activity', title: 'Narisawa', location: 'Tokyo', startDate: '2026-12-31',
      mapsQuery: 'Narisawa Tokyo',
      place: { id: 'ChIJnarisawa', lat: 35.66, lon: 139.72, at: Date.now(), city: 'Tokyo' },
    }],
  };
  const shared = L.slimTripForShare(trip);
  assert.deepEqual(shared.items[0].place, { id: 'ChIJnarisawa', at: trip.items[0].place.at, lat: 35.66, lon: 139.72, city: 'Tokyo' });
  // and NOTHING Google's terms forbid storing rides with it
  for (const k of ['name', 'rating', 'userRatingCount', 'hours', 'mapsUri']) {
    assert.equal(shared.items[0].place[k], undefined, k);
  }
});

test('the resolved place is held BACK from the assistant', () => {
  // A place ID and a coordinate are useless to a model - it cannot look either
  // up - and they would only eat the trip's size budget. Its cue that an item
  // already has a place is the mapsQuery, which still travels. privacy.html
  // lists exactly what reaches the assistant, so this is a promise, not a
  // preference (tests/static/trip-planner-assistant-privacy.test.mjs pins it).
  const trip = {
    name: 'T', currency: 'USD',
    items: [{
      id: 'a', type: 'activity', title: 'Narisawa', location: 'Tokyo', startDate: '2026-12-31',
      mapsQuery: 'Narisawa Tokyo', confirmation: 'ABC123',
      place: { id: 'ChIJnarisawa', lat: 35.66, lon: 139.72, at: Date.now(), city: 'Tokyo' },
    }],
  };
  const seen = JSON.stringify(L.slimTripForAssistant(trip));
  assert.equal(/ChIJnarisawa/.test(seen), false, 'the place ID never reaches the model');
  assert.equal(/35\.66/.test(seen), false, 'nor its coordinates');
  assert.equal(/ABC123/.test(seen), false, 'the confirmation code is held back as it always was');
  assert.equal(/Narisawa Tokyo/.test(seen), true, 'the mapsQuery still travels: it is the model\'s cue');
});

test('a malformed place record cannot travel in a share link', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'activity', title: 'X', startDate: '2026-12-31', place: { lat: 1, lon: 2 } },
    { id: 'b', type: 'activity', title: 'Y', startDate: '2026-12-31', place: 'nonsense' },
    { id: 'c', type: 'activity', title: 'Z', startDate: '2026-12-31', place: { id: 'ok', at: 1, lat: 999, lon: 0 } },
  ] };
  const shared = L.slimTripForShare(trip);
  assert.equal(shared.items[0].place, undefined, 'no ID is no place');
  assert.equal(shared.items[1].place, undefined);
  assert.equal(shared.items[2].place.lat, undefined, 'an out-of-range coordinate is dropped, the ID kept');
  assert.equal(shared.items[2].place.id, 'ok');
});

// ---------- 10. one URL for one place, on every surface ----------

test('the rating chip, the card link and the itinerary row agree on the URL', () => {
  // Found in live validation (2026-08-27): the chip rendered Google's own
  // `mapsUri` while the other two preferred the place ID, so ONE recommendation
  // showed two different (both valid) URLs for one place - and the card's URL
  // therefore did not survive into the itinerary unchanged.
  const entry = {
    status: 'ok', placeId: 'ChIJ_kyoto', verified: true, rating: 4.1, userRatingCount: 5412,
    mapsUri: 'https://maps.google.com/?cid=3103456862751661139',
  };
  const url = L.placeEntryUrl(entry);
  assert.equal(url, 'https://www.google.com/maps/place/?q=place_id:ChIJ_kyoto');
  assert.equal(L.assistMapsLink('Takashimaya Kyoto Store', entry).href, url,
    'the card link is the same URL');
  // The itinerary row renders from the SAME helper (paintTripMapsLink) and,
  // when it has only a saved record, from placeMapsUrl - which is the same form.
  assert.equal(L.placeMapsUrl({ id: 'ChIJ_kyoto' }), url,
    'a row rendering from its saved record produces the identical URL');
});

test('the place ID wins because it is the form we can always produce', () => {
  // Google's caching terms let us keep the place ID indefinitely and forbid
  // keeping `mapsUri`, so a row rendering from its saved record has only the
  // ID. Preferring `mapsUri` anywhere would make that row the odd one out.
  assert.equal(L.placeEntryUrl({ status: 'ok', mapsUri: 'https://maps.google.com/?cid=9' }),
    'https://maps.google.com/?cid=9', 'a pre-placeId server response still links somewhere real');
  assert.equal(L.placeEntryUrl({ status: 'ok', mapsUri: 'javascript:alert(1)' }), '',
    'and a non-http(s) URI never reaches an href');
  assert.equal(L.placeEntryUrl({ status: 'no_match', reason: 'wrong_area' }), '');
  assert.equal(L.placeEntryUrl(null), '');
});
