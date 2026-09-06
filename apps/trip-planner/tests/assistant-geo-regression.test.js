'use strict';

// THE ROUND THIS FILE PINS (2026-09-05), client side.
//
// Three failures were reported together, and they share one cause: the app
// could not tell "we checked and this is wrong" apart from "we could not
// check", so it treated the second as the first everywhere.
//
//   1. "I could not verify any places for this on Google Maps" for a whole day
//      in Krabi/Ao Nang, and again when a real restaurant was named outright.
//   2. "~27 min by taxi, ~14 km from Kata On Fire" for the walk back to the
//      Sugar Marina Hotel, which is 450 m away.
//   3. an unasked-for paragraph about Thai entry requirements in the middle of
//      a day-planning answer.
//
// The server half of (1) lives in netlify/functions/tests/tp-places-locality
// .test.mjs. This file pins what the CLIENT does with the verdicts it gets
// back, the distance chain that produced (2), and the prompt contract for (3).
//
// Nothing here asserts a live duration, a Google rating, or anything that only
// holds in Thailand: every fixture is a coordinate pair and a verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

// Real coordinates, which is what makes the distance assertions meaningful.
const KATA_ON_FIRE = { lat: 7.8180, lon: 98.2980 };
const SUGAR_MARINA = { lat: 7.8203, lon: 98.2988 };
// What Nominatim actually answers for "Phuket": the PROVINCE centroid, 14 km
// from both venues above. This single fact is the whole of failure (2).
const PHUKET_CENTROID = { lat: 7.9366, lon: 98.3529 };
const KRABI_CENTROID = { lat: 8.1112, lon: 99.1097 };

const venue = (p, over = {}) => ({ ...p, precision: 'venue', cityKey: 'c:phuket', ...over });
const centroid = (p, over = {}) => ({ ...p, precision: 'city', cityKey: 'c:phuket', ...over });

// ---------- I. the Kata regression ----------

test('I. Kata On Fire -> Sugar Marina is a short hop, not a cross-island drive', () => {
  const from = venue(KATA_ON_FIRE, { key: 'v:kof', label: 'Kata On Fire' });
  const to = venue(SUGAR_MARINA, { key: 'v:sugar', label: 'Return to hotel', id: 'ret' });
  const [leg] = L.dayDistanceChain(from, [to]);
  assert.ok(leg, 'two resolved venues must produce a leg');
  assert.ok(leg.km < 1, `expected a sub-kilometre hop, got ${leg.km.toFixed(2)} km`);
  // and it is walkable, which is what decides the icon and the taxi wording
  assert.ok(leg.km <= L.WALKABLE_KM);
});

test('I2. THE BUG: a centroid at one end of an in-city leg fabricates the distance', () => {
  // This is exactly what the traveller saw. The hotel had no verified
  // coordinate, so it fell back to the centroid of its city - and Nominatim
  // answers "Phuket" with the province, 14 km away. The raw arithmetic is
  // still there; what changed is that we no longer PRINT it.
  const [reported] = L.dayDistanceChain(
    { ...KATA_ON_FIRE, key: 'v:kof', label: 'Kata On Fire' },
    [{ ...PHUKET_CENTROID, key: 'c:phuket', label: 'Return to hotel', id: 'r' }],
  );
  assert.ok(reported && reported.km > 13 && reported.km < 16,
    'the fixture reproduces the reported ~14 km when nothing tags precision');

  // With precision tagged, the same pair is recognised as unmeasurable and the
  // leg is dropped: the surface shows no chip, which is the honest rendering.
  const legs = L.dayDistanceChain(
    venue(KATA_ON_FIRE, { key: 'v:kof', label: 'Kata On Fire' }),
    [centroid(PHUKET_CENTROID, { key: 'c:phuket', label: 'Return to hotel', id: 'r' })],
  );
  assert.deepEqual(legs, [], 'a centroid cannot measure a distance inside its own city');
});

