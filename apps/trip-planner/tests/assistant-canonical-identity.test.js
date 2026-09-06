// THE CLIENT HALF of the 2026-09-05 round: the invariants that hold a place's
// identity together from the moment a lookup resolves it to the moment a
// reloaded itinerary draws a route to it.
//
// The three production failures this file exists for:
//
//   A. THE ANCHOR. The app fed the resolver a coordinate for "Ko Phi Phi" that
//      was 570 km wrong, so every real venue on the island was refused and the
//      whole day came back empty. The app had ALREADY scored that geocode
//      `low` and never read the score. This boundary had no test at all,
//      because the decision lived in app.js, which node cannot load - so it
//      now lives in trip-logic as a pure function with injected cache readers,
//      and the tests below are the reason it moved.
//
//   B. THE IDENTITY. A resolved place whose branch could not be confirmed was
//      persisted as nothing, so Add to trip silently threw away the place ID
//      of a correctly identified venue and the row re-resolved itself by name
//      on every reload.
//
//   C. THE STORY THE UI TOLD. "No rating match" was printed for four different
//      answers at once, including next to a Google Maps link that opens the
//      correct restaurant.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

const NOW = Date.UTC(2027, 0, 27);

// The two coordinates the whole story turns on.
const PHI_PHI = { lat: 7.7390, lon: 98.7714 };          // the real island
const TRAT_ISLET = { lat: 11.8237522, lon: 102.4463456 }; // what Nominatim says
const HOTEL_DOORSTEP = { lat: 7.7412, lon: 98.7736 };     // the traveller's stay

// A cache reader pair for areaAnchorFor. `cities` maps a lowercased name to a
// geocode entry (with the confidence the classifier gave it); `venues` maps a
// place key to a coordinate the venue cache holds.
const io = (cities = {}, venues = {}) => ({
  cityPoint: name => cities[String(name || '').trim().toLowerCase()] || null,
  venuePoint: key => venues[key] || null,
});

const stay = (over = {}) => ({
  id: 's1', type: 'stay', title: 'Phi Phi Bayview Resort', location: 'Ko Phi Phi',
  startDate: '2027-01-26', endDate: '2027-01-29', ...over,
});

// ---------- A. the anchor ----------

test('ANCHOR: a geocode the app itself scored `low` may not reject anything', () => {
  // This is the production repro in one line. "Ko Phi Phi" is in the cache,
  // with a real coordinate, 570 km from the island - and classifyGeoMatch
  // called it `low` when it was written.
  const cities = { 'ko phi phi': { ...TRAT_ISLET, conf: 'low', key: 'c:ko phi phi' } };
  assert.equal(L.areaAnchorFor('Ko Phi Phi', 'Ko Phi Phi', [], '2027-01-27', io(cities)), null,
    'no anchor at all, so the resolver reports "could not check" instead of "checked and wrong"');
});

test('ANCHOR: `ambiguous` is not evidence either', () => {
  const cities = { 'phi phi don': { lat: 14.25, lon: 100.32, conf: 'ambiguous', key: 'c:phi phi don' } };
  assert.equal(L.areaAnchorFor('Phi Phi Don', 'Phi Phi Don', [], '2027-01-27', io(cities)), null);
});

test('ANCHOR: a vouched-for centroid still anchors, so ordinary cities are untouched', () => {
  const cities = { tokyo: { lat: 35.6768, lon: 139.7639, conf: 'confident', key: 'c:tokyo' } };
  const p = L.areaAnchorFor('Tokyo', 'Tokyo', [], '2027-01-27', io(cities));
  assert.equal(p.lat, 35.6768);
});

test('ANCHOR: the day\'s own hotel outranks any centroid, however confident', () => {
  // The traveller picked this hotel from the picker, which seeds the geocode
  // cache under the hotel's own name and marks it confident. It is a building,
  // the centroid is a polygon's middle, and the hotel is where the day starts.
  const s = stay();
  const cities = {
    'ko phi phi': { ...TRAT_ISLET, conf: 'confident', key: 'c:ko phi phi' },
    'phi phi bayview resort': { ...HOTEL_DOORSTEP, conf: 'confident', key: 'c:phi phi bayview resort' },
  };
  const p = L.areaAnchorFor('Ko Phi Phi', 'Ko Phi Phi', [s], '2027-01-27', io(cities));
  assert.equal(p.lat, HOTEL_DOORSTEP.lat);
});

