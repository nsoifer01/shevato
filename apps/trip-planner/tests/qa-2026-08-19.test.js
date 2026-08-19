'use strict';

// Regression cover for the 2026-08-19 exploratory QA round.
//
// This file holds the findings whose fix lives in PURE logic, so they are
// pinned here rather than through a browser: day-location inference (TP-02),
// example-trip currency (TP-04), transport-mode honesty (TP-05), temperature
// units (TP-19) and airport search relevance (TP-20). Everything else from that
// round is a DOM or state fact and is covered by e2e/qa-fixes.mjs instead.
//
// Each block names the finding it defends and, where the old behaviour was
// subtle, what it actually produced. A test that only asserted the new output
// would not stop the old bug coming back in a different shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../js/trip-logic.js');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
let n = 0;
const item = (over = {}) => Object.assign({
  id: `q${++n}`, type: 'activity', title: 'Something', location: '',
  startDate: '2026-11-01', endDate: '', startTime: '', endTime: '',
  status: 'to-book', cost: null, details: '', createdAt: `c${n}`,
}, over);

// The exact itinerary the QA run built by hand: an overnight transatlantic
// flight, and a Paris venue the app's own prefill left on the DEPARTURE day.
const JFK_CDG = () => [
  item({ id: 'f1', type: 'flight', title: 'New York (JFK) to Paris (CDG)', location: '',
    startDate: '2026-11-01', startTime: '19:00', endDate: '2026-11-02', endTime: '08:30', status: 'booked' }),
  item({ id: 'a1', title: 'Eiffel Tower', location: 'Paris', startDate: '2026-11-01' }),
];

// app.js injects a CACHE-ONLY probe. Cold is the state a brand new trip is in,
// and it is the state the bug needed.
const cold = () => false;
const warm = set => p => set.has(String(p).trim().toLowerCase());

// ---------------------------------------------------------------------------
// TP-02  the day's city, and the days that had none
// ---------------------------------------------------------------------------
test('TP-02: a departure day is named by where you LEAVE, on a cold cache', () => {
  // The bug: the travel-origin rung was gated on a cache-only geocode probe, so
  // on a brand new trip it was skipped and the day fell through to the city of
  // whatever activity sat on it. The day you fly OUT of New York was therefore
  // labelled "Paris", took Paris's weather, and drew a Paris walking route.
  const items = JFK_CDG();
  assert.deepEqual(L.dayMorningCity(items, '2026-11-01', cold),
    { city: 'New York', source: 'travel-origin' });
  // and identically once the cache is warm: the label must not depend on it
  assert.deepEqual(L.dayMorningCity(items, '2026-11-01', warm(new Set(['new york', 'paris']))),
    { city: 'New York', source: 'travel-origin' });
});

test('TP-02: an arrival day is named by where you LAND', () => {
  // Nov 2 is the day the traveller is actually in Paris. It had no city at all
  // (no rung answered it), so no city chip, no weather, and the assistant's day
  // list offered "Day 2" with no location context.
  const items = JFK_CDG();
  assert.deepEqual(L.dayMorningCity(items, '2026-11-02', cold),
    { city: 'Paris', source: 'arrival' });
});

test('TP-02: a same-day leg still opens in its ORIGIN', () => {
  // dayMorningCity answers "where does this day START", which dayAnchor builds
  // every day route from. A leg that leaves and lands on one date must not
  // relabel the morning as the destination.
  const items = [item({ id: 'f', type: 'flight', title: 'Tokyo (HND) to Osaka (ITM)',
    startDate: '2026-11-05', startTime: '10:30', endTime: '12:00', status: 'booked' })];
  assert.deepEqual(L.dayMorningCity(items, '2026-11-05', cold),
    { city: 'Tokyo', source: 'travel-origin' });
});

test('TP-02: a stay still outranks every travel rung', () => {
  const items = [
    item({ id: 's', type: 'stay', title: 'Hotel', location: 'Rome', startDate: '2026-11-01', endDate: '2026-11-05', status: 'booked' }),
    item({ id: 'f', type: 'flight', title: 'Rome (FCO) to Tokyo (HND)', startDate: '2026-11-05', startTime: '09:00', status: 'booked' }),
  ];
  assert.deepEqual(L.dayMorningCity(items, '2026-11-03', cold), { city: 'Rome', source: 'stay' });
  assert.deepEqual(L.dayMorningCity(items, '2026-11-05', cold), { city: 'Rome', source: 'stay' });
});

