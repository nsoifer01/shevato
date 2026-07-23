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

test('validateItem accepts a `local` item exactly like any other non-stay', () => {
  const it = { type: 'local', title: 'Metro to Shibuya', startDate: '2027-01-02' };
  assert.deepEqual(L.validateItem(it), {});
  // and it is validated as a non-stay: no check-out date is demanded
  assert.deepEqual(L.validateItem({ ...it, endDate: '2027-01-02' }), {});
  assert.ok(L.validateItem({ ...it, endDate: '2027-01-01' }).end);
});

test('validateItem accepts a negative cost as a refund, and still rejects a non-number', () => {
  // The contract REVERSED here: a negative amount is a refund or a credit (a
  // cancelled hotel that was refunded, a share of a bill paid back), so it is
  // real data. The only thing left that a total cannot be built from is a value
  // that is not a finite number.
  const base = flight('f', 'A to B', '2027-01-01');
  assert.deepEqual(L.validateItem({ ...base, cost: -5 }), {});
  assert.deepEqual(L.validateItem({ ...base, cost: -0.01 }), {});
  assert.deepEqual(L.validateItem({ ...base, cost: null }), {});
  assert.deepEqual(L.validateItem({ ...base, cost: 0 }), {});
  assert.ok(L.validateItem({ ...base, cost: 'free' }).cost);
  assert.ok(L.validateItem({ ...base, cost: Infinity }).cost);
});

test('isDateInRange is the one bound the form and the date pickers share', () => {
  assert.equal(L.DATE_MIN, '2000-01-01');
  assert.equal(L.DATE_MAX, '2100-12-31');
  assert.equal(L.isDateInRange('2027-05-01'), true);
  // the boundaries themselves are inside
  assert.equal(L.isDateInRange(L.DATE_MIN), true);
  assert.equal(L.isDateInRange(L.DATE_MAX), true);
  // the mistyped year the form used to accept: #itemForm is novalidate, so the
  // inputs' min/max only ever constrained the picker's spinner
  assert.equal(L.isDateInRange('9999-01-01'), false);
  assert.equal(L.isDateInRange('1999-12-31'), false);
  assert.equal(L.isDateInRange('0202-05-01'), false);
  // and it is a range check ON TOP of the format check, not instead of it
  assert.equal(L.isDateInRange(''), false);
  assert.equal(L.isDateInRange('2027-13-40'), false);
  assert.equal(L.isDateInRange(null), false);
});

test('validateItem still accepts an out-of-range date, so import keeps its own error path', () => {
  // The range check belongs to the FORM. An item that arrives by import or by
  // share link must keep flowing to the computeIssues error that names it and
  // explains the 400-day render cap, which is what the cap depends on.
  assert.deepEqual(L.validateItem({ type: 'note', title: 'Typo', startDate: '9999-01-01' }), {});
  assert.equal(L.tripStats({ items: [
    { id: 'a', type: 'note', title: 'Now', startDate: '2027-05-01', status: 'to-book' },
    { id: 'b', type: 'note', title: 'Typo', startDate: '9999-01-01', status: 'to-book' },
  ] }).spanCapped, true);
});

// ---------- visa: a geocode may not state a legal requirement unless it is sure ----------

test('visaCountryUsable admits ONLY a confident match', () => {
  assert.equal(L.visaCountryUsable('confident'), true);
  // every one of these produced a real wrong-country row on a sample trip
  assert.equal(L.visaCountryUsable('ambiguous'), false); // Maras -> Turkmenistan
  assert.equal(L.visaCountryUsable('low'), false);       // Nara  -> United States
  assert.equal(L.visaCountryUsable('failed'), false);
  // a cache entry written before `conf` existed is NO evidence, not weak
  // evidence, so it must not be treated as good enough either
  assert.equal(L.visaCountryUsable(undefined), false);
  assert.equal(L.visaCountryUsable(''), false);
});

test('the four wrong-country sample places are classified as unusable, except the one that cannot be', () => {
  // Candidate rows captured VERBATIM from Nominatim on 2026-07-20 for the
  // queries the sample trips actually send, so this fails if classifyGeoMatch
  // ever stops catching them, not merely if someone edits visaCountryUsable.

  // "Nara" (Japan trip) -> the US NATIONAL ARCHIVES, an office in Washington
  // DC. The dialog was telling a Korean passport holder they needed a US eTA.
  // Rejected at the first gate: an `office` is not a settlement.
  const nara = L.classifyGeoMatch('Nara', [
    { name: 'US National Archives', cc: 'US', country: 'United States', state: 'District of Columbia', importance: 0.7161225186214478, kind: 'office' },
    { name: 'Nara', cc: 'JP', country: 'Japan', state: 'Nara Prefecture', importance: 0.6062730387027173, kind: 'city' },
    { name: 'Nara', cc: 'RU', country: 'Russia', state: 'Kaluga Oblast', importance: 0.43753274145943666, kind: 'river' },
  ]);
  assert.equal(nara, 'low');
  assert.equal(L.visaCountryUsable(nara), false);

  // "Maras" (Peru trip) -> "Mary City", Turkmenistan: a FUZZY name match, and
  // a real settlement, so only the contested-rival rule catches it.
  const maras = L.classifyGeoMatch('Maras', [
    { name: 'Mary City', cc: 'TM', country: 'Turkmenistan', state: 'Mary Region', importance: 0.5112913645959383, kind: 'city' },
    { name: 'Maras', cc: 'PE', country: 'Peru', state: 'Cusco', importance: 0.3644234137366019, kind: 'city' },
    { name: 'Kahramanmaras', cc: 'TR', country: 'Turkey', state: 'Kahramanmaras', importance: 0.5672554167977486, kind: 'province' },
  ]);
  assert.equal(maras, 'ambiguous');
  assert.equal(L.visaCountryUsable(maras), false);

  // "Ha Long" (Vietnam trip) -> a village in LESOTHO, outranking the real one.
  const haLong = L.classifyGeoMatch('Ha Long', [
    { name: 'Ha Long', cc: 'LS', country: 'Lesotho', state: 'Thaba-Tseka District', importance: 0.14670416800183103, kind: 'village' },
    { name: 'Ha Long Ward', cc: 'VN', country: 'Vietnam', state: 'Quang Ninh Province', importance: 0.24158668584662718, kind: 'city' },
    { name: 'Phuong Ha Long', cc: 'VN', country: 'Vietnam', state: 'Quang Ninh Province', importance: 0.24005052491035322, kind: 'suburb' },
  ]);
  assert.equal(haLong, 'ambiguous');
  assert.equal(L.visaCountryUsable(haLong), false);

  // KNOWN RESIDUAL: "Lang Co" (Vietnam trip) -> "Nang County", China. ONE
  // candidate came back, it is a real settlement with ordinary importance, and
  // nothing about it looks wrong, so no confidence score can catch it. Asserted
  // so the limitation is a recorded fact rather than a surprise; the row prints
  // "Lang Co" beneath the country, which keeps it traceable to the stop that
  // produced it.
  const langCo = L.classifyGeoMatch('Lang Co', [
    { name: 'Nang County', cc: 'CN', country: 'China', state: 'Xizang', importance: 0.43510533837124926, kind: 'county' },
  ]);
  assert.equal(langCo, 'confident');
});

test('no sample trip ships a place whose bare name resolves to the wrong country', () => {
  // "Lang Co" alone is "Nang County", China (see above), and it is the one case
  // confidence scoring cannot catch, so the SAMPLE carries the qualifier that
  // the dialog tells travellers to add. If this location ever loses its comma,
  // the Vietnam example starts claiming a Chinese visa requirement again.
  const vietnam = L.buildSampleTrip('vietnam', { today: '2026-09-04' });
  const langCo = vietnam.items.find(it => /An Cu seafood/.test(it.title));
  assert.equal(langCo.location, 'Lang Co, Vietnam');
  assert.equal(L.geoInputIsQualified(langCo.location, { name: 'Nang County', cc: 'CN', country: 'China' }), true);
});

test('a traveller who disambiguated the place themselves is trusted', () => {
  // the documented way out of a suppressed row: "Nara, Japan" is qualified, so
  // it is confident and DOES name a country
  const qualified = L.classifyGeoMatch('Nara, Japan', [
    { name: 'Nara', cc: 'JP', country: 'Japan', state: 'Nara Prefecture', importance: 0.6062730387027173, kind: 'city' },
    { name: 'Nara', cc: 'RU', country: 'Russia', state: 'Kaluga Oblast', importance: 0.43753274145943666, kind: 'river' },
  ]);
  assert.equal(L.visaCountryUsable(qualified), true);
});

// ---------- assistant: a heavy trip is trimmed, not rejected ----------

function heavyContext(n, detailChars) {
  return { trip: { name: 'Heavy', currency: 'USD', items: Array.from({ length: n }, (_, i) => ({
    id: 'i' + i, type: 'activity', title: 'Item ' + i, location: 'Tokyo',
    startDate: '2027-05-01', startTime: '10:00', status: 'to-book',
    cost: 40, costCurrency: 'USD', details: 'd'.repeat(detailChars),
  })) }, focusDate: null, today: '2027-04-01' };
}

test('a context that already fits is passed through untouched and unflagged', () => {
  const ctx = heavyContext(5, 50);
  const fit = L.fitAssistContext(ctx, 30000);
  assert.equal(fit.ok, true);
  assert.equal(fit.truncated, false);
  // identity, not merely equality: nothing was rebuilt
  assert.equal(fit.ctx, ctx);
});

test('an oversize context loses long DESCRIPTIONS and keeps every structural fact', () => {
  // MEASURED: `details` is capped at 500 chars an item, so the real cliff is
  // 45 items (30,490 chars) rather than the ~40 originally reported. 50 items
  // is comfortably past it. For scale, the largest sample trip (Japan, 44
  // items) is 10,577 chars, about a third of the cap.
  const ctx = heavyContext(50, 500);
  assert.ok(JSON.stringify(ctx).length > 30000, 'fixture must actually be oversize');
  const fit = L.fitAssistContext(ctx, 30000);
  assert.equal(fit.ok, true);
  assert.equal(fit.truncated, true);
  assert.ok(JSON.stringify(fit.ctx).length <= 30000);
  // NOT ONE ITEM LOST: a trip missing items is one the assistant answers wrongly
  assert.equal(fit.ctx.trip.items.length, 50);
  for (let i = 0; i < 50; i++) {
    const it = fit.ctx.trip.items[i];
    assert.equal(it.title, 'Item ' + i);
    assert.equal(it.startDate, '2027-05-01');
    assert.equal(it.startTime, '10:00');
    assert.equal(it.type, 'activity');
    assert.equal(it.location, 'Tokyo');
    assert.equal(it.status, 'to-book');
    assert.equal(it.cost, 40);
    assert.equal(it.costCurrency, 'USD');
  }
  // and the caller's object was not mutated
  assert.equal(ctx.trip.items[0].details.length, 500);
});

test('descriptions are shortened before they are dropped', () => {
  const fit = L.fitAssistContext(heavyContext(50, 500), 30000);
  const kept = fit.ctx.trip.items[0].details;
  assert.equal(kept.length, L.ASSIST_DETAILS_BUDGET);
});

test('when shortening is not enough, descriptions go entirely and the trip still fits', () => {
  // enough items that even 120 chars each blows the cap
  const ctx = heavyContext(400, 500);
  const fit = L.fitAssistContext(ctx, 90000);
  assert.equal(fit.ok, true);
  assert.equal(fit.truncated, true);
  assert.equal(fit.ctx.trip.items.length, 400);
  assert.equal('details' in fit.ctx.trip.items[0], false);
  assert.ok(JSON.stringify(fit.ctx).length <= 90000);
});

test('a trip too big even without descriptions fails LOUDLY, not as a bad request', () => {
  // structural facts alone over the cap: the caller must report this in its own
  // words, because retrying can never succeed
  const fit = L.fitAssistContext(heavyContext(400, 500), 5000);
  assert.equal(fit.ok, false);
  assert.equal(fit.truncated, true);
});

test('the two oversize failures are told apart, because they need different answers', () => {
  // no trip in it at all: a malformed body, answered as bad_request
  const junk = L.fitAssistContext({ trip: { name: 'x'.repeat(40000), items: [] } }, 30000);
  assert.equal(junk.ok, false);
  assert.equal(junk.reason, 'untrimmable');
  // a real trip whose structural facts alone bust the cap: its own answer, so
  // the UI can say what happened instead of showing a generic failure
  const huge = L.fitAssistContext(heavyContext(400, 500), 5000);
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, 'still_too_big');
});

test('a truncated context makes the system prompt WARN the model, and an intact one does not', () => {
  const trip = { name: 'T', currency: 'USD', items: [{ id: 'a', type: 'activity', title: 'X', startDate: '2027-05-01', status: 'to-book' }] };
  const intact = L.buildAssistSystemPrompt({ trip, focusDate: '', today: '2027-04-01' });
  const cut = L.buildAssistSystemPrompt({ trip, focusDate: '', today: '2027-04-01', truncated: true });
  assert.equal(intact.includes(L.ASSIST_TRUNCATED_NOTE), false);
  assert.ok(cut.includes(L.ASSIST_TRUNCATED_NOTE));
  // the caveat must sit immediately BEFORE the JSON it qualifies: several
  // paragraphs earlier is a caveat the model drops
  assert.ok(cut.indexOf(L.ASSIST_TRUNCATED_NOTE) < cut.indexOf('Here is the current trip as JSON:'));
  // and it must forbid the specific failure: claiming the trip has no notes
  assert.match(L.ASSIST_TRUNCATED_NOTE, /never say or imply that an item has no notes/i);
});

test('visaVintageNote states the DATA vintage and how stale it is', () => {
  // the old disclaimer said "refreshed monthly", which described our browser
  // cache TTL, not the dataset: travellers read 18-month-old entry rules as
  // current. The date the data is FROM has to be on screen, with its age.
  assert.equal(L.visaVintageNote('2026-02-17', '2026-07-20'), 'Rules as published on February 17, 2026, about 5 months ago.');
  assert.equal(L.visaVintageNote('2026-02-17', '2026-03-01'), 'Rules as published on February 17, 2026.');
  assert.equal(L.visaVintageNote('2026-02-17', ''), 'Rules as published on February 17, 2026.');
  assert.equal(L.visaVintageNote('2026-02-17', '2027-02-17'), 'Rules as published on February 17, 2026, about 12 months ago.');
  assert.equal(L.visaVintageNote('', '2026-07-20'), '');
  assert.equal(L.visaVintageNote('nonsense', '2026-07-20'), '');
});

test('the assistant is forbidden from stating entry requirements', () => {
  // One constant feeds all three tiers, including the copy/paste package handed
  // to an external AI, so this is the only place the rule can live.
  const prompt = L.buildAssistSystemPrompt({ trip: null, focusDate: '', today: '2027-04-01' });
  for (const topic of ['visa', 'passport validity', 'vaccination', 'driving permit', 'customs']) {
    assert.match(prompt.toLowerCase(), new RegExp(topic.split(' ')[0]), `prompt must constrain: ${topic}`);
  }
  assert.match(prompt, /NEVER state entry requirements as fact/);
  // and it must send them somewhere real rather than just hedging
  assert.match(prompt, /official immigration site|embassy/i);
  // the copy/paste package carries the same rule, or tier 1 is unconstrained
  assert.match(L.buildAssistPackage({ trip: { name: 'T', currency: 'USD', items: [] }, focusDate: '', request: 'hi' }), /NEVER state entry requirements as fact/);
});

test('pickMonthSamples takes one month across every year in the range', () => {
  // "typically 23-30C" was built from ONE year, so a single freak August was
  // the whole claim. The window now spans several years of that month.
  const times = ['2022-09-01', '2022-10-01', '2023-09-01', '2023-09-02', '2024-01-01', '2024-09-01'];
  const mins = [1, 99, 2, 3, 99, 4];
  const maxs = [11, 99, 12, 13, 99, 14];
  const [lo, hi] = L.pickMonthSamples(times, '09', [mins, maxs]);
  assert.deepEqual(lo, [1, 2, 3, 4], 'only September, but every September');
  assert.deepEqual(hi, [11, 12, 13, 14]);
  // a missing series must not desynchronise the others
  assert.deepEqual(L.pickMonthSamples(times, '09', [mins, undefined])[1], []);
  assert.deepEqual(L.pickMonthSamples([], '09', [mins]), [[]]);
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

// A `local` item is getting around inside one city. It is never a bed, so it
// must never quiet a "no stay covers this night" warning: a taxi to dinner that
// happens to run past midnight would otherwise hide a real uncovered night.
test('overnightTransit keeps `local` out of the nights-in-transit set', () => {
  const items = [
    flight('f', 'red-eye', '2027-01-02', '2027-01-03'),
    { id: 'l', type: 'local', title: 'Return to hotel', startDate: '2027-01-04', endDate: '2027-01-05', status: 'booked' },
    { id: 't', type: 'transport', title: 'Tokyo to Kyoto', startDate: '2027-01-06', endDate: '2027-01-07', status: 'booked' },
  ];
  assert.deepEqual(L.overnightTransit(items).map(it => it.id), ['f', 't']);
  assert.equal(L.isTransitSpan(items[1]), false);
  assert.equal(L.isTransitSpan(items[2]), true);
});

test('a `local` hop across midnight does NOT cover the night, a transport leg does', () => {
  const stays = [stay('a', 'Tokyo', '2026-12-30', '2027-01-02'), stay('b', 'Kyoto', '2027-01-03', '2027-01-05')];
  const localHop = { id: 'l', type: 'local', title: 'Taxi to the night market', startDate: '2027-01-02', endDate: '2027-01-03', status: 'booked' };
  const sleeper = { id: 't', type: 'transport', title: 'Tokyo to Kyoto sleeper', startDate: '2027-01-02', endDate: '2027-01-03', status: 'booked' };
  assert.deepEqual(
    L.coverageGaps(stays, null, L.overnightTransit([localHop])),
    [{ start: '2027-01-02', end: '2027-01-03', nights: 1 }],
  );
  assert.deepEqual(L.coverageGaps(stays, null, L.overnightTransit([sleeper])), []);
});

test('tripStats never counts a `local` span as a booked night', () => {
  const trip = { items: [
    stay('s', 'Tokyo', '2026-12-30', '2027-01-02'),
    { id: 'l', type: 'local', title: 'Late taxi back', startDate: '2027-01-02', endDate: '2027-01-03', status: 'booked' },
  ] };
  assert.equal(L.tripStats(trip).bookedNights, 3);
});

// Stored trips predate `local`: every travel item in them says "transport" and
// nothing migrates them. A trip saved before this change must render, validate
// and warn exactly as it did.
test('old stored data typed `transport` behaves exactly as before', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2027-01-01', '2027-01-05'),
    { id: 'x', type: 'transport', title: 'Tokyo to Kyoto sleeper', location: '', startDate: '2027-01-05', endDate: '2027-01-06', status: 'booked' },
    stay('k', 'Kyoto', '2027-01-06', '2027-01-08'),
  ] };
  assert.deepEqual(L.validateItem(trip.items[1]), {});
  assert.equal(L.transportGaps(trip).length, 0);          // the leg still explains the city change
  assert.deepEqual(L.coverageGaps(
    trip.items.filter(L.isStay), null, L.overnightTransit(trip.items),
  ), []);                                                  // the sleeper still covers Jan 5
  assert.equal(L.tripStats(trip).bookedNights, 7);         // 4 + 1 on the train + 2
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'transport', title: 'Bus', startDate: '2027-01-05' } }, trip).ok, true);
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

// ---------- money: when a cost is worth showing ----------
// The owner reported a suggestion card reading "$0.00" under the title. A zero
// is a real recorded value, it just says nothing as a badge.

test('showsCostBadge hides zero, because "$0.00" is noise, not a price', () => {
  assert.equal(L.showsCostBadge(0), false);
  assert.equal(L.showsCostBadge('0'), false);
  assert.equal(L.showsCostBadge(-0), false);
});

test('showsCostBadge hides a cost that was never recorded', () => {
  assert.equal(L.showsCostBadge(null), false);
  assert.equal(L.showsCostBadge(undefined), false);
  assert.equal(L.showsCostBadge(''), false);
  // a junk value cannot be formatted, so it cannot be shown either
  assert.equal(L.showsCostBadge('free'), false);
  assert.equal(L.showsCostBadge(NaN), false);
});

test('showsCostBadge shows any real amount, including a refund', () => {
  assert.equal(L.showsCostBadge(0.01), true);
  assert.equal(L.showsCostBadge(30000), true);
  assert.equal(L.showsCostBadge('120.5'), true);
  // negative is not reachable through the form (validateItem rejects it) but a
  // credit carried in from an import is information, so it renders
  assert.equal(L.showsCostBadge(-45), true);
});

test('hiding the zero badge is display-only: the totals still count it', () => {
  const trip = { items: [
    stay('a', 'Tokyo', '2027-01-01', '2027-01-03', 'booked', 0),
    stay('b', 'Kyoto', '2027-01-03', '2027-01-05', 'booked', 100),
  ] };
  const s = L.tripStats(trip);
  assert.equal(s.confirmed, 100);
  assert.equal(s.planned, 100);
  // and a zero-cost item is still a costed item as far as the sums are concerned
  assert.equal(L.showsCostBadge(trip.items[0].cost), false);
  assert.equal(trip.items[0].cost, 0, 'a stored 0 must never be coerced to null');
});

// ---------- money: "~" marks a price the assistant estimated ----------