test('ANCHOR: the venue cache is the other way a stay can produce a doorstep', () => {
  // A hotel typed rather than picked has no geocode entry of its own, but
  // Photon or an earlier Places resolution may have pinned it in the venue
  // cache under the stay's own area-aware key.
  const s = stay();
  const key = L.placeCacheKey(L.itemMapsQuery(s), { city: 'Ko Phi Phi' });
  const cities = { 'ko phi phi': { ...TRAT_ISLET, conf: 'low', key: 'c:ko phi phi' } };
  const p = L.areaAnchorFor('Ko Phi Phi', 'Ko Phi Phi', [s], '2027-01-27', io(cities, { [key]: HOTEL_DOORSTEP }));
  assert.equal(p.lat, HOTEL_DOORSTEP.lat);
});

test('ANCHOR: the hotel rung is refused to an item that named a city of its own', () => {
  // "Nikko" on a Tokyo-based day is a claim about Nikko. Answering it with
  // Tokyo's hotel would check the wrong place entirely.
  const s = { ...stay(), title: 'Hotel Okura Tokyo', location: 'Tokyo' };
  const cities = { 'hotel okura tokyo': { lat: 35.6672, lon: 139.7414, conf: 'confident', key: 'c:hotel okura tokyo' } };
  assert.equal(L.areaAnchorFor('Nikko', 'Tokyo', [s], '2027-01-27', io(cities)), null);
});

test('ANCHOR: the hotel is chosen BY DATE, not by whichever was saved first', () => {
  const a = stay({ id: 'a', title: 'Hotel A', startDate: '2027-01-01', endDate: '2027-01-04' });
  const b = stay({ id: 'b', title: 'Hotel B', startDate: '2027-01-04', endDate: '2027-01-07' });
  const cities = {
    'ko phi phi': { ...TRAT_ISLET, conf: 'low', key: 'c:ko phi phi' },
    'hotel a': { lat: 1, lon: 1, conf: 'confident', key: 'c:hotel a' },
    'hotel b': { lat: 2, lon: 2, conf: 'confident', key: 'c:hotel b' },
  };
  assert.equal(L.areaAnchorFor('Ko Phi Phi', 'Ko Phi Phi', [a, b], '2027-01-02', io(cities)).lat, 1);
  assert.equal(L.areaAnchorFor('Ko Phi Phi', 'Ko Phi Phi', [a, b], '2027-01-05', io(cities)).lat, 2);
});

test('ANCHOR: nothing in the cache is not a reason to invent one', () => {
  assert.equal(L.areaAnchorFor('Ko Phi Phi', 'Ko Phi Phi', [], '2027-01-27', io({})), null);
  assert.equal(L.areaAnchorFor('', '', [], '', io({})), null);
});

// ---------- INVARIANT 5 / 22: return-to-hotel is the day's hotel ----------

test('INVARIANT: a return leg resolves to the stay that hosts ITS OWN date', () => {
  const a = stay({ id: 'a', title: 'Hotel A', startDate: '2027-01-01', endDate: '2027-01-04' });
  const b = stay({ id: 'b', title: 'Hotel B', startDate: '2027-01-04', endDate: '2027-01-07' });
  const legOn5 = { id: 'l', type: 'local', title: 'Return to hotel', mapsQuery: 'Hotel B', startDate: '2027-01-05' };
  assert.equal(L.legDestinationStay(legOn5, [a, b]).id, 'b');
});

test('INVARIANT: a leg copied to another date cannot drag the old hotel with it', () => {
  // "Copy to another date" clones a leg verbatim, so a return leg written for
  // Hotel A's day arrives on Hotel B's day still naming Hotel A. Matching by
  // name alone pinned that day in the wrong city, and nothing said so.
  const a = stay({ id: 'a', title: 'Grand Hotel', location: 'Krabi', startDate: '2027-01-01', endDate: '2027-01-04' });
  const b = stay({ id: 'b', title: 'Grand Hotel', location: 'Phuket', startDate: '2027-01-04', endDate: '2027-01-07' });
  const copied = { id: 'l', type: 'local', title: 'Return to hotel', mapsQuery: 'Grand Hotel', startDate: '2027-01-05' };
  const resolved = L.legDestinationStay(copied, [a, b]);
  assert.equal(resolved.id, 'b', 'the same chain twice resolves by DATE, never by insertion order');
  assert.equal(resolved.location, 'Phuket');
});

