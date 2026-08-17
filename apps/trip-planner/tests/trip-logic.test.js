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

// localDateIso is the only local-clock reader in the module, so it is checked
// against a mocked device timezone. A UTC slice of the SAME instant names a
// different day for part of every day at any real offset, and that is the
// reading the app's "today" used to take: it moved the countdown, the past-row
// dimming and the booking deadlines a day off for those hours.
function atZone(tz, fn) {
  const had = 'TZ' in process.env;
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (had) process.env.TZ = prev; else delete process.env.TZ; }
}

test('localDateIso reads the local calendar day where a UTC slice reads another', () => {
  atZone('America/Los_Angeles', () => {
    const evening = new Date('2026-07-26T02:00:00Z'); // 19:00 on the 25th locally
    assert.equal(L.localDateIso(evening), '2026-07-25');
    assert.equal(evening.toISOString().slice(0, 10), '2026-07-26'); // what "today" used to say
  });
  atZone('Asia/Jerusalem', () => {
    const smallHours = new Date('2026-07-25T22:00:00Z'); // 01:00 on the 26th locally
    assert.equal(L.localDateIso(smallHours), '2026-07-26');
    assert.equal(smallHours.toISOString().slice(0, 10), '2026-07-25'); // what "today" used to say
  });
});

test('localDateIso pads to YYYY-MM-DD and matches UTC when the offset cannot bite', () => {
  atZone('UTC', () => {
    assert.equal(L.localDateIso(new Date('2026-01-05T12:00:00Z')), '2026-01-05');
  });
  atZone('Asia/Jerusalem', () => {
    assert.equal(L.localDateIso(new Date('2026-03-09T09:30:00Z')), '2026-03-09');
  });
  atZone('America/Los_Angeles', () => {
    assert.equal(L.localDateIso(new Date('2026-11-02T18:00:00Z')), '2026-11-02');
  });
});

// Every date the app compares against "today" is a zero-padded ISO string it
// also sorts and diffs, so the local reader must produce the same shape.
test('localDateIso output is usable by the ISO date helpers', () => {
  atZone('Pacific/Kiritimati', () => { // UTC+14, the largest real offset
    const iso = L.localDateIso(new Date('2026-07-25T12:00:00Z')); // already the 26th there
    assert.equal(iso, '2026-07-26');
    assert.equal(L.isIsoDate(iso), true);
    assert.equal(L.addDays(iso, 1), '2026-07-27');
  });
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

// Every sort in here used `sortKey(a) < sortKey(b) ? -1 : 1`, which answers
// "b comes first" for a pair that is equal. Nothing in the sort spec has to
// honour a comparator that inconsistent, so the resulting order was V8's
// stability by luck rather than by contract. Identical keys are routine, not
// exotic: duplicateDay stamps every copy of a day with the same createdAt
// millisecond and copies the date, time and type verbatim.
test('bySortKey returns 0 on an identical key and is antisymmetric', () => {
  const a = { id: 'a', type: 'activity', startDate: '2027-01-16', startTime: '09:00', createdAt: '2027-01-01T00:00:00.000Z' };
  const b = { ...a, id: 'b' };
  const later = { ...a, id: 'c', startTime: '10:00' };
  assert.equal(L.sortKey(a), L.sortKey(b));
  assert.equal(L.bySortKey(a, b), 0);
  assert.equal(L.bySortKey(a, a), 0);
  assert.equal(L.bySortKey(a, later), -1);
  assert.equal(L.bySortKey(later, a), 1);
});

test('items with an identical sort key keep the order they were given', () => {
  // exactly the shape duplicateDay produces: same date, same time, same type,
  // and one createdAt for the whole batch
  const at = '2027-01-01T00:00:00.000Z';
  const items = ['Breakfast', 'Museum', 'Dinner'].map((title, i) => ({
    id: `c${i}`, type: 'activity', title, location: '', status: 'booked',
    startDate: '2027-01-16', startTime: '09:00', endDate: '', createdAt: at,
  }));
  const keys = items.map(L.sortKey);
  assert.equal(new Set(keys).size, 1);
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['c0', 'c1', 'c2']);
  assert.deepEqual(L.dayItemsInOrder(items, '2027-01-16').map(i => i.id), ['c0', 'c1', 'c2']);
});

test('departureOrigin reads the first flight when two share a sort key', () => {
  const at = '2027-01-01T00:00:00.000Z';
  const a = { ...flight('a', 'Tokyo to Bangkok', '2027-01-16'), startTime: '09:00', createdAt: at };
  const b = { ...flight('b', 'Osaka to Bangkok', '2027-01-16'), startTime: '09:00', createdAt: at };
  assert.equal(L.sortKey(a), L.sortKey(b));
  assert.equal(L.departureOrigin([a, b]), 'Tokyo');
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

// ---------- manual order inside a tie ----------
// A drag handle is a promise that two rows are interchangeable, so the group it
// is offered on has to be exactly the set of rows the comparator cannot
// separate: same date, same clock time. Anything wider would let a drag claim a
// 09:00 museum happens after a 14:00 train, which is the one thing a manual
// order must never be able to say.
const at = '2027-01-01T00:00:00.000Z';
function act(id, title, startDate, startTime = '', extra = {}) {
  return { id, type: 'activity', title, location: '', status: 'booked', startDate, startTime, endDate: '', createdAt: at, ...extra };
}

test('tieGroups collects same date + same time, and nothing else', () => {
  const items = [
    act('m', 'Museum', '2027-01-16', '09:00'),
    act('g', 'Gallery', '2027-01-16', '09:00'),
    act('t', 'Train museum', '2027-01-16', '14:00'),   // same day, different clock
    act('n1', 'Walk', '2027-01-16'),                    // same day, no time
    act('n2', 'Read', '2027-01-16'),
    act('x', 'Museum', '2027-01-17', '09:00'),          // same time, different day
  ];
  const groups = L.tieGroups(items);
  assert.deepEqual([...groups.keys()].sort(), ['2027-01-16|', '2027-01-16|09:00']);
  assert.deepEqual(groups.get('2027-01-16|09:00').map(i => i.id), ['m', 'g']);
  assert.deepEqual(groups.get('2027-01-16|').map(i => i.id), ['n1', 'n2']);
  // the 14:00 row, and both rows that tie with nobody, get no handle at all
  assert.deepEqual([...L.reorderableIds(items)].sort(), ['g', 'm', 'n1', 'n2']);
});

test('a stay is never in a tie group: its rows sit at assumed times', () => {
  const items = [
    stay('s', 'Tokyo', '2027-01-16', '2027-01-18'),
    act('a', 'Museum', '2027-01-16'),
    act('b', 'Dinner', '2027-01-16'),
  ];
  assert.equal(L.reorderableIds(items).has('s'), false);
  assert.deepEqual(L.tieGroupOf(items, 's'), []);
  assert.deepEqual(L.tieGroupOf(items, 'a').map(i => i.id), ['a', 'b']);
});

test('an undated item ties with nobody', () => {
  const items = [act('a', 'Someday', ''), act('b', 'Also someday', '')];
  assert.equal(L.reorderableIds(items).size, 0);
});

test('applyManualOrder stores the dropped order and sortedItems honours it', () => {
  const items = [
    act('a', 'Breakfast', '2027-01-16'),
    act('b', 'Museum', '2027-01-16'),
    act('c', 'Dinner', '2027-01-16'),
  ];
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['a', 'b', 'c']);
  assert.equal(L.applyManualOrder(items, ['c', 'a', 'b']), true);
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['c', 'a', 'b']);
  assert.deepEqual(items.map(i => i.order), [1, 2, 0]);
  // dropping a row back where it was is not an edit, so it never becomes a save
  assert.equal(L.applyManualOrder(items, ['c', 'a', 'b']), false);
});

test('a manual order never outranks a date or a clock time', () => {
  const items = [
    act('early', 'Museum', '2027-01-16', '09:00', { order: 5 }),
    act('late', 'Train', '2027-01-16', '14:00', { order: 0 }),
    act('next', 'Beach', '2027-01-17', '', { order: 0 }),
  ];
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['early', 'late', 'next']);
});

test('an untouched trip sorts byte-for-byte as it did before ordering existed', () => {
  const items = [
    act('c0', 'Breakfast', '2027-01-16', '09:00'),
    act('c1', 'Museum', '2027-01-16', '09:00'),
    act('c2', 'Dinner', '2027-01-16', '09:00'),
  ];
  // no order key anywhere: every key is identical, so the sort is the stable
  // input order the old comparator produced
  assert.equal(new Set(items.map(L.sortKey)).size, 1);
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['c0', 'c1', 'c2']);
  assert.equal(items.some(i => 'order' in i), false);
});

test('moveInTie walks a row one step and stops at both ends of its group', () => {
  const items = [
    act('a', 'Breakfast', '2027-01-16'),
    act('b', 'Museum', '2027-01-16'),
    act('c', 'Dinner', '2027-01-16'),
  ];
  assert.equal(L.moveInTie(items, 'c', -1), true);
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['a', 'c', 'b']);
  assert.equal(L.moveInTie(items, 'c', -1), true);
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['c', 'a', 'b']);
  assert.equal(L.moveInTie(items, 'c', -1), false);   // already the first row
  assert.equal(L.moveInTie(items, 'b', 1), false);    // already the last row
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['c', 'a', 'b']);
});

test('moveInTie refuses an item that ties with nobody', () => {
  const items = [act('a', 'Museum', '2027-01-16', '09:00'), act('b', 'Train', '2027-01-16', '14:00')];
  assert.equal(L.moveInTie(items, 'a', 1), false);
  assert.equal(L.moveInTie(items, 'missing', 1), false);
  assert.equal(items.some(i => 'order' in i), false);
});

test('normalizeOrders renumbers an ordered group and leaves an untouched one alone', () => {
  const items = [
    act('a', 'Breakfast', '2027-01-16', '', { order: 4 }),
    act('b', 'Museum', '2027-01-16', '', { order: 9 }),
    act('c', 'Coffee', '2027-01-17'),
    act('d', 'Walk', '2027-01-17'),
  ];
  assert.equal(L.normalizeOrders(items), true);
  assert.deepEqual(items.map(i => i.order), [0, 1, undefined, undefined]);
  assert.equal(L.normalizeOrders(items), false);   // idempotent
});

test('normalizeOrders drops a number left on a row that now ties with nobody', () => {
  const items = [
    act('a', 'Breakfast', '2027-01-16', '', { order: 0 }),
    act('b', 'Museum', '2027-01-16', '', { order: 1 }),
  ];
  // the traveller deletes one of the pair (or moves it to another day)
  items.splice(1, 1);
  assert.equal(L.normalizeOrders(items), true);
  assert.equal('order' in items[0], false);
});

test('normalizeOrders fits a newly added row into an ordered day, last', () => {
  const items = [
    act('a', 'Breakfast', '2027-01-16', '', { order: 1 }),
    act('b', 'Museum', '2027-01-16', '', { order: 0 }),
  ];
  items.push(act('c', 'Dinner', '2027-01-16'));   // added after the reorder
  assert.equal(L.normalizeOrders(items), true);
  assert.deepEqual(L.sortedItems({ items }).map(i => i.id), ['b', 'a', 'c']);
  assert.deepEqual(items.map(i => i.order), [1, 0, 2]);
});

test('a shared link carries the manual order and only when there is one', () => {
  const ordered = { name: 'T', currency: 'USD', items: [
    act('a', 'Breakfast', '2027-01-16', '', { order: 1 }),
    act('b', 'Museum', '2027-01-16', '', { order: 0 }),
  ] };
  const slim = L.slimTripForShare(ordered);
  assert.deepEqual(slim.items.map(i => i.order), [1, 0]);
  const plain = L.slimTripForShare({ name: 'T', currency: 'USD', items: [act('a', 'Breakfast', '2027-01-16')] });
  assert.equal('order' in plain.items[0], false);
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

test('a suppressed stop is not warned about when its country is ALREADY listed', () => {
  // The Israel sample. "Masada" is a national park, so Nominatim's top hit is
  // an `historic` / archaeological_site (measured 2026-07-23, importance 0.53,
  // country IL), which is not a settlement and so classifies 'low' whatever
  // else is in the list. Israel is already on screen from four confident city
  // stops, so the row asking the traveller to disambiguate Masada could not
  // have changed a single visa row: it was work with no outcome.
  const masada = L.classifyGeoMatch('Masada', [
    { name: 'Masada', cc: 'IL', country: 'Israel', state: 'South District', importance: 0.5291182090199721, kind: 'historic' },
    { name: 'Massada', cc: 'IL', country: 'Israel', state: 'North District', importance: 0.3523323513289129, kind: 'village' },
    { name: 'Masada', cc: 'IN', country: 'India', state: 'Andhra Pradesh', importance: 0.14670416800183103, kind: 'village' },
  ]);
  assert.equal(masada, 'low');
  assert.equal(L.visaCountryUsable(masada), false);
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Masada', cc: 'IL' }], ['IL']), []);
});

test('a suppressed stop IS still warned about when its country is not listed', () => {
  // The regression that matters. Suppression tracks "this row would tell you
  // nothing new", never "this guess is probably fine", so every documented
  // wrong-country case keeps its warning: none of these countries is otherwise
  // on the trip, and staying quiet would silently drop the stop instead.
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Nara', cc: 'US' }], ['JP']), ['Nara']);
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Maras', cc: 'TM' }], ['PE']), ['Maras']);
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Ha Long', cc: 'LS' }], ['VN']), ['Ha Long']);
  // and the mixed case: one vindicated, one not, on the same trip
  assert.deepEqual(
    L.visaUnconfirmedNames([{ name: 'Masada', cc: 'IL' }, { name: 'Nara', cc: 'US' }], ['IL', 'JO']),
    ['Nara'],
  );
});

test('suppression does not depend on the order the stops were read in', () => {
  // Masada is day 9 of the Israel sample, but a national park could as easily
  // be day 1. The caller collects the confident countries FIRST and resolves
  // these against the finished set, so an unconfirmed stop that arrives before
  // the confident sibling vindicating it is treated identically.
  const early = L.visaUnconfirmedNames([{ name: 'Masada', cc: 'IL' }], ['IL', 'JO']);
  const late = L.visaUnconfirmedNames([{ name: 'Masada', cc: 'IL' }], ['JO', 'IL']);
  assert.deepEqual(early, []);
  assert.deepEqual(late, []);
});

test('visaUnconfirmedNames handles the empty and country-less cases', () => {
  assert.deepEqual(L.visaUnconfirmedNames([], ['IL']), []);
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Masada', cc: 'IL' }], []), ['Masada']);
  // no best guess at all is no reason for silence: nothing on screen covers it
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Somewhere', cc: '' }], ['IL']), ['Somewhere']);
  // the caller passes Map keys, which are already uppercase, but a cache entry
  // that predates that normalisation must not read as a DIFFERENT country
  assert.deepEqual(L.visaUnconfirmedNames([{ name: 'Masada', cc: 'il' }], ['IL']), []);
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

// `count` feeds the summary bar's Items chip, so its rule is pinned here: it
// is the whole-trip count of items still ON the plan. Cancelled items are out
// (cancelling must read as removal from the plan), every live status is in,
// and an undated note counts the same as a dated flight.
test('tripStats.count counts non-cancelled items only', () => {
  assert.equal(L.tripStats({ items: [] }).count, 0);
  assert.equal(L.tripStats({ items: [
    { id: 'n', type: 'note', title: 'Undated packing note', startDate: '', status: 'to-book' },
  ] }).count, 1);
  const trip = { items: [
    stay('s', 'Tokyo', '2027-01-01', '2027-01-03'),
    flight('f', 'SHV to HND', '2027-01-01'),
    { id: 'a', type: 'activity', title: 'Museum', startDate: '2027-01-02', status: 'decide' },
    { id: 'c', type: 'activity', title: 'Cancelled tour', startDate: '2027-01-02', status: 'cancelled' },
  ] };
  assert.equal(L.tripStats(trip).count, 3);
  // restoring the cancelled item puts it straight back in the count
  trip.items.find(x => x.id === 'c').status = 'to-book';
  assert.equal(L.tripStats(trip).count, 4);
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

// ---------- a gap warning that fills itself in ----------
// The whole point of the "Add stay" control is that the traveller does not
// retype dates the app already knows: the form has to open on EXACTLY the range
// coverageGaps reported, or the dialog and the warning that opened it are two
// different claims about the same nights.

test('stayPrefillForGap opens a stay on exactly the uncovered range', () => {
  const gaps = L.coverageGaps([
    stay('a', 'Tokyo', '2027-01-01', '2027-01-05'),
    stay('b', 'Kyoto', '2027-01-08', '2027-01-11'),
  ]);
  assert.deepEqual(gaps, [{ start: '2027-01-05', end: '2027-01-08', nights: 3 }]);
  assert.deepEqual(L.stayPrefillForGap(gaps[0]), {
    type: 'stay', startDate: '2027-01-05', endDate: '2027-01-08', nights: 3,
  });
});

test('stayPrefillForGap on a single uncovered night is a one-night stay', () => {
  const gaps = L.coverageGaps([
    stay('a', 'Tokyo', '2027-01-01', '2027-01-05'),
    stay('b', 'Kyoto', '2027-01-06', '2027-01-09'),
  ]);
  const pre = L.stayPrefillForGap(gaps[0]);
  assert.equal(pre.startDate, '2027-01-05');
  assert.equal(pre.endDate, '2027-01-06');
  assert.equal(pre.nights, 1);
  // and it passes the form's own validator, so the prefilled dialog can be
  // saved without the traveller touching a field
  assert.deepEqual(L.validateItem({ ...pre, title: 'Somewhere', cost: null }), {});
});

test('firstStayPrefill takes the EARLIEST hole when a trip has several', () => {
  const gaps = L.coverageGaps([
    stay('a', 'Tokyo', '2027-01-01', '2027-01-03'),
    stay('b', 'Kyoto', '2027-01-05', '2027-01-07'),
    stay('c', 'Osaka', '2027-01-09', '2027-01-11'),
  ]);
  assert.equal(gaps.length, 2);
  assert.deepEqual(L.firstStayPrefill(gaps), {
    type: 'stay', startDate: '2027-01-03', endDate: '2027-01-05', nights: 2,
  });
  // the second line offers its own hole, never the first one again
  assert.equal(L.stayPrefillForGap(gaps[1]).startDate, '2027-01-07');
});

test('stayPrefillForGap refuses anything that is not a range of nights', () => {
  assert.equal(L.stayPrefillForGap(null), null);
  assert.equal(L.stayPrefillForGap({ start: '2027-01-05', end: '2027-01-05', nights: 0 }), null);
  assert.equal(L.stayPrefillForGap({ start: 'not a date', end: '2027-01-08' }), null);
  assert.equal(L.firstStayPrefill([]), null);
  assert.equal(L.firstStayPrefill(null), null);
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

// ---------- per-traveller cost split ----------

test('normalizeTravelers trims, dedupes case-insensitively and caps at 6', () => {
  assert.deepEqual(L.normalizeTravelers([' Alex ', 'Sam', 'alex']), ['Alex', 'Sam']);
  assert.deepEqual(L.normalizeTravelers(['a', 'b', 'c', 'd', 'e', 'f', 'g']), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(L.normalizeTravelers(['  ', '', 'Sam']), ['Sam']);
  assert.deepEqual(L.normalizeTravelers('not an array'), []);
  assert.deepEqual(L.normalizeTravelers(undefined), []);
});

test('travelerTotals splits solo, subset and Everyone items exactly (the contract)', () => {
  const trip = {
    currency: 'USD',
    travelers: ['Alex', 'Sam'],
    items: [
      { id: 'a', status: 'booked', cost: 100, travelers: ['Alex'] }, // Alex only
      { id: 'b', status: 'booked', cost: 50, travelers: ['Sam'] },   // Sam only
      { id: 'c', status: 'booked', cost: 60 },                       // Everyone -> $30 each
    ],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 130, Sam: 80 });
});

test('travelerTotals: a $60 Everyone item is an exact $30 split, no rounding drift', () => {
  const trip = { currency: 'USD', travelers: ['Alex', 'Sam'], items: [{ id: 'c', status: 'booked', cost: 60 }] };
  const t = L.travelerTotals(trip);
  assert.equal(t.Alex, 30);
  assert.equal(t.Sam, 30);
});

test('travelerTotals excludes cancelled items from every share', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      { id: 'a', status: 'booked', cost: 100, travelers: ['Alex'] },
      { id: 'x', status: 'cancelled', cost: 500, travelers: ['Alex'] },
      { id: 'y', status: 'cancelled', cost: 200 },
    ],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 100, Sam: 0 });
});

test('travelerTotals counts non-booked (planned) items too, cancelled aside', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      { id: 'a', status: 'to-book', cost: 40, travelers: ['Alex'] },
      { id: 'b', status: 'decide', cost: 20, travelers: ['Sam'] },
    ],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 40, Sam: 20 });
});

test('travelerTotals: an unconvertible amount is flagged per owed traveller, never counted', () => {
  const rates = { base: 'USD', rates: { EUR: 0.9 } }; // no THB rate
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      { id: 'a', status: 'booked', cost: 100, costCurrency: 'USD' },      // Everyone -> 50 each
      { id: 'b', status: 'booked', cost: 900, costCurrency: 'THB' },      // Everyone, unconvertible
    ],
  };
  const t = L.travelerTotals(trip, rates);
  assert.equal(t.Alex, 50);
  assert.equal(t.Sam, 50);
  assert.equal(t.unconverted.Alex.length, 1);
  assert.equal(t.unconverted.Sam.length, 1);
  assert.equal(t.unconverted.Alex[0].id, 'b');
});

test('travelerTotals treats an empty pick and an unknown name as Everyone, never nobody', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      { id: 'a', status: 'booked', cost: 80, travelers: [] },        // Everyone -> 40 each
      { id: 'b', status: 'booked', cost: 60, travelers: ['Ghost'] }, // unknown only -> Everyone -> 30 each
    ],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 70, Sam: 70 });
});

test('travelerTotals matches an item assignment case-insensitively to the trip roster', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [{ id: 'a', status: 'booked', cost: 100, travelers: ['alex'] }],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 100, Sam: 0 });
});

test('travelerTotals returns an empty map for a trip that never names a second traveller', () => {
  assert.deepEqual(L.travelerTotals({ currency: 'USD', items: [{ id: 'a', status: 'booked', cost: 100 }] }), {});
  assert.deepEqual(L.travelerTotals({ currency: 'USD', travelers: ['Solo'], items: [{ id: 'a', status: 'booked', cost: 100 }] }), {});
});

