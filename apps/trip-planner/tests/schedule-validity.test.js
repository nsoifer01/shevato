'use strict';

// SCHEDULE VALIDITY: a verified real place is not automatically a valid one.
//
// THE REPORTED FAILURE (owner, 2026-09-05). A guided "I want to be at my first
// planned stop at 8:00 AM" day came back offering breakfast at 08:00 at Only
// Noodles, which Google lists as opening at 10:30, alongside a second
// restaurant that was also shut. Both were perfectly verified: right business,
// right branch, 4.7 stars from a real review count. The app painted them red
// after the fact, dropped them from the winner badges and refused to add them -
// and then left the traveller holding a breakfast slot with nothing usable in
// it, having never once searched for a place that opens at eight.
//
// The fix is a stage, not another warning: identity validity ("is this the real
// Google place?") and schedule validity ("can it be used at the hour proposed
// for it?") are separate questions, both asked before a candidate may occupy a
// slot, and a candidate that fails the second one is REPLACED.
//
// These tests pin the deterministic half - the verdicts, the tiers, the
// selection arithmetic and the bounded-search policy. The full loop, including
// the provider round trip and the rendered cards, is pinned in the browser by
// e2e/schedule-slots.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/trip-logic.js');

// ---------- fixtures ----------

// Weekly hours, the same every day: the shape Google returns for a venue with a
// plain opening pattern and no dated exceptions.
const P = (day, open, close) => ({ open: { day, min: open }, close: { day, min: close } });
const hhmm = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const daily = (open, close) => ({
  always: false,
  periods: [0, 1, 2, 3, 4, 5, 6].map(d => P(d, hhmm(open), hhmm(close))),
  special: [],
});
const onDays = (days, open, close) => ({
  always: false,
  periods: days.map(d => P(d, hhmm(open), hhmm(close))),
  special: [],
});

// 2027-01-27 is a WEDNESDAY, and it is deliberately far in the future: these
// itineraries are never "now", so nothing anywhere may consult a live clock or
// an "open now" flag.
const WED = '2027-01-27';
const THU = '2027-01-28';
const MON = '2027-02-01';
const TUE = '2027-02-02';

const breakfastAt = (time, startDate = WED) => ({
  type: 'activity', meal: 'breakfast', title: 'X', startDate, startTime: time,
});

// A candidate as the pipeline holds one: the canonical resolved place plus the
// fields the proposal would create.
const cand = (name, hours, fields, extra = {}) => ({
  name,
  entry: { status: 'ok', placeId: 'pid-' + name, rating: 4.5, userRatingCount: 500, hours },
  proposal: { pid: 'p-' + name, display: { title: name, startDate: fields.startDate, startTime: fields.startTime }, fields },
  schedule: L.candidateScheduleTier({ hours }, fields),
  ...extra,
});

// ---------- the reported case ----------

test('THE REPORT: Only Noodles at 08:00 is INVALID for the slot, not merely red', () => {
  // Google: opens 10:30, closes 22:00. The traveller asked to be at their first
  // stop at 08:00.
  const v = L.candidateScheduleTier({ hours: daily('10:30', '22:00') }, breakfastAt('08:00'));
  assert.equal(v.tier, 'invalid', 'a venue that has not opened cannot fill the slot');
  assert.equal(v.status, 'beforeOpen');
  assert.equal(v.reason, 'opens_after_slot');
  assert.equal(v.opensMin, hhmm('10:30'));
  // and the rating it carries is irrelevant to that answer
  assert.equal(L.candidateScheduleTier(
    { rating: 4.9, userRatingCount: 9000, hours: daily('10:30', '22:00') }, breakfastAt('08:00')).tier, 'invalid');
});

test('THE REPORT, the other half: a place that IS open at 08:00 is valid', () => {
  const v = L.candidateScheduleTier({ hours: daily('07:00', '11:00') }, breakfastAt('08:00'));
  assert.equal(v.tier, 'open');
  assert.equal(v.reason, '');
  assert.equal(v.closesMin, hhmm('11:00'));
  assert.equal(v.minutesLeft, 180);
});