test('a leg on a date no stay covers still resolves to the stay it names', () => {
  const a = stay({ id: 'a', title: 'Hotel A', startDate: '2027-01-01', endDate: '2027-01-04' });
  const orphan = { id: 'l', type: 'local', title: 'Return to hotel', mapsQuery: 'Hotel A', startDate: '2027-02-20' };
  assert.equal(L.legDestinationStay(orphan, [a]).id, 'a');
});

test('a leg that names nothing on the trip is not a stay', () => {
  const a = stay({ id: 'a', title: 'Hotel A' });
  assert.equal(L.legDestinationStay({ type: 'local', title: 'Airport transfer', mapsQuery: 'Krabi Airport', startDate: '2027-01-02' }, [a]), null);
});

// ---------- INVARIANT: a centroid is not a measurement, at either end ----------

const pt = (lat, lon, over = {}) => ({ lat, lon, key: 'k', cityKey: 'c:phuket', precision: 'venue', label: 'X', ...over });

test('INVARIANT: a centroid standing in for a NAMED venue cannot start a leg', () => {
  // The 14 km phantom, with the roles swapped: an unresolved activity fell to
  // the province centroid, became the origin of "Return to hotel", and the card
  // read "~27 min by taxi" for a 450 m walk.
  const standin = pt(7.9366, 98.3529, { precision: 'city', standin: true, label: 'Kata On Fire' });
  const hotel = pt(7.8203, 98.2988, { key: 'v:sugar', label: 'Sugar Marina' });
  assert.equal(L.unmeasurableLeg(standin, hotel), true);
});

test('a day anchor that is OPENLY the city still measures across town', () => {
  // The long-standing coarse answer to a coarse question. It is labelled with
  // the city, the traveller can see what it is, and suppressing it would strip
  // the chip from every trip whose hotel was typed rather than picked.
  const cityAnchor = pt(7.9366, 98.3529, { precision: 'city', label: 'Phuket' });
  const venue = pt(7.8203, 98.2988, { key: 'v:kof', label: 'Kata On Fire' });
  assert.equal(L.unmeasurableLeg(cityAnchor, venue), false);
});

test('a leg ENDING on a centroid inside its own city is still refused', () => {
  const venue = pt(7.8203, 98.2988, { key: 'v:kof' });
  const centroid = pt(7.9366, 98.3529, { precision: 'city' });
  assert.equal(L.unmeasurableLeg(venue, centroid), true);
});

test('two centroids in DIFFERENT cities are a real intercity measurement', () => {
  const a = pt(7.9366, 98.3529, { precision: 'city', standin: true, cityKey: 'c:phuket' });
  const b = pt(8.0863, 98.9063, { precision: 'city', cityKey: 'c:krabi' });
  assert.equal(L.unmeasurableLeg(a, b), false);
});

// ---------- INVARIANT 2: identity survives proposal -> add -> reload ----------

test('INVARIANT: a resolved place keeps its identity through the persistence boundary', () => {
  const entry = { status: 'ok', placeId: 'ChIJmango', verified: true, rating: 4.8, userRatingCount: 3770,
    name: 'The Mango Garden', lat: PHI_PHI.lat, lon: PHI_PHI.lon };
  // 1. what Add to trip writes
  const saved = L.placeRecordFrom(entry, { city: 'Ko Phi Phi' }, NOW);
  assert.equal(saved.id, 'ChIJmango');
  // 2. what a reload reads back, with the item's own city as the sanity anchor
  const reloaded = L.normalizePlaceRecord(saved, { now: NOW, cityPoint: PHI_PHI });
  assert.equal(reloaded.id, 'ChIJmango', 'the same entity, after a round trip through storage');
  assert.equal(reloaded.lat, PHI_PHI.lat);
  // 3. and every link built from it names that entity, not a text search
  assert.equal(L.placeMapsUrl(reloaded), 'https://www.google.com/maps/place/?q=place_id:ChIJmango');
  assert.equal(L.placeEntryUrl(entry), L.placeMapsUrl(reloaded),
    'the card and the reloaded row link at the same place, in the same form');
});