test('mealTitlePrefixes are read out of the contract, not restated', () => {
  // If ASSIST_KINDS ever changes its prefixes, the renderer follows automatically
  // instead of silently disagreeing with the instruction the model was given.
  assert.deepEqual(L.mealTitlePrefixes(), ['Breakfast: ', 'Lunch: ', 'Dinner: ', 'Drinks: ']);
  const sys = L.buildAssistSystemPrompt({ trip: tripWith([]), focusDate: '', today: '' });
  for (const p of L.mealTitlePrefixes()) assert.ok(sys.includes(`"${p}"`), `prefix ${p} missing from the prompt`);
});

test('isFoodOrDrink keys off the mandated title prefix, not the item type', () => {
  // meals and drinks ride on type "activity"; only the prefix separates them
  assert.equal(L.isFoodOrDrink('Dinner: Narisawa'), true);
  assert.equal(L.isFoodOrDrink('Breakfast: Bricolage'), true);
  assert.equal(L.isFoodOrDrink('Lunch: Ichiran'), true);
  assert.equal(L.isFoodOrDrink('Drinks: Bar Trench'), true);
  assert.equal(L.isFoodOrDrink('Hie Shrine'), false);
  assert.equal(L.isFoodOrDrink('Return to hotel'), false);
  // "dinner" as a word is not the prefix; the colon and position are the contract
  assert.equal(L.isFoodOrDrink('Sunset dinner cruise'), false);
  assert.equal(L.isFoodOrDrink(''), false);
  assert.equal(L.isFoodOrDrink(null), false);
});

test('an estimate is a fact about the data, not a guess from the title', () => {
  // the source decides: a number the assistant supplied lives in estCost and is
  // always a guess, whatever the item type or status
  assert.equal(L.isEstimatedCost({ title: 'Dinner: Narisawa', status: 'to-book', estCost: 45 }), true);
  assert.equal(L.isEstimatedCost({ title: 'Dinner: Narisawa', status: 'booked', estCost: 45 }), true);
  assert.equal(L.isEstimatedCost({ title: 'teamLab Planets', status: 'to-book', estCost: 38 }), true);
  assert.equal(L.isEstimatedCost({ title: 'Park Hyatt', type: 'stay', status: 'to-book', estCost: 600 }), true);
  // a number the traveller typed is never an estimate, whatever the title says
  assert.equal(L.isEstimatedCost({ title: 'Dinner: Narisawa', status: 'to-book', cost: 45 }), false);
  assert.equal(L.isEstimatedCost({ title: 'teamLab Planets', status: 'to-book', cost: 38 }), false);
  // a typed price wins over a leftover guess: there is only ever one number shown
  assert.equal(L.isEstimatedCost({ title: 'Dinner: Narisawa', cost: 60, estCost: 45 }), false);
  assert.equal(L.isEstimatedCost(null), false);
  assert.equal(L.isEstimatedCost({ title: 'Note' }), false);
});

test('the tilde is presentation only and never touches the stored number', () => {
  const item = { title: 'Dinner: Narisawa', status: 'to-book', estCost: 45 };
  L.isEstimatedCost(item);
  assert.equal(item.estCost, 45);
  assert.equal(item.cost, undefined);
  // and a zero amount renders nothing at all, so "~$0.00" is unreachable
  assert.equal(L.showsCostBadge(0), false);
  assert.equal(L.displayCostOf({ title: 'Dinner: free tasting', estCost: 0 }), null);
});

test('a typed 0 is a decision, so it never falls through to the guess', () => {
  // "free museum" must not silently start showing the assistant's old number
  assert.equal(L.displayCostOf({ title: 'teamLab Planets', cost: 0, estCost: 38 }), null);
  assert.deepEqual(L.displayCostOf({ title: 'teamLab Planets', cost: 38, costCurrency: 'JPY', estCost: 50 }),
    { amount: 38, currency: 'JPY', est: false });
  assert.deepEqual(L.displayCostOf({ title: 'Dinner: Narisawa', estCost: 45, estCostCurrency: 'JPY' }),
    { amount: 45, currency: 'JPY', est: true });
});