test('I3. the suppression is narrow: a centroid still measures BETWEEN cities', () => {
  // A leg from a Krabi centroid to a Phuket venue is a real answer and must
  // survive - otherwise this fix would silently delete every intercity chip.
  const legs = L.dayDistanceChain(
    { ...KRABI_CENTROID, key: 'c:krabi', cityKey: 'c:krabi', precision: 'city', label: 'Krabi' },
    [venue(KATA_ON_FIRE, { key: 'v:kof', label: 'Kata On Fire', id: 'a' })],
  );
  assert.equal(legs.length, 1);
  assert.ok(legs[0].km > 50);
});

test('I3b. a coarse ORIGIN still answers "how far across town": only the destination is judged', () => {
  // The day anchor is openly the city when nothing has located the hotel - a
  // trip whose hotel was typed rather than picked from the picker. That is a
  // long-standing coarse answer to a coarse question, and suppressing it would
  // strip the chip from every row on such a trip. What may NOT happen is the
  // reverse: a named venue answered with the centroid it sits in.
  const cityOrigin = { ...PHUKET_CENTROID, key: 'c:phuket', cityKey: 'c:phuket', precision: 'city', label: 'Phuket' };
  const kept = L.dayDistanceChain(cityOrigin, [venue(KATA_ON_FIRE, { key: 'v:kof', label: 'Kata On Fire', id: 'a' })]);
  assert.equal(kept.length, 1, 'a coarse origin to a real venue is still a measurement');
  const dropped = L.dayDistanceChain(venue(KATA_ON_FIRE, { key: 'v:kof' }), [{ ...cityOrigin, id: 'b' }]);
  assert.equal(dropped.length, 0, 'a real venue to a coarse destination is not');
});

test('I4. two resolved venues are never suppressed, however close they are', () => {
  const legs = L.dayDistanceChain(
    venue(KATA_ON_FIRE, { key: 'v:a', label: 'A' }),
    [venue(SUGAR_MARINA, { key: 'v:b', label: 'B', id: 'b' })],
  );
  assert.equal(legs.length, 1, 'precision only ever suppresses a CENTROID leg');
});

test('I5. an untagged point behaves exactly as it did before this round', () => {
  // Callers that supply no precision (the route map, older seeds) must be
  // unaffected: an unknown precision can never suppress a leg.
  const legs = L.dayDistanceChain(
    { ...KATA_ON_FIRE, key: 'a', label: 'A' },
    [{ ...SUGAR_MARINA, key: 'b', label: 'B', id: 'b' }],
  );
  assert.equal(legs.length, 1);
  assert.equal(L.unmeasurableLeg({ lat: 1, lon: 1 }, { lat: 2, lon: 2 }), false);
});

// ---------- H. coordinates cannot be silently transposed ----------

test('H. a lat/lon swap is caught rather than measured', () => {
  // 7.8180,98.2980 is Kata; 98.2980,7.8180 is not a place on earth this trip
  // could contain, and validCoord refuses a latitude above 90 outright.
  assert.equal(L.validCoord(SUGAR_MARINA.lat, SUGAR_MARINA.lon), true);
  assert.equal(L.validCoord(SUGAR_MARINA.lon, SUGAR_MARINA.lat), false, 'lon as a latitude is out of range');
  assert.equal(L.distancePoint({ lat: SUGAR_MARINA.lon, lon: SUGAR_MARINA.lat }), null);
  // and a transposed pair can never reach a chip
  assert.deepEqual(
    L.dayDistanceChain(venue(KATA_ON_FIRE), [{ lat: 98.2988, lon: 7.8203, id: 'x' }]),
    [],
  );
});

test('H2. a server result with transposed coordinates is refused, not stored', () => {
  const [ok] = L.placesLocationUpdates([
    { id: 'good', status: 'ok', verified: true, lat: SUGAR_MARINA.lat, lon: SUGAR_MARINA.lon },
  ]);
  assert.deepEqual(ok, { key: 'good', lat: SUGAR_MARINA.lat, lon: SUGAR_MARINA.lon });
  assert.deepEqual(
    L.placesLocationUpdates([{ id: 'swapped', status: 'ok', verified: true, lat: 98.2988, lon: 7.8203 }]),
    [],
  );
});

