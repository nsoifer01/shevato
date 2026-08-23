'use strict';

// Regression cover for HR-01, reported during the 2026-08-22 fix round: a Days
// row scheduled BEFORE a venue opens read "Closed at 5:30 PM · Hours: 6:00
// PM-2:00 AM". At 17:30 the bar had not closed, it had not opened, and the
// sentence sent the traveller looking for another venue when all they needed
// was a later hour.
//
// The fix is a state, not a string: hoursVerdict answers 'beforeOpen' with the
// hour it opens, and every consumer reads that one canonical verdict (the Days
// row, the assistant card, the winner badges and the accept refusal). These
// tests pin the state machine and its boundaries; the wording each surface puts
// on it is in e2e/audit-fixes.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

const P = (od, o, cd, c) => ({
  open: { day: od, min: Number(o.slice(0, 2)) * 60 + Number(o.slice(3)) },
  close: { day: cd, min: Number(c.slice(0, 2)) * 60 + Number(c.slice(3)) },
});
// 2026-10-16 is a Friday, 2026-10-17 a Saturday, 2026-10-19 a Monday.
const FRI = '2026-10-16', SAT = '2026-10-17', MON = '2026-10-19';
const hoursOf = periods => ({ always: false, periods, special: [] });
// the reported venue: open 18:00 through 02:00 the next morning, every day
const BAR = hoursOf([0, 1, 2, 3, 4, 5, 6].map(d => P(d, '18:00', (d + 1) % 7, '02:00')));
const v = (hours, date, time, win) => L.hoursVerdict(hours, date, time, win);

test('HR-01: the reported case - 17:30 against 18:00-02:00 has not opened yet', () => {
  const before = v(BAR, FRI, '17:30');
  assert.equal(before.status, 'beforeOpen');
  assert.equal(before.opensMin, 18 * 60);
  assert.equal(before.closesMin, null, 'nothing has closed, so there is no closing time to report');
});

test('HR-01: every boundary around a single opening interval', () => {
  const nine2five = hoursOf([P(5, '09:00', 5, '17:00')]); // Friday only
  const cases = [
    ['00:00', 'beforeOpen'],
    ['08:59', 'beforeOpen'],
    ['09:00', 'open'],        // exactly at opening
    ['12:00', 'open'],        // during
    ['16:59', 'open'],
    ['17:00', 'closed'],      // exactly at closing counts as closed
    ['17:01', 'closed'],
    ['23:59', 'closed'],
  ];
  for (const [time, want] of cases) {
    assert.equal(v(nine2five, FRI, time).status, want, `${time} should be ${want}`);
  }
  assert.equal(v(nine2five, FRI, '08:59').opensMin, 9 * 60);
});

test('HR-01: an overnight range is open past midnight and beforeOpen after it', () => {
  assert.equal(v(BAR, FRI, '23:00').status, 'open');
  assert.equal(v(BAR, SAT, '01:00').status, 'open', 'the spill-over from Friday night');
  assert.equal(v(BAR, SAT, '01:59').status, 'open');
  // 02:00 is the close, and the doors open again at 18:00 the same day
  const shut = v(BAR, SAT, '02:00');
  assert.equal(shut.status, 'beforeOpen');
  assert.equal(shut.opensMin, 18 * 60);
  assert.equal(v(BAR, SAT, '03:00').status, 'beforeOpen');
  assert.equal(v(BAR, SAT, '17:59').status, 'beforeOpen');
  assert.equal(v(BAR, SAT, '18:00').status, 'open');
});

test('HR-01: a night-only venue is CLOSED after its last spill, never beforeOpen', () => {
  // open Friday 18:00 to Saturday 02:00 and not again that weekend
  const fridayOnly = hoursOf([P(5, '18:00', 6, '02:00')]);
  assert.equal(v(fridayOnly, SAT, '01:00').status, 'open');
  assert.equal(v(fridayOnly, SAT, '03:00').status, 'closed', 'Saturday has no opening of its own');
  assert.equal(v(fridayOnly, SAT, '03:00').opensMin, undefined);
  // and a day it never opens at all is closed, not "opens later"
  assert.equal(v(fridayOnly, MON, '12:00').status, 'closed');
});