test('an estimate is shown but never summed, and a typed cost always is', () => {
  const trip = { items: [
    // the assistant's guesses: displayed, counted nowhere
    { id: 'd', type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01', status: 'to-book', estCost: 45 },
    { id: 'm', type: 'activity', title: 'teamLab Planets', startDate: '2027-01-01', status: 'booked', estCost: 38 },
    // numbers the traveller typed: counted, whatever the item type
    { id: 'l', type: 'activity', title: 'Lunch: Ichiran', startDate: '2027-01-01', status: 'booked', cost: 12 },
    { id: 'h', type: 'stay', title: 'Park Hyatt', startDate: '2027-01-01', endDate: '2027-01-03', status: 'to-book', cost: 600 },
  ] };
  const s = L.tripStats(trip);
  assert.equal(s.planned, 612);
  assert.equal(s.confirmed, 12);
  // the guessed amounts appear in no total at all
  assert.ok(![s.planned, s.confirmed].some(v => String(v).includes('45') || String(v).includes('38')));
});

test('sumInCurrency ignores estimates on every path, converted or not', () => {
  const ratesObj = { base: 'USD', rates: { JPY: 150 } };
  const items = [
    { id: 'a', cost: 100, costCurrency: 'USD' },
    { id: 'b', estCost: 3000, estCostCurrency: 'JPY' },
    { id: 'c', estCost: 40, estCostCurrency: 'USD' },
  ];
  const { total, unconverted } = L.sumInCurrency(items, 'USD', ratesObj);
  assert.equal(total, 100);
  // an estimate is not "an amount we failed to convert", it is not money at all
  assert.deepEqual(unconverted, []);
});

test('the budget comparison is built from typed costs only', () => {
  const trip = { budget: 500, items: [
    { id: 'a', type: 'stay', title: 'Hotel', startDate: '2027-01-01', endDate: '2027-01-02', status: 'booked', cost: 400 },
    { id: 'b', type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01', status: 'to-book', estCost: 200 },
  ] };
  const s = L.tripStats(trip);
  // 400 + a 200 guess must not read as over budget
  assert.equal(s.confirmed, 400);
  assert.ok(s.confirmed <= trip.budget);
});

test('adopting an estimate is what moves the totals, by exactly its amount', () => {
  const before = { items: [{ id: 'd', type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01', status: 'booked', estCost: 45 }] };
  assert.equal(L.tripStats(before).planned, 0);
  // adoption: the number becomes the traveller's own and the guess is gone
  const after = { items: [{ id: 'd', type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01', status: 'booked', cost: 45, costCurrency: 'USD' }] };
  assert.equal(L.tripStats(after).planned, 45);
  assert.equal(L.tripStats(after).confirmed, 45);
  assert.equal(L.isEstimatedCost(after.items[0]), false);
});

// ---------- money: "~" marks a price the assistant guessed ----------
// The owner asked for a tilde on food and drink prices. Meals are not their own
// item type: they are `activity` items carrying the title prefix the assistant
// contract mandates, so detection reads that contract rather than restating it.

test('the meal prefixes come from the prompt text, not a second copy of the list', () => {
  const prefixes = L.mealTitlePrefixes();
  assert.deepEqual(prefixes, ['Breakfast: ', 'Lunch: ', 'Dinner: ', 'Drinks: ']);
  // the point of deriving them: the prompt the model actually receives contains
  // every prefix we match on, so the two cannot drift apart
  const prompt = L.buildAssistSystemPrompt({ trip: { items: [] } });
  for (const p of prefixes) assert.ok(prompt.includes(`"${p}"`), `prompt is missing ${p}`);
});

test('a suggested meal or drink is an estimate', () => {
  for (const title of ['Dinner: Narisawa', 'Breakfast: Bills', 'Lunch: Tsuta', 'Drinks: Bar High Five']) {
    assert.equal(L.isEstimatedCost({ type: 'activity', title, status: 'to-book', estCost: 45 }), true, title);
  }
});

test('the meal prefixes still drive icons and colours, never the money', () => {
  // the title prefix keeps deciding which meal an item is (icon + accent), and
  // no longer decides anything about the price
  assert.equal(L.mealKind('Dinner: Narisawa'), 'dinner');
  assert.equal(L.isFoodOrDrink('Dinner: Narisawa'), true);
  assert.equal(L.isEstimatedCost({ type: 'activity', title: 'Dinner: Narisawa', status: 'to-book', cost: 45 }), false);
  // the colon is required, so a word that merely starts the same way is not a meal
  assert.equal(L.isFoodOrDrink('Dinnerware shopping in Kappabashi'), false);
  assert.equal(L.isFoodOrDrink(''), false);
  assert.equal(L.isFoodOrDrink(null), false);
});

test('prefix matching tolerates case, leading space and a missing space after the colon', () => {
  assert.equal(L.isFoodOrDrink('dinner: narisawa'), true);
  assert.equal(L.isFoodOrDrink('DINNER: NARISAWA'), true);
  assert.equal(L.isFoodOrDrink('  Dinner: Narisawa'), true);
  assert.equal(L.isFoodOrDrink('Dinner:Narisawa'), true);
  assert.equal(L.isFoodOrDrink('Drinks:  Bar High Five'), true);
});

test('an estimate drops its cents, a real price keeps them', () => {
  // the traveller's own booking is what the trip totals are built from, so it
  // has to stay exact to the cent
  const booked = { type: 'stay', title: 'Park Hyatt', status: 'booked', cost: 1587.34 };
  assert.deepEqual(L.costDisplayParts(booked), { est: false, tilde: '', digits: 2 });
  // a suggested dinner is a guess, so cents are noise
  const guess = { type: 'activity', title: 'Dinner: Narisawa', status: 'to-book', estCost: 44.6 };
  assert.deepEqual(L.costDisplayParts(guess), { est: true, tilde: '~', digits: 0 });
  // adopting that guess turns it into a real price
  assert.deepEqual(L.costDisplayParts({ type: 'activity', title: 'Dinner: Narisawa', cost: 44.6 }), { est: false, tilde: '', digits: 2 });
  // a meal a traveller entered as $1,587.34 must not become $1,587
  assert.equal(L.costDisplayParts({ ...booked, title: 'Dinner: Narisawa' }).digits, 2);
});

test('estimate rounding goes up, not down: $44.60 reads as ~$45', () => {
  // costDisplayParts hands Intl the digit count; Intl rounds half-up, which is
  // the whole point of using it rather than a truncating format
  const digits = L.costDisplayParts({ title: 'Dinner: Narisawa', status: 'to-book', estCost: 44.6 }).digits;
  const fmt = n => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(n);
  assert.equal(fmt(44.6), '$45');
  assert.equal(fmt(44.4), '$44');
  assert.equal(fmt(45), '$45');
});

test('a zero cost shows nothing at all, so "~$0.00" can never appear', () => {
  const item = { type: 'activity', title: 'Dinner: comped by the hotel', status: 'to-book', cost: 0 };
  // the tilde only ever decorates a badge that showsCostBadge already allowed
  assert.equal(L.showsCostBadge(item.cost), false);
});

test('the tilde is presentation only: stored costs and totals are untouched', () => {
  const trip = { items: [
    { id: 'a', type: 'activity', title: 'Dinner: Narisawa', status: 'to-book', startDate: '2027-01-02', cost: 45 },
    { id: 'b', type: 'activity', title: 'Dinner: Sukiyabashi', status: 'booked', startDate: '2027-01-03', cost: 55 },
  ] };
  const s = L.tripStats(trip);
  assert.equal(s.planned, 100, 'an estimated price still counts in full');
  assert.equal(s.confirmed, 55);
  assert.equal(trip.items[0].cost, 45, 'the stored number never gains a "~"');
  assert.equal(typeof trip.items[0].cost, 'number');
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
  assert.ok(modes.some(m => m.key === 'air'));
  assert.ok(!modes.some(m => m.key === 'walk'));
});

test('modeOptions: island legs get a ferry and no train', () => {
  const modes = L.modeOptions(45, true);
  assert.ok(modes.some(m => m.key === 'ferry'));
  assert.ok(!modes.some(m => m.key === 'rail'));
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

// ---------- route cost, emissions, badges ----------
// The whole point of these: every figure the route modal shows has to be
// COMPUTED from the distance, so that no stale remembered fare can ever be
// quoted at a traveller as a price.

test('modeCost grows with distance for every priced mode', () => {
  for (const key of ['rail', 'bus', 'drive', 'air']) {
    const near = L.modeCost(key, 300), far = L.modeCost(key, 800);
    assert.ok(near.lo < far.lo, `${key} lo should grow with distance`);
    assert.ok(near.hi < far.hi, `${key} hi should grow with distance`);
    assert.ok(near.lo < near.hi, `${key} must be a range, not a point`);
  }
});

test('modeCost keeps modes in the order a traveller expects', () => {
  const mid = c => (c.lo + c.hi) / 2;
  const km = 600;
  assert.ok(mid(L.modeCost('bus', km)) < mid(L.modeCost('rail', km)));
  assert.ok(mid(L.modeCost('rail', km)) < mid(L.modeCost('air', km)));
  // fast rail costs more than the slow train on the same line
  assert.ok(mid(L.modeCost('rail', km, true)) > mid(L.modeCost('rail', km, false)));
});

test('modeCost is per car for driving and per person elsewhere', () => {
  assert.equal(L.modeCost('drive', 400).per, 'car');
  assert.equal(L.modeCost('rail', 400).per, 'person');
  assert.equal(L.modeCost('air', 400).per, 'person');
});

test('modeCost stays absent where the distance says nothing about the fare', () => {
  // a ferry on a 600 km route is only the last leg, so the route distance
  // cannot price it: absent beats invented
  assert.equal(L.modeCost('ferry', 600), null);
  assert.ok(L.modeCost('ferry', 40));
  // a walk and a metro ride have no comparable fare at all
  assert.equal(L.modeCost('walk', 3), null);
  assert.equal(L.modeCost('local', 20), null);
  assert.equal(L.modeCost('rail', 0), null);
});

test('modeCo2 puts flying above driving above rail at the same distance', () => {
  // 600 km: the only band where all three modes are actually offered
  const km = 600;
  assert.ok(L.modeCo2('air', km).kg > L.modeCo2('drive', km).kg);
  assert.ok(L.modeCo2('drive', km).kg > L.modeCo2('rail', km).kg);
  assert.ok(L.modeCo2('rail', km).kg > L.modeCo2('bus', km).kg);
  // and the ordering holds across the whole band where driving is offered
  for (const d of [250, 400, 899]) {
    assert.ok(L.modeCo2('air', d).kg > L.modeCo2('drive', d).kg, `flight should exceed drive at ${d} km`);
  }
});

test('modeCo2 labels the car figure as per car, since it is not per seat', () => {
  assert.equal(L.modeCo2('drive', 400).per, 'car');
  assert.equal(L.modeCo2('air', 400).per, 'person');
  assert.equal(L.modeCo2('walk', 3), null);
});

test('routeBadges derives every badge from the computed numbers', () => {
  const opts = L.modeOptions(370, false, true);
  const badges = L.routeBadges(opts, { island: false });
  const ids = key => (badges[key] || []).map(b => b.id);
  // high-speed rail beats the plane once airport time is back in
  assert.deepEqual(ids('rail'), ['recommended', 'fastest']);
  assert.ok(ids('bus').includes('cheapest'));
  assert.ok(ids('bus').includes('greenest'));
  // a mode with no comparable fare competes for nothing
  const short = L.modeOptions(5, false, false);
  assert.deepEqual(L.routeBadges(short, {}), {});
});

test('routeBadges caps a card at two badges and awards each badge once', () => {
  const opts = L.modeOptions(9000, false, false);
  const badges = L.routeBadges(opts, {});
  // one option sweeps all four, and the card still shows only the top two
  assert.deepEqual(badges.air.map(b => b.id), ['recommended', 'fastest']);
  for (const km of [45, 370, 600, 9000]) {
    const b = L.routeBadges(L.modeOptions(km, false, false), {});
    const all = Object.values(b).flat().map(x => x.id);
    assert.equal(all.length, new Set(all).size, `a badge was awarded twice at ${km} km`);
    for (const list of Object.values(b)) assert.ok(list.length <= 2);
  }
});

test('routeBadges breaks a tie deterministically, on list order', () => {
  const tied = [
    { key: 'rail', cmpMin: 120, cost: { lo: 40, hi: 60 }, co2: { kg: 10 } },
    { key: 'bus', cmpMin: 120, cost: { lo: 40, hi: 60 }, co2: { kg: 10 } },
  ];
  const b = L.routeBadges(tied, {});
  assert.deepEqual(b.rail.map(x => x.id), ['recommended', 'fastest']);
  assert.deepEqual(b.bus, undefined);
});

test('routeBadges recommends the ferry on an island route, since the boat is unavoidable', () => {
  const opts = L.modeOptions(45, true, false);
  const b = L.routeBadges(opts, { island: true });
  assert.ok(b.ferry.some(x => x.id === 'recommended'));
  assert.ok(!(b.drive || []).some(x => x.id === 'recommended'));
});

// ---------- curated corridor facts ----------

test('corridorFacts finds a famous corridor in either direction', () => {
  assert.ok(L.corridorFacts('Tokyo', 'Kyoto'));
  assert.ok(L.corridorFacts('Kyoto, Japan', 'Tokyo, Japan'));
  assert.match(L.corridorFacts('Tokyo', 'Kyoto').tip, /Shinkansen/);
});

test('an unknown route yields no tips and no flags rather than invented ones', () => {
  const ctx = { fromText: 'Ljubljana', toText: 'Maribor', island: false, international: false, km: 120 };
  assert.equal(L.corridorFacts(ctx.fromText, ctx.toText), null);
  assert.deepEqual(L.routeTips(ctx), []);
  assert.deepEqual(L.routeFlags(ctx), []);
});

test('the curated table never carries money, so nothing stale can be quoted as a price', () => {
  const money = /[$€£¥]|\b(usd|eur|gbp|jpy|thb)\b|\b\d+\s*(dollars?|euros?|pounds?|yen|baht)\b/i;
  for (const from of ['Tokyo', 'Bangkok', 'London', 'Madrid', 'New York']) {
    for (const to of ['Kyoto', 'Phuket', 'Paris', 'Barcelona', 'Washington', 'Chiang Mai']) {
      const c = L.corridorFacts(from, to);
      if (!c) continue;
      const text = [c.tip, c.frequency || ''].join(' ');
      assert.ok(!money.test(text), `curated text for ${from}-${to} looks like money: ${text}`);
      const flags = L.routeFlags({ fromText: from, toText: to, island: false, international: false, km: 400 });
      for (const f of flags) assert.ok(!money.test(f.text), `curated flag looks like money: ${f.text}`);
    }
  }
});

test('routeFlags adds the structural facts geometry really knows', () => {
  const ids = ctx => L.routeFlags(ctx).map(f => f.id);
  assert.ok(ids({ fromText: 'Surat Thani', toText: 'Ko Samui', island: true, international: false, km: 80 }).includes('ferry'));
  assert.ok(ids({ fromText: 'Nice', toText: 'Turin', island: false, international: true, km: 200 }).includes('border'));
  assert.ok(ids({ fromText: 'Nice', toText: 'Turin', island: false, international: false, km: 200 }).includes('border') === false);
  assert.ok(ids({ fromText: 'Tokyo', toText: 'Kyoto', island: false, international: false, km: 370 })[0] === 'frequency');
});

test('routeFlags never repeats a flag the curated entry already carries', () => {
  const ids = L.routeFlags({ fromText: 'London', toText: 'Paris', island: false, international: true, km: 340 }).map(f => f.id);
  assert.equal(ids.filter(i => i === 'border').length, 1);
});

test('routeTips layers the curated line over the generic geometry ones', () => {
  const island = L.routeTips({ fromText: 'Bangkok', toText: 'Ko Samui', island: true, km: 600 });
  assert.ok(island.some(t => t.id === 'island'));
  const drive = L.routeTips({ fromText: 'Denver', toText: 'Moab', island: false, km: 500 });
  assert.deepEqual(drive.map(t => t.id), ['long-drive']);
});

// ---------- external links ----------

test('routeLinks picks the national rail operator by country', () => {
  const label = cc => L.routeLinks({ from: 'A', to: 'B', fromCc: cc, toCc: cc, km: 400 }).find(l => l.mode === 'rail').label;
  assert.equal(label('JP'), 'JR Central Smart EX');
  assert.equal(label('DE'), 'Deutsche Bahn');
  assert.equal(label('GB'), 'National Rail');
  assert.equal(label('FR'), 'SNCF Connect');
});

test('routeLinks falls back to Trainline in Europe and to nothing elsewhere', () => {
  const ids = cc => L.routeLinks({ from: 'A', to: 'B', fromCc: cc, toCc: cc, km: 400 }).map(l => l.id);
  assert.ok(ids('IT').includes('trainline'));
  // a country with no rail entry at all gets no rail link invented for it
  assert.ok(!ids('TH').some(id => id === 'rail' || id === 'trainline'));
  // and a national operator makes the reseller redundant
  assert.ok(!ids('FR').includes('trainline'));
});

test('routeLinks offers rail only where a train could actually run', () => {
  const railIds = extra => L.routeLinks(Object.assign({ from: 'A', to: 'B', fromCc: 'FR', toCc: 'FR' }, extra))
    .filter(l => l.mode === 'rail').map(l => l.id);
  assert.deepEqual(railIds({ km: 400 }), ['rail']);
  // intercontinental: landing in France is not a reason to show SNCF
  assert.deepEqual(railIds({ km: 9400 }), []);
  assert.deepEqual(railIds({ km: 400, island: true }), []);
});

test('routeLinks always ends on Rome2Rio, as discovery and never as the official source', () => {
  for (const cc of ['JP', 'TH', '', 'GB']) {
    const links = L.routeLinks({ from: 'A', to: 'B', fromCc: cc, toCc: cc, km: 400 });
    const last = links[links.length - 1];
    assert.equal(last.id, 'r2r');
    assert.equal(last.discovery, true);
    assert.ok(links.some(l => l.official) || !RAIL_KNOWN.has(cc));
  }
});
const RAIL_KNOWN = new Set(['JP', 'FR', 'DE', 'GB']);

test('routeLinks offers a ferry site only when a boat is actually involved', () => {
  const has = island => L.routeLinks({ from: 'A', to: 'B', fromCc: 'TH', toCc: 'TH', km: 400, island }).some(l => l.id === 'ferry');
  assert.equal(has(true), true);
  assert.equal(has(false), false);
});

test('routeLinks needs both places and encodes them into the map links', () => {
  assert.deepEqual(L.routeLinks({ from: 'Tokyo', to: '', km: 100 }), []);
  const drive = L.routeLinks({ from: 'Ko Tao', to: 'Ko Samui', km: 60 }).find(l => l.id === 'drive');
  assert.match(drive.url, /origin=Ko%20Tao&destination=Ko%20Samui/);
});

test('modeLink sends a card to the best site for its mode, Rome2Rio when nothing fits', () => {
  const links = L.routeLinks({ from: 'Tokyo', to: 'Kyoto', fromCc: 'JP', toCc: 'JP', km: 370 });
  assert.equal(L.modeLink('rail', links).site, 'JR Central Smart EX');
  assert.equal(L.modeLink('air', links).site, 'Google Flights');
  assert.equal(L.modeLink('ferry', links).site, 'Rome2Rio');
  assert.equal(L.modeLink('rail', links).label, 'View schedules');
});

test('the honest line says the figures are estimates, not fares', () => {
  assert.match(L.ROUTE_HONESTY, /estimates/);
  assert.match(L.ROUTE_HONESTY, /not schedules or quotes/);
  assert.match(L.ROUTE_HONESTY, /per car/);
  assert.ok(!L.ROUTE_HONESTY.includes('—'));
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

// ---------- location match confidence ----------

function geoRow(name, cc, state, importance, kind = 'city', country = '') {
  return { name, cc, state, importance, kind, country };
}

test('classifyGeoMatch reports failed when the geocoder returned nothing', () => {
  assert.equal(L.classifyGeoMatch('Paris', []), 'failed');
  assert.equal(L.classifyGeoMatch('Paris', null), 'failed');
  assert.equal(L.classifyGeoMatch('Paris', [null]), 'failed');
});

test('classifyGeoMatch treats a non-settlement top hit as low, not a city match', () => {
  // A stray POI or a shop outranking every town means the traveller almost
  // certainly did not get the place they were planning around.
  assert.equal(L.classifyGeoMatch('Eiffel Tower', [geoRow('Eiffel Tower', 'fr', 'IDF', 0.9, 'attraction', 'France')]), 'low');
  assert.equal(L.classifyGeoMatch('Noma', [geoRow('Noma', 'dk', 'H', 0.8, 'restaurant', 'Denmark')]), 'low');
  // A missing kind is no evidence of a settlement either.
  assert.equal(L.classifyGeoMatch('Paris', [{ name: 'Paris', cc: 'fr', state: 'IDF', importance: 0.86, country: 'France' }]), 'low');
});

test('classifyGeoMatch trusts input the traveller already qualified', () => {
  // "Paris, Texas" loses to Paris FR on importance, yet the comma says the
  // traveller picked the small one on purpose, so we do not second-guess it.
  assert.equal(L.classifyGeoMatch('Paris, Texas', [
    geoRow('Paris', 'us', 'Texas', 0.45, 'city', 'United States'),
    geoRow('Paris', 'fr', 'IDF', 0.86, 'city', 'France'),
  ]), 'confident');
  // A trailing country token qualifies without a comma, even against a rival.
  assert.equal(L.classifyGeoMatch('Valencia Spain', [
    geoRow('Valencia', 'es', 'Valencian Community', 0.7, 'city', 'Spain'),
    geoRow('Valencia', 've', 'Carabobo', 0.68, 'city', 'Venezuela'),
  ]), 'confident');
  assert.equal(L.classifyGeoMatch('London Ontario', [geoRow('London', 'ca', 'Ontario', 0.6, 'city', 'Canada')]), 'confident');
  // Two-word hints ("United Kingdom") count as one tail.
  assert.equal(L.classifyGeoMatch('London United Kingdom', [geoRow('London', 'gb', 'England', 0.9, 'city', 'United Kingdom')]), 'confident');
});

test('classifyGeoMatch flags a close settlement rival in another country as ambiguous', () => {
  assert.equal(L.classifyGeoMatch('Valencia', [
    geoRow('Valencia', 'es', 'Valencian Community', 0.7, 'city', 'Spain'),
    geoRow('Valencia', 've', 'Carabobo', 0.68, 'city', 'Venezuela'),
  ]), 'ambiguous');
});

test('classifyGeoMatch flags a close rival in another state of the same country as ambiguous', () => {
  // The Springfield case: same country, same kind, a couple of hundredths apart.
  assert.equal(L.classifyGeoMatch('Springfield', [
    geoRow('Springfield', 'us', 'Illinois', 0.52, 'city', 'United States'),
    geoRow('Springfield', 'us', 'Missouri', 0.5, 'city', 'United States'),
  ]), 'ambiguous');
  // Same state is the same place twice, not a rival worth a warning.
  assert.equal(L.classifyGeoMatch('Riverside', [
    geoRow('Riverside', 'us', 'California', 0.52, 'city', 'United States'),
    geoRow('Riverside', 'us', 'California', 0.5, 'suburb', 'United States'),
  ]), 'confident');
});

test('classifyGeoMatch stays confident when a famous winner outranks its namesake', () => {
  // The gap rule exists to spot look-alikes, so it must not fire on a real
  // winner: Paris FR beats Paris TX by tenths, far beyond GEO_RIVAL_GAP.
  assert.ok(0.86 - 0.45 > L.GEO_RIVAL_GAP);
  assert.equal(L.classifyGeoMatch('Paris', [
    geoRow('Paris', 'fr', 'IDF', 0.86, 'city', 'France'),
    geoRow('Paris', 'us', 'Texas', 0.45, 'city', 'United States'),
  ]), 'confident');
  // A close rival that is not a settlement is not a rival at all.
  assert.equal(L.classifyGeoMatch('Tokyo', [
    geoRow('Tokyo', 'jp', 'Tokyo', 0.9, 'city', 'Japan'),
    geoRow('Tokyo Tower', 'us', 'Texas', 0.89, 'attraction', 'United States'),
  ]), 'confident');
});

test('classifyGeoMatch reports low when the only hit is too obscure to be the destination', () => {
  assert.equal(L.classifyGeoMatch('Nowheresville', [geoRow('Nowheresville', 'us', 'Iowa', 0.12, 'hamlet', 'United States')]), 'low');
  // The threshold is exclusive: exactly at the line still reads as a place.
  assert.equal(L.classifyGeoMatch('Edge', [geoRow('Edge', 'us', 'Iowa', L.GEO_WEAK_IMPORTANCE, 'village', 'United States')]), 'confident');
});

test('classifyGeoMatch never reads a missing importance as weak, and treats it as a close rival', () => {
  // Absence of evidence must not manufacture confidence in either direction:
  // an unscored top hit is not "obscure", and an unscored rival cannot be
  // ruled out on a gap we cannot measure.
  assert.equal(L.classifyGeoMatch('Mystery', [geoRow('Mystery', 'us', 'Iowa', undefined, 'city', 'United States')]), 'confident');
  assert.equal(L.classifyGeoMatch('Mystery', [geoRow('Mystery', 'us', 'Iowa', NaN, 'city', 'United States')]), 'confident');
  // Unscored top: the far-behind rival still counts, so we warn.
  assert.equal(L.classifyGeoMatch('Mystery', [
    geoRow('Mystery', 'us', 'Iowa', undefined, 'city', 'United States'),
    geoRow('Mystery', 'fr', 'IDF', 0.01, 'city', 'France'),
  ]), 'ambiguous');
  // Unscored rival behind a strong winner: still ambiguous, gap unknowable.
  assert.equal(L.classifyGeoMatch('Mystery', [
    geoRow('Mystery', 'fr', 'IDF', 0.9, 'city', 'France'),
    geoRow('Mystery', 'us', 'Iowa', NaN, 'city', 'United States'),
  ]), 'ambiguous');
});

test('classifyGeoMatch does not let a region named after the place self-qualify', () => {
  // Regression: "San Jose" (city in San Jose province) and "New York" (city in
  // New York state) once matched their own region name and read as a hand
  // qualification, hiding every warning behind a false confident.
  assert.equal(L.geoInputIsQualified('San Jose', geoRow('San Jose', 'cr', 'San Jose', 0.7, 'city', 'Costa Rica')), false);
  assert.equal(L.geoInputIsQualified('New York', geoRow('New York', 'us', 'New York', 0.9, 'city', 'United States')), false);
  assert.equal(L.classifyGeoMatch('New York', [
    geoRow('New York', 'us', 'New York', 0.6, 'city', 'United States'),
    geoRow('New York', 'gb', 'England', 0.58, 'village', 'United Kingdom'),
  ]), 'ambiguous');
});

test('geoMatchNote lets the worst level across the places win', () => {
  assert.equal(L.geoMatchNote(['confident', 'confident']), 'Matched to your locations');
  assert.equal(L.geoMatchNote(['confident', 'ambiguous']), 'Not the places you meant? Add a country or region.');
  assert.equal(L.geoMatchNote(['ambiguous', 'low']), 'Please check these locations. Add a country or region for a more precise match.');
  assert.equal(L.geoMatchNote(['low', 'failed']), 'We could not find this location. Try adding a country or region.');
  assert.equal(L.geoMatchNote(['failed', 'confident']), 'We could not find this location. Try adding a country or region.');
  // A bare level is accepted as a one-place list.
  assert.equal(L.geoMatchNote('confident'), 'Matched to your locations');
});

test('geoMatchNote stays silent when either level is unknown', () => {
  // Legacy cache entries were stored before confidence was recorded: with no
  // evidence at all the line says nothing rather than warning without cause.
  assert.equal(L.geoMatchNote(['confident', undefined]), '');
  assert.equal(L.geoMatchNote([undefined, 'low']), '');
  assert.equal(L.geoMatchNote(['confident', 'bogus']), '');
  assert.equal(L.geoMatchNote([]), '');
  assert.equal(L.geoMatchNote(undefined), '');
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

// A taxi across town is not how you got from Tokyo to Kyoto. If `local` cleared
// this gap, the traveller would lose the only warning that says no leg between
// the two cities is booked.
test('transportGaps: a `local` item does NOT clear a city change', () => {
  const trip = { items: [
    stay('t', 'Tokyo', '2027-01-01', '2027-01-05'),
    transport('x', 'Taxi to Tokyo Station', '2027-01-05', '', 'booked', 'local'),
    stay('k', 'Kyoto', '2027-01-05', '2027-01-08'),
  ] };
  const gaps = L.transportGaps(trip);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fromLocation, 'Tokyo');
  assert.equal(gaps[0].toLocation, 'Kyoto');
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

test('dayCards sorts an 08:00 activity above a check-out on the same day', () => {
  // the assumed check-out time is late morning, so a real early activity must
  // land above it; the traveller is not told the hotel time we assumed
  const trip = { items: [
    stay('h', 'Rome', '2027-02-27', '2027-03-01'),
    timedItem('walk', 'activity', 'Morning walk', '2027-03-01', '08:00'),
  ] };
  const day = L.dayCards(trip).find(c => c.date === '2027-03-01');
  assert.deepEqual(day.events.map(e => e.kind === 'item' ? e.item.id : e.kind), ['walk', 'checkout']);
  // a late activity still falls below the check-out
  const trip2 = { items: [
    stay('h', 'Rome', '2027-02-27', '2027-03-01'),
    timedItem('lunch', 'activity', 'Lunch', '2027-03-01', '13:00'),
  ] };
  const day2 = L.dayCards(trip2).find(c => c.date === '2027-03-01');
  assert.deepEqual(day2.events.map(e => e.kind === 'item' ? e.item.id : e.kind), ['checkout', 'lunch']);
});

test('dayCards never exposes the assumed stay times as a displayable time', () => {
  const trip = { items: [
    stay('out', 'Rome', '2027-02-27', '2027-03-01'),
    stay('in', 'Florence', '2027-03-01', '2027-03-04'),
  ] };
  const day = L.dayCards(trip).find(c => c.date === '2027-03-01');
  assert.deepEqual(day.events.map(e => e.kind), ['checkout', 'checkin']);
  for (const ev of day.events) assert.equal(ev.time, '');
});

test('dayCards puts timeless items in their own group at the bottom', () => {
  const trip = { items: [
    timedItem('museum', 'activity', 'Museum', '2027-03-01', '10:00'),
    timedItem('idea', 'activity', 'Maybe the market', '2027-03-01', ''),
    timedItem('idea2', 'note', 'Buy stamps', '2027-03-01', ''),
  ] };
  const day = L.dayCards(trip)[0];
  assert.deepEqual(day.events.map(e => e.item.id), ['museum']);
  assert.deepEqual(day.untimed.map(e => e.item.id), ['idea', 'idea2']);
  assert.equal(day.empty, false);
});

// ---------- the day picker's dropdown ----------

test('the day picker lands on today while the trip is running', () => {
  const days = ['2027-03-01', '2027-03-02', '2027-03-03'];
  assert.equal(L.defaultPlanDay(days, '2027-03-02'), '2027-03-02');
});

test('a trip that has not started yet opens on its first upcoming day', () => {
  const days = ['2027-03-01', '2027-03-02', '2027-03-03'];
  // the owner's trips are entirely future-dated, so this is the common case
  assert.equal(L.defaultPlanDay(days, '2026-12-31'), '2027-03-01');
  // mid-trip with a gap day: the next day that has not happened
  assert.equal(L.defaultPlanDay(['2027-03-01', '2027-03-05'], '2027-03-03'), '2027-03-05');
});

test('a finished trip opens on its last day rather than nothing', () => {
  const days = ['2027-03-01', '2027-03-02'];
  assert.equal(L.defaultPlanDay(days, '2027-04-01'), '2027-03-02');
  assert.equal(L.defaultPlanDay([], '2027-04-01'), '');
});

test('day groups drop empty buckets and label nothing when only one survives', () => {
  const days = ['2027-03-01', '2027-03-02', '2027-03-03'];
  // entirely future: one bucket, and a lone "Upcoming" heading over every
  // option is noise, so the label is dropped
  assert.deepEqual(L.planDayGroups(days, '2026-12-31'), [{ label: '', days }]);
  // entirely past: same rule, other bucket
  assert.deepEqual(L.planDayGroups(days, '2028-01-01'), [{ label: '', days }]);
});

test('a trip in progress splits into Past / Today / Upcoming', () => {
  const days = ['2027-03-01', '2027-03-02', '2027-03-03'];
  assert.deepEqual(L.planDayGroups(days, '2027-03-02'), [
    { label: 'Past', days: ['2027-03-01'] },
    { label: 'Today', days: ['2027-03-02'] },
    { label: 'Upcoming', days: ['2027-03-03'] },
  ]);
  // no "Today" bucket when the date is not a trip day: it is simply omitted
  assert.deepEqual(L.planDayGroups(['2027-03-01', '2027-03-05'], '2027-03-03'), [
    { label: 'Past', days: ['2027-03-01'] },
    { label: 'Upcoming', days: ['2027-03-05'] },
  ]);
});

test('dayCards counts a timeless-only day as not empty', () => {
  const trip = { items: [
    timedItem('a', 'activity', 'Something', '2027-03-01', ''),
    timedItem('b', 'activity', 'Later', '2027-03-03', ''),
  ] };
  const cards = L.dayCards(trip);
  assert.equal(cards[0].empty, false);
  assert.equal(cards[1].empty, true); // the untouched middle day
});

test('dayCards reports the host city on busy days, not only quiet ones', () => {
  const trip = { items: [
    stay('h', 'Tokyo', '2027-03-01', '2027-03-05'),
    timedItem('t', 'activity', 'Shrine', '2027-03-03', '10:00'),
  ] };
  const cards = L.dayCards(trip);
  assert.equal(cards[0].city, 'Tokyo');  // check-in day
  assert.equal(cards[2].city, 'Tokyo');  // busy interior day
  assert.equal(cards[2].events.length, 1);
  assert.equal(cards[4].city, 'Tokyo');  // check-out morning still in Tokyo
  assert.equal(cards[0].hostStayId, 'h');
});

test('dayHostStay prefers tonight\'s bed over the stay being left', () => {
  const items = [
    stay('out', 'Rome', '2027-02-27', '2027-03-01'),
    stay('in', 'Florence', '2027-03-01', '2027-03-04'),
  ];
  assert.equal(L.dayHostStay(items, '2027-03-01').id, 'in');
  assert.equal(L.dayHostStay(items, '2027-02-28').id, 'out');
  assert.equal(L.dayHostStay(items, '2027-03-04').id, 'in'); // check-out morning
  assert.equal(L.dayHostStay(items, '2027-03-05'), null);
});

test('dayHostStay ignores cancelled and location-less stays', () => {
  assert.equal(L.dayHostStay([stay('h', 'Rome', '2027-03-01', '2027-03-05', 'cancelled')], '2027-03-02'), null);
  assert.equal(L.dayHostStay([stay('h', '', '2027-03-01', '2027-03-05')], '2027-03-02'), null);
});

test('a day with no coverage has no city', () => {
  const trip = { items: [
    flight('a', 'A to B', '2027-03-01'),
    flight('b', 'B to C', '2027-03-03'),
  ] };
  const cards = L.dayCards(trip);
  assert.equal(cards[1].city, '');
  assert.equal(cards[1].hostStayId, null);
});

// ---------- morning city ----------

const RESOLVES = new Set(['shreveport', 'tokyo', 'rome', 'osaka', 'shibuya']);
const geoOk = p => RESOLVES.has(String(p).trim().toLowerCase());

test('stripPlaceCode drops airport and station codes', () => {
  assert.equal(L.stripPlaceCode('Shreveport (SHV)'), 'Shreveport');
  assert.equal(L.stripPlaceCode('Tokyo'), 'Tokyo');
  assert.equal(L.stripPlaceCode('Paris (CDG) (T2)'), 'Paris');
});

test('parseTravelOrigin takes the half before the FIRST " to "', () => {
  assert.equal(L.parseTravelOrigin('Shreveport (SHV) to Tokyo (HND)'), 'Shreveport');
  assert.equal(L.parseTravelOrigin('Rome to Florence'), 'Rome');
  // a multi-leg title still departs from the first city, not the middle one
  assert.equal(L.parseTravelOrigin('Tokyo to Kyoto to Osaka'), 'Tokyo');
  assert.equal(L.parseTravelOrigin('Toronto To Montreal'), 'Toronto');
  assert.equal(L.parseTravelOrigin('Bullet train'), '');
  assert.equal(L.parseTravelOrigin(''), '');
});

test('dayMorningCity prefers the stay you woke up in', () => {
  const items = [
    stay('h', 'Rome', '2027-03-01', '2027-03-05'),
    flight('f', 'Rome to Tokyo', '2027-03-05', '', 'booked'),
  ];
  // check-out morning: the bed still answers, not the flight's origin
  assert.deepEqual(L.dayMorningCity(items, '2027-03-05', geoOk), { city: 'Rome', source: 'stay' });
  assert.deepEqual(L.dayMorningCity(items, '2027-03-02', geoOk), { city: 'Rome', source: 'stay' });
});

test('dayMorningCity falls back to the departure city of a flight-only day', () => {
  const items = [{
    id: 'f', type: 'flight', title: 'Shreveport (SHV) to Tokyo (HND)',
    startDate: '2026-12-29', endDate: '', status: 'booked', createdAt: 'f',
  }];
  assert.deepEqual(L.dayMorningCity(items, '2026-12-29', geoOk), { city: 'Shreveport', source: 'travel-origin' });
});

test('dayMorningCity refuses a parsed origin the geocoder does not know', () => {
  // "Return to hotel" and "Travel to Shibuya" are assistant-contract phrasings:
  // a naive split would name the day "Return" / "Travel" and then fetch that
  // non-place's weather, so the gate must reject them.
  const back = [{ id: 't', type: 'transport', title: 'Return to hotel', startDate: '2027-03-02', status: 'booked', createdAt: 't' }];
  assert.deepEqual(L.dayMorningCity(back, '2027-03-02', geoOk), { city: '', source: '' });
  const go = [{ id: 't', type: 'transport', title: 'Travel to Shibuya', startDate: '2027-03-02', status: 'booked', createdAt: 't' }];
  assert.deepEqual(L.dayMorningCity(go, '2027-03-02', geoOk), { city: '', source: '' });
});

test('dayMorningCity ignores a non-travel title that happens to read "A to B"', () => {
  const items = [{ id: 'a', type: 'activity', title: 'Tokyo to Osaka walking tour', startDate: '2027-03-02', location: '', status: 'booked', createdAt: 'a' }];
  assert.deepEqual(L.dayMorningCity(items, '2027-03-02', geoOk), { city: '', source: '' });
});

test('dayMorningCity falls through an unresolvable origin to a located item', () => {
  const items = [
    { id: 't', type: 'transport', title: 'Return to hotel', startDate: '2027-03-02', startTime: '08:00', location: '', status: 'booked', createdAt: 't' },
    { id: 'a', type: 'activity', title: 'Fish market', startDate: '2027-03-02', startTime: '10:00', location: 'Osaka', status: 'booked', createdAt: 'a' },
  ];
  assert.deepEqual(L.dayMorningCity(items, '2027-03-02', geoOk), { city: 'Osaka', source: 'location' });
});

test('dayMorningCity uses only the FIRST travel item of the day', () => {
  const items = [
    { id: 'f1', type: 'flight', title: 'Shreveport (SHV) to Tokyo (HND)', startDate: '2026-12-29', startTime: '06:00', status: 'booked', createdAt: 'f1' },
    { id: 'f2', type: 'flight', title: 'Tokyo to Osaka', startDate: '2026-12-29', startTime: '20:00', status: 'booked', createdAt: 'f2' },
  ];
  assert.equal(L.dayMorningCity(items, '2026-12-29', geoOk).city, 'Shreveport');
});

test('dayMorningCity skips cancelled items and gives up cleanly', () => {
  const items = [
    { id: 'f', type: 'flight', title: 'Tokyo to Osaka', startDate: '2027-03-02', status: 'cancelled', createdAt: 'f' },
    { id: 'n', type: 'note', title: 'Buy a SIM', startDate: '2027-03-02', location: '', status: 'booked', createdAt: 'n' },
  ];
  assert.deepEqual(L.dayMorningCity(items, '2027-03-02', geoOk), { city: '', source: '' });
  assert.deepEqual(L.dayMorningCity([], '2027-03-02', geoOk), { city: '', source: '' });
});

test('dayMorningCity without a gate trusts any parsed origin', () => {
  const items = [{ id: 'f', type: 'flight', title: 'Nowhereville to Tokyo', startDate: '2027-03-02', status: 'booked', createdAt: 'f' }];
  assert.equal(L.dayMorningCity(items, '2027-03-02').city, 'Nowhereville');
});

// ---------- passport inference ----------
// The visa dialog is the highest-stakes screen in the app, so this derivation
// may only ever produce a LABELLED assumption, and must give up (leaving the
// traveller to pick) the moment the origin stops being a known place.

const toCountry = { shreveport: 'US', denver: 'US', athens: 'GR', toronto: 'CA', tokyo: 'JP' };
const ccOf = p => toCountry[String(p).trim().toLowerCase()] || '';

test('departureOrigin reads the first non-cancelled flight of the trip', () => {
  const items = [
    flight('f2', 'Tokyo to Osaka', '2027-03-08'),
    flight('f0', 'Paris to Shreveport', '2027-03-01', '', 'cancelled'),
    flight('f1', 'Shreveport (SHV) to Tokyo (HND)', '2027-03-01'),
  ];
  assert.equal(L.departureOrigin(items), 'Shreveport');
  assert.equal(L.departureOrigin([]), '');
});

test('suggestedPassport reads the passport off the flight out', () => {
  const items = [
    flight('f1', 'Shreveport (SHV) to Tokyo (HND)', '2027-03-01'),
    stay('h', 'Tokyo', '2027-03-01', '2027-03-06'),
    flight('f2', 'Tokyo (HND) to Shreveport (SHV)', '2027-03-06'),
  ];
  assert.deepEqual(L.suggestedPassport(items, ccOf), { cc: 'US', origin: 'Shreveport' });
});

test('suggestedPassport gives up rather than guessing from something weaker', () => {
  // no flight at all: a trip that starts with a train says nothing about home
  const noFlight = [{ id: 't', type: 'transport', title: 'Rome to Florence', startDate: '2027-03-01', status: 'booked' }];
  assert.equal(L.suggestedPassport(noFlight, ccOf), null);
  // a title that is not "A to B"
  const unparseable = [flight('f', 'Redeye home', '2027-03-01')];
  assert.equal(L.suggestedPassport(unparseable, ccOf), null);
  // an origin no geocoder resolves
  const unknown = [flight('f', 'Nowhereville to Tokyo', '2027-03-01')];
  assert.equal(L.suggestedPassport(unknown, ccOf), null);
  // and with no resolver injected there is nothing to resolve against
  assert.equal(L.suggestedPassport([flight('f', 'Shreveport to Tokyo', '2027-03-01')]), null);
});

test('suggestedPassport rejects a resolver answer that is not a country code', () => {
  const items = [flight('f', 'Shreveport to Tokyo', '2027-03-01')];
  assert.equal(L.suggestedPassport(items, () => 'United States'), null);
  assert.equal(L.suggestedPassport(items, () => ''), null);
  // lowercase from a cache written by a different code path is still valid
  assert.deepEqual(L.suggestedPassport(items, () => 'us'), { cc: 'US', origin: 'Shreveport' });
});

test('suggestedPassport still answers on a domestic-only trip', () => {
  // the guess is about the ORIGIN, not about crossing a border: flying Denver
  // to Miami still says the traveller lives in the United States
  const items = [flight('f', 'Denver (DEN) to Miami (MIA)', '2027-03-01')];
  assert.deepEqual(L.suggestedPassport(items, ccOf), { cc: 'US', origin: 'Denver' });
});

test('passportAssumptionParts never needs an article', () => {
  // English articles follow pronunciation, not spelling, so "an United States"
  // is what a leading-vowel test produces and what this shape must never emit.
  const cases = [
    ['Greece', 'Athens'],
    ['United States', 'Shreveport'],
    ['United Kingdom', 'London'],
    ['Israel', 'Tel Aviv'],
    ['Netherlands', 'Amsterdam'],
    ['Egypt', 'Cairo'],
  ];
  for (const [country, origin] of cases) {
    const p = L.passportAssumptionParts(country, origin);
    assert.equal(p.value, country);
    assert.equal(p.source, `from your flight out of ${origin}`);
    assert.equal(p.text, `Assumed passport: ${country} (from your flight out of ${origin})`);
    assert.ok(!/\ban\b|\ba\b|\bthe\b/i.test(p.text.replace(/\b(?:United States|United Kingdom|Netherlands|Israel|Greece|Egypt)\b/g, '')),
      `stray article in: ${p.text}`);
    assert.ok(!p.text.includes(' an '), p.text);
  }
});

test('passportAssumptionParts still says it is an assumption without an origin', () => {
  for (const origin of [undefined, null, '', '   ']) {
    const p = L.passportAssumptionParts('Israel', origin);
    assert.equal(p.label, 'Assumed passport');
    assert.equal(p.source, 'from your itinerary');
    assert.equal(p.text, 'Assumed passport: Israel (from your itinerary)');
    assert.ok(!p.text.includes(' an '), p.text);
  }
  // and with nothing at all it still reads as an assumption, not as a fact
  const empty = L.passportAssumptionParts('', '');
  assert.equal(empty.text, 'Assumed passport: (from your itinerary)');
  assert.ok(/^Assumed/.test(empty.text));
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

test('weatherRange is the bare range, with no forecast wording and no place', () => {
  assert.equal(L.weatherRange({ lo: 4, hi: 12, wet: true }), '4-12°C');
  // a hyphen between sub-zero numbers reads as "-12--7"
  assert.equal(L.weatherRange({ lo: -3, hi: 2, wet: false }), '-3 to 2°C');
  assert.equal(L.weatherRange({ lo: -12, hi: -7, wet: false }), '-12 to -7°C');
  assert.match(L.weatherLine('Ittoqqortoormiit', { lo: -12, hi: -7, wet: false }), /Typically -12 to -7°C in Ittoqqortoormiit/);
  assert.equal(L.weatherRange({ lo: null, hi: 12 }), '');
  assert.equal(L.weatherRange(null), '');
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

test('slimTripForShare carries the estimate so a shared plan shows what to expect', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'x1', type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01',
      status: 'to-book', cost: null, estCost: 45, estCostCurrency: 'JPY', createdAt: 'z' },
  ] };
  const slim = L.slimTripForShare(trip);
  assert.equal(slim.items[0].estCost, 45);
  assert.equal(slim.items[0].estCostCurrency, 'JPY');
  // it is still not a cost on the far side
  assert.equal(slim.items[0].cost, undefined);
  assert.equal(L.tripStats({ items: slim.items }).planned, 0);
});

test('the ICS export has nowhere honest to put a guess, so it carries none', () => {
  const trip = { name: 'T', items: [
    { id: 'x1', type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01',
      status: 'to-book', estCost: 45, estCostCurrency: 'USD' },
  ] };
  const ics = L.buildIcs(trip);
  assert.ok(ics.includes('SUMMARY:Dinner: Narisawa'));
  assert.ok(!ics.includes('45'));
  assert.ok(!/estCost/i.test(ics));
});

test('a proposal price is presented as an estimate, never as a cost', () => {
  const trip = { items: [] };
  const res = L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-01-01', cost: 45, costCurrency: 'JPY',
  } }, trip);
  assert.equal(res.ok, true);
  assert.equal(res.proposal.display.estCost, 45);
  assert.equal(res.proposal.display.estCostCurrency, 'JPY');
  assert.equal(res.proposal.display.cost, undefined);
  assert.equal(L.isEstimatedCost(res.proposal.display), true);
});

test('slimTripForShare keeps mapsQuery so the assistant sees verified places', () => {
  // mapsQuery is a real item field now (it used to be flattened into details).
  // Dropping it here would send the model a trip with no Maps context, and it
  // would re-suggest venues the traveller has already accepted.
  const trip = { name: 'T', currency: 'JPY', items: [
    { id: 'a', type: 'activity', title: 'Dinner: Narisawa', startDate: '2026-12-31', mapsQuery: 'Narisawa Tokyo' },
    { id: 'b', type: 'activity', title: 'Walk', startDate: '2026-12-31' },
    { id: 'c', type: 'activity', title: 'Blank', startDate: '2026-12-31', mapsQuery: '' },
  ] };
  const slim = L.slimTripForShare(trip);
  assert.equal(slim.items[0].mapsQuery, 'Narisawa Tokyo');
  // absent or empty must emit no key at all: share links pay for every byte
  assert.equal('mapsQuery' in slim.items[1], false);
  assert.equal('mapsQuery' in slim.items[2], false);
});

// ---------- view <-> fragment ----------
// The fragment is shared with the share link, which parks a whole compressed
// trip in it. The isShare signal is what stops the view code from ever writing
// over a payload: a refresh after that would lose the shared itinerary.
test('viewFromHash reads the three views', () => {
  assert.deepEqual(L.viewFromHash('#days', 'timeline'), { view: 'days', isShare: false });
  assert.deepEqual(L.viewFromHash('#map', 'timeline'), { view: 'map', isShare: false });
  assert.deepEqual(L.viewFromHash('#timeline', 'map'), { view: 'timeline', isShare: false });
});

test('viewFromHash flags a share payload and hands back the fallback untouched', () => {
  assert.deepEqual(L.viewFromHash('#share=AAAA', 'days'), { view: 'days', isShare: true });
  // case-insensitive on purpose: never write over anything payload-shaped
  assert.equal(L.viewFromHash('#SHARE=AAAA', 'timeline').isShare, true);
});

test('viewFromHash falls back for empty, bare and unknown fragments', () => {
  for (const h of ['', '#', '#nonsense', '#/days', null, undefined]) {
    assert.deepEqual(L.viewFromHash(h, 'map'), { view: 'map', isShare: false }, `hash ${h}`);
  }
});

test('viewFromHash matches the whole fragment, not a prefix', () => {
  assert.equal(L.viewFromHash('#daysofourlives', 'timeline').view, 'timeline');
  assert.equal(L.viewFromHash('#mapbox', 'timeline').view, 'timeline');
});

test('viewFromHash is case-insensitive on the view name', () => {
  assert.equal(L.viewFromHash('#Days', 'timeline').view, 'days');
  assert.equal(L.viewFromHash('#MAP', 'timeline').view, 'map');
});

test('viewFromHash guards against a junk fallback', () => {
  assert.equal(L.viewFromHash('#nonsense', 'wat').view, 'timeline');
});

test('hashForView is the inverse, with timeline as the clean default URL', () => {
  assert.equal(L.hashForView('days'), '#days');
  assert.equal(L.hashForView('map'), '#map');
  assert.equal(L.hashForView('timeline'), '');
  assert.equal(L.hashForView('nope'), '');
  for (const v of ['days', 'map', 'timeline']) {
    assert.equal(L.viewFromHash(L.hashForView(v), 'timeline').view, v);
  }
});

// netlify/functions/tp-assist.mjs caps a tripContext at MAX_TRIP_JSON (30000
// chars). It no longer rejects an oversize one: fitAssistContext trims free-text
// details to fit and flags the prompt (see the trim tests above). Payload size
// is still a hard product constraint, because trimming costs the model context. Measured 2026-07-19: mapsQuery costs about
// 26 bytes per item that has one. A 40-item trip with long details was already
// near the cap BEFORE this field existed, so the guard below tracks the whole
// payload, not just the delta.
function bigTrip(itemCount, withMapsQuery) {
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const base = { id: `f9b2c8d1-aaaa-bbbb-cccc-${String(i).padStart(12, '0')}`, startDate: '2026-12-31', status: 'to-book', cost: 12000, costCurrency: 'JPY' };
    const k = i % 5;
    if (k === 0) items.push({ ...base, type: 'stay', title: 'Park Hotel Tokyo', location: 'Minato City, Tokyo', endDate: '2027-01-03' });
    else if (k === 1) items.push({ ...base, type: 'flight', title: 'NRT to ITM', startTime: '09:20', endTime: '10:45' });
    else items.push({ ...base, type: 'activity', title: 'Dinner: Narisawa', location: 'Minato City, Tokyo', startTime: '19:00', endTime: '21:00', details: 'Booked via concierge, 8 course tasting menu.', mapsQuery: withMapsQuery ? 'Narisawa, Minato City, Tokyo' : undefined });
  }
  return { name: 'Japan New Year', currency: 'JPY', items };
}

test('a realistic 40-item trip with mapsQuery stays well under the 30000-char payload cap', () => {
  const size = JSON.stringify(L.slimTripForShare(bigTrip(40, true))).length;
  assert.ok(size < 15000, `payload was ${size} chars against a 30000 cap`);
});

test('adding mapsQuery costs a small fraction of the payload cap', () => {
  const withQ = JSON.stringify(L.slimTripForShare(bigTrip(40, true))).length;
  const without = JSON.stringify(L.slimTripForShare(bigTrip(40, false))).length;
  assert.ok(withQ > without, 'mapsQuery must actually be in the payload');
  assert.ok(withQ - without < 3000, `mapsQuery added ${withQ - without} chars to a 40-item trip`);
});

// ---------- assistant: extractTripActions ----------

test('extractTripActions pulls actions from a ```json fence and cleans the prose', () => {
  const text = 'Sure, here is a plan.\n\n```json\n{"tripActions":[{"op":"add","item":{"title":"Louvre"}}]}\n```\n\nEnjoy!';
  const { actions, cleanedText } = L.extractTripActions(text);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].item.title, 'Louvre');
  assert.doesNotMatch(cleanedText, /tripActions/);
  assert.match(cleanedText, /Sure, here is a plan/);
  assert.match(cleanedText, /Enjoy!/);
});

test('extractTripActions reads a bare {"tripActions"} object amid prose', () => {
  const text = 'Add this: {"tripActions":[{"op":"remove","match":{"title":"Old"}}]} done.';
  const { actions, cleanedText } = L.extractTripActions(text);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, 'remove');
  assert.doesNotMatch(cleanedText, /tripActions/);
  assert.match(cleanedText, /Add this:/);
  assert.match(cleanedText, /done\./);
});

test('extractTripActions treats pure prose as no actions and preserves the text verbatim', () => {
  const text = '  Just some advice about Tokyo, no edits here.  ';
  const out = L.extractTripActions(text);
  assert.deepEqual(out.actions, []);
  assert.equal(out.cleanedText, text);
});

test('extractTripActions concatenates two blocks in document order', () => {
  const text = 'First\n```json\n{"tripActions":[{"op":"add","item":{"title":"A"}}]}\n```\n'
    + 'then {"tripActions":[{"op":"add","item":{"title":"B"}}]} last.';
  const { actions } = L.extractTripActions(text);
  assert.deepEqual(actions.map(a => a.item.title), ['A', 'B']);
});

test('extractTripActions leaves a truncated block in the prose and never throws', () => {
  const text = 'Here is the start ```json\n{"tripActions":[{"op":"add","item":{"title":"Cut off"';
  const { actions, cleanedText } = L.extractTripActions(text);
  assert.deepEqual(actions, []);
  assert.match(cleanedText, /Cut off/);
});

test('extractTripActions skips malformed JSON but keeps well-formed siblings', () => {
  const text = '```json\n{"tripActions":[{oops not json]}\n```\n'
    + 'and {"tripActions":[{"op":"add","item":{"title":"Good"}}]}';
  const { actions } = L.extractTripActions(text);
  assert.deepEqual(actions.map(a => a.item.title), ['Good']);
});

// ---------- assistant: validateTripAction ----------

const tripWith = items => ({ name: 'T', currency: 'USD', items });

test('validateTripAction add: valid item yields a to-book proposal', () => {
  const r = L.validateTripAction({ op: 'add', item: { type: 'activity', title: 'Louvre', startDate: '2027-05-01', mapsQuery: 'Louvre Paris' } }, tripWith([]));
  assert.equal(r.ok, true);
  assert.equal(r.proposal.op, 'add');
  assert.equal(r.proposal.status, 'to-book');
  assert.equal(r.proposal.fields.title, 'Louvre');
  assert.equal(r.proposal.display.mapsQuery, 'Louvre Paris');
});

test('validateTripAction add: missing title and bad type are rejected with reasons', () => {
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'activity', title: '  ', startDate: '2027-05-01' } }, tripWith([])).ok, false);
  const badType = L.validateTripAction({ op: 'add', item: { type: 'hovercraft', title: 'X', startDate: '2027-05-01' } }, tripWith([]));
  assert.equal(badType.ok, false);
  assert.match(badType.reason, /type/);
});

test('validateTripAction add: no silent type coercion (unknown type never becomes note)', () => {
  const r = L.validateTripAction({ op: 'add', item: { type: 'spaceship', title: 'X', startDate: '2027-05-01' } }, tripWith([]));
  assert.equal(r.ok, false);
});

test('validateTripAction add: start date must be ISO', () => {
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'note', title: 'X', startDate: 'May 1st' } }, tripWith([])).ok, false);
});

