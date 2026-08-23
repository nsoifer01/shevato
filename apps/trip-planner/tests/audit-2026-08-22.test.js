'use strict';

// Regression cover for the 2026-08-22 audit round (see AUDIT-2026-08-22.md).
//
// This file holds the findings whose fix lives in PURE logic, so they are
// pinned here rather than through a browser: connection warnings that a
// non-leg item used to hide (DM-01), night coverage on a trip with no stay at
// all (DM-06), and the morning bed a day's route chain starts from (MV-01). The rest of the round's fixes are DOM or state facts and are
// covered by e2e/audit-fixes.mjs instead.
//
// Each block names the finding it defends and what the old behaviour actually
// produced: a test that only asserted the new output would not stop the same
// bug coming back in a different shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
let n = 0;
const leg = (over = {}) => Object.assign({
  id: `a${++n}`, type: 'flight', title: 'A to B', location: '',
  startDate: '2026-10-10', startTime: '', endDate: '', endTime: '',
  status: 'booked',
}, over);
const plain = (over = {}) => leg(Object.assign({ type: 'activity', title: 'Something' }, over));
const bed = (over = {}) => leg(Object.assign({
  type: 'stay', title: 'Hotel', location: 'Tokyo',
  startDate: '2026-10-11', endDate: '2026-10-12',
}, over));

// ---------------------------------------------------------------------------
// DM-01: a connection is between two LEGS, not between two adjacent rows
// ---------------------------------------------------------------------------
// Reported: "the flight lands 16:30, the airport bus leaves 17:00, and the
// warnings panel says nothing." The cause was list adjacency: connectionWarnings
// walked every non-cancelled item in sort order and skipped any pair whose ends
// were not both travel, so ONE note dated that day - the commonest thing on a
// travel day - broke the pair and the warning vanished. It went silent on
// exactly the trips that have things planned in them.

const landing = () => leg({ id: 'f', title: 'New York (JFK) to Tokyo (HND)', startDate: '2026-10-10', startTime: '13:00', endDate: '2026-10-11', endTime: '16:30' });
const bus = (time) => leg({ id: 'b', type: 'local', title: 'Airport bus', startDate: '2026-10-11', startTime: time, status: 'to-book' });

test('DM-01: a note on the departure day cannot hide a tight connection', () => {
  const note = plain({ id: 'n', type: 'note', title: 'Buy the JR pass', startDate: '2026-10-10' });
  const withNote = L.connectionWarnings([landing(), note, bus('17:00')]);
  assert.equal(withNote.length, 1);
  assert.equal(withNote[0].kind, 'tight');
  assert.equal(withNote[0].minutes, 30);
  assert.equal(withNote[0].fromId, 'f');
  assert.equal(withNote[0].toId, 'b');
  // and it reads exactly as it does with nothing between the two legs
  assert.deepEqual(withNote, L.connectionWarnings([landing(), bus('17:00')]));
});

test('DM-01: an activity or a meal between two legs cannot hide an impossible one', () => {
  const coffee = plain({ id: 'c', title: 'Coffee at the airport', startDate: '2026-10-11', startTime: '16:40' });
  const dinner = plain({ id: 'd', title: 'Narisawa', meal: 'dinner', startDate: '2026-10-11', startTime: '19:30' });
  for (const between of [coffee, dinner]) {
    const out = L.connectionWarnings([landing(), between, bus('16:00')]);
    assert.equal(out.length, 1, `hidden by ${between.title}`);
    assert.equal(out[0].kind, 'impossible');
    assert.equal(out[0].minutes, -30);
  }
});

test('DM-01: several things logged between the legs still leave ONE warning', () => {
  const items = [
    landing(),
    plain({ id: 'n1', type: 'note', title: 'Cash', startDate: '2026-10-10' }),
    plain({ id: 'c1', title: 'Coffee', startDate: '2026-10-11', startTime: '16:35' }),
    plain({ id: 'c2', title: 'SIM card', startDate: '2026-10-11', startTime: '16:40' }),
    bus('17:00'),
  ];
  const out = L.connectionWarnings(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromId, 'f');
  assert.equal(out[0].toId, 'b');
});

test('DM-01: the rules that SHOULD suppress a connection still do', () => {
  // a bed for the night the two legs straddle is a stopover, not a connection,
  // and an activity sitting between them does not change that
  const overnight = leg({ id: 'f2', title: 'BOS to CDG', startDate: '2026-10-11', startTime: '18:00', endDate: '2026-10-11', endTime: '23:50' });
  const nextMorning = leg({ id: 'b2', title: 'CDG to FCO', startDate: '2026-10-12', startTime: '00:05' });
  assert.deepEqual(L.connectionWarnings([overnight, bed({ startDate: '2026-10-11', endDate: '2026-10-12' }), plain({ startDate: '2026-10-11', startTime: '19:00' }), nextMorning]), []);
  // a cancelled leg is not a leg
  assert.deepEqual(L.connectionWarnings([landing(), plain({ startDate: '2026-10-11', startTime: '16:40' }), leg({ ...bus('17:00'), status: 'cancelled' })]), []);
  // a leg with no clock time can only be judged by inventing one
  assert.deepEqual(L.connectionWarnings([landing(), plain({ startDate: '2026-10-11', startTime: '16:40' }), leg({ id: 'b3', type: 'local', title: 'Bus', startDate: '2026-10-11', startTime: '' })]), []);
  // more than 24 hours apart is not a connection however little is in between
  assert.deepEqual(L.connectionWarnings([landing(), plain({ startDate: '2026-10-12', startTime: '09:00' }), leg({ id: 'b4', type: 'local', title: 'Bus', startDate: '2026-10-13', startTime: '17:00' })]), []);
  // a comfortable gap stays quiet
  assert.deepEqual(L.connectionWarnings([landing(), plain({ startDate: '2026-10-11', startTime: '16:40' }), bus('19:00')]), []);
});