test('travelerTotals keeps its unconverted breakdown off the enumerable totals', () => {
  const trip = { currency: 'USD', travelers: ['Alex', 'Sam'], items: [{ id: 'a', status: 'booked', cost: 100 }] };
  const t = L.travelerTotals(trip);
  assert.deepEqual(Object.keys(t), ['Alex', 'Sam']); // unconverted is non-enumerable
  assert.deepEqual(t.unconverted, { Alex: [], Sam: [] });
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

// The day card is where the handle lives, so a manual order that the comparator
// honours but dayCards does not would be a drag that snaps back on every
// render. Both of the card's lists sort through the same key.
test('dayCards renders a hand-set order, in both the timed and untimed lists', () => {
  const trip = { items: [
    timedItem('idea', 'activity', 'Maybe the market', '2027-03-01', ''),
    timedItem('idea2', 'note', 'Buy stamps', '2027-03-01', ''),
    timedItem('museum', 'activity', 'Museum', '2027-03-01', '10:00'),
    timedItem('coffee', 'activity', 'Coffee', '2027-03-01', '10:00'),
  ] };
  assert.equal(L.applyManualOrder(trip.items, ['idea2', 'idea']), true);
  assert.equal(L.applyManualOrder(trip.items, ['coffee', 'museum']), true);
  const day = L.dayCards(trip)[0];
  assert.deepEqual(day.untimed.map(e => e.item.id), ['idea2', 'idea']);
  assert.deepEqual(day.events.map(e => e.item.id), ['coffee', 'museum']);
});

// A stay carries no order, so the assumed check-in position it is drawn at
// cannot be shoved around by a neighbour that has been reordered.
test('dayCards keeps a stay row where its assumed time puts it', () => {
  const trip = { items: [
    stay('h', 'Rome', '2027-03-01', '2027-03-04'),
    timedItem('a', 'activity', 'Museum', '2027-03-01', '09:00'),
    timedItem('b', 'activity', 'Coffee', '2027-03-01', '09:00'),
    timedItem('c', 'activity', 'Dinner', '2027-03-01', '19:00'),
  ] };
  const before = L.dayCards(trip)[0].events.map(e => e.item.id);
  assert.deepEqual(before, ['a', 'b', 'h', 'c']);   // check-in sits at 15:00
  L.applyManualOrder(trip.items, ['b', 'a']);
  assert.deepEqual(L.dayCards(trip)[0].events.map(e => e.item.id), ['b', 'a', 'h', 'c']);
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

// ---------- near-term forecast ----------

// The whole point of the second weather source is that it applies to a NARROW
// window and nothing else: one day past the horizon must keep the historical
// chip, or the app would be labelling a 5-year average "Forecast".
test('forecastEligible spans today through the 16th day and stops there', () => {
  const today = '2027-03-10';
  assert.equal(L.forecastEligible('2027-03-10', today), true);   // today
  assert.equal(L.forecastEligible('2027-03-25', today), true);   // +15, the last day Open-Meteo answers for
  assert.equal(L.forecastEligible('2027-03-26', today), false);  // +16, one past the horizon
  assert.equal(L.forecastEligible('2027-03-09', today), false);  // yesterday: history, not forecast
  assert.equal(L.forecastEligible('2028-03-10', today), false);
  assert.equal(L.forecastEligible('', today), false);
  assert.equal(L.forecastEligible('2027-03-10', ''), false);
  assert.equal(L.forecastEligible('2027-13-40', today), false);
});

test('forecastKey keys per place and DATE, never colliding with the climate key', () => {
  assert.equal(L.forecastKey('Tokyo', '2027-03-10'), 'tokyo|2027-03-10');
  assert.equal(L.forecastKey('  Rome ', '2027-12-01'), 'rome|2027-12-01');
  // two days of the same month must be two entries; weatherKey deliberately
  // collapses them into one, which is why the caches cannot be shared
  assert.notEqual(L.forecastKey('tokyo', '2027-03-10'), L.forecastKey('tokyo', '2027-03-11'));
  assert.notEqual(L.forecastKey('tokyo', '2027-03-10'), L.weatherKey('tokyo', 3));
});

test('summarizeForecast reads one daily block into per-date records', () => {
  const byDate = L.summarizeForecast({
    time: ['2027-03-10', '2027-03-11'],
    temperature_2m_min: [3.4, -2.6],
    temperature_2m_max: [11.6, 1.2],
    precipitation_probability_max: [40, 0],
    weather_code: [61, 71],
    relative_humidity_2m_mean: [78.4, 63],
  });
  assert.deepEqual(byDate['2027-03-10'], { lo: 3, hi: 12, pop: 40, code: 61, rh: 78 });
  assert.deepEqual(byDate['2027-03-11'], { lo: -3, hi: 1, pop: 0, code: 71, rh: 63 });
});

// The condition and the humidity are extras on a request that was already
// being made, so a response without them must still produce a usable record
// rather than dropping the day.
test('summarizeForecast leaves the condition and humidity null when the API omits them', () => {
  const byDate = L.summarizeForecast({
    time: ['2027-03-10'],
    temperature_2m_min: [3],
    temperature_2m_max: [11],
    precipitation_probability_max: [40],
  });
  assert.deepEqual(byDate['2027-03-10'], { lo: 3, hi: 11, pop: 40, code: null, rh: null });
});

// A half-read day would render a chip labelled "Forecast" over a nonsense
// range, which is worse than the historical figure it would be replacing.
test('summarizeForecast drops a day missing either temperature and survives junk', () => {
  const byDate = L.summarizeForecast({
    time: ['2027-03-10', '2027-03-11', 'not-a-date'],
    temperature_2m_min: [3, null],
    temperature_2m_max: [11, 9],
    precipitation_probability_max: [null, 20],
  });
  assert.deepEqual(Object.keys(byDate), ['2027-03-10']);
  assert.equal(byDate['2027-03-10'].pop, null);
  assert.deepEqual(L.summarizeForecast(null), {});
  assert.deepEqual(L.summarizeForecast({ time: 'nope' }), {});
});

// A forecast that outlives its window is a stale claim under a "Forecast"
// label; the climate cache has no expiry precisely because it cannot go stale.
test('forecastFresh and freshForecasts expire a cached forecast', () => {
  const now = 1_700_000_000_000;
  assert.equal(L.forecastFresh({ at: now, lo: 3, hi: 11 }, now), true);
  assert.equal(L.forecastFresh({ at: now - (L.FORECAST_TTL_MS - 1) }, now), true);
  assert.equal(L.forecastFresh({ at: now - L.FORECAST_TTL_MS }, now), false);
  assert.equal(L.forecastFresh({ at: now + 60_000 }, now), false); // clock moved back
  assert.equal(L.forecastFresh({ lo: 3, hi: 11 }, now), false);
  assert.equal(L.forecastFresh(null, now), false);
  const kept = L.freshForecasts({
    'tokyo|2027-03-10': { at: now - 1000, lo: 3, hi: 11, pop: 40 },
    'tokyo|2027-03-11': { at: now - L.FORECAST_TTL_MS - 1, lo: 4, hi: 12, pop: 10 },
    'rome|2027-03-10': { lo: 8, hi: 16, pop: null },
  }, now);
  assert.deepEqual(Object.keys(kept), ['tokyo|2027-03-10']);
  assert.deepEqual(L.freshForecasts(null, now), {});
});

test('forecastLine says Forecast and never Typically', () => {
  const line = L.forecastLine('Tokyo', { lo: 3, hi: 11, pop: 40, code: 3 });
  assert.match(line, /^Forecast 3-11°C in Tokyo, overcast, 40% chance of rain$/);
  // below zero spells the join out, exactly as the climate line does
  assert.match(L.forecastLine('Tromso', { lo: -6, hi: -1, pop: null }), /^Forecast -6 to -1°C in Tromso$/);
  assert.doesNotMatch(line, /Typically|typical/);
  assert.equal(L.forecastLine('Tokyo', { lo: null, hi: 11, pop: 40 }), '');
  assert.equal(L.forecastLine('Tokyo', null), '');
});

// The chip shows a glyph and two bare percentages; only the tooltip can say
// which picture and which number mean what, so it must spell all three out.
test('forecastLine spells the icon, the rain figure and the humidity out in words', () => {
  const line = L.forecastLine('Tokyo', { lo: 24, hi: 34, pop: 69, code: 3, rh: 70 });
  assert.equal(line, 'Forecast 24-34°C in Tokyo, overcast, 69% chance of rain, 70% average humidity');
  // an old record with neither extra reads exactly as it did before
  assert.equal(L.forecastLine('Tokyo', { lo: 3, hi: 11, pop: null }), 'Forecast 3-11°C in Tokyo');
  // 0% is stated in the tooltip even though the chip drops the figure
  assert.match(L.forecastLine('Lima', { lo: 15, hi: 20, pop: 0, code: 0 }), /clear, 0% chance of rain$/);
});

// ---------- forecast conditions (WMO codes) ----------
// The mapping is what turns Open-Meteo's 100 codes into the seven pictures the
// chip owns. A code landing on the wrong bucket is a chip claiming snow on a
// drizzly day, so every boundary is pinned.
test('forecastConditionKey maps the WMO code table onto the seven conditions', () => {
  const cases = [
    [0, 'clear'], [1, 'partly'], [2, 'partly'], [3, 'cloudy'],
    [45, 'fog'], [48, 'fog'],
    [51, 'rain'], [61, 'rain'], [67, 'rain'],
    [71, 'snow'], [77, 'snow'],
    [80, 'rain'], [82, 'rain'],
    [85, 'snow'], [86, 'snow'],
    [95, 'thunder'], [99, 'thunder'],
  ];
  for (const [code, key] of cases) assert.equal(L.forecastConditionKey(code), key, `code ${code}`);
  // gaps in the table are not guessed at
  for (const code of [4, 44, 50, 68, 70, 79, 83, 90, 100, -1]) {
    assert.equal(L.forecastConditionKey(code), '', `code ${code}`);
  }
  assert.equal(L.forecastConditionKey(null), '');
  assert.equal(L.forecastConditionKey('nope'), '');
});

test('every condition key owns exactly one icon and one word', () => {
  const keys = Object.keys(L.FORECAST_CONDITIONS);
  assert.deepEqual(keys.sort(), ['clear', 'cloudy', 'fog', 'partly', 'rain', 'snow', 'thunder']);
  const icons = keys.map(k => L.FORECAST_CONDITIONS[k].icon);
  assert.equal(new Set(icons).size, icons.length, 'two conditions share an icon');
  for (const k of keys) assert.ok(L.FORECAST_CONDITIONS[k].word.trim(), k);
});

test('forecastCondition falls back to the precipitation figures when no code was served', () => {
  assert.equal(L.forecastCondition({ lo: 3, hi: 11, pop: 40, code: 61 }).key, 'rain');
  // no code: derived, and a freezing day derives snow rather than rain
  assert.equal(L.forecastCondition({ lo: 12, hi: 19, pop: 80 }).key, 'rain');
  assert.equal(L.forecastCondition({ lo: -8, hi: -2, pop: 80 }).key, 'snow');
  assert.equal(L.forecastCondition({ lo: 12, hi: 19, pop: 20 }).key, 'partly');
  assert.equal(L.forecastCondition({ lo: 12, hi: 19, pop: 0 }).key, 'clear');
  // nothing to derive from: no icon rather than an invented sun
  assert.equal(L.forecastCondition({ lo: 12, hi: 19, pop: null }), null);
  assert.equal(L.forecastCondition(null), null);
});

test('forecastChipParts prints rain only above 0% and humidity only when served', () => {
  const wet = L.forecastChipParts({ lo: 24, hi: 34, pop: 69, code: 95, rh: 70 });
  assert.deepEqual(wet, { icon: '⛈️', condition: 'thunderstorms', temp: '24-34°C', rain: '69%', humidity: '70%' });
  // a dry day carries no rain figure at all: "0%" is noise on a chip this small
  const dry = L.forecastChipParts({ lo: 15, hi: 22, pop: 0, code: 0, rh: 45 });
  assert.equal(dry.rain, '');
  assert.equal(dry.icon, '☀️');
  assert.equal(dry.humidity, '45%');
  // no humidity served: absent, never an empty figure next to its marker
  assert.equal(L.forecastChipParts({ lo: 15, hi: 22, pop: 30, code: 3 }).humidity, '');
  assert.equal(L.forecastChipParts({ lo: null, hi: 22, pop: 30 }), null);
  assert.equal(L.forecastChipParts(null), null);
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

test('slimTripForShare carries the traveller roster and per-item split', () => {
  const trip = { name: 'T', currency: 'USD', travelers: ['Alex', 'Sam'], items: [
    { id: 'x1', type: 'stay', title: 'Hotel', startDate: '2027-01-01', endDate: '2027-01-03',
      status: 'booked', cost: 200, travelers: ['Alex'], createdAt: 'z' },
    { id: 'x2', type: 'flight', title: 'Home', startDate: '2027-01-03', status: 'booked',
      cost: 100, travelers: [], createdAt: 'z' },
  ] };
  const slim = L.slimTripForShare(trip);
  assert.deepEqual(slim.travelers, ['Alex', 'Sam']);
  assert.deepEqual(slim.items[0].travelers, ['Alex']);
  // an Everyone (empty) assignment stays absent on the far side, not [] noise
  assert.equal(slim.items[1].travelers, undefined);
});

test('slimTripForShare omits the roster entirely for a solo trip', () => {
  const slim = L.slimTripForShare({ name: 'T', currency: 'USD', items: [] });
  assert.equal(slim.travelers, undefined);
});

test('buildCsv appends a travelers column without disturbing the cost total', () => {
  const cols = L.csvColumns('USD');
  assert.equal(cols.indexOf('travelers'), 17); // appended after confirmation, and still there
  assert.equal(cols.indexOf('cost'), 10); // cost column index is unchanged by the append
  const trip = { currency: 'USD', items: [
    { id: 'a', type: 'stay', title: 'Hotel', startDate: '2027-01-01', endDate: '2027-01-02',
      status: 'booked', cost: 200, travelers: ['Alex', 'Sam'] },
    { id: 'b', type: 'flight', title: 'Home', startDate: '2027-01-02', status: 'booked', cost: 100 },
  ] };
  const csv = L.buildCsv(trip, 'USD', null);
  assert.ok(csv.includes('"Alex; Sam"'));
  const rows = parseCsv(csv);
  assert.equal(rows[2][rows[0].indexOf('travelers')], ''); // the Everyone item leaves its cell empty
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

// `build` takes the mode so each assertion can say which contract it belongs
// to: the agenda and mapsQuery rules are shared, the option COUNTS are not.
for (const [name, build] of [
  ['buildAssistSystemPrompt', (mode) => L.buildAssistSystemPrompt({ trip: tripWith([]), focusDate: '', today: '', mode })],
  ['buildAssistPackage', (mode) => L.buildAssistPackage({ trip: tripWith([]), focusDate: '', request: 'plan my day', mode })],
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

  test(`${name} scopes the GUIDED meal-candidates rule to the slots the traveller asked for`, () => {
    assert.match(build('plan'), /meal slot and each drinks slot the traveller asked for \(and only those\)/);
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

  // How an alternative SET is expressed is contract in both modes: the pick-one
  // card is built on the shared group id, whoever asked and however many there
  // are. How MANY there are is not, and the two used to be one paragraph.
  test(`${name} always explains the group mechanic and what is never grouped`, () => {
    for (const mode of ['plan', 'chat']) {
      const s = build(mode);
      assert.match(s, /the same "group" value on its action/, mode);
      assert.match(s, /dinner-2026-12-31/, mode);
      assert.match(s, /never reuse one group id across two different slots/, mode);
      assert.match(s, /Transport, local hops, stays and notes are NEVER grouped/, mode);
      // the old blanket ban on grouping activities is exactly what this replaced
      assert.doesNotMatch(s, /Do NOT group activities/, mode);
    }
  });

  // A single take-it-or-leave-it museum card is a worse offer than a choice of
  // two, and three dinners is the count the picker's own request line asks for.
  test(`${name} asks the GUIDED planner for exactly 3 meal and 2 activity candidates`, () => {
    const s = build('plan');
    assert.match(s, /propose EXACTLY 3 candidates/);
    assert.match(s, /For every OTHER activity you suggest/);
    assert.match(s, /propose EXACTLY 2 candidates for that one slot/);
    assert.match(s, /group id of their own/);
  });

  // The regression this whole split exists for: "Give me 5 options, not 3" was
  // answered with "my instructions require exactly 3 options for each meal or
  // drinks slot", because the picker's rule lived in the SYSTEM prompt.
  test(`${name} never imposes a fixed option count in free-form chat`, () => {
    for (const mode of ['chat', undefined, '', 'nonsense']) {
      const s = build(mode);
      assert.doesNotMatch(s, /EXACTLY 3 candidates/, String(mode));
      assert.doesNotMatch(s, /EXACTLY 2 candidates/, String(mode));
      assert.match(s, /How MANY options to offer is the traveller's call/, String(mode));
      assert.match(s, /give exactly that many/, String(mode));
      assert.match(s, /You have no maximum and no minimum/, String(mode));
      assert.match(s, /NEVER tell the traveller that your instructions fix, cap or require a\s+particular number/, String(mode));
    }
  });

  // The cap this replaced was 8 per slot, which is the same arbitrary product
  // rule as "exactly 3" with a bigger number in it. What is left is the ONE
  // real constraint - a reply has to be complete, because the fenced JSON sits
  // at the end and a truncated answer loses the cards rather than shortening
  // them - stated as graceful degradation rather than as a refusal.
  test(`${name} states a reply-size limit instead of an option-count limit`, () => {
    const s = build('chat');
    assert.doesNotMatch(s, /up to \d+ per slot/);
    assert.doesNotMatch(s, /most you can show/);
    assert.doesNotMatch(s, /maximum of \d+/);
    assert.match(s, /a single reply has to be complete/);
    assert.match(s, /offer to continue in\s+the next message/);
    assert.match(s, /Never silently drop the rest, and never refuse the request outright/);
    // quoting what a traveller might ASK for is fine and wanted; what must not
    // appear is any wording that caps what the assistant may give back
    assert.doesNotMatch(s, /\bup to \d+/i);
    assert.doesNotMatch(s, /\bat most \d+/i);
    assert.doesNotMatch(s, /\bmaximum\b(?!\s+and no minimum)/i);
    assert.doesNotMatch(s, /\bno more than \d+/i);
    assert.match(s, /"give me 10"/);   // an explicitly large ask, answered as asked
  });

  // The other half of the honesty rule: knowing the card carries a figure is
  // not permission to invent one in prose.
  test(`${name} says the app measures distance and forbids inventing one`, () => {
    for (const mode of ['plan', 'chat']) {
      const s = build(mode);
      assert.match(s, /This app measures distance itself/, mode);
      assert.match(s, /never explain that you lack GPS, live traffic, maps or location access/, mode);
      assert.match(s, /Do not state a distance, a walking time, a driving time, a\s+fare or a journey time as a fact/, mode);
    }
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

// Activities are grouped now too (2 options a slot), so the whole path from a
// raw reply to rendered cards has to treat an activity group exactly as it
// treats a dinner group: no warning, no special case, no dropped option.
test('a 3-option meal set and a 2-option activity set both validate and group cleanly', () => {
  const trip = tripWith([]);
  const raw = [
    { op: 'add', group: 'dinner-2027-05-01', item: { type: 'activity', title: 'Dinner: A', startDate: '2027-05-01', startTime: '19:00', mapsQuery: 'A Tokyo' } },
    { op: 'add', group: 'dinner-2027-05-01', item: { type: 'activity', title: 'Dinner: B', startDate: '2027-05-01', startTime: '19:00' } },
    { op: 'add', group: 'dinner-2027-05-01', item: { type: 'activity', title: 'Dinner: C', startDate: '2027-05-01', startTime: '19:00' } },
    { op: 'add', group: 'activity-2027-05-01-morning', item: { type: 'activity', title: 'Meiji Shrine', startDate: '2027-05-01', startTime: '10:00' } },
    { op: 'add', group: 'activity-2027-05-01-morning', item: { type: 'activity', title: 'teamLab Planets', startDate: '2027-05-01', startTime: '10:00' } },
    { op: 'add', item: { type: 'local', title: 'Return to hotel', startDate: '2027-05-01', startTime: '22:00' } },
  ];
  const proposals = raw.map((a, i) => {
    const r = L.validateTripAction(a, trip);
    assert.equal(r.ok, true, `action ${i} was rejected: ${r.reason}`);
    return { ...r.proposal, pid: 'p' + i };
  });
  assert.equal(proposals[3].group, 'activity-2027-05-01-morning');
  assert.equal('group' in proposals[5], false, 'a local hop is never grouped');
  const entries = L.groupProposals(proposals);
  assert.deepEqual(entries.map(e => e.type), ['set', 'set', 'single']);
  assert.deepEqual(entries.map(e => (e.type === 'set' ? e.candidates.length : 1)), [3, 2, 1]);
  assert.equal(entries[1].group, 'activity-2027-05-01-morning');
  // accepting takes exactly one option out of a set: the pids are distinct and
  // each candidate is a whole proposal of its own
  assert.deepEqual(entries[1].candidates.map(p => p.pid), ['p3', 'p4']);
  assert.deepEqual(entries[1].candidates.map(p => p.display.title), ['Meiji Shrine', 'teamLab Planets']);
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
  // the activities line asks for its own two options; nothing else may
  const optionLines = out.split('\n').filter(l => l.includes('options'));
  assert.deepEqual(optionLines, ['I would like 2-3 activities, and give me 2 options for each one.']);
  assert.doesNotMatch(L.buildPlanRequest(planPrefs({
    activities: 0, drinks: 0, meals: { breakfast: false, lunch: false, dinner: false },
  }), emptyTrip()), /options/);
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

// The picker sends the budget as an ARRAY now: one tier behaves like the old
// number, several tiers are a range the model may span, and an empty array is
// "no preference" - the request then says nothing about money at all.
test('buildPlanRequest: a one-tier budget array reads exactly like the old number', () => {
  const arr = L.buildPlanRequest(planPrefs({ budget: [3] }), emptyTrip());
  const num = L.buildPlanRequest(planPrefs({ budget: 3 }), emptyTrip());
  assert.equal(arr, num);
  assert.ok(arr.includes('Keep the whole day upscale.'), arr);
});

test('buildPlanRequest: a multi-tier budget joins the price words with or', () => {
  const out = L.buildPlanRequest(planPrefs({ budget: [2, 3] }), emptyTrip());
  assert.ok(out.includes('Keep the whole day mid-range or upscale.'), out);
  const three = L.buildPlanRequest(planPrefs({ budget: [1, 2, 3] }), emptyTrip());
  assert.ok(three.includes('Keep the whole day budget-friendly, mid-range or upscale.'), three);
});

test('buildPlanRequest: multi-tier budgets sort and dedupe before wording', () => {
  const out = L.buildPlanRequest(planPrefs({ budget: [3, 2, 3] }), emptyTrip());
  assert.ok(out.includes('Keep the whole day mid-range or upscale.'), out);
});

test('buildPlanRequest: an empty budget array says nothing about money', () => {
  const out = L.buildPlanRequest(planPrefs({ budget: [] }), emptyTrip());
  assert.doesNotMatch(out, /Keep the whole day/);
  assert.doesNotMatch(out, /budget-friendly|mid-range|upscale|splurge-worthy/);
});

test('buildPlanRequest: junk inside a budget array is dropped, not defaulted', () => {
  const out = L.buildPlanRequest(planPrefs({ budget: [9, 'x'] }), emptyTrip());
  assert.doesNotMatch(out, /Keep the whole day/);
  const mixed = L.buildPlanRequest(planPrefs({ budget: [9, 4] }), emptyTrip());
  assert.ok(mixed.includes('Keep the whole day splurge-worthy.'), mixed);
});

test('buildPlanRequest: a missing or unrecognisable non-array budget still defaults to mid-range', () => {
  const missing = planPrefs({});
  delete missing.budget;
  assert.ok(L.buildPlanRequest(missing, emptyTrip()).includes('Keep the whole day mid-range.'));
  assert.ok(L.buildPlanRequest(planPrefs({ budget: 99 }), emptyTrip()).includes('Keep the whole day mid-range.'));
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

test('buildPlanRequest asks for 3 options per meal and drinks slot and 2 per activity', () => {
  const out = L.buildPlanRequest(planPrefs({ drinks: 3 }), emptyTrip());
  const mealLine = out.split('\n').find(l => l.includes('breakfast'));
  const drinksLine = out.split('\n').find(l => l.includes('drinks'));
  const activityLine = out.split('\n').find(l => l.includes('activities'));
  assert.ok(mealLine.includes('3 options'), mealLine);
  assert.ok(drinksLine.includes('3 options'), drinksLine);
  // an activity is a choice between two, not a single take-it-or-leave-it card
  assert.ok(activityLine.includes('2 options'), activityLine);
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
    'I want to be at my first planned stop at 6:30 AM, with any travel to it before that time, and want to be back at my hotel by 8:00 PM.',
    'Plan breakfast, and give me 3 options for each one.',
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
  // The attribution link is mandatory, so a rating we cannot attribute is
  // never cached as ok - but it IS remembered as a tombstone, because
  // dropping it entirely re-billed the same venue on every later batch for a
  // rating that would be refused again. A malformed rating (C) stays dropped
  // outright: that is a transient response shape, worth a retry.
  assert.deepEqual(L.placesCacheUpdates([
    { query: 'A', status: 'ok', rating: 4.1, userRatingCount: 5, mapsUri: 'javascript:alert(1)' },
    { query: 'B', status: 'ok', rating: 4.1, userRatingCount: 5 },
    { query: 'C', status: 'ok', rating: 'nope', userRatingCount: 5, mapsUri: 'https://maps.google.com/?cid=2' },
  ]), [
    { key: 'a', entry: { status: 'no_match', reason: 'unattributable' } },
    { key: 'b', entry: { status: 'no_match', reason: 'unattributable' } },
  ]);
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
  usa: { days: 30, density: 'road' },
};

test('every template declares a shape and the library spans 7 to 30 days at every density', () => {
  const ids = samples.map(s => s.opt.id);
  assert.deepEqual([...ids].sort(), Object.keys(SAMPLE_SHAPES).sort());
  const declared = ids.map(id => SAMPLE_SHAPES[id].density);
  for (const density of ['sparse', 'moderate', 'relaxed', 'packed', 'split', 'road']) {
    assert.ok(declared.includes(density), `no template is ${density}`);
  }
  const lengths = new Set(ids.map(id => SAMPLE_SHAPES[id].days));
  assert.ok(lengths.size >= 8, `only ${lengths.size} distinct trip lengths`);
  assert.equal(Math.min(...lengths), 7);
  assert.equal(Math.max(...lengths), 30);
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

// A dozen examples that all started 45 days out showed one thing: a trip in the
// middle distance. The offsets are spread so the library also shows a trip
// happening TODAY (day-of chips, the near-term forecast chip), one next week,
// one in a fortnight and one in a month, without any of them being hardcoded.
test('the example offsets are spread across the next half year and include today, a week, a fortnight and a month', () => {
  const offsets = samples.map(s => s.opt.startOffset);
  for (const off of offsets) assert.ok(Number.isInteger(off) && off >= 0, `bad offset ${off}`);
  for (const required of [0, 7, 14, 30]) {
    assert.ok(offsets.includes(required), `no example starts ${required} days from today`);
  }
  assert.equal(new Set(offsets).size, offsets.length, 'two examples share a start offset');
  assert.ok(Math.max(...offsets) >= 120, 'nothing is planned far out');
});

test('each template carries its own start offset rather than the shared fallback', () => {
  for (const { opt } of samples) {
    const tpl = L.sampleTrip(opt.id);
    assert.equal(tpl.startOffset, opt.startOffset, `${opt.id} does not own its offset`);
    assert.equal(L.sampleStartOffset(tpl), opt.startOffset);
    const trip = L.buildSampleTrip(opt.id, { today: SAMPLE_TODAY });
    assert.equal(L.tripStats(trip).start, L.addDays(SAMPLE_TODAY, opt.startOffset));
  }
  // a template that names none still builds, on the documented fallback
  assert.equal(L.sampleStartOffset({}), L.SAMPLE_START_OFFSET);
  assert.equal(L.sampleStartOffset({ startOffset: -3 }), L.SAMPLE_START_OFFSET);
  assert.equal(L.sampleStartOffset(null), L.SAMPLE_START_OFFSET);
});

// The dropdown in the empty state and the trip-name datalist both render
// sampleTripOptions() in the order it returns them, so the A-to-Z promise in
// the README is this function's, and it is asserted rather than assumed.
test('sampleTripOptions lists the examples alphabetically by label', () => {
  const labels = L.sampleTripOptions().map(o => o.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(labels.map(l => l.replace(/\s*\(.*$/, '')), L.sampleTripOptions().map(o => o.place));
  // the offsets are deliberately NOT the sort key: alphabetical order must not
  // quietly become chronological order
  const offsets = L.sampleTripOptions().map(o => o.startOffset);
  assert.notDeepEqual(offsets, [...offsets].sort((a, b) => a - b));
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

  test(`example ${opt.id}: dates are relative to today and the trip runs 7 to 30 days`, () => {
    const stats = L.tripStats(trip);
    assert.equal(stats.start, L.addDays(SAMPLE_TODAY, opt.startOffset));
    const days = L.diffDays(stats.start, stats.end) + 1;
    assert.ok(days >= 7 && days <= 30, `${opt.id} runs ${days} days`);
    assert.equal(days, SAMPLE_SHAPES[opt.id].days, `${opt.id} does not run the length it declares`);
    for (const it of items) {
      // >=, not >: the offset-0 template starts TODAY on purpose, which is the
      // whole point of spreading the offsets. Nothing may fall behind today.
      assert.ok(it.startDate >= SAMPLE_TODAY, `${it.title} is in the past`);
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
    } else if (shape.density === 'road') {
      // a road trip is busy but never blank: the driving is itself the day's
      // main event, so an empty day would read as a day nobody moved
      assert.ok(avg(loads) >= 3.5, `${where}, too quiet for a road trip`);
      assert.equal(emptyDays(loads), 0, `${where}, a road trip has no blank days`);
      assert.ok(Math.max(...loads) <= 6, `${where}, has an overloaded day`);
      // more than half the days are spent getting somewhere new
      const driving = trip.items.filter(it => it.type === 'transport' && it.status !== 'cancelled').length;
      assert.ok(driving > loads.length / 2, `${where}, only ${driving} driving days`);
    }
  });

  // Every template used to be a two-city trip, so this was "the" intercity leg.
  // It is now per HOP: consecutive stays in different places must be joined by
  // a leg that names both of them, which is the same assertion for a two-stay
  // template and seventeen of them for the coast-to-coast one.
  test(`example ${opt.id}: every hop between stays is a named travel leg`, () => {
    assert.ok(stays.length >= 2, 'each example moves between at least two places');
    for (let i = 1; i < stays.length; i++) {
      const a = stays[i - 1], b = stays[i];
      assert.notEqual(a.location, b.location);
      const connects = items.some(it => {
        if (it.type !== 'transport' && it.type !== 'flight') return false;
        if (it.startDate < a.endDate || it.startDate > b.startDate) return false;
        const parts = it.title.split(/\s+to\s+/).map(s => L.stripPlaceCode(s));
        return parts[0] === a.location && parts[1] === b.location;
      });
      assert.ok(connects, `no leg reads "${a.location} to ${b.location}"`);
    }
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

// ---------- the coast-to-coast example ----------
// The one template that is a ROAD TRIP rather than a two-city trip, so the
// things worth failing on are the road-trip ones: it crosses the country, it
// never sleeps in the same place twice in a row, the driving is an explicit
// timed leg rather than an implied one, and a long drive is not also a full
// day of sightseeing. The last of those is the whole reason this test exists:
// "drive eight hours, then do six attractions" is the failure mode a
// generated itinerary falls into, and it would read as a bug in the shop
// window.
const usa = samples.find(s => s.opt.id === 'usa').trip;
const usaStays = usa.items.filter(it => L.isStay(it) && it.status !== 'cancelled');
const usaLegs = usa.items.filter(it => it.type === 'transport' && it.status !== 'cancelled');

test('the USA example crosses the country and sleeps somewhere new all the way', () => {
  assert.equal(L.diffDays(L.tripStats(usa).start, L.tripStats(usa).end) + 1, 30);
  assert.ok(usaStays.length >= 15, `only ${usaStays.length} overnight stops`);
  assert.equal(usaStays[0].location, 'New York');
  assert.equal(usaStays[usaStays.length - 1].location, 'San Francisco');
  // no place is slept in twice, here or anywhere else in the trip: a road trip
  // that doubled back would show up as a repeated stay location
  const places = usaStays.map(s => s.location);
  assert.equal(new Set(places).size, places.length, 'a stay location repeats');
  // one hop per pair of stays, all of them driven
  assert.equal(usaLegs.length, usaStays.length - 1, 'a hop is missing a drive');
  assert.equal(usa.items.filter(it => it.type === 'flight').length, 2, 'the driving is not all driving');
});

test('every drive in the USA example is an explicit timed leg', () => {
  for (const leg of usaLegs) {
    assert.ok(/^\d{2}:\d{2}$/.test(leg.startTime), `${leg.title} has no departure time`);
    assert.ok(/^\d{2}:\d{2}$/.test(leg.endTime), `${leg.title} has no arrival time`);
    assert.ok(L.isLongDetails(leg.details) || leg.details.length > 40, `${leg.title} says nothing about the drive`);
    assert.equal(leg.endDate, '', `${leg.title} spans a night it should not`);
  }
});

test('a long driving day in the USA example is not also a full day of sightseeing', () => {
  const LONG_MIN = 6 * 60;
  const loadOn = date => usa.items.filter(it => it.startDate === date
    && !L.isStay(it) && it.type !== 'note' && it.type !== 'transport' && it.status !== 'cancelled').length;
  const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let longDays = 0;
  for (const leg of usaLegs) {
    const window = mins(leg.endTime) - mins(leg.startTime);
    if (window < LONG_MIN) continue;
    longDays++;
    const [from, to] = leg.title.split(/\s+to\s+/).map(s => L.stripPlaceCode(s));
    assert.ok(loadOn(leg.startDate) <= 5, `${leg.title} is a ${window / 60}h day carrying ${loadOn(leg.startDate)} other things`);
    // and it is never JUST a drive: something on the way, somewhere that is
    // neither the city being left nor the city being reached
    const enRoute = usa.items.filter(it => it.startDate === leg.startDate && it.type === 'activity'
      && it.location && it.location !== from && it.location !== to);
    assert.ok(enRoute.length, `nothing to stop for on the ${window / 60}h ${leg.title} run`);
    for (const stop of enRoute) assert.ok(stop.mapsQuery, `${stop.title} has no mapsQuery`);
  }
  assert.ok(longDays >= 8, `only ${longDays} long driving days in a coast-to-coast trip`);
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
    ['USA', 'usa'], ['usa 2028', 'usa'], ['coast to coast USA', 'usa'],
    ['route 66', 'usa'], ['New York to San Francisco', 'usa'], ['Nashville and Memphis', 'usa'],
    ['santa fe + las vegas', 'usa'], ['Grand Canyon 2029', 'usa'],
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

// ---------- the budget range ----------
// A budget is optional and, when it exists, the CEILING is trip.budget. The
// range only adds an optional floor, so nothing that judges money changes.

test('readBudgetRange accepts the three states a budget is allowed to be', () => {
  // no budget at all is a real answer, not a blank waiting to be filled
  assert.deepEqual(L.readBudgetRange('', ''), { ok: true, error: '', from: null, to: null });
  // the plain ceiling this app has always had
  assert.deepEqual(L.readBudgetRange('', '3000'), { ok: true, error: '', from: null, to: 3000 });
  // and the range
  assert.deepEqual(L.readBudgetRange('3000', '5000'), { ok: true, error: '', from: 3000, to: 5000 });
  // a one-point range is still a range: from <= to is the only rule
  assert.deepEqual(L.readBudgetRange('3000', '3000'), { ok: true, error: '', from: 3000, to: 3000 });
});

test('readBudgetRange rounds both ends to the cent, like every other amount', () => {
  // stored and shown have to agree here for the same reason parseMoney rounds
  const r = L.readBudgetRange('2999.995', '5000.004');
  assert.deepEqual([r.from, r.to], [3000, 5000]);
});

test('readBudgetRange refuses a lower figure above the upper one', () => {
  const r = L.readBudgetRange('5000', '3000');
  assert.equal(r.ok, false);
  assert.match(r.error, /lower figure/i);
  // and nothing is handed back for the caller to save by accident
  assert.equal(r.to, undefined);
});

test('readBudgetRange refuses a negative at either end, as a budget always has', () => {
  // parseMoney allows negatives because a REFUND is legal money; a budget is a
  // ceiling, not a transaction
  assert.equal(L.readBudgetRange('', '-1').ok, false);
  assert.equal(L.readBudgetRange('-1', '3000').ok, false);
  assert.equal(L.readBudgetRange('', '-1').error, 'A budget cannot be negative.');
});

test('readBudgetRange refuses a floor with no ceiling instead of promoting it', () => {
  // a number typed as "at least 3000" must never come back as "at most 3000":
  // there is nothing to judge a total against, so the traveller is asked
  const r = L.readBudgetRange('3000', '');
  assert.equal(r.ok, false);
  assert.match(r.error, /upper figure/i);
});

test('readBudgetRange refuses junk at either end rather than inventing a number', () => {
  assert.equal(L.readBudgetRange('', 'lots').ok, false);
  assert.equal(L.readBudgetRange('some', '5000').ok, false);
  assert.equal(L.readBudgetRange('', true).ok, false);
});

test('a budget range is judged and drawn against its TOP, never its floor', () => {
  // the whole point of keeping trip.budget as the ceiling: every existing
  // consumer of it keeps its meaning when a floor appears underneath
  const r = L.readBudgetRange('3000', '5000');
  assert.equal(L.budgetVerdict(4000, r.to, 0), 'ok');
  assert.equal(L.budgetVerdict(5100, r.to, 0), 'over');
  // 4000 is over the FLOOR and that is not a warning about anything
  assert.equal(L.budgetVerdict(4000, r.to, 1), 'partial');
});

test('budgetFigure prints the ceiling alone when there is no floor', () => {
  const fmt = n => `$${Number(n).toFixed(2)}`;
  // byte for byte what the chip said before ranges existed
  assert.equal(L.budgetFigure(null, 3000, fmt), '$3000.00');
  assert.equal(L.budgetFigure('', 3000, fmt), '$3000.00');
});

test('budgetFigure prints both ends of a range, each formatted as money', () => {
  const fmt = n => `$${Number(n).toFixed(2)}`;
  assert.equal(L.budgetFigure(3000, 5000, fmt), '$3000.00-$5000.00');
});

test('budgetFigure says nothing at all when there is no budget', () => {
  const fmt = n => `$${Number(n).toFixed(2)}`;
  assert.equal(L.budgetFigure(null, null, fmt), '');
  assert.equal(L.budgetFigure(3000, null, fmt), '');
  assert.equal(L.budgetFigure(3000, '', fmt), '');
});

test('normalizeBudgetFrom keeps a floor that is one and drops one that is not', () => {
  assert.deepEqual(L.normalizeBudgetFrom(3000, 5000), { value: 3000, reason: '' });
  assert.deepEqual(L.normalizeBudgetFrom(null, 5000), { value: null, reason: '' });
  assert.equal(L.normalizeBudgetFrom('lots', 5000).value, null);
  assert.equal(L.normalizeBudgetFrom(-5, 5000).value, null);
  // a floor above the ceiling, and a floor left behind by a budget somebody
  // cleared, are both stale data that would render as a nonsense chip
  assert.equal(L.normalizeBudgetFrom(6000, 5000).value, null);
  assert.equal(L.normalizeBudgetFrom(3000, null).value, null);
  // every drop is explained, so an import can tell the traveller what it refused
  for (const args of [['lots', 5000], [-5, 5000], [6000, 5000], [3000, null]]) {
    assert.notEqual(L.normalizeBudgetFrom(args[0], args[1]).reason, '');
  }
});

test('a share link carries the lower end of a budget range but never invents one', () => {
  const items = [{ id: 'x', type: 'note', title: 'n', startDate: '2027-01-01', status: 'to-book' }];
  const ranged = L.slimTripForShare({ name: 'T', currency: 'USD', budget: 5000, budgetFrom: 3000, items });
  assert.equal(ranged.budget, 5000);
  assert.equal(ranged.budgetFrom, 3000);
  // a plain ceiling produces byte for byte the payload it always did
  const ceiling = L.slimTripForShare({ name: 'T', currency: 'USD', budget: 5000, items });
  assert.equal(ceiling.budgetFrom, undefined);
  // and a floor with no ceiling is not a budget, so it does not ride along
  const orphan = L.slimTripForShare({ name: 'T', currency: 'USD', budget: null, budgetFrom: 3000, items });
  assert.equal(orphan.budget, undefined);
  assert.equal(orphan.budgetFrom, undefined);
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

// ---------- connections between legs ----------

function cLeg(id, title, startDate, startTime, endDate = '', endTime = '', type = 'flight', status = 'booked') {
  return { id, type, title, location: '', startDate, startTime, endDate, endTime, status };
}
function cAct(id, title, startDate, startTime, status = 'booked') {
  return { id, type: 'activity', title, location: '', startDate, startTime, endDate: '', endTime: '', status };
}

test('connectionWarnings flags a departure at or before the previous arrival', () => {
  const items = [
    cLeg('a', 'BOS to CDG', '2026-09-01', '18:00', '2026-09-02', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '07:10'),
  ];
  const out = L.connectionWarnings(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'impossible');
  assert.deepEqual([out[0].fromId, out[0].toId], ['a', 'b']);
});

test('connectionWarnings treats an exactly equal departure and arrival as impossible', () => {
  const out = L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '07:30'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'impossible');
  assert.equal(out[0].minutes, 0);
});

test('connectionWarnings reports the gap in minutes under the tight cutoff', () => {
  const out = L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '07:45'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tight');
  assert.equal(out[0].minutes, 15);
});

test('connectionWarnings goes quiet at exactly the tight cutoff', () => {
  const at = L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '08:15'),
  ]);
  assert.deepEqual(at, []);
  assert.equal(L.TIGHT_CONNECTION_MIN, 45);
  const under = L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '08:14'),
  ]);
  assert.equal(under.length, 1);
  assert.equal(under[0].minutes, 44);
});

// A leg saved with no clock value at all could only be judged by inventing one.
test('connectionWarnings says nothing when either leg has no time', () => {
  assert.deepEqual(L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '', '', ''),
    cLeg('b', 'CDG to FCO', '2026-09-02', '07:45'),
  ]), []);
  assert.deepEqual(L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', ''),
  ]), []);
});

test('connectionWarnings ignores a non-travel item and a cancelled leg', () => {
  // an activity between the two legs means they are not back to back
  assert.deepEqual(L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cAct('m', 'Coffee', '2026-09-02', '07:35'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '07:45'),
  ]), []);
  assert.deepEqual(L.connectionWarnings([
    cLeg('a', 'BOS to CDG', '2026-09-02', '05:00', '', '07:30'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '07:45', '', '', 'flight', 'cancelled'),
  ]), []);
});

// A bed booked for the night the two legs straddle makes this a stopover.
test('connectionWarnings drops a pair with a stay covering the night between', () => {
  const items = [
    cLeg('a', 'BOS to CDG', '2026-09-01', '18:00', '2026-09-01', '23:50'),
    stay('h', 'Paris', '2026-09-01', '2026-09-02'),
    cLeg('b', 'CDG to FCO', '2026-09-02', '00:05'),
  ];
  assert.deepEqual(L.connectionWarnings(items), []);
});

// ...but a hotel check-in later the same day says nothing about the twenty
// minutes between landing and the next departure, so the warning survives it.
test('connectionWarnings keeps a same-day tight change despite that evening stay', () => {
  const items = [
    cLeg('a', 'BOS to CDG', '2026-09-01', '06:00', '', '10:00'),
    cLeg('b', 'CDG to FCO', '2026-09-01', '10:20'),
    stay('h', 'Rome', '2026-09-01', '2026-09-04'),
  ];
  const out = L.connectionWarnings(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tight');
});

// Sort adjacency cannot tell an outbound from a return: on a two-flight trip
// they sit next to each other. A mistyped arrival year must not be reported as
// an impossible connection weeks later.
test('connectionWarnings ignores two legs further than a day apart', () => {
  assert.deepEqual(L.connectionWarnings([
    cLeg('a', '2026-09-01 out', '2026-09-01', '09:00', '2026-12-01', '11:00'),
    cLeg('b', 'return', '2026-09-08', '09:00'),
  ]), []);
  // and the honest same-journey case still fires across midnight
  const overnight = L.connectionWarnings([
    cLeg('a', 'LHR to DXB', '2026-09-01', '21:00', '2026-09-02', '06:40'),
    cLeg('b', 'DXB to SIN', '2026-09-02', '07:00'),
  ]);
  assert.equal(overnight.length, 1);
  assert.equal(overnight[0].minutes, 20);
});

test('connectionWarnings covers transport and local legs, not just flights', () => {
  const out = L.connectionWarnings([
    cLeg('a', 'Taxi to Termini', '2026-09-03', '08:00', '', '08:30', 'local'),
    cLeg('b', 'Rome to Florence', '2026-09-03', '08:35', '', '10:07', 'transport'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].minutes, 5);
});

// ---------- same-clock-time double bookings ----------

test('sameTimeCollisions pairs two items on the same date and time', () => {
  const out = L.sameTimeCollisions([
    cAct('a', 'Louvre', '2026-09-05', '14:00'),
    cAct('b', 'Cooking class', '2026-09-05', '14:00'),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].aId, out[0].bId], ['a', 'b']);
  assert.deepEqual([out[0].aTitle, out[0].bTitle], ['Louvre', 'Cooking class']);
  assert.deepEqual([out[0].date, out[0].time], ['2026-09-05', '14:00']);
});

// The app never records how long anything lasts, so a five-minute offset is not
// evidence of a clash. Exact match only.
test('sameTimeCollisions is silent one minute apart, on another date, or cancelled', () => {
  assert.deepEqual(L.sameTimeCollisions([
    cAct('a', 'Louvre', '2026-09-05', '14:00'),
    cAct('b', 'Cooking class', '2026-09-05', '14:05'),
  ]), []);
  assert.deepEqual(L.sameTimeCollisions([
    cAct('a', 'Louvre', '2026-09-05', '14:00'),
    cAct('b', 'Cooking class', '2026-09-06', '14:00'),
  ]), []);
  assert.deepEqual(L.sameTimeCollisions([
    cAct('a', 'Louvre', '2026-09-05', '14:00'),
    cAct('b', 'Cooking class', '2026-09-05', '14:00', 'cancelled'),
  ]), []);
});

test('sameTimeCollisions ignores items with no time and stays', () => {
  assert.deepEqual(L.sameTimeCollisions([
    cAct('a', 'Louvre', '2026-09-05', ''),
    cAct('b', 'Cooking class', '2026-09-05', ''),
  ]), []);
  assert.deepEqual(L.sameTimeCollisions([
    stay('h1', 'Paris', '2026-09-05', '2026-09-08'),
    stay('h2', 'Paris annexe', '2026-09-05', '2026-09-07'),
  ]), []);
});

test('sameTimeCollisions reports every pair in a three-way pile-up', () => {
  const out = L.sameTimeCollisions([
    cAct('a', 'Louvre', '2026-09-05', '14:00'),
    cAct('b', 'Cooking class', '2026-09-05', '14:00'),
    cAct('c', 'Seine cruise', '2026-09-05', '14:00'),
  ]);
  assert.equal(out.length, 3);
});

// ---------- confirmation / booking reference ----------

test('CSV exports the confirmation code, and every older column keeps its index', () => {
  const cols = L.csvColumns('USD');
  // confirmation came first, travelers after it, bookBy and paymentMethod after
  // those; every one of them was added by appending, never inserting, so a
  // spreadsheet built against the old header still reads the same values out of
  // the same columns
  assert.equal(cols.indexOf('confirmation'), 16);
  assert.equal(cols.indexOf('travelers'), 17);
  assert.deepEqual(cols.slice(0, 16), ['startDate', 'startTime', 'endDate', 'endTime', 'nights',
    'type', 'title', 'location', 'details', 'status', 'cost', 'costCurrency', 'costInUSD',
    'estimatedCost', 'estimatedCostCurrency', 'costNote']);
});

test('a confirmation code survives the CSV export, and an item without one exports blank', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'flight', title: 'SHV to HND', startDate: '2027-05-01', status: 'booked', confirmation: 'XJ7K2Q' },
    { id: 'b', type: 'activity', title: 'Museum', startDate: '2027-05-02', status: 'booked' },
  ] };
  const rows = parseCsv(L.buildCsv(trip, 'USD', null));
  const col = rows[0].indexOf('confirmation');
  assert.equal(rows[1][col], 'XJ7K2Q');
  // no key at all on the older item: a blank cell, not "undefined"
  assert.equal(rows[2][col], '');
});

test('a confirmation code with a comma or a quote stays one CSV cell', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'stay', title: 'Hotel', startDate: '2027-05-01', endDate: '2027-05-03', status: 'booked', confirmation: 'AB,12"X' },
  ] };
  const rows = parseCsv(L.buildCsv(trip, 'USD', null));
  assert.equal(rows[1].length, rows[0].length);
  assert.equal(rows[1][rows[0].indexOf('confirmation')], 'AB,12"X');
});

test('the calendar export carries the confirmation code, labelled, and omits it when there is none', () => {
  const withRef = L.buildIcs({ name: 'T', items: [
    { id: 'a', type: 'flight', title: 'SHV to HND', startDate: '2027-05-01', status: 'booked', confirmation: 'XJ7K2Q' },
  ] });
  assert.ok(withRef.includes('Ref: XJ7K2Q'));
  const without = L.buildIcs({ name: 'T', items: [
    { id: 'a', type: 'flight', title: 'SHV to HND', startDate: '2027-05-01', status: 'booked' },
  ] });
  assert.equal(without.includes('Ref:'), false);
});

test('a confirmation code survives a share link, and an empty one is not carried', () => {
  const slim = L.slimTripForShare({ name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'flight', title: 'SHV to HND', startDate: '2027-05-01', status: 'booked', confirmation: 'XJ7K2Q' },
    { id: 'b', type: 'activity', title: 'Museum', startDate: '2027-05-02', status: 'booked', confirmation: '' },
    { id: 'c', type: 'activity', title: 'Park', startDate: '2027-05-03', status: 'booked' },
  ] });
  assert.equal(slim.items[0].confirmation, 'XJ7K2Q');
  assert.equal('confirmation' in slim.items[1], false);
  assert.equal('confirmation' in slim.items[2], false);
});

test('an assistant can never write a booking reference', () => {
  // a guessed code that looks real is worse at a check-in counter than none
  const add = L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Tour', startDate: '2027-05-01', confirmation: 'FAKE99',
  } }, { items: [] });
  assert.equal(add.ok, true);
  assert.equal('confirmation' in add.proposal.fields, false);
  // and an update leaves the traveller's own code exactly where it was
  const trip = { items: [{ id: 'x', type: 'stay', title: 'Hotel', startDate: '2027-05-01', endDate: '2027-05-03', status: 'booked', confirmation: 'REAL42' }] };
  const upd = L.validateTripAction({ op: 'update', match: { id: 'x' }, set: { location: 'Kyoto', confirmation: 'FAKE99' } }, trip);
  assert.equal('confirmation' in upd.proposal.fields, false);
  assert.equal(trip.items[0].confirmation, 'REAL42');
});

test('an item with no confirmation key validates exactly as one with an empty code', () => {
  const base = { type: 'activity', title: 'Museum', startDate: '2027-05-01' };
  assert.deepEqual(L.validateItem(base), {});
  assert.deepEqual(L.validateItem({ ...base, confirmation: '' }), {});
  assert.deepEqual(L.validateItem({ ...base, confirmation: 'XJ7K2Q' }), {});
});

// ---------- settle up (who owes whom) ----------
// The point of every case below: a settlement is a CLAIM ABOUT MONEY somebody
// has to hand over. It may only come from money that actually moved (booked,
// costed, with a payer named), it must net down so nobody is asked to pay a
// person who owes them, and it must never print a line for a rounding artefact.

function paid(id, cost, paidBy, extra) {
  return { id, type: 'activity', title: id, startDate: '2027-05-01', status: 'booked', cost, paidBy, ...(extra || {}) };
}

test('settlements: one Everyone cost paid by one traveller is a single half-share debt', () => {
  const trip = { currency: 'USD', travelers: ['Alex', 'Sam'], items: [paid('a', 200, 'Alex')] };
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 100 }]);
});

test('settlements nets opposing debts into ONE payment, never two crossing ones', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [paid('a', 200, 'Alex'), paid('b', 60, 'Sam')],
  };
  // Alex is owed 100, Sam is owed 30: asking each to pay the other is two
  // transfers to settle one 70-dollar difference
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 70 }]);
});