test('validateTripAction add: stay needs check-out strictly after check-in', () => {
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'stay', title: 'H', startDate: '2027-05-01', endDate: '2027-05-01' } }, tripWith([])).ok, false);
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'stay', title: 'H', startDate: '2027-05-01', endDate: '2027-05-03' } }, tripWith([])).ok, true);
});

test('validateTripAction add: non-stay end date may equal but not precede the start', () => {
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'flight', title: 'F', startDate: '2027-05-01', endDate: '2027-05-01' } }, tripWith([])).ok, true);
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'flight', title: 'F', startDate: '2027-05-02', endDate: '2027-05-01' } }, tripWith([])).ok, false);
});

test('validateTripAction add: model status booked/cancelled is forced to to-book, decide survives', () => {
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'note', title: 'X', startDate: '2027-05-01', status: 'booked' } }, tripWith([])).proposal.status, 'to-book');
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'note', title: 'X', startDate: '2027-05-01', status: 'cancelled' } }, tripWith([])).proposal.status, 'to-book');
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'note', title: 'X', startDate: '2027-05-01', status: 'decide' } }, tripWith([])).proposal.status, 'decide');
});

test('validateTripAction add: a model-supplied refund and a bad currency drop, valid ones survive', () => {
  // A negative is legal DATA now (see the refund tests), but not from a model:
  // the key is omitted entirely so an `update` falls back to the item's own
  // number rather than blanking it.
  const bad = L.validateTripAction({ op: 'add', item: { type: 'note', title: 'X', startDate: '2027-05-01', cost: -5, costCurrency: 'dollars' } }, tripWith([]));
  assert.equal('cost' in bad.proposal.fields, false);
  assert.equal(bad.proposal.fields.costCurrency, undefined);
  const good = L.validateTripAction({ op: 'add', item: { type: 'note', title: 'X', startDate: '2027-05-01', cost: 40, costCurrency: 'EUR' } }, tripWith([]));
  assert.equal(good.proposal.fields.cost, 40);
  assert.equal(good.proposal.fields.costCurrency, 'EUR');
});

test('validateTripAction update/remove resolve by exact id or case-insensitive exact title', () => {
  const trip = tripWith([{ id: 'abc', type: 'stay', title: 'Hotel Nikko', startDate: '2027-05-01', endDate: '2027-05-04' }]);
  assert.equal(L.validateTripAction({ op: 'remove', match: { id: 'abc' } }, trip).proposal.targetId, 'abc');
  assert.equal(L.validateTripAction({ op: 'remove', match: { title: 'hotel nikko' } }, trip).proposal.targetId, 'abc');
  const upd = L.validateTripAction({ op: 'update', match: { title: 'Hotel Nikko' }, set: { cost: 300 } }, trip);
  assert.equal(upd.ok, true);
  assert.equal(upd.proposal.fields.cost, 300);
});

test('validateTripAction update/remove: zero matches and ambiguous matches are rejected with the exact reasons', () => {
  const trip = tripWith([
    { id: 'a', type: 'note', title: 'Museum', startDate: '2027-05-01' },
    { id: 'b', type: 'note', title: 'museum', startDate: '2027-05-02' },
  ]);
  assert.equal(L.validateTripAction({ op: 'remove', match: { title: 'Nope' } }, trip).reason, 'No matching item found.');
  assert.equal(L.validateTripAction({ op: 'update', match: { title: 'Museum' }, set: {} }, trip).reason, 'Multiple items match, name it more specifically.');
  assert.equal(L.validateTripAction({ op: 'update', set: { cost: 1 } }, trip).ok, false);
});

// ---------- assistant: prompt builders ----------

