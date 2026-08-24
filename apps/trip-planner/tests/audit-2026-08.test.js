'use strict';

// Regression cover for the 2026-08-22 site-wide audit (pure-logic findings).
//
//   D3  an item dated a year EARLY used to become the trip's anchor: every
//       correct item was flagged "far outside the rest of the trip" and the
//       Days view rendered 400 days from the typo. tripStats now anchors the
//       rendered span on the largest cluster of dates, and exposes renderStart
//       so the outlier is the one item outside [renderStart, renderEnd].
//   D5  the ferry card had no distance ceiling (Tokyo to Sydney got one) and
//       island detection missed Santorini-class islands (Athens to Santorini
//       was a Recommended train).
//   D6  two geocodes on the same point produced "Walk 0m, heading north".
// Everything DOM-shaped from the same round (D1, D2, D4, D7-D10) lives in
// e2e/audit-2026-08.mjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

const note = (id, title, startDate, endDate = '') => ({ id, type: 'note', title, startDate, endDate, status: 'to-book' });

// ---------- D3: early outlier ----------

test('tripStats anchors the rendered span on the cluster, not on the earliest date', () => {
  const trip = { items: [
    note('a', 'A to B', '2027-06-01'),
    note('b', 'Hotel', '2027-06-02', '2027-06-05'),
    note('c', 'Colosseum', '2027-06-03'),
    note('t', 'Typo', '2025-06-04'), // one item a year early
  ] };
  const st = L.tripStats(trip);
  assert.equal(st.start, '2025-06-04'); // honest: the issues list names it from here
  assert.equal(st.end, '2027-06-05');
  assert.equal(st.spanCapped, true);
  assert.equal(st.renderStart, '2027-06-01');
  assert.equal(st.renderEnd, '2027-06-05');
  // the Days view renders the real trip, not 400 days from the typo
  const cards = L.dayCards(trip);
  assert.equal(cards[0].date, '2027-06-01');
  assert.equal(cards.length, 5);
});

test('a far-FUTURE outlier keeps the cluster too, and a trip longer than the cap is cut at the cap', () => {
  const future = L.tripStats({ items: [note('a', 'Rome', '2027-03-01', '2027-03-04'), note('t', 'Typo', '9999-12-31')] });
  assert.equal(future.renderStart, '2027-03-01');
  assert.equal(future.renderEnd, '2027-03-04');
  assert.equal(future.spanCapped, true);
  // a genuinely long trip (no outlier) still renders its first MAX_TRIP_DAYS
  const items = [];
  for (let i = 0; i < 30; i++) items.push(note('i' + i, 'Leg ' + i, L.addDays('2027-01-01', i * 20)));
  const long = L.tripStats({ items });
  assert.equal(long.renderStart, '2027-01-01');
  assert.equal(long.renderEnd, L.addDays('2027-01-01', L.MAX_TRIP_DAYS - 1));
  assert.equal(long.spanCapped, true);
});

test('nights are counted over the rendered window, so a typo cannot report "3 of 804"', () => {
  const trip = { items: [
    { id: 'h', type: 'stay', title: 'Hotel', startDate: '2027-06-19', endDate: '2027-06-22', status: 'booked' },
    { id: 'a', type: 'note', title: 'Last day', startDate: '2027-06-23', status: 'to-book' },
    { id: 't', type: 'note', title: 'Typo', startDate: '2025-06-04', status: 'to-book' },
  ] };
  const st = L.tripStats(trip);
  assert.equal(st.renderStart, '2027-06-19');
  assert.equal(st.renderEnd, '2027-06-23');
  assert.equal(st.totalTripNights, 4);
  assert.equal(st.bookedNights, 3);
  // an uncapped trip is unchanged: the whole span, every booked night
  const plain = L.tripStats({ items: [trip.items[0], trip.items[1]] });
  assert.equal(plain.totalTripNights, 4);
  assert.equal(plain.bookedNights, 3);
});