// REVISED 2026-09-06. This used to assert that an unconfirmed branch loses its
// coordinate, and Anna's Restaurant is the case that shows why that was wrong:
// it is on Ko Phi Phi, where NOTHING can confirm a locality, so the rule threw
// away the right point on every island in the world and let a global name
// search supply a wrong one. The identity keeps its position; a trusted anchor
// is what may take it away (see place-resolution's 809 km test).
test('INVARIANT: an unconfirmed branch keeps both claims, and says which was checked', () => {
  const entry = { status: 'ok', placeId: 'ChIJannas', verified: false, rating: 4.7, lat: PHI_PHI.lat, lon: PHI_PHI.lon };
  const saved = L.placeRecordFrom(entry, { city: 'Ko Phi Phi' }, NOW);
  assert.equal(saved.id, 'ChIJannas', 'the venue is still identified, and the next turn can exclude it');
  assert.equal(saved.lat, PHI_PHI.lat, 'and it is still where Google says it is');
  assert.equal(saved.verified, undefined, 'while staying honest that the area was never corroborated');
  assert.equal(L.placeMapsUrl(saved), 'https://www.google.com/maps/place/?q=place_id:ChIJannas');
});

test('INVARIANT: displayed name and displayed rating come from ONE cache entry', () => {
  // The 2026-08-27 shape - a card keyed on one string and a row on another -
  // cannot recur while both read placesCacheUpdates' single entry per key.
  const updates = L.placesCacheUpdates([{
    id: 'the mango garden ko phi phi@ko phi phi', status: 'ok', name: 'The Mango Garden',
    rating: 4.8, userRatingCount: 3770, mapsUri: 'https://maps.google.com/?cid=1751281051042218790',
    placeId: 'ChIJmango', verified: true, lat: PHI_PHI.lat, lon: PHI_PHI.lon,
  }]);
  assert.equal(updates.length, 1);
  const e = updates[0].entry;
  assert.equal(e.name, 'The Mango Garden');
  assert.equal(e.rating, 4.8);
  assert.equal(e.userRatingCount, 3770);
  assert.equal(e.placeId, 'ChIJmango');
  assert.equal(L.placeEntryUrl(e), 'https://www.google.com/maps/place/?q=place_id:ChIJmango');
});

test('lat and lon cannot be swapped anywhere along the way', () => {
  const e = L.placesCacheUpdates([{ id: 'k', status: 'ok', name: 'X', rating: 4, userRatingCount: 1,
    mapsUri: 'https://maps.google.com/?cid=1', placeId: 'p', verified: true,
    lat: PHI_PHI.lat, lon: PHI_PHI.lon }])[0].entry;
  assert.ok(Math.abs(e.lat) < 20 && Math.abs(e.lon) > 90, 'Thailand is 7N 98E, never 98N 7E');
  const rec = L.placeRecordFrom(e, { city: 'Ko Phi Phi' }, NOW);
  assert.equal(rec.lat, PHI_PHI.lat);
  assert.equal(rec.lon, PHI_PHI.lon);
});

// ---------- INVARIANT 10: the model can never supply a rating ----------

