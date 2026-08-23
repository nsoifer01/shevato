'use strict';

// Regression cover for the deterministic-data findings of the 2026-08-22 audit
// (AUDIT-2026-08-22.md): DM-02 (the visa reminder stretched the trip by a
// month), DM-03 (switching currency relabelled the budget instead of keeping
// its meaning) and DM-04 (a timed dinner exported as an all-day banner).
//
// The DOM halves - the Visas dialog, the totals-footer currency switch and the
// trip dialog's budget boxes - are in e2e/audit-fixes.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

let n = 0;
const item = (over = {}) => Object.assign({
  id: `d${++n}`, type: 'activity', title: 'Thing', location: '', startDate: '2026-11-10',
  endDate: '', startTime: '', endTime: '', status: 'booked', cost: null, details: '',
}, over);
const tripOf = (items, over = {}) => Object.assign({ id: 't', name: 'T', currency: 'USD', items }, over);
const RATES = { base: 'USD', rates: { EUR: 0.9, JPY: 150 } };
const unfold = ics => ics.replace(/\r\n /g, '');
const lines = ics => unfold(ics).split('\r\n');

// ---------------------------------------------------------------------------
// DM-02: a pre-trip task is a deadline, not a trip day
// ---------------------------------------------------------------------------
// The reminder was DATED thirty days before the trip, so tripStats read it as
// the new first day: 35 days / 34 nights on a 5-day trip, a countdown to the
// reminder, thirty "No plans yet" cards and day one labelled with the visa's
// country. The fix carries the date in bookBy, which the warnings panel already
// counts down, so the trip's own span is untouched.

const visaTrip = () => tripOf([
  item({ id: 'f', type: 'flight', title: 'London (LHR) to Bangkok (BKK)', startDate: '2026-12-01', startTime: '10:00' }),
  item({ id: 's', type: 'stay', title: 'Hotel', location: 'Bangkok', startDate: '2026-12-02', endDate: '2026-12-05' }),
]);

test('DM-02: a reminder carrying its deadline leaves the trip span alone', () => {
  const before = L.tripStats(visaTrip());
  const trip = visaTrip();
  // what addVisaReminder now stores: dated the trip's first day, deadline 30 days out
  trip.items.push(item({ id: 'v', type: 'note', title: 'Apply for Thailand visa', location: 'Thailand', status: 'to-book', startDate: before.start, bookBy: L.addDays(before.start, -30) }));
  const after = L.tripStats(trip);
  assert.equal(after.start, before.start);
  assert.equal(after.end, before.end);
  assert.equal(after.totalTripNights, before.totalTripNights);
});

test('DM-02: the old shape is what stretched it, and by exactly a month', () => {
  const before = L.tripStats(visaTrip());
  const stretched = visaTrip();
  stretched.items.push(item({ id: 'v', type: 'note', title: 'Apply for Thailand visa', startDate: L.addDays(before.start, -30) }));
  const after = L.tripStats(stretched);
  assert.equal(L.diffDays(after.start, before.start), 30, 'the fixture no longer reproduces the reported defect');
  assert.ok(after.totalTripNights > before.totalTripNights + 29);
});

test('DM-02: the deadline is what the warnings panel counts down', () => {
  const start = '2026-12-01';
  const reminder = item({ id: 'v', type: 'note', title: 'Apply for Thailand visa', status: 'to-book', startDate: start, bookBy: L.addDays(start, -30) });
  // inside the seven-day window it is named with its days left
  const due = L.bookingDeadlines([reminder], L.addDays(start, -33));
  assert.equal(due.length, 1);
  assert.equal(due[0].daysLeft, 3);
  assert.equal(due[0].kind, 'due');
  // past it, it is named as passed
  assert.equal(L.bookingDeadlines([reminder], L.addDays(start, -20))[0].kind, 'passed');
  // and long before, it says nothing at all
  assert.deepEqual(L.bookingDeadlines([reminder], L.addDays(start, -90)), []);
  // marking it booked silences it whatever the stored date says
  assert.deepEqual(L.bookingDeadlines([{ ...reminder, status: 'booked' }], L.addDays(start, -33)), []);
});