test('settlements pays a single creditor directly, never through a chain', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam', 'Jo'],
    items: [paid('a', 300, 'Alex')],
  };
  assert.deepEqual(L.settlements(trip), [
    { from: 'Sam', to: 'Alex', amount: 100 },
    { from: 'Jo', to: 'Alex', amount: 100 },
  ]);
});

test('settlements ignores a cost with no payer, and says nothing was tracked', () => {
  const trip = { currency: 'USD', travelers: ['Alex', 'Sam'], items: [paid('a', 60, undefined)] };
  const s = L.settlements(trip);
  assert.deepEqual(s, []);
  // the render needs this to ask for a payer instead of printing a settled trip
  assert.equal(s.tracked, 0);
  // and the same cost still counts towards each traveller's share
  assert.deepEqual(L.travelerTotals(trip), { Alex: 30, Sam: 30 });
});

test('settlements counts only BOOKED costs: money not yet spent is not a debt', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      paid('a', 200, 'Alex', { status: 'to-book' }),
      paid('b', 500, 'Alex', { status: 'cancelled' }),
      paid('c', 40, 'Alex'),
    ],
  };
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 20 }]);
});

test('settlements honours the item split: a cost for one person is owed in full', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [paid('a', 90, 'Alex', { travelers: ['Sam'] })],
  };
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 90 }]);
});

test('settlements: a cost the payer alone owes settles nothing', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [paid('a', 90, 'Alex', { travelers: ['Alex'] })],
  };
  const s = L.settlements(trip);
  assert.deepEqual(s, []);
  // tracked, unlike the untracked case: the trip is genuinely square
  assert.equal(s.tracked, 1);
});

test('settlements rounds to whole cents and never emits a sub-cent line', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam', 'Jo'],
    items: [paid('a', 100, 'Alex')], // 33.333... each
  };
  const s = L.settlements(trip);
  assert.deepEqual(s, [
    { from: 'Sam', to: 'Alex', amount: 33.33 },
    { from: 'Jo', to: 'Alex', amount: 33.33 },
  ]);
  for (const p of s) assert.equal(p.amount, Math.round(p.amount * 100) / 100);
});

test('settlements: a perfectly even split leaves no payment at all', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [paid('a', 50, 'Alex'), paid('b', 50, 'Sam')],
  };
  const s = L.settlements(trip);
  assert.deepEqual(s, []);
  assert.equal(s.tracked, 2);
});

test('settlements converts foreign costs, and flags one it cannot convert', () => {
  const rates = { base: 'USD', rates: { EUR: 0.5 } }; // no THB rate
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      paid('a', 100, 'Alex', { costCurrency: 'EUR' }),  // 200 USD -> Sam owes 100
      paid('b', 900, 'Sam', { costCurrency: 'THB' }),   // unconvertible: no debt invented
    ],
  };
  const s = L.settlements(trip, rates);
  assert.deepEqual(s, [{ from: 'Sam', to: 'Alex', amount: 100 }]);
  assert.equal(s.unconverted.length, 1);
  assert.equal(s.unconverted[0].id, 'b');
  assert.equal(s.tracked, 1);
});

test('settlements ignores a payer the trip no longer names, and matches case', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [paid('a', 200, 'Ghost'), paid('b', 80, 'alex')],
  };
  const s = L.settlements(trip);
  assert.deepEqual(s, [{ from: 'Sam', to: 'Alex', amount: 40 }]);
  assert.equal(s.tracked, 1);
});

test('settlements is absent on a solo or unnamed trip', () => {
  assert.deepEqual(L.settlements({ currency: 'USD', items: [paid('a', 60, 'Alex')] }), []);
  assert.deepEqual(L.settlements({ currency: 'USD', travelers: ['Alex'], items: [paid('a', 60, 'Alex')] }), []);
  assert.deepEqual(L.settlements(null), []);
});

test('settlements minimises payments across four travellers', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam', 'Jo', 'Kim'],
    items: [paid('a', 400, 'Alex'), paid('b', 200, 'Sam')],
  };
  // shares are 150 each: Alex is owed 250, Sam 50, Jo and Kim owe 150 each.
  // Four balances can always be cleared in three transfers or fewer.
  const s = L.settlements(trip);
  assert.ok(s.length <= 3, `expected at most 3 payments, got ${s.length}`);
  const net = { Alex: 0, Sam: 0, Jo: 0, Kim: 0 };
  for (const p of s) { net[p.to] += p.amount; net[p.from] -= p.amount; }
  assert.deepEqual(net, { Alex: 250, Sam: 50, Jo: -150, Kim: -150 });
});

test('a share link carries who paid, so the copy can still settle up', () => {
  const slim = L.slimTripForShare({
    name: 'T', currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      { id: 'a', type: 'activity', title: 'Tour', startDate: '2027-05-01', status: 'booked', cost: 200, paidBy: 'Alex' },
      { id: 'b', type: 'activity', title: 'Park', startDate: '2027-05-02', status: 'booked' },
    ],
  });
  assert.equal(slim.items[0].paidBy, 'Alex');
  assert.equal('paidBy' in slim.items[1], false);
});

// ---------- cost by type ----------
// The rule under all of these: a row is a claim that this trip spent that much
// on that kind of thing. No booked cost of a type means no claim to make (not a
// $0.00 one), and an amount we could not convert has to stay visible as missing.

function booked(id, type, cost, extra) {
  return { id, type, title: id, startDate: '2027-05-01', status: 'booked', cost, ...(extra || {}) };
}

test('costsByType lists one row per booked type, biggest first', () => {
  const trip = {
    currency: 'USD',
    items: [booked('a', 'activity', 40), booked('b', 'flight', 500), booked('c', 'stay', 300)],
  };
  assert.deepEqual(L.costsByType(trip).map(r => [r.type, r.total]), [
    ['flight', 500], ['stay', 300], ['activity', 40],
  ]);
});

test('costsByType sums several items of the same type into one row', () => {
  const trip = { currency: 'USD', items: [booked('a', 'flight', 500), booked('b', 'flight', 120)] };
  const rows = L.costsByType(trip);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].type, rows[0].total], ['flight', 620]);
});

test('costsByType gives a type with nothing booked no row at all, never a $0.00 one', () => {
  const trip = {
    currency: 'USD',
    items: [
      booked('a', 'flight', 500),
      booked('b', 'transport', 90, { status: 'to-book' }),
      booked('c', 'stay', 400, { status: 'cancelled' }),
      { id: 'd', type: 'note', title: 'Passport', startDate: '2027-05-01', status: 'booked' }, // no cost
    ],
  };
  assert.deepEqual(L.costsByType(trip).map(r => r.type), ['flight']);
});

test('costsByType totals match the Confirmed total, so the page shows one number twice', () => {
  const trip = {
    currency: 'USD',
    items: [booked('a', 'flight', 500), booked('b', 'stay', 300), booked('c', 'activity', 40),
      booked('d', 'local', 25, { status: 'to-book' })],
  };
  const byType = L.costsByType(trip).reduce((n, r) => n + r.total, 0);
  const confirmed = L.sumInCurrency(trip.items.filter(i => i.status === 'booked'), 'USD', null).total;
  assert.equal(byType, confirmed);
});

test('costsByType keeps the row for an amount it could not convert, flagged not dropped', () => {
  const rates = { base: 'USD', rates: { EUR: 0.5 } }; // no JPY rate
  const trip = {
    currency: 'USD',
    items: [
      booked('a', 'stay', 90000, { costCurrency: 'JPY' }),
      booked('b', 'flight', 100, { costCurrency: 'EUR' }), // 200 USD
    ],
  };
  const rows = L.costsByType(trip, rates);
  assert.deepEqual(rows.map(r => r.type), ['flight', 'stay']);
  assert.equal(rows[0].total, 200);
  assert.equal(rows[1].total, 0);
  assert.equal(rows[1].unconverted.length, 1);
  assert.equal(rows[1].unconverted[0].id, 'a');
});

test('costsByType converts a foreign cost into the trip currency before ranking', () => {
  const rates = { base: 'USD', rates: { EUR: 0.5 } };
  const trip = {
    currency: 'USD',
    items: [booked('a', 'stay', 300, { costCurrency: 'EUR' }), booked('b', 'flight', 500)],
  };
  // 300 EUR is 600 USD, so the stay outranks the flight despite the smaller figure
  assert.deepEqual(L.costsByType(trip, rates).map(r => [r.type, r.total]), [['stay', 600], ['flight', 500]]);
});

test('costsByType breaks a tie on the app type order, so the rows never shuffle', () => {
  const trip = { currency: 'USD', items: [booked('a', 'activity', 100), booked('b', 'flight', 100)] };
  assert.deepEqual(L.costsByType(trip).map(r => r.type), ['flight', 'activity']);
});

