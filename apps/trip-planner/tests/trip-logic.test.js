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

// ---------- ICS export ----------

test('buildIcs maps a stay to an all-day event with exclusive end', () => {
  const ics = L.buildIcs({ name: 'Trip', items: [
    stay('s', 'Tokyo', '2027-01-10', '2027-01-14'),
  ] });
  assert.match(ics, /DTSTART;VALUE=DATE:20270110/);
  assert.match(ics, /DTEND;VALUE=DATE:20270114/);
  assert.match(ics, /SUMMARY:Tokyo hotel/);
  // CRLF line endings in the generated string
  assert.ok(ics.includes('\r\n'));
});

test('buildIcs makes an overnight timed flight a floating VEVENT (no Z, no TZID)', () => {
  const it = { id: 'f', type: 'flight', title: 'SHV to HND', location: '', startDate: '2027-01-01', endDate: '2027-01-02', startTime: '23:30', endTime: '06:15', status: 'booked' };
  const ics = L.buildIcs({ name: 'T', items: [it] });
  assert.match(ics, /DTSTART:20270101T233000/);
  assert.match(ics, /DTEND:20270102T061500/);
  assert.ok(!/DTSTART:20270101T233000Z/.test(ics));
  assert.ok(!ics.includes('TZID'));
  assert.ok(!ics.includes('VTIMEZONE'));
});

test('buildIcs: timed event with no arrival date/time ends at DTSTART', () => {
  const it = { id: 'f', type: 'transport', title: 'Train', location: '', startDate: '2027-01-05', endDate: '', startTime: '09:00', endTime: '', status: 'booked' };
  const ics = L.buildIcs({ name: 'T', items: [it] });
  assert.match(ics, /DTSTART:20270105T090000/);
  assert.match(ics, /DTEND:20270105T090000/);
});

test('buildIcs makes untimed items single all-day events', () => {
  const it = { id: 'a', type: 'activity', title: 'Museum', location: 'Rome', startDate: '2027-01-05', endDate: '', startTime: '', status: 'to-book' };
  const ics = L.buildIcs({ name: 'T', items: [it] });
  assert.match(ics, /DTSTART;VALUE=DATE:20270105/);
  assert.match(ics, /DTEND;VALUE=DATE:20270106/);
});

test('buildIcs excludes cancelled items', () => {
  const ics = L.buildIcs({ name: 'T', items: [
    stay('keep', 'Tokyo', '2027-01-10', '2027-01-12'),
    stay('drop', 'Osaka', '2027-01-12', '2027-01-14', 'cancelled'),
  ] });
  assert.ok(ics.includes('keep@trip-planner.shevato.com'));
  assert.ok(!ics.includes('drop@trip-planner.shevato.com'));
});

test('buildIcs uses a stable per-item UID', () => {
  const ics = L.buildIcs({ name: 'T', items: [stay('abc-123', 'Tokyo', '2027-01-10', '2027-01-12')] });
  assert.match(ics, /UID:abc-123@trip-planner\.shevato\.com/);
});

test('buildIcs escapes commas, semicolons and newlines per RFC 5545', () => {
  const it = { id: 'n', type: 'note', title: 'Pack; check, twice', location: '', startDate: '2027-01-05', endDate: '', startTime: '', status: 'booked', details: 'line1\nline2' };
  const ics = L.buildIcs({ name: 'T', items: [it] });
  assert.match(ics, /SUMMARY:Pack\\; check\\, twice/);
  assert.match(ics, /DESCRIPTION:line1\\nline2/);
});

// ---------- currency conversion ----------

test('convertAmount returns the amount unchanged for same currency (no rates needed)', () => {
  assert.equal(L.convertAmount(100, 'USD', 'USD', null), 100);
});

test('convertAmount converts foreign into base using the rate table', () => {
  const rates = { base: 'USD', rates: { EUR: 0.9, JPY: 150 } };
  // 90 EUR into USD base = 90 / 0.9 = 100
  assert.equal(L.convertAmount(90, 'EUR', 'USD', rates), 100);
  // base into foreign
  assert.equal(L.convertAmount(1, 'USD', 'JPY', rates), 150);
});