// ---------- §14: the exact candidate pipeline the owner specified ----------

test('FIXTURE: 3 asked for, 2 closed, 2 replacements found - the final slot is C, D, E', () => {
  const f = breakfastAt('08:00');
  // What the model proposed
  const only = cand('Only Noodles', daily('10:30', '22:00'), f);   // opens 10:30
  const B = cand('Candidate B', daily('12:00', '22:00'), f);        // opens 12:00
  const C = cand('Candidate C', daily('07:00', '11:00'), f);        // open
  // What the provider handed back when the slot went looking
  const D = cand('Candidate D', daily('06:30', '12:00'), f, { replacement: true });
  const E = cand('Candidate E', daily('07:30', '15:00'), f, { replacement: true });

  // 1. the two shut ones are refused for the slot, with a reason each
  assert.equal(only.schedule.tier, 'invalid');
  assert.equal(only.schedule.reason, 'opens_after_slot');
  assert.equal(B.schedule.tier, 'invalid');
  assert.equal(B.schedule.reason, 'opens_after_slot');
  for (const c of [C, D, E]) assert.equal(c.schedule.tier, 'open', c.name);

  // 2. the slot therefore needs two more CONFIRMED-OPEN candidates
  assert.equal(L.slotReplacementNeed({ want: 3, kept: 1, open: 1, scheduleDropped: 2 }), 2);

  // 3. and the final three are the open ones
  const { final, refused } = L.selectSlotCandidates([C, D, E, only, B], 3);
  assert.deepEqual(final.map(x => x.name), ['Candidate C', 'Candidate D', 'Candidate E']);
  assert.deepEqual(refused.map(x => x.name), ['Only Noodles', 'Candidate B'],
    'the shut ones survive as diagnostics, never as choices');
});

test('INVARIANT A: a verified-closed candidate cannot count toward the slot count', () => {
  const f = breakfastAt('08:00');
  const shut = cand('Shut', daily('10:30', '22:00'), f);
  const open1 = cand('Open one', daily('07:00', '12:00'), f);
  const { final } = L.selectSlotCandidates([open1, shut], 3);
  assert.deepEqual(final.map(x => x.name), ['Open one']);
  // ...and the slot still knows it is two short, which is what buys a search
  assert.equal(L.slotReplacementNeed({ want: 3, kept: 1, open: 1, scheduleDropped: 1 }), 2);
});

test('INVARIANT B: enough open candidates means the slot is filled to the count', () => {
  const f = breakfastAt('08:00');
  const list = ['A', 'B', 'C'].map(n => cand(n, daily('06:00', '12:00'), f));
  const { final, dropped } = L.selectSlotCandidates(list, 3);
  assert.equal(final.length, 3);
  assert.equal(dropped.length, 0);
  assert.equal(L.slotReplacementNeed({ want: 3, kept: 3, open: 3, scheduleDropped: 0 }), 0,
    'a full slot never buys a replacement');
});

test('INVARIANT G: one closed candidate cannot take valid ones down with it', () => {
  const f = breakfastAt('08:00');
  const good = ['A', 'B'].map(n => cand(n, daily('06:00', '12:00'), f));
  const shut = cand('Shut', daily('19:00', '23:00'), f);
  const { final } = L.selectSlotCandidates([...good, shut], 3);
  assert.deepEqual(final.map(x => x.name), ['A', 'B'], 'the other two are untouched');
});

// ---------- §15: hours unknown is its own answer ----------