test('TP-02: the junk-title gate still holds, on BOTH travel rungs', () => {
  // The safeguard this fix had to keep. "Return to hotel" and "Travel to
  // Shibuya" are assistant-contract phrasings: a naive split names the day
  // "Return" / "Travel" / "hotel" and then fetches that non-place's weather.
  // Neither half carries a place code, so neither the origin nor the arrival
  // rung may accept it, and an unresolvable origin still falls through to a
  // genuinely located item on the same day.
  const back = [item({ id: 't', type: 'transport', title: 'Return to hotel', startDate: '2026-11-02', startTime: '08:00', status: 'booked' })];
  assert.deepEqual(L.dayMorningCity(back, '2026-11-02', cold), { city: '', source: '' });
  const go = [item({ id: 't', type: 'transport', title: 'Travel to Shibuya', startDate: '2026-11-02', startTime: '08:00', status: 'booked' })];
  assert.deepEqual(L.dayMorningCity(go, '2026-11-02', cold), { city: '', source: '' });
  const withLocated = [
    item({ id: 't', type: 'transport', title: 'Return to hotel', startDate: '2026-11-02', startTime: '08:00', status: 'booked' }),
    item({ id: 'a', title: 'Fish market', location: 'Osaka', startDate: '2026-11-02', startTime: '10:00', status: 'booked' }),
  ];
  assert.deepEqual(L.dayMorningCity(withLocated, '2026-11-02', cold), { city: 'Osaka', source: 'location' });
});

test('TP-02: a place code is what makes an uncached origin trustworthy', () => {
  // The mechanism, stated on its own: with no code and no cache entry the rung
  // declines (above); with a code it does not need the cache at all.
  const coded = [item({ id: 'f', type: 'flight', title: 'Shreveport (SHV) to Tokyo (HND)', startDate: '2026-11-01', status: 'booked' })];
  assert.equal(L.dayMorningCity(coded, '2026-11-01', cold).city, 'Shreveport');
  const bare = [item({ id: 'f', type: 'flight', title: 'Nowhereville to Tokyo', startDate: '2026-11-01', status: 'booked' })];
  assert.deepEqual(L.dayMorningCity(bare, '2026-11-01', cold), { city: '', source: '' });
  // ...and the cache is still a way to say yes, for a title with no code
  assert.equal(L.dayMorningCity(bare, '2026-11-01', warm(new Set(['nowhereville']))).city, 'Nowhereville');
});

test('TP-02: an item in a city you have not reached yet is flagged', () => {
  // The other half of the fix: the day LABEL is now right about where you are,
  // and this is what says the item is not. Deliberately narrow - see
  // arrivalConflicts - because a blunt city mismatch would fire on every day
  // trip and be turned off within a week.
  const c = L.arrivalConflicts(JFK_CDG());
  assert.equal(c.length, 1);
  assert.equal(c[0].title, 'Eiffel Tower');
  assert.equal(c[0].city, 'Paris');
  assert.equal(c[0].arriveDate, '2026-11-02');
});

test('TP-02: normal itineraries raise no arrival conflict', () => {
  // a day trip out of the city you are staying in
  const dayTrip = [
    item({ id: 's', type: 'stay', title: 'Hotel', location: 'Tokyo', startDate: '2026-11-01', endDate: '2026-11-06', status: 'booked' }),
    item({ id: 'a', title: 'Day trip to Nikko', location: 'Nikko', startDate: '2026-11-03' }),
  ];
  assert.deepEqual(L.arrivalConflicts(dayTrip), []);
  // a leg that lands the same day it leaves
  const sameDay = [
    item({ id: 'f', type: 'flight', title: 'Tokyo (HND) to Osaka (ITM)', startDate: '2026-11-05', endDate: '2026-11-05', status: 'booked' }),
    item({ id: 'a', title: 'Dotonbori', location: 'Osaka', startDate: '2026-11-05' }),
  ];
  assert.deepEqual(L.arrivalConflicts(sameDay), []);
  // the same item moved to the day it can actually happen
  const fixed = JFK_CDG();
  fixed[1].startDate = '2026-11-02';
  assert.deepEqual(L.arrivalConflicts(fixed), []);
  // a cancelled item is not a plan
  const cancelled = JFK_CDG();
  cancelled[1].status = 'cancelled';
  assert.deepEqual(L.arrivalConflicts(cancelled), []);
});

// ---------------------------------------------------------------------------
// TP-04  example trips and the currency their numbers are written in
// ---------------------------------------------------------------------------
// Everything the rates provider quotes. Kept here as an explicit list because
// the point of the test is that the samples do not drift away from it.
const FX_SUPPORTED = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF',
  'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP',
  'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);