test('costsByType needs no travellers: it is gated on cost data alone', () => {
  const trip = { currency: 'USD', items: [booked('a', 'flight', 500)] };
  assert.deepEqual(L.costsByType(trip).map(r => [r.type, r.total]), [['flight', 500]]);
  assert.deepEqual(L.costsByType({ currency: 'USD', items: [] }), []);
  assert.deepEqual(L.costsByType(null), []);
});

// ---------- "Up next" chip and the packing checklist (round 3, agent A) ----------

const timed = (id, type, title, startDate, startTime, extra = {}) =>
  ({ id, type, title, startDate, startTime, status: 'booked', ...extra });

test('nextUpEvent names the soonest timed item and how long until it starts', () => {
  const items = [
    timed('a', 'activity', 'Museum visit', '2026-09-01', '10:00'),
    timed('b', 'activity', 'Dinner', '2026-09-01', '19:30'),
  ];
  const up = L.nextUpEvent(items, '2026-09-01T08:00');
  assert.equal(up.mode, 'next');
  assert.equal(up.title, 'Museum visit');
  assert.equal(up.id, 'a');
  assert.equal(up.dur, '2h');
  assert.equal(up.minutes, 120);
  // and the duration is fmtDur's, minutes and all
  assert.equal(L.nextUpEvent(items, '2026-09-01T08:30').dur, '1h 30m');
  assert.equal(L.nextUpEvent(items, '2026-09-01T09:15').dur, '45m');
});

test('nextUpEvent reads "now" while a leg is in the air, and stops naming it once it lands', () => {
  const items = [
    timed('f', 'flight', 'BOS to KEF', '2026-09-01', '21:30', { endDate: '2026-09-02', endTime: '06:45' }),
    timed('c', 'activity', 'Blue Lagoon', '2026-09-02', '11:00'),
  ];
  const mid = L.nextUpEvent(items, '2026-09-02T02:00');
  assert.equal(mid.mode, 'now');
  assert.equal(mid.title, 'BOS to KEF');
  // "Now" carries no duration: the chip must not print a countdown for it
  assert.equal(mid.minutes, null);
  assert.equal(mid.dur, '');
  // the moment of departure is already inside the span, the arrival is not
  assert.equal(L.nextUpEvent(items, '2026-09-01T21:30').mode, 'now');
  const landed = L.nextUpEvent(items, '2026-09-02T06:45');
  assert.equal(landed.mode, 'next');
  assert.equal(landed.title, 'Blue Lagoon');
});

test('a leg with no arrival time is never a "now": an assumed span is not a fact', () => {
  const items = [timed('f', 'flight', 'BOS to KEF', '2026-09-01', '21:30')];
  // an hour after it left, with no arrival typed, there is nothing to be inside of
  assert.equal(L.nextUpEvent(items, '2026-09-01T22:30'), null);
});

test('nextUpEvent skips cancelled items even when they are chronologically closer', () => {
  const items = [
    timed('x', 'activity', 'Cancelled tour', '2026-09-01', '09:00', { status: 'cancelled' }),
    timed('y', 'activity', 'Castle', '2026-09-01', '11:00'),
  ];
  const up = L.nextUpEvent(items, '2026-09-01T08:00');
  assert.equal(up.id, 'y');
  assert.equal(up.title, 'Castle');
});

test('stays and untimed items never take part', () => {
  const items = [
    { id: 's', type: 'stay', title: 'Hotel Kyoto', startDate: '2026-09-01', endDate: '2026-09-04', status: 'booked' },
    { id: 'n', type: 'activity', title: 'Somewhere, some time', startDate: '2026-09-01', status: 'booked' },
  ];
  assert.equal(L.nextUpEvent(items, '2026-09-01T08:00'), null);
  // a stay carrying a stray time is still not an event: check-in time is assumed
  const withTime = [{ ...items[0], startTime: '15:00' }];
  assert.equal(L.nextUpEvent(withTime, '2026-09-01T08:00'), null);
});

test('the chip goes quiet past the 36-hour window, and at the boundary it does not', () => {
  const at = t => L.nextUpEvent([timed('a', 'activity', 'Tour', '2026-09-03', t)], '2026-09-01T08:00');
  assert.equal(L.NEXT_UP_WINDOW_MIN, 36 * 60);
  // 2026-09-01 08:00 plus 36h is 2026-09-02 20:00, so both of these are further out
  assert.equal(at('08:00'), null);           // 48 hours
  assert.equal(at('00:00'), null);           // 40 hours
  const edge = L.nextUpEvent([timed('a', 'activity', 'Tour', '2026-09-02', '20:00')], '2026-09-01T08:00');
  assert.equal(edge.minutes, 36 * 60);
  assert.equal(edge.dur, '36h');
  assert.equal(L.nextUpEvent([timed('a', 'activity', 'Tour', '2026-09-02', '20:01')], '2026-09-01T08:00'), null);
});

test('nextUpEvent is silent rather than wrong when it has nothing to read', () => {
  assert.equal(L.nextUpEvent([], '2026-09-01T08:00'), null);
  assert.equal(L.nextUpEvent(null, '2026-09-01T08:00'), null);
  assert.equal(L.nextUpEvent([timed('a', 'activity', 'Tour', '2026-09-01', '10:00')], ''), null);
  assert.equal(L.nextUpEvent([timed('a', 'activity', 'Tour', '2026-09-01', '10:00')], 'not-a-stamp'), null);
  // everything already behind the clock, and none of it a span
  assert.equal(L.nextUpEvent([timed('a', 'activity', 'Tour', '2026-09-01', '07:00')], '2026-09-01T08:00'), null);
});

test('the packing seed always carries the universal basics', () => {
  const seed = L.defaultPackingItems({ items: [] });
  assert.equal(seed[0], 'Passport or photo ID');
  assert.equal(seed.length, 5);
  assert.equal(new Set(seed).size, seed.length);
  assert.deepEqual(L.defaultPackingItems({}), seed);
});

test('the boarding-pass row seeds only for a trip that actually has a flight', () => {
  const BP = 'Boarding passes downloaded or mobile wallet ready';
  const noFlight = L.defaultPackingItems({ items: [
    { id: 'a', type: 'transport', title: 'Train', startDate: '2026-09-01', status: 'booked' },
  ] });
  assert.equal(noFlight.includes(BP), false);
  const withFlight = L.defaultPackingItems({ items: [
    { id: 'a', type: 'flight', title: 'BOS to KEF', startDate: '2026-09-01', status: 'booked' },
  ] });
  assert.equal(withFlight.includes(BP), true);
  // a cancelled flight is not a flight you are catching
  const cancelled = L.defaultPackingItems({ items: [
    { id: 'a', type: 'flight', title: 'BOS to KEF', startDate: '2026-09-01', status: 'cancelled' },
  ] });
  assert.equal(cancelled.includes(BP), false);
});

test('the sleep-in-transit row seeds only for an overnight leg', () => {
  const WARM = 'Something warm to sleep in transit';
  const sameDay = L.defaultPackingItems({ items: [
    { id: 'a', type: 'flight', title: 'BOS to JFK', startDate: '2026-09-01', endDate: '2026-09-01', status: 'booked' },
  ] });
  assert.equal(sameDay.includes(WARM), false);
  const redEye = L.defaultPackingItems({ items: [
    { id: 'a', type: 'flight', title: 'BOS to KEF', startDate: '2026-09-01', endDate: '2026-09-02', status: 'booked' },
  ] });
  assert.equal(redEye.includes(WARM), true);
  // a sleeper train counts; a taxi that somehow spans midnight is not a bed
  const sleeper = L.defaultPackingItems({ items: [
    { id: 'a', type: 'transport', title: 'Bangkok to Chiang Mai', startDate: '2026-09-01', endDate: '2026-09-02', status: 'booked' },
  ] });
  assert.equal(sleeper.includes(WARM), true);
  const taxi = L.defaultPackingItems({ items: [
    { id: 'a', type: 'local', title: 'Night taxi', startDate: '2026-09-01', endDate: '2026-09-02', status: 'booked' },
  ] });
  assert.equal(taxi.includes(WARM), false);
});

test('a trip with a flight and an overnight leg seeds seven rows, all distinct', () => {
  const seed = L.defaultPackingItems({ items: [
    { id: 'a', type: 'flight', title: 'BOS to KEF', startDate: '2026-09-01', endDate: '2026-09-02', status: 'booked' },
    { id: 'b', type: 'stay', title: 'Hotel', startDate: '2026-09-02', endDate: '2026-09-05', status: 'booked' },
  ] });
  assert.equal(seed.length, 7);
  assert.equal(new Set(seed).size, 7);
  // and the seed says nothing about a destination or a season it cannot know
  assert.equal(seed.some(t => /adapter|swimwear|thermal|sunscreen/i.test(t)), false);
});

// ---------- per-traveller packing rows ----------
// The rule under all of these: an untagged row is EVERYONE'S row. That is what
// every list stored before the tag existed, so a solo trip and an old trip both
// have to keep reading exactly as they did.

const pkRow = (id, text, who, done = false) => (who ? { id, text, who, done } : { id, text, done });
const PAIR = ['Alex', 'Sam'];

test('packingWho canonicalises a tag against the roster and reads an untagged row as everyone', () => {
  assert.deepEqual(L.packingWho(pkRow('a', 'Boots'), PAIR), []);
  assert.deepEqual(L.packingWho(pkRow('a', 'Boots', []), PAIR), []);
  // the roster's spelling wins over the row's, so a case-only rename is not a
  // different person
  assert.deepEqual(L.packingWho(pkRow('a', 'Boots', ['alex']), PAIR), ['Alex']);
  assert.deepEqual(L.packingWho(pkRow('a', 'Boots', ['Sam', 'Sam']), PAIR), ['Sam']);
  // a name the trip does not carry cannot keep a row off the list it belongs on
  assert.deepEqual(L.packingWho(pkRow('a', 'Boots', ['Jordan']), PAIR), []);
  assert.deepEqual(L.packingWho(pkRow('a', 'Boots', ['Sam']), []), []);
  assert.deepEqual(L.packingWho(null, PAIR), []);
});

test('a traveller filter shows their rows AND everyone rows, never somebody else\'s', () => {
  const rows = [
    pkRow('a', 'Passport'),
    pkRow('b', 'Contact lenses', ['Alex']),
    pkRow('c', 'Retainer', ['Sam']),
    pkRow('d', 'Chargers', ['Alex', 'Sam']),
  ];
  assert.deepEqual(L.packingRowsFor(rows, 'Alex', PAIR).map(r => r.id), ['a', 'b', 'd']);
  assert.deepEqual(L.packingRowsFor(rows, 'sam', PAIR).map(r => r.id), ['a', 'c', 'd']);
  // no filter is the whole trip's list, and so is a filter naming somebody who
  // is no longer on the roster: a stale select must not empty the dialog
  assert.deepEqual(L.packingRowsFor(rows, '', PAIR).map(r => r.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(L.packingRowsFor(rows, 'Jordan', PAIR).map(r => r.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(L.packingRowsFor(null, 'Alex', PAIR), []);
});

test('the packed counter counts the rows the filter is showing, not the trip', () => {
  const rows = [
    pkRow('a', 'Passport', null, true),
    pkRow('b', 'Contact lenses', ['Alex'], true),
    pkRow('c', 'Retainer', ['Sam']),
    pkRow('d', 'Chargers', ['Alex']),
  ];
  assert.deepEqual(L.packingProgress(rows, '', PAIR), { done: 2, total: 4 });
  assert.deepEqual(L.packingProgress(rows, 'Alex', PAIR), { done: 2, total: 3 });
  assert.deepEqual(L.packingProgress(rows, 'Sam', PAIR), { done: 1, total: 2 });
  // a solo trip has no filter to apply, so it always counts the whole list
  assert.deepEqual(L.packingProgress(rows, 'Alex', []), { done: 2, total: 4 });
});

test('taking a name off the roster is counted BEFORE it is applied, in rows', () => {
  const rows = [
    pkRow('a', 'Passport'),
    pkRow('b', 'Contact lenses', ['Alex']),
    pkRow('c', 'Retainer', ['Sam']),
    pkRow('d', 'Chargers', ['Alex', 'Sam']),
  ];
  const drops = L.packingRosterDrops(rows, ['Alex', 'Jordan']);
  // the retainer was Sam's row and leaves with Sam; the chargers were shared, so
  // they stay and keep the name that is still on the trip
  assert.equal(drops.removed, 1);
  assert.equal(drops.untagged, 1);
  // and the sentence needs the name as the ROWS spell it
  assert.deepEqual(drops.names, [{ name: 'Sam', count: 2 }]);
  // a respelling carries every row over, so there is nobody to warn about
  assert.deepEqual(L.packingRosterDrops(rows, ['alex', 'SAM']).names, []);
  assert.deepEqual(L.packingRosterDrops(rows, ['alex', 'SAM']).removed, 0);
  // clearing the roster outright removes everybody, so every row that was one
  // person's row goes too - which is exactly what the warning then says
  const cleared = L.packingRosterDrops(rows, []);
  assert.deepEqual(cleared.names, [{ name: 'Alex', count: 2 }, { name: 'Sam', count: 2 }]);
  assert.equal(cleared.removed, 3);
});

test('the warning counts what saving actually does, not what it means to do', () => {
  // the counts are taken by running the edit on a copy, so they cannot promise
  // one number and do another. Dropping to ONE traveller retires the tag
  // entirely, which costs Alex's row its tag even though Alex is the one who
  // stayed, while Sam's row goes with Sam.
  const rows = [pkRow('b', 'Contact lenses', ['Alex']), pkRow('c', 'Retainer', ['Sam'])];
  const before = JSON.stringify(rows);
  const drops = L.packingRosterDrops(rows, ['Alex']);
  assert.equal(drops.removed, 1);
  assert.equal(drops.untagged, 1);
  assert.deepEqual(drops.names, [{ name: 'Sam', count: 1 }]);
  // counting is a read: the dialog is still open and nothing has been saved
  assert.equal(JSON.stringify(rows), before);
  // and the save then does exactly the numbers it promised
  assert.deepEqual(L.applyPackingRoster(rows, ['Alex']), { removed: drops.removed, untagged: drops.untagged });
  assert.deepEqual(rows.map(r => r.id), ['b']);
});

test('the warning cannot disagree with the save on any roster shrink', () => {
  // the one property the dialog rests on: whatever mix of rows a trip carries,
  // "removes N, untags M" is the same N and M the save then performs, and the
  // list shrinks by exactly N
  const build = () => [
    pkRow('a', 'Passport'),
    pkRow('b', 'Contact lenses', ['Alex']),
    pkRow('c', 'Retainer', ['Sam']),
    pkRow('d', 'Chargers', ['Alex', 'Sam']),
    pkRow('e', 'Trail shoes', ['Sam', 'Jordan']),
    pkRow('f', 'Passport wallet', ['Jordan']),
  ];
  for (const roster of [['Alex', 'Jordan'], ['Alex'], ['Alex', 'Sam', 'Jordan'], []]) {
    const counted = L.packingRosterDrops(build(), roster);
    const rows = build();
    const applied = L.applyPackingRoster(rows, roster);
    assert.deepEqual(applied, { removed: counted.removed, untagged: counted.untagged });
    assert.equal(rows.length, 6 - counted.removed);
  }
});

test('a packing row tagged only to the leaver is deleted, never kept for everyone', () => {
  // Sam leaves a three-person trip. Sam's retainer is not suddenly the trip's
  // retainer, so it goes; the shared charger stays under the names still on the
  // roster; and a row nobody was ever tagged to is not touched at all.
  const rows = [
    pkRow('a', 'Passport'),
    pkRow('b', 'Retainer', ['Sam']),
    pkRow('c', 'Chargers', ['Sam', 'Alex']),
    pkRow('d', 'Contact lenses', ['Alex']),
  ];
  const everyone = { ...rows[0] };
  assert.deepEqual(L.applyPackingRoster(rows, ['Alex', 'Jordan']), { removed: 1, untagged: 1 });
  assert.deepEqual(rows.map(r => r.id), ['a', 'c', 'd']);
  assert.deepEqual(rows[0], everyone);            // untouched: it was everyone's already
  assert.deepEqual(rows[1].who, ['Alex']);        // mixed tag keeps whoever is left
  assert.deepEqual(rows[2].who, ['Alex']);
  // and the deleted row is gone from the list, not hidden behind a filter
  assert.deepEqual(L.packingRowsFor(rows, 'Alex', ['Alex', 'Jordan']).map(r => r.id), ['a', 'c', 'd']);
  assert.deepEqual(L.packingRowsFor(rows, 'Jordan', ['Alex', 'Jordan']).map(r => r.id), ['a']);
});

test('a row already packed is deleted with its traveller like any other', () => {
  // ticking the box records that it is in the bag, not that the row is load
  // bearing: it cannot outlive the only person it was ever for
  const rows = [pkRow('a', 'Retainer', ['Sam'], true), pkRow('b', 'Passport', null, true)];
  assert.deepEqual(L.applyPackingRoster(rows, ['Alex', 'Jordan']), { removed: 1, untagged: 0 });
  assert.deepEqual(rows.map(r => r.id), ['b']);
  assert.deepEqual(L.packingProgress(rows, '', ['Alex', 'Jordan']), { done: 1, total: 1 });
});

test('applying the roster re-spells the tags it keeps and drops the ones it cannot', () => {
  const rows = [
    pkRow('a', 'Passport'),
    pkRow('b', 'Contact lenses', ['alex']),
    pkRow('c', 'Retainer', ['Sam']),
    pkRow('d', 'Chargers', ['Alex', 'Sam']),
  ];
  assert.deepEqual(L.applyPackingRoster(rows, ['Alex', 'Jordan']), { removed: 1, untagged: 2 });
  assert.equal(rows[0].who, undefined);          // untouched: it was everyone's already
  assert.deepEqual(rows[1].who, ['Alex']);       // re-spelled to the roster
  assert.deepEqual(rows[2].who, ['Alex']);       // Sam is gone; Alex still has the chargers
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'd']);
  // a row naming EVERYBODY is the same row as one naming nobody, and is stored
  // as untagged so a traveller joining later is not silently left off it
  const all = [pkRow('e', 'Snacks', ['Alex', 'Sam'])];
  assert.deepEqual(L.applyPackingRoster(all, PAIR), { removed: 0, untagged: 1 });
  assert.equal(all[0].who, undefined);
  // and an empty tag was Everyone all along, so it is normalised, never deleted
  const blank = [pkRow('f', 'Snacks', [])];
  assert.deepEqual(L.applyPackingRoster(blank, PAIR), { removed: 0, untagged: 0 });
  assert.deepEqual(blank.map(r => r.id), ['f']);
  assert.equal(blank[0].who, undefined);
});

test('dropping to a solo roster leaves the packing list with no tags at all', () => {
  // below two travellers the app offers no tag control anywhere, so a tag left
  // behind would be invisible state deciding what a filter shows later. Alex's
  // row survives untagged because Alex is who is left; Sam's row leaves with Sam.
  const rows = [pkRow('a', 'Boots', ['Alex']), pkRow('b', 'Retainer', ['Sam'])];
  L.applyPackingRoster(rows, ['Alex']);
  assert.deepEqual(rows.map(r => r.id), ['a']);
  assert.equal(rows[0].who, undefined);
  assert.deepEqual(L.packingProgress(rows, '', []), { done: 0, total: 1 });
});

// ---------- reusable trip templates ----------
// A template keeps the SHAPE and drops the booking. Everything below is a fact
// that was true of one trip and would be a lie about the next one.

function bookedTrip() {
  return {
    id: 't1', name: 'Kyoto in spring', currency: 'JPY', budget: 4000, budgetFrom: 3000, travelers: ['Alex', 'Sam'],
    packing: [{ id: 'p1', text: 'Passport', done: true }],
    items: [
      {
        id: 'i1', type: 'flight', title: 'BOS to KIX', location: 'Boston', status: 'booked',
        startDate: '2026-04-02', endDate: '2026-04-03', startTime: '18:30',
        cost: 980, costCurrency: 'USD', costNote: 'each', estCost: 1100, estCostCurrency: 'USD',
        confirmation: 'XY7Q2R', bookBy: '2026-01-15', payment: 'card',
        paidBy: 'Alex', travelers: ['Alex'], splitAmounts: { Alex: 980 },
        details: 'Aisle seats', mapsQuery: 'Logan Airport',
      },
      {
        id: 'i2', type: 'stay', title: 'Machiya near Gion', location: 'Kyoto', status: 'decide',
        startDate: '2026-04-03', endDate: '2026-04-09', cost: 1200, confirmation: 'HTL-88', paidBy: 'Sam',
      },
    ],
  };
}

test('a template keeps the plan and clears every booking fact on it', () => {
  const tpl = L.tripAsTemplate(bookedTrip());
  // the shape: same items, same titles, same types, same dates
  assert.deepEqual(tpl.items.map(i => i.title), ['BOS to KIX', 'Machiya near Gion']);
  assert.deepEqual(tpl.items.map(i => i.type), ['flight', 'stay']);
  assert.deepEqual(tpl.items.map(i => i.startDate), ['2026-04-02', '2026-04-03']);
  assert.equal(tpl.items[0].startTime, '18:30');
  assert.equal(tpl.items[0].details, 'Aisle seats');
  assert.equal(tpl.items[0].location, 'Boston');
  // and none of the booking
  for (const it of tpl.items) {
    assert.equal(it.status, 'to-book');
    for (const k of L.TEMPLATE_CLEARED) assert.equal(k in it, false, `${it.title} still carries ${k}`);
  }
  // the trip's own settings are not a booking fact, so they survive, and a
  // budget travels as the whole range it was set as
  assert.equal(tpl.currency, 'JPY');
  assert.equal(tpl.budget, 4000);
  assert.equal(tpl.budgetFrom, 3000);
  assert.deepEqual(tpl.travelers, ['Alex', 'Sam']);
});

test('the cost column of a template is BLANK, estimates included', () => {
  // a leftover estCost renders as "~$1,100" in the same cell the cost would
  // have used, so clearing `cost` alone would leave last year's price on screen
  const it = L.tripAsTemplate(bookedTrip()).items[0];
  assert.equal(L.displayCostOf(it), null);
  assert.equal(L.hasEstimate(it), false);
  // and with nothing to show, nothing is shown as an estimate either
  assert.equal(L.costDisplayParts(it).est, false);
  assert.equal(L.costDisplayParts(it).tilde, '');
});

test('a template keeps the packing list but not which boxes were ticked', () => {
  const source = bookedTrip();
  source.packing = [
    { id: 'p1', text: 'Passport or photo ID', done: true },
    { id: 'p2', text: 'Hiking boots', done: false, who: ['Alex'] },
    { id: 'p3', text: 'Sunscreen', done: true, who: ['Sam'] },
  ];
  const tpl = L.tripAsTemplate(source);
  // the rows survive, in order, with their per-traveller tags intact: the list
  // itself is part of the shape being reused
  assert.deepEqual(tpl.packing.map(r => r.text), ['Passport or photo ID', 'Hiking boots', 'Sunscreen']);
  assert.deepEqual(tpl.packing.map(r => r.who || null), [null, ['Alex'], ['Sam']]);
  // but nothing is pre-packed for a trip that has not happened yet
  assert.deepEqual(tpl.packing.map(r => r.done), [false, false, false]);
  // and the source keeps its own progress
  assert.deepEqual(source.packing.map(r => r.done), [true, false, true]);
});

test('a template of a trip that never opened its packing list stays without one', () => {
  const source = bookedTrip();
  delete source.packing;
  const tpl = L.tripAsTemplate(source);
  assert.equal('packing' in tpl, false);
});

test('building a template does not touch the trip it was built from', () => {
  const source = bookedTrip();
  const before = JSON.stringify(source);
  L.tripAsTemplate(source);
  assert.equal(JSON.stringify(source), before);
});

// ---------- moving a whole trip in time ----------
// One piece of arithmetic behind two dialogs: "Shift entire trip" (a number of
// days) and a template being given a new start date (a destination). They must
// not be able to disagree about what moves or about what is refused.

test('the first dated item is the day the plan begins, whatever order it is stored in', () => {
  assert.equal(L.firstItemDate([
    { id: 'a', startDate: '2026-04-09' },
    { id: 'b', startDate: '2026-04-02' },
    { id: 'c', startDate: '' },
  ]), '2026-04-02');
  // an undated trip has no anchor to measure a shift from
  assert.equal(L.firstItemDate([{ id: 'a', startDate: '' }]), null);
  assert.equal(L.firstItemDate([]), null);
  assert.equal(L.firstItemDate(null), null);
});

test('a new start date is the same move as a shift, expressed as a destination', () => {
  const items = [{ id: 'a', startDate: '2026-04-02' }, { id: 'b', startDate: '2026-04-09' }];
  assert.deepEqual(L.startDateShift(items, '2027-04-02'), { from: '2026-04-02', days: 365 });
  assert.deepEqual(L.startDateShift(items, '2026-03-30'), { from: '2026-04-02', days: -3 });
  // the same date is not a move, and the dialog treats a 0-day delta as "keep
  // these dates" rather than as an edit
  assert.equal(L.startDateShift(items, '2026-04-02').days, 0);
  assert.equal(L.startDateShift(items, 'not-a-date'), null);
  assert.equal(L.startDateShift([], '2027-04-02'), null);
});

test('a shift moves both dates on every item and keeps the gaps between them', () => {
  const items = [
    { id: 'a', startDate: '2026-04-02', endDate: '2026-04-03' },
    { id: 'b', startDate: '2026-04-03', endDate: '2026-04-09' },
    { id: 'c', startDate: '', endDate: '' },
  ];
  const plan = L.startDateShift(items, '2027-05-10');
  assert.equal(L.applyDayShift(items, plan.days), 2);
  assert.equal(items[0].startDate, '2027-05-10');
  assert.equal(items[1].startDate, '2027-05-11');
  assert.equal(items[1].endDate, '2027-05-17');
  // the spacing is what a template is FOR: 7 nights before, 7 nights after
  assert.equal(L.diffDays(items[1].startDate, items[1].endDate), 6);
  assert.equal(items[2].startDate, '');
});

test('a shift that would leave the calendar is refused before anything moves', () => {
  const items = [{ id: 'a', startDate: '2100-12-30', endDate: '2100-12-31' }];
  assert.equal(L.shiftFits(items, 1), false);
  assert.equal(L.shiftFits(items, -1), true);
  assert.equal(L.shiftFits([{ id: 'a', startDate: '2000-01-02' }], -2), false);
  // a date that is out of range ALREADY arrived by import or share link: it is
  // left alone rather than freezing every other date on the trip
  assert.equal(L.shiftFits([{ id: 'a', startDate: '1998-06-01' }], 5), true);
  assert.equal(L.shiftFits([{ id: 'a', startDate: '' }], 5), true);
});

// ---------- booking deadlines ----------
// The rule under all of these: a deadline is a TASK, and only a "to book" item
// with a real date of its own can still carry one. Everything else stored on an
// item is history, and history must not nag.

function toBook(id, bookBy, startDate = '2027-05-20', extra) {
  return { id, type: 'activity', title: id, startDate, status: 'to-book', bookBy, ...(extra || {}) };
}

test('a deadline inside the seven-day window is due, with the days left counted', () => {
  const rows = L.bookingDeadlines([toBook('Sumo tickets', '2027-05-05')], '2027-05-02');
  assert.deepEqual(rows, [{ id: 'Sumo tickets', title: 'Sumo tickets', date: '2027-05-05', daysLeft: 3, kind: 'due' }]);
});

test('exactly seven days out is inside the window, eight days out is not', () => {
  const items = [toBook('seven', '2027-05-09'), toBook('eight', '2027-05-10')];
  const rows = L.bookingDeadlines(items, '2027-05-02');
  assert.deepEqual(rows.map(r => [r.id, r.daysLeft, r.kind]), [['seven', 7, 'due']]);
});

test('the deadline falling today is still due, with zero days left', () => {
  const rows = L.bookingDeadlines([toBook('today', '2027-05-02')], '2027-05-02');
  assert.deepEqual(rows.map(r => [r.daysLeft, r.kind]), [[0, 'due']]);
});

test('a deadline already behind us is passed, and says how far behind', () => {
  const rows = L.bookingDeadlines([toBook('missed', '2027-04-20')], '2027-05-02');
  assert.deepEqual(rows.map(r => [r.kind, r.daysLeft]), [['passed', -12]]);
});

test('only a "to book" item can carry a live deadline', () => {
  const dates = { bookBy: '2027-05-05', startDate: '2027-05-20' };
  const items = [
    { id: 'a', type: 'activity', title: 'booked', status: 'booked', ...dates },
    { id: 'b', type: 'activity', title: 'later', status: 'decide', ...dates },
    { id: 'c', type: 'activity', title: 'off', status: 'cancelled', ...dates },
    { id: 'd', type: 'activity', title: 'live', status: 'to-book', ...dates },
  ];
  assert.deepEqual(L.bookingDeadlines(items, '2027-05-02').map(r => r.id), ['d']);
  // and the same holds once the date is behind us: a booked item is not late
  assert.deepEqual(L.bookingDeadlines(items, '2027-05-10').map(r => r.id), ['d']);
});

test('an item with no date of its own raises no deadline, matching validateItem', () => {
  assert.deepEqual(L.bookingDeadlines([toBook('no date', '2027-05-05', '')], '2027-05-02'), []);
  assert.deepEqual(L.bookingDeadlines([toBook('junk date', '2027-05-05', 'soon')], '2027-05-02'), []);
});

test('no deadline stored means no deadline reported: the field is opt-in', () => {
  const items = [
    { id: 'a', type: 'flight', title: 'SHV to HND', startDate: '2027-05-20', status: 'to-book' },
    toBook('blank', '', '2027-05-20'),
    toBook('junk', 'next week', '2027-05-20'),
  ];
  assert.deepEqual(L.bookingDeadlines(items, '2027-05-02'), []);
});

test('every late booking gets its own line, soonest deadline first, never a count', () => {
  const items = [
    toBook('c', '2027-05-04'),
    toBook('a', '2027-04-28'),
    toBook('b', '2027-05-01'),
  ];
  const rows = L.bookingDeadlines(items, '2027-05-02');
  assert.deepEqual(rows.map(r => [r.id, r.kind]), [['a', 'passed'], ['b', 'passed'], ['c', 'due']]);
});

test('a nonsense today reports nothing rather than guessing at one', () => {
  assert.deepEqual(L.bookingDeadlines([toBook('a', '2027-05-05')], ''), []);
  assert.deepEqual(L.bookingDeadlines(undefined, '2027-05-02'), []);
});

// ---------- pace ----------
// The rule under all of these: this is an OBSERVATION, so it only speaks when
// the arithmetic is worth a sentence (enough stays to average, and an average
// short enough that the trip really is a run of one-night stops), and the
// figures it hands over are the ones nights() gives the strip - never a second
// count of the same nights.

// one stay per entry: `spans` is the nights each stay covers, laid end to end
// from a fixed start so the dates stay real however long the run gets
function paceStays(spans, status = 'booked') {
  let start = '2027-05-01';
  return spans.map((n, i) => {
    const end = L.addDays(start, n);
    const row = stay(`s${i}`, `city${i}`, start, end, status);
    start = end;
    return row;
  });
}

test('four stays averaging under two nights is a fast pace, with both figures', () => {
  const pace = L.paceAdvisory(paceStays([1, 1, 2, 1]));
  assert.deepEqual(pace, { stays: 4, nights: 5, avg: 1.3 });
});

test('four stays is the floor: three one-night stops say nothing', () => {
  assert.equal(L.paceAdvisory(paceStays([1, 1, 1])), null);
  assert.equal(L.paceAdvisory(paceStays([1, 1, 1, 1])).stays, 4);
});

test('an average of exactly two nights is not fast', () => {
  assert.equal(L.paceAdvisory(paceStays([2, 2, 2, 2])), null);
  // and the same total spread so it lands just under the line does speak
  assert.equal(L.paceAdvisory(paceStays([1, 2, 2, 2])).avg, 1.8);
});

test('an average that would PRINT as 2.0 says nothing, so the line cannot contradict itself', () => {
  // 39 nights over 20 stays is 1.95, which rounds to the 2.0 the sentence would
  // print under the word "Fast"
  const spans = [...Array(19).fill(2), 1];
  const stays = paceStays(spans);
  assert.equal(stays.length, 20);
  assert.equal(L.paceAdvisory(stays), null);
});

test('a cancelled stay is off the trip, so it is in neither the count nor the average', () => {
  const live = paceStays([1, 1, 1, 1]);
  const dead = paceStays([9, 9], 'cancelled');
  assert.deepEqual(L.paceAdvisory([...live, ...dead]), { stays: 4, nights: 4, avg: 1 });
  // and dropping to three live stays takes the whole line away, however many
  // cancelled ones are left lying around
  assert.equal(L.paceAdvisory([...live.slice(0, 3), ...dead]), null);
});

test('only what nights() calls a stay is counted, so the figures match the strip', () => {
  const items = [
    ...paceStays([1, 1, 1, 1]),
    flight('f1', 'SIN to BKK', '2027-05-01', '2027-05-02'),
    stay('same-day', 'daybed', '2027-05-20', '2027-05-20'),
    stay('undated', 'nowhere', '', ''),
  ];
  const pace = L.paceAdvisory(items);
  assert.deepEqual(pace, { stays: 4, nights: 4, avg: 1 });
  const strip = items.map(L.nights).filter(n => n != null);
  assert.equal(strip.length, pace.stays);
  assert.equal(strip.reduce((a, b) => a + b, 0), pace.nights);
});

test('the average is rounded to the one decimal the line prints', () => {
  // 10 nights over 6 stays is 1.666..., and the sentence says 1.7
  assert.equal(L.paceAdvisory(paceStays([1, 1, 2, 2, 2, 2])).avg, 1.7);
});

test('no items at all is not a pace', () => {
  assert.equal(L.paceAdvisory([]), null);
  assert.equal(L.paceAdvisory(undefined), null);
});

test('validateItem rejects a deadline dated after the item it books', () => {
  const late = L.validateItem({ title: 'Sumo', startDate: '2027-05-20', bookBy: '2027-05-21' });
  assert.equal(typeof late.bookBy, 'string');
  // the same day is fine (book it on the morning of), and so is earlier
  assert.equal(L.validateItem({ title: 'Sumo', startDate: '2027-05-20', bookBy: '2027-05-20' }).bookBy, undefined);
  assert.equal(L.validateItem({ title: 'Sumo', startDate: '2027-05-20', bookBy: '2027-04-01' }).bookBy, undefined);
  // no item date means nothing to bound it against, so no second complaint on
  // top of the missing-date one
  assert.deepEqual(Object.keys(L.validateItem({ title: 'Sumo', startDate: '', bookBy: '2027-05-21' })), ['start']);
  // and an item that never had the field is untouched by any of it
  assert.deepEqual(L.validateItem({ title: 'Sumo', startDate: '2027-05-20' }), {});
});

// ---------- cash needed, per currency ----------
// The rule under all of these: this block answers "how much of THIS currency do
// I have to carry", so it never converts, never invents a row for a currency
// nobody tagged, and never hides an amount because it nets out awkwardly.

function cash(id, cost, costCurrency, extra) {
  return { id, type: 'activity', title: id, startDate: '2027-05-01', status: 'to-book', payment: 'cash', cost, costCurrency, ...(extra || {}) };
}

test('cashNeeded sums the cash-tagged costs per currency, in that currency', () => {
  const trip = { currency: 'USD', items: [cash('a', 12000, 'JPY'), cash('b', 3000, 'JPY'), cash('c', 40, 'USD')] };
  assert.deepEqual(L.cashNeeded(trip), [{ currency: 'JPY', total: 15000 }, { currency: 'USD', total: 40 }]);
});

test('cash rows sort by currency code, not by size or entry order', () => {
  const trip = { currency: 'USD', items: [cash('a', 5, 'USD'), cash('b', 900, 'THB'), cash('c', 20, 'EUR')] };
  assert.deepEqual(L.cashNeeded(trip).map(r => r.currency), ['EUR', 'THB', 'USD']);
});

test('an untagged item is not cash, whatever else it is', () => {
  const trip = {
    currency: 'USD',
    items: [
      { id: 'a', type: 'activity', title: 'a', startDate: '2027-05-01', status: 'booked', cost: 100 },
      { id: 'b', type: 'activity', title: 'b', startDate: '2027-05-01', status: 'booked', cost: 50, payment: 'card' },
      { id: 'c', type: 'activity', title: 'c', startDate: '2027-05-01', status: 'booked', cost: 25, payment: 'prepaid' },
    ],
  };
  assert.deepEqual(L.cashNeeded(trip), []);
});

test('a cancelled cash item leaves no trace, and takes its row with it', () => {
  const trip = { currency: 'USD', items: [cash('a', 12000, 'JPY', { status: 'cancelled' })] };
  assert.deepEqual(L.cashNeeded(trip), []);
  const mixed = { currency: 'USD', items: [cash('a', 12000, 'JPY', { status: 'cancelled' }), cash('b', 3000, 'JPY')] };
  assert.deepEqual(L.cashNeeded(mixed), [{ currency: 'JPY', total: 3000 }]);
});

test('a cash item with no cost contributes nothing and cannot conjure a row', () => {
  const trip = { currency: 'USD', items: [cash('a', null, 'JPY'), cash('b', '', 'JPY'), cash('c', 'free', 'JPY')] };
  assert.deepEqual(L.cashNeeded(trip), []);
});

test('a cash refund nets into its currency, even down to zero or below', () => {
  const zeroed = { currency: 'USD', items: [cash('a', 100, 'EUR'), cash('b', -100, 'EUR')] };
  assert.deepEqual(L.cashNeeded(zeroed), [{ currency: 'EUR', total: 0 }]);
  const negative = { currency: 'USD', items: [cash('a', 40, 'EUR'), cash('b', -100, 'EUR')] };
  assert.deepEqual(L.cashNeeded(negative), [{ currency: 'EUR', total: -60 }]);
});

test('a cash item with no currency of its own counts in the trip currency', () => {
  const trip = { currency: 'THB', items: [cash('a', 500), cash('b', 20, 'USD')] };
  assert.deepEqual(L.cashNeeded(trip), [{ currency: 'THB', total: 500 }, { currency: 'USD', total: 20 }]);
  // and with no trip currency either, the same USD default every total uses
  assert.deepEqual(L.cashNeeded({ items: [cash('a', 500)] }), [{ currency: 'USD', total: 500 }]);
});

test('cash totals are rounded to cents, so a row never prints float dust', () => {
  const trip = { currency: 'USD', items: [cash('a', 0.1, 'USD'), cash('b', 0.2, 'USD')] };
  assert.deepEqual(L.cashNeeded(trip), [{ currency: 'USD', total: 0.3 }]);
});

test('cash is counted whatever the booking status, except cancelled', () => {
  const trip = {
    currency: 'JPY',
    items: [cash('a', 100, 'JPY', { status: 'booked' }), cash('b', 200, 'JPY', { status: 'decide' }), cash('c', 400, 'JPY')],
  };
  assert.deepEqual(L.cashNeeded(trip), [{ currency: 'JPY', total: 700 }]);
});

test('cashNeeded survives an empty or absent trip', () => {
  assert.deepEqual(L.cashNeeded({ items: [] }), []);
  assert.deepEqual(L.cashNeeded({}), []);
  assert.deepEqual(L.cashNeeded(null), []);
});

// ---------- bookBy / payment reach every export ----------
// Both fields already survive the JSON export because sanitizeItem accepts
// them. Share links, CSV and ICS each dropped them silently, which is the worst
// kind of data loss: the traveller has no way to notice.

function bookedItem(extra) {
  return { id: 'x1', type: 'activity', title: 'Museum', location: 'Rome', startDate: '2027-03-01',
    endDate: '', startTime: '', endTime: '', status: 'to-book', cost: 40, costCurrency: 'EUR',
    costNote: '', confirmation: '', details: '', bookBy: '', createdAt: '2026-07-18T00:00:00Z', ...extra };
}

test('slimTripForShare carries the booking deadline and the payment tag', () => {
  const trip = { name: 'T', currency: 'USD', items: [bookedItem({ bookBy: '2027-02-10', payment: 'prepaid' })] };
  const slim = L.slimTripForShare(trip);
  assert.equal(slim.items[0].bookBy, '2027-02-10');
  assert.equal(slim.items[0].payment, 'prepaid');
});

test('a share payload omits both fields when neither is set, never an empty string', () => {
  const slim = L.slimTripForShare({ name: 'T', currency: 'USD', items: [bookedItem()] });
  assert.equal('bookBy' in slim.items[0], false);
  assert.equal('payment' in slim.items[0], false);
  // an item tagged Not tracked stores no `payment` at all; an explicit empty
  // one (hand-edited JSON, an older export) must not leak into the URL either
  const blanked = L.slimTripForShare({ name: 'T', currency: 'USD', items: [bookedItem({ payment: '' })] });
  assert.equal('payment' in blanked.items[0], false);
});

test('a trip using neither field shares byte-for-byte the payload it did before', () => {
  // The fragment carries the whole trip, warns past 8k and is refused past 30k,
  // so "two more optional fields" may not cost a single byte on a trip that
  // never uses them. This literal is the pre-change output, captured before the
  // fields were added to the keep list.
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'f9b2c8d1-aaaa-bbbb-cccc-1234567890ab', type: 'flight', title: 'A to B', location: 'JFK',
      startDate: '2027-03-01', endDate: '', startTime: '07:35', endTime: '', status: 'to-book',
      cost: 200, costCurrency: 'USD', costNote: '', confirmation: 'XJ7K2Q', details: '',
      bookBy: '', createdAt: '2026-07-18T00:00:00Z' },
  ] };
  assert.equal(
    JSON.stringify(L.slimTripForShare(trip)),
    '{"name":"T","currency":"USD","items":[{"id":"i1","type":"flight","title":"A to B","location":"JFK","startDate":"2027-03-01","startTime":"07:35","status":"to-book","cost":200,"costCurrency":"USD","confirmation":"XJ7K2Q"}]}',
  );
});