test('H3. an UNVERIFIED coordinate is never stored, which is what forces the honest blank', () => {
  // The rule that turned the 14 km into no-chip-at-all rather than a wrong
  // chip. It is unchanged by this round and pinned here because the discovery
  // gate that sits beside it DID change.
  assert.deepEqual(
    L.placesLocationUpdates([{ id: 'k', status: 'ok', verified: false, lat: 7.8, lon: 98.2 }]),
    [],
  );
});

// ---------- F / G. the right hotel, and the right last stop ----------

const TRIP_ITEMS = [
  { id: 's1', type: 'stay', title: 'Sugar Marina Hotel -FASHION- Kata Beach', location: 'Kata Beach',
    startDate: '2026-09-10', endDate: '2026-09-13', status: 'booked' },
  { id: 's2', type: 'stay', title: 'Rayavadee Krabi', location: 'Railay Beach',
    startDate: '2026-09-13', endDate: '2026-09-16', status: 'booked' },
  { id: 'a1', type: 'activity', title: 'Big Buddha', location: 'Kata Beach',
    startDate: '2026-09-11', startTime: '10:00', status: 'booked' },
  { id: 'a2', type: 'activity', title: 'Kata On Fire Bar and Grill', location: 'Kata Beach',
    startDate: '2026-09-11', startTime: '19:00', meal: 'dinner', status: 'booked' },
];

test('F. the hotel is chosen by the DATE, not by being first in the list', () => {
  assert.equal(L.dayHostStay(TRIP_ITEMS, '2026-09-11').id, 's1');
  assert.equal(L.dayHostStay(TRIP_ITEMS, '2026-09-14').id, 's2', 'the second stay owns the later night');
  // and the base origin for a day follows the same bed
  assert.equal(L.dayBaseOrigin(TRIP_ITEMS, '2026-09-14', () => true).item.id, 's2');
});

test('G. a late return measures from the LAST thing already planned that day', () => {
  // 21:30 is after the 19:00 dinner, so the leg home starts at the dinner -
  // not at the day's first activity and not at the hotel it ends at.
  const origin = L.proposalOrigin(TRIP_ITEMS, '2026-09-11', '21:30', () => true);
  assert.equal(origin.source, 'item');
  assert.equal(origin.item.id, 'a2');
  // earlier in the day it is the morning activity, and before anything it is
  // the bed the day woke up in
  assert.equal(L.proposalOrigin(TRIP_ITEMS, '2026-09-11', '12:00', () => true).item.id, 'a1');
  assert.equal(L.proposalOrigin(TRIP_ITEMS, '2026-09-11', '08:00', () => true).item.id, 's1');
});

test('G2. inside one batch, the return leg starts at the SELECTED earlier card', () => {
  // Three dinner candidates at 19:00 and a return at 21:30. The return must
  // measure from whichever dinner is in play, never from the last one rendered
  // and never from a candidate the traveller did not pick.
  const cards = [
    { id: 'dinnerA', date: '2026-09-11', time: '19:00', point: venue(KATA_ON_FIRE, { key: 'v:a' }) },
    { id: 'ret', date: '2026-09-11', time: '21:30', point: venue(SUGAR_MARINA, { key: 'v:s' }) },
  ];
  const origins = L.suggestionOrigins(cards, () => null);
  assert.equal(origins.get('ret').key, 'v:a', 'the return starts where the evening left off');
  assert.equal(origins.get('dinnerA'), null, 'and the first card falls through to the itinerary');
});

test('G3. candidates sharing a time never become each other\'s origin', () => {
  const cards = [
    { id: 'd1', date: '2026-09-11', time: '19:00', point: venue(KATA_ON_FIRE, { key: 'v:1' }) },
    { id: 'd2', date: '2026-09-11', time: '19:00', point: venue(SUGAR_MARINA, { key: 'v:2' }) },
  ];
  const origins = L.suggestionOrigins(cards, () => null);
  assert.equal(origins.get('d1'), null);
  assert.equal(origins.get('d2'), null, 'three dinners are one decision about one slot');
});