test('an uncapped trip reports renderStart equal to start', () => {
  const st = L.tripStats({ items: [note('a', 'Rome', '2027-03-01', '2027-03-04')] });
  assert.equal(st.renderStart, '2027-03-01');
  assert.equal(st.spanCapped, false);
});

test('a two-item tie anchors on the earlier date, the behaviour before clustering existed', () => {
  const st = L.tripStats({ items: [note('a', 'Early', '2025-01-01'), note('b', 'Late', '2027-01-01')] });
  assert.equal(st.renderStart, '2025-01-01');
});

// ---------- D5: ferries and islands ----------

test('modeOptions: no ferry card on a sea-country leg thousands of km long (Tokyo to Sydney)', () => {
  const modes = L.modeOptions(7800, true, false);
  assert.ok(!modes.some(m => m.key === 'ferry'), JSON.stringify(modes.map(m => m.key)));
  assert.ok(modes.some(m => m.key === 'air'));
  // and the boat tips go with it
  const ctx = { fromText: 'Tokyo', toText: 'Sydney', island: true, international: true, km: 7800 };
  assert.ok(!L.routeFlags(ctx).some(f => f.id === 'ferry'));
  assert.ok(!L.routeTips(ctx).some(t => t.id === 'island'));
});

test('modeOptions: a ferry-length island leg keeps its ferry and the boat tips (London to Dublin, Athens to Santorini)', () => {
  for (const km of [464, 235]) {
    const modes = L.modeOptions(km, true, false);
    assert.ok(modes.some(m => m.key === 'ferry'), `km=${km}`);
    assert.ok(!modes.some(m => m.key === 'rail'), `km=${km}`);
  }
  const ctx = { fromText: 'Athens', toText: 'Santorini', island: true, international: false, km: 235 };
  assert.ok(L.routeFlags(ctx).some(f => f.id === 'ferry'));
  assert.ok(L.routeTips(ctx).some(t => t.id === 'island'));
  // an island hop this long is flown too, even though it is under the usual 250 km air floor
  assert.ok(L.modeOptions(235, true, false).some(m => m.key === 'air'));
});

test('isIslandPlace: Santorini-class islands by name, OSM place=island by kind, cities never', () => {
  for (const name of ['Santorini', 'Mykonos, Greece', 'Crete', 'Heraklion', 'Sicily', 'Bali', 'Mallorca', 'Ko Samui']) {
    assert.ok(L.isIslandPlace(name), name);
  }
  for (const name of ['Athens', 'Tokyo', 'Sydney', 'Bangkok', 'Paris, France']) {
    assert.ok(!L.isIslandPlace(name), name);
  }
  assert.ok(L.isIslandPlace('Somewhere', 'island'));
  assert.ok(!L.isIslandPlace('Somewhere', 'city'));
});

test('routeBadges never recommends a train whose line is unverified', () => {
  // Lima to Cusco class: 580 km, no fast rail, no through line known
  const opts = L.modeOptions(580, false, false);
  const train = opts.find(o => o.key === 'rail');
  assert.ok(train && train.unverified);
  const badges = L.routeBadges(opts, { island: false });
  assert.ok(!(badges.rail || []).some(b => b.id === 'recommended'), JSON.stringify(badges));
  assert.ok(Object.values(badges).some(list => list.some(b => b.id === 'recommended')), 'someone is still recommended');
  // a high-speed line is a verified service and may be recommended
  const hsr = L.routeBadges(L.modeOptions(370, false, true), {});
  assert.ok((hsr.rail || []).some(b => b.id === 'recommended'));
});

// ---------- D6: same point ----------

test('modeOptions: two geocodes on the same point offer nothing rather than a 0m walk', () => {
  assert.deepEqual(L.modeOptions(0, false, false), []);
  assert.deepEqual(L.modeOptions(0.04, false, false), []);
  assert.ok(L.modeOptions(0.5, false, false).some(m => m.key === 'walk'));
});
