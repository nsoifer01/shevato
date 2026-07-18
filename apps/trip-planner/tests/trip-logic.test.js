'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

function stay(id, location, startDate, endDate, status = 'booked', cost = null) {
  return { id, type: 'stay', title: `${location} hotel`, location, startDate, endDate, status, cost };
}
function flight(id, title, startDate, endDate = '', status = 'booked', cost = null) {
  return { id, type: 'flight', title, location: '', startDate, endDate, status, cost };
}

// ---------- dates ----------

test('isIsoDate accepts YYYY-MM-DD and rejects junk', () => {
  assert.equal(L.isIsoDate('2027-01-16'), true);
  assert.equal(L.isIsoDate('2027-13-40'), false);
  assert.equal(L.isIsoDate('16/01/2027'), false);
  assert.equal(L.isIsoDate(''), false);
  assert.equal(L.isIsoDate(null), false);
});

test('diffDays and addDays are inverse and cross month/year ends', () => {
  assert.equal(L.diffDays('2026-12-29', '2027-01-10'), 12);
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(L.addDays('2027-01-10', -12), '2026-12-29');
});

// ---------- item helpers ----------

test('nights counts stay nights and rejects non-stays and inverted ranges', () => {
  assert.equal(L.nights(stay('s', 'Tokyo', '2026-12-30', '2027-01-10')), 11);
  assert.equal(L.nights(flight('f', 'X to Y', '2027-01-16', '2027-01-17')), null);
  assert.equal(L.nights(stay('s', 'Tokyo', '2027-01-10', '2027-01-10')), null);
});

test('sortedItems orders by date, then time, then travel before stays', () => {
  const trip = { items: [
    stay('b', 'Bangkok', '2027-01-16', '2027-01-19'),
    flight('a', 'KIX to BKK', '2027-01-16'),
    stay('t', 'Tokyo', '2026-12-30', '2027-01-10'),
  ] };
  assert.deepEqual(L.sortedItems(trip).map(i => i.id), ['t', 'a', 'b']);
});

test('tripLegs finds consecutive stays in different places, skipping cancelled', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2026-12-30', '2027-01-10'),
    stay('k', 'Kyoto', '2027-01-10', '2027-01-16'),
    stay('x', 'Osaka', '2027-01-16', '2027-01-17', 'cancelled'),
    stay('b', 'Bangkok', '2027-01-17', '2027-01-19'),
  ] };
  const legs = L.tripLegs(trip);
  assert.deepEqual(legs.map(l => `${l.from}>${l.to}`), ['Tokyo>Kyoto', 'Kyoto>Bangkok']);
  assert.equal(legs[0].date, '2027-01-10');
  assert.equal(legs[0].toId, 'k');
});

// ---------- validation ----------

test('validateItem requires title and valid start date', () => {
  const errs = L.validateItem({ type: 'note', title: ' ', startDate: 'nope' });
  assert.equal(errs.title, true);
  assert.equal(errs.start, true);
});

test('validateItem: stay needs check-out strictly after check-in', () => {
  assert.ok(L.validateItem(stay('s', 'Tokyo', '2027-01-10', '2027-01-10')).end);
  assert.ok(L.validateItem(stay('s', 'Tokyo', '2027-01-10', '')).end);
  assert.deepEqual(L.validateItem(stay('s', 'Tokyo', '2027-01-10', '2027-01-11')), {});
});

test('validateItem: flight arrival may be same day but never earlier', () => {
  assert.deepEqual(L.validateItem(flight('f', 'HKT to SHV', '2027-02-05', '2027-02-05')), {});
  assert.deepEqual(L.validateItem(flight('f', 'SHV to HND', '2026-12-29', '2026-12-30')), {});
  assert.ok(L.validateItem(flight('f', 'X to Y', '2027-02-05', '2027-02-04')).end);
});

test('validateItem rejects negative cost, allows null', () => {
  assert.ok(L.validateItem({ ...flight('f', 'A to B', '2027-01-01'), cost: -5 }).cost);
  assert.deepEqual(L.validateItem({ ...flight('f', 'A to B', '2027-01-01'), cost: null }), {});
});

// ---------- coverage gaps ----------

test('coverageGaps finds a mid-trip hole between stays', () => {
  const gaps = L.coverageGaps([
    stay('a', 'Khao Lak', '2027-01-19', '2027-01-22'),
    stay('b', 'Railay', '2027-01-23', '2027-01-26'),
  ]);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { start: '2027-01-22', end: '2027-01-23', nights: 1 });
});

test('coverageGaps flags nights between last check-out and trip end', () => {
  const gaps = L.coverageGaps(
    [stay('a', 'Phuket', '2027-01-28', '2027-02-01')],
    '2027-02-05',
  );
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { start: '2027-02-01', end: '2027-02-05', nights: 4 });
});

test('coverageGaps treats overnight travel as covered nights', () => {
  const gaps = L.coverageGaps(
    [stay('a', 'Tokyo', '2026-12-30', '2027-01-02'), stay('b', 'Kyoto', '2027-01-03', '2027-01-05')],
    null,
    [flight('f', 'overnight train', '2027-01-02', '2027-01-03')],
  );
  assert.equal(gaps.length, 0);
});

test('coverageGaps returns nothing for a fully covered trip or no stays', () => {
  assert.deepEqual(L.coverageGaps([]), []);
  assert.deepEqual(L.coverageGaps([stay('a', 'Tokyo', '2027-01-01', '2027-01-05')]), []);
});

// ---------- trip stats ----------