test('DM-02: the reminder is a valid item, so it can be saved and edited', () => {
  const start = '2026-12-01';
  const reminder = { type: 'note', title: 'Apply for Thailand visa', startDate: start, bookBy: L.addDays(start, -30) };
  assert.deepEqual(L.validateItem(reminder), {});
});

// ---------------------------------------------------------------------------
// DM-03: a budget keeps its meaning when the trip currency changes
// ---------------------------------------------------------------------------

test('DM-03: an absent budgetCurrency means the trip own, and converts to itself', () => {
  const trip = tripOf([], { budget: 5000, budgetFrom: 3000 });
  const bud = L.tripBudgetIn(trip, RATES);
  assert.equal(L.budgetCurrencyOf(trip), 'USD');
  assert.equal(bud.top, 5000);
  assert.equal(bud.low, 3000);
  assert.equal(bud.foreign, false);
  assert.equal(bud.unconverted, false);
});

test('DM-03: a budget typed in another currency is CONVERTED, not relabelled', () => {
  // the reported case: 6000-8000 was typed in USD, the traveller switches the
  // trip to EUR, and the ceiling must still mean the same money
  const trip = tripOf([], { currency: 'EUR', budget: 8000, budgetFrom: 6000, budgetCurrency: 'USD' });
  const bud = L.tripBudgetIn(trip, RATES);
  assert.equal(Math.round(bud.top), 7200);
  assert.equal(Math.round(bud.low), 5400);
  assert.equal(bud.foreign, true);
  assert.notEqual(bud.top, 8000, 'the number was relabelled rather than converted');
});

test('DM-03: a rate the provider does not quote is reported, never assumed', () => {
  const trip = tripOf([], { currency: 'USD', budget: 100000, budgetCurrency: 'XXX' });
  const bud = L.tripBudgetIn(trip, RATES);
  assert.equal(bud.top, null);
  assert.equal(bud.unconverted, true);
  assert.equal(bud.currency, 'XXX');
  // and with no rate table at all
  assert.equal(L.tripBudgetIn(tripOf([], { currency: 'EUR', budget: 8000, budgetCurrency: 'USD' }), null).unconverted, true);
});

test('DM-03: the verdict is judged against the CONVERTED ceiling', () => {
  const trip = tripOf([], { currency: 'EUR', budget: 8000, budgetCurrency: 'USD' }); // 7200 EUR
  const bud = L.tripBudgetIn(trip, RATES);
  assert.equal(L.budgetVerdict(7000, bud.top, 0), 'ok');
  assert.equal(L.budgetVerdict(7500, bud.top, 0), 'over');
  // against the unconverted number 7500 would have read as within budget
  assert.equal(L.budgetVerdict(7500, trip.budget, 0), 'ok');
});

test('DM-03: junk and orphaned codes fall back to the trip currency', () => {
  for (const bad of ['usd', 'US', 'DOLLARS', 42, null, '']) {
    assert.equal(L.budgetCurrencyOf(tripOf([], { budget: 100, budgetCurrency: bad })), 'USD');
  }
});

test('DM-03: the share payload carries the code only when it differs', () => {
  const same = L.slimTripForShare(tripOf([], { currency: 'USD', budget: 5000, budgetCurrency: 'USD' }));
  assert.equal(same.budgetCurrency, undefined, 'a trip that never switched must ship what it always did');
  const diff = L.slimTripForShare(tripOf([], { currency: 'EUR', budget: 8000, budgetFrom: 6000, budgetCurrency: 'USD' }));
  assert.equal(diff.budgetCurrency, 'USD');
  assert.equal(diff.budget, 8000);
  assert.equal(diff.budgetFrom, 6000);
  // no budget, no code
  assert.equal(L.slimTripForShare(tripOf([], { currency: 'EUR', budgetCurrency: 'USD' })).budgetCurrency, undefined);
});