test('buildAssistPackage embeds the slim trip, schema, contract, request and focus day', () => {
  const trip = tripWith([{ id: 'x', type: 'stay', title: 'Ryokan', location: 'Kyoto', startDate: '2027-05-01', endDate: '2027-05-03', createdAt: '2026-01-01T00:00:00Z' }]);
  const pkg = L.buildAssistPackage({ trip, focusDate: '2027-05-02', request: 'What should I do on day 2?' });
  assert.match(pkg, /"tripActions"/);
  assert.match(pkg, /mapsQuery/);
  assert.match(pkg, /Ryokan/);
  assert.match(pkg, /2027-05-02/);
  assert.match(pkg, /What should I do on day 2\?/);
  // slimmed: the createdAt timestamp is stripped before the trip is shared
  assert.doesNotMatch(pkg, /createdAt/);
});

test('buildAssistPackage omits the focus-day line when no day is focused', () => {
  const pkg = L.buildAssistPackage({ trip: tripWith([]), focusDate: '', request: 'hi' });
  assert.doesNotMatch(pkg, /focused on this day/);
});

test('buildAssistSystemPrompt carries the honesty note, schema, contract, today and trip', () => {
  const trip = tripWith([{ id: 'x', type: 'note', title: 'Idea', startDate: '2027-05-01' }]);
  const sys = L.buildAssistSystemPrompt({ trip, focusDate: '2027-05-01', today: '2026-07-19' });
  assert.match(sys, /Google Maps/);
  assert.match(sys, /"tripActions"/);
  assert.match(sys, /Today is 2026-07-19/);
  assert.match(sys, /focused on this day: 2027-05-01/);
  assert.match(sys, /Idea/);
});

test('buildAssistSystemPrompt still builds when the server has no trip in the payload', () => {
  // tp-assist.mjs feeds this from a network body, where trip may be absent.
  const sys = L.buildAssistSystemPrompt({ trip: null, focusDate: '', today: '2026-07-19' });
  assert.match(sys, /"tripActions"/);
  assert.doesNotMatch(sys, /current trip as JSON/);
});

// ---------- assistant: agenda + grouping instructions (stories 9-12) ----------
// Each assertion below is a production failure we do not want back: one fat
// item holding a whole timetable, meals dropped to two of three, no ride home,
// and restaurant names in prose that never became actions.

for (const [name, build] of [
  ['buildAssistSystemPrompt', () => L.buildAssistSystemPrompt({ trip: tripWith([]), focusDate: '', today: '' })],
  ['buildAssistPackage', () => L.buildAssistPackage({ trip: tripWith([]), focusDate: '', request: 'plan my day' })],
]) {
  test(`${name} demands one add action per agenda entry with its own startTime`, () => {
    const s = build();
    assert.match(s, /ONE add action per agenda entry/);
    assert.match(s, /own startTime/);
  });

  test(`${name} shows the timetable-in-details failure as an explicit negative example`, () => {
    const s = build();
    assert.match(s, /WRONG/);
    assert.match(s, /New Year's Eve in Tokyo/);
    assert.match(s, /09:30 Breakfast\. 10:15-12:00 Hie Shrine\. 12:30-14:00 Lunch/);
    assert.match(s, /RIGHT/);
  });

  // The earlier "always emit breakfast AND lunch AND dinner" wording fixed a
  // dropped-meal bug by overcorrecting: it made the model serve a full day to a
  // traveller who had switched lunch, dinner, activities and drinks off. The
  // rule must keep meals from being dropped WITHOUT inventing slots.
  test(`${name} demands exactly the slots asked for, never more, never fewer`, () => {
    const s = build();
    assert.doesNotMatch(s, /breakfast AND lunch AND dinner/);
    assert.doesNotMatch(s, /never two of the three/);
    assert.match(s, /Plan exactly the slots the traveller asked for/);
    assert.match(s, /never drop one they asked for, and never add one they did not/);
    assert.match(s, /breakfast and nothing else/);
  });

  test(`${name} forbids introducing an unrequested slot type in the action contract`, () => {
    assert.match(build(), /Never introduce a slot type the traveller did not request/);
  });

  test(`${name} scopes the 2-3 candidates rule to the slots the traveller asked for`, () => {
    assert.match(build(), /meal slot and each drinks slot the traveller asked for \(and only those\)/);
  });

  test(`${name} requires a return-to-hotel action per day within the return-by time`, () => {
    const s = build();
    assert.match(s, /Return to hotel/);
    // The ride home is a LOCAL hop: routing it to "transport" would let it stand
    // in for a between-cities leg and quiet a real continuity warning.
    assert.match(s, /one local action per planned day/);
    assert.match(s, /type "local", never "transport"/);
    assert.match(s, /startTime no later than that time/);
  });

  test(`${name} explains the transport (between cities) vs local (within a city) split`, () => {
    const s = build();
    assert.match(s, /"transport" for travel BETWEEN cities/);
    assert.match(s, /"local" for getting around WITHIN one city/);
  });

  test(`${name} forbids naming a venue in prose with no matching action`, () => {
    const s = build();
    assert.match(s, /Every venue you name in your prose must have a matching add action carrying a mapsQuery/);
    assert.match(s, /Never name a restaurant, bar or sight in prose without the action/);
  });

  // A category mapsQuery is why "Verify on Google Maps" opened the wrong place:
  // Maps resolves it to whatever it likes. All three examples below are real
  // queries from the owner's production reply.
  test(`${name} demands a specific venue name in mapsQuery, never a category`, () => {
    const s = build();
    assert.match(s, /SPECIFIC, searchable name of ONE real venue/);
    assert.match(s, /city or neighbourhood/);
    assert.match(s, /Never a category, a cuisine, a meal, an area or a description/);
  });

  test(`${name} shows the three real category failures with their corrections`, () => {
    const s = build();
    assert.ok(s.includes('WRONG: "Roppongi sushi restaurants". RIGHT: "Sukiyabashi Jiro Roppongi Tokyo".'));
    assert.ok(s.includes('WRONG: "Breakfast near Akasaka Tokyo".'));
    assert.match(s, /"Shibuya Crossing Tokyo" on an item titled "New Year's Eve in Tokyo"/);
  });

  test(`${name} makes the return-to-hotel action carry the real hotel name`, () => {
    const s = build();
    assert.match(s, /actual hotel name taken from the trip JSON/);
    assert.match(s, /never "hotel", "our hotel" or "back to the hotel"/);
  });

  test(`${name} says to omit mapsQuery when the item has no single place`, () => {
    // An absent link beats a wrong one: a travel leg or a note names no venue.
    const s = build();
    assert.match(s, /omit mapsQuery\s+entirely/);
    assert.match(s, /No link is better than a link to the wrong place/);
  });

  test(`${name} asks for 2-3 grouped candidates for meals and drinks only`, () => {
    const s = build();
    assert.match(s, /propose 2-3 candidates/);
    assert.match(s, /"group"/);
    assert.match(s, /dinner-2026-12-31/);
    assert.match(s, /Do NOT group activities or transport/);
  });

  test(`${name} keeps the six item types and carries the kind in a title prefix`, () => {
    const s = build();
    assert.match(s, /limited to flight, transport, local, activity, stay and note/);
    assert.match(s, /Meals and drinks are type "activity"/);
    for (const prefix of ['"Breakfast: "', '"Lunch: "', '"Dinner: "', '"Drinks: "']) {
      assert.ok(s.includes(prefix), `missing literal title prefix ${prefix}`);
    }
  });
}

test('an assistant action typed `local` produces a valid proposal', () => {
  const r = L.validateTripAction({
    op: 'add',
    item: { type: 'local', title: 'Return to hotel', startDate: '2027-05-01', startTime: '22:00' },
  }, tripWith([]));
  assert.equal(r.ok, true);
  assert.equal(r.proposal.fields.type, 'local');
  assert.equal(r.proposal.status, 'to-book');
});

test('the action types are NOT widened for meals and drinks', () => {
  // The six types are the storage schema; "meal" must still be rejected.
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'meal', title: 'Dinner: X', startDate: '2027-05-01' } }, tripWith([])).ok, false);
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'drinks', title: 'Drinks: X', startDate: '2027-05-01' } }, tripWith([])).ok, false);
  assert.equal(L.validateTripAction({ op: 'add', item: { type: 'activity', title: 'Dinner: X', startDate: '2027-05-01' } }, tripWith([])).ok, true);
});

// ---------- assistant: alternative sets (group) ----------

test('extractTripActions passes an add group through untouched', () => {
  const text = '```json\n{"tripActions":[{"op":"add","group":"dinner-2027-05-01","item":{"title":"Dinner: A"}}]}\n```';
  const { actions } = L.extractTripActions(text);
  assert.equal(actions[0].group, 'dinner-2027-05-01');
});

test('validateTripAction add: a group survives validation from the action or the item', () => {
  const base = { type: 'activity', title: 'Dinner: Narisawa', startDate: '2027-05-01' };
  const onAction = L.validateTripAction({ op: 'add', group: 'dinner-2027-05-01', item: base }, tripWith([]));
  assert.equal(onAction.ok, true);
  assert.equal(onAction.proposal.group, 'dinner-2027-05-01');
  const onItem = L.validateTripAction({ op: 'add', item: { ...base, group: 'dinner-2027-05-01' } }, tripWith([]));
  assert.equal(onItem.proposal.group, 'dinner-2027-05-01');
});

test('validateTripAction add: no group means no group key (unchanged behaviour)', () => {
  const r = L.validateTripAction({ op: 'add', item: { type: 'activity', title: 'Louvre', startDate: '2027-05-01' } }, tripWith([]));
  assert.equal('group' in r.proposal, false);
});

test('validateTripAction add: a grouped add is validated exactly like any other add', () => {
  const bad = L.validateTripAction({ op: 'add', group: 'dinner-1', item: { type: 'activity', title: '', startDate: '2027-05-01' } }, tripWith([]));
  assert.equal(bad.ok, false);
});

test('groupProposals keeps ungrouped proposals as singles in order', () => {
  const list = [{ id: 1 }, { id: 2, group: '' }, { id: 3 }];
  const out = L.groupProposals(list);
  assert.deepEqual(out.map(e => e.type), ['single', 'single', 'single']);
  assert.deepEqual(out.map(e => e.proposal.id), [1, 2, 3]);
});

test('groupProposals collapses 2+ shared-group proposals into one set at the first position', () => {
  const list = [
    { id: 'a' },
    { id: 'd1', group: 'dinner' },
    { id: 'x' },
    { id: 'd2', group: 'dinner' },
    { id: 'd3', group: 'dinner' },
  ];
  const out = L.groupProposals(list);
  assert.deepEqual(out.map(e => e.type), ['single', 'set', 'single']);
  assert.equal(out[1].group, 'dinner');
  assert.deepEqual(out[1].candidates.map(p => p.id), ['d1', 'd2', 'd3']);
  assert.equal(out[2].proposal.id, 'x');
});

test('groupProposals degrades a one-member group to a single card', () => {
  // One candidate is not a choice, so it must not render as a chooser.
  const out = L.groupProposals([{ id: 'only', group: 'lunch' }]);
  assert.deepEqual(out, [{ type: 'single', proposal: { id: 'only', group: 'lunch' } }]);
});

test('groupProposals keeps distinct groups apart and handles an empty list', () => {
  const out = L.groupProposals([
    { id: 'l1', group: 'lunch' }, { id: 'd1', group: 'dinner' },
    { id: 'l2', group: 'lunch' }, { id: 'd2', group: 'dinner' },
  ]);
  assert.deepEqual(out.map(e => e.group), ['lunch', 'dinner']);
  assert.deepEqual(out[0].candidates.map(p => p.id), ['l1', 'l2']);
  assert.deepEqual(L.groupProposals([]), []);
});

// ---------- assistant: linkifySegments ----------

test('linkifySegments returns one text segment when there is no URL', () => {
  assert.deepEqual(L.linkifySegments('Just prose, no links.'), [{ text: 'Just prose, no links.' }]);
  assert.deepEqual(L.linkifySegments(''), [{ text: '' }]);
});

test('linkifySegments splits text around a URL into exactly three segments', () => {
  const out = L.linkifySegments('Book at https://example.com/a?b=1 before noon');
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { text: 'Book at ' });
  assert.deepEqual(out[1], { href: 'https://example.com/a?b=1' });
  assert.deepEqual(out[2], { text: ' before noon' });
});

test('linkifySegments handles http, several URLs, and trailing sentence punctuation', () => {
  const out = L.linkifySegments('One http://a.example and two https://b.example/x.');
  assert.deepEqual(out.map(s => s.href).filter(Boolean), ['http://a.example', 'https://b.example/x']);
  assert.equal(out[out.length - 1].text, '.');
});

test('linkifySegments returns data only, never markup', () => {
  // B renders and escapes; anything HTML-shaped here would be an injection bug.
  const out = L.linkifySegments('<b>hi</b> https://x.example/<script>');
  for (const seg of out) {
    if (seg.href) assert.doesNotMatch(seg.href, /[<>]/);
  }
  assert.equal(out.map(s => s.text || s.href).join('').startsWith('<b>hi</b>'), true);
});

// ---------- assistant: buildPlanRequest ----------

const planPrefs = over => ({
  date: '2026-12-31',
  activities: 3,
  drinks: 0,
  meals: { breakfast: true, lunch: true, dinner: true },
  styles: { activities: [], drinks: [], meals: [] },
  wakeTime: '08:00',
  returnTime: '22:00',
  repeatOk: false,
  budget: 2,
  note: '',
  ...over,
});
const emptyTrip = () => tripWith([]);
// A skipped slot type is now NAMED in the exclusion sentence, so "the word is
// absent" is no longer the right check for "not asked for". These helpers split
// the two: what the traveller asked for vs what they ruled out.
const exclusionLine = out => out.split('\n').find(l => /^(Only plan |Do not suggest )/.test(l)) || '';
const askedFor = out => out.split('\n').filter(l => !/^(Only plan |Do not suggest )/.test(l)).join('\n');

test('buildPlanRequest defaults ask for 2-3 activities and all three meals', () => {
  const out = L.buildPlanRequest(planPrefs(), emptyTrip());
  assert.ok(out.includes('2-3 activities'), out);
  assert.ok(out.includes('breakfast'));
  assert.ok(out.includes('lunch'));
  assert.ok(out.includes('dinner'));
  assert.ok(out.includes('2026-12-31'));
});

test('buildPlanRequest activity count follows the top of the selected range, 0 skips activities', () => {
  assert.ok(L.buildPlanRequest(planPrefs({ activities: 2 }), emptyTrip()).includes('1-2 activities'));
  assert.ok(L.buildPlanRequest(planPrefs({ activities: 4 }), emptyTrip()).includes('3-4 activities'));
  const none = L.buildPlanRequest(planPrefs({ activities: 0 }), emptyTrip());
  assert.doesNotMatch(askedFor(none), /activities/);
});

test('buildPlanRequest turning off one meal removes only that word', () => {
  const out = L.buildPlanRequest(planPrefs({ meals: { breakfast: false, lunch: true, dinner: true } }), emptyTrip());
  assert.doesNotMatch(askedFor(out), /breakfast/);
  assert.ok(out.includes('lunch'));
  assert.ok(out.includes('dinner'));
  const dinnerOnly = L.buildPlanRequest(planPrefs({ meals: { breakfast: false, lunch: false, dinner: true } }), emptyTrip());
  assert.ok(dinnerOnly.includes('dinner'));
  assert.doesNotMatch(askedFor(dinnerOnly), /lunch/);
});

test('buildPlanRequest with no meals at all asks for no meal options', () => {
  const out = L.buildPlanRequest(planPrefs({ meals: { breakfast: false, lunch: false, dinner: false } }), emptyTrip());
  assert.doesNotMatch(askedFor(out), /breakfast|lunch|dinner/);
  assert.doesNotMatch(out, /options/);
});

test('buildPlanRequest joins two style chips of one type with " or "', () => {
  const out = L.buildPlanRequest(planPrefs({ drinks: 2, styles: { activities: [], drinks: ['rooftop', 'classy'], meals: [] } }), emptyTrip());
  assert.ok(out.includes('rooftop or classy drinks'), out);
});

test('buildPlanRequest carries activity and meal styles too', () => {
  const out = L.buildPlanRequest(planPrefs({ styles: { activities: ['museums', 'walks'], drinks: [], meals: ['street food', 'local'] } }), emptyTrip());
  assert.ok(out.includes('museums or walks'));
  assert.ok(out.includes('street food or local'));
});

test('buildPlanRequest states the wake and return times in 12-hour format', () => {
  const out = L.buildPlanRequest(planPrefs(), emptyTrip());
  assert.ok(out.includes('8:00 AM'), out);
  assert.ok(out.includes('10:00 PM'), out);
  const late = L.buildPlanRequest(planPrefs({ wakeTime: '11:30', returnTime: '00:30' }), emptyTrip());
  assert.ok(late.includes('11:30 AM'), late);
  assert.ok(late.includes('12:30 AM'), late);
  const noon = L.buildPlanRequest(planPrefs({ wakeTime: '12:00', returnTime: '13:05' }), emptyTrip());
  assert.ok(noon.includes('12:00 PM'), noon);
  assert.ok(noon.includes('1:05 PM'), noon);
});

test('buildPlanRequest maps each budget level to exactly one price word, used once', () => {
  const words = { 1: 'budget-friendly', 2: 'mid-range', 3: 'upscale', 4: 'splurge-worthy' };
  for (const level of [1, 2, 3, 4]) {
    const out = L.buildPlanRequest(planPrefs({ budget: Number(level) }), emptyTrip());
    const mine = words[level];
    assert.equal(out.split(mine).length - 1, 1, `${mine} should appear exactly once`);
    for (const [other, word] of Object.entries(words)) {
      if (Number(other) !== level) assert.doesNotMatch(out, new RegExp(word));
    }
  }
});

test('buildPlanRequest lists existing activities as places not to repeat', () => {
  const trip = tripWith([
    { id: 'a', type: 'activity', title: 'Senso-ji', startDate: '2026-12-30' },
    { id: 'b', type: 'activity', title: 'Dinner: Narisawa', startDate: '2026-12-30' },
    { id: 'c', type: 'stay', title: 'Park Hotel', startDate: '2026-12-29', endDate: '2027-01-03' },
    { id: 'd', type: 'activity', title: 'Cancelled thing', startDate: '2026-12-30', status: 'cancelled' },
  ]);
  const out = L.buildPlanRequest(planPrefs(), trip);
  assert.match(out, /Do not repeat/);
  assert.ok(out.includes('Senso-ji'));
  assert.ok(out.includes('Dinner: Narisawa'));
  assert.doesNotMatch(out, /Park Hotel/);
  assert.doesNotMatch(out, /Cancelled thing/);
});

test('buildPlanRequest emits no dangling repeat sentence when there is nothing to avoid', () => {
  assert.doesNotMatch(L.buildPlanRequest(planPrefs(), emptyTrip()), /repeat/i);
  const trip = tripWith([{ id: 'a', type: 'activity', title: 'Senso-ji', startDate: '2026-12-30' }]);
  assert.doesNotMatch(L.buildPlanRequest(planPrefs({ repeatOk: true }), trip), /repeat/i);
});

test('buildPlanRequest appends a non-empty note verbatim as the last line', () => {
  const out = L.buildPlanRequest(planPrefs({ note: 'My partner is vegetarian.' }), emptyTrip());
  const lines = out.split('\n');
  assert.equal(lines[lines.length - 1], 'Also: My partner is vegetarian.');
  assert.doesNotMatch(L.buildPlanRequest(planPrefs({ note: '   ' }), emptyTrip()), /Also:/);
  assert.doesNotMatch(L.buildPlanRequest(planPrefs(), emptyTrip()), /Also:/);
});

test('buildPlanRequest caps the request at 900 characters and keeps the note', () => {
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ id: 'a' + i, type: 'activity', title: `A very long existing activity title number ${i}`, startDate: '2026-12-30' });
  const out = L.buildPlanRequest(planPrefs({ note: 'Keep it walkable.' }), tripWith(items));
  assert.ok(out.length <= 900, `length was ${out.length}`);
  assert.ok(out.includes('Also: Keep it walkable.'), out);
  assert.ok(out.includes('2-3 activities'));
});

test('buildPlanRequest asks for 2-3 options for every active meal and drinks slot', () => {
  const out = L.buildPlanRequest(planPrefs({ drinks: 3 }), emptyTrip());
  const mealLine = out.split('\n').find(l => l.includes('breakfast'));
  const drinksLine = out.split('\n').find(l => l.includes('drinks'));
  assert.ok(mealLine.includes('2-3 options'), mealLine);
  assert.ok(drinksLine.includes('2-3 options'), drinksLine);
  // drinks off means no drinks request line, only the exclusion
  assert.doesNotMatch(askedFor(L.buildPlanRequest(planPrefs({ drinks: 0 }), emptyTrip())), /drinks/);
});

// ---------- assistant: buildPlanRequest exclusions ----------
// The owner picked breakfast only, activities and drinks off, and got a full
// day back: activities, lunch and dinner included. The request never said what
// NOT to plan, and the model read that silence as room to fill.

