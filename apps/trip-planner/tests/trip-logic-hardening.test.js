'use strict';

// Added by the 2026-08-15 testing-strategy hardening round: pins for exported
// trip-logic surfaces that had no unit coverage. Four areas:
//   - legTravelMode + directionsUrl (the card's mode judgement and the Maps
//     link must AGREE - the FINDINGS invariant "a card cannot promise a walk
//     and hand over driving")
//   - isPlaceType / isTravelLeg (the venue-vs-leg split that decides ratings
//     vs Directions)
//   - leap-day spans: nights / coverageGaps / dayCards / spendByWeek fixtures
//     crossing 2028-02-29 (all four are pure string-date math with no
//     local-clock reader, so no TZ pinning is needed; localDateIso is the only
//     local-clock reader in the module and has its own zoned tests)
//   - normalizeTripName, templateItem, hotelScore + the HOTEL_*_BONUS
//     calibration constants

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

// ---------- legTravelMode ----------

test('legTravelMode: flights and transport open directions in driving', () => {
  assert.equal(L.legTravelMode('flight', 0.4), 'driving');
  assert.equal(L.legTravelMode('flight', null), 'driving');
  assert.equal(L.legTravelMode('transport', 550), 'driving');
});

test('legTravelMode: a short local hop is walked, up to and including WALKABLE_KM', () => {
  assert.equal(L.legTravelMode('local', 0.3), 'walking');
  assert.equal(L.legTravelMode('local', L.WALKABLE_KM), 'walking');
});

test('legTravelMode: a local hop past WALKABLE_KM rides transit', () => {
  assert.equal(L.legTravelMode('local', L.WALKABLE_KM + 0.1), 'transit');
  assert.equal(L.legTravelMode('local', 14), 'transit');
});

test('legTravelMode: a local hop nothing located yet defaults to transit, never a guessed walk', () => {
  assert.equal(L.legTravelMode('local', null), 'transit');
  assert.equal(L.legTravelMode('local', undefined), 'transit');
});

// ---------- directionsUrl ----------

test('directionsUrl: no destination means no link at all', () => {
  assert.equal(L.directionsUrl('Somewhere', '', 'walking'), '');
  assert.equal(L.directionsUrl('Somewhere', '   ', 'walking'), '');
  assert.equal(L.directionsUrl('Somewhere', null, 'walking'), '');
});

test('directionsUrl: an omitted origin produces a destination-only link (Maps asks for the start)', () => {
  const url = L.directionsUrl('', 'Sotetsu Grand Fresa Bangkok', 'walking');
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1'));
  assert.ok(!url.includes('origin='));
  assert.ok(url.includes('destination=Sotetsu%20Grand%20Fresa%20Bangkok'));
  assert.ok(url.includes('travelmode=walking'));
});

test('directionsUrl: origin and destination are both URL-encoded', () => {
  const url = L.directionsUrl('Above Eleven Bangkok', 'Hotel & Spa, Kyoto', 'transit');
  assert.ok(url.includes('origin=Above%20Eleven%20Bangkok'));
  assert.ok(url.includes('destination=Hotel%20%26%20Spa%2C%20Kyoto'));
});

test('directionsUrl: an unknown mode falls back to transit, never leaks into the URL', () => {
  for (const bad of ['flying', 'WALKING', '', null, undefined]) {
    const url = L.directionsUrl('A', 'B', bad);
    assert.ok(url.includes('travelmode=transit'), `mode ${JSON.stringify(bad)} -> ${url}`);
  }
});

test('invariant: whatever mode legTravelMode judges, directionsUrl links that exact mode', () => {
  // The chip's judgement and the link must agree (FINDINGS): every value
  // legTravelMode can produce is accepted verbatim by directionsUrl.
  const cases = [
    ['flight', 3], ['transport', 300], ['local', 0.5], ['local', null], ['local', 9],
  ];
  for (const [type, km] of cases) {
    const mode = L.legTravelMode(type, km);
    const url = L.directionsUrl('A', 'B', mode);
    assert.ok(url.includes(`travelmode=${mode}`), `${type}/${km} judged ${mode} but linked ${url}`);
  }
});