// The link itself: slim -> JSON -> deflate -> base64url, and back. Same steps
// and the same exported helpers shareTrip/decodeShare use in app.js, so this is
// the real wire format rather than a stand-in for it.
async function through(Ctor, bytes) {
  const s = new Ctor('deflate');
  const w = s.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(s.readable).arrayBuffer());
}

test('both fields survive the real share link round trip and the receiver guards', async () => {
  const trip = { name: 'T', currency: 'USD', items: [bookedItem({ bookBy: '2027-02-10', payment: 'cash' })] };
  const json = JSON.stringify({ version: 1, trip: L.slimTripForShare(trip) });
  const link = L.bytesToBase64url(await through(CompressionStream, new TextEncoder().encode(json)));
  const back = JSON.parse(new TextDecoder().decode(await through(DecompressionStream, L.base64urlToBytes(link))));
  const item = back.trip.items[0];
  assert.equal(item.bookBy, '2027-02-10');
  assert.equal(item.payment, 'cash');
  // sanitizeItem (app.js) clears a bookBy that is not a real date and drops a
  // payment outside the picker's three, so a payload that failed either guard
  // would arrive stripped even though it travelled intact
  assert.equal(L.isIsoDate(item.bookBy), true);
  assert.ok(['cash', 'card', 'prepaid'].includes(item.payment));
  // and the deadline is still actionable on the far side
  assert.deepEqual(L.bookingDeadlines([{ ...item, id: 'x1' }], '2027-02-08'),
    [{ id: 'x1', title: 'Museum', date: '2027-02-10', daysLeft: 2, kind: 'due' }]);
});

test('buildCsv appends bookBy and paymentMethod LAST, leaving every prior column where it was', () => {
  const cols = L.csvColumns('USD');
  assert.deepEqual(cols.slice(-2), ['bookBy', 'paymentMethod']);
  // the columns a spreadsheet may already be built against keep their indexes
  assert.equal(cols.indexOf('cost'), 10);
  assert.equal(cols.indexOf('confirmation'), 16);
  assert.equal(cols.indexOf('travelers'), 17);
});

test('CSV prints the payment wording a person reads, not the stored token', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    bookedItem({ id: 'a', bookBy: '2027-02-10', payment: 'prepaid' }),
    bookedItem({ id: 'b', startDate: '2027-03-02', payment: 'cash' }),
    bookedItem({ id: 'c', startDate: '2027-03-03', payment: 'card' }),
  ] };
  const rows = parseCsv(L.buildCsv(trip, 'USD', null));
  const head = rows[0];
  const bookByCol = head.indexOf('bookBy'), payCol = head.indexOf('paymentMethod');
  assert.equal(rows[1][bookByCol], '2027-02-10');
  assert.deepEqual(rows.slice(1).map(r => r[payCol]), ['Prepaid / already paid', 'Cash', 'Card']);
  assert.ok(!/"prepaid"/.test(L.buildCsv(trip, 'USD', null)));
});

test('an item using neither field gets two empty cells, not the word undefined', () => {
  const trip = { name: 'T', currency: 'USD', items: [bookedItem()] };
  const csv = L.buildCsv(trip, 'USD', null);
  assert.ok(!/undefined/.test(csv));
  const rows = parseCsv(csv);
  assert.equal(rows[1][rows[0].indexOf('bookBy')], '');
  assert.equal(rows[1][rows[0].indexOf('paymentMethod')], '');
  assert.ok(csv.endsWith(',"",""'));
});

test('a comma and a quote earlier in the row cannot shift the two new columns', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    bookedItem({ title: 'Dinner: Ki"chi, Rome', costNote: 'split, later', bookBy: '2027-02-10', payment: 'cash' }),
  ] };
  const rows = parseCsv(L.buildCsv(trip, 'USD', null));
  const head = rows[0];
  assert.equal(rows[1].length, head.length);
  assert.equal(rows[1][head.indexOf('title')], 'Dinner: Ki"chi, Rome');
  assert.equal(rows[1][head.indexOf('bookBy')], '2027-02-10');
  assert.equal(rows[1][head.indexOf('paymentMethod')], 'Cash');
});

function icsDesc(item) {
  return L.buildIcs({ name: 'T', items: [item] }).split('\r\n').find(l => l.startsWith('DESCRIPTION:'));
}

test('the calendar entry carries the deadline and the payment, as readable text', () => {
  const desc = icsDesc(bookedItem({ confirmation: 'XJ7K2Q', bookBy: '2027-02-10', payment: 'prepaid', costNote: 'cash, on arrival' }));
  // a raw ISO string in the middle of a sentence is not what a calendar shows
  assert.ok(!desc.includes('2027-02-10'));
  assert.equal(desc, 'DESCRIPTION:Ref: XJ7K2Q\\nStatus: To book\\nBook by: February 10\\, 2027\\nPayment: Prepaid / already paid\\ncash\\, on arrival');
});

test('each ICS line appears only with its own field', () => {
  const onlyDeadline = icsDesc(bookedItem({ bookBy: '2027-02-10' }));
  assert.ok(onlyDeadline.includes('Book by: February 10'));
  assert.ok(!onlyDeadline.includes('Payment:'));
  const onlyPayment = icsDesc(bookedItem({ payment: 'card' }));
  assert.ok(onlyPayment.includes('Payment: Card'));
  assert.ok(!onlyPayment.includes('Book by:'));
});

test('an item with neither field has exactly the description it had before', () => {
  // pre-change output, captured before the two lines were added
  const desc = icsDesc(bookedItem({ confirmation: 'XJ7K2Q', costNote: 'cash, on arrival' }));
  assert.equal(desc, 'DESCRIPTION:Ref: XJ7K2Q\\nStatus: To book\\ncash\\, on arrival');
});

// ---------- uneven cost splits ----------
// The point of every case below: an even divide is a GUESS about who owed what,
// and it is the wrong guess exactly when the settle-up ledger matters most (one
// person's upgrade, one person covering the table). A hand-entered split is a
// CLAIM, so it may only be spent while it still adds up to the money that was
// actually spent; the moment it stops describing the item, the even divide,
// unchanged and byte for byte what it always was, has to take back over.

function split(id, cost, travelers, amounts, extra) {
  return {
    id, type: 'activity', title: id, startDate: '2027-05-01', status: 'booked',
    cost, travelers, splitAmounts: amounts, ...(extra || {}),
  };
}

test('evenSplitAmounts divides to the cent and always adds back up to the cost', () => {
  assert.deepEqual(L.evenSplitAmounts(100, ['Alex', 'Sam']), { Alex: 50, Sam: 50 });
  // three 33.33s leave a cent nobody owes, which is a default that cannot be saved
  const three = L.evenSplitAmounts(100, ['Alex', 'Sam', 'Jo']);
  assert.deepEqual(three, { Alex: 33.34, Sam: 33.33, Jo: 33.33 });
  assert.equal(L.splitAmountsSum(three, ['Alex', 'Sam', 'Jo']), 100);
  // the odd cents land in roster order, so the same item always opens the same
  const two = L.evenSplitAmounts(0.01, ['Alex', 'Sam']);
  assert.deepEqual(two, { Alex: 0.01, Sam: 0 });
});

test('evenSplitAmounts splits a refund the same way it splits a charge', () => {
  const r = L.evenSplitAmounts(-100, ['Alex', 'Sam', 'Jo']);
  assert.deepEqual(r, { Alex: -33.34, Sam: -33.33, Jo: -33.33 });
  assert.equal(L.splitAmountsSum(r, ['Alex', 'Sam', 'Jo']), -100);
});

test('evenSplitAmounts has nothing to divide with no cost or nobody to divide it among', () => {
  assert.deepEqual(L.evenSplitAmounts(100, []), {});
  assert.deepEqual(L.evenSplitAmounts(null, ['Alex', 'Sam']), {});
  assert.deepEqual(L.evenSplitAmounts('', ['Alex', 'Sam']), {});
  assert.deepEqual(L.evenSplitAmounts('abc', ['Alex', 'Sam']), {});
});

test('splitAmountsMatch compares to the CENT, so binary float noise never blocks a save', () => {
  // 70.1 + 29.9 is 100.00000000000001 added as floats
  assert.equal(L.splitAmountsMatch(100, { Alex: 70.1, Sam: 29.9 }, ['Alex', 'Sam']), true);
  assert.equal(L.splitAmountsMatch(100, { Alex: 70, Sam: 30 }, ['Alex', 'Sam']), true);
  // and one cent out is out: the boundary is exact, not fuzzy
  assert.equal(L.splitAmountsMatch(100, { Alex: 70, Sam: 29.99 }, ['Alex', 'Sam']), false);
  assert.equal(L.splitAmountsMatch(100, { Alex: 70, Sam: 30.01 }, ['Alex', 'Sam']), false);
  // a blank or junk entry is not a zero, it is an unfinished split
  assert.equal(L.splitAmountsMatch(100, { Alex: 100, Sam: '' }, ['Alex', 'Sam']), false);
  assert.equal(L.splitAmountsMatch(100, { Alex: 100 }, ['Alex', 'Sam']), false);
  assert.equal(L.splitAmountsSum({ Alex: 'abc', Sam: 30 }, ['Alex', 'Sam']), null);
});

test('customSplitShares pays out a 70/30 split exactly as it was entered', () => {
  const item = split('a', 100, ['Alex', 'Sam'], { Alex: 70, Sam: 30 });
  assert.deepEqual(L.customSplitShares(item, ['Alex', 'Sam']), { Alex: 70, Sam: 30 });
});

test('customSplitShares refuses a split that no longer describes the item', () => {
  const names = ['Alex', 'Sam', 'Jo'];
  // the cost was edited elsewhere and the amounts no longer add up to it
  assert.equal(L.customSplitShares(split('a', 120, ['Alex', 'Sam'], { Alex: 70, Sam: 30 }), names), null);
  // a traveller was dropped from the trip, so one amount now belongs to nobody
  assert.equal(L.customSplitShares(split('b', 100, ['Alex', 'Ghost'], { Alex: 70, Ghost: 30 }), names), null);
  // an amount is missing for somebody the item is assigned to
  assert.equal(L.customSplitShares(split('c', 100, names, { Alex: 70, Sam: 30 }), names), null);
  // an extra amount for somebody the item is not assigned to
  assert.equal(L.customSplitShares(split('d', 100, ['Alex', 'Sam'], { Alex: 70, Sam: 30, Jo: 0 }), names), null);
  // junk from a hand-edited import
  assert.equal(L.customSplitShares(split('e', 100, ['Alex', 'Sam'], { Alex: 'seventy', Sam: 30 }), names), null);
  assert.equal(L.customSplitShares(split('f', 100, ['Alex', 'Sam'], 'nope'), names), null);
});

test('customSplitShares needs a cost and 2+ NAMED travellers, never "Everyone"', () => {
  const names = ['Alex', 'Sam'];
  // no cost: nothing to split
  assert.equal(L.customSplitShares(split('a', null, names, { Alex: 70, Sam: 30 }), names), null);
  assert.equal(L.customSplitShares(split('b', '', names, { Alex: 70, Sam: 30 }), names), null);
  // "Everyone" (no assignment) has no fixed roster to key amounts by
  assert.equal(L.customSplitShares(split('c', 100, undefined, { Alex: 70, Sam: 30 }), names), null);
  assert.equal(L.customSplitShares(split('d', 100, [], { Alex: 70, Sam: 30 }), names), null);
  // one person owes the whole thing: there is nothing to divide unevenly
  assert.equal(L.customSplitShares(split('e', 100, ['Alex'], { Alex: 100 }), names), null);
  // and an item that never carried a split is untouched
  assert.equal(L.customSplitShares({ id: 'f', cost: 100, travelers: names }, names), null);
});

test('travelerTotals spends a 70/30 split instead of dividing, and settle up follows it', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [split('a', 100, ['Alex', 'Sam'], { Alex: 70, Sam: 30 }, { paidBy: 'Alex' })],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 70, Sam: 30 });
  // Alex paid 100 and owed 70, so Sam owes 30, NOT the 50 an even divide claims
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 30 }]);
});

test('a split reverted to even is byte for byte the old even divide', () => {
  const custom = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [split('a', 100, ['Alex', 'Sam'], { Alex: 70, Sam: 30 }, { paidBy: 'Alex' })],
  };
  // reverting is the ABSENCE of the key, which is what the form saves
  const even = { ...custom, items: [{ ...custom.items[0], splitAmounts: undefined }] };
  delete even.items[0].splitAmounts;
  assert.deepEqual(L.travelerTotals(even), { Alex: 50, Sam: 50 });
  assert.deepEqual(L.settlements(even), [{ from: 'Sam', to: 'Alex', amount: 50 }]);
  // and an item that never had one is identical to the same item without the key
  const legacy = { ...custom, items: [{ id: 'a', type: 'activity', title: 'a', startDate: '2027-05-01', status: 'booked', cost: 100, travelers: ['Alex', 'Sam'], paidBy: 'Alex' }] };
  assert.deepEqual(L.travelerTotals(legacy), L.travelerTotals(even));
  assert.deepEqual(L.settlements(legacy), L.settlements(even));
});

test('a split that stopped adding up falls back to the even divide, never to stale numbers', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [split('a', 200, ['Alex', 'Sam'], { Alex: 70, Sam: 30 }, { paidBy: 'Alex' })],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 100, Sam: 100 });
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 100 }]);
});

test('a hand-entered split converts, and a whole-cent split of thirds still nets out', () => {
  const rates = { base: 'USD', rates: { EUR: 0.5 } };
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [split('a', 100, ['Alex', 'Sam'], { Alex: 70, Sam: 30 }, { paidBy: 'Alex', costCurrency: 'EUR' })],
  };
  // 100 EUR is 200 USD, so the 70/30 split is 140/60 in the trip's currency
  assert.deepEqual(L.travelerTotals(trip, rates), { Alex: 140, Sam: 60 });
  assert.deepEqual(L.settlements(trip, rates), [{ from: 'Sam', to: 'Alex', amount: 60 }]);
  // the uneven cent from evenSplitAmounts is a legal saved split too
  const thirds = {
    currency: 'USD', travelers: ['Alex', 'Sam', 'Jo'],
    items: [split('b', 100, ['Alex', 'Sam', 'Jo'], { Alex: 33.34, Sam: 33.33, Jo: 33.33 }, { paidBy: 'Alex' })],
  };
  assert.deepEqual(L.travelerTotals(thirds), { Alex: 33.34, Sam: 33.33, Jo: 33.33 });
  assert.deepEqual(L.settlements(thirds), [
    { from: 'Sam', to: 'Alex', amount: 33.33 },
    { from: 'Jo', to: 'Alex', amount: 33.33 },
  ]);
});