test('DM-01: three legs in a row still report each tight pair once', () => {
  const a = leg({ id: 'l1', startDate: '2026-10-10', startTime: '08:00', endDate: '2026-10-10', endTime: '10:00' });
  const b = leg({ id: 'l2', startDate: '2026-10-10', startTime: '10:20', endDate: '2026-10-10', endTime: '12:00' });
  const c = leg({ id: 'l3', type: 'local', startDate: '2026-10-10', startTime: '12:10' });
  const between = plain({ id: 'x', title: 'Lounge', startDate: '2026-10-10', startTime: '10:05' });
  const out = L.connectionWarnings([a, between, b, c]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(w => [w.fromId, w.toId, w.minutes]), [['l1', 'l2', 20], ['l2', 'l3', 10]]);
});

// ---------------------------------------------------------------------------
// DM-06: no stay at all is not "every night is covered"
// ---------------------------------------------------------------------------
// coverageGaps measures from the first check-in, and with no stay to measure
// from it answered [] - which the warnings panel printed as "None" next to a
// summary chip reading "0 of 4 nights booked", with the night strip hidden.
// The trip's own first day is the honest floor in that case, and the gaps it
// returns carry the same shape, so "show" and "Add stay" work on them.

test('DM-06: a trip with no stay reports its nights as uncovered', () => {
  const gaps = L.coverageGaps([], '2026-11-03', [], '2026-11-01');
  assert.deepEqual(gaps, [{ start: '2026-11-01', end: '2026-11-03', nights: 2 }]);
});

test('DM-06: overnight travel still covers the nights it spans', () => {
  const redEye = { startDate: '2026-11-01', endDate: '2026-11-02' };
  assert.deepEqual(L.coverageGaps([], '2026-11-02', [redEye], '2026-11-01'), []);
  // the night after it lands is still a night in a bed nobody booked
  assert.deepEqual(L.coverageGaps([], '2026-11-03', [redEye], '2026-11-01'),
    [{ start: '2026-11-02', end: '2026-11-03', nights: 1 }]);
});

test('DM-06: a day trip and an undated plan claim nothing', () => {
  assert.deepEqual(L.coverageGaps([], '2026-11-01', [], '2026-11-01'), []);
  assert.deepEqual(L.coverageGaps([], '', [], ''), []);
  assert.deepEqual(L.coverageGaps([], '2026-11-03', []), []);
});

test('DM-06: callers that pass no trip start keep the old answer', () => {
  // stayDatesFrom and stayCheckoutFor have their own no-stay branches and ask
  // this a different question; they must not start receiving gaps
  assert.deepEqual(L.coverageGaps([], '2026-11-30', [{ startDate: '2026-11-01', endDate: '2026-11-02' }]), []);
});

test('DM-06: a far-future typo does not manufacture hundreds of nights', () => {
  // the same clamp the stay path already had: past the render horizon the trip
  // end is a mistyped date, and the error line about that item is the answer
  const gaps = L.coverageGaps([], '2999-01-01', [], '2026-11-01');
  assert.deepEqual(gaps, []);
});

test('DM-06: a trip that HAS stays is completely unchanged', () => {
  const stays = [{ startDate: '2026-11-02', endDate: '2026-11-04' }];
  const withStart = L.coverageGaps(stays, '2026-11-06', [], '2026-11-01');
  const without = L.coverageGaps(stays, '2026-11-06', []);
  assert.deepEqual(withStart, without);
  assert.deepEqual(withStart, [{ start: '2026-11-04', end: '2026-11-06', nights: 2 }]);
});

test('DM-06: the gap a stayless trip reports still prefills an Add stay', () => {
  const items = [
    leg({ id: 'f3', title: 'Rome (FCO) to Split (SPU)', startDate: '2026-11-01', startTime: '09:00' }),
    plain({ id: 'a3', title: 'Diocletian Palace', location: 'Split', startDate: '2026-11-02', startTime: '10:00' }),
  ];
  const [gap] = L.coverageGaps([], '2026-11-03', [], '2026-11-01');
  const pre = L.stayPrefillForGap(gap, items);
  assert.equal(pre.type, 'stay');
  assert.equal(pre.startDate, '2026-11-01');
  assert.equal(pre.endDate, '2026-11-03');
  assert.equal(pre.nights, 2);
  // and it is a range validateItem accepts, or the form could not be saved
  assert.deepEqual(L.validateItem({ type: 'stay', title: 'Hotel', startDate: pre.startDate, endDate: pre.endDate }), {});
});

