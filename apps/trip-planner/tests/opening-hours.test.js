'use strict';

// The deterministic opening-hours layer (trip-logic.js): normalization from
// Google's Place Details shape, the open/closed/unknown verdict, per-day
// interval extraction, and the display line. This is the check that stops the
// assistant recommending "Drinks at 23:00" at a bar whose verified hours end
// at 23:00 - the production failure that motivated the feature - so the
// boundary rule is pinned hard: open <= t < close, a start AT closing time is
// CLOSED, and missing hours are UNKNOWN, never open.
//
// Dates used: 2026-08-29 is a Saturday (day 6), 2026-08-30 a Sunday (day 0),
// 2026-08-31 a Monday (day 1).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

const SAT = '2026-08-29', SUN = '2026-08-30', MON = '2026-08-31';

// A weekly period helper: open/close as (day, 'HH:MM').
const P = (od, ot, cd, ct) => ({
  open: { day: od, min: +ot.slice(0, 2) * 60 + +ot.slice(3) },
  close: { day: cd, min: +ct.slice(0, 2) * 60 + +ct.slice(3) },
});

// A bar open 16:00-23:00 every day of the week.
const EVERY_DAY_16_23 = { always: false, periods: [0, 1, 2, 3, 4, 5, 6].map(d => P(d, '16:00', d, '23:00')), special: [] };

test('the screenshot bug: a 23:00 start at a venue closing 23:00 is CLOSED', () => {
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, SAT, '23:00').status, 'closed');
});

test('one minute before closing is still open (22:59 vs a 23:00 close)', () => {
  const v = L.hoursVerdict(EVERY_DAY_16_23, SAT, '22:59');
  assert.equal(v.status, 'open');
  assert.equal(v.closesMin, 23 * 60);
});

test('after closing is closed, before opening is closed, at opening is open', () => {
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, SAT, '23:30').status, 'closed');
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, SAT, '10:00').status, 'closed');
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, SAT, '16:00').status, 'open');
});

test('closed all day: a venue with no periods on that weekday', () => {
  // Open Monday only; asked about Saturday.
  const hours = { always: false, periods: [P(1, '09:00', 1, '17:00')], special: [] };
  assert.equal(L.hoursVerdict(hours, SAT, '12:00').status, 'closed');
  const day = L.hoursIntervalsForDate(hours, SAT);
  assert.equal(day.known, true);
  assert.equal(day.intervals.length, 0);
});

test('split hours 11:00-14:00 + 17:00-23:00: 15:00 closed, 20:00 open, 12:00 open', () => {
  const hours = { always: false, periods: [P(6, '11:00', 6, '14:00'), P(6, '17:00', 6, '23:00')], special: [] };
  assert.equal(L.hoursVerdict(hours, SAT, '15:00').status, 'closed');
  assert.equal(L.hoursVerdict(hours, SAT, '20:00').status, 'open');
  assert.equal(L.hoursVerdict(hours, SAT, '12:00').status, 'open');
  // the covering interval's close is the one reported, not the day's last
  assert.equal(L.hoursVerdict(hours, SAT, '12:00').closesMin, 14 * 60);
});

test('overnight 18:00-02:00: 23:00 open, 01:00 next day open, 03:00 closed', () => {
  // Saturday evening spilling into Sunday morning.
  const hours = { always: false, periods: [P(6, '18:00', 0, '02:00')], special: [] };
  const late = L.hoursVerdict(hours, SAT, '23:00');
  assert.equal(late.status, 'open');
  assert.equal(late.closesMin, 24 * 60 + 120, 'close is 02:00 the NEXT day, so 1560 minutes from Saturday midnight');
  const smallHours = L.hoursVerdict(hours, SUN, '01:00');
  assert.equal(smallHours.status, 'open');
  assert.equal(smallHours.closesMin, 120);
  assert.equal(L.hoursVerdict(hours, SUN, '03:00').status, 'closed');
  // and midnight itself is INSIDE the interval, not a closure
  assert.equal(L.hoursVerdict(hours, SUN, '00:00').status, 'open');
});

