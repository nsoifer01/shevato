// THE 344 KM DAY (owner report, 2026-09-06).
//
// Jan 27 2027, Ko Phi Phi. ChaoKoh Hotel Phi Phi Island -> The Mango Garden is
// a 258 m walk; Google's own directions say 210 m and three minutes. The app
// printed "~344 km", totalled the day as a taxi ride, and plotted the two pins
// on opposite sides of the Gulf of Thailand - while the Maps link on the very
// same row opened the correct restaurant on the correct island.
//
// Both coordinates were wrong, and each came from a different hole:
//
//   THE ORIGIN was the centroid of the string "Ko Phi Phi". Nominatim's first
//     answer for that name is เกาะผี, an islet in Trat Province 606 km away.
//     A guard added in #484 (`standin`) exists precisely to stop a leg being
//     drawn FROM a centroid standing in for a named building - and it had
//     never once fired, because distancePoint rebuilds a point field by field
//     and nobody added `standin` to the list. The same omission emptied every
//     leg's `fromPlaceId`/`toPlaceId`.
//
//   THE DESTINATION was Photon's first answer for "The Mango Garden Ko Phi
//     Phi": a cafe named exactly "The Mango Garden" on Ko Tao, 286 km away.
//     It was stored unchecked because the gate asked for a VOUCHED-FOR city
//     centroid and then let the hit through when there wasn't one - so on
//     every island and beach, where no centroid is ever vouched for, nothing
//     was checked at all.
//
//   AND THE RIGHT ANSWER WAS ALREADY IN HAND. Google had resolved The Mango
//     Garden in full (4.8 from 3,769 reviews) and returned its coordinates.
//     placeRecordFrom threw them away, because the ISLAND's locality could not
//     be corroborated - so the app discarded evidence and then guessed.
//
// The invariants below are the shape of the fix: a resolved place's own point
// is authoritative, no later fallback may stand in for it, and a leg the app
// itself places in one city may never quietly measure hundreds of kilometres.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

const NOW = Date.UTC(2027, 0, 27);

// Real geography, and the two impostors that replaced it.
const CHAOKOH = { lat: 7.7386, lon: 98.7770 };            // the hotel, Tonsai Bay
const MANGO = { lat: 7.7402, lon: 98.7787 };              // the restaurant, 258 m away
const TRAT_ISLET = { lat: 11.823752, lon: 102.446346 };   // Nominatim's "Ko Phi Phi"
const KO_TAO_MANGO = { lat: 10.0941684, lon: 99.8293127 };// Photon's "The Mango Garden"
const MANGO_ID = 'ChIJvb7PGeDeUTARJoM-VdbMTRg';
const HOTEL_ID = 'ChIJChaoKohPhiPhiIsland000';

// A point as app.js placePoint hands it to the chain. Every fixture point gets
// a DISTINCT key unless it deliberately shares one: sameSpot folds two ends
// that came from the same cache entry, which is correct behaviour and would
// otherwise quietly empty a chain a test meant to measure.
let ptN = 0;
const pt = (over) => ({ key: 'k' + (++ptN), label: '', query: '', precision: 'venue', cityKey: 'c:ko phi phi', ...over });

// ---------- 1. the guard that was carried nowhere ----------

test('distancePoint carries every field the leg rules read', () => {
  const p = L.distancePoint(pt({ lat: 11.82, lon: 102.44, precision: 'city', standin: true, placeId: HOTEL_ID }));
  assert.equal(p.standin, true, 'unmeasurableLeg tests a.standin === true and cannot see a field this drops');
  assert.equal(p.placeId, HOTEL_ID, 'dayDistanceChain copies prev.placeId into fromPlaceId');
});

test('a leg may not START on a centroid standing in for a named building', () => {
  // The exact production pair. Both ends claim Ko Phi Phi; the origin is the
  // islet centroid wearing the hotel's name.
  const anchor = pt({ ...TRAT_ISLET, label: 'ChaoKoh Hotel Phi Phi Island', precision: 'city', standin: true });
  const stop = pt({ id: 0, ...KO_TAO_MANGO, label: 'The Mango Garden' });
  assert.equal(L.unmeasurableLeg(L.distancePoint(anchor), L.distancePoint(stop)), true);
  assert.deepEqual(L.dayDistanceChain(anchor, [stop]), [], 'no leg at all beats a 344 km fiction');
});