// ---------- isPlaceType / isTravelLeg ----------

test('isPlaceType and isTravelLeg split the six types with no overlap', () => {
  const expectations = {
    stay: { place: true, leg: false },
    activity: { place: true, leg: false },
    flight: { place: false, leg: true },
    transport: { place: false, leg: true },
    local: { place: false, leg: true },
    note: { place: false, leg: false }, // a note is neither
  };
  for (const [type, want] of Object.entries(expectations)) {
    assert.equal(L.isPlaceType({ type }), want.place, `isPlaceType(${type})`);
    assert.equal(L.isTravelLeg({ type }), want.leg, `isTravelLeg(${type})`);
    assert.ok(!(L.isPlaceType({ type }) && L.isTravelLeg({ type })), `${type} cannot be both`);
  }
});

test('isPlaceType / isTravelLeg refuse junk without throwing', () => {
  for (const junk of [null, undefined, {}, { type: 'banquet' }, { type: '' }]) {
    assert.equal(L.isPlaceType(junk), false);
    assert.equal(L.isTravelLeg(junk), false);
  }
});

test('the split asks the TYPE, never whether a mapsQuery happens to exist', () => {
  // A return leg carries the hotel's real name on purpose (so the distance
  // chip has something to measure to); that must never make it a place.
  const leg = { type: 'local', title: 'Return to hotel', mapsQuery: 'Sotetsu Grand Fresa Bangkok' };
  assert.equal(L.isPlaceType(leg), false);
  assert.equal(L.isTravelLeg(leg), true);
});

// ---------- leap-day spans (2028-02-29) ----------

function stay(id, location, startDate, endDate, status = 'booked', cost = null) {
  return { id, type: 'stay', title: `${location} hotel`, location, startDate, endDate, status, cost };
}

test('nights counts across the leap day', () => {
  assert.equal(L.nights(stay('s1', 'Oslo', '2028-02-28', '2028-03-01')), 2);
  assert.equal(L.nights(stay('s2', 'Oslo', '2028-02-28', '2028-02-29')), 1);
  // and a non-leap year the same calendar distance is still exact
  assert.equal(L.nights(stay('s3', 'Oslo', '2027-02-28', '2027-03-01')), 1);
});

test('coverageGaps names Feb 29 as a real uncovered night', () => {
  const gaps = L.coverageGaps([
    stay('a', 'Oslo', '2028-02-27', '2028-02-28'),
    stay('b', 'Bergen', '2028-03-01', '2028-03-02'),
  ], null);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { start: '2028-02-28', end: '2028-03-01', nights: 2 });
});

test('coverageGaps reports no gap when a stay spans the leap day itself', () => {
  const gaps = L.coverageGaps([
    stay('a', 'Oslo', '2028-02-27', '2028-03-02'),
  ], null);
  assert.deepEqual(gaps, []);
});