test('a start AT an overnight close is closed too (02:00 on the following day)', () => {
  const hours = { always: false, periods: [P(6, '18:00', 0, '02:00')], special: [] };
  assert.equal(L.hoursVerdict(hours, SUN, '02:00').status, 'closed');
});

test('a 24-hour venue is open at any time and reports no close', () => {
  const hours = { always: true, periods: [], special: [] };
  for (const t of ['00:00', '03:30', '12:00', '23:59']) {
    const v = L.hoursVerdict(hours, SAT, t);
    assert.equal(v.status, 'open');
    assert.equal(v.closesMin, null);
  }
});

test('missing or malformed hours are UNKNOWN, never open and never closed', () => {
  assert.equal(L.hoursVerdict(null, SAT, '12:00').status, 'unknown');
  assert.equal(L.hoursVerdict(undefined, SAT, '12:00').status, 'unknown');
  assert.equal(L.hoursVerdict({}, SAT, '12:00').status, 'unknown');
  assert.equal(L.hoursVerdict({ always: false, periods: [], special: [] }, SAT, '12:00').status, 'unknown');
  // bad date / bad time are unknown as well: no invented verdicts
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, 'not-a-date', '12:00').status, 'unknown');
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, SAT, '').status, 'unknown');
  assert.equal(L.hoursVerdict(EVERY_DAY_16_23, SAT, '9:00').status, 'unknown');
});

test('day-of-week is read from the DATE, not from anything ambient', () => {
  // Saturday-only venue: open on 2026-08-29 (a Saturday), closed the next day.
  const hours = { always: false, periods: [P(6, '10:00', 6, '18:00')], special: [] };
  assert.equal(L.hoursVerdict(hours, SAT, '12:00').status, 'open');
  assert.equal(L.hoursVerdict(hours, SUN, '12:00').status, 'closed');
  assert.equal(L.hoursVerdict(hours, MON, '12:00').status, 'closed');
});

test('dated special hours beat the weekly pattern for their own date only', () => {
  const hours = {
    always: false,
    periods: [0, 1, 2, 3, 4, 5, 6].map(d => P(d, '16:00', d, '23:00')),
    // that Saturday the venue closes early, at 20:00
    special: [{ open: { date: SAT, min: 16 * 60 }, close: { date: SAT, min: 20 * 60 } }],
  };
  assert.equal(L.hoursVerdict(hours, SAT, '21:00').status, 'closed', 'weekly says open, the dated table says closed');
  assert.equal(L.hoursVerdict(hours, SAT, '19:00').status, 'open');
  assert.equal(L.hoursVerdict(hours, SUN, '21:00').status, 'open', 'the next day falls back to the weekly pattern');
});

test('a dated overnight period covers the small hours of the NEXT date', () => {
  const hours = {
    always: false,
    periods: [],
    special: [{ open: { date: SAT, min: 18 * 60 }, close: { date: SUN, min: 120 } }],
  };
  assert.equal(L.hoursVerdict(hours, SUN, '01:00').status, 'open');
  assert.equal(L.hoursVerdict(hours, SAT, '23:30').status, 'open');
  assert.equal(L.hoursVerdict(hours, SAT, '12:00').status, 'closed', 'dated periods exist for that date and none covers noon');
});

test('hoursIntervalsForDate lists the intervals that START that day', () => {
  const hours = { always: false, periods: [P(6, '11:00', 6, '14:00'), P(6, '18:00', 0, '02:00')], special: [] };
  const sat = L.hoursIntervalsForDate(hours, SAT);
  assert.equal(sat.known, true);
  assert.deepEqual(sat.intervals, [
    { startMin: 11 * 60, endMin: 14 * 60, nextDay: false },
    { startMin: 18 * 60, endMin: 120, nextDay: true },
  ]);
  // Sunday's own line is empty: the 18:00-02:00 interval belongs to Saturday's
  // sign, exactly as a human reads posted hours.
  assert.deepEqual(L.hoursIntervalsForDate(hours, SUN).intervals, []);
  assert.equal(L.hoursIntervalsForDate(null, SAT).known, false);
});