test('buildPlanRequest names every skipped slot type and nothing else', () => {
  const cases = [
    [{ activities: 0 }, 'Only plan breakfast, lunch and dinner. Do not suggest activities or drinks.'],
    [{ drinks: 2, meals: { breakfast: true, lunch: true, dinner: true } }, ''],
    [{ drinks: 0 }, 'Only plan activities, breakfast, lunch and dinner. Do not suggest drinks.'],
    [{ drinks: 2, meals: { breakfast: false, lunch: false, dinner: true } }, 'Only plan activities, dinner and drinks. Do not suggest breakfast or lunch.'],
    [{ activities: 0, drinks: 0, meals: { breakfast: false, lunch: true, dinner: false } }, 'Only plan lunch. Do not suggest activities, breakfast, dinner or drinks.'],
    [{ activities: 0, drinks: 2, meals: { breakfast: false, lunch: false, dinner: false } }, 'Only plan drinks. Do not suggest activities, breakfast, lunch or dinner.'],
    [{ activities: 0, drinks: 0, meals: { breakfast: false, lunch: false, dinner: false } }, 'Do not suggest activities, breakfast, lunch, dinner or drinks.'],
  ];
  for (const [over, expected] of cases) {
    assert.equal(exclusionLine(L.buildPlanRequest(planPrefs(over), emptyTrip())), expected, JSON.stringify(over));
  }
});

test('buildPlanRequest says nothing about exclusions when every slot is on', () => {
  const out = L.buildPlanRequest(planPrefs({ drinks: 3 }), emptyTrip());
  assert.doesNotMatch(out, /Do not suggest/);
  assert.doesNotMatch(out, /Only plan/);
});

// The exact prefs from the production report: activities skip, drinks skip,
// breakfast only, out 06:30, back 20:00, splurge.
test('buildPlanRequest states breakfast as the only thing to plan for the reported prefs', () => {
  const out = L.buildPlanRequest(planPrefs({
    activities: 0, drinks: 0, budget: 4, wakeTime: '06:30', returnTime: '20:00',
    meals: { breakfast: true, lunch: false, dinner: false },
  }), emptyTrip());
  assert.equal(out, [
    'Plan my day for 2026-12-31.',
    'I am ready to head out at 6:30 AM and want to be back at my hotel by 8:00 PM.',
    'Plan breakfast, and give me 2-3 options for each one.',
    'Only plan breakfast. Do not suggest activities, lunch, dinner or drinks.',
    'Keep the whole day splurge-worthy.',
  ].join('\n'));
});

test('buildPlanRequest stays under 900 chars with the longest exclusion plus a full note', () => {
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ id: 'a' + i, type: 'activity', title: `A very long existing activity title number ${i}`, startDate: '2026-12-30' });
  const out = L.buildPlanRequest(planPrefs({
    activities: 0, drinks: 0, meals: { breakfast: false, lunch: false, dinner: true },
    note: 'x'.repeat(300),
  }), tripWith(items));
  assert.ok(out.length <= 900, `length was ${out.length}`);
  assert.ok(out.includes('Only plan dinner. Do not suggest activities, breakfast, lunch or drinks.'), out);
  assert.ok(out.includes(`Also: ${'x'.repeat(300)}`), out);
});

test('buildPlanRequest never emits an em dash', () => {
  const out = L.buildPlanRequest(planPrefs({
    drinks: 3, activities: 4, budget: 4,
    styles: { activities: ['art'], drinks: ['rooftop', 'classy'], meals: ['local'] },
    note: 'nothing fancy',
  }), tripWith([{ id: 'a', type: 'activity', title: 'Senso-ji', startDate: '2026-12-30' }]));
  assert.doesNotMatch(out, /—/);
});

// ---------- assistant: Google Places rating lookups ----------
// Every cache miss is a BILLED lookup, so these tests exist to pin the money
// rules: never ask twice for the same venue, never exceed the server's cap,
// never re-ask for a permanent no_match, and always re-ask after a transient
// failure.

test('placeCacheKey folds case and whitespace so one venue is one lookup', () => {
  assert.equal(L.placeCacheKey('  Ichiran   Ramen  Shibuya '), 'ichiran ramen shibuya');
  assert.equal(L.placeCacheKey('Ichiran Ramen Shibuya'), L.placeCacheKey('ichiran ramen  SHIBUYA'));
  assert.equal(L.placeCacheKey('   '), '');
  assert.equal(L.placeCacheKey(null), '');
});

test('normalizePlaceQuery clamps to the 200 chars the server accepts', () => {
  const q = L.normalizePlaceQuery('x'.repeat(250));
  assert.equal(q.length, 200);
});

// itemMapsQuery decides which rows get a Google Maps section at all, so it is
// also the thing that decides which rows can BILL a lookup. Both halves matter:
// every place a traveller walks into must qualify, and nothing that is not a
// place may.
test('itemMapsQuery prefers the item own mapsQuery over anything derived', () => {
  assert.equal(
    L.itemMapsQuery({ type: 'activity', title: 'Dinner: Narisawa', location: 'Tokyo', mapsQuery: 'Narisawa Minato Tokyo' }),
    'Narisawa Minato Tokyo');
});

test('itemMapsQuery derives a query for every accommodation and attraction', () => {
  // a hotel, a hostel, a ryokan, a villa: all `stay`, all places you can visit,
  // none of them tagged by hand
  assert.equal(L.itemMapsQuery({ type: 'stay', title: 'Hotel Okura', location: 'Tokyo' }), 'Hotel Okura Tokyo');
  assert.equal(L.itemMapsQuery({ type: 'stay', title: 'Hoshinoya Kyoto', location: 'Kyoto' }), 'Hoshinoya Kyoto');
  assert.equal(L.itemMapsQuery({ type: 'activity', title: 'Acropolis Museum', location: 'Athens' }), 'Acropolis Museum Athens');
});

test('itemMapsQuery strips the slot prefix, which is a label and not a venue', () => {
  assert.equal(L.itemMapsQuery({ type: 'activity', title: 'Dinner: Fiskfelagid', location: 'Reykjavik' }), 'Fiskfelagid Reykjavik');
  assert.equal(L.itemMapsQuery({ type: 'activity', title: 'Cancelled: Blue Lagoon', location: 'Grindavik', status: 'cancelled' }), 'Blue Lagoon Grindavik');
});

test('itemMapsQuery derives nothing for the things that are not a place', () => {
  // a leg goes BETWEEN places, a taxi hop is not a destination, and a note is
  // not anywhere at all: "Return to hotel Lisbon" is the exact query that sends
  // a traveller to the wrong pin
  assert.equal(L.itemMapsQuery({ type: 'flight', title: 'BOS to KEF', location: 'Boston' }), '');
  assert.equal(L.itemMapsQuery({ type: 'transport', title: 'Reykjavik to Akureyri' }), '');
  assert.equal(L.itemMapsQuery({ type: 'local', title: 'Return to hotel', location: 'Lisbon' }), '');
  assert.equal(L.itemMapsQuery({ type: 'note', title: 'About this trip' }), '');
  assert.equal(L.itemMapsQuery({ type: 'activity', title: '', location: 'Tokyo' }), '');
  assert.equal(L.itemMapsQuery(null), '');
});

test('itemMapsQuery does not repeat a location the title already names', () => {
  assert.equal(L.itemMapsQuery({ type: 'activity', title: 'Godafoss and Akureyri', location: 'Akureyri' }), 'Godafoss and Akureyri');
});

test('displayTitle drops the status prefix ONLY where a badge now says it', () => {
  assert.equal(L.displayTitle({ title: 'Cancelled: Fado night', status: 'cancelled' }), 'Fado night');
  // not cancelled: the words are the traveller's own title, so they stay
  assert.equal(L.displayTitle({ title: 'Cancelled: Fado night', status: 'to-book' }), 'Cancelled: Fado night');
  // a title that is nothing BUT the prefix keeps its text rather than vanishing
  assert.equal(L.displayTitle({ title: 'Cancelled', status: 'cancelled' }), 'Cancelled');
  assert.equal(L.displayTitle({ title: 'Cancelled:', status: 'cancelled' }), 'Cancelled:');
});

test('planPlacesLookup drops duplicates within one render so a card bills once', () => {
  const { misses, batches } = L.planPlacesLookup(
    ['Narisawa Tokyo', 'narisawa  tokyo', 'Den Tokyo', '', null], new Set());
  assert.deepEqual(misses.map(m => m.key), ['narisawa tokyo', 'den tokyo']);
  assert.equal(batches.length, 1);
  // the wire form keeps the traveller-facing casing, not the lowercased key
  assert.equal(misses[0].query, 'Narisawa Tokyo');
});

test('planPlacesLookup skips anything already cached or in flight', () => {
  const known = new Set(['narisawa tokyo']);
  const { misses } = L.planPlacesLookup(['Narisawa Tokyo', 'Den Tokyo'], known);
  assert.deepEqual(misses.map(m => m.key), ['den tokyo']);
  // a no_match tombstone counts as known, so a permanent miss is never retried
  assert.deepEqual(L.planPlacesLookup(['Den Tokyo'], new Map([['den tokyo', { status: 'no_match' }]])).misses, []);
});

test('planPlacesLookup splits past 12 because the server drops the overflow', () => {
  const qs = Array.from({ length: 27 }, (_, i) => 'Venue ' + i);
  const { misses, batches } = L.planPlacesLookup(qs, new Set());
  assert.equal(misses.length, 27);
  assert.deepEqual(batches.map(b => b.length), [12, 12, 3]);
});

test('placesCacheUpdates caches ok and tombstones no_match', () => {
  const out = L.placesCacheUpdates([
    { query: 'Narisawa Tokyo', status: 'ok', name: 'Narisawa', rating: 4.35, userRatingCount: 1204, mapsUri: 'https://maps.google.com/?cid=1' },
    { query: 'somewhere nice', status: 'no_match', reason: 'generic_query' },
  ]);
  assert.deepEqual(out[0], {
    key: 'narisawa tokyo',
    entry: { status: 'ok', name: 'Narisawa', rating: 4.4, userRatingCount: 1204, mapsUri: 'https://maps.google.com/?cid=1' },
  });
  // the tombstone keeps the reason: "generic_query" is how the card knows it can
  // only offer a search, and it costs nothing to learn (the server never bills it)
  assert.deepEqual(out[1], { key: 'somewhere nice', entry: { status: 'no_match', reason: 'generic_query' } });
});

test('placesCacheUpdates never caches unavailable, so a later card can retry', () => {
  const results = [{ query: 'Den Tokyo', status: 'unavailable', reason: 'quota' }];
  assert.deepEqual(L.placesCacheUpdates(results), []);
  // and with nothing cached, the same query is planned again
  assert.equal(L.planPlacesLookup(['Den Tokyo'], new Map()).misses.length, 1);
});

// ---------- assistant: the Maps link on a proposal card ----------
// The owner reported "Verify on Google Maps" opening the wrong place. The cause
// was the query ("Roppongi sushi restaurants" cannot resolve to a venue), so the
// link must prefer the place the lookup actually resolved, and must stop saying
// "Verify" when the server already told us the query names no place.

const SEARCH_NARISAWA = 'https://www.google.com/maps/search/?api=1&query=Narisawa%20Tokyo';

test('assistMapsLink uses the resolved place URI once the lookup has answered', () => {
  const entry = { status: 'ok', name: 'Narisawa', rating: 4.4, userRatingCount: 1204, mapsUri: 'https://maps.google.com/?cid=17' };
  assert.deepEqual(L.assistMapsLink('Narisawa Tokyo', entry), {
    href: 'https://maps.google.com/?cid=17',
    label: '📍 Verify on Google Maps',
    resolved: true,
  });
});

test('assistMapsLink keeps the search URL while the lookup is pending or unavailable', () => {
  // undefined = not asked yet, in flight, quota-limited, offline, or 503 for the
  // whole session. Every one of those must still give the traveller a link.
  for (const entry of [undefined, null]) {
    assert.deepEqual(L.assistMapsLink('Narisawa Tokyo', entry), {
      href: SEARCH_NARISAWA, label: '📍 Verify on Google Maps', resolved: false,
    });
  }
});

test('assistMapsLink keeps "Verify" for a no_match that is not a generic query', () => {
  // low_confidence / not_found / unrated: the query does name a place, we just
  // could not price it, so promising a specific place is still honest.
  for (const reason of ['not_found', 'low_confidence', 'unrated']) {
    const link = L.assistMapsLink('Narisawa Tokyo', { status: 'no_match', reason });
    assert.equal(link.href, SEARCH_NARISAWA);
    assert.equal(link.label, '📍 Verify on Google Maps');
  }
});

test('assistMapsLink relabels a generic query, because a search is all it can do', () => {
  const link = L.assistMapsLink('Roppongi sushi restaurants', { status: 'no_match', reason: 'generic_query' });
  assert.equal(link.href, 'https://www.google.com/maps/search/?api=1&query=Roppongi%20sushi%20restaurants');
  assert.equal(link.label, '📍 Search Google Maps');
  assert.equal(link.resolved, false);
});

test('assistMapsLink falls back to search when the resolved URI is missing or unusable', () => {
  // mapsUri arrives over the network; an unusable one must never reach an href.
  for (const mapsUri of ['', undefined, 'javascript:alert(1)', 'ftp://example.com/x', '/relative']) {
    const link = L.assistMapsLink('Narisawa Tokyo', { status: 'ok', rating: 4.4, mapsUri });
    assert.equal(link.href, SEARCH_NARISAWA, `bad mapsUri leaked: ${mapsUri}`);
    assert.equal(link.label, '📍 Verify on Google Maps');
    assert.equal(link.resolved, false);
  }
});

test('assistMapsLink returns null when the item carries no place at all', () => {
  // A travel leg or a note gets no link rather than a link to nowhere.
  assert.equal(L.assistMapsLink('', { status: 'ok', mapsUri: 'https://maps.google.com/?cid=1' }), null);
  assert.equal(L.assistMapsLink('   ', undefined), null);
  assert.equal(L.assistMapsLink(null, undefined), null);
});

test('assistMapsLink escapes the query into the search URL', () => {
  const link = L.assistMapsLink('Bar & Grill "Tokyo" #1', undefined);
  assert.equal(link.href, 'https://www.google.com/maps/search/?api=1&query=Bar%20%26%20Grill%20%22Tokyo%22%20%231');
});

test('placesCacheUpdates rejects a rating with no usable maps link', () => {
  // the attribution link is mandatory, so a rating we cannot attribute is dropped
  assert.deepEqual(L.placesCacheUpdates([
    { query: 'A', status: 'ok', rating: 4.1, userRatingCount: 5, mapsUri: 'javascript:alert(1)' },
    { query: 'B', status: 'ok', rating: 4.1, userRatingCount: 5 },
    { query: 'C', status: 'ok', rating: 'nope', userRatingCount: 5, mapsUri: 'https://maps.google.com/?cid=2' },
  ]), []);
});

// ---------- assistant markdown ----------
// parseMarkdown returns a DATA TREE, never HTML: the app builds elements with
// createElement and fills leaves with textContent, so escaping happens exactly
// once, at the DOM boundary. These tests therefore assert on the tree, and a
// text node holding a raw '<' or '&' is the PROOF that nothing was escaped
// early (which is what would double-escape into &amp;amp;).

// Visible text of an inline run, the way the DOM would read it back.
function inlineText(nodes) {
  return (nodes || []).map(n => {
    if (n.type === 'text') return n.text;
    if (n.type === 'br') return '\n';
    if (n.type === 'code') return n.text;
    return inlineText(n.children);
  }).join('');
}
function blockText(block) {
  if (block.type === 'code') return block.text;
  if (block.type === 'list') return block.items.map(i => inlineText(i.inline)).join('\n');
  return inlineText(block.inline);
}
function allInline(nodes, out = []) {
  for (const n of nodes || []) { out.push(n); if (n.children) allInline(n.children, out); }
  return out;
}
function allLinks(blocks) {
  const links = [];
  for (const b of blocks) {
    if (b.type === 'list') { for (const it of b.items) links.push(...allInline(it.inline).filter(n => n.type === 'link')); }
    else if (b.inline) links.push(...allInline(b.inline).filter(n => n.type === 'link'));
  }
  return links;
}

test('parseMarkdown renders every heading level with its inline formatting', () => {
  const blocks = L.parseMarkdown('# Day 1\n\n###### Notes\n\n## **Tokyo** food');
  assert.deepEqual(blocks.map(b => [b.type, b.level, blockText(b)]), [
    ['heading', 1, 'Day 1'],
    ['heading', 6, 'Notes'],
    ['heading', 2, 'Tokyo food'],
  ]);
  assert.equal(blocks[2].inline[0].type, 'strong');
});

test('parseMarkdown splits paragraphs on blank lines and keeps single newlines as breaks', () => {
  const blocks = L.parseMarkdown('One line\nsame paragraph\n\nSecond paragraph');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[0].inline.map(n => n.type), ['text', 'br', 'text']);
  assert.equal(blockText(blocks[1]), 'Second paragraph');
});

test('parseMarkdown handles both bold and both italic markers', () => {
  const inline = L.parseMarkdownInline('**a** __b__ *c* _d_');
  assert.deepEqual(inline.filter(n => n.type !== 'text').map(n => [n.type, inlineText(n.children)]), [
    ['strong', 'a'], ['strong', 'b'], ['em', 'c'], ['em', 'd'],
  ]);
});

test('parseMarkdown keeps snake_case intact rather than reading it as emphasis', () => {
  const inline = L.parseMarkdownInline('use trip_start_date here');
  assert.deepEqual(inline, [{ type: 'text', text: 'use trip_start_date here' }]);
});

test('parseMarkdown renders inline code and leaves its contents literal', () => {
  const inline = L.parseMarkdownInline('run `npm **test**` now');
  assert.deepEqual(inline[1], { type: 'code', text: 'npm **test**' });
});

test('parseMarkdown renders unordered lists for -, * and + markers', () => {
  for (const marker of ['-', '*', '+']) {
    const blocks = L.parseMarkdown(`${marker} Sushi\n${marker} Ramen`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].ordered, false);
    assert.deepEqual(blocks[0].items.map(i => inlineText(i.inline)), ['Sushi', 'Ramen']);
  }
});

test('parseMarkdown renders ordered lists and remembers where they start', () => {
  const blocks = L.parseMarkdown('3. Third\n4. Fourth');
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].start, 3);
  assert.deepEqual(blocks[0].items.map(i => inlineText(i.inline)), ['Third', 'Fourth']);
});

test('parseMarkdown starts a new list when the marker kind changes', () => {
  const blocks = L.parseMarkdown('- one\n1. two');
  assert.deepEqual(blocks.map(b => b.ordered), [false, true]);
});

test('parseMarkdown renders blockquotes, joining consecutive quoted lines', () => {
  const blocks = L.parseMarkdown('> Book early.\n> Seats sell out.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'quote');
  assert.equal(blockText(blocks[0]), 'Book early.\nSeats sell out.');
});

test('parseMarkdown renders fenced code blocks and keeps the language tag', () => {
  const blocks = L.parseMarkdown('Try:\n\n```bash\nnpm test\n```\n\nDone');
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'code', 'paragraph']);
  assert.equal(blocks[1].lang, 'bash');
  assert.equal(blocks[1].text, 'npm test');
});

test('parseMarkdown turns [text](https url) and bare URLs into links', () => {
  const blocks = L.parseMarkdown('See [the menu](https://bills.example/menu) or https://tokyo.example/a.');
  const links = allLinks(blocks);
  assert.deepEqual(links.map(l => [l.href, inlineText(l.children)]), [
    ['https://bills.example/menu', 'the menu'],
    ['https://tokyo.example/a', 'https://tokyo.example/a'],
  ]);
  // the sentence's full stop stays prose, exactly as linkifySegments decides it
  assert.equal(blockText(blocks[0]).endsWith('.'), true);
});

test('parseMarkdown renders bold and links inside list items, which is what the assistant actually emits', () => {
  const blocks = L.parseMarkdown('* **Option 1:** Bills Omotesando\n* See [menu](https://bills.example)');
  const [first, second] = blocks[0].items;
  assert.equal(first.inline[0].type, 'strong');
  assert.equal(inlineText(first.inline), 'Option 1: Bills Omotesando');
  const link = allInline(second.inline).find(n => n.type === 'link');
  assert.deepEqual([link.href, inlineText(link.children)], ['https://bills.example', 'menu']);
});

// ---------- adversarial: the reply is untrusted text ----------

test('parseMarkdown never passes raw HTML through: a script payload stays visible text', () => {
  const blocks = L.parseMarkdown('Look: <img src=x onerror=alert(1)> and <script>alert(2)</script>');
  assert.equal(blocks.length, 1);
  assert.equal(blockText(blocks[0]), 'Look: <img src=x onerror=alert(1)> and <script>alert(2)</script>');
  assert.deepEqual(blocks[0].inline.map(n => n.type), ['text']);
});

test('parseMarkdown refuses javascript:, data: and vbscript: link targets', () => {
  for (const src of [
    '[click](javascript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '[x](JaVaScRiPt:alert(1))',
  ]) {
    const blocks = L.parseMarkdown(src);
    assert.deepEqual(allLinks(blocks), [], `unsafe target became a link: ${src}`);
    assert.equal(blockText(blocks[0]).includes('['), true, `payload vanished instead of showing: ${src}`);
  }
});

test('parseMarkdown refuses protocol-relative and relative link targets', () => {
  for (const src of ['[x](//evil.example/pwn)', '[x](/settings)', '[x](evil.example)', '[x](ftp://h/f)']) {
    assert.deepEqual(allLinks(L.parseMarkdown(src)), [], `target became a link: ${src}`);
  }
  // and the traveller still sees what the model wrote
  assert.equal(blockText(L.parseMarkdown('[x](//evil.example/pwn)')[0]), '[x](//evil.example/pwn)');
});