test('HR-01: split hours name the NEXT sitting, and the last close ends the day', () => {
  const split = hoursOf([P(1, '11:00', 1, '14:00'), P(1, '17:00', 1, '23:00')]);
  assert.equal(v(split, MON, '10:59').status, 'beforeOpen');
  assert.equal(v(split, MON, '10:59').opensMin, 11 * 60);
  assert.equal(v(split, MON, '11:00').status, 'open');
  assert.equal(v(split, MON, '13:59').status, 'open');
  assert.equal(v(split, MON, '14:00').status, 'beforeOpen', 'the lunch sitting ends and the evening one is ahead');
  assert.equal(v(split, MON, '14:00').opensMin, 17 * 60);
  assert.equal(v(split, MON, '16:30').opensMin, 17 * 60);
  assert.equal(v(split, MON, '23:00').status, 'closed', 'nothing opens again that day');
});

test('HR-01: closing-soon is unchanged and never collides with beforeOpen', () => {
  const split = hoursOf([P(1, '11:00', 1, '14:00'), P(1, '17:00', 1, '23:00')]);
  assert.equal(v(split, MON, '13:30', 30).status, 'open', 'exactly the window still recommends');
  assert.equal(v(split, MON, '13:31', 30).status, 'closingSoon');
  assert.equal(v(split, MON, '13:31', 30).closesMin, 14 * 60);
  // a window can never turn a not-yet-open time into closingSoon
  assert.equal(v(split, MON, '10:00', 30).status, 'beforeOpen');
  assert.equal(v(split, MON, '16:00', 60).status, 'beforeOpen');
  // and an overnight interval still measures its remaining time past midnight
  assert.equal(v(BAR, FRI, '23:50', 30).status, 'open');
  assert.equal(v(BAR, SAT, '01:40', 30).status, 'closingSoon');
});

test('HR-01: dated hours decide their own date, weekly hours the rest', () => {
  const hours = {
    always: false,
    periods: [P(6, '09:00', 6, '17:00')],
    special: [{ open: { date: SAT, min: 18 * 60 }, close: { date: '2026-10-18', min: 120 } }],
  };
  // the dated period replaces the weekly one for that date, so 12:00 is before
  // the 18:00 dated opening rather than inside the weekly 09:00-17:00
  const noon = v(hours, SAT, '12:00');
  assert.equal(noon.status, 'beforeOpen');
  assert.equal(noon.opensMin, 18 * 60);
  assert.equal(v(hours, SAT, '19:00').status, 'open');
  // a dated CLOSURE (a period the table names with no room for the time and no
  // later opening) is closed by those dated hours
  const closedDay = { always: false, periods: [P(6, '09:00', 6, '17:00')], special: [{ open: { date: SAT, min: 9 * 60 }, close: { date: SAT, min: 10 * 60 } }] };
  assert.equal(v(closedDay, SAT, '12:00').status, 'closed');
});

test('HR-01: unknown stays unknown, and a 24-hour venue is always open', () => {
  assert.equal(v(null, FRI, '17:30').status, 'unknown');
  assert.equal(v({ always: false, periods: [], special: [] }, FRI, '17:30').status, 'unknown');
  assert.equal(v({ always: true, periods: [], special: [] }, FRI, '03:00').status, 'open');
  // no time to judge is not a claim either
  assert.equal(v(BAR, FRI, '').status, 'unknown');
});

test('HR-01: nextOpeningMin is the canonical answer both branches use', () => {
  assert.equal(L.nextOpeningMin(BAR, FRI, 17 * 60 + 30), 18 * 60);
  assert.equal(L.nextOpeningMin(BAR, FRI, 18 * 60), null, 'an opening exactly at the time is not "later"');
  assert.equal(L.nextOpeningMin(hoursOf([P(5, '09:00', 5, '17:00')]), FRI, 18 * 60), null);
});

test('HR-01: the hours line itself is unchanged in both formats', () => {
  const day = L.hoursIntervalsForDate(BAR, FRI);
  assert.equal(L.hoursLineText(day, t => t), '18:00\u201302:00');
  const twelve = L.hoursLineText(day, t => {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  });
  assert.equal(twelve, '6:00 PM\u20132:00 AM');
});