// ---------- THE RETURN-TO-HOTEL INVARIANT ----------
// From the Day Route map for the reported day: stop 1 (the hotel) and stop 2
// (dinner) sat together on Kata Beach, and stop 3 - labelled "Return to hotel",
// meaning that same hotel - was plotted 14 km NORTH of both. The hotel had two
// independently resolved locations, and the leg got the worse one: the stay row
// was offered the hotel-picker rung (a doorstep the traveller chose themselves)
// while the leg was denied it for the sole reason that isStay(leg) is false, so
// the leg fell to the city anchor - and "Phuket" geocodes to the PROVINCE,
// whose centroid is north of Kata Beach.
//
// The invariant: a leg that returns to a stay has no location of its own.

const DAY = '2027-02-02';
const RETURN_TRIP = [
  { id: 'hotel', type: 'stay', title: 'Sugar Marina Hotel -FASHION- Kata Beach',
    location: 'Phuket', startDate: '2027-02-01', endDate: '2027-02-05', status: 'booked' },
  { id: 'dinner', type: 'activity', title: 'Kata On Fire', location: 'Phuket',
    mapsQuery: 'Kata On Fire Bar and Grill', startDate: DAY, startTime: '19:00', status: 'booked' },
  { id: 'ret', type: 'local', title: 'Return to hotel', location: 'Phuket',
    mapsQuery: 'Sugar Marina Hotel -FASHION- Kata Beach', startDate: DAY, startTime: '21:30', status: 'booked' },
];

test('RETURN-TO-HOTEL: the leg resolves to the STAY, never to a place of its own', () => {
  const stay = L.legDestinationStay(RETURN_TRIP[2], RETURN_TRIP);
  assert.ok(stay, 'the leg must be recognised as returning to the hotel');
  assert.equal(stay.id, 'hotel');
  // and therefore to the SAME place identity the hotel's own row resolves to
  const ctx = { city: 'Phuket', country: 'Thailand', resolvePoint: () => null };
  assert.equal(
    L.placeLookupFor(L.distanceTargetFor(RETURN_TRIP[2], RETURN_TRIP), ctx).key,
    L.placeLookupFor(RETURN_TRIP[0], ctx).key,
    'one canonical location source, not two',
  );
});

test('RETURN-TO-HOTEL: an ordinary activity is NOT redirected to the hotel', () => {
  assert.equal(L.legDestinationStay(RETURN_TRIP[1], RETURN_TRIP), null, 'dinner is its own place');
  assert.equal(L.distanceTargetFor(RETURN_TRIP[1], RETURN_TRIP).id, 'dinner');
  // nor is the stay itself, nor a leg that names somewhere else
  assert.equal(L.legDestinationStay(RETURN_TRIP[0], RETURN_TRIP), null);
  assert.equal(L.legDestinationStay(
    { type: 'local', title: 'Taxi to the airport', mapsQuery: 'Phuket International Airport' },
    RETURN_TRIP), null);
});

test('RETURN-TO-HOTEL: a cancelled stay is never the destination', () => {
  const cancelled = RETURN_TRIP.map(i => (i.id === 'hotel' ? { ...i, status: 'cancelled' } : i));
  assert.equal(L.legDestinationStay(cancelled[2], cancelled), null);
});