test('a fenced block whose contents look like Markdown renders literally', () => {
  const blocks = L.parseMarkdown('```\n# not a heading\n* not a list\n**not bold** [x](https://a.example)\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].text, '# not a heading\n* not a list\n**not bold** [x](https://a.example)');
  assert.deepEqual(allLinks(blocks), []);
});

test('unbalanced markers degrade to plain text instead of throwing', () => {
  for (const src of ['**bold with no close', 'a stray * star', '_ dangling', '`unclosed code', '[link](https://a.example', 'a ** b ** c']) {
    const blocks = L.parseMarkdown(src);
    assert.equal(blockText(blocks[0]), src, `mangled: ${src}`);
  }
});

test('special characters survive unescaped exactly once, so the DOM escape is the only one', () => {
  // Anything pre-escaped here would reach the screen as &amp;amp;.
  const blocks = L.parseMarkdown('[Bar & "Grill" <b>](https://a.example/?x=1&y=2) and `a < b && c > d`');
  const link = allLinks(blocks)[0];
  assert.equal(inlineText(link.children), 'Bar & "Grill" <b>');
  assert.equal(link.href, 'https://a.example/?x=1&y=2');
  const code = allInline(blocks[0].inline).find(n => n.type === 'code');
  assert.equal(code.text, 'a < b && c > d');
});

test('a reply carrying a tripActions fence renders only the prose', () => {
  const raw = 'Here is the plan:\n\n- **Day 1:** Shibuya\n\n```json\n{"tripActions":[{"op":"add","item":{"type":"activity","title":"Shibuya Sky","startDate":"2027-01-16"}}]}\n```\n\nEnjoy!';
  const { actions, cleanedText } = L.extractTripActions(raw);
  assert.equal(actions.length, 1);
  const blocks = L.parseMarkdown(cleanedText);
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'list', 'paragraph']);
  assert.equal(blocks.some(b => b.type === 'code'), false);
  assert.equal(blocks.map(blockText).join(' ').includes('tripActions'), false);
});

test('parseMarkdown tolerates empty and non-string input', () => {
  assert.deepEqual(L.parseMarkdown(''), []);
  assert.deepEqual(L.parseMarkdown(null), []);
  assert.deepEqual(L.parseMarkdown('   \n\n  '), []);
});

test('parseMarkdown accepts a link title and still refuses an unsafe target that carries one', () => {
  const ok = allLinks(L.parseMarkdown('[menu](https://bills.example "Bills Omotesando")'));
  assert.deepEqual(ok.map(l => [l.href, inlineText(l.children)]), [['https://bills.example', 'menu']]);
  assert.deepEqual(allLinks(L.parseMarkdown('[x](javascript:alert(1) "hi")')), []);
});

// ---------- timeline hierarchy (stay -> day -> activity) ----------
const tlItem = (o) => ({ id: o.id, type: o.type, title: o.title || o.id, status: o.status || 'to-book',
  startDate: o.startDate || '', endDate: o.endDate || '', startTime: o.startTime || '', endTime: '' });
const tlGroups = (items) => L.timelineGroups(L.sortedItems({ items }));
const spineIds = (nodes) => nodes.map(n => n.item.id);

test('the timeline spine keeps only flights, stays and between-cities transport', () => {
  const nodes = tlGroups([
    tlItem({ id: 'fly', type: 'flight', startDate: '2027-03-01' }),
    tlItem({ id: 'hotel', type: 'stay', startDate: '2027-03-01', endDate: '2027-03-04' }),
    tlItem({ id: 'museum', type: 'activity', startDate: '2027-03-02', startTime: '10:00' }),
    tlItem({ id: 'taxi', type: 'local', startDate: '2027-03-02', startTime: '09:00' }),
    tlItem({ id: 'memo', type: 'note', startDate: '2027-03-03' }),
    tlItem({ id: 'train', type: 'transport', startDate: '2027-03-04', startTime: '12:00' }),
  ]);
  assert.deepEqual(spineIds(nodes), ['fly', 'hotel', 'train']);
  const stay = nodes.find(n => n.kind === 'stay');
  assert.equal(stay.count, 3);
  assert.deepEqual(stay.days.map(d => d.date), ['2027-03-02', '2027-03-03']);
  assert.deepEqual(stay.days[0].items.map(i => i.id), ['taxi', 'museum']);
});

test('an item with no covering stay stays on the spine instead of disappearing', () => {
  const nodes = tlGroups([
    tlItem({ id: 'fly', type: 'flight', startDate: '2027-03-01' }),
    tlItem({ id: 'lounge', type: 'activity', startDate: '2027-03-01', startTime: '08:00' }),
    tlItem({ id: 'hotel', type: 'stay', startDate: '2027-03-02', endDate: '2027-03-05' }),
  ]);
  assert.deepEqual(spineIds(nodes).sort(), ['fly', 'hotel', 'lounge']);
  assert.equal(nodes.find(n => n.kind === 'stay').count, 0);
});

test('a changeover day splits at the assumed check-out time the day tiles sort by', () => {
  const items = [
    tlItem({ id: 'a', type: 'stay', title: 'Hotel A', startDate: '2027-03-01', endDate: '2027-03-04' }),
    tlItem({ id: 'b', type: 'stay', title: 'Hotel B', startDate: '2027-03-04', endDate: '2027-03-07' }),
    tlItem({ id: 'breakfast', type: 'activity', title: 'Breakfast: cafe', startDate: '2027-03-04', startTime: '08:00' }),
    tlItem({ id: 'dinner', type: 'activity', title: 'Dinner: izakaya', startDate: '2027-03-04', startTime: '19:00' }),
    tlItem({ id: 'limbo', type: 'activity', title: 'Left luggage', startDate: '2027-03-04', startTime: '13:00' }),
    tlItem({ id: 'untimed', type: 'activity', title: 'Walk', startDate: '2027-03-04' }),
  ];
  const nodes = tlGroups(items);
  const byId = Object.fromEntries(nodes.filter(n => n.kind === 'stay').map(n => [n.item.id, n]));
  assert.deepEqual(byId.a.days[0].items.map(i => i.id), ['breakfast']);
  // once you have checked out, the stay is over: the 13:00 item between the two
  // assumed times belongs to the place you are heading to, not the one you left
  assert.deepEqual(byId.b.days[0].items.map(i => i.id), ['limbo', 'dinner', 'untimed']);
  // the same rule the day tile draws: everything above the check-out row stays
  // with the old hotel, everything below it moves to the new one
  const card = L.dayCards({ items }).find(c => c.date === '2027-03-04');
  const order = card.events.map(e => e.kind === 'item' ? e.item.id : `${e.kind}:${e.item.id}`);
  assert.deepEqual(order, ['breakfast', 'checkout:a', 'limbo', 'checkin:b', 'dinner']);
});

test('a cancelled stay never swallows the activities under it', () => {
  const nodes = tlGroups([
    tlItem({ id: 'hotel', type: 'stay', startDate: '2027-03-01', endDate: '2027-03-04', status: 'cancelled' }),
    tlItem({ id: 'museum', type: 'activity', startDate: '2027-03-02', startTime: '10:00' }),
  ]);
  assert.deepEqual(spineIds(nodes), ['hotel', 'museum']);
});

test('coveringStay prefers the stay you are mid-way through over one ending that day', () => {
  const stays = [
    tlItem({ id: 'long', type: 'stay', startDate: '2027-03-01', endDate: '2027-03-10' }),
    tlItem({ id: 'short', type: 'stay', startDate: '2027-03-01', endDate: '2027-03-05' }),
  ];
  const hit = L.coveringStay(stays, tlItem({ id: 'x', type: 'activity', startDate: '2027-03-05', startTime: '09:00' }));
  assert.equal(hit.id, 'long');
  assert.equal(L.coveringStay(stays, tlItem({ id: 'y', type: 'activity', startDate: '2027-03-20' })), null);
  assert.equal(L.coveringStay(stays, tlItem({ id: 'z', type: 'activity', startDate: '' })), null);
});

test('mealKind names the meal for exactly the titles isFoodOrDrink accepts', () => {
  for (const p of L.mealTitlePrefixes()) {
    const title = p + 'somewhere';
    assert.equal(L.isFoodOrDrink(title), true);
    assert.equal(L.mealKind(title), p.replace(/[:\s]+$/, '').toLowerCase());
  }
  for (const title of ['Dinnerware shopping', 'Museum', '', null, '  lunchtime walk']) {
    assert.equal(L.mealKind(title), '', String(title));
    assert.equal(L.isFoodOrDrink(title), L.mealKind(title) !== '');
  }
  assert.equal(L.mealKind('  dinner:Narisawa'), 'dinner');
});

test('isLongDetails only flags text long enough to be worth clamping', () => {
  assert.equal(L.isLongDetails(''), false);
  assert.equal(L.isLongDetails(null), false);
  assert.equal(L.isLongDetails('x'.repeat(180)), false);
  assert.equal(L.isLongDetails('x'.repeat(181)), true);
});

// ---------- example trips ----------
// These run over EVERY template, because the library is also the app's
// regression fixture: a sample that renders a warning, rots into the past or
// loses a mapsQuery is a bug in the app's shop window.

const SAMPLE_TODAY = '2026-07-20';
const samples = L.sampleTripOptions().map(o => ({ opt: o, trip: L.buildSampleTrip(o.id, { today: SAMPLE_TODAY }) }));

// Density is MEASURED rather than eyeballed: for every day of the trip, count
// the things actually scheduled on it. A stay spans days instead of filling
// them, the boilerplate note is not an activity, and a cancelled row is a
// record of something that is NOT happening, so none of the three counts
// towards how busy a day feels.
function dayLoads(trip) {
  const stats = L.tripStats(trip);
  const loads = new Map();
  for (let d = stats.start; d <= stats.end; d = L.addDays(d, 1)) loads.set(d, 0);
  for (const it of trip.items) {
    if (L.isStay(it) || it.type === 'note' || it.status === 'cancelled') continue;
    loads.set(it.startDate, loads.get(it.startDate) + 1);
  }
  return [...loads.values()];
}
const avg = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const emptyDays = xs => xs.filter(x => x === 0).length;

// The declared shape of every template. The library is the app's shop window
// as well as its fixture, so "a broad spread of trip shapes" has to be a thing
// the suite can fail on, not a claim in a comment.
const SAMPLE_SHAPES = {
  iceland: { days: 7, density: 'sparse' },
  portugal: { days: 8, density: 'moderate' },
  morocco: { days: 8, density: 'moderate' },
  greece: { days: 9, density: 'moderate' },
  netherlands: { days: 9, density: 'moderate' },
  italy: { days: 10, density: 'moderate' },
  croatia: { days: 10, density: 'relaxed' },
  peru: { days: 11, density: 'packed' },
  japan: { days: 12, density: 'packed' },
  israel: { days: 12, density: 'moderate' },
  vietnam: { days: 13, density: 'moderate' },
  thailand: { days: 14, density: 'split' },
};

test('every template declares a shape and the library spans 7 to 14 days at every density', () => {
  const ids = samples.map(s => s.opt.id);
  assert.deepEqual([...ids].sort(), Object.keys(SAMPLE_SHAPES).sort());
  const declared = ids.map(id => SAMPLE_SHAPES[id].density);
  for (const density of ['sparse', 'moderate', 'relaxed', 'packed', 'split']) {
    assert.ok(declared.includes(density), `no template is ${density}`);
  }
  const lengths = new Set(ids.map(id => SAMPLE_SHAPES[id].days));
  assert.ok(lengths.size >= 7, `only ${lengths.size} distinct trip lengths`);
  assert.equal(Math.min(...lengths), 7);
  assert.equal(Math.max(...lengths), 14);
});

test('the example library covers a real spread of destinations', () => {
  assert.ok(samples.length >= 12, `expected at least 12 templates, got ${samples.length}`);
  const ids = samples.map(s => s.opt.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of samples) {
    assert.ok(s.opt.label.trim(), s.opt.id);
    assert.ok(s.opt.place.trim() && !s.opt.place.includes('('), s.opt.id);
    assert.equal(L.matchSampleTrip(s.opt.place), s.opt.id, `the offered name must match its own template: ${s.opt.place}`);
  }
});

test('buildSampleTrip rejects an unknown destination', () => {
  assert.equal(L.buildSampleTrip('atlantis', { today: SAMPLE_TODAY }), null);
  assert.equal(L.buildSampleTrip('', { today: SAMPLE_TODAY }), null);
});