// The line goes through the CALLER's formatter, which is how the app's one
// 12/24-hour preference applies here without a second formatter existing.
const fmt24 = t => t;
const fmt12 = t => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

test('hoursLineText renders through the injected 12/24-hour formatter', () => {
  const hours = { always: false, periods: [P(6, '11:30', 6, '14:30'), P(6, '17:00', 6, '22:00')], special: [] };
  const day = L.hoursIntervalsForDate(hours, SAT);
  assert.equal(L.hoursLineText(day, fmt12), '11:30 AM–2:30 PM, 5:00 PM–10:00 PM');
  assert.equal(L.hoursLineText(day, fmt24), '11:30–14:30, 17:00–22:00');
  assert.equal(L.hoursLineText(L.hoursIntervalsForDate({ always: true, periods: [], special: [] }, SAT), fmt12), 'Open 24 hours');
  const closedDay = L.hoursIntervalsForDate({ always: false, periods: [L.sanitizeHours ? P(1, '09:00', 1, '17:00') : null].filter(Boolean), special: [] }, SAT);
  assert.equal(L.hoursLineText(closedDay, fmt12), 'Closed');
  assert.equal(L.hoursLineText({ known: false, always: false, intervals: [] }, fmt12), '');
});

test('an overnight interval formats as its two clock faces ("6:00 PM–2:00 AM")', () => {
  const hours = { always: false, periods: [P(6, '18:00', 0, '02:00')], special: [] };
  assert.equal(L.hoursLineText(L.hoursIntervalsForDate(hours, SAT), fmt12), '6:00 PM–2:00 AM');
});

// ---------- normalization from Google's Place Details shape ----------

test('normalizeGoogleHours maps regularOpeningHours to the internal shape', () => {
  const hours = L.normalizeGoogleHours({
    periods: [
      { open: { day: 6, hour: 16, minute: 0 }, close: { day: 6, hour: 23, minute: 0 } },
      { open: { day: 1, hour: 9, minute: 30 }, close: { day: 2, hour: 1, minute: 0 } },
    ],
  }, null);
  assert.deepEqual(hours, {
    always: false,
    periods: [
      { open: { day: 6, min: 960 }, close: { day: 6, min: 1380 } },
      { open: { day: 1, min: 570 }, close: { day: 2, min: 60 } },
    ],
    special: [],
  });
});

test('normalizeGoogleHours reads the no-close convention as open 24 hours', () => {
  const hours = L.normalizeGoogleHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, null);
  assert.equal(hours.always, true);
  assert.equal(L.hoursVerdict(hours, SAT, '03:00').status, 'open');
});

test('normalizeGoogleHours keeps dated currentOpeningHours periods as specials', () => {
  const hours = L.normalizeGoogleHours(
    { periods: [{ open: { day: 6, hour: 16, minute: 0 }, close: { day: 6, hour: 23, minute: 0 } }] },
    { periods: [{ open: { day: 6, hour: 16, minute: 0, date: { year: 2026, month: 8, day: 29 } }, close: { day: 6, hour: 20, minute: 0, date: { year: 2026, month: 8, day: 29 } } }] },
  );
  assert.deepEqual(hours.special, [{ open: { date: SAT, min: 960 }, close: { date: SAT, min: 1200 } }]);
  assert.equal(L.hoursVerdict(hours, SAT, '21:00').status, 'closed');
});

test('normalizeGoogleHours returns null when Google has nothing: unknown, not open', () => {
  assert.equal(L.normalizeGoogleHours(null, null), null);
  assert.equal(L.normalizeGoogleHours({}, {}), null);
  assert.equal(L.normalizeGoogleHours({ periods: [] }, { periods: [] }), null);
  assert.equal(L.normalizeGoogleHours({ periods: [{ open: { day: 9, hour: 1, minute: 0 }, close: { day: 1, hour: 2, minute: 0 } }] }, null), null);
});