test('an OPENLY coarse day anchor still starts a leg (no chips were harmed)', () => {
  // A day whose hotel was never located anchors on the city itself, labelled
  // with the city. "~4 km from Krabi" is coarse and true, and #484 kept it.
  const anchor = pt({ ...TRAT_ISLET, label: 'Krabi', precision: 'city', cityKey: 'c:krabi' });
  const stop = pt({ id: 0, lat: 11.83, lon: 102.45, label: 'A cafe', cityKey: 'c:krabi' });
  assert.equal(L.dayDistanceChain(anchor, [stop]).length, 1);
});

test('a leg carries both canonical identities, so its directions link cannot be reinterpreted', () => {
  const anchor = pt({ ...CHAOKOH, label: 'ChaoKoh', placeId: HOTEL_ID });
  const stop = pt({ id: 0, ...MANGO, label: 'The Mango Garden', placeId: MANGO_ID });
  const [leg] = L.dayDistanceChain(anchor, [stop]);
  assert.equal(leg.fromPlaceId, HOTEL_ID);
  assert.equal(leg.toPlaceId, MANGO_ID);
});

// ---------- 2. identity brings its position with it ----------

test('a place that RESOLVED keeps its coordinate even when the area cannot be checked', () => {
  // Ko Phi Phi in one assertion: Google returned the restaurant in full, and
  // no anchor on earth could corroborate the locality.
  const entry = { placeId: MANGO_ID, ...MANGO, verified: false, rating: 4.8, userRatingCount: 3769 };
  const rec = L.placeRecordFrom(entry, { city: 'Ko Phi Phi' }, NOW);
  assert.equal(rec.id, MANGO_ID);
  assert.equal(rec.lat, MANGO.lat, 'the point Google gave for the entity we resolved');
  assert.equal(rec.lon, MANGO.lon);
  assert.equal(rec.verified, undefined, 'still honest about how well corroborated it is');
});

test('a verified place is unchanged, and says so', () => {
  const rec = L.placeRecordFrom({ placeId: MANGO_ID, ...MANGO, verified: true }, { city: 'Ko Phi Phi' }, NOW);
  assert.equal(rec.verified, true);
  assert.equal(rec.lat, MANGO.lat);
});

test('no place ID is still no record: an identity is the price of entry', () => {
  assert.equal(L.placeRecordFrom({ ...MANGO, verified: false }, { city: 'Ko Phi Phi' }, NOW), null);
});

test('the venue cache is fed by resolution, not by corroboration', () => {
  const out = L.placesLocationUpdates([{ id: 'k1', placeId: MANGO_ID, ...MANGO, verified: false }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].lat, MANGO.lat);
});

// ---------- 3. and a TRUSTED anchor may still refuse it ----------

test('the 809 km chip stays dead: a trusted anchor still drops a wrong branch', () => {
  // Royce Tokyo Station resolved to the Hokkaido shop. Tokyo geocodes
  // `confident`, so the app HAS evidence, and evidence still wins.
  const rec = L.normalizePlaceRecord(
    { id: 'ChIJroyce', lat: 43.0621, lon: 141.3544, at: NOW },
    { now: NOW, cityPoint: { lat: 35.6812, lon: 139.7671 } });
  assert.equal(rec.id, 'ChIJroyce', 'the identity survives - it is still the place that resolved');
  assert.equal(rec.lat, undefined, 'the position does not');
});

test('an UNTRUSTED area refuses nothing, because silence is not evidence', () => {
  const rec = L.normalizePlaceRecord({ id: MANGO_ID, ...MANGO, at: NOW }, { now: NOW, cityPoint: null });
  assert.equal(rec.lat, MANGO.lat);
});

test('a coordinate past its 29 days goes; the ID Google lets us keep stays', () => {
  const old = NOW - 31 * 86400000;
  const rec = L.normalizePlaceRecord({ id: MANGO_ID, ...MANGO, at: old }, { now: NOW, cityPoint: null });
  assert.equal(rec.id, MANGO_ID);
  assert.equal(rec.lat, undefined);
});

// ---------- 4. the day itself ----------

test('THE REPORTED DAY: hotel to restaurant is a walk, not a flight', () => {
  const anchor = pt({ ...CHAOKOH, label: 'ChaoKoh Hotel Phi Phi Island', placeId: HOTEL_ID });
  const stop = pt({ id: 0, ...MANGO, label: 'The Mango Garden', placeId: MANGO_ID, key: 'p:' + MANGO_ID });
  const [leg] = L.dayDistanceChain(anchor, [stop]);
  assert.ok(leg, 'the leg is drawn');
  assert.ok(leg.km < 1, `a few hundred metres, got ${leg.km.toFixed(3)} km`);
  assert.equal(leg.suspect, '', 'nothing contradictory about it');
});