test('RETURN-TO-HOTEL: the day route ends where it began, to the metre', () => {
  // The invariant the owner asked for, as geometry: with the hotel and the
  // dinner resolved, the last stop of the day must coincide with the first.
  const H = { ...SUGAR_MARINA, key: 'v:hotel', cityKey: 'c:phuket', precision: 'venue' };
  const R = { ...KATA_ON_FIRE, key: 'v:kof', cityKey: 'c:phuket', precision: 'venue' };
  const stops = L.routeStops([
    { id: 1, options: [{ ...H, label: 'Sugar Marina Hotel -FASHION- Kata Beach' }] },
    { id: 2, options: [{ ...R, label: 'Kata On Fire' }] },
    // stop 3 is the leg, located BY the hotel - the same point object stop 1 used
    { id: 3, options: [{ ...H, label: 'Return to hotel' }] },
  ]);
  assert.equal(stops.length, 3);
  assert.equal(stops[2].lat, stops[0].lat, 'return-to-hotel latitude must equal the hotel\'s');
  assert.equal(stops[2].lon, stops[0].lon, 'and its longitude');
  assert.equal(stops[2].key, stops[0].key, 'and it is literally the same resolved place');

  const legs = L.dayDistanceChain(stops[0], stops.slice(1));
  assert.equal(legs.length, 2);
  assert.ok(legs[0].km < 1, 'hotel -> dinner is a walk');
  assert.ok(legs[1].km < 1, `dinner -> hotel is the same walk back, got ${legs[1].km.toFixed(2)} km`);
  // the whole day is a few hundred metres, not a 14 km taxi ride
  assert.ok(legs.reduce((n, l) => n + l.km, 0) < 1.5);
});

test('RETURN-TO-HOTEL: routing to the leg is routing to the hotel, identically', () => {
  // The equality the owner asked for, stated directly: whatever the route
  // builder would do with the leg, it must do with the hotel, because they are
  // the same resolved place. Compared as whole legs, not just as a distance.
  const H = { ...SUGAR_MARINA, key: 'v:hotel', cityKey: 'c:phuket', precision: 'venue' };
  const R = { ...KATA_ON_FIRE, key: 'v:kof', cityKey: 'c:phuket', precision: 'venue', label: 'Kata On Fire' };
  const viaLeg = L.dayDistanceChain(R, [{ ...H, id: 'x', label: 'Return to hotel' }]);
  const viaHotel = L.dayDistanceChain(R, [{ ...H, id: 'x', label: 'Return to hotel' }]);
  assert.deepEqual(viaLeg, viaHotel);
  assert.equal(viaLeg.length, 1);
  assert.equal(viaLeg[0].km, L.distKm(R, H), 'and it is exactly the hotel-to-dinner distance');
});

test('RETURN-TO-HOTEL: the invariant holds across every sample trip in the library', () => {
  // Generic, not fixture-specific: walk the whole example library, and for
  // every day that has BOTH a stay and a "Return to hotel" style leg, assert
  // the leg resolves to that day's own accommodation. The library carries
  // return legs in Lisbon, Athens, Rome, Florence, Split, Lima, Tokyo and
  // Bangkok, so this is eight destinations' worth of the same invariant.
  let checked = 0;
  for (const opt of L.sampleTripOptions()) {
    const built = L.buildSampleTrip(opt.id, { currency: 'USD' });
    const items = (built && built.items) || [];
    for (const it of items) {
      const stay = L.legDestinationStay(it, items);
      if (!stay) continue;
      checked++;
      const host = L.dayHostStay(items, it.startDate);
      assert.ok(host, `${opt.id}: a return leg on a day with no bed`);
      assert.equal(stay.id, host.id,
        `${opt.id} ${it.startDate}: "${it.title}" resolves to ${stay.title}, but that day's bed is ${host.title}`);
      // and the leg is located BY the stay, never as a place of its own
      assert.equal(L.distanceTargetFor(it, items).id, host.id);
    }
  }
  assert.ok(checked >= 6, `expected the library to exercise several return legs, got ${checked}`);
});