// ---------------------------------------------------------------------------
// DM-04: a timed item is a timed calendar event
// ---------------------------------------------------------------------------

test('DM-04: a timed dinner exports at its time, not as an all-day banner', () => {
  const ics = L.buildIcs(tripOf([
    item({ id: 'din', title: 'Narisawa', meal: 'dinner', startDate: '2026-10-12', startTime: '19:30' }),
  ]), new Date('2026-08-23T12:00:00Z'));
  const l = lines(ics);
  assert.ok(l.includes('DTSTART:20261012T193000'), l.join(' | '));
  assert.ok(!l.some(x => x.startsWith('DTSTART;VALUE=DATE')));
  assert.ok(l.includes('SUMMARY:Dinner: Narisawa'));
});

test('DM-04: every timed type lands at its clock time', () => {
  const ics = L.buildIcs(tripOf([
    item({ id: 'a', type: 'activity', title: 'Museum', startDate: '2026-10-12', startTime: '09:00' }),
    item({ id: 'n', type: 'note', title: 'Call the hotel', startDate: '2026-10-12', startTime: '08:00' }),
    item({ id: 'f', type: 'flight', title: 'A to B', startDate: '2026-10-13', startTime: '07:00' }),
  ]), new Date('2026-08-23T12:00:00Z'));
  const starts = lines(ics).filter(x => x.startsWith('DTSTART'));
  assert.deepEqual(starts, ['DTSTART:20261012T080000', 'DTSTART:20261012T090000', 'DTSTART:20261013T070000']);
});

test('DM-04: an untimed item and a stay are still all-day', () => {
  const ics = L.buildIcs(tripOf([
    item({ id: 'u', title: 'Somewhere that day', startDate: '2026-10-12', startTime: '' }),
    item({ id: 's', type: 'stay', title: 'Hotel', startDate: '2026-10-12', endDate: '2026-10-15', startTime: '15:00' }),
  ]), new Date('2026-08-23T12:00:00Z'));
  const l = lines(ics);
  assert.ok(l.includes('DTSTART;VALUE=DATE:20261012'));
  assert.ok(l.includes('DTEND;VALUE=DATE:20261015'), 'a stay keeps its nights');
});

test('DM-04: every VEVENT carries the DTSTAMP the spec requires', () => {
  const ics = L.buildIcs(tripOf([
    item({ id: 'a', startDate: '2026-10-12', startTime: '09:00' }),
    item({ id: 'b', startDate: '2026-10-13' }),
  ]), new Date('2026-08-23T12:00:00Z'));
  const l = lines(ics);
  assert.equal(l.filter(x => x === 'DTSTAMP:20260823T120000Z').length, 2);
  assert.equal(l.filter(x => x === 'BEGIN:VEVENT').length, 2);
});

test('DM-04: no content line exceeds 75 octets, and unfolding restores it', () => {
  const details = 'A description long enough to need folding. '.repeat(10);
  const ics = L.buildIcs(tripOf([
    item({ id: 'a', title: 'Sushi 🍣 and a very long title that keeps going for a while', startDate: '2026-10-12', startTime: '19:30', details }),
  ]), new Date('2026-08-23T12:00:00Z'));
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line of ${Buffer.byteLength(line, 'utf8')} octets: ${line.slice(0, 40)}`);
  }
  const back = unfold(ics);
  assert.ok(back.includes('🍣'), 'a surrogate pair was split by the fold');
  assert.ok(back.includes(details.trim().slice(0, 60)));
});

test('DM-04: a cancelled item still exports nothing', () => {
  const ics = L.buildIcs(tripOf([item({ id: 'c', status: 'cancelled', startTime: '19:30' })]), new Date('2026-08-23T12:00:00Z'));
  assert.ok(!lines(ics).some(x => x.startsWith('BEGIN:VEVENT')));
});