test('INVARIANT: a model-written rating, review count or hours cannot reach an item', () => {
  const hostile = {
    op: 'add',
    item: {
      type: 'activity', title: 'Dinner: Nowhere', location: 'Ko Phi Phi',
      startDate: '2027-01-27', startTime: '19:00', mapsQuery: 'Nowhere Ko Phi Phi',
      // everything below is invented and must be dropped at the boundary
      rating: 5, userRatingCount: 99999, googleRating: 4.9, reviewCount: 1234,
      hours: { always: true }, openingHours: 'always open', placeId: 'ChIJfake',
      place: { id: 'ChIJfake', lat: 0, lon: 0 }, lat: 0, lon: 0,
      mapsUri: 'https://maps.google.com/?cid=999', verified: true,
    },
  };
  const res = L.validateTripAction(hostile, { id: 't', items: [] });
  assert.equal(res.ok, true);
  for (const k of ['rating', 'userRatingCount', 'googleRating', 'reviewCount', 'hours',
    'openingHours', 'placeId', 'place', 'lat', 'lon', 'mapsUri', 'verified']) {
    assert.equal(res.proposal.fields[k], undefined, `${k} must never survive the action allowlist`);
    assert.equal(res.proposal.display[k], undefined, `${k} must never reach the display bag either`);
  }
  assert.equal(res.proposal.fields.title, 'Nowhere', 'while the real fields come through');
  assert.equal(res.proposal.fields.meal, 'dinner');
});

// ---------- INVARIANT: the UI says which thing is missing ----------

test('INVARIANT: a resolved place never reads as "we could not find this"', () => {
  // The exact complaint: The Mango Garden, a correct Google Maps link, and
  // "No rating match" printed beside it.
  const resolvedNoStar = L.placeStateLabel({ status: 'no_match', reason: 'unrated', placeId: 'ChIJmango', verified: true });
  assert.equal(resolvedNoStar.text, 'No rating yet');
  assert.equal(resolvedNoStar.resolved, true);
  // and the same is true when the BRANCH could not be confirmed: the identity
  // is still an identity.
  const unconfirmed = L.placeStateLabel({ status: 'no_match', reason: 'unrated', placeId: 'ChIJmango', verified: false });
  assert.equal(unconfirmed.text, 'No rating yet');
  assert.equal(unconfirmed.resolved, true);
});

test('the four unresolved answers are four different sentences', () => {
  const say = (reason, extra = {}) => L.placeStateLabel({ status: 'no_match', reason, ...extra });
  assert.equal(say('wrong_area').text, 'Different city');
  assert.equal(say('type_mismatch').text, 'Different kind of place');
  assert.equal(say('unattributable').text, 'Rating unavailable');
  assert.equal(say('low_confidence').text, 'Not found on Google');
  assert.equal(say('not_found').text, 'Not found on Google');
  for (const r of ['wrong_area', 'type_mismatch', 'unattributable', 'low_confidence', 'not_found']) {
    assert.equal(say(r).resolved, false);
    assert.ok(say(r).why.length > 20, 'each state explains itself on hover');
  }
  assert.equal(L.placeStateLabel({ status: 'ok', rating: 4.8 }), null, 'a rated place is not a state label at all');
  assert.equal(L.placeStateLabel(null), null);
  assert.equal(L.placeStateLabel({ status: 'unavailable' }), null, 'transient, so the slot stays empty and may fill later');
});

test('a resolved place is OPENED on Google Maps; only an unresolved one is "verified"', () => {
  const opened = L.assistMapsLink('The Mango Garden Ko Phi Phi', { status: 'ok', placeId: 'p', verified: true, rating: 4.8 });
  assert.equal(opened.label, '\u{1F4CD} Open on Google Maps');
  assert.match(opened.href, /place_id:p/);
  const unverified = L.assistMapsLink('The Mango Garden Ko Phi Phi', { status: 'ok', placeId: 'p', verified: false, rating: 4.8 });
  assert.match(unverified.href, /place_id:p/, 'still the entity, never a search');
  const nothing = L.assistMapsLink('The Mango Garden Ko Phi Phi', undefined);
  assert.equal(nothing.resolved, false);
  assert.match(nothing.href, /maps\/search/);
});

// ---------- INVARIANT 6: a provider failure is not a verdict about the world ----------

test('INVARIANT: a lookup that never ran says so, instead of reporting an empty area', () => {
  for (const failure of ['timeout', 'network', 'upstream', 'quota', 'off', 'malformed']) {
    const { note } = L.rebuildAssistProse('Here are three great spots.', {
      kept: [], rejected: [], requested: 3, providerFailure: failure,
    });
    assert.ok(note, `${failure} must produce a note`);
    assert.ok(!/could not verify any places/i.test(note),
      `${failure} must never be reported as a verdict about the place`);
    assert.match(note, /check|confirm/i, 'it talks about the CHECK, not about the island');
  }
});