// ---------------------------------------------------------------------------
// MV-01: a day's route chain starts at the bed you WOKE UP in
// ---------------------------------------------------------------------------
// On a handover day (check out of Tokyo, train at 10:30, check into Kyoto)
// dayAnchor read the stay covering the NIGHT, so the 8:00 Tokyo breakfast was
// measured from the Kyoto hotel: a ~232 mi first chip and Directions from the
// wrong end of the country. dayHostStay still answers the night; dayMorningStay
// answers the morning, and only the chain's start moved.

const handover = () => [
  { id: 's1', type: 'stay', title: 'Hotel Ryumeikan Tokyo', location: 'Tokyo', startDate: '2026-11-20', endDate: '2026-11-25', status: 'booked' },
  { id: 'b', type: 'activity', title: 'Kimuraya Ginza', location: 'Tokyo', startDate: '2026-11-25', startTime: '08:00', status: 'booked' },
  { id: 't', type: 'transport', title: 'Tokyo to Kyoto', location: 'Kyoto', startDate: '2026-11-25', startTime: '10:30', status: 'booked' },
  { id: 's2', type: 'stay', title: 'Hotel Kanra Kyoto', location: 'Kyoto', startDate: '2026-11-25', endDate: '2026-12-01', status: 'booked' },
  { id: 'k', type: 'activity', title: 'Nishiki Market', location: 'Kyoto', startDate: '2026-11-25', startTime: '15:00', status: 'booked' },
];
const resolved = () => true;

test('MV-01: the handover day anchors at the hotel being checked OUT of', () => {
  const a = L.dayAnchor(handover(), '2026-11-25', resolved);
  assert.equal(a.source, 'stay');
  assert.equal(a.label, 'Hotel Ryumeikan Tokyo');
  assert.equal(a.city, 'Tokyo');
});

test('MV-01: the night stay, night coverage and the day city are untouched', () => {
  const items = handover();
  assert.equal(L.dayHostStay(items, '2026-11-25').title, 'Hotel Kanra Kyoto');
  assert.equal(L.dayMorningStay(items, '2026-11-25').title, 'Hotel Ryumeikan Tokyo');
  // the day's own city still answers "where is this day", which is where it ends
  assert.equal(L.dayMorningCity(items, '2026-11-25', resolved).city, 'Kyoto');
  // and the nights either side are covered exactly as before
  assert.deepEqual(L.coverageGaps(items.filter(i => i.type === 'stay'), '2026-12-01', []), []);
});

test('MV-01: ordinary days are unchanged in both directions', () => {
  const items = handover();
  // an interior night of the first stay
  assert.equal(L.dayAnchor(items, '2026-11-22', resolved).label, 'Hotel Ryumeikan Tokyo');
  // the last day, where a stay ends and nothing starts
  assert.equal(L.dayAnchor(items, '2026-12-01', resolved).label, 'Hotel Kanra Kyoto');
  // a day with no stay at all falls through to the city, as before
  assert.equal(L.dayAnchor([{ id: 'x', type: 'activity', title: 'Museum', location: 'Rome', startDate: '2027-01-05', status: 'booked' }], '2027-01-05', resolved).city, 'Rome');
});

test('MV-01: the chain hands over at the leg between the two cities', () => {
  const P = (id, label, lat, lon) => ({ id, label, lat, lon });
  const legs = L.dayDistanceChain(
    P('s1', 'Hotel Ryumeikan Tokyo', 35.686, 139.774),
    [P('b', 'Kimuraya Ginza', 35.672, 139.765), P('t', 'Tokyo to Kyoto', 34.985, 135.758), P('k', 'Nishiki Market', 35.005, 135.765)],
  );
  assert.equal(legs.length, 3);
  assert.equal(legs[0].from, 'Hotel Ryumeikan Tokyo');
  assert.ok(legs[0].km < 5, `the breakfast is a walk away, not ${Math.round(legs[0].km)} km`);
  assert.ok(legs[1].km > 300, 'the journey itself is the long leg');
  assert.equal(legs[2].from, 'Tokyo to Kyoto');
  assert.ok(legs[2].km < 5, 'once the train has landed, Kyoto stops measure from Kyoto');
});

test('MV-01: an arrival day still anchors where it lands', () => {
  const items = [
    { id: 'f', type: 'flight', title: 'Rome (FCO) to Tokyo (HND)', startDate: '2026-11-19', startTime: '10:00', endDate: '2026-11-20', endTime: '08:00', status: 'booked' },
    { id: 's1', type: 'stay', title: 'Hotel Ryumeikan Tokyo', location: 'Tokyo', startDate: '2026-11-20', endDate: '2026-11-25', status: 'booked' },
  ];
  const a = L.dayAnchor(items, '2026-11-20', resolved);
  assert.equal(a.source, 'arrival');
});