test('convertAmount returns null when a needed rate is missing', () => {
  const rates = { base: 'USD', rates: { EUR: 0.9 } };
  assert.equal(L.convertAmount(100, 'THB', 'USD', rates), null);
  assert.equal(L.convertAmount(100, 'EUR', 'USD', null), null);
});

test('sumInCurrency totals convertible items and flags the rest', () => {
  const rates = { base: 'USD', rates: { EUR: 0.5 } };
  const items = [
    { cost: 100, costCurrency: 'USD' },   // 100
    { cost: 50, costCurrency: 'EUR' },    // 50 / 0.5 = 100
    { cost: 30, costCurrency: 'THB' },    // no rate -> unconverted
    { cost: null, costCurrency: 'USD' },  // ignored
  ];
  const res = L.sumInCurrency(items, 'USD', rates);
  assert.equal(res.total, 200);
  assert.equal(res.unconverted.length, 1);
  assert.equal(res.unconverted[0].costCurrency, 'THB');
});

test('sumInCurrency treats a missing costCurrency as the trip currency', () => {
  const items = [{ cost: 40 }, { cost: 60 }];
  const res = L.sumInCurrency(items, 'USD', null);
  assert.equal(res.total, 100);
  assert.equal(res.unconverted.length, 0);
});

// ---------- base64url ----------

test('base64url round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 42]);
  const str = L.bytesToBase64url(bytes);
  assert.ok(!/[+/=]/.test(str));
  assert.deepEqual([...L.base64urlToBytes(str)], [...bytes]);
});

test('base64url round-trips every remainder length', () => {
  for (let n = 0; n < 8; n++) {
    const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));
    assert.deepEqual([...L.base64urlToBytes(L.bytesToBase64url(bytes))], [...bytes]);
  }
});

// ---------- continuity gaps ----------

function transport(id, title, startDate, endDate = '', status = 'booked', type = 'flight') {
  return { id, type, title, location: '', startDate, endDate, status };
}

test('transportGaps flags a city change with no flight or transport between', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2027-01-01', '2027-01-05'),
    stay('k', 'Kyoto', '2027-01-05', '2027-01-08'),
  ] };
  const gaps = L.transportGaps(trip);
  assert.equal(gaps.length, 1);
  assert.deepEqual(
    { from: gaps[0].fromLocation, to: gaps[0].toLocation, s: gaps[0].gapStart, e: gaps[0].gapEnd },
    { from: 'Tokyo', to: 'Kyoto', s: '2027-01-05', e: '2027-01-05' },
  );
});

test('transportGaps: a transport dated inside the window clears the gap', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2027-01-01', '2027-01-05'),
    transport('x', 'Tokyo to Kyoto', '2027-01-05', '', 'booked', 'transport'),
    stay('k', 'Kyoto', '2027-01-05', '2027-01-08'),
  ] };
  assert.equal(L.transportGaps(trip).length, 0);
});

test('transportGaps skips same-city consecutive stays', () => {
  const trip = { items: [
    stay('a', 'Tokyo', '2027-01-01', '2027-01-05'),
    stay('b', 'Tokyo', '2027-01-05', '2027-01-08'),
  ] };
  assert.equal(L.transportGaps(trip).length, 0);
});

test('transportGaps ignores a cancelled transport (gap stays)', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2027-01-01', '2027-01-05'),
    transport('x', 'Tokyo to Kyoto', '2027-01-05', '', 'cancelled', 'transport'),
    stay('k', 'Kyoto', '2027-01-05', '2027-01-08'),
  ] };
  assert.equal(L.transportGaps(trip).length, 1);
});

test('transportGaps skips a cancelled stay in the pairing', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2027-01-01', '2027-01-05'),
    stay('x', 'Osaka', '2027-01-05', '2027-01-06', 'cancelled'),
    stay('k', 'Kyoto', '2027-01-06', '2027-01-08'),
  ] };
  const gaps = L.transportGaps(trip);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fromLocation, 'Tokyo');
  assert.equal(gaps[0].toLocation, 'Kyoto');
});

// ---------- trip phase ----------