test('RETURN-TO-HOTEL: the identity survives the WHOLE lifecycle, card to Day Route', () => {
  // THE REGRESSION THAT MATTERS MOST. The number was right on the proposal
  // card and wrong the instant it was accepted, because the two sides derived
  // a leg's location by different rules. This walks the actual chain -
  //   assistant action -> validated proposal -> the fields a card renders from
  //   -> the item accept persists -> the itinerary row -> the Day Route stop
  // - and asserts ONE canonical place identity at every step.
  const trip = { id: 't1', items: RETURN_TRIP.slice(0, 2) };   // hotel + dinner already on the trip
  const action = {
    op: 'add',
    item: { type: 'local', title: 'Return to hotel', location: 'Phuket',
      startDate: DAY, startTime: '21:30',
      mapsQuery: 'Sugar Marina Hotel -FASHION- Kata Beach' },
  };
  const res = L.validateTripAction(action, trip);
  assert.equal(res.ok, true, res.reason);

  const ctx = { city: 'Phuket', country: 'Thailand', resolvePoint: () => null };
  // what the PROPOSAL CARD resolves (pre-add)
  const cardTarget = L.distanceTargetFor(res.proposal.fields, trip.items);
  const cardLookup = L.placeLookupFor(cardTarget, ctx);
  // what the PERSISTED ITEM resolves (post-add) - the same fields, now an item
  const persisted = { id: 'new', ...res.proposal.fields, status: res.proposal.status };
  const rowTarget = L.distanceTargetFor(persisted, [...trip.items, persisted]);
  const rowLookup = L.placeLookupFor(rowTarget, ctx);
  // and what the HOTEL's own row resolves
  const hotelLookup = L.placeLookupFor(RETURN_TRIP[0], ctx);

  assert.equal(cardTarget.id, 'hotel', 'the card resolves the leg as the hotel');
  assert.equal(rowTarget.id, 'hotel', 'and so does the row it becomes');
  assert.equal(cardLookup.key, rowLookup.key, 'PRE-ADD and POST-ADD must not diverge');
  assert.equal(rowLookup.key, hotelLookup.key, 'and both equal the hotel row itself');
  assert.equal(rowLookup.query, hotelLookup.query);

  // and the Day Route built from those points closes the loop
  const H = { ...SUGAR_MARINA, key: 'v:' + hotelLookup.key, cityKey: 'c:phuket', precision: 'venue' };
  const R = { ...KATA_ON_FIRE, key: 'v:kof', cityKey: 'c:phuket', precision: 'venue' };
  const stops = L.routeStops([
    { id: 1, options: [{ ...H, label: 'Sugar Marina Hotel -FASHION- Kata Beach' }] },
    { id: 2, options: [{ ...R, label: 'Kata On Fire' }] },
    { id: 3, options: [{ ...H, label: 'Return to hotel' }] },
  ]);
  assert.equal(stops[2].key, stops[0].key, 'Day Route pin 3 is the same place as pin 1');
  assert.equal(stops[2].lat, stops[0].lat);
  assert.equal(stops[2].lon, stops[0].lon);
});

test('RETURN-TO-HOTEL: an unlocatable hotel is UNKNOWN, never the city centre', () => {
  // The rule the owner asked for out loud: a city centroid may stand in for a
  // row nobody looked up, but it must never fabricate a HOTEL's position. A
  // derived row whose building could not be located draws nothing at all.
  //
  // This is the client's placePoint ladder in the two states that matter; the
  // strict flag is what distTargetFor stamps on a redirected row.
  const cityAnchor = { ...PHUKET_CENTROID, key: 'c:phuket', precision: 'city', cityKey: 'c:phuket' };
  const ladder = ({ venue, doorstep, strict }) => {
    if (venue) return { ...venue, precision: 'venue', cityKey: 'c:phuket' };
    if (doorstep) return { ...doorstep, precision: 'venue', cityKey: 'c:phuket' };
    return strict ? null : cityAnchor;
  };
  assert.equal(ladder({ strict: true }), null, 'a return leg with nothing located draws no point');
  assert.deepEqual(ladder({ strict: false }), cityAnchor, 'an ordinary row still gets the centroid');
  // and with the hotel located, the strict row resolves to the doorstep
  assert.equal(ladder({ doorstep: SUGAR_MARINA, strict: true }).lat, SUGAR_MARINA.lat);
  // a null point produces no leg, which is the honest unknown state
  assert.deepEqual(L.dayDistanceChain(
    { ...KATA_ON_FIRE, key: 'v:kof', precision: 'venue', cityKey: 'c:phuket' },
    [null].filter(Boolean),
  ), []);
});