test('FIXTURE: unknown hours are never open and never closed - open first, unknown fills', () => {
  const f = breakfastAt('08:00');
  const A = cand('A open', daily('07:00', '12:00'), f);
  const B = cand('B open', daily('06:30', '11:00'), f);
  const C = cand('C unknown', null, f);
  const D = cand('D closed', daily('11:00', '23:00'), f);

  assert.equal(C.schedule.tier, 'unknown');
  assert.equal(C.schedule.reason, 'hours_unknown');
  assert.equal(C.schedule.checked, false, 'nothing was checked, so nothing may be claimed');
  assert.equal(D.schedule.tier, 'invalid');

  // three asked for, two confirmed open, one unknown: the unknown one fills the
  // third place rather than the slot going short, and D never appears.
  const { final, refused } = L.selectSlotCandidates([A, B, C, D], 3);
  assert.deepEqual(final.map(x => x.name), ['A open', 'B open', 'C unknown']);
  assert.deepEqual(refused.map(x => x.name), ['D closed']);

  // and with enough confirmed-open candidates, the unknown one is surplus
  const E = cand('E open', daily('05:00', '10:00'), f);
  const two = L.selectSlotCandidates([A, B, E, C], 3);
  assert.deepEqual(two.final.map(x => x.name), ['A open', 'B open', 'E open']);
  assert.deepEqual(two.dropped.map(x => x.name), ['C unknown']);
});

test('INVARIANT F: unknown hours are not treated as known open, in either direction', () => {
  const f = breakfastAt('08:00');
  // no hours at all, malformed hours, and an empty table all mean UNKNOWN
  for (const hours of [null, undefined, {}, { periods: [], special: [], always: false }, 'nonsense']) {
    assert.equal(L.candidateScheduleTier({ hours }, f).tier, 'unknown', String(hours));
  }
  // a slot of only unknown-hours candidates asks for NO replacement: nothing
  // was learned against them, so nothing is bought to replace them
  assert.equal(L.slotReplacementNeed({ want: 3, kept: 3, open: 0, scheduleDropped: 0 }), 0);
});

test('a venue with no business hours at all (a beach, a viewpoint) is never rejected', () => {
  // Google returns no hours for natural features. That must read as "no opinion",
  // never as "closed", or the app would delete every beach on the island.
  const beach = { type: 'activity', title: 'Loh Dalum Beach', startDate: WED, startTime: '08:00' };
  assert.equal(L.candidateScheduleTier({ hours: null }, beach).tier, 'unknown');
  // and a non-visit (a travel leg, a note, a stay) is not schedule-judged at all
  for (const type of ['local', 'transport', 'flight', 'note', 'stay']) {
    const v = L.candidateScheduleTier({ hours: daily('10:00', '18:00') }, { type, title: 'x', startDate: WED, startTime: '08:00' });
    assert.equal(v.tier, 'unknown', type);
    assert.equal(v.checked, false, type);
  }
});

// ---------- §16 / §17: future dates, weekdays and timezones ----------

test('FUTURE DATES are judged by the weekday of the itinerary date, never by "now"', () => {
  // Open Monday to Friday only. 2027-02-01 is a Monday, 2027-02-02 a Tuesday,
  // and both are more than a year out.
  const weekdaysOnly = onDays([1, 2, 3, 4, 5], '08:00', '17:00');
  const at = (date, time) => L.candidateScheduleTier({ hours: weekdaysOnly },
    { type: 'activity', meal: 'lunch', title: 'X', startDate: date, startTime: time }).tier;
  assert.equal(at(MON, '08:00'), 'open', 'Monday 08:00 is inside Mon-Fri 08:00-17:00');
  assert.equal(at(TUE, '08:00'), 'open');
  // 2027-01-30 is a Saturday and 2027-01-31 a Sunday: shut both days
  assert.equal(at('2027-01-30', '08:00'), 'invalid');
  assert.equal(at('2027-01-31', '08:00'), 'invalid');
  assert.equal(
    L.candidateScheduleTier({ hours: weekdaysOnly }, { type: 'activity', meal: 'lunch', title: 'X', startDate: '2027-01-30', startTime: '08:00' }).reason,
    'closed_at_requested_time', 'a day it never opens is closed, not "opens later"');
});

