'use strict';

// Regression cover for the assistant findings of the 2026-08-22 audit
// (AUDIT-2026-08-22.md): AS-02 (an update or remove by id could never match),
// AS-03 (an update un-booked a real reservation), AS-B3 (booking facts handed
// to a model that has no use for them) and AS-C1 (a re-suggested item says so).
//
// The whole mutation chain up to the write lives in trip-logic and is pinned
// here; the DOM half (cards, accept, undo, both views) is e2e/audit-fixes.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

let n = 0;
const item = (over = {}) => Object.assign({
  id: `real-${++n}`, type: 'activity', title: 'Museum', location: 'Tokyo',
  startDate: '2026-10-12', endDate: '', startTime: '10:00', endTime: '',
  status: 'to-book', cost: null, details: '', createdAt: `c${n}`,
}, over);
const tripOf = (items, over = {}) => Object.assign({ id: 't1', name: 'T', currency: 'USD', items }, over);

// ---------------------------------------------------------------------------
// AS-02: the model is given ids it can actually use
// ---------------------------------------------------------------------------

test('AS-02: the assistant projection carries the real item id', () => {
  const a = item({ id: 'abc-123', title: 'Senso-ji' });
  const b = item({ id: 'def-456', title: 'Narisawa', meal: 'dinner', startTime: '19:30' });
  const slim = L.slimTripForAssistant(tripOf([a, b]));
  assert.deepEqual(slim.items.map(x => x.id), ['abc-123', 'def-456']);
  // and the share projection still renumbers, because a share becomes a new trip
  assert.deepEqual(L.slimTripForShare(tripOf([a, b])).items.map(x => x.id), ['i1', 'i2']);
});

test('AS-02: an update by the id the model was given resolves to that item', () => {
  const a = item({ id: 'abc-123', title: 'Senso-ji' });
  const b = item({ id: 'def-456', title: 'Narisawa' });
  const trip = tripOf([a, b]);
  const shown = L.slimTripForAssistant(trip).items[1].id;
  const res = L.validateTripAction({ op: 'update', match: { id: shown }, set: { startTime: '20:00' } }, trip);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.proposal.targetId, 'def-456');
  assert.equal(res.proposal.fields.startTime, '20:00');
});

test('AS-02: a remove by that id resolves too', () => {
  const trip = tripOf([item({ id: 'abc-123' }), item({ id: 'def-456' })]);
  const res = L.validateTripAction({ op: 'remove', match: { id: 'def-456' } }, trip);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.proposal.targetId, 'def-456');
});

test('AS-02: the old i1..iN form no longer resolves, and says so honestly', () => {
  // The failure this whole finding is about: a compliant model matched on the
  // number it was shown and hit nothing. Now that it is shown real ids, an
  // "i2" is a made-up reference - and it must NOT be resolved by position,
  // because validate runs again at accept and the row at that position may be
  // a different item by then.
  const trip = tripOf([item({ id: 'abc-123' }), item({ id: 'def-456' })]);
  const res = L.validateTripAction({ op: 'update', match: { id: 'i2' }, set: { startTime: '20:00' } }, trip);
  assert.equal(res.ok, false);
  assert.match(res.reason, /No matching item/i);
});

test('AS-02: malformed, unknown and deleted-target ids all refuse', () => {
  const trip = tripOf([item({ id: 'abc-123', title: 'Senso-ji' })]);
  for (const id of ['', '   ', 'nope', '../../etc', '__proto__', 'def-456']) {
    const res = L.validateTripAction({ op: 'update', match: { id }, set: { startTime: '20:00' } }, trip);
    assert.equal(res.ok, false, `id ${JSON.stringify(id)} resolved`);
  }
  // a target the traveller deleted between the reply and the press is gone,
  // not "the item that slid into its place"
  const after = tripOf([item({ id: 'ghi-789', title: 'Something else' })]);
  assert.equal(L.validateTripAction({ op: 'remove', match: { id: 'abc-123' } }, after).ok, false);
});

test('AS-02: an exact title still matches, and an ambiguous one still refuses', () => {
  const trip = tripOf([item({ id: 'a', title: 'Senso-ji' }), item({ id: 'b', title: 'Narisawa' })]);
  assert.equal(L.validateTripAction({ op: 'update', match: { title: 'senso-ji' }, set: { startTime: '09:00' } }, trip).proposal.targetId, 'a');
  const two = tripOf([item({ id: 'a', title: 'Lunch' }), item({ id: 'b', title: 'Lunch' })]);
  assert.match(L.validateTripAction({ op: 'remove', match: { title: 'Lunch' } }, two).reason, /Multiple items match/i);
});

// ---------------------------------------------------------------------------
// AS-03: an update never touches what the traveller has booked
// ---------------------------------------------------------------------------

test('AS-03: an update that names a status leaves a booked item booked', () => {
  const flight = item({ id: 'f1', type: 'flight', title: 'Tokyo (HND) to Bangkok (BKK)', status: 'booked', cost: 800, costCurrency: 'USD', confirmation: 'XJ7K2Q' });
  const trip = tripOf([flight]);
  for (const status of ['to-book', 'cancelled', 'decide', 'booked', 'nonsense', 42, null]) {
    const res = L.validateTripAction({ op: 'update', match: { id: 'f1' }, set: { status, startTime: '11:00' } }, trip);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.proposal.status, 'booked', `status ${String(status)} demoted a booking`);
    assert.equal(res.proposal.fields.status, undefined, 'status must never ride in the field bag');
  }
});

test('AS-03: it leaves every other status exactly as it found it too', () => {
  for (const start of ['to-book', 'decide', 'cancelled', 'booked']) {
    const trip = tripOf([item({ id: 'x', status: start })]);
    const res = L.validateTripAction({ op: 'update', match: { id: 'x' }, set: { status: 'booked', title: 'New name' } }, trip);
    assert.equal(res.proposal.status, start, `${start} was rewritten`);
  }
});