test('the day footer totals a walk', () => {
  const anchor = pt({ ...CHAOKOH, label: 'ChaoKoh' });
  const stop = pt({ id: 0, ...MANGO, label: 'The Mango Garden' });
  const totals = L.dayTravelTotals(L.dayDistanceChain(anchor, [stop]));
  assert.equal(totals.byMode.ride, 0, 'no 🚕 344 km in the footer');
  assert.ok(totals.byMode.walk > 0 && totals.byMode.walk < 1);
});

// ---------- 5. impossible geography is named ----------

test('one city and hundreds of kilometres is flagged, not silently drawn', () => {
  const a = L.distancePoint(pt({ ...TRAT_ISLET, precision: 'venue' }));
  const b = L.distancePoint(pt({ ...KO_TAO_MANGO }));
  assert.equal(L.contradictoryPair(a, b), 'same-city-far');
  // and it rides on the leg, so a render can say so
  const [leg] = L.dayDistanceChain(pt({ ...TRAT_ISLET, precision: 'venue' }), [pt({ id: 0, ...KO_TAO_MANGO })]);
  assert.equal(leg.suspect, 'same-city-far');
  assert.ok(Math.round(leg.km) === 344, `the reported number, for the record: ${leg.km.toFixed(1)} km`);
});

test('an ordinary intercity leg is never flagged', () => {
  const a = L.distancePoint(pt({ lat: 8.0863, lon: 98.9063, cityKey: 'c:krabi' }));
  const b = L.distancePoint(pt({ lat: 7.8804, lon: 98.3923, cityKey: 'c:phuket' }));
  assert.equal(L.contradictoryPair(a, b), '', 'two cities genuinely 60 km apart');
});

// ---------- 6. the general case: this is not about Ko Phi Phi ----------

test('GENERIC SMALL ISLAND: a 250 m hop survives the whole lifecycle', () => {
  // No Thai place names, no locality text, no nearby mainland municipality:
  // just a resolved hotel and a resolved restaurant 250 m apart, on an island
  // whose name nothing can corroborate.
  const H = { lat: -0.6000, lon: 73.0000 };
  const R = { lat: -0.6022, lon: 73.0000 }; // ~245 m south
  const area = { city: 'Some Small Island' };

  // resolution -> record (unverified, because the locality cannot be checked)
  const hotelRec = L.placeRecordFrom({ placeId: 'ChIJh', ...H, verified: false }, area, NOW);
  const restRec = L.placeRecordFrom({ placeId: 'ChIJr', ...R, verified: false }, area, NOW);

  // persistence -> reload, with no anchor able to judge either point
  const hotelBack = L.normalizePlaceRecord(hotelRec, { now: NOW, cityPoint: null });
  const restBack = L.normalizePlaceRecord(restRec, { now: NOW, cityPoint: null });
  assert.deepEqual([hotelBack.id, hotelBack.lat, hotelBack.lon], ['ChIJh', H.lat, H.lon]);
  assert.deepEqual([restBack.id, restBack.lat, restBack.lon], ['ChIJr', R.lat, R.lon]);

  // route
  const [leg] = L.dayDistanceChain(
    pt({ ...hotelBack, key: 'p:ChIJh', label: 'The hotel', placeId: hotelBack.id, cityKey: 'c:island' }),
    [pt({ id: 0, ...restBack, key: 'p:ChIJr', label: 'The restaurant', placeId: restBack.id, cityKey: 'c:island' })]);
  assert.ok(leg.km < 1, `still a walk after the round trip, got ${leg.km.toFixed(3)} km`);
  assert.equal(leg.fromPlaceId, 'ChIJh');
  assert.equal(leg.toPlaceId, 'ChIJr');
});

test('LIFECYCLE: the coordinate a card showed is the coordinate the row keeps', () => {
  // proposal -> add -> persist -> reload. The place ID and the point must be
  // the same object at every stage; anything else is the split identity again.
  const entry = { placeId: MANGO_ID, ...MANGO, verified: false };
  const area = { city: 'Ko Phi Phi' };
  const card = L.placeRecordFrom(entry, area, NOW);          // what the card derives
  const added = L.placeRecordFrom(entry, area, NOW);         // what Add to trip writes
  const reloaded = L.normalizePlaceRecord(added, { now: NOW, cityPoint: null });
  for (const [stage, rec] of [['card', card], ['added', added], ['reloaded', reloaded]]) {
    assert.equal(rec.id, MANGO_ID, stage);
    assert.equal(rec.lat, MANGO.lat, stage);
    assert.equal(rec.lon, MANGO.lon, stage);
  }
});