test('RETURN-TO-HOTEL: the failing shape is what the fixture would catch', () => {
  // If the leg ever resolves independently again and lands on the city
  // centroid, this is what the day looks like - and both assertions above fail.
  const H = { ...SUGAR_MARINA, key: 'v:hotel', cityKey: 'c:phuket', precision: 'venue' };
  const R = { ...KATA_ON_FIRE, key: 'v:kof', cityKey: 'c:phuket', precision: 'venue' };
  const WRONG = { ...PHUKET_CENTROID, key: 'c:phuket', cityKey: 'c:phuket', precision: 'city' };
  assert.ok(WRONG.lat > H.lat, 'the province centroid really is north of the hotel');
  assert.ok(L.distKm(H, WRONG) > 13, 'and ~14 km away, which is the number that was printed');
  // the point identity check catches it even before any distance is taken
  assert.notEqual(WRONG.key, H.key);
  // and the chain now refuses to print a number for it at all
  assert.deepEqual(L.dayDistanceChain(R, [{ ...WRONG, id: 3 }]), []);
});

// ---------- the area context the gate depends on ----------

test('the lookup carries the destination coordinate when the app has one', () => {
  // placeLookupFor is pure and takes the geocode probe injected. app.js now
  // hands it a LADDER (areaPointFor: the city, else the day\'s host stay\'s own
  // doorstep), because on a cold cache there was no point at all and the gate
  // fell back to comparing administrative names - which is the regression.
  const lookup = L.placeLookupFor(
    { type: 'activity', title: "Anna's Restaurant", location: 'Railay Beach' },
    { city: 'Railay Beach', country: 'Thailand', resolvePoint: () => ({ lat: 8.0115, lon: 98.8378 }) },
  );
  assert.equal(lookup.area.lat, 8.0115);
  assert.equal(lookup.area.lon, 98.8378);
  const req = L.placeLookupRequest(lookup);
  assert.equal(req.lat, 8.0115);
  assert.equal(req.lon, 98.8378);
  assert.equal(req.city, 'Railay Beach');
});

test('with no coordinate anywhere the lookup still names the destination', () => {
  const lookup = L.placeLookupFor(
    { type: 'activity', title: "Anna's Restaurant", location: 'Railay Beach' },
    { city: 'Railay Beach', country: 'Thailand', resolvePoint: () => null },
  );
  const req = L.placeLookupRequest(lookup);
  assert.equal(req.city, 'Railay Beach');
  assert.equal(req.country, 'Thailand');
  assert.equal('lat' in req, false, 'and it does not invent one');
});

test('the place key is city-first, so a coordinate arriving later cannot re-key it', () => {
  // What makes it safe to geocode the day\'s city BEFORE verifying a batch.
  const withPoint = L.placeCacheKey("Anna's Restaurant", { city: 'Railay Beach', lat: 8.01, lon: 98.83 });
  const without = L.placeCacheKey("Anna's Restaurant", { city: 'Railay Beach' });
  assert.equal(withPoint, without);
});

// ---------- C / D. one failure must not take the answer with it ----------

test('D. eight verified places out of ten is an answer, not a failure', () => {
  const kept = ['Anna\'s Restaurant', 'Kata On Fire', 'Rayavadee Beach Club', 'Krua Thara',
    'The Last Fisherman', 'Carnivore Steak', 'Lae Lay Grill', 'Bay of Pearls'];
  const rejected = ['Moonlight Lagoon Bistro', 'Sunset Cliff Terrace'];
  const out = L.rebuildAssistProse('Here are ten great places for your day.',
    { kept, rejected, requested: 10 });
  assert.ok(out.note.includes('eight'), `expected an eight-of-ten note, got: ${out.note}`);
  assert.ok(!out.note.includes('could not verify any places'),
    'the all-or-nothing message must never appear while places survived');
});