test('TP-04: sample costs keep their AUTHORED currency in any trip currency', () => {
  // The bug: an unpinned sample cost took the trip's currency, so the same
  // number meant dollars in a USD trip and yen in a JPY one. Loading the Japan
  // example into a JPY trip produced a ¥310 international flight and a ¥980
  // five-night hotel next to the one item that really is yen (teamLab, ¥3,800).
  const seen = [];
  for (const cur of ['USD', 'EUR', 'JPY', 'HUF']) {
    const t = L.buildSampleTrip('japan', { today: '2026-08-19', currency: cur });
    const flight = t.items.find(i => /Seoul/.test(i.title));
    const hotel = t.items.find(i => /Ryumeikan/.test(i.title));
    const teamlab = t.items.find(i => /teamLab/.test(i.title));
    assert.equal(t.currency, cur, 'the TRIP currency is still the traveller\'s choice');
    assert.equal(flight.costCurrency, L.SAMPLE_BASE_CURRENCY, `flight currency in a ${cur} trip`);
    assert.equal(hotel.costCurrency, L.SAMPLE_BASE_CURRENCY, `hotel currency in a ${cur} trip`);
    assert.equal(teamlab.costCurrency, 'JPY', 'a pinned amount keeps its own currency');
    seen.push([flight.cost, hotel.cost, teamlab.cost].join('/'));
  }
  // the amounts themselves never move with the trip currency either
  assert.equal(new Set(seen).size, 1, 'sample amounts changed with the trip currency');
});

test('TP-04: every example is fully convertible and shows a foreign currency', () => {
  for (const opt of L.sampleTripOptions()) {
    const t = L.buildSampleTrip(opt.id, { today: '2026-08-19', currency: 'USD' });
    const codes = [...new Set(t.items.flatMap(i => [i.costCurrency, i.estCostCurrency]).filter(Boolean))];
    for (const c of codes) {
      assert.ok(FX_SUPPORTED.has(c),
        `${opt.id} prices something in ${c}, which the rates provider does not quote, so it would sit outside every total`);
    }
    // each sample still demonstrates the mixed-currency path
    assert.ok(t.items.some(i => i.costCurrency && i.costCurrency !== L.SAMPLE_BASE_CURRENCY),
      `${opt.id} has no foreign-currency item left`);
  }
});

test('TP-04: the sample base currency is a real, quoted currency', () => {
  assert.match(L.SAMPLE_BASE_CURRENCY, /^[A-Z]{3}$/);
  assert.ok(FX_SUPPORTED.has(L.SAMPLE_BASE_CURRENCY));
});

// ---------------------------------------------------------------------------
// TP-05  transport modes that cannot exist
// ---------------------------------------------------------------------------
test('TP-05: a leg with no land route loses its train and gains a ferry', () => {
  // London -> Dublin offered a 5h 31m train and a 7h 14m drive across the Irish
  // Sea, because "island" was decided by a resort-name regex that only ever
  // matched places like Koh Samui.
  assert.equal(L.seaCrossing('GB', 'IE'), true);
  const names = L.modeOptions(464, L.seaCrossing('GB', 'IE'), false).map(m => m.name);
  assert.ok(!names.includes('Train'), 'a train was offered across water');
  assert.ok(names.includes('Ferry'), 'no ferry offered on a sea crossing');
});

test('TP-05: road modes on a sea crossing say the ferry is not in the time', () => {
  const opts = L.modeOptions(464, L.seaCrossing('GB', 'IE'), false);
  for (const key of ['drive', 'bus']) {
    const m = opts.find(o => o.key === key);
    assert.ok(m, `${key} should still be offered - you can drive onto a boat`);
    assert.match(m.note, /ferry/i, `${key} does not mention the crossing`);
    assert.match(m.note, /NOT in this time/, `${key} does not say the crossing is excluded`);
  }
});

test('TP-05: fixed links and domestic legs keep their land modes', () => {
  // The cases a naive "island country" rule breaks. Every one of these has a
  // real train, and suppressing it would be a worse lie than the one being fixed.
  assert.equal(L.seaCrossing('GB', 'FR'), false, 'the Channel Tunnel exists');
  assert.equal(L.seaCrossing('SG', 'MY'), false, 'the Johor causeway exists');
  assert.equal(L.seaCrossing('JP', 'JP'), false, 'a domestic leg is never a crossing');
  assert.equal(L.seaCrossing('AU', 'AU'), false);
  assert.equal(L.seaCrossing('FR', 'DE'), false);
  for (const [a, b] of [['GB', 'FR'], ['JP', 'JP'], ['AU', 'AU']]) {
    assert.ok(L.modeOptions(400, L.seaCrossing(a, b), false).some(m => m.name === 'Train'),
      `${a}->${b} lost its train`);
  }
});