// ---------- 7. the fix that came before this one still holds ----------

test('RETURN TO HOTEL: the day ends where it began, to the metre', () => {
  const hotel = pt({ ...CHAOKOH, key: 'p:' + HOTEL_ID, label: 'ChaoKoh', placeId: HOTEL_ID });
  const stops = [
    pt({ id: 0, ...MANGO, key: 'p:' + MANGO_ID, label: 'The Mango Garden', placeId: MANGO_ID }),
    pt({ id: 1, lat: 7.7434, lon: 98.7712, key: 'v:loh-dalum', label: 'Loh Dalum Beach' }),
    // the return leg is located BY the stay (app.js legDestStay), so it is the
    // same point, the same key and the same identity as the anchor
    pt({ id: 2, ...CHAOKOH, key: 'p:' + HOTEL_ID, label: 'Return to hotel', placeId: HOTEL_ID }),
  ];
  const legs = L.dayDistanceChain(hotel, stops);
  const back = legs.find(l => l.id === 2);
  assert.ok(back, 'the return leg is drawn');
  assert.equal(back.toPlaceId, HOTEL_ID, 'and it ends at the hotel the day started from');
  assert.ok(back.km < 1, `a walk home, got ${back.km.toFixed(3)} km`);
  assert.ok(legs.every(l => !l.suspect), 'nothing on this day contradicts itself');
});

// ---------- 8. a resolution the traveller TYPED is durable too ----------
// Owner report, 2026-09-06, read off their own synced trip: every activity on
// the Ko Phi Phi day carried a canonical record and the stay they had typed
// carried `place: NONE`. `attachResolvedPlace` runs on the assistant's accept
// path and nowhere else, so a hand-added stay - the anchor of every day - never
// kept the identity the app had already paid Google for. It re-resolved from a
// text query on every load, and until that landed the day had no anchor.
//
// The client half (persistResolvedPlaces) lives in app.js and is covered by
// e2e/canonical-coordinates.mjs block C. What is pinned here is the rule it
// leans on: the record a background lookup would write for a typed stay is
// exactly the record an accepted suggestion writes, so the two paths cannot
// drift into storing different things about the same place.

test('a typed stay and an accepted suggestion store the SAME record', () => {
  const entry = { status: 'ok', placeId: HOTEL_ID, ...CHAOKOH, verified: false, rating: 4.1 };
  const area = { city: 'Ko Phi Phi' };
  const viaAccept = L.placeRecordFrom(entry, area, NOW);   // attachResolvedPlace
  const viaLookup = L.placeRecordFrom(entry, area, NOW);   // persistResolvedPlaces
  assert.deepEqual(viaAccept, viaLookup);
  assert.equal(viaAccept.id, HOTEL_ID);
  assert.equal(viaAccept.lat, CHAOKOH.lat, 'the anchor of the day keeps its own coordinate');
});

test('re-resolving an unchanged place produces an identical record but for `at`', () => {
  // persistResolvedPlaces compares everything EXCEPT `at` before writing, so a
  // warm repaint cannot rewrite the trip and wake the sync layer on every
  // ratings response.
  const entry = { status: 'ok', placeId: HOTEL_ID, ...CHAOKOH, verified: false };
  const first = L.placeRecordFrom(entry, { city: 'Ko Phi Phi' }, NOW);
  const later = L.placeRecordFrom(entry, { city: 'Ko Phi Phi' }, NOW + 3600000);
  assert.notEqual(first.at, later.at, 'the timestamp does move');
  for (const k of ['id', 'lat', 'lon', 'city', 'verified']) {
    assert.equal(first[k], later[k], `${k} is identity, not freshness`);
  }
});

test('a typed stay whose city IS trusted still refuses a wrong branch', () => {
  // The typed-stay path must not become a way around the area gate.
  const rec = L.placeRecordFrom(
    { status: 'ok', placeId: 'ChIJwrong', lat: 43.0621, lon: 141.3544, verified: false },
    { city: 'Tokyo' }, NOW);
  const read = L.normalizePlaceRecord(rec, { now: NOW, cityPoint: { lat: 35.6812, lon: 139.7671 } });
  assert.equal(read.id, 'ChIJwrong');
  assert.equal(read.lat, undefined, 'a hand-typed row gets no exemption from the 150 km gate');
});