test('TIMEZONE: the weekday comes from the calendar date, not from the machine', () => {
  // The trip is in Thailand (UTC+7) and the browser may be anywhere. hoursDow
  // parses the ISO date at UTC midnight, so the weekday of "2027-01-27" is
  // Wednesday in Louisiana, in Bangkok and on a server in Frankfurt.
  const wedOnly = onDays([3], '07:00', '11:00');   // Wednesdays only
  const run = () => L.candidateScheduleTier({ hours: wedOnly }, breakfastAt('08:00')).tier;
  const zones = ['UTC', 'America/Chicago', 'Asia/Bangkok', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
  const before = process.env.TZ;
  try {
    for (const tz of zones) {
      process.env.TZ = tz;
      assert.equal(run(), 'open', `Wednesday 08:00 must be open with TZ=${tz}`);
      // and the Thursday next door must be shut in every one of them
      assert.equal(
        L.candidateScheduleTier({ hours: wedOnly }, breakfastAt('08:00', THU)).tier, 'invalid',
        `Thursday must be shut with TZ=${tz}`);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('the itinerary time is the VENUE\'s local time, and no conversion happens anywhere', () => {
  // A Bangkok restaurant open 07:00-10:00 local, judged against a 08:00 local
  // itinerary time. If any UTC conversion crept in, +07:00 would move this to
  // 01:00 and the venue would read as shut.
  const v = L.candidateScheduleTier({ hours: daily('07:00', '10:00') }, breakfastAt('08:00'));
  assert.equal(v.tier, 'open');
  assert.equal(v.closesMin, 600, 'minutes past midnight, in the venue\'s own day');
});

// ---------- §19: cross-midnight ----------

test('CROSS-MIDNIGHT: an 18:00-02:00 venue is open at 01:00 the next morning', () => {
  const bar = {
    always: false,
    periods: [0, 1, 2, 3, 4, 5, 6].map(d => ({ open: { day: d, min: hhmm('18:00') }, close: { day: (d + 1) % 7, min: hhmm('02:00') } })),
    special: [],
  };
  const at = time => L.candidateScheduleTier({ hours: bar },
    { type: 'activity', meal: 'drinks', title: 'Bar', startDate: WED, startTime: time });
  assert.equal(at('23:00').tier, 'open');
  assert.equal(at('01:00').tier, 'open', 'the spill-over from the night before');
  assert.equal(at('01:59').status, 'closingSoon', 'open, but one minute of drinking left');
  assert.equal(at('03:00').tier, 'invalid');
  assert.equal(at('03:00').reason, 'opens_after_slot', 'it opens again at 18:00 the same day');
  assert.equal(at('17:00').reason, 'opens_after_slot');
  assert.equal(at('18:00').tier, 'open');
  // 00:00 exactly, on both sides of the boundary
  assert.equal(at('00:00').tier, 'open');
});

test('a venue that shut earlier that day says so, and is told apart from one that never opened', () => {
  const f = { type: 'activity', meal: 'dinner', title: 'X', startDate: WED, startTime: '20:00' };
  // lunch only: it opened and closed before dinner
  const lunchOnly = L.candidateScheduleTier({ hours: daily('11:00', '15:00') }, f);
  assert.equal(lunchOnly.tier, 'invalid');
  assert.equal(lunchOnly.reason, 'closes_before_slot');
  // shut all Wednesday: never opened at all
  const closedWed = L.candidateScheduleTier({ hours: onDays([0, 1, 2, 4, 5, 6], '11:00', '23:00') }, f);
  assert.equal(closedWed.reason, 'closed_at_requested_time');
});

// ---------- §18: the planned duration, not just the opening minute ----------

test('THE SITTING MATTERS: a venue that shuts 15 minutes into breakfast is not a breakfast place', () => {
  // Open 06:00-08:15 against an 08:00 breakfast. Technically open at the minute
  // asked; useless for the meal.
  const v = L.candidateScheduleTier({ hours: daily('06:00', '08:15') }, breakfastAt('08:00'));
  assert.equal(v.status, 'closingSoon');
  assert.equal(v.tier, 'invalid', 'ineligible for the slot, exactly as the accept gate has always treated it');
  assert.equal(v.reason, 'closes_before_slot');
  assert.equal(v.minutesLeft, 15);
  assert.equal(v.windowMin, 45, 'a sat-down breakfast is a 45-minute sitting');
});

test('each kind is judged by its own sitting, and the boundary is inclusive', () => {
  const kinds = { breakfast: 45, brunch: 60, lunch: 45, dinner: 60, drinks: 45, cafe: 30, snack: 30 };
  for (const [meal, win] of Object.entries(kinds)) {
    const f = { type: 'activity', meal, title: 'X', startDate: WED, startTime: '12:00' };
    assert.equal(L.recommendWindowMin(f), win, meal);
    // exactly `win` minutes left is still open; one minute less is not
    const closeAt = m => `${String(Math.floor((720 + m) / 60)).padStart(2, '0')}:${String((720 + m) % 60).padStart(2, '0')}`;
    assert.equal(L.candidateScheduleTier({ hours: daily('06:00', closeAt(win)) }, f).tier, 'open', meal + ' at the boundary');
    assert.equal(L.candidateScheduleTier({ hours: daily('06:00', closeAt(win - 1)) }, f).tier, 'invalid', meal + ' one minute short');
  }
});

test('a museum and a shop are judged by their own windows too, not only meals', () => {
  // §9: this is not a breakfast feature.
  const visit = (title, time, hours) => L.candidateScheduleTier({ hours },
    { type: 'activity', title, mapsQuery: title, startDate: WED, startTime: time });
  // a museum needs an hour: arriving at 16:30 for a 17:00 close is not a visit
  assert.equal(visit('British Museum', '16:30', daily('10:00', '17:00')).tier, 'invalid');
  assert.equal(visit('British Museum', '16:00', daily('10:00', '17:00')).tier, 'open');
  // a shop wants 30 minutes
  assert.equal(visit('Borough Market', '17:45', daily('09:00', '18:00')).tier, 'invalid');
  assert.equal(visit('Borough Market', '17:30', daily('09:00', '18:00')).tier, 'open');
  // and a museum closed on Wednesday is refused for the day, whatever the hour
  assert.equal(visit('Rijksmuseum', '11:00', onDays([0, 1, 2, 4, 5, 6], '09:00', '17:00')).reason, 'closed_at_requested_time');
});

// ---------- ranking ----------

test('INVARIANT: inside a slot, a confirmed-open candidate outranks a better-rated unknown one', () => {
  const f = breakfastAt('08:00');
  const unknownButGreat = {
    ...cand('Unknown 4.9', null, f),
    time: '08:00', score: L.placeQualityScore({ rating: 4.9, userRatingCount: 5000 }, 1),
  };
  const openButOrdinary = {
    ...cand('Open 4.1', daily('07:00', '12:00'), f),
    time: '08:00', score: L.placeQualityScore({ rating: 4.1, userRatingCount: 300 }, 1),
  };
  const ranked = L.rankVerifiedPlaces([unknownButGreat, openButOrdinary]);
  assert.deepEqual(ranked.map(x => x.name), ['Open 4.1', 'Unknown 4.9']);
});

test('a real schedule still keeps its clock order: tiers only break ties within a slot', () => {
  const mk = (name, time, tier) => ({ name, time, score: 1, schedule: { tier } });
  const ranked = L.rankVerifiedPlaces([
    mk('dinner', '19:00', 'open'),
    mk('breakfast', '08:00', 'unknown'),
    mk('lunch', '13:00', 'open'),
  ]);
  assert.deepEqual(ranked.map(x => x.name), ['breakfast', 'lunch', 'dinner'],
    'the day is not reordered by hours quality');
});

// ---------- §8 / §15 of the request: the first stop is a constraint ----------

test('FIRST STOP: the day is pulled to the hour the traveller asked for', () => {
  const c = { date: WED, firstStopTime: '08:00' };
  const plan = L.firstStopShiftPlan([
    { pid: 'b1', type: 'activity', startDate: WED, startTime: '09:00' },
    { pid: 'b2', type: 'activity', startDate: WED, startTime: '09:00' },
    { pid: 'b3', type: 'activity', startDate: WED, startTime: '09:00' },
    { pid: 'a1', type: 'activity', startDate: WED, startTime: '11:00' },
  ], c);
  assert.equal(plan.applied, true);
  assert.equal(plan.targetTime, '08:00');
  assert.equal(plan.from, '09:00');
  assert.deepEqual(plan.shiftPids, ['b1', 'b2', 'b3'], 'the whole first slot moves together');
});

test('FIRST STOP: travel to it is exempt, which is what the request actually says', () => {
  const c = { date: WED, firstStopTime: '08:00' };
  const plan = L.firstStopShiftPlan([
    { pid: 'taxi', type: 'local', startDate: WED, startTime: '07:15' },
    { pid: 'b1', type: 'activity', startDate: WED, startTime: '08:00' },
  ], c);
  assert.equal(plan.applied, false);
  assert.equal(plan.reason, 'already_met', 'the 07:15 ride is the contract being honoured, not the first stop');
});

test('INVARIANT E: an explicit first-stop hour is never moved to suit a venue', () => {
  // The shift plan is computed from times and types ONLY. There is no hours
  // input to it, so no venue's opening time can reach it. This test is the
  // guard on that: the same day, with a wildly different set of hours attached
  // to the venues, produces the identical plan.
  const c = { date: WED, firstStopTime: '08:00' };
  const rows = [
    { pid: 'b1', type: 'activity', startDate: WED, startTime: '09:00', hours: daily('10:30', '22:00') },
    { pid: 'b2', type: 'activity', startDate: WED, startTime: '09:00', hours: daily('06:00', '11:00') },
  ];
  const a = L.firstStopShiftPlan(rows, c);
  const b = L.firstStopShiftPlan(rows.map(r => ({ ...r, hours: null })), c);
  assert.deepEqual(a, b);
  assert.equal(a.targetTime, '08:00', 'never 10:30, whatever the restaurant does');
});

test('FIRST STOP: a day the model built to another shape is left alone, not reordered', () => {
  const c = { date: WED, firstStopTime: '08:00' };
  // The second stop is at 08:00 already: pulling the 07:00 one forward would
  // stack two stops on the same minute.
  const plan = L.firstStopShiftPlan([
    { pid: 'x', type: 'activity', startDate: WED, startTime: '07:00' },
    { pid: 'y', type: 'activity', startDate: WED, startTime: '08:00' },
  ], c);
  assert.equal(plan.applied, false);
  assert.equal(plan.reason, 'would_collide');
});

test('FIRST STOP: nothing to move, nothing on the day, or no constraint at all', () => {
  assert.equal(L.firstStopShiftPlan([], { date: WED, firstStopTime: '08:00' }).reason, 'no_candidates');
  assert.equal(L.firstStopShiftPlan([{ pid: 'a', type: 'activity', startDate: THU, startTime: '09:00' }],
    { date: WED, firstStopTime: '08:00' }).reason, 'no_candidates', 'another day is another day');
  assert.equal(L.firstStopShiftPlan([{ pid: 'a', type: 'activity', startDate: WED, startTime: '09:00' }],
    { date: WED, firstStopTime: '' }).reason, 'no_constraint');
  assert.equal(L.firstStopShiftPlan([{ pid: 'a', type: 'activity', startDate: WED, startTime: '' }],
    { date: WED, firstStopTime: '08:00' }).reason, 'no_candidates', 'an untimed item is not a stop');
});

test('the picker\'s answers become a structure the pipeline can enforce', () => {
  const c = L.planConstraintsFrom({
    date: WED, wakeTime: '08:00', returnTime: '22:00',
    meals: { breakfast: true, lunch: true, dinner: false }, activities: 3, drinks: 0,
  });
  assert.equal(c.date, WED);
  assert.equal(c.firstStopTime, '08:00');
  assert.equal(c.returnBy, '22:00');
  assert.deepEqual(c.meals, ['breakfast', 'lunch']);
  assert.equal(c.mealOptions, L.PLAN_MEAL_OPTIONS);
  assert.equal(c.activityOptions, L.PLAN_ACTIVITY_OPTIONS);
  // and the same structure is what the request text is worded from, so the
  // model and the enforcement can never be given different contracts
  const text = L.buildPlanRequest({
    date: WED, wakeTime: '08:00', returnTime: '22:00',
    meals: { breakfast: true, lunch: true, dinner: false }, activities: 3, drinks: 0,
    styles: {}, budget: [2],
  }, { items: [] });
  assert.match(text, /first planned stop at 8:00 AM/);
  assert.match(text, /back at my hotel by 10:00 PM/);
});

test('defaults hold when the picker sends nothing usable', () => {
  const c = L.planConstraintsFrom({});
  assert.equal(c.firstStopTime, '08:00');
  assert.equal(c.returnBy, '22:00');
  assert.equal(L.planConstraintsFrom(null).firstStopTime, '08:00');
});

// ---------- §13: a structured plan is a discovery request ----------

test('the guided plan text does NOT read as discovery, which is exactly why plan is passed as DATA', () => {
  // This is the regression that caused the whole report: the picker's own
  // wording contains no "find" / "recommend" / "suggest", so the intent regex
  // says no and the guided path used to skip verification altogether. The regex
  // is not "fixed" (widening it would swallow explicit-place requests); the
  // structured request is threaded through instead.
  const text = L.buildPlanRequest({
    date: WED, wakeTime: '08:00', returnTime: '22:00',
    meals: { breakfast: true, lunch: true, dinner: true }, activities: 3, drinks: 0,
    styles: {}, budget: [2],
  }, { items: [] });
  assert.equal(L.assistDiscoveryIntent(text).discovery, false,
    'the words alone still do not read as discovery');
  assert.match(text, /give me 3 options for each one/,
    'while the request plainly asks us to find nine venues');
});

test('a slot knows what to search for, per category', () => {
  assert.equal(L.slotDiscoveryQuery('breakfast', 'Ko Phi Phi'), 'breakfast restaurant Ko Phi Phi');
  assert.equal(L.slotDiscoveryQuery('lunch', 'Railay Beach'), 'lunch restaurant Railay Beach');
  assert.equal(L.slotDiscoveryQuery('dinner', 'Ao Nang'), 'dinner restaurant Ao Nang');
  assert.equal(L.slotDiscoveryQuery('drinks', 'Tokyo'), 'bar Tokyo');
  assert.equal(L.slotDiscoveryQuery('cafe', 'Kyoto'), 'cafe Kyoto');
  assert.equal(L.slotDiscoveryQuery('activity', 'Krabi'), 'tourist attraction Krabi');
  // no city is still a usable query (the area rectangle carries the geography)
  assert.equal(L.slotDiscoveryQuery('breakfast', ''), 'breakfast restaurant');
  // and an unknown kind has no category search, so nothing is invented
  assert.equal(L.slotDiscoveryQuery('nonsense', 'Tokyo'), '');
  assert.equal(L.slotDiscoveryQuery('', 'Tokyo'), '');
});

test('candidates are filed by SLOT: a shared group is one question', () => {
  const a = { pid: 'p1', group: 'breakfast-2027-01-27' };
  const b = { pid: 'p2', group: 'breakfast-2027-01-27' };
  const c = { pid: 'p3', group: 'lunch-2027-01-27' };
  const d = { pid: 'p4' };
  assert.equal(L.proposalSlotKey(a), L.proposalSlotKey(b));
  assert.notEqual(L.proposalSlotKey(a), L.proposalSlotKey(c));
  assert.notEqual(L.proposalSlotKey(d), L.proposalSlotKey(a), 'an ungrouped proposal is its own slot');
});

// ---------- §12: the bounded strategy ----------

test('the replacement budget is bounded, and the bounds are the documented ones', () => {
  assert.equal(L.DISCOVERY_REPLACEMENT_ROUNDS, 1);
  assert.equal(L.DISCOVERY_REPLACEMENTS_PER_ROUND, 4);
  assert.equal(L.DISCOVERY_CANDIDATE_MAX, 12);
  assert.equal(L.SLOT_REPLACEMENT_BUDGET, 6, 'the whole reply shares this, not each slot');
  assert.equal(L.SLOT_REPLACEMENT_SEARCHES, 3, 'and only three slots may go shopping per reply');
});

test('§29: an honest shortfall is stated, and reads differently from a provider failure', () => {
  const f = t => t;   // the 24-hour formatter, injected as everywhere else
  assert.equal(
    L.scheduleShortfallNote([{ kind: 'breakfast', time: '08:00', requested: 3, open: 1, unknown: 0, closed: 2 }], f),
    'I could confirm one breakfast place open at 08:00, not three.');
  assert.equal(
    L.scheduleShortfallNote([{ kind: 'breakfast', time: '08:00', requested: 3, open: 0, unknown: 0, closed: 3 }], f),
    'I could not confirm any breakfast place open at 08:00, so none is offered for that slot.');
  // hours unavailable is a different sentence again
  assert.match(
    L.scheduleShortfallNote([{ kind: 'lunch', time: '13:00', requested: 3, open: 2, unknown: 1, closed: 1 }], f),
    /no opening hours for one of the lunch options shown/);
  // a slot that was filled says nothing at all
  assert.equal(L.scheduleShortfallNote([{ kind: 'dinner', time: '19:00', requested: 3, open: 3, unknown: 0, closed: 0 }], f), '');
  assert.equal(L.scheduleShortfallNote([], f), '');
  // NOR does a slot that went fine with hours nobody could check: a beach has
  // no business hours, and "I could confirm zero activity places open at 10:00"
  // is a sentence about nothing that went wrong.
  assert.equal(L.scheduleShortfallNote([{ kind: 'activity', time: '10:00', requested: 1, open: 0, unknown: 1, closed: 0 }], f), '');
  // NOR a slot emptied by IDENTITY failures (the venue does not exist). Blaming
  // the clock for a hallucinated venue is the wrong sentence; that shortfall
  // belongs to rebuildAssistProse, which says "verify" because existence is
  // what was in question.
  assert.equal(L.scheduleShortfallNote([{ kind: 'activity', time: '14:00', requested: 3, open: 0, unknown: 0, closed: 0 }], f), '');
  // but when hours DID refuse something, the unconfirmed filler is named
  assert.match(
    L.scheduleShortfallNote([{ kind: 'activity', time: '10:00', requested: 2, open: 0, unknown: 1, closed: 1 }], f),
    /^I could not confirm any activity place open at 10:00, so what is offered here is unconfirmed\./);
});

test('the prose sanitizer matches WHOLE WORDS, so a kept venue cannot rescue a dropped one', () => {
  // The substring form scored "star" (of "Morning Star Kitchen", a surviving
  // replacement) against the word "start", which kept a REJECTED venue's
  // recommendation in the answer with no card under it.
  const text = 'Only Noodles is a great start to the morning.';
  const out = L.rebuildAssistProse(text, {
    kept: ['Morning Star Kitchen'], rejected: ['Only Noodles'], requested: 3,
  });
  assert.equal(out.text, '', 'the block naming only a rejected venue goes');
  // and a block that genuinely names a survivor is still kept
  const keepMe = 'Morning Star Kitchen opens early and is five minutes away.';
  assert.equal(L.rebuildAssistProse(keepMe, { kept: ['Morning Star Kitchen'], rejected: ['Only Noodles'] }).text, keepMe);
});

// ---------- §20: provenance ----------

test('INVARIANT D: the hours that decide come from the provider entry, never from the model', () => {
  const f = breakfastAt('08:00');
  // A proposal carrying model-authored "hours" in its own fields changes
  // nothing: candidateScheduleTier reads the resolved ENTRY, and an entry with
  // no hours is unknown however confidently the action was written.
  const lying = { ...f, details: 'Open from 6am daily!', hours: daily('06:00', '12:00') };
  assert.equal(L.candidateScheduleTier({ status: 'ok', rating: 4.8 }, lying).tier, 'unknown');
  // while the same fields against a real entry are judged by that entry
  assert.equal(L.candidateScheduleTier({ status: 'ok', hours: daily('10:30', '22:00') }, lying).tier, 'invalid');
});