test('dayCards deals one card per day across Feb 29, numbered without a skip', () => {
  const trip = {
    id: 'leap', name: 'Leap trip', currency: 'USD',
    items: [
      { id: 'f1', type: 'flight', title: 'Out', startDate: '2028-02-28', startTime: '08:00', endDate: '', status: 'booked' },
      stay('s1', 'Oslo', '2028-02-28', '2028-03-01'),
      { id: 'a1', type: 'activity', title: 'Leap-day walk', location: 'Oslo', startDate: '2028-02-29', startTime: '11:00', endDate: '', status: 'booked' },
    ],
  };
  const cards = L.dayCards(trip);
  assert.deepEqual(cards.map(c => c.date), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(cards.map(c => c.dayNumber), [1, 2, 3]);
  assert.equal(cards[0].totalDays, 3);
  const leapCard = cards[1];
  assert.ok(leapCard.events.some(e => e.kind === 'item' && e.item.id === 'a1'),
    'the Feb 29 card carries its own activity');
  assert.ok(cards[2].events.some(e => e.kind === 'checkout'), 'checkout lands on Mar 1');
});

test('spendByWeek buckets a leap-week correctly and zero-fills across it', () => {
  // 2028-02-28 and 2028-03-13 are Mondays; the week starting 02-28 contains
  // Feb 29. addDays stepping 7 from 02-28 must land on 03-06 (leap year),
  // not 03-07, or the zero week between two spends would be mislabelled.
  const trip = {
    id: 'leap2', currency: 'USD',
    items: [
      { id: 'i1', type: 'activity', title: 'A', startDate: '2028-02-29', status: 'booked', cost: 100, costCurrency: 'USD' },
      { id: 'i2', type: 'activity', title: 'B', startDate: '2028-03-14', status: 'booked', cost: 50, costCurrency: 'USD' },
    ],
  };
  const weeks = L.spendByWeek(trip, null);
  assert.deepEqual(weeks.map(w => w.start), ['2028-02-28', '2028-03-06', '2028-03-13']);
  assert.deepEqual(weeks.map(w => w.total), [100, 0, 50]);
  assert.equal(L.weekStart('2028-02-29'), '2028-02-28');
});

// ---------- normalizeTripName ----------

test('normalizeTripName folds case, accents and punctuation into padded words', () => {
  assert.equal(L.normalizeTripName('Japón & Thailand, 2027!'), ' japon thailand 2027 ');
  assert.equal(L.normalizeTripName('  ICELAND ring-road  '), ' iceland ring road ');
});

test('normalizeTripName pads with spaces so whole-word matching works at the edges', () => {
  // the matcher searches for " kw ", so the first and last word must be
  // reachable the same way an interior word is
  const hay = L.normalizeTripName('Japan garden tour');
  assert.ok(hay.includes(' japan '));
  assert.ok(hay.includes(' tour '));
  assert.ok(!hay.includes(' japanese '));
});

test('normalizeTripName answers blank input with the empty padded form, never throws', () => {
  assert.equal(L.normalizeTripName(''), '  ');
  assert.equal(L.normalizeTripName(null), '  ');
  assert.equal(L.normalizeTripName(undefined), '  ');
});

// ---------- templateItem ----------

test('templateItem drops every booking fact and keeps the shape', () => {
  const source = {
    id: 'x1', type: 'stay', title: 'Hotel Borg', location: 'Reykjavik',
    startDate: '2027-06-01', endDate: '2027-06-04', startTime: '', endTime: '',
    details: 'quiet room', mapsQuery: 'Hotel Borg Reykjavik', order: 1,
    status: 'booked',
    cost: 540, costCurrency: 'EUR', costNote: 'card', estCost: 500, estCostCurrency: 'EUR',
    confirmation: 'ABC123', bookBy: '2027-05-01', payment: 'card', paidBy: 'Alex',
    travelers: ['Alex'], splitAmounts: { Alex: 540 },
  };
  const copy = L.templateItem(source);
  for (const k of L.TEMPLATE_CLEARED) {
    assert.ok(!(k in copy), `${k} must be cleared from a template`);
  }
  for (const k of ['id', 'type', 'title', 'location', 'startDate', 'endDate', 'details', 'mapsQuery', 'order']) {
    assert.deepEqual(copy[k], source[k], `${k} must survive`);
  }
  assert.equal(copy.status, 'to-book');
});

test('templateItem forces to-book whatever the source status was, and never mutates the source', () => {
  for (const status of ['booked', 'cancelled', 'decide-later', 'to-book']) {
    const src = { id: 'y', type: 'activity', title: 'T', status, cost: 10 };
    const copy = L.templateItem(src);
    assert.equal(copy.status, 'to-book', `status ${status}`);
    assert.equal(src.status, status, 'source untouched');
    assert.equal(src.cost, 10, 'source cost untouched');
  }
});

// ---------- hotelScore + calibration constants ----------

const hotelRow = (over = {}) => ({
  value: 'Novotel Bangkok Sukhumvit', kind: 'hotel', locality: 'Bangkok', ...over,
});

test('hotelScore: position is the base score, one step per HOTEL_POSITION_WEIGHT', () => {
  const r = hotelRow();
  const at0 = L.hotelScore('zzz', r, '', 0);
  const at1 = L.hotelScore('zzz', r, '', 1);
  assert.equal(at0 - at1, L.HOTEL_POSITION_WEIGHT);
});

test('hotelScore: prefix and exact-name bonuses stack as the constants say', () => {
  const r = hotelRow({ value: 'Novotel' });
  const none = L.hotelScore('zzz', r, '', 0);
  const prefix = L.hotelScore('novo', r, '', 0);
  const exact = L.hotelScore('novotel', r, '', 0);
  assert.equal(prefix - none, L.HOTEL_PREFIX_BONUS);
  assert.equal(exact - none, L.HOTEL_PREFIX_BONUS + L.HOTEL_EXACT_BONUS);
});

test('hotelScore: the kind bonus prefers a hotel over an apartment by the map values', () => {
  const hotel = L.hotelScore('zzz', hotelRow({ kind: 'hotel' }), '', 0);
  const apartment = L.hotelScore('zzz', hotelRow({ kind: 'apartment' }), '', 0);
  const unknown = L.hotelScore('zzz', hotelRow({ kind: 'castle' }), '', 0);
  assert.equal(hotel - apartment, L.HOTEL_KIND_BONUS.get('hotel') - L.HOTEL_KIND_BONUS.get('apartment'));
  assert.equal(hotel - unknown, L.HOTEL_KIND_BONUS.get('hotel'));
});

test('hotelScore: the city bonus matches includes-both-ways, exactly HOTEL_CITY_BONUS', () => {
  const base = L.hotelScore('zzz', hotelRow(), '', 0);
  // exact, ward-contains-city and city-contains-locality all earn the bonus
  assert.equal(L.hotelScore('zzz', hotelRow(), 'Bangkok', 0) - base, L.HOTEL_CITY_BONUS);
  const ward = hotelRow({ locality: 'Shimogyo Ward' });
  assert.equal(L.hotelScore('zzz', ward, 'Shimogyo', 0) - L.hotelScore('zzz', ward, '', 0), L.HOTEL_CITY_BONUS);
  const nyc = hotelRow({ locality: 'New York City' });
  assert.equal(L.hotelScore('zzz', nyc, 'New York', 0) - L.hotelScore('zzz', nyc, '', 0), L.HOTEL_CITY_BONUS);
  // a different city earns nothing
  assert.equal(L.hotelScore('zzz', hotelRow(), 'Christchurch', 0), base);
});

test('hotelScore calibration: the typed city beats a 5-position deficit (the Novotel case)', () => {
  // FINDINGS: "novotel" with "Bangkok" in the form must answer Bangkok even
  // when Photon ranks Christchurch first. The city bonus (120) lifts a row
  // about 5 positions (25 each), which is the documented calibration.
  const christchurch = hotelRow({ value: 'Novotel Christchurch Cathedral Square', locality: 'Christchurch' });
  const bangkok = hotelRow({ value: 'Novotel Bangkok Sukhumvit', locality: 'Bangkok' });
  const first = L.hotelScore('novotel', christchurch, 'Bangkok', 0);
  const fifth = L.hotelScore('novotel', bangkok, 'Bangkok', 4);
  assert.ok(fifth > first, `bangkok@4 (${fifth}) must beat christchurch@0 (${first})`);
});