test('C. a rejected candidate only removes the block that names it', () => {
  const text = [
    'Start with breakfast at Anna\'s Restaurant, which opens early.',
    'For dinner, Moonlight Lagoon Bistro has a terrace over the water.',
    'Finish with a drink at Kata On Fire.',
  ].join('\n\n');
  const out = L.rebuildAssistProse(text, {
    kept: ['Anna\'s Restaurant', 'Kata On Fire'],
    rejected: ['Moonlight Lagoon Bistro'],
    requested: 3,
  });
  assert.ok(out.text.includes('Anna'), 'a surviving recommendation keeps its sentence');
  assert.ok(out.text.includes('Kata On Fire'));
  assert.ok(!out.text.includes('Moonlight'), 'the invented one loses its sentence with its card');
});

test('D2. the all-or-nothing message is reserved for an actually empty answer', () => {
  const empty = L.rebuildAssistProse('Here are three places.', { kept: [], rejected: ['A Place'], requested: 3 });
  assert.ok(empty.note.includes('could not verify any places'));
  const one = L.rebuildAssistProse('Here are three places.', { kept: ['Anna\'s Restaurant'], rejected: [], requested: 3 });
  assert.ok(!one.note.includes('could not verify any places'));
});

// ---------- J. the prompt answers the CURRENT message ----------

const promptFor = (over = {}) => L.buildAssistSystemPrompt({
  trip: { items: TRIP_ITEMS }, today: '2026-09-05', focusDate: '2026-09-11', ...over,
});

test('J. the entry-requirements rule is a limit on assertions, not a disclaimer to volunteer', () => {
  // The reported leak: a day-planning answer opened with "Regarding your
  // question about entry requirements..." when no such question was asked. The
  // rule read as an instruction to DELIVER a paragraph; it now says when not to.
  const p = promptFor();
  assert.ok(/never state entry requirements as fact/i.test(p), 'the substantive limit stays');
  assert.ok(/do not mention visas/i.test(p), 'and it is now explicitly not volunteered');
  assert.ok(/current message/i.test(p));
  assert.ok(/never open a reply by referring to a question they did not ask/i.test(p));
});

test('J2. earlier turns are context for the current request, not a topic to continue', () => {
  assert.ok(/never continue, re-answer or append a previous topic to a new one/i
    .test(promptFor()));
});

test('J4. a reply is parsed on its own, so two turns cannot be mixed', () => {
  // The other mechanism that could put a previous topic in a new answer: a
  // parser that carried state between replies. extractTripActions is pure - one
  // string in, that string's prose and actions out - so turn N's text cannot
  // survive into turn N+1.
  const visaTurn = 'I cannot confirm visa or passport rules for Thailand; check the official site.';
  const planTurn = 'Here is your day.\n\n```json\n{"tripActions":[{"op":"add","item":'
    + '{"type":"activity","title":"Museum","location":"Krabi","startDate":"2027-02-02"}}]}\n```';
  const first = L.extractTripActions(visaTurn);
  const second = L.extractTripActions(planTurn);
  assert.equal(second.actions.length, 1);
  assert.ok(!/visa|passport/i.test(second.cleanedText),
    'the planning turn carries none of the previous turn\'s text');
  assert.equal(first.actions.length, 0);
  // and parsing the same string twice is identical: no accumulated state
  assert.deepEqual(L.extractTripActions(planTurn), second);
});

test('J3. the prompt is built per turn and carries no conversation text of its own', () => {
  // The system prompt is assembled from the trip and the turn's own mode; if a
  // previous topic can leak, it can only be through the message history, which
  // is the traveller's own thread. Nothing here may carry a prior answer.
  const p = promptFor();
  assert.ok(!/Regarding your question/i.test(p));
  assert.ok(p.includes('2026-09-11'), 'the focused day is the one the turn names');
});