test('a split can hand one person the whole cost, and settle up says so', () => {
  const trip = {
    currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [split('a', 80, ['Alex', 'Sam'], { Alex: 0, Sam: 80 }, { paidBy: 'Alex' })],
  };
  assert.deepEqual(L.travelerTotals(trip), { Alex: 0, Sam: 80 });
  assert.deepEqual(L.settlements(trip), [{ from: 'Sam', to: 'Alex', amount: 80 }]);
});

test('a hand-entered split survives a share link, and an item without one is unchanged', () => {
  const slim = L.slimTripForShare({
    name: 'T', currency: 'USD', travelers: ['Alex', 'Sam'],
    items: [
      split('a', 100, ['Alex', 'Sam'], { Alex: 70, Sam: 30 }),
      { id: 'b', type: 'activity', title: 'Park', startDate: '2027-05-02', status: 'booked', cost: 40 },
    ],
  });
  assert.deepEqual(slim.items[0].splitAmounts, { Alex: 70, Sam: 30 });
  assert.equal('splitAmounts' in slim.items[1], false);
  // the far side reads the same numbers back
  assert.deepEqual(L.travelerTotals(slim), { Alex: 90, Sam: 50 });
});

test('an assistant can never write a cost split', () => {
  const add = L.validateTripAction({ op: 'add', item: {
    type: 'activity', title: 'Dinner', startDate: '2027-05-01', cost: 100,
    travelers: ['Alex', 'Sam'], splitAmounts: { Alex: 100, Sam: 0 },
  } }, { items: [] });
  assert.equal(add.ok, true);
  assert.equal('splitAmounts' in add.proposal.fields, false);
});

// ---------- cost by type: proportional bars ----------
// The point: the bar is a picture of the ranking the rows already carry, so it
// may never claim something the amounts do not. The largest row is the whole
// track and everything else is measured against it, never against the total.

test('typeBarShares makes the largest row the whole track and the rest proportional', () => {
  const rows = [{ total: 900 }, { total: 600 }, { total: 260 }, { total: 45 }];
  const shares = L.typeBarShares(rows);
  assert.equal(shares[0], 1);
  assert.deepEqual(shares.map(s => Math.round(s * 1000) / 1000), [1, 0.667, 0.289, 0.05]);
  // strictly shorter, in the order the rows came in
  for (let i = 1; i < shares.length; i++) assert.ok(shares[i] < shares[i - 1]);
});

test('typeBarShares gives a lone row the full track rather than skipping it', () => {
  assert.deepEqual(L.typeBarShares([{ total: 42 }]), [1]);
});

test('typeBarShares draws no backwards bar for a refunded row', () => {
  // a booking cancelled and refunded can leave a type at or below zero
  assert.deepEqual(L.typeBarShares([{ total: 500 }, { total: 0 }, { total: -80 }]), [1, 0, 0]);
  // nothing positive at all means there is no largest to measure against
  assert.deepEqual(L.typeBarShares([{ total: -80 }, { total: -20 }]), [0, 0]);
  assert.deepEqual(L.typeBarShares([]), []);
  assert.deepEqual(L.typeBarShares(null), []);
});

test('typeBarShares reads the rows costsByType actually produces', () => {
  const trip = { currency: 'USD', items: [
    { id: 'a', type: 'flight', title: 'F', startDate: '2027-05-01', status: 'booked', cost: 900 },
    { id: 'b', type: 'stay', title: 'S', startDate: '2027-05-01', endDate: '2027-05-03', status: 'booked', cost: 450 },
    { id: 'c', type: 'activity', title: 'A', startDate: '2027-05-02', status: 'booked', cost: 225 },
  ] };
  assert.deepEqual(L.typeBarShares(L.costsByType(trip)), [1, 0.5, 0.25]);
});

// ---------- cross-trip date overlap ----------
// The point: every other collision check in this app looks inside ONE trip, so
// the only way to double-book yourself was to do it across two saved trips.
// The check is per active trip, which is what makes both sides of a clash
// report it instead of only whichever one happened to be computed first.

const tripOf = (id, name, items) => ({ id, name, currency: 'USD', items });
const dated = (id, startDate, endDate = '', status = 'booked') =>
  ({ id, type: 'stay', title: 'Hotel', location: 'X', startDate, endDate, status });

test('overlappingTrips names the other trip from either side of the clash', () => {
  const a = tripOf('a', 'Japan', [dated('a1', '2027-06-01', '2027-06-10')]);
  const b = tripOf('b', 'Portugal', [dated('b1', '2027-06-08', '2027-06-15')]);
  const trips = [a, b];
  assert.deepEqual(L.overlappingTrips(trips, 'a'), [{ id: 'b', name: 'Portugal', start: '2027-06-08', end: '2027-06-15' }]);
  assert.deepEqual(L.overlappingTrips(trips, 'b'), [{ id: 'a', name: 'Japan', start: '2027-06-01', end: '2027-06-10' }]);
});

test('overlappingTrips leaves adjacent trips alone but flags a single shared day', () => {
  const a = tripOf('a', 'Japan', [dated('a1', '2027-06-01', '2027-06-10')]);
  const c = tripOf('c', 'Rome', [dated('c1', '2027-06-11', '2027-06-14')]);
  assert.deepEqual(L.overlappingTrips([a, c], 'a'), []);
  assert.deepEqual(L.overlappingTrips([a, c], 'c'), []);
  // touching on one date is NOT adjacent: that day is claimed twice
  const sameDay = tripOf('d', 'Rome', [dated('d1', '2027-06-10', '2027-06-14')]);
  assert.deepEqual(L.overlappingTrips([a, sameDay], 'a').map(o => o.id), ['d']);
  // one trip swallowing another is still exactly one warning
  const inside = tripOf('e', 'Weekend', [dated('e1', '2027-06-03', '2027-06-05')]);
  assert.deepEqual(L.overlappingTrips([a, inside], 'a').map(o => o.id), ['e']);
  assert.deepEqual(L.overlappingTrips([a, inside], 'e').map(o => o.id), ['a']);
});

test('three mutually overlapping trips each report exactly the other two', () => {
  const trips = [
    tripOf('a', 'A', [dated('a1', '2027-06-01', '2027-06-10')]),
    tripOf('b', 'B', [dated('b1', '2027-06-05', '2027-06-12')]),
    tripOf('c', 'C', [dated('c1', '2027-06-08', '2027-06-20')]),
  ];
  assert.deepEqual(L.overlappingTrips(trips, 'a').map(o => o.id), ['b', 'c']);
  assert.deepEqual(L.overlappingTrips(trips, 'b').map(o => o.id), ['a', 'c']);
  assert.deepEqual(L.overlappingTrips(trips, 'c').map(o => o.id), ['a', 'b']);
});

test('a trip with no computable span neither triggers the warning nor is named by it', () => {
  const a = tripOf('a', 'Japan', [dated('a1', '2027-06-01', '2027-06-10')]);
  const empty = tripOf('z', 'Someday', []);
  const undated = tripOf('u', 'Ideas', [{ id: 'u1', type: 'note', title: 'Look at flights', startDate: '', status: 'to-book' }]);
  // cancelled is dropped by tripStats, so a trip holding only cancelled dates
  // has no span either - and no claim on those days
  const cancelled = tripOf('x', 'Called off', [dated('x1', '2027-06-02', '2027-06-09', 'cancelled')]);
  const trips = [a, empty, undated, cancelled];
  assert.deepEqual(L.overlappingTrips(trips, 'a'), []);
  assert.deepEqual(L.overlappingTrips(trips, 'z'), []);
  assert.deepEqual(L.overlappingTrips(trips, 'u'), []);
  assert.deepEqual(L.overlappingTrips(trips, 'x'), []);
  // the only trip on the device can never overlap anything
  assert.deepEqual(L.overlappingTrips([a], 'a'), []);
  // an id nobody holds asks about no trip at all
  assert.deepEqual(L.overlappingTrips(trips, 'nope'), []);
  assert.deepEqual(L.overlappingTrips(null, 'a'), []);
});

// ---------- passport expiry ----------
// The point: this is the six-month rule, which denies boarding, so the wording
// must never harden "many countries ask for 6 months" into "you are fine" or
// "you are refused". Two sentences speak, the third branch is silence.

// the app's own display format (app.js FMT_FULL), so the copy asserted here is
// character-for-character what the dialog renders
const fmtD = s => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(s + 'T00:00:00Z'));

test('a passport expiring during the trip is a flat error naming both dates', () => {
  assert.deepEqual(L.passportExpiryStatus('2027-06-05', '2027-06-10', fmtD), {
    level: 'error',
    text: 'Your passport expires Jun 5, 2027 - before this trip ends on Jun 10, 2027.',
  });
  // expiring ON the last day is the same problem: you are still abroad that day
  assert.deepEqual(L.passportExpiryStatus('2027-06-10', '2027-06-10', fmtD), {
    level: 'error',
    text: 'Your passport expires Jun 10, 2027 - before this trip ends on Jun 10, 2027.',
  });
});

test('a passport expiring inside six months of the return warns without asserting a rule', () => {
  const expected = 'Your passport is valid for this trip but expires Dec 6, 2027 - within 6 months of your return.'
    + ' Many countries require 6+ months of remaining validity to let you in;'
    + " always check each destination's exact rule.";
  // 2027-06-10 + 179 days
  assert.deepEqual(L.passportExpiryStatus('2027-12-06', '2027-06-10', fmtD), { level: 'warn', text: expected });
  // one day past the end of the trip is the other edge of the same branch
  assert.equal(L.passportExpiryStatus('2027-06-11', '2027-06-10', fmtD).level, 'warn');
});

test('180 days of remaining validity is where the app goes quiet', () => {
  const end = '2027-06-10';
  assert.equal(L.diffDays(end, '2027-12-06'), 179);
  assert.equal(L.diffDays(end, '2027-12-07'), 180);
  assert.equal(L.passportExpiryStatus('2027-12-06', end, fmtD).level, 'warn');
  assert.equal(L.passportExpiryStatus('2027-12-07', end, fmtD), null);
  assert.equal(L.passportExpiryStatus('2027-12-08', end, fmtD), null);
  assert.equal(L.passportExpiryStatus('2035-01-01', end, fmtD), null);
  assert.equal(L.PASSPORT_VALIDITY_DAYS, 180);
});

test('passportExpiryStatus says nothing without both dates', () => {
  // blank field on a dated trip, and a filled field on a trip with no dates:
  // both are legal states of the dialog and neither has a comparison to make
  assert.equal(L.passportExpiryStatus('', '2027-06-10', fmtD), null);
  assert.equal(L.passportExpiryStatus('2027-06-05', '', fmtD), null);
  assert.equal(L.passportExpiryStatus('2027-06-05', null, fmtD), null);
  assert.equal(L.passportExpiryStatus('06/05/2027', '2027-06-10', fmtD), null);
  assert.equal(L.passportExpiryStatus(null, null, fmtD), null);
});

// ---------- city picker (Open-Meteo geocoding results) ----------

// Shaped like a real Open-Meteo row so the tests exercise the same keys the
// endpoint actually sends.
function omRow(name, country, cc, population, extra = {}) {
  return {
    id: Math.abs(`${name}${cc}${population}`.length * 7919),
    name, country, country_code: cc, population,
    latitude: 1, longitude: 2, feature_code: 'PPL',
    ...extra,
  };
}
const omPayload = (...results) => ({ results });

test('rankPlaceResults survives the payloads the endpoint really sends', () => {
  // no match and a one-character query both come back WITHOUT a results key
  assert.deepEqual(L.rankPlaceResults('zzzq', { generationtime_ms: 0.4 }, 8), []);
  assert.deepEqual(L.rankPlaceResults('a', {}, 8), []);
  assert.deepEqual(L.rankPlaceResults('x', null, 8), []);
  assert.deepEqual(L.rankPlaceResults('x', { results: null }, 8), []);
});

test('rankPlaceResults drops everything that is not a place you can stay', () => {
  // a search for Kyoto really does return a heliport and a palace
  const out = L.rankPlaceResults('kyoto', omPayload(
    omRow('Kyoto', 'Japan', 'JP', 1463723, { feature_code: 'PPLA' }),
    omRow('Kyoto Heliport', 'Japan', 'JP', 0, { feature_code: 'AIRH' }),
    omRow('Kyoto Imperial Palace', 'Japan', 'JP', 0, { feature_code: 'PRK' }),
  ), 8);
  assert.deepEqual(out.map(r => r.value), ['Kyoto']);
});

test('rankPlaceResults ranks the big city over the exact small one', () => {
  // THE regression this scoring exists for: "tok" matches the village of Tok,
  // Alaska exactly and Tokyo only as a prefix, and a traveller means Tokyo.
  const out = L.rankPlaceResults('tok', omPayload(
    omRow('Tok', 'United States', 'US', 1258, { admin1: 'Alaska' }),
    omRow('Tok', 'Kazakhstan', 'KZ', 0),
    omRow('Tokyo', 'Japan', 'JP', 9733276, { admin1: 'Tokyo' }),
  ), 8);
  assert.equal(out[0].value, 'Tokyo');
  assert.equal(out[1].label, 'Tok, Alaska, United States');
});

test('rankPlaceResults keeps a match that is neither exact nor a prefix', () => {
  // the endpoint resolves native and alternate names but returns only the
  // ENGLISH one, so "koln" legitimately comes back as "Cologne"
  const out = L.rankPlaceResults('koln', omPayload(
    omRow('Kolno', 'Poland', 'PL', 10659),
    omRow('Cologne', 'Germany', 'DE', 963395),
  ), 8);
  assert.equal(out[0].value, 'Cologne');
  assert.equal(out.length, 2);
});

test('rankPlaceResults disambiguates the namesakes in the label', () => {
  const out = L.rankPlaceResults('paris', omPayload(
    omRow('Paris', 'United States', 'US', 24782, { admin1: 'Texas' }),
    omRow('Paris', 'France', 'FR', 2138551, { admin1: 'Île-de-France Region', feature_code: 'PPLC' }),
  ), 8);
  assert.deepEqual(out.map(r => r.label), [
    'Paris, Île-de-France Region, France',
    'Paris, Texas, United States',
  ]);
  // what lands in the field is the BARE name: the label is for choosing, but
  // the value is also the day-card chip and the weather lookup key
  assert.deepEqual(out.map(r => r.value), ['Paris', 'Paris']);
  assert.equal(out[0].cc, 'FR');
});

test('rankPlaceResults does not repeat a region that echoes the city', () => {
  const [row] = L.rankPlaceResults('tokyo', omPayload(
    omRow('Tokyo', 'Japan', 'JP', 9733276, { admin1: 'Tokyo' }),
  ), 8);
  assert.equal(row.label, 'Tokyo, Japan');
  assert.equal(row.detail, 'Japan');
});

test('rankPlaceResults de-duplicates the settlement and its admin twin', () => {
  const out = L.rankPlaceResults('berlin', omPayload(
    omRow('Berlin', 'Germany', 'DE', 3426354, { admin1: 'Berlin', feature_code: 'PPLC' }),
    omRow('Berlin', 'Germany', 'DE', 3426354, { admin1: 'Berlin', feature_code: 'ADM1' }),
  ), 8);
  assert.equal(out.length, 1);
  assert.equal(out[0].feature, 'PPLC');
});

test('rankPlaceResults honours the limit and drops unplottable rows', () => {
  const many = Array.from({ length: 12 }, (_, i) => omRow(`Springfield ${i}`, 'United States', 'US', 1000 * i));
  assert.equal(L.rankPlaceResults('springfield', omPayload(...many), 5).length, 5);
  const broken = L.rankPlaceResults('nowhere', omPayload(
    { name: 'Nowhere', country: 'X', country_code: 'XX', feature_code: 'PPL', latitude: null, longitude: null },
  ), 8);
  assert.deepEqual(broken, []);
});

test('foldPlace is blind to case and diacritics', () => {
  assert.equal(L.foldPlace('Köln'), 'koln');
  assert.equal(L.foldPlace('  MÁLAGA '), 'malaga');
  assert.equal(L.foldPlace(null), '');
});

// ---------- airport picker (bundled OurAirports table) ----------

const AIRPORT_FIXTURE = {
  countries: { JP: 'Japan', US: 'United States', GB: 'United Kingdom', FR: 'France' },
  rows: [
    ['HND', 'Tokyo Haneda International', 'Tokyo', 'JP', 35.55, 139.79, 1, 'TYO'],
    ['NRT', 'Narita International', 'Narita', 'JP', 35.77, 140.39, 1, 'TYO Tokyo New'],
    ['LHR', 'London Heathrow', 'London', 'GB', 51.47, -0.46, 1, 'LON'],
    ['LGW', 'London Gatwick', 'London', 'GB', 51.15, -0.19, 1, 'LON'],
    ['LCY', 'London City', 'London', 'GB', 51.51, 0.05, 0, 'LON'],
    ['JFK', 'John F. Kennedy International', 'New York', 'US', 40.64, -73.78, 1, 'NYC Idlewild'],
    ['EWR', 'Newark Liberty International', 'Newark', 'US', 40.69, -74.17, 1, 'Manhattan New York City NYC'],
    ['LAX', 'Los Angeles International', 'Los Angeles', 'US', 33.94, -118.41, 1, ''],
    ['CDG', 'Charles de Gaulle International', 'Paris', 'FR', 49.01, 2.55, 1, 'PAR Roissy'],
  ],
};
const AIRPORTS = L.airportIndex(AIRPORT_FIXTURE);
const codes = (q, n) => L.searchAirports(q, AIRPORTS, n).map(a => a.iata);

test('airportIndex expands the compact payload and resolves the country', () => {
  const hnd = AIRPORTS.find(a => a.iata === 'HND');
  assert.equal(hnd.city, 'Tokyo');
  assert.equal(hnd.country, 'Japan');
  assert.equal(hnd.big, true);
  assert.equal(AIRPORTS.find(a => a.iata === 'LCY').big, false);
  assert.deepEqual(L.airportIndex(null), []);
  assert.deepEqual(L.airportIndex({ rows: 'nope' }), []);
});

test('a typed IATA code beats every name match', () => {
  assert.equal(codes('lax')[0], 'LAX');
  assert.equal(codes('jfk')[0], 'JFK');
  // LHR by code, even though four other rows contain "l"
  assert.equal(codes('lhr')[0], 'LHR');
});

test('airport search finds the alternate city travellers actually type', () => {
  // Narita's municipality is Narita, not Tokyo: without the keyword aliases
  // from the upstream data, "tokyo" would never surface NRT at all
  assert.deepEqual(codes('tokyo'), ['HND', 'NRT']);
  // and Newark is how you fly to New York
  assert.ok(codes('new york').includes('EWR'));
  assert.equal(codes('new york')[0], 'JFK');
  // metro codes are real search terms
  assert.ok(codes('par').includes('CDG'));
});

test('a large airport outranks a small one in the same city', () => {
  const london = codes('london');
  // London City is a medium airport, so it sorts below the two large ones
  // whatever the alphabet and the hub list do above it.
  assert.equal(london[london.length - 1], 'LCY');
});

test('the hub list breaks a tie the alphabet would get backwards', () => {
  // Heathrow and Gatwick are both large, both filed under London, and score
  // identically; nothing in OurAirports separates them, so the raw sort gave
  // Gatwick first. PRIMARY_HUBS is the curated answer.
  assert.deepEqual(codes('london'), ['LHR', 'LGW', 'LCY']);
  assert.ok(L.PRIMARY_HUBS.has('LHR'));
  assert.ok(!L.PRIMARY_HUBS.has('LGW'));
});

test('the hub list is ONLY a tiebreak and never beats a better match', () => {
  // LHR is a hub and LCY is not, but a typed code is an exact IATA match and
  // outranks everything: a hub bonus that could cross tiers would break this.
  assert.equal(codes('lcy')[0], 'LCY');
  // and a hub cannot pull itself above a closer name match either
  assert.equal(codes('london city')[0], 'LCY');
});

// ---------- the metro promotion ----------

test('naming a metro finds its gateway even when the data files it elsewhere', () => {
  // MXP's city is Ferno, so "milan" reaches it only through the airport name,
  // two tiers below any airport whose city string IS the metro. Declaring the
  // metro in PRIMARY_HUBS lifts that to a city-level match.
  const rows = L.airportIndex(require('../data/airports.json'));
  const top = q => L.searchAirports(q, rows, 3).map(a => a.iata)[0];
  assert.equal(L.PRIMARY_HUBS.get('MXP'), 'Milan');
  assert.equal(top('milan'), 'MXP');
  // partial typing gets there too, so the promotion is not an exact-match trick
  assert.equal(top('mil'), 'MXP');
  assert.equal(top('buch'), 'OTP');
  assert.equal(top('dall'), 'DFW');
});

test('Washington answers DCA, not Dulles (owner decision)', () => {
  // Dulles is the intercontinental gateway, but Reagan National is inside the
  // city and is what its city field says it is. IAD is deliberately absent
  // from PRIMARY_HUBS so no metro promotion fires and the plain city match
  // wins. Pinned because the "obvious" change is to add IAD back.
  const rows = L.airportIndex(require('../data/airports.json'));
  assert.ok(!L.PRIMARY_HUBS.has('IAD'));
  assert.deepEqual(L.searchAirports('washington', rows, 3).map(a => a.iata), ['DCA', 'IAD', 'BWI']);
  // Dulles is still perfectly reachable by its own name and code
  assert.equal(L.searchAirports('dulles', rows, 3).map(a => a.iata)[0], 'IAD');
  assert.equal(L.searchAirports('iad', rows, 3).map(a => a.iata)[0], 'IAD');
});

test('the promotion needs the METRO name, not any prefix of the airport name', () => {
  // An earlier draft promoted any name-prefix match. Airport names start with
  // people, so that put Amman (Queen Alia) above Queenstown and Paris
  // (Charles de Gaulle) above Chicago. Both must stay where they were.
  const rows = L.airportIndex(require('../data/airports.json'));
  const top = q => L.searchAirports(q, rows, 3).map(a => a.iata)[0];
  assert.equal(top('queen'), 'ZQN');   // Queenstown, not AMM
  assert.equal(top('ch'), 'ORD');      // Chicago, not CDG
  assert.equal(top('john'), 'JST');    // Johnstown, not JFK
  assert.equal(top('ge'), 'AVV');      // not IAH via "George Bush"
});

test('two letters do not name a metro', () => {
  // "lo" is on the way to somewhere, not a declaration of London.
  const rows = L.airportIndex(require('../data/airports.json'));
  assert.equal(L.airportScore('lo', rows.find(a => a.iata === 'LHR')), 650);  // prefix + big, unpromoted
  assert.equal(L.airportScore('lon', rows.find(a => a.iata === 'LHR')), 950); // promoted
});

test('every hub code and metro name in the list actually resolves', () => {
  // A typo in a curated list is silent: the entry simply never matches. This
  // pins both halves against the shipped table, so a bad code OR a metro name
  // that no longer reaches its airport fails loudly.
  const rows = L.airportIndex(require('../data/airports.json'));
  const shipped = new Set(rows.map(a => a.iata));
  const missing = [...L.PRIMARY_HUBS.keys()].filter(c => !shipped.has(c));
  assert.deepEqual(missing, []);
  const unreachable = [...L.PRIMARY_HUBS].filter(([iata, metro]) =>
    L.searchAirports(metro, rows, 3).map(a => a.iata)[0] !== iata);
  assert.deepEqual(unreachable, []);
});

test('the shipped data still ranks the real multi-airport metros correctly', () => {
  const rows = L.airportIndex(require('../data/airports.json'));
  const top = q => L.searchAirports(q, rows, 4).map(a => a.iata)[0];
  // One assertion per metro the hub list exists to arbitrate. These are the
  // cases where the alphabet was wrong before it.
  assert.equal(top('london'), 'LHR');
  assert.equal(top('chicago'), 'ORD');
  assert.equal(top('houston'), 'IAH');
  assert.equal(top('moscow'), 'SVO');
  assert.equal(top('rome'), 'FCO');
  assert.equal(top('seoul'), 'ICN');
  assert.equal(top('osaka'), 'KIX');
  assert.equal(top('milan'), 'MXP');
  assert.equal(top('sao paulo'), 'GRU');
  assert.equal(top('johannesburg'), 'JNB');
  assert.equal(top('dubai'), 'DXB');
  assert.equal(top('doha'), 'DOH');
  assert.equal(top('tenerife'), 'TFS');
  // the four the metro promotion fixed: each one's gateway is filed under a
  // suburb, and a smaller airport inside the city limits was beating it
  assert.equal(top('bucharest'), 'OTP');   // was BBU (Baneasa)
  assert.equal(top('dallas'), 'DFW');      // was DAL (Love Field)
  assert.equal(top('manchester'), 'MAN');  // was MHT (New Hampshire)
  // and the ones it merely confirms
  assert.equal(top('paris'), 'CDG');
  assert.equal(top('new york'), 'JFK');
  assert.equal(top('tokyo'), 'HND');
  assert.equal(top('istanbul'), 'IST');
});

test('airport search ignores queries too short to mean anything', () => {
  assert.deepEqual(L.searchAirports('l', AIRPORTS, 8), []);
  assert.deepEqual(L.searchAirports('', AIRPORTS, 8), []);
  assert.deepEqual(L.searchAirports('zzzz', AIRPORTS, 8), []);
  assert.deepEqual(L.searchAirports('tokyo', null, 8), []);
});

test('airport rows read as a label and a detail line', () => {
  const hnd = AIRPORTS.find(a => a.iata === 'HND');
  assert.equal(L.airportLabel(hnd), 'Tokyo (HND)');
  // the trailing "Airport" is stripped in the data to save bytes, and put back
  // for reading
  assert.equal(L.airportDetail(hnd), 'Tokyo Haneda International Airport · Japan');
  assert.equal(L.airportLabel(null), '');
});

test('flightTitleFromAirports writes the shape the day cards already parse', () => {
  const hnd = AIRPORTS.find(a => a.iata === 'HND');
  const cdg = AIRPORTS.find(a => a.iata === 'CDG');
  const title = L.flightTitleFromAirports(hnd, cdg);
  assert.equal(title, 'Tokyo (HND) to Paris (CDG)');
  // THE POINT of that shape: dayMorningCity runs these two over the title to
  // decide which city a travel day starts in, and keys the weather off it
  assert.equal(L.parseTravelOrigin(title), 'Tokyo');
  assert.equal(L.stripPlaceCode('Paris (CDG)'), 'Paris');
  assert.equal(L.flightTitleFromAirports(hnd, null), '');
});

test('parseFlightAirports re-fills the pickers from an existing title', () => {
  const { from, to } = L.parseFlightAirports('Tokyo (HND) to Paris (CDG)', AIRPORTS);
  assert.equal(from.iata, 'HND');
  assert.equal(to.iata, 'CDG');
  // lower case and a hand-written title still resolve
  assert.equal(L.parseFlightAirports('red-eye (hnd) to (lhr)', AIRPORTS).to.iata, 'LHR');
});

test('parseFlightAirports refuses parentheses that are not airports', () => {
  assert.deepEqual(L.parseFlightAirports('Dinner (7pm) to follow', AIRPORTS), { from: null, to: null });
  assert.deepEqual(L.parseFlightAirports('Ferry to Naxos', AIRPORTS), { from: null, to: null });
  // one known code is not a route: the caller needs both to compose a title
  assert.equal(L.parseFlightAirports('Flight to Tokyo (HND)', AIRPORTS).to, null);
  assert.deepEqual(L.parseFlightAirports('', AIRPORTS), { from: null, to: null });
  assert.deepEqual(L.parseFlightAirports(null, null), { from: null, to: null });
});

// ---------- hotel picker (Photon) ----------