test('tripStats: booked nights = union of booked stays and overnight travel', () => {
  const trip = { items: [
    flight('f1', 'SHV to HND', '2026-12-29', '2026-12-30'),        // night of Dec 29 on the plane
    stay('s1', 'Tokyo', '2026-12-30', '2027-01-02'),               // 3 nights
    stay('s2', 'Cheow Lan', '2027-01-02', '2027-01-03', 'decide'), // not booked
    stay('s3', 'Phuket', '2027-01-03', '2027-01-05'),              // 2 nights
  ] };
  const s = L.tripStats(trip);
  assert.equal(s.totalTripNights, 7);
  assert.equal(s.bookedNights, 6); // 1 transit + 3 + 2, decide-later night excluded
});

test('tripStats dedupes a night covered by both a red-eye and a stay', () => {
  const trip = { items: [
    flight('f', 'red-eye', '2027-01-01', '2027-01-02'),
    stay('s', 'City', '2027-01-01', '2027-01-03'),
  ] };
  assert.equal(L.tripStats(trip).bookedNights, 2);
});

test('tripStats sums confirmed vs planned costs and ignores cancelled', () => {
  const trip = { items: [
    stay('a', 'Tokyo', '2027-01-01', '2027-01-03', 'booked', 100),
    stay('b', 'Kyoto', '2027-01-03', '2027-01-05', 'to-book', 50),
    stay('c', 'Osaka', '2027-01-05', '2027-01-07', 'cancelled', 999),
  ] };
  const s = L.tripStats(trip);
  assert.equal(s.confirmed, 100);
  assert.equal(s.planned, 150);
});

test('tripStats trip end extends to a flight arrival date', () => {
  const trip = { items: [
    stay('a', 'Tokyo', '2027-01-01', '2027-01-03'),
    flight('f', 'home', '2027-01-03', '2027-01-04'),
  ] };
  const s = L.tripStats(trip);
  assert.equal(s.end, '2027-01-04');
});

// ---------- route helper math ----------

test('distKm: Tokyo to Kyoto is roughly 370 km', () => {
  const km = L.distKm({ lat: 35.6764, lon: 139.65 }, { lat: 35.0116, lon: 135.7681 });
  assert.ok(km > 340 && km < 400, `got ${km}`);
});

test('compass: Kyoto to Bangkok heads southwest', () => {
  assert.equal(L.compass({ lat: 35.0116, lon: 135.7681 }, { lat: 13.7563, lon: 100.5018 }), 'southwest');
});

test('fmtDur formats minutes and hours', () => {
  assert.equal(L.fmtDur(45), '45m');
  assert.equal(L.fmtDur(60), '1h');
  assert.equal(L.fmtDur(95), '1h 35m');
});

test('modeOptions: long haul offers flying, never walking', () => {
  const modes = L.modeOptions(4200, false);
  assert.ok(modes.some(m => m.name === 'Fly'));
  assert.ok(!modes.some(m => m.name === 'Walk'));
});

test('modeOptions: island legs get a ferry and no train', () => {
  const modes = L.modeOptions(45, true);
  assert.ok(modes.some(m => m.name === 'Ferry / speedboat'));
  assert.ok(!modes.some(m => m.name === 'Train'));
});

test('modeOptions: fast-rail note only shows for HSR countries', () => {
  const train = modes => modes.find(m => m.name === 'Train');
  assert.match(train(L.modeOptions(370, false, true)).note, /Shinkansen/);
  assert.equal(train(L.modeOptions(370, false, false)).note, 'where rail exists');
  assert.equal(train(L.modeOptions(370, false)).note, 'where rail exists');
});

test('hasFastRail knows HSR countries and rejects the rest', () => {
  assert.ok(L.hasFastRail('JP'));
  assert.ok(L.hasFastRail('fr'));
  assert.ok(!L.hasFastRail('TH'));
  assert.ok(!L.hasFastRail(''));
  assert.ok(!L.hasFastRail(undefined));
});

test('flagEmoji builds regional indicators and falls back to a pin', () => {
  assert.equal(L.flagEmoji('JP'), '🇯🇵');
  assert.equal(L.flagEmoji(''), '📍');
  assert.equal(L.flagEmoji('JPN'), '📍');
});

test('ISLANDISH matches Thai island spots but not cities', () => {
  assert.ok(L.ISLANDISH.test('Ko Phi Phi'));
  assert.ok(L.ISLANDISH.test('Railay Beach'));
  assert.ok(!L.ISLANDISH.test('Bangkok'));
});

// ---------- visa helpers ----------

test('classifyVisa maps dataset values to categories', () => {
  assert.deepEqual(L.classifyVisa('90'), { cls: 'free', label: 'Visa-free · up to 90 days' });
  assert.equal(L.classifyVisa('visa free').cls, 'free');
  assert.equal(L.classifyVisa('visa on arrival').cls, 'arrival');
  assert.equal(L.classifyVisa('e-visa').cls, 'evisa');
  assert.equal(L.classifyVisa('eta').cls, 'evisa');
  assert.equal(L.classifyVisa('visa required').cls, 'required');
  assert.equal(L.classifyVisa('no admission').cls, 'required');
  assert.equal(L.classifyVisa('-1').cls, 'home');
  assert.equal(L.classifyVisa('gibberish').cls, 'unknown');
  assert.equal(L.classifyVisa(null).cls, 'unknown');
});

test('parseVisaMatrix builds a passport x destination lookup', () => {
  const m = L.parseVisaMatrix('Passport,JP,TH,US\nUS,90,60,-1\nIL,90,visa free,eta\n');
  assert.deepEqual(m.codes, ['US', 'IL']);
  assert.equal(m.matrix.US.JP, '90');
  assert.equal(m.matrix.IL.TH, 'visa free');
  assert.equal(m.matrix.US.US, '-1');
  assert.equal(L.parseVisaMatrix(''), null);
  assert.equal(L.parseVisaMatrix('Passport,JP\nnot-a-code,90\n'), null);
});