test('tripPhase: before, during (first/last day) and after boundaries', () => {
  assert.equal(L.tripPhase('2027-01-10', '2027-01-14', '2027-01-09').phase, 'before');
  const first = L.tripPhase('2027-01-10', '2027-01-14', '2027-01-10');
  assert.equal(first.phase, 'during');
  assert.equal(first.dayNumber, 1);
  assert.equal(first.totalDays, 5);
  const last = L.tripPhase('2027-01-10', '2027-01-14', '2027-01-14');
  assert.equal(last.phase, 'during');
  assert.equal(last.dayNumber, 5);
  assert.equal(L.tripPhase('2027-01-10', '2027-01-14', '2027-01-15').phase, 'after');
});

test('isPastRow: stays by check-out, others by end or start', () => {
  const today = '2027-01-10';
  assert.equal(L.isPastRow(stay('s', 'Tokyo', '2027-01-05', '2027-01-09'), today), true);
  assert.equal(L.isPastRow(stay('s', 'Tokyo', '2027-01-05', '2027-01-10'), today), false);
  assert.equal(L.isPastRow(flight('f', 'X', '2027-01-08', '2027-01-09'), today), true);
  assert.equal(L.isPastRow(flight('f', 'X', '2027-01-11'), today), false);
  assert.equal(L.isPastRow(flight('f', 'X', '2027-01-09'), today), true);
});

// ---------- day cards ----------

function timedItem(id, type, title, startDate, startTime = '', status = 'booked') {
  return { id, type, title, location: '', startDate, endDate: '', startTime, status, createdAt: id };
}

test('dayCards yields one card per date, start..end inclusive', () => {
  const trip = { items: [
    flight('f', 'JFK to FCO', '2027-03-01'),
    stay('h', 'Rome', '2027-03-01', '2027-03-05'),
  ] };
  const cards = L.dayCards(trip);
  assert.equal(cards.length, 5); // Mar 1..5 inclusive
  assert.equal(cards[0].date, '2027-03-01');
  assert.equal(cards[4].date, '2027-03-05');
  assert.equal(cards[0].dayNumber, 1);
  assert.equal(cards[4].dayNumber, 5);
  assert.equal(cards[0].totalDays, 5);
});

test('dayCards splits a stay into checkin and checkout on different days', () => {
  const trip = { items: [ stay('h', 'Rome', '2027-03-01', '2027-03-05') ] };
  const cards = L.dayCards(trip);
  assert.deepEqual(cards[0].events.map(e => e.kind), ['checkin']);
  assert.deepEqual(cards[4].events.map(e => e.kind), ['checkout']);
  assert.equal(cards[0].events[0].item.id, 'h');
});

test('dayCards reports stayingAt for interior days with no events', () => {
  const trip = { items: [ stay('h', 'Rome', '2027-03-01', '2027-03-05') ] };
  const cards = L.dayCards(trip);
  assert.equal(cards[1].stayingAt, 'Rome');
  assert.equal(cards[1].empty, false);
  assert.equal(cards[1].events.length, 0);
  // checkin/checkout days are not "staying" days
  assert.equal(cards[0].stayingAt, null);
  assert.equal(cards[4].stayingAt, null);
});

test('dayCards marks a bare day empty', () => {
  const trip = { items: [
    flight('a', 'A to B', '2027-03-01'),
    flight('b', 'B to C', '2027-03-03'),
  ] };
  const cards = L.dayCards(trip);
  assert.equal(cards[1].date, '2027-03-02');
  assert.equal(cards[1].empty, true);
  assert.equal(cards[1].stayingAt, null);
});

test('dayCards orders a day by time then type, checkout before checkin', () => {
  const trip = { items: [
    stay('leave', 'Rome', '2027-02-28', '2027-03-01'),
    stay('arrive', 'Florence', '2027-03-01', '2027-03-04'),
    timedItem('train', 'transport', 'Rome to Florence', '2027-03-01', '09:30'),
    timedItem('flight', 'flight', 'early flight', '2027-03-01', '07:00'),
  ] };
  const day = L.dayCards(trip).find(c => c.date === '2027-03-01');
  assert.deepEqual(
    day.events.map(e => e.kind === 'item' ? e.item.id : e.kind),
    ['flight', 'train', 'checkout', 'checkin']
  );
});