test('AS-03: an ADD still cannot claim a booking', () => {
  const trip = tripOf([]);
  const res = L.validateTripAction({ op: 'add', item: { type: 'activity', title: 'Museum', startDate: '2026-10-12', status: 'booked' } }, trip);
  assert.equal(res.proposal.status, 'to-book');
  // ...unless it was transcribed off the traveller's own confirmation
  const doc = L.validateTripAction({ op: 'add', source: 'document', item: { type: 'flight', title: 'A to B', startDate: '2026-10-12', status: 'booked' } }, trip);
  assert.equal(doc.proposal.status, 'booked');
});

test('AS-03: an update carries only the fields it names', () => {
  const rich = item({
    id: 'r1', title: 'Narisawa', meal: 'dinner', location: 'Tokyo', startTime: '19:30',
    status: 'booked', cost: 220, costCurrency: 'USD', confirmation: 'ABC123', bookBy: '2026-10-01',
    payment: 'card', paidBy: 'Alex', travelers: ['Alex'], details: 'window table', mapsQuery: 'Narisawa Tokyo',
  });
  const res = L.validateTripAction({ op: 'update', match: { id: 'r1' }, set: { startTime: '20:00', confirmation: 'FAKE', paidBy: 'Sam', cost: 999 } }, tripOf([rich]));
  const f = res.proposal.fields;
  assert.equal(f.startTime, '20:00');
  // a model may not invent any of these, so they are not in the bag at all
  for (const k of ['confirmation', 'paidBy', 'payment', 'bookBy', 'travelers', 'splitAmounts', 'status']) {
    assert.equal(f[k], undefined, `${k} reached the update`);
  }
  // and a model price is an ESTIMATE, never the traveller's own number
  assert.equal(f.cost, 999);
  assert.equal(res.proposal.op, 'update');
});

// ---------------------------------------------------------------------------
// AS-B3: what the model is handed
// ---------------------------------------------------------------------------

test('AS-B3: booking facts stay out of the assistant projection', () => {
  const it = item({
    id: 'p1', title: 'Hotel', type: 'stay', endDate: '2026-10-15',
    confirmation: 'XJ7K2Q', bookBy: '2026-10-01', payment: 'card',
    paidBy: 'Alex', splitAmounts: { Alex: 100, Sam: 50 },
  });
  const trip = tripOf([it], { travelers: ['Alex', 'Sam'] });
  const wire = JSON.stringify(L.slimTripForAssistant(trip));
  for (const secret of ['XJ7K2Q', 'splitAmounts', 'paidBy', 'payment', 'bookBy']) {
    assert.equal(wire.includes(secret), false, `${secret} was sent to the model`);
  }
  // the share link is unchanged: the person you share with IS the other traveller
  const share = JSON.stringify(L.slimTripForShare(trip));
  assert.equal(share.includes('XJ7K2Q'), true);
  assert.equal(share.includes('splitAmounts'), true);
  // and what the model legitimately needs is all still there
  const slim = L.slimTripForAssistant(trip);
  assert.equal(slim.items[0].title, 'Hotel');
  assert.equal(slim.items[0].endDate, '2026-10-15');
  assert.equal(slim.name, 'T');
});

test('AS-B3: the projection is idempotent (client slims, server slims again)', () => {
  const trip = tripOf([item({ id: 'abc-123', confirmation: 'SECRET' })]);
  const once = L.slimTripForAssistant(trip);
  const twice = L.slimTripForAssistant(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.items[0].id, 'abc-123');
});

// ---------------------------------------------------------------------------
// AS-C1: a suggestion already on the plan
// ---------------------------------------------------------------------------

test('AS-C1: an add matching an existing row is flagged, not refused', () => {
  const existing = item({ id: 'e1', title: 'Wat Pho', startDate: '2026-10-20', startTime: '14:00' });
  const trip = tripOf([existing]);
  const res = L.validateTripAction({ op: 'add', item: { type: 'activity', title: 'wat pho ', startDate: '2026-10-20', startTime: '14:00' } }, trip);
  assert.equal(res.ok, true);
  assert.equal(res.proposal.duplicateOf, 'e1');
});

test('AS-C1: a different time, day, name or a cancelled row is not a duplicate', () => {
  const existing = item({ id: 'e1', title: 'Wat Pho', startDate: '2026-10-20', startTime: '14:00' });
  const cases = [
    { title: 'Wat Pho', startDate: '2026-10-20', startTime: '16:00' },
    { title: 'Wat Pho', startDate: '2026-10-21', startTime: '14:00' },
    { title: 'Wat Arun', startDate: '2026-10-20', startTime: '14:00' },
  ];
  for (const c of cases) {
    const res = L.validateTripAction({ op: 'add', item: { type: 'activity', ...c } }, tripOf([existing]));
    assert.equal(res.proposal.duplicateOf, undefined, JSON.stringify(c));
  }
  const dropped = tripOf([item({ ...existing, status: 'cancelled' })]);
  const res = L.validateTripAction({ op: 'add', item: { type: 'activity', title: 'Wat Pho', startDate: '2026-10-20', startTime: '14:00' } }, dropped);
  assert.equal(res.proposal.duplicateOf, undefined);
});

test('AS-C1: two untimed rows on the same day still count as the same plan', () => {
  const trip = tripOf([item({ id: 'e1', title: 'Packing', type: 'note', startDate: '2026-10-20', startTime: '' })]);
  const res = L.validateTripAction({ op: 'add', item: { type: 'note', title: 'Packing', startDate: '2026-10-20' } }, trip);
  assert.equal(res.proposal.duplicateOf, 'e1');
});