test('TP-05: an unknown country never invents a crossing', () => {
  // Unverifiable is not the same as "crosses water": with no country codes the
  // modes must be exactly what they were.
  assert.equal(L.seaCrossing('', ''), false);
  assert.equal(L.seaCrossing('PE', ''), false);
  assert.equal(L.seaCrossing(undefined, 'IE'), false);
});

test('TP-05: a train with no known network says the line may not exist', () => {
  // Lima -> Cusco printed "~6h 48m" and a fare for a city pair with no through
  // passenger railway. The duration stays (it is all we can compute) but the
  // card no longer implies either the line or the timetable is real.
  const note = L.modeOptions(570, false, false).find(m => m.key === 'rail').note;
  assert.match(note, /only if a through line runs/);
  assert.match(note, /estimated from distance, not a timetable/);
});

// ---------------------------------------------------------------------------
// TP-19  temperature units
// ---------------------------------------------------------------------------
test('TP-19: temperatures follow the unit preference', () => {
  try {
    L.setTempUnit('c');
    assert.equal(L.getTempUnit(), 'c');
    assert.equal(L.tempSpan(18, 28), '18-28°C');
    L.setTempUnit('f');
    assert.equal(L.getTempUnit(), 'f');
    assert.equal(L.tempSpan(18, 28), '64-82°F');
    // a below-zero span still spells the join out rather than printing "-12--7"
    assert.equal(L.tempSpan(-20, -10), '-4 to 14°F');
    L.setTempUnit('c');
    assert.equal(L.tempSpan(-12, -7), '-12 to -7°C');
    // anything unrecognised is Celsius, never a third state
    L.setTempUnit('kelvin');
    assert.equal(L.getTempUnit(), 'c');
  } finally {
    L.setTempUnit('c');
  }
});

test('TP-19: the weather sentence follows the same unit', () => {
  try {
    L.setTempUnit('f');
    assert.match(L.weatherLine('Rome', { lo: 18, hi: 28, wet: false }), /64-82°F/);
  } finally {
    L.setTempUnit('c');
  }
});

// ---------------------------------------------------------------------------
// TP-20  airport search relevance
// ---------------------------------------------------------------------------
const AIRPORTS = L.airportIndex(JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'airports.json'), 'utf8')));
const search = (q, limit = 8) => L.searchAirports(q, AIRPORTS, limit);
const codes = (q, limit = 8) => search(q, limit).map(a => a.iata);

test('TP-20: a short query no longer matches the inside of a word', () => {
  // "rome" was padded out to eight rows with Split (Saint Je-rome), Dover
  // (Aird-rome) and Gustavia (Aé-rod-rome) - matches with nothing on the row to
  // explain them.
  const got = codes('rome');
  assert.deepEqual(got.slice(0, 2), ['FCO', 'CIA'], 'the real answers must still lead');
  for (const bad of ['SPU', 'DOV', 'SBH']) {
    assert.ok(!got.includes(bad), `${bad} matched "rome" inside a word`);
  }
  // what survives is word-anchored and visible in the row text (Romeu, Romero)
  assert.ok(got.length <= 5);
});

test('TP-20: word-anchored weak matches are kept', () => {
  // The tier this fix had to preserve: "orly" only ever reaches ORY through the
  // airport NAME, which is exactly the weak tier being tightened.
  assert.deepEqual(codes('orly'), ['ORY']);
  // an alias word still reaches a hub filed under another city
  assert.ok(codes('new york').includes('EWR'));
  // Paris-Vatry is reachable through its alias, and must not be swept up
  assert.ok(codes('paris').includes('XCR'));
});

test('TP-20: a long query may still match inside a word', () => {
  // Interior substrings are only a coincidence when they are short; at five
  // characters and up they are usually deliberate.
  assert.deepEqual(codes('eathrow'), ['LHR']);
  assert.deepEqual(codes('heathrow'), ['LHR']);
  assert.deepEqual(codes('fiumicino'), ['FCO']);
});

test('TP-20: exact codes and cities are unaffected', () => {
  assert.equal(codes('lax')[0], 'LAX');
  assert.equal(codes('jfk')[0], 'JFK');
  assert.equal(codes('split')[0], 'SPU');
  assert.equal(codes('tokyo')[0], 'HND');
  assert.ok(codes('san').length > 1, 'a genuine city prefix still lists its namesakes');
});

test('TP-20: the result list stays capped', () => {
  assert.ok(search('a', 8).length <= 8);
  assert.ok(search('san', 5).length <= 5);
});