// Shaped exactly like a Photon feature, including the fields it omits: the
// spike showed `city` missing on rural rows and `district` standing in for it
// inside Tokyo, so both paths are exercised below.
function photon(name, opts = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [opts.lon == null ? 139.7 : opts.lon, opts.lat == null ? 35.6 : opts.lat] },
    properties: {
      name,
      osm_key: opts.key || 'tourism',
      osm_value: opts.value || 'hotel',
      city: opts.city,
      district: opts.district,
      state: opts.state,
      country: opts.country || 'Japan',
      countrycode: opts.cc || 'JP',
    },
  };
}
const fc = (...features) => ({ type: 'FeatureCollection', features });

test('normalizeHotelRow builds the bare-name row the field stores', () => {
  const row = L.normalizeHotelRow(photon('Hotel Granvia Kyoto', { city: 'Kyoto', country: 'Japan' }));
  // the FIELD gets the bare name: it becomes the item title on every card
  assert.equal(row.value, 'Hotel Granvia Kyoto');
  assert.equal(row.label, 'Hotel Granvia Kyoto, Kyoto, Japan');
  assert.equal(row.detail, 'Kyoto, Japan');
  assert.equal(row.kindLabel, 'Hotel');
  assert.equal(row.locality, 'Kyoto');
  assert.equal(row.cc, 'JP');
});

test('normalizeHotelRow drops a locality that just repeats the name', () => {
  const row = L.normalizeHotelRow(photon('Kyoto', { city: 'Kyoto', country: 'Japan' }));
  assert.equal(row.label, 'Kyoto, Japan');
});

test('normalizeHotelRow falls back through city -> district -> state', () => {
  assert.equal(L.normalizeHotelRow(photon('A', { district: 'Minato' })).locality, 'Minato');
  assert.equal(L.normalizeHotelRow(photon('B', { state: 'Bali' })).locality, 'Bali');
  assert.equal(L.normalizeHotelRow(photon('C', { city: 'Kyoto', district: 'Shimogyo' })).locality, 'Kyoto');
});

test('normalizeHotelRow rejects rows that are not lodging or not locatable', () => {
  // the osm_tag filter is a request, not a guarantee
  assert.equal(L.normalizeHotelRow(photon('Kyoto Station', { key: 'railway', value: 'station' })), null);
  assert.equal(L.normalizeHotelRow(photon('Some Museum', { value: 'museum' })), null);
  assert.equal(L.normalizeHotelRow(photon('')), null);
  assert.equal(L.normalizeHotelRow(null), null);
  // THE GULF OF GUINEA TRAP: Number('') is 0, a real coordinate, so a row with
  // no latitude must not survive and drop a pin in the ocean
  const noCoords = photon('Nowhere');
  noCoords.geometry.coordinates = ['', ''];
  assert.equal(L.normalizeHotelRow(noCoords), null);
  const noGeom = photon('Nowhere2');
  delete noGeom.geometry;
  assert.equal(L.normalizeHotelRow(noGeom), null);
});

test('rankHotelResults de-duplicates the same hotel returned twice', () => {
  // OSM holds a building way AND an entrance node for the same hotel, and
  // Photon returns both: "Novotel, Paris, France" listed twice
  const out = L.rankHotelResults('novotel', fc(
    photon('Novotel', { city: 'Paris', country: 'France', cc: 'FR' }),
    photon('Novotel', { city: 'Paris', country: 'France', cc: 'FR', lat: 48.9 }),
    photon('Novotel Bangkok', { city: 'Bangkok', country: 'Thailand', cc: 'TH' }),
  ), '', 8);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(r => r.value), ['Novotel', 'Novotel Bangkok']);
});

test('rankHotelResults lets the typed city outrank Photon own order', () => {
  // the exact failure the spike found: Photon answers Christchurch first for
  // "novotel" even with a Bangkok lat/lon bias
  const payload = fc(
    photon('Novotel', { city: 'Christchurch', country: 'New Zealand', cc: 'NZ' }),
    photon('Novotel', { city: 'Leeds', country: 'United Kingdom', cc: 'GB' }),
    photon('Novotel Bangkok Platinum', { city: 'Bangkok', country: 'Thailand', cc: 'TH' }),
  );
  assert.equal(L.rankHotelResults('novotel', payload, '', 8)[0].locality, 'Christchurch');
  assert.equal(L.rankHotelResults('novotel', payload, 'Bangkok', 8)[0].locality, 'Bangkok');
});

test('rankHotelResults matches a city the two sources spell differently', () => {
  const payload = fc(
    photon('Far Inn', { city: 'Osaka', country: 'Japan' }),
    photon('Near Inn', { city: 'Shimogyo Ward, Kyoto', country: 'Japan' }),
  );
  // the Place field says "Kyoto", OSM files the hotel under a ward of it
  assert.equal(L.rankHotelResults('inn', payload, 'Kyoto', 8)[0].value, 'Near Inn');
  // and the other direction: the field is more specific than OSM. Both names
  // match the query equally here on purpose, so the city is the only thing
  // separating them (an exact NAME hit is worth more than a city hit, and
  // would mask this).
  const other = fc(photon('Inn A', { city: 'Osaka' }), photon('Inn B', { city: 'York' }));
  assert.equal(L.rankHotelResults('inn', other, 'York, England', 8)[0].value, 'Inn B');
});

test('rankHotelResults prefers a hotel over an apartment on an equal match', () => {
  const out = L.rankHotelResults('sakura', fc(
    photon('Sakura', { value: 'apartment', city: 'Kyoto' }),
    photon('Sakura', { value: 'hotel', city: 'Nara' }),
  ), '', 8);
  assert.equal(out[0].kind, 'hotel');
  assert.equal(out[0].kindLabel, 'Hotel');
});

test('rankHotelResults keeps Photon order when nothing else separates rows', () => {
  const out = L.rankHotelResults('inn', fc(
    photon('Inn One', { city: 'Kyoto' }),
    photon('Inn Two', { city: 'Kyoto' }),
    photon('Inn Three', { city: 'Kyoto' }),
  ), '', 8);
  assert.deepEqual(out.map(r => r.value), ['Inn One', 'Inn Two', 'Inn Three']);
});

test('rankHotelResults honours the limit and survives junk payloads', () => {
  const many = fc(...Array.from({ length: 12 }, (_, i) => photon(`Hotel ${i}`, { city: 'Kyoto' })));
  assert.equal(L.rankHotelResults('hotel', many, 'Kyoto', 8).length, 8);
  // Photon answers with an empty feature list rather than an error
  assert.deepEqual(L.rankHotelResults('nothing', fc(), '', 8), []);
  assert.deepEqual(L.rankHotelResults('x', null, '', 8), []);
  assert.deepEqual(L.rankHotelResults('x', { features: 'not an array' }, '', 8), []);
});

test('HOTEL_TAGS is the single source for the query and the row label', () => {
  // app.js builds the osm_tag parameters from these keys, and the picker shows
  // the value as the row tag: a key added to one and not the other is the bug
  // this pins
  assert.deepEqual([...L.HOTEL_TAGS.keys()], ['hotel', 'hostel', 'guest_house', 'motel', 'apartment']);
  assert.equal(L.HOTEL_TAGS.get('guest_house'), 'Guest house');
  for (const key of L.HOTEL_TAGS.keys()) assert.ok(L.HOTEL_KIND_BONUS.has(key), `${key} needs a kind bonus`);
});

// ---------- distances: venue cache, day chains, shortest route ----------

// Coordinates are laid out on the equator on purpose: 0.01 degrees of longitude
// there is 1.1120 km, so every figure below is a number a human can check by
// hand rather than a value copied back out of the implementation.
const KM_PER_UNIT = 1.11195;
const pt = (units) => ({ lat: 0, lon: units * 0.01 });
const NOW = Date.UTC(2027, 0, 16);

test('normalizeVenueCache drops junk, expired and over-cap entries', () => {
  const raw = {
    good: { lat: 35.6, lon: 139.7, at: NOW - 1000 },
    stale: { lat: 35.6, lon: 139.7, at: NOW - L.VENUE_TTL_MS - 1 },
    // Number('') is 0, a real point in the Gulf of Guinea: a coordinate that
    // was never written must not survive as one that was
    empty: { lat: '', lon: '', at: NOW },
    offEarth: { lat: 120, lon: 20, at: NOW },
    noStamp: { lat: 1, lon: 1 },
    fromTheFuture: { lat: 1, lon: 1, at: NOW + 86400000 },
  };
  assert.deepEqual(Object.keys(L.normalizeVenueCache(raw, NOW)), ['good']);
  assert.deepEqual(L.normalizeVenueCache(null, NOW), {});
  assert.deepEqual(L.normalizeVenueCache('nope', NOW), {});

  const many = {};
  for (let i = 0; i < L.VENUE_CACHE_MAX + 20; i++) many['v' + i] = { lat: 1, lon: 1, at: NOW - i };
  const capped = L.normalizeVenueCache(many, NOW);
  assert.equal(Object.keys(capped).length, L.VENUE_CACHE_MAX);
  assert.ok(capped.v0, 'the newest entry survives');
  assert.ok(!capped['v' + (L.VENUE_CACHE_MAX + 10)], 'the oldest entries are dropped');
});

test('rememberVenue evicts the least recently written venue at the cap', () => {
  const cache = {};
  for (let i = 0; i < L.VENUE_CACHE_MAX; i++) L.rememberVenue(cache, 'v' + i, { lat: 1, lon: 1 }, NOW + i);
  assert.equal(Object.keys(cache).length, L.VENUE_CACHE_MAX);
  L.rememberVenue(cache, 'newcomer', { lat: 35.6, lon: 139.7 }, NOW + 9999);
  assert.equal(Object.keys(cache).length, L.VENUE_CACHE_MAX);
  assert.ok(!cache.v0, 'the oldest write is the one that goes');
  assert.deepEqual(cache.newcomer, { lat: 35.6, lon: 139.7, at: NOW + 9999 });
  // a bad write changes nothing rather than storing a point in the ocean
  L.rememberVenue(cache, 'bad', { lat: '', lon: '' }, NOW);
  L.rememberVenue(cache, '', { lat: 1, lon: 1 }, NOW);
  assert.ok(!cache.bad);
  assert.equal(Object.keys(cache).length, L.VENUE_CACHE_MAX);
});

test('placesLocationUpdates stores the coordinates the ratings call returned', () => {
  const out = L.placesLocationUpdates([
    { query: 'Ichiran Shibuya, Tokyo', status: 'ok', rating: 4.2, lat: 35.6595, lon: 139.7005 },
    // an unrated but confidently matched venue still carries a position
    { query: 'Tiny Bar, Tokyo', status: 'no_match', reason: 'unrated', lat: 35.68, lon: 139.76 },
    // a wrong business (low confidence) is sent without one, and a generic
    // query never reached Google at all
    { query: 'Ramen Shop', status: 'no_match', reason: 'generic_query' },
    { query: 'Somewhere', status: 'ok', rating: 4, lat: 999, lon: 0 },
    { status: 'ok', lat: 1, lon: 1 },
    null,
  ]);
  assert.deepEqual(out, [
    { key: 'ichiran shibuya, tokyo', lat: 35.6595, lon: 139.7005 },
    { key: 'tiny bar, tokyo', lat: 35.68, lon: 139.76 },
  ]);
  // the key is the SAME one the rating cache uses, so one venue is one entry
  assert.equal(out[0].key, L.placeCacheKey('  Ichiran Shibuya,  Tokyo '));
});

test('pickVenueFeature refuses a top hit the query does not account for', () => {
  const feat = (name, lon) => ({
    geometry: { type: 'Point', coordinates: [lon, 35.6] },
    properties: { name },
  });
  // Photon answers everything with something: "Shibuya Crossing" is not Ichiran
  const wrong = { features: [feat('Shibuya Crossing', 139.7)] };
  assert.equal(L.pickVenueFeature('Ichiran Shibuya, Tokyo', wrong), null);
  // the venue named in the query, further down the list, is the one taken
  const mixed = { features: [feat('Shibuya Crossing', 139.7), feat('Ichiran', 139.701)] };
  assert.deepEqual(L.pickVenueFeature('Ichiran Shibuya, Tokyo', mixed), { name: 'Ichiran', lat: 35.6, lon: 139.701 });
  // and the other direction: the feature name is longer than the query head
  const longer = { features: [feat('teamLab Planets TOKYO DMM', 139.79)] };
  assert.equal(L.pickVenueFeature('teamLab Planets TOKYO, Toyosu', longer).lat, 35.6);
  assert.equal(L.pickVenueFeature('', mixed), null);
  assert.equal(L.pickVenueFeature('x', null), null);
  assert.equal(L.pickVenueFeature('x', { features: 'nope' }), null);
});

test('dayAnchor starts the day at its covering stay, else at the morning city', () => {
  const items = [
    stay('s1', 'Tokyo', '2027-01-16', '2027-01-19'),
    { id: 'a1', type: 'activity', title: 'teamLab', location: 'Tokyo', startDate: '2027-01-20', startTime: '10:00', status: 'to-book' },
  ];
  const inStay = L.dayAnchor(items, '2027-01-17');
  assert.equal(inStay.source, 'stay');
  assert.equal(inStay.item.id, 's1');
  assert.equal(inStay.label, 'Tokyo hotel');
  assert.equal(inStay.city, 'Tokyo');
  // no bed that day: the anchor is the city the day-card chip already names
  const noStay = L.dayAnchor(items, '2027-01-20');
  assert.equal(noStay.source, 'city');
  assert.equal(noStay.item, null);
  assert.equal(noStay.label, 'Tokyo');
  assert.equal(L.dayAnchor([], '2027-01-20'), null);
});

test('parseTravelArrival takes the LAST "to" half, with label, city and code', () => {
  assert.deepEqual(L.parseTravelArrival('Boston (BOS) to Keflavik (KEF)'),
    { label: 'Keflavik (KEF)', city: 'Keflavik', iata: 'KEF' });
  assert.deepEqual(L.parseTravelArrival('Tokyo to Kyoto to Osaka'),
    { label: 'Osaka', city: 'Osaka', iata: '' });
  assert.deepEqual(L.parseTravelArrival('Reykjavik to Akureyri'),
    { label: 'Akureyri', city: 'Akureyri', iata: '' });
  assert.equal(L.parseTravelArrival('Airport bus to the Riva').city, 'the Riva');
  assert.equal(L.parseTravelArrival('Just a title'), null);
  assert.equal(L.parseTravelArrival(''), null);
});

// The arrival that opens a day: an overnight flight claims the day it LANDS
// on, a same-day leg its only day, and anything located earlier that day
// (a morning in the departure city) switches the rule off entirely.
test('dayArrival finds the leg that opens the day and yields to earlier plans', () => {
  const flight = { id: 'f1', type: 'flight', title: 'Boston (BOS) to Keflavik (KEF)',
    startDate: '2027-01-16', startTime: '21:30', endDate: '2027-01-17', endTime: '06:45', status: 'booked' };
  const hotel = stay('s1', 'Reykjavik', '2027-01-17', '2027-01-20');
  // the overnight leg claims its LANDING day, not its takeoff day
  assert.equal(L.dayArrival([flight, hotel], '2027-01-16'), null);
  const arr = L.dayArrival([flight, hotel], '2027-01-17');
  assert.equal(arr.item.id, 'f1');
  assert.equal(arr.iata, 'KEF');
  assert.equal(arr.city, 'Keflavik');
  // a stay check-in never blocks; a located activity BEFORE the arrival does
  const early = { id: 'a1', type: 'activity', title: 'Breakfast: somewhere', location: 'Boston',
    startDate: '2027-01-17', startTime: '05:00', status: 'to-book' };
  assert.equal(L.dayArrival([flight, hotel, early], '2027-01-17'), null);
  // a located activity AFTER the arrival is exactly the point, and blocks nothing
  const later = { ...early, id: 'a2', startTime: '10:00', location: 'Reykjavik' };
  assert.equal(L.dayArrival([flight, hotel, later], '2027-01-17').item.id, 'f1');
  // a same-day leg claims its own day via its end (or start) time
  const train = { id: 't1', type: 'transport', title: 'Reykjavik to Akureyri',
    startDate: '2027-01-20', startTime: '09:00', endTime: '16:30', status: 'booked' };
  assert.equal(L.dayArrival([train], '2027-01-20').city, 'Akureyri');
  // a timeless leg cannot be ordered against the day and claims nothing
  const timeless = { id: 't2', type: 'transport', title: 'A to B', startDate: '2027-01-21', status: 'booked' };
  assert.equal(L.dayArrival([timeless], '2027-01-21'), null);
  // cancelled legs never anchor anything
  assert.equal(L.dayArrival([{ ...flight, status: 'cancelled' }], '2027-01-17'), null);
});

test('dayAnchor prefers the day-opening arrival over the covering stay', () => {
  const flight = { id: 'f1', type: 'flight', title: 'Boston (BOS) to Keflavik (KEF)',
    startDate: '2027-01-16', startTime: '21:30', endDate: '2027-01-17', endTime: '06:45', status: 'booked' };
  const hotel = stay('s1', 'Reykjavik', '2027-01-17', '2027-01-20');
  const a = L.dayAnchor([flight, hotel], '2027-01-17');
  assert.equal(a.source, 'arrival');
  assert.equal(a.item.id, 'f1');
  assert.equal(a.label, 'Keflavik (KEF)');
  assert.equal(a.iata, 'KEF');
  // the next morning there is no arrival, so the stay anchors as always
  assert.equal(L.dayAnchor([flight, hotel], '2027-01-18').source, 'stay');
});

test('dayDistanceChain measures from the anchor, then from each located stop', () => {
  const legs = L.dayDistanceChain(
    { key: 'hotel', label: 'Hotel Gracery', ...pt(0) },
    [
      { id: 'a', key: 'a', label: 'Museum', ...pt(1) },
      { id: 'b', key: 'b', label: 'Ramen', ...pt(3) },
    ],
  );
  assert.equal(legs.length, 2);
  assert.equal(legs[0].id, 'a');
  assert.equal(legs[0].from, 'Hotel Gracery');
  assert.ok(Math.abs(legs[0].km - KM_PER_UNIT) < 0.01, 'first leg measures from the anchor');
  // the second leg measures from the row before it, not from the hotel again
  assert.equal(legs[1].from, 'Museum');
  assert.ok(Math.abs(legs[1].km - 2 * KM_PER_UNIT) < 0.01);
});

test('dayDistanceChain skips checkout rows and rows nothing locates', () => {
  const legs = L.dayDistanceChain(
    { key: 'hotel', label: 'Hotel', ...pt(0) },
    [
      // a check-OUT row is the same booking a second time: no chip, and it does
      // not become the origin of the next leg either
      { id: 'out', key: 'hotel', label: 'Hotel', skip: true, ...pt(0) },
      { id: 'unlocated', label: 'Wander around' },
      { id: 'a', key: 'a', label: 'Museum', ...pt(2) },
      { id: 'b', key: 'b', label: 'Ramen', ...pt(3) },
    ],
  );
  assert.deepEqual(legs.map(l => l.id), ['a', 'b']);
  // the unlocatable row did not break the chain: 'a' still measures from the hotel
  assert.equal(legs[0].from, 'Hotel');
  assert.ok(Math.abs(legs[0].km - 2 * KM_PER_UNIT) < 0.01);
  assert.equal(legs[1].from, 'Museum');
});

test('dayDistanceChain drops a leg between two identical points, never "0.0 km"', () => {
  const centroid = { ...pt(5) };
  const legs = L.dayDistanceChain(
    { key: 'c:tokyo', label: 'Tokyo', ...centroid },
    [
      // both fell back to the same city centroid
      { id: 'a', key: 'c:tokyo', label: 'Lunch', ...centroid },
      // a different cache entry that happens to sit on the same spot
      { id: 'b', key: 'v:cafe', label: 'Cafe', ...centroid },
      { id: 'c', key: 'v:far', label: 'Museum', ...pt(6) },
    ],
  );
  assert.deepEqual(legs.map(l => l.id), ['c']);
  assert.equal(legs[0].from, 'Cafe', 'the suppressed stops still advance the origin');
  assert.ok(L.sameSpot({ key: 'x', ...pt(0) }, { key: 'y', lat: 0, lon: 0.0002 }), '22 m apart is the same spot');
  assert.ok(!L.sameSpot({ key: 'x', ...pt(0) }, { key: 'y', ...pt(1) }));
});

test('shortestRoute beats the greedy order on a hand-computed fixture', () => {
  // On a line through the anchor: one stop 1.1 units east, two stops 1 and 2
  // units west. Nearest-first walks west first and pays 1 + 1 + 3.1 = 5.1 units;
  // the shortest walk takes the east stop first: 1.1 + 2.1 + 1 = 4.2 units.
  const route = L.shortestRoute({ label: 'Hotel', ...pt(0) }, [
    { id: 'west1', label: 'W1', ...pt(-1) },
    { id: 'west2', label: 'W2', ...pt(-2) },
    { id: 'east', label: 'E', ...pt(1.1) },
  ]);
  assert.deepEqual(route.stops.map(s => s.id), ['east', 'west1', 'west2']);
  assert.ok(Math.abs(route.km - 4.2 * KM_PER_UNIT) < 0.02, `expected ~4.67 km, got ${route.km}`);
});

test('shortestRoute keeps the anchor as the start and breaks ties by input order', () => {
  const anchor = { label: 'Hotel', ...pt(0) };
  // mirror images: both orders cost the same, so the first-listed card is #1
  const tie = L.shortestRoute(anchor, [
    { id: 'east', label: 'E', ...pt(1) },
    { id: 'west', label: 'W', ...pt(-1) },
  ]);
  assert.deepEqual(tie.stops.map(s => s.id), ['east', 'west']);
  const flipped = L.shortestRoute(anchor, [
    { id: 'west', label: 'W', ...pt(-1) },
    { id: 'east', label: 'E', ...pt(1) },
  ]);
  assert.deepEqual(flipped.stops.map(s => s.id), ['west', 'east']);
  // a stop nothing located is not in the route, and an anchorless day has none
  const partial = L.shortestRoute(anchor, [{ id: 'ok', label: 'A', ...pt(2) }, { id: 'nowhere', label: 'B' }]);
  assert.deepEqual(partial.stops.map(s => s.id), ['ok']);
  assert.equal(L.shortestRoute(null, [{ id: 'ok', label: 'A', ...pt(2) }]), null);
  assert.equal(L.shortestRoute(anchor, []), null);
});

test('shortestRoute falls back to nearest-neighbour past the exact ceiling', () => {
  // 9 collinear stops (one past ROUTE_EXACT_MAX), shuffled: on a line the greedy
  // walk IS the optimum, so the fallback is still checkable by hand.
  const spread = [4, 1, 9, 3, 7, 2, 8, 5, 6];
  const route = L.shortestRoute({ label: 'Hotel', ...pt(0) },
    spread.map(u => ({ id: 'p' + u, label: 'P' + u, ...pt(u) })));
  assert.equal(route.stops.length, 9);
  assert.deepEqual(route.stops.map(s => s.id), [1, 2, 3, 4, 5, 6, 7, 8, 9].map(u => 'p' + u));
  assert.ok(Math.abs(route.km - 9 * KM_PER_UNIT) < 0.05);
});

// One card is one stop. A three-option dinner set is one dinner, so the route
// must count it once, at the venue the traveller currently has picked.
test('routeStops counts an alternative set once, at its selected option', () => {
  const cards = [
    { id: 'museum', options: [{ key: 'v:museum', label: 'Museum', ...pt(2) }], selected: 0 },
    {
      id: 'dinner',
      options: [
        { key: 'v:near', label: 'Dinner A', ...pt(1) },
        { key: 'v:far', label: 'Dinner B', ...pt(9) },
        { key: 'v:mid', label: 'Dinner C', ...pt(5) },
      ],
      selected: 0,
    },
  ];
  const first = L.routeStops(cards);
  assert.deepEqual(first.map(s => s.id), ['museum', 'dinner']);
  assert.deepEqual(first.map(s => s.label), ['Museum', 'Dinner A']);
  // flipping the pick moves the stop, and the route reorders around it: with
  // Dinner A at 1 unit the walk is hotel > dinner > museum; with Dinner B at 9
  // it is hotel > museum > dinner
  const anchor = { label: 'Hotel', ...pt(0) };
  assert.deepEqual(L.shortestRoute(anchor, first).stops.map(s => s.id), ['dinner', 'museum']);
  const flipped = L.routeStops([cards[0], { ...cards[1], selected: 1 }]);
  assert.deepEqual(flipped.map(s => s.label), ['Museum', 'Dinner B']);
  const route = L.shortestRoute(anchor, flipped);
  assert.deepEqual(route.stops.map(s => s.id), ['museum', 'dinner']);
  assert.ok(route.km > L.shortestRoute(anchor, first).km, 'the far option is a longer walk');
});

test('routeStops skips a card whose selected option has no coordinates', () => {
  // never a silent fallback to a sibling: the route would then name a venue the
  // traveller did not choose
  const set = {
    id: 'drinks',
    options: [{ label: 'Nowhere Bar' }, { key: 'v:bar', label: 'Bar B', ...pt(3) }],
    selected: 0,
  };
  assert.deepEqual(L.routeStops([set]), []);
  assert.deepEqual(L.routeStops([{ ...set, selected: 1 }]).map(s => s.label), ['Bar B']);
  // an out-of-range or missing selection stands at the first option
  assert.deepEqual(L.routeStops([{ id: 'x', options: [{ key: 'v:a', label: 'A', ...pt(1) }], selected: 7 }]).map(s => s.label), ['A']);
  assert.deepEqual(L.routeStops([{ id: 'x', options: [{ key: 'v:a', label: 'A', ...pt(1) }] }]).map(s => s.label), ['A']);
  // an accepted set has had its options removed from the card
  assert.deepEqual(L.routeStops([{ id: 'gone', options: [] }]), []);
  assert.deepEqual(L.routeStops([null, undefined]), []);
  assert.deepEqual(L.routeStops(null), []);
});

test('distance wording prints exactly ONE unit, chosen by the preference', () => {
  // default is miles (matches the 12-hour clock default); kilometers on request
  try {
    assert.equal(L.getDistanceUnit(), 'mi');
    assert.equal(L.fmtDist(1.2), '0.7 mi');
    assert.equal(L.fmtDist(1240), '771 mi');
    assert.equal(L.distanceChipLabel(1.24), '~0.8 mi');
    L.setDistanceUnit('km');
    assert.equal(L.fmtDist(1.2), '1.2 km');
    assert.equal(L.fmtDist(0.34), '0.3 km');
    assert.equal(L.fmtDist(1240), '1,240 km');
    assert.equal(L.distanceChipLabel(1.24), '~1.2 km');
    assert.equal(L.distanceChipTitle(1.24, 'Hotel Gracery Shinjuku'),
      '1.2 km straight-line from Hotel Gracery Shinjuku, not a walking route.');
    assert.equal(L.routeFooterText('Hotel', ['B', 'A', 'C'], 5.4), 'Shortest route: Hotel > B > A > C · ~5.4 km total');
    // an unknown value falls back to miles rather than a third state
    L.setDistanceUnit('bananas');
    assert.equal(L.getDistanceUnit(), 'mi');
    // the dual "km / mi" form is gone from every formatter
    L.setDistanceUnit('km');
    for (const s of [L.fmtDist(3), L.distanceChipLabel(3), L.distanceChipTitle(3, 'X'),
      L.assistDistanceChipLabel(1.3, 'X'), L.routeFooterText('H', ['A'], 2)]) {
      assert.ok(!/km \/|\/ mi/.test(s), `dual units in "${s}"`);
      // UI copy carries no em dash anywhere in this app
      assert.ok(!s.includes('—'), `em dash in "${s}"`);
    }
  } finally {
    L.setDistanceUnit('mi');
  }
});

// ---------- assistant: where a SUGGESTION is measured from ----------
// The reported bug: a rooftop-bar suggestion for the evening of the hotel
// check-in day carried no distance at all. dayAnchor answers "where does this
// DAY open", which on an arrival day is the airport, and both the airport and
// the suggestion fell back to the same city centroid, so the leg was dropped as
// a fake 0.0 km. proposalOrigin answers the question a suggestion actually
// asks: where is the traveller at THAT HOUR.