test('dayCards passes cancelled items through with their status', () => {
  // non-cancelled flights anchor the date range (tripStats drops cancelled),
  // so the cancelled stay's span stays visible in the cards.
  const trip = { items: [
    flight('f1', 'A to B', '2027-03-01'),
    flight('f2', 'B to C', '2027-03-05'),
    stay('h', 'Rome', '2027-03-01', '2027-03-05', 'cancelled'),
  ] };
  const cards = L.dayCards(trip);
  const checkin = cards[0].events.find(e => e.kind === 'checkin');
  assert.equal(checkin.item.status, 'cancelled');
  // a cancelled stay does not make an interior day a "staying" day
  assert.equal(cards[1].stayingAt, null);
  assert.equal(cards[1].empty, true);
});

test('dayCards returns [] without dated items', () => {
  assert.deepEqual(L.dayCards({ items: [] }), []);
});

// ---------- climate / weather ----------

test('weatherKey lowercases the place and pads the month', () => {
  assert.equal(L.weatherKey('Tokyo', 1), 'tokyo|01');
  assert.equal(L.weatherKey('  Rome ', 12), 'rome|12');
});

test('summarizeClimate averages and rounds, drops null samples', () => {
  const s = L.summarizeClimate([4, 6, null, 5], [14, 16, 15], [0, 0, 0]);
  assert.equal(s.lo, 5);   // (4+6+5)/3 = 5
  assert.equal(s.hi, 15);  // (14+16+15)/3 = 15
  assert.equal(s.wet, false);
});

test('summarizeClimate flags wet when >=30% of days rain', () => {
  assert.equal(L.summarizeClimate([10], [20], [2, 0, 3, 0, 1]).wet, true);   // 3/5
  assert.equal(L.summarizeClimate([10], [20], [2, 0, 0, 0, 0]).wet, false);  // 1/5
  assert.equal(L.summarizeClimate([10], [20]).wet, false);                   // no precip data
});

test('weatherLine says Typically and never forecasts', () => {
  const line = L.weatherLine('Tokyo', { lo: 3, hi: 10, wet: true });
  assert.match(line, /Typically/);
  assert.match(line, /Tokyo/);
  assert.match(line, /often rainy/);
  assert.doesNotMatch(line, /forecast|will be/);
  assert.equal(L.weatherLine('Tokyo', { lo: null, hi: 10, wet: false }), '');
});

// ---------- documents pocket guards ----------

test('docGuard enforces the 10-file and 2MB limits', () => {
  assert.deepEqual(L.docGuard(0, 1024), { ok: true });
  assert.deepEqual(L.docGuard(10, 1024), { ok: false, reason: 'count' });
  assert.deepEqual(L.docGuard(2, 2 * 1024 * 1024 + 1), { ok: false, reason: 'size' });
  assert.deepEqual(L.docGuard(2, 2 * 1024 * 1024), { ok: true });
});

test('slimTripForShare drops empties, timestamps and long ids but keeps data', () => {
  const trip = { name: 'T', currency: 'USD', budget: null, visaExtras: [],
    items: [{ id: 'f9b2c8d1-aaaa-bbbb-cccc-1234567890ab', type: 'flight', title: 'A to B',
      location: '', startDate: '2027-01-01', endDate: '', startTime: '07:35', endTime: '',
      status: 'booked', cost: 200, costCurrency: 'USD', costNote: '', details: '',
      createdAt: '2026-07-18T00:00:00Z' }] };
  const slim = L.slimTripForShare(trip);
  assert.equal(slim.items[0].id, 'i1');
  assert.equal(slim.items[0].createdAt, undefined);
  assert.equal(slim.items[0].location, undefined);
  assert.equal(slim.items[0].endTime, undefined);
  assert.equal(slim.items[0].title, 'A to B');
  assert.equal(slim.items[0].cost, 200);
  assert.equal(slim.budget, undefined);
  assert.equal(slim.visaExtras, undefined);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(trip).length * 0.6);
});