test('a genuine shortfall still reads as a shortfall', () => {
  const { note } = L.rebuildAssistProse('Three great spots.', { kept: ['A'], rejected: ['B', 'C'], requested: 3 });
  assert.match(note, /one good match/i);
  const empty = L.rebuildAssistProse('Three great spots.', { kept: [], rejected: ['B'], requested: 3 });
  assert.match(empty.note, /could not verify any places/i);
});

// ---------- INVARIANT: the day the assistant wrote has to be possible ----------

test('INVARIANT: travel time alone is compared with the clock, and nothing else is guessed', () => {
  const clash = L.impossibleHops([
    { time: '12:30', label: 'Lunch', ...PHI_PHI },
    { time: '12:40', label: 'Viewpoint', lat: 7.79, lon: 98.72 },
  ]);
  assert.equal(clash.length, 1);
  assert.equal(clash[0].to, 'Viewpoint');
  assert.ok(clash[0].needMin > clash[0].haveMin);
  assert.match(clash[0].text, /Viewpoint is about .* away but is scheduled/);
});

test('a hop too long to be local is judged too, at the fastest mode there is', () => {
  const clash = L.impossibleHops([
    { time: '09:00', label: 'Breakfast', ...PHI_PHI },
    { time: '09:10', label: 'Phuket sight', lat: 8.30, lon: 98.30 },
  ]);
  assert.equal(clash.length, 1, '81 km in ten minutes is impossible by every mode the app knows');
});

test('a comfortable day, an unlocated stop and a timeless stop all pass in silence', () => {
  assert.deepEqual(L.impossibleHops([
    { time: '12:30', label: 'A', ...PHI_PHI },
    { time: '15:00', label: 'B', lat: 7.79, lon: 98.72 },
  ]), []);
  assert.deepEqual(L.impossibleHops([{ time: '12:30', label: 'A' }, { time: '12:35', label: 'B' }]), [],
    'an unlocated stop is not evidence of anything');
  assert.deepEqual(L.impossibleHops([{ label: 'A', ...PHI_PHI }, { label: 'B', lat: 7.79, lon: 98.72 }]), []);
  assert.deepEqual(L.impossibleHops(null), []);
});

test('stops are judged in CLOCK order, whatever order they arrive in', () => {
  const out = L.impossibleHops([
    { time: '12:40', label: 'Second', lat: 7.79, lon: 98.72 },
    { time: '12:30', label: 'First', ...PHI_PHI },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, 'First');
});

// ---------- the wire contract ----------

test('the meal slot travels to the resolver but is NOT part of the cache key', () => {
  const item = { type: 'activity', meal: 'breakfast', title: 'The Mango Garden',
    location: 'Ko Phi Phi', mapsQuery: 'The Mango Garden Ko Phi Phi' };
  const lookup = L.placeLookupFor(item, { city: 'Ko Phi Phi', country: 'Thailand', resolvePoint: () => PHI_PHI });
  assert.equal(lookup.meal, 'breakfast');
  assert.equal(L.placeLookupRequest(lookup).meal, 'breakfast');
  // one venue, one key, one billed lookup - whatever slot it was filed under
  const noMeal = L.placeLookupFor({ ...item, meal: '' }, { city: 'Ko Phi Phi', country: 'Thailand', resolvePoint: () => PHI_PHI });
  assert.equal(lookup.key, noMeal.key);
});

test('a directions link carries the canonical identity of both ends when it has one', () => {
  const url = L.directionsUrl('Sugar Marina', 'Kata On Fire', 'walking',
    { origin: 'ChIJsugar', destination: 'ChIJkata' });
  assert.match(url, /origin_place_id=ChIJsugar/);
  assert.match(url, /destination_place_id=ChIJkata/);
  assert.match(url, /travelmode=walking/);
  // and a row nobody resolved links exactly as it always did
  const plain = L.directionsUrl('Sugar Marina', 'Kata On Fire', 'walking');
  assert.ok(!plain.includes('place_id'));
  assert.match(plain, /destination=Kata%20On%20Fire/);
});