const BKK_FLIGHT = {
  id: 'f1', type: 'flight', title: 'Tokyo (HND) to Bangkok (BKK)',
  startDate: '2027-01-16', startTime: '09:00', endTime: '13:30', status: 'booked',
};
const BKK_HOTEL = {
  id: 's1', type: 'stay', title: 'Sotetsu Grand Fresa Bangkok', location: 'Bangkok',
  startDate: '2027-01-16', endDate: '2027-01-20', status: 'booked',
};

test('proposalOrigin: an evening on the arrival day starts at the hotel, not the airport', () => {
  const items = [BKK_FLIGHT, BKK_HOTEL];
  // the DAY still opens at the airport - the Days-view chain is untouched
  assert.equal(L.dayAnchor(items, '2027-01-16').source, 'arrival');
  // but by 20:00 the traveller has landed AND checked in
  const evening = L.proposalOrigin(items, '2027-01-16', '20:00');
  assert.equal(evening.source, 'stay');
  assert.equal(evening.label, 'Sotetsu Grand Fresa Bangkok');
  assert.equal(evening.city, 'Bangkok');
  // ...with no bed booked, the airport is still the honest answer
  assert.equal(L.proposalOrigin([BKK_FLIGHT], '2027-01-16', '20:00').iata, 'BKK');
});

test('proposalOrigin: the previous scheduled activity wins over the day anchor', () => {
  const lunch = {
    id: 'a1', type: 'activity', title: 'Lunch: Jay Fai', location: 'Bangkok',
    mapsQuery: 'Jay Fai Bangkok', startDate: '2027-01-17', startTime: '13:00', status: 'to-book',
  };
  const items = [BKK_HOTEL, lunch];
  const after = L.proposalOrigin(items, '2027-01-17', '20:00');
  assert.equal(after.source, 'item');
  assert.equal(after.item.id, 'a1');
  assert.equal(after.label, 'Lunch: Jay Fai');
  // a suggestion BEFORE it falls back to the bed, not forward to lunch
  assert.equal(L.proposalOrigin(items, '2027-01-17', '09:00').source, 'stay');
  // and a cancelled plan is not somewhere the traveller will be
  assert.equal(L.proposalOrigin([BKK_HOTEL, { ...lunch, status: 'cancelled' }], '2027-01-17', '20:00').source, 'stay');
});

test('proposalOrigin: a mid-day leg puts the traveller where it LANDS', () => {
  // no bed that night in the new city: the arrival itself is the origin, and it
  // keeps the code the bundled airports table can pin exactly
  const hop = {
    id: 't1', type: 'transport', title: 'Bangkok to Ayutthaya', location: '',
    startDate: '2027-01-18', startTime: '10:00', endTime: '11:30', status: 'booked',
  };
  const o = L.proposalOrigin([hop], '2027-01-18', '13:00');
  assert.equal(o.source, 'arrival');
  assert.equal(o.city, 'Ayutthaya');
  // an unparseable leg title names nowhere and is skipped rather than guessed
  assert.equal(L.proposalOrigin([{ ...hop, title: 'Day trip' }], '2027-01-18', '13:00'), null);
});

test('proposalOrigin: a stay never claims a day it does not cover, and empty is null', () => {
  // multiple hotels on one trip: each day measures from ITS OWN bed
  const kyoto = { id: 's2', type: 'stay', title: 'Kyoto Ryokan', location: 'Kyoto', startDate: '2027-01-20', endDate: '2027-01-23', status: 'booked' };
  const items = [BKK_HOTEL, kyoto];
  assert.equal(L.proposalOrigin(items, '2027-01-17', '20:00').label, 'Sotetsu Grand Fresa Bangkok');
  assert.equal(L.proposalOrigin(items, '2027-01-21', '20:00').label, 'Kyoto Ryokan');
  // nothing at all to measure from: no origin, which renders as no chip
  assert.equal(L.proposalOrigin([], '2027-01-16', '20:00'), null);
  assert.equal(L.proposalOrigin(null, '', ''), null);
  assert.equal(L.proposalOrigin([BKK_HOTEL], 'not-a-date', '20:00'), null);
});

test('proposalOrigin: a garbage time degrades to the day anchor rather than throwing', () => {
  const items = [BKK_HOTEL];
  for (const t of [null, undefined, '', '25:99', 'evening', 7, {}]) {
    assert.equal(L.proposalOrigin(items, '2027-01-17', t).source, 'stay', String(t));
  }
});

// ---------- assistant: chaining a BATCH of suggestions ----------

test('suggestionOrigins: a later card measures from an earlier card, not the hotel', () => {
  const hotel = { key: 'c:bangkok', lat: 13.75, lon: 100.5, label: 'Sotetsu Grand Fresa Bangkok' };
  const bar = { key: 'v:above eleven', lat: 13.743, lon: 100.556, label: 'Drinks: Above Eleven' };
  const cards = [
    { id: 'bar', date: '2027-01-16', time: '20:00', point: bar },
    { id: 'home', date: '2027-01-16', time: '21:30', point: hotel },
  ];
  const out = L.suggestionOrigins(cards, () => hotel);
  // the first card of the evening starts at the fallback (the itinerary answer)
  assert.equal(out.get('bar').label, 'Sotetsu Grand Fresa Bangkok');
  // the ride home is the leg FROM the bar, which is the whole point of it
  assert.equal(out.get('home').label, 'Drinks: Above Eleven');
});

test('suggestionOrigins: candidates sharing a time are one decision, never each other origin', () => {
  const hotel = { key: 'c:h', lat: 0, lon: 0, label: 'Hotel' };
  const p = (n) => ({ key: 'v:' + n, lat: n / 100, lon: 0, label: String(n) });
  const cards = [
    { id: 'd1', date: 'D', time: '19:00', point: p(1) },
    { id: 'd2', date: 'D', time: '19:00', point: p(2) },
    { id: 'd3', date: 'D', time: '19:00', point: p(3) },
  ];
  const out = L.suggestionOrigins(cards, () => hotel);
  for (const id of ['d1', 'd2', 'd3']) assert.equal(out.get(id).label, 'Hotel', id);
});

test('suggestionOrigins: an unlocatable card is skipped over, and days never mix', () => {
  const fallback = (date) => ({ key: 'c:' + date, lat: 0, lon: 0, label: 'Bed ' + date });
  const cards = [
    { id: 'a', date: 'D1', time: '10:00', point: { key: 'v:a', lat: 1, lon: 1, label: 'A' } },
    { id: 'b', date: 'D1', time: '12:00', point: null },
    { id: 'c', date: 'D1', time: '14:00', point: { key: 'v:c', lat: 3, lon: 3, label: 'C' } },
    { id: 'd', date: 'D2', time: '11:00', point: { key: 'v:d', lat: 4, lon: 4, label: 'D' } },
  ];
  const out = L.suggestionOrigins(cards, fallback);
  assert.equal(out.get('a').label, 'Bed D1');
  // b resolved to nothing, so c still measures from a rather than breaking
  assert.equal(out.get('c').label, 'A');
  // another day starts at its own bed, never at the last card of the day before
  assert.equal(out.get('d').label, 'Bed D2');
  // an untimed card cannot be ordered against the batch and takes the fallback
  const untimed = L.suggestionOrigins([{ id: 'u', date: 'D1', time: '', point: null }], fallback);
  assert.equal(untimed.get('u').label, 'Bed D1');
  assert.deepEqual([...L.suggestionOrigins([], fallback)], []);
  assert.deepEqual([...L.suggestionOrigins(null, fallback)], []);
});

test('suggestionOrigins tolerates a fallback that is not a function', () => {
  const out = L.suggestionOrigins([{ id: 'x', date: 'D', time: '10:00', point: null }], null);
  assert.equal(out.get('x'), null);
});

// ---------- assistant: distance wording on a suggestion card ----------

test('the assistant chip names the travel time, the distance and the origin', () => {
  try {
    L.setDistanceUnit('km');
    // the time leads, because "20 minutes away" is what a traveller decides on
    assert.equal(L.assistDistanceChipLabel(1.3, 'Sotetsu Grand Fresa Bangkok'),
      '\u{1F6B6} ~20 min walk \u00b7 ~1.3 km from Sotetsu Grand Fresa Bangkok');
    // ...and it still carries the same NUMBER the itinerary chip prints, which is
    // the property that makes a pre-add figure trustworthy after the add
    assert.ok(L.assistDistanceChipLabel(1.3, 'X').includes(L.distanceChipLabel(1.3)));
    // past a walkable hop the walk is computable and useless: name the ride
    assert.match(L.assistDistanceChipLabel(4.2, 'X'), /~8 min by taxi \u00b7 ~4\.2 km/);
    // past every in-city mode there is nothing honest to say, so nothing is said
    assert.equal(L.assistDistanceChipLabel(400, 'X'), '~400 km from X');
    // every part degrades on its own
    for (const empty of ['', '   ', null, undefined]) {
      assert.match(L.assistDistanceChipLabel(1.3, empty), /^\u{1F6B6} ~20 min walk \u00b7 ~1\.3 km$/u);
    }
    // ...and the same chip in miles, so the preference reaches the assistant too
    L.setDistanceUnit('mi');
    assert.equal(L.assistDistanceChipLabel(1.3, 'X'), '\u{1F6B6} ~20 min walk \u00b7 ~0.8 mi from X');
  } finally {
    L.setDistanceUnit('mi');
  }
});

// "20m" next to "1.3 km" reads as twenty METRES, which is the one thing a
// distance chip must never say.
test('a duration printed beside a distance spells its minutes out', () => {
  assert.equal(L.fmtMins(20), '20 min');
  assert.equal(L.fmtMins(59.6), '1 hr');
  assert.equal(L.fmtMins(63), '1 hr 3 min');
  assert.equal(L.fmtMins(120), '2 hr');
  for (const km of [0.4, 1.3, 4.2, 40]) {
    assert.doesNotMatch(L.assistDistanceChipLabel(km, 'X'), /~\d+m\b/, String(km));
  }
});

test('hopTravel names the mode a traveller would actually use, or nothing', () => {
  // a walkable hop names the walk; the ride at that range is a 2 minute taxi
  assert.equal(L.hopTravel(1.3).key, 'walk');
  assert.equal(L.hopTravel(L.WALKABLE_KM).key, 'walk');
  // above it the walk is an hour and the ride is the useful figure
  assert.equal(L.hopTravel(4.2).key, 'ride');
  assert.equal(L.hopTravel(40).key, 'ride');
  // derived from modeOptions, so there is one set of speeds in the app
  const walk = L.modeOptions(1.3, false, false).find(r => r.key === 'walk');
  assert.equal(L.hopTravel(1.3).min, walk.durMin);
  // nothing to say rather than a made-up figure
  for (const bad of [0, -1, null, undefined, NaN]) assert.equal(L.hopTravel(bad), null, String(bad));
});

test('the assistant tooltip adds a travel estimate from the app own route speeds', () => {
  // reused from modeOptions, so there is one set of speed assumptions in the app
  const near = L.assistDistanceChipTitle(1.3, 'Hotel Borg');
  assert.match(near, /straight-line from Hotel Borg, not a walking route\./);
  assert.match(near, /on foot/);
  assert.match(near, /not live traffic/);
  const far = L.assistDistanceChipTitle(4.2, 'Hotel Borg');
  assert.match(far, /by taxi or local transit/);
  // past every in-city mode there is nothing honest to add, so nothing is added
  assert.equal(L.shortHopHint(400), '');
  assert.equal(L.shortHopHint(0), '');
  assert.equal(L.shortHopHint(-3), '');
  assert.equal(L.assistDistanceChipTitle(400, 'X'), L.distanceChipTitle(400, 'X'));
});

test('the assistant distance wording carries no em dash', () => {
  for (const s of [L.assistDistanceChipLabel(2, 'X'), L.assistDistanceChipTitle(2, 'X'),
    L.assistDistanceChipTitle(6, 'X'), L.assistOriginNote({ date: '2027-01-16', label: 'X', city: 'Y', source: 'stay' }),
    L.assistOptionRules('chat'), L.assistOptionRules('plan')]) {
    assert.ok(!s.includes('—'), `em dash in "${s}"`);
  }
});

// ---------- assistant: the origin the MODEL is told about ----------

test('assistOriginNote names the origin, why it is the origin, and stays silent without one', () => {
  const note = L.assistOriginNote({ date: '2027-01-16', label: 'Sotetsu Grand Fresa Bangkok', city: 'Bangkok', source: 'stay' });
  assert.match(note, /is based on 2027-01-16 at Sotetsu Grand Fresa Bangkok in Bangkok/);
  assert.match(note, /the place they are booked into that night/);
  assert.match(note, /Each card is then measured from wherever the traveller will actually be at that hour/);
  assert.match(L.assistOriginNote({ label: 'Bangkok (BKK)', source: 'arrival' }), /where they arrive that day/);
  assert.match(L.assistOriginNote({ label: 'Lunch: Jay Fai', source: 'item' }), /the last thing already on their plan before then/);
  assert.match(L.assistOriginNote({ label: 'Bangkok', source: 'city' }), /the city they are in that day/);
  // an unknown source still reads as a sentence rather than "undefined"
  assert.match(L.assistOriginNote({ label: 'X', source: 'nonsense' }), /where they are that day/);
  // a city that merely repeats the label is not printed twice
  assert.doesNotMatch(L.assistOriginNote({ label: 'Bangkok', city: 'Bangkok', source: 'city' }), /Bangkok in Bangkok/);
  // nothing to say
  for (const bad of [null, undefined, {}, { label: '  ' }, 'string', 5]) {
    assert.equal(L.assistOriginNote(bad), '', JSON.stringify(bad));
  }
});

test('the prompt builders carry the origin only when there is one', () => {
  const trip = { name: 'T', currency: 'USD', items: [] };
  const origin = { date: '2027-01-16', label: 'Sotetsu Grand Fresa Bangkok', city: 'Bangkok', source: 'stay' };
  for (const build of [
    (o) => L.buildAssistSystemPrompt({ trip, focusDate: '2027-01-16', today: '2027-01-01', origin: o }),
    (o) => L.buildAssistPackage({ trip, focusDate: '2027-01-16', request: 'rooftop bars', origin: o }),
  ]) {
    assert.match(build(origin), /is based on 2027-01-16 at Sotetsu Grand Fresa Bangkok/);
    assert.doesNotMatch(build(null), /The traveller is based/);
    assert.doesNotMatch(build(undefined), /The traveller is based/);
  }
});

test('dayBaseOrigin names the bed the traveller is based at, even on the arrival day', () => {
  const items = [BKK_FLIGHT, BKK_HOTEL];
  // the day still OPENS at the airport, and a 10am chip still says so...
  assert.equal(L.dayAnchor(items, '2027-01-16').source, 'arrival');
  assert.equal(L.proposalOrigin(items, '2027-01-16', '10:00').source, 'arrival');
  // ...but a prompt has to name one place to reason about a whole day from,
  // and by any hour that matters that place is the hotel
  const base = L.dayBaseOrigin(items, '2027-01-16');
  assert.equal(base.source, 'stay');
  assert.equal(base.label, 'Sotetsu Grand Fresa Bangkok');
  // no bed that night: the same answer proposalOrigin gives with no hour
  assert.equal(L.dayBaseOrigin([BKK_FLIGHT], '2027-01-16').source, 'arrival');
  assert.equal(L.dayBaseOrigin([], '2027-01-16'), null);
  assert.equal(L.dayBaseOrigin([BKK_HOTEL], 'nope'), null);
});

test('assistOriginNote says based-at rather than starts-from and does not overclaim', () => {
  const note = L.assistOriginNote({ date: '2027-01-16', label: 'H', city: 'Bangkok', source: 'stay' });
  assert.match(note, /is based on 2027-01-16 at H in Bangkok/);
  // the cards measure per hour, so the prompt must not promise they all match
  assert.match(note, /unless something you suggested earlier that day has moved them/);
});

test('proposalOrigin orders a leg by when it LANDS, not when it leaves', () => {
  const items = [BKK_FLIGHT, BKK_HOTEL];   // departs 09:00, lands 13:30
  // mid-flight: the traveller is in the air, so the destination is where the
  // DAY is anchored, never "you are already at the hotel"
  assert.equal(L.proposalOrigin(items, '2027-01-16', '10:00').source, 'arrival');
  // after landing, with a bed booked, it is the bed
  assert.equal(L.proposalOrigin(items, '2027-01-16', '20:00').source, 'stay');
  // an overnight leg lands on a day it did not start on and still counts there
  const overnight = {
    id: 'f9', type: 'flight', title: 'Boston (BOS) to Keflavik (KEF)',
    startDate: '2027-01-15', startTime: '21:30', endDate: '2027-01-16', endTime: '06:45', status: 'booked',
  };
  const after = L.proposalOrigin([overnight], '2027-01-16', '10:00');
  assert.equal(after.source, 'arrival');
  assert.equal(after.iata, 'KEF');
});

test('proposalOrigin: a later plan wins over an earlier one on the same day', () => {
  const at = (id, time, title) => ({
    id, type: 'activity', title, location: 'Bangkok', mapsQuery: title + ' Bangkok',
    startDate: '2027-01-17', startTime: time, status: 'to-book',
  });
  const items = [BKK_HOTEL, at('a1', '10:00', 'Wat Pho'), at('a2', '16:00', 'Jim Thompson House')];
  assert.equal(L.proposalOrigin(items, '2027-01-17', '20:00').item.id, 'a2');
  assert.equal(L.proposalOrigin(items, '2027-01-17', '12:00').item.id, 'a1');
  // exactly AT the same time is not "after" it: two things at 16:00 are one
  // moment, not a leg between them
  assert.equal(L.proposalOrigin(items, '2027-01-17', '16:00').item.id, 'a1');
});

// ---------- guided planner: the picker's controls are the contract ----------
// Two different things were being called "the option count" and only one of
// them is the traveller's to choose:
//   - how many SLOTS a day gets (Activities 1-2 / 2-3 / 3-4, Drinks Skip /
//     1-2 / 2-3, which meals) - picked in the UI, carried by buildPlanRequest;
//   - how many CANDIDATES each slot offers (3 for a meal or drinks slot, 2 for
//     any other activity) - fixed, not exposed anywhere in the picker, and the
//     thing the pick-one card is built around.
// The regression to guard is the prompt's fixed candidate counts silently
// overriding a slot count the traveller actually chose.
const PLAN_BASE = {
  date: '2027-01-16',
  meals: { breakfast: true, lunch: true, dinner: true },
  styles: { activities: [], drinks: [], meals: [] },
  wakeTime: '08:00', returnTime: '22:00', repeatOk: true, budget: [2], note: '',
};

test('the guided request carries the SLOT counts the picker selected', () => {
  const req = (over) => L.buildPlanRequest({ ...PLAN_BASE, ...over }, { name: 'T', currency: 'USD', items: [] });
  // every Activities range the control offers reaches the model as itself
  assert.match(req({ activities: 2 }), /I would like 1-2 activities/);
  assert.match(req({ activities: 3 }), /I would like 2-3 activities/);
  assert.match(req({ activities: 4 }), /I would like 3-4 activities/);
  // ...and both Drinks ranges
  assert.match(req({ drinks: 2 }), /Include 1-2 drinks stops/);
  assert.match(req({ drinks: 3 }), /Include 2-3 drinks stops/);
  // Skip is not silence: silence reads as permission, so it is said out loud
  const skipped = req({ activities: 0, drinks: 0, meals: { breakfast: false, lunch: false, dinner: true } });
  assert.doesNotMatch(skipped, /I would like .* activities/);
  assert.doesNotMatch(skipped, /Include .* drinks stops/);
  assert.match(skipped, /Only plan dinner\./);
  assert.match(skipped, /Do not suggest activities, breakfast, lunch or drinks\./);
});

test('the guided candidate counts never override a selected slot count', () => {
  const prefs = { ...PLAN_BASE, activities: 4, drinks: 3 };
  const request = L.buildPlanRequest(prefs, { name: 'T', currency: 'USD', items: [] });
  const sys = L.buildAssistSystemPrompt({ trip: { name: 'T', currency: 'USD', items: [] }, mode: 'plan' });
  // the per-slot candidate counts are scoped to the slots that were ASKED for,
  // so neither rule can turn into "and therefore plan 3 activities"
  assert.match(sys, /each meal slot and each drinks slot the traveller asked for \(and only those\)/);
  assert.match(sys, /For every OTHER activity you suggest/);
  // and the two numbers never collide: the request owns how many slots, the
  // prompt owns how many candidates per slot, and they say different things
  assert.match(request, /3-4 activities, and give me 2 options for each one/);
  assert.match(request, /give me 3 options for each one/);
  // the prompt states no slot count of its own at all
  assert.doesNotMatch(sys, /\d-\d activities/);
  assert.doesNotMatch(sys, /drinks stops/);
});

test('the guided prompt keeps its candidate counts out of free-form chat', () => {
  const trip = { name: 'T', currency: 'USD', items: [] };
  const plan = L.buildAssistSystemPrompt({ trip, mode: 'plan' });
  const chat = L.buildAssistSystemPrompt({ trip, mode: 'chat' });
  assert.match(plan, /EXACTLY 3 candidates/);
  assert.doesNotMatch(chat, /EXACTLY \d/);
  // and neither mode invents a slot the traveller did not ask for
  for (const s of [plan, chat]) assert.match(s, /Never introduce a slot type the traveller did not request/);
});

// ---------- the day route: totals, mode, external URLs ----------
// One chain feeds every surface: these helpers read dayDistanceChain legs
// verbatim, so the per-card chips, the day totals and the Google Maps route
// can never disagree about what the day contains.

test('dayTravelTotals sums the chain legs by the same mode judgement the chips print', () => {
  const legs = [
    { id: 0, km: 1.2 },  // walk (under WALKABLE_KM)
    { id: 1, km: 0.6 },  // walk
    { id: 2, km: 4.8 },  // ride
    { id: 3, km: 0 },    // no distance: not a leg, not counted
    null,                // tolerated
  ];
  const t = L.dayTravelTotals(legs);
  assert.ok(Math.abs(t.byMode.walk - 1.8) < 1e-9);
  assert.ok(Math.abs(t.byMode.ride - 4.8) < 1e-9);
  assert.ok(Math.abs(t.km - 6.6) < 1e-9);
  assert.equal(t.legCount, 3);
  // an intercity hop inside one day still counts, under ride, rather than
  // silently vanishing from the total
  assert.ok(L.dayTravelTotals([{ km: 400 }]).byMode.ride === 400);
  // empty in, empty out
  assert.deepEqual(L.dayTravelTotals([]).byMode, { walk: 0, ride: 0 });
  assert.equal(L.dayTravelTotals(undefined).km, 0);
});

test('dayRouteMode is walking only when EVERY leg is walkable, else driving', () => {
  assert.equal(L.dayRouteMode([{ km: 0.5 }, { km: 1.9 }]), 'walking');
  assert.equal(L.dayRouteMode([{ km: 0.5 }, { km: 3.1 }]), 'driving');
  assert.equal(L.dayRouteMode([{ km: L.WALKABLE_KM }]), 'walking');
  // no located legs: walking is the harmless default for a link that will not
  // be offered anyway (the caller needs a chain to build the URL at all)
  assert.equal(L.dayRouteMode([]), 'walking');
});

test('directionsRouteUrl carries origin, ordered waypoints, destination and one mode', () => {
  const url = L.directionsRouteUrl('Hotel Borg', ['Breakfast Cafe', 'Meiji Jingu'], 'Shibuya Sky', 'walking');
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1'));
  assert.ok(url.includes('origin=Hotel%20Borg'));
  assert.ok(url.includes('waypoints=Breakfast%20Cafe%7CMeiji%20Jingu'));
  assert.ok(url.includes('destination=Shibuya%20Sky'));
  assert.ok(url.includes('travelmode=walking'));
  // a whole-day URL needs BOTH ends: destination-only is the single-leg
  // link's affordance, not the route's
  assert.equal(L.directionsRouteUrl('', ['A'], 'B', 'walking'), '');
  assert.equal(L.directionsRouteUrl('A', ['B'], '', 'walking'), '');
  // transit does not support waypoints in the Maps URL API; anything but the
  // two supported modes falls back to driving rather than lying
  assert.match(L.directionsRouteUrl('A', [], 'B', 'transit'), /travelmode=driving/);
  // unlocatable waypoints are dropped from the URL, never turned into ""
  assert.ok(!L.directionsRouteUrl('A', ['', null, 'C'], 'B', 'driving').includes('%7C%7C'));
});

test('routeUrlChunks splits a long day without dropping or duplicating stops', () => {
  const q = n => Array.from({ length: n }, (_, i) => `Stop ${i}`);
  // a normal day fits one link
  assert.deepEqual(L.routeUrlChunks(q(5)), [q(5)]);
  // fewer than two stops is no route
  assert.deepEqual(L.routeUrlChunks(q(1)), []);
  assert.deepEqual(L.routeUrlChunks([]), []);
  // a 15-stop day exceeds origin + 9 waypoints + destination and splits;
  // each part starts where the previous ended, and every stop appears
  const chunks = L.routeUrlChunks(q(15));
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 11, `chunk of ${c.length}`);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i][0], chunks[i - 1][chunks[i - 1].length - 1], 'parts must be continuous');
  }
  const seen = chunks.flat();
  // interior boundaries appear twice (end of one part, start of the next)
  assert.deepEqual([...new Set(seen)], q(15), 'every stop appears, in order');
});

// ---------- pick-one candidate badges ----------
test('candidateBadges crowns fastest by leg distance, rated by rating, popular by review count', () => {
  const out = L.candidateBadges({
    kms: [1.2, 0.4, 2.0],
    ratings: [{ rating: 4.1, count: 250 }, { rating: 4.8, count: 90 }, { rating: 4.4, count: 1660 }],
  });
  assert.deepEqual(out[0].map(b => b.id), []);
  assert.deepEqual(out[1].map(b => b.id), ['fastest', 'rated']);
  assert.deepEqual(out[2].map(b => b.id), ['popular']);
  // each badge names itself for the card
  assert.equal(out[1].find(b => b.id === 'fastest').icon, '⚡');
  assert.equal(out[1].find(b => b.id === 'rated').label, 'Highest rated');
  assert.equal(out[2][0].label, 'Most popular');
});

test('candidateBadges ties break to candidate order, deterministically', () => {
  const out = L.candidateBadges({
    kms: [0.8, 0.8, 0.8],
    ratings: [{ rating: 4.5, count: 100 }, { rating: 4.5, count: 100 }, null],
  });
  assert.deepEqual(out[0].map(b => b.id), ['fastest', 'rated', 'popular']);
  assert.deepEqual(out[1], []);
  assert.deepEqual(out[2], []);
});

test('candidateBadges never fabricates a comparison from missing data', () => {
  // no ratings resolved: no rated/popular badge anywhere
  const noRatings = L.candidateBadges({ kms: [1, 2], ratings: [null, null] });
  assert.deepEqual(noRatings.flat().map(b => b.id), ['fastest']);
  // only ONE candidate resolved: that is missing data, not a win
  const oneKm = L.candidateBadges({ kms: [1, null, null], ratings: [null, null, null] });
  assert.deepEqual(oneKm.flat(), []);
  const oneRating = L.candidateBadges({ kms: [null, null], ratings: [{ rating: 5, count: 10 }, null] });
  assert.deepEqual(oneRating.flat(), []);
  // a rating with no reviews competes for rated but not for popular
  const zeroCount = L.candidateBadges({ kms: [null, null], ratings: [{ rating: 4.9, count: 0 }, { rating: 4.1, count: 0 }] });
  assert.deepEqual(zeroCount.flat().map(b => b.id), ['rated']);
  // one candidate is not a comparison at all
  assert.deepEqual(L.candidateBadges({ kms: [1], ratings: [{ rating: 5, count: 5 }] }), [[]]);
  // one candidate may legitimately win everything
  const sweep = L.candidateBadges({
    kms: [0.3, 1.4],
    ratings: [{ rating: 4.9, count: 900 }, { rating: 4.0, count: 20 }],
  });
  assert.deepEqual(sweep[0].map(b => b.id), ['fastest', 'rated', 'popular']);
  assert.deepEqual(sweep[1], []);
});