for (const { opt, trip } of samples) {
  const items = trip.items;
  const stays = items.filter(it => L.isStay(it) && it.status !== 'cancelled');

  test(`example ${opt.id}: every item is valid and uniquely identified`, () => {
    for (const it of items) {
      assert.deepEqual(L.validateItem(it), {}, `${opt.id} / ${it.title}`);
    }
    const ids = items.map(it => it.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test(`example ${opt.id}: no uncovered nights, no collisions, no continuity gaps`, () => {
    const end = L.tripStats(trip).end;
    assert.deepEqual(L.coverageGaps(stays, end, L.overnightTransit(items)), []);
    assert.deepEqual(L.transportGaps(trip), []);
    for (let i = 0; i < stays.length; i++) {
      for (let j = i + 1; j < stays.length; j++) {
        const a = stays[i], b = stays[j];
        const from = a.startDate > b.startDate ? a.startDate : b.startDate;
        const to = a.endDate < b.endDate ? a.endDate : b.endDate;
        assert.ok(L.diffDays(from, to) <= 0, `${a.title} overlaps ${b.title}`);
      }
    }
  });

  test(`example ${opt.id}: dates are relative to today and the trip runs 7 to 14 days`, () => {
    const stats = L.tripStats(trip);
    assert.equal(stats.start, L.addDays(SAMPLE_TODAY, L.SAMPLE_START_OFFSET));
    const days = L.diffDays(stats.start, stats.end) + 1;
    assert.ok(days >= 7 && days <= 14, `${opt.id} runs ${days} days`);
    assert.equal(days, SAMPLE_SHAPES[opt.id].days, `${opt.id} does not run the length it declares`);
    for (const it of items) {
      assert.ok(it.startDate > SAMPLE_TODAY, `${it.title} is not in the future`);
    }
    // shifting "today" shifts the whole itinerary: nothing is hardcoded
    const later = L.buildSampleTrip(opt.id, { today: L.addDays(SAMPLE_TODAY, 10) });
    assert.equal(L.tripStats(later).start, L.addDays(stats.start, 10));
  });

  test(`example ${opt.id}: every venue carries a mapsQuery and estimates never touch cost`, () => {
    for (const it of items) {
      if (it.type === 'activity' || it.type === 'stay') {
        assert.ok(it.mapsQuery, `${it.title} names a place with no mapsQuery`);
      }
      if (L.hasEstimate(it)) {
        assert.equal(it.cost, null, `${it.title} carries both an estimate and a cost`);
        assert.ok(/^[A-Z]{3}$/.test(it.estCostCurrency));
      }
      if (it.cost != null) assert.ok(/^[A-Z]{3}$/.test(it.costCurrency), it.title);
    }
  });

  test(`example ${opt.id}: contains all six fixture features`, () => {
    const has = {
      estimate: items.some(it => L.isEstimatedCost(it)),
      foreignCurrency: items.some(it => it.costCurrency && it.costCurrency !== trip.currency),
      longDetails: items.some(it => it.type !== 'note' && L.isLongDetails(it.details)),
      // the boilerplate note is untimed too, so it cannot be what satisfies this
      untimed: items.some(it => !L.isStay(it) && it.type !== 'note' && !it.startTime),
      cancelled: items.some(it => it.status === 'cancelled'),
      localTravel: items.some(it => it.type === 'local'),
    };
    for (const [feature, present] of Object.entries(has)) {
      assert.ok(present, `${opt.id} is missing the ${feature} fixture`);
    }
    assert.ok(items.some(it => it.status === 'booked'), 'nothing is booked');
    assert.ok(items.some(it => it.status === 'to-book'), 'nothing is left to book');
    assert.ok(items.some(it => L.isStay(it) && L.nights(it) > 1), 'no multi-night stay');
    assert.ok(items.some(it => L.isFoodOrDrink(it.title)), 'no meals or drinks');
  });

  test(`example ${opt.id}: the declared density holds day by day`, () => {
    const loads = dayLoads(trip);
    const shape = SAMPLE_SHAPES[opt.id];
    const where = `${opt.id} runs [${loads.join(', ')}]`;
    if (shape.density === 'sparse') {
      // few stops, long distances between them: never a four-item day
      assert.ok(avg(loads) <= 2.2, `${where}, too busy for sparse`);
      assert.ok(Math.max(...loads) <= 3, `${where}, has a packed day`);
    } else if (shape.density === 'moderate') {
      assert.ok(avg(loads) >= 2.2 && avg(loads) <= 3.0, `${where}, not a moderate pace`);
      assert.ok(Math.max(...loads) >= 3, `${where}, never has a full day`);
    } else if (shape.density === 'relaxed') {
      // a rest day is a REAL empty day: nothing scheduled, night still covered
      assert.ok(avg(loads) <= 2.0, `${where}, too busy to be relaxed`);
      assert.ok(emptyDays(loads) >= 2, `${where}, has no rest days`);
    } else if (shape.density === 'packed') {
      assert.ok(avg(loads) >= 3.0, `${where}, not packed`);
      assert.ok(loads.filter(n => n >= 4).length >= 3, `${where}, too few full days`);
      assert.equal(emptyDays(loads), 0, `${where}, a packed trip has no blank days`);
    } else if (shape.density === 'split') {
      const half = Math.ceil(loads.length / 2);
      const front = loads.slice(0, half), back = loads.slice(half);
      assert.ok(avg(front) >= 3.0, `${where}, the first half is not packed`);
      assert.ok(front.some(n => n >= 4), `${where}, the first half has no full day`);
      assert.ok(avg(back) <= 1.5, `${where}, the second half is not relaxed`);
      assert.ok(emptyDays(back) >= 2, `${where}, the second half has no rest days`);
    }
  });

  test(`example ${opt.id}: the intercity leg connects the two stay cities`, () => {
    assert.equal(stays.length, 2, 'each example is a two-city trip');
    const [a, b] = stays;
    assert.notEqual(a.location, b.location);
    const connects = items.some(it => {
      if (it.type !== 'transport' && it.type !== 'flight') return false;
      if (it.startDate < a.endDate || it.startDate > b.startDate) return false;
      const parts = it.title.split(/\s+to\s+/).map(s => L.stripPlaceCode(s));
      return parts[0] === a.location && parts[1] === b.location;
    });
    assert.ok(connects, `no leg reads "${a.location} to ${b.location}"`);
  });

  test(`example ${opt.id}: opens with an inbound flight from another country and ends going home`, () => {
    const flights = items.filter(it => it.type === 'flight');
    const first = flights[0], last = flights[flights.length - 1];
    assert.equal(first.startDate, L.tripStats(trip).start);
    const origin = L.stripPlaceCode(L.parseTravelOrigin(first.title));
    assert.ok(origin && origin !== stays[0].location, `${opt.id} flies in from ${origin}`);
    const home = L.stripPlaceCode(last.title.split(/\s+to\s+/)[1] || '');
    assert.equal(home, origin, 'the last flight goes back where the first one came from');
  });
}

test('the Netherlands example day-trips to Utrecht and Leiden without moving hotel', () => {
  const trip = samples.find(s => s.opt.id === 'netherlands').trip;
  const stays = trip.items.filter(it => L.isStay(it) && it.status !== 'cancelled');
  assert.deepEqual(stays.map(s => s.location), ['Amsterdam', 'Rotterdam']);
  for (const city of ['Utrecht', 'Leiden']) {
    const there = trip.items.filter(it => it.location === city);
    assert.ok(there.length >= 2, `nothing to do in ${city}`);
    assert.ok(there.every(it => it.mapsQuery), `a ${city} venue has no mapsQuery`);
    // out and back by train on ONE day: half an hour each way is not a hotel move
    const legs = trip.items.filter(it => it.type === 'transport' && it.title.includes(city));
    assert.equal(legs.length, 2, `${city} is not an out-and-back rail day trip`);
    assert.equal(new Set([...legs, ...there].map(it => it.startDate)).size, 1, `${city} spills over a day`);
    assert.ok(!stays.some(s => s.location === city), `${city} became a stay`);
  }
});

test('the Israel example draws the local / intercity line with Ramat Gan and Beer Sheva', () => {
  const trip = samples.find(s => s.opt.id === 'israel').trip;
  const stays = trip.items.filter(it => L.isStay(it) && it.status !== 'cancelled');
  assert.deepEqual(stays.map(s => s.location), ['Tel Aviv', 'Jerusalem']);
  // adjacent municipality: a city fare, so `local`
  const ramatGan = trip.items.filter(it => it.title.includes('Ramat Gan') || it.location === 'Ramat Gan');
  assert.ok(ramatGan.some(it => it.type === 'local'), 'Ramat Gan is not reached by a local hop');
  assert.ok(!ramatGan.some(it => it.type === 'transport'), 'Ramat Gan is not an intercity leg');
  // an hour down the line: a booked ticket, so `transport`
  const beerSheva = trip.items.filter(it => it.title.includes('Beer Sheva') || it.location === 'Beer Sheva');
  assert.ok(beerSheva.some(it => it.type === 'transport'), 'Beer Sheva is not reached by an intercity leg');
  assert.ok(!beerSheva.some(it => it.type === 'local'), 'Beer Sheva is treated as a local hop');
  for (const city of ['Ramat Gan', 'Beer Sheva']) {
    assert.ok(!stays.some(s => s.location === city), `${city} became a stay`);
  }
});

// ---------- the trip-name matcher ----------

test('matchSampleTrip is forgiving about case, punctuation, years and extra words', () => {
  const cases = [
    ['Japan', 'japan'], ['japan', 'japan'], ['JAPAN', 'japan'],
    ['Japan 2027', 'japan'], ['Tokyo 2027', 'japan'], ['our week in Kyoto!', 'japan'],
    ['Italy trip', 'italy'], ['Trip to Greece 2028', 'greece'],
    ['Chiang Mai + Bangkok', 'thailand'], ['machu-picchu 2027', 'peru'],
    ['Reykjavik/Akureyri', 'iceland'], ['Hoi An food trip', 'vietnam'],
    ['Marrakech riad week', 'morocco'], ['Split & Hvar sailing', 'croatia'],
    ['porto and lisbon', 'portugal'],
    ['Krabi beach week', 'thailand'],
    ['Amsterdam 2028', 'netherlands'], ['rotterdam long weekend', 'netherlands'],
    ['The Hague + Utrecht', 'netherlands'], ['Leiden university visit', 'netherlands'],
    ['Israel spring trip', 'israel'], ['Tel-Aviv and Jerusalem', 'israel'],
    ['haifa coast drive', 'israel'], ['Ramat Gan 2028', 'israel'], ['beer sheva desert', 'israel'],
  ];
  for (const [name, id] of cases) assert.equal(L.matchSampleTrip(name), id, name);
});

test('matchSampleTrip takes the first destination when a name lists two', () => {
  assert.equal(L.matchSampleTrip('Japan and Thailand 2027'), 'japan');
  assert.equal(L.matchSampleTrip('Thailand and Japan 2027'), 'thailand');
});

test('matchSampleTrip refuses near misses rather than guessing', () => {
  const misses = [
    'Japanese garden weekend', 'Italian cooking class', 'Thai food festival',
    'Vietnamese street food night', 'Moroccan rug shopping', 'Romania road trip',
    'Portland brewery tour', 'Icelandic knitting retreat', 'Grease the wheels',
    'Perusing the museums', 'Splitting the bill', 'Summer 2027', 'Honeymoon',
    // the Netherlands and Israel keywords are deliberately narrow: colloquial
    // and adjectival forms are NOT keywords, so none of these may match
    'Dutch oven cooking class', 'Holland Park picnic', 'Netherworld haunted house',
    'Israeli couscous recipe', 'Jaffa cakes taste test', 'Halifax weekend',
    'Utrechtse Heuvelrug', 'Haguenau day trip',
    '', '   ', null, undefined, '2027',
  ];
  for (const name of misses) assert.equal(L.matchSampleTrip(name), '', String(name));
});

// ---------- regressions: one bad value must not take the app with it ----------

test('isIsoDate rejects a day that does not exist rather than rolling it forward', () => {
  // Date.parse turns 2027-02-30 into Mar 2, so the old shape-only check both
  // accepted the date and then showed a different one.
  assert.equal(L.isIsoDate('2027-02-30'), false);
  assert.equal(L.isIsoDate('2027-04-31'), false);
  assert.equal(L.isIsoDate('2027-02-29'), false);
  assert.equal(L.isIsoDate('2028-02-29'), true); // leap year, a real day
  assert.equal(L.isIsoDate('2027-12-31'), true);
});

test('an impossible date is not counted as a trip date at all', () => {
  const trip = { items: [
    stay('h', 'Rome', '2027-03-01', '2027-03-04', 'booked'),
    flight('f', 'Home', '2027-02-30'),
  ] };
  const st = L.tripStats(trip);
  assert.equal(st.start, '2027-03-01');
  // the "4 booked nights in a 3 night trip" summary came from start being the
  // raw string minimum while every span used the rolled-forward date
  assert.ok(st.bookedNights <= st.totalTripNights);
});

test('a validated item names its impossible date instead of silently shifting it', () => {
  const errs = L.validateItem({ ...flight('f', 'A to B', '2027-02-30'), });
  assert.equal(errs.start, true);
});

test('tripStats caps the rendered span so one mistyped year cannot hang a view', () => {
  const trip = { items: [
    stay('h', 'Rome', '2027-03-01', '2027-03-04'),
    flight('f', 'Typo', '9999-12-31'),
  ] };
  const st = L.tripStats(trip);
  assert.equal(st.start, '2027-03-01');
  assert.equal(st.end, '9999-12-31'); // honest, so the issues list can name it
  assert.equal(st.spanCapped, true);
  assert.equal(st.renderEnd, L.addDays('2027-03-01', L.MAX_TRIP_DAYS - 1));
});

test('a normal trip reports no cap and renders to its real end', () => {
  const st = L.tripStats({ items: [stay('h', 'Rome', '2027-03-01', '2027-03-04')] });
  assert.equal(st.spanCapped, false);
  assert.equal(st.renderEnd, '2027-03-04');
});

test('dayCards stops at the cap instead of building millions of tiles', () => {
  const trip = { items: [
    stay('h', 'Rome', '2027-03-01', '2027-03-04'),
    flight('f', 'Typo', '9999-12-31'),
  ] };
  const cards = L.dayCards(trip);
  assert.equal(cards.length, L.MAX_TRIP_DAYS);
  assert.equal(cards[0].totalDays, L.MAX_TRIP_DAYS);
  assert.equal(cards[cards.length - 1].date, L.addDays('2027-03-01', L.MAX_TRIP_DAYS - 1));
});

test('a booked span running to the year 9999 cannot blow up the booked-night set', () => {
  const trip = { items: [stay('h', 'Rome', '2027-03-01', '9999-12-31', 'booked')] };
  const st = L.tripStats(trip);
  assert.equal(st.bookedNights, L.MAX_TRIP_DAYS);
});

test('coverageGaps stops at the cap for an absurd trip end', () => {
  const gaps = L.coverageGaps([stay('h', 'Rome', '2027-03-01', '2027-03-04')], '9999-12-31', []);
  const total = gaps.reduce((n, g) => n + g.nights, 0);
  assert.ok(total <= L.MAX_TRIP_DAYS, `capped, got ${total}`);
});

test('a mistyped trip end invents no uncovered nights at all', () => {
  // The 3-night Rome trip plus one item typed as the year 9999: the far-future
  // date is reported as its own error, and warning about 397 uncovered nights
  // for a trip with a hotel every night would be plainly false.
  assert.deepEqual(L.coverageGaps([stay('h', 'Rome', '2027-03-01', '2027-03-04')], '9999-12-31', []), []);
  // a REAL hole between real stays is still reported in the same trip
  assert.deepEqual(
    L.coverageGaps([
      stay('h', 'Rome', '2027-03-01', '2027-03-04'),
      stay('h2', 'Florence', '2027-03-06', '2027-03-08'),
    ], '9999-12-31', []),
    [{ start: '2027-03-04', end: '2027-03-06', nights: 2 }],
  );
  // and a trip end inside the render horizon still extends coverage as before
  assert.deepEqual(
    L.coverageGaps([stay('h', 'Rome', '2027-03-01', '2027-03-04')], '2027-03-06', []),
    [{ start: '2027-03-04', end: '2027-03-06', nights: 2 }],
  );
});

// ---------- empty-day wording ----------

test('an empty day inside a stay names the hotel instead of claiming no plans', () => {
  const items = [stay('h', 'Reykjavik', '2027-05-01', '2027-05-05')];
  assert.equal(L.emptyDayNote(items, '2027-05-03'), 'Nothing planned, staying at Reykjavik hotel');
  // check-in and check-out days are covered too (those tiles are never empty,
  // but the wording must not flip to a falsehood if they ever are)
  assert.equal(L.emptyDayNote(items, '2027-05-01'), 'Nothing planned, staying at Reykjavik hotel');
  assert.equal(L.emptyDayNote(items, '2027-05-05'), 'Nothing planned, staying at Reykjavik hotel');
});

test('a day with no stay at all still says there are no plans', () => {
  const items = [stay('h', 'Reykjavik', '2027-05-01', '2027-05-05')];
  assert.equal(L.emptyDayNote(items, '2027-05-06'), 'No plans yet');
  assert.equal(L.emptyDayNote([], '2027-05-03'), 'No plans yet');
  // a cancelled booking is not somewhere to sleep
  assert.equal(L.emptyDayNote([stay('h', 'Reykjavik', '2027-05-01', '2027-05-05', 'cancelled')], '2027-05-03'), 'No plans yet');
});

// ---------- regressions: money read out of untrusted JSON ----------

test('parseMoney keeps real numbers and numeric strings', () => {
  assert.deepEqual(L.parseMoney(120), { ok: true, value: 120, reason: '' });
  assert.deepEqual(L.parseMoney('120.50'), { ok: true, value: 120.5, reason: '' });
  assert.deepEqual(L.parseMoney(0), { ok: true, value: 0, reason: '' });
});

test('parseMoney treats an absent price as absent, not as a drop', () => {
  for (const v of [null, undefined, '', '   ']) {
    const r = L.parseMoney(v);
    assert.equal(r.ok, true, String(v));
    assert.equal(r.value, null, String(v));
  }
});

test('parseMoney refuses to invent money out of a non-number', () => {
  // `true` used to become $1.00 and `[]` used to become $0
  for (const v of [true, false, [], {}, ['5'], 'free']) {
    const r = L.parseMoney(v);
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.equal(r.value, null, JSON.stringify(v));
    assert.ok(r.reason, JSON.stringify(v));
  }
});

test('parseMoney refuses Infinity, which JSON.stringify would write back as null', () => {
  const r = L.parseMoney(1e999);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'is not a finite amount');
});

test('parseMoney keeps a negative amount: it is a refund, not a drop', () => {
  assert.deepEqual(L.parseMoney(-50), { ok: true, value: -50, reason: '' });
  // rounding is symmetric: a refund and its exact reverse must cancel to zero
  assert.deepEqual(L.parseMoney('-120.505'), { ok: true, value: -120.51, reason: '' });
  assert.equal(L.roundMoney(120.505) + L.roundMoney(-120.505), 0);
  // and the guard that stopped money being invented from a boolean is intact:
  // Number(true) is 1 and Number([]) is 0, so a signed amount becoming legal
  // must not reopen that hole
  for (const v of [true, false, [], {}, [-5], '-free']) {
    assert.equal(L.parseMoney(v).ok, false, JSON.stringify(v));
  }
  assert.equal(L.parseMoney(-1e999).ok, false);
  assert.equal(L.parseMoney(-1e999).reason, 'is not a finite amount');
});

// ---------- refunds ----------

test('refundParts turns a signed amount into a direction plus a magnitude', () => {
  assert.deepEqual(L.refundParts(-120), { isRefund: true, magnitude: 120 });
  assert.deepEqual(L.refundParts('-0.5'), { isRefund: true, magnitude: 0.5 });
  assert.deepEqual(L.refundParts(120), { isRefund: false, magnitude: 120 });
  assert.deepEqual(L.refundParts(0), { isRefund: false, magnitude: 0 });
  // -0 is not a refund: it is zero, and "Refund $0.00" would be a lie
  assert.equal(L.refundParts(-0).isRefund, false);
  assert.equal(L.refundParts('nope').isRefund, false);
});

test('showsCostBadge renders a refund and still hides a zero', () => {
  assert.equal(L.showsCostBadge(-120), true);
  assert.equal(L.showsCostBadge(0), false);
  assert.equal(L.showsCostBadge(null), false);
});

test('displayCostOf passes a refund through as a real cost', () => {
  const it = { cost: -120, costCurrency: 'USD' };
  assert.deepEqual(L.displayCostOf(it), { amount: -120, currency: 'USD', est: false });
});

test('sumInCurrency nets refunds against spend, in one currency and across two', () => {
  const items = [
    { cost: 500, costCurrency: 'USD' },
    { cost: -120, costCurrency: 'USD' },
  ];
  assert.equal(L.sumInCurrency(items, 'USD', null).total, 380);
  // a refund in another currency converts with the same rate as a charge
  const rates = { base: 'USD', rates: { EUR: 2 } };
  const mixed = [
    { cost: 100, costCurrency: 'USD' },
    { cost: -50, costCurrency: 'EUR' }, // 50 EUR = 25 USD back
  ];
  assert.equal(L.sumInCurrency(mixed, 'USD', rates).total, 75);
});

test('sumInCurrency goes negative when refunds exceed spend', () => {
  const items = [
    { cost: 40, costCurrency: 'USD' },
    { cost: -160, costCurrency: 'USD' },
  ];
  assert.equal(L.sumInCurrency(items, 'USD', null).total, -120);
});

test('budgetVerdict says refund, not "within budget", when the total is negative', () => {
  // "within budget" is technically true and completely uninformative when the
  // money counted so far is money coming BACK, and a green tick over a negative
  // number reads as a bug
  assert.equal(L.budgetVerdict(-120, 1000, 0), 'refund');
  assert.equal(L.budgetVerdict(-120, 1000, 2), 'refund');
  assert.equal(L.budgetVerdict(0, 1000, 0), 'ok');
  assert.equal(L.budgetVerdict(-120, null, 0), '');
});

// A minimal RFC4180 reader, only good enough for the rows buildCsv writes.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test('CSV keeps a refund as a signed number, so a spreadsheet SUM equals the app total', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'activity', title: 'Tour', startDate: '2027-05-01', status: 'booked', cost: 500, costCurrency: 'USD' },
    { id: 'b', type: 'note', title: 'Hotel refund', startDate: '2027-05-02', status: 'booked', cost: -120.5, costCurrency: 'USD' },
    { id: 'c', type: 'activity', title: 'Free museum', startDate: '2027-05-03', status: 'booked', cost: 0, costCurrency: 'USD' },
  ] };
  const rows = parseCsv(L.buildCsv(trip, 'USD', null));
  const head = rows[0];
  const costCol = head.indexOf('cost');
  const values = rows.slice(1).map(r => r[costCol]);
  assert.deepEqual(values, ['500', '-120.5', '0']);
  // the spreadsheet property: SUM(cost) === the app's own total
  const sheetSum = values.reduce((a, v) => a + Number(v), 0);
  assert.equal(sheetSum, L.sumInCurrency(trip.items, 'USD', null).total);
  assert.equal(sheetSum, 379.5);
  // ...and the converted column carries the sign too
  const convCol = head.indexOf('costInUSD');
  assert.equal(rows[2][convCol], '-120.50');
});

test('a refund round-trips CSV -> re-import unchanged', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'b', type: 'note', title: 'Hotel refund', startDate: '2027-05-02', status: 'booked', cost: -120.5, costCurrency: 'EUR' },
  ] };
  const rows = parseCsv(L.buildCsv(trip, 'USD', null));
  const head = rows[0];
  const raw = rows[1][head.indexOf('cost')];
  const back = L.parseMoney(raw);
  assert.equal(back.ok, true);
  assert.equal(back.value, -120.5);
  assert.equal(rows[1][head.indexOf('costCurrency')], 'EUR');
  // and the re-imported item is valid, so it is not silently dropped
  assert.deepEqual(L.validateItem({ type: 'note', title: 'Hotel refund', startDate: '2027-05-02', cost: back.value }), {});
});

test('a refund survives a share link and the assistant trip package', () => {
  const trip = { name: 'T', currency: 'USD', budget: 1000, items: [
    { id: 'x', type: 'note', title: 'Hotel refund', startDate: '2027-05-02', status: 'booked', cost: -120, costCurrency: 'USD' },
  ] };
  const slim = L.slimTripForShare(trip);
  assert.equal(slim.items[0].cost, -120);
  // and it is still valid on the far side, where the receiver re-validates
  assert.deepEqual(L.validateItem({ ...slim.items[0] }), {});
});

test('CSV columns still separate a guess from a price', () => {
  const cols = L.csvColumns('USD');
  assert.ok(cols.includes('cost'));
  assert.ok(cols.includes('estimatedCost'));
  assert.ok(cols.includes('costInUSD'));
});

test('an ASSISTANT may not propose a refund: only the traveller records one', () => {
  // A model that can post credits can make any trip look as cheap as it likes,
  // and the number would land in the Full plan total with no deliberate act by
  // the person paying. The negative is dropped; the rest of the add survives.
  const res = L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Refunded tour', startDate: '2027-05-01', cost: -200,
  } }, { items: [] });
  assert.equal(res.ok, true);
  assert.equal('cost' in res.proposal.fields, false);
  assert.equal(res.proposal.display.estCost, null);
  // a positive price from the same path is untouched
  const ok = L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Tour', startDate: '2027-05-01', cost: 200,
  } }, { items: [] });
  assert.equal(ok.proposal.fields.cost, 200);
});

test("an assistant update never overwrites the traveller's own refund", () => {
  const trip = { items: [{ id: 'x', type: 'activity', title: 'Cancelled tour', startDate: '2027-05-01', cost: -200, costCurrency: 'USD', status: 'booked' }] };
  const res = L.validateTripAction({ op: 'update', match: { id: 'x' }, set: { location: 'Kyoto', cost: -900 } }, trip);
  assert.equal(res.ok, true);
  // the model's negative is gone and the item's own refund is what the card shows
  assert.equal('cost' in res.proposal.fields, false);
  assert.equal(res.proposal.display.cost, -200);
});

test('a proposed cost of true or Infinity never becomes a price', () => {
  assert.equal(L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Museum', startDate: '2027-05-01', cost: true,
  } }, { items: [] }).proposal.fields.cost, null);
  assert.equal(L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Museum', startDate: '2027-05-01', cost: 1e999,
  } }, { items: [] }).proposal.fields.cost, null);
});

// ---------- regressions: an update proposal must not un-book anything ----------

function bookedHotel() {
  return {
    id: 'h1', type: 'stay', title: 'Ryokan', location: 'Kyoto',
    startDate: '2027-05-01', endDate: '2027-05-05', status: 'booked',
    cost: 800, costCurrency: 'USD',
  };
}

test('an update that says nothing about status leaves a booked item booked', () => {
  const res = L.validateTripAction(
    { op: 'update', match: { id: 'h1' }, set: { location: 'Kyoto, Higashiyama' } },
    { items: [bookedHotel()] });
  assert.equal(res.ok, true);
  assert.equal(res.proposal.status, 'booked');
  assert.equal(res.proposal.display.status, 'booked');
});

test('an update that DOES claim booked still cannot mark anything booked', () => {
  const res = L.validateTripAction(
    { op: 'update', match: { id: 'h1' }, set: { status: 'booked' } },
    { items: [{ ...bookedHotel(), status: 'to-book' }] });
  assert.equal(res.proposal.status, 'to-book');
  const cancel = L.validateTripAction(
    { op: 'update', match: { id: 'h1' }, set: { status: 'cancelled' } },
    { items: [bookedHotel()] });
  assert.equal(cancel.proposal.status, 'to-book');
});

test('an update proposal never labels the traveller own price as an estimate', () => {
  const res = L.validateTripAction(
    { op: 'update', match: { id: 'h1' }, set: { location: 'Kyoto, Higashiyama' } },
    { items: [bookedHotel()] });
  const d = res.proposal.display;
  assert.equal(d.cost, 800);
  assert.equal(d.estCost, null);
  assert.equal(L.costDisplayParts(d).tilde, '');
});

test('an update proposal DOES mark a price the model supplied as an estimate', () => {
  const res = L.validateTripAction(
    { op: 'update', match: { id: 'h1' }, set: { cost: 640, costCurrency: 'USD' } },
    { items: [bookedHotel()] });
  const d = res.proposal.display;
  assert.equal(d.estCost, 640);
  assert.equal(d.cost, undefined);
  assert.equal(L.costDisplayParts(d).tilde, '~');
});

test('a remove proposal shows the real status and the real price', () => {
  const res = L.validateTripAction({ op: 'remove', match: { id: 'h1' } }, { items: [bookedHotel()] });
  assert.equal(res.proposal.status, 'booked');
  assert.equal(res.proposal.display.cost, 800);
  assert.equal(L.costDisplayParts(res.proposal.display).tilde, '');
});

test('an add proposal is still always the model guess, never booked', () => {
  const res = L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Museum', startDate: '2027-05-02', cost: 25, status: 'booked',
  } }, { items: [bookedHotel()] });
  assert.equal(res.proposal.status, 'to-book');
  assert.equal(res.proposal.display.estCost, 25);
  assert.equal(L.costDisplayParts(res.proposal.display).tilde, '~');
});

// ---------- regressions: a total must not look complete when it is not ----------

test('budgetVerdict is over budget whenever the counted money already exceeds it', () => {
  assert.equal(L.budgetVerdict(1200, 1000, 0), 'over');
  assert.equal(L.budgetVerdict(1200, 1000, 3), 'over');
});

test('budgetVerdict never says within budget on an incomplete total', () => {
  // the 900,000 JPY ryokan that could not be converted is exactly the money
  // that would push this over, so green here was a claim about money nobody
  // counted
  assert.equal(L.budgetVerdict(300, 1000, 1), 'partial');
  assert.equal(L.budgetVerdict(300, 1000, 0), 'ok');
});

test('budgetVerdict says nothing when there is no budget', () => {
  assert.equal(L.budgetVerdict(300, null, 0), '');
  assert.equal(L.budgetVerdict(300, '', 2), '');
});

test('roundMoney stores the number the row actually shows', () => {
  assert.equal(L.roundMoney(12.12345678), 12.12);
  assert.equal(L.roundMoney(0.005), 0.01);
  assert.equal(L.roundMoney('44.6'), 44.6);
  assert.equal(L.roundMoney(1200), 1200);
});

test('parseMoney rounds what it accepts, so stored and shown agree', () => {
  assert.equal(L.parseMoney(12.12345678).value, 12.12);
  assert.equal(L.parseMoney('0.005').value, 0.01);
});

test('viewFromHash falls back for a fragment that names no view', () => {
  // the hashchange handler compares this to the current view, so "#nonsense"
  // reads as "no change" and the URL has to be rewritten rather than left
  assert.deepEqual(L.viewFromHash('#nonsense', 'map'), { view: 'map', isShare: false });
  assert.equal(L.hashForView('map'), '#map');
  assert.equal(L.hashForView('timeline'), '');
});