test('sanitizeHours drops malformed network data instead of trusting it', () => {
  assert.equal(L.sanitizeHours(null), null);
  assert.equal(L.sanitizeHours('open'), null);
  assert.equal(L.sanitizeHours({ always: false, periods: [], special: [] }), null);
  // out-of-range days/minutes and half-formed periods are dropped
  const cleaned = L.sanitizeHours({
    always: false,
    periods: [
      { open: { day: 6, min: 960 }, close: { day: 6, min: 1380 } },
      { open: { day: 7, min: 960 }, close: { day: 6, min: 1380 } },
      { open: { day: 6, min: 2000 }, close: { day: 6, min: 1380 } },
      { open: { day: 6, min: 960 } },
      'garbage',
    ],
    special: [
      { open: { date: SAT, min: 960 }, close: { date: SUN, min: 60 } },
      { open: { date: 'never', min: 960 }, close: { date: SUN, min: 60 } },
      { open: { date: SUN, min: 960 }, close: { date: SAT, min: 60 } },
    ],
  });
  assert.equal(cleaned.periods.length, 1);
  assert.equal(cleaned.special.length, 1);
  // a valid special survives alone, so dated-only payloads still verify
  const datedOnly = L.sanitizeHours({ special: [{ open: { date: SAT, min: 960 }, close: { date: SAT, min: 1200 } }] });
  assert.equal(datedOnly.special.length, 1);
});

// ---------- the session cache carries the hours, and only the safe ones ----------

test('placesCacheUpdates keeps hours on ok results and on unrated confident matches', () => {
  const hours = { always: false, periods: [{ open: { day: 6, min: 960 }, close: { day: 6, min: 1380 } }], special: [] };
  const updates = L.placesCacheUpdates([
    { query: 'Above The Grid Louisville', status: 'ok', rating: 4.6, userRatingCount: 200, mapsUri: 'https://maps.google.com/?cid=9', hours },
    { query: 'Tiny Bar Reykjavik', status: 'no_match', reason: 'unrated', hours },
    { query: 'Wrong Business', status: 'no_match', reason: 'low_confidence', hours },
    { query: 'No Hours Cafe', status: 'ok', rating: 4.2, userRatingCount: 5, mapsUri: 'https://maps.google.com/?cid=8', hours: null },
  ]);
  const byKey = new Map(updates.map(u => [u.key, u.entry]));
  assert.deepEqual(byKey.get('above the grid louisville').hours, hours);
  assert.deepEqual(byKey.get('tiny bar reykjavik').hours, hours);
  assert.equal(byKey.get('wrong business').hours, undefined, 'a low-confidence hit is a different business; its hours would lie');
  assert.equal(byKey.get('no hours cafe').hours, undefined, 'no hours stays no hours');
});

test('placesCacheUpdates sanitizes hours coming off the wire', () => {
  const updates = L.placesCacheUpdates([
    { query: 'Evil Venue', status: 'ok', rating: 4.0, userRatingCount: 1, mapsUri: 'https://maps.google.com/?cid=7', hours: { always: false, periods: [{ open: { day: 99, min: -5 }, close: {} }], special: [] } },
  ]);
  assert.equal(updates[0].entry.hours, undefined);
});

// ---------- the prompt carries the defence-in-depth paragraph ----------

test('both prompt builders tell the model about opening hours (defence-in-depth only)', () => {
  const trip = { id: 't1', name: 'T', currency: 'USD', items: [] };
  const pkg = L.buildAssistPackage({ trip, focusDate: SAT, request: 'plan my day', mode: 'plan' });
  const sys = L.buildAssistSystemPrompt({ trip, focusDate: SAT, today: SAT, mode: 'chat' });
  for (const text of [pkg, sys]) {
    assert.match(text, /opening hours/i);
    assert.match(text, /at or after the time it closes/);
  }
});
