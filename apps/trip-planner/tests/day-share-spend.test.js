'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

const { dayShareText, weekStart, spendByWeek, dayCards, sumInCurrency, typeBarShares } = L;

// The two formatters the app injects, reproduced exactly (see app.js fmtDate /
// fmtTime): the shared text has to print the date and the clock format the
// screen beside it is printing, so the tests drive the real thing.
const FMT_FULL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtDate = s => FMT_FULL.format(new Date(s + 'T00:00:00Z'));
const fmtTime = use24h => t => {
  if (!t) return '';
  if (use24h) return t;
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const item = (over = {}) => ({
  id: over.id || 'i' + Math.random().toString(36).slice(2, 8),
  type: 'activity', title: 'Thing', location: '', status: 'booked',
  startDate: '2027-03-02', startTime: '', cost: null, ...over,
});
const cardFor = (items, date) => dayCards({ id: 't1', currency: 'USD', items }).find(c => c.date === date);

// ---------- dayShareText ----------
// Format (owner-directed, 2026-08-10): sections separated by blank lines -
// a calendar-emoji date header, timed rows carrying the card's type icon,
// untimed rows bulleted under "No time set:", and the stay set apart last
// with a hotel emoji. Pinned as exact strings because the text IS the
// product here (it lands in messages verbatim).

test('dayShareText leads with the formatted date and prints timed rows in 12-hour clock', () => {
  const items = [
    item({ id: 'a', title: 'Louvre tickets', location: 'Paris', startTime: '09:30' }),
    item({ id: 'b', title: 'Dinner', location: 'Paris', startTime: '19:05' }),
  ];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(text, [
    '\u{1F4C5} Mar 2, 2027',
    '',
    '9:30 AM \u{1F39F}\uFE0F Louvre tickets, Paris',
    '7:05 PM \u{1F39F}\uFE0F Dinner, Paris',
  ].join('\n'));
});

test('dayShareText follows the 24-hour preference, because the message must match the screen', () => {
  const items = [item({ id: 'a', title: 'Louvre tickets', location: 'Paris', startTime: '09:30' })];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(true));
  assert.equal(text.split('\n')[2], '09:30 \u{1F39F}\uFE0F Louvre tickets, Paris');
});

test('dayShareText keeps the card order: timed rows first, then everything under "No time set"', () => {
  const items = [
    item({ id: 'a', title: 'Breakfast', startTime: '08:00' }),
    item({ id: 'b', title: 'Wander the souks' }),
    item({ id: 'c', title: 'Museum', startTime: '14:00' }),
    item({ id: 'd', title: 'Buy a SIM card' }),
  ];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.deepEqual(text.split('\n'), [
    '\u{1F4C5} Mar 2, 2027',
    '',
    '8:00 AM \u{1F39F}\uFE0F Breakfast',
    '2:00 PM \u{1F39F}\uFE0F Museum',
    '',
    'No time set:',
    '\u2022 \u{1F39F}\uFE0F Wander the souks',
    '\u2022 \u{1F39F}\uFE0F Buy a SIM card',
  ]);
});

test('dayShareText omits the "No time set" heading when every row has a clock time', () => {
  const items = [item({ id: 'a', title: 'Museum', startTime: '14:00' })];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(text.includes('No time set:'), false);
});

test('dayShareText names the covering stay once, never as two check-in/check-out rows', () => {
  const items = [
    item({ id: 's', type: 'stay', title: 'Riad Yasmine', location: 'Marrakesh', startDate: '2027-03-01', endDate: '2027-03-04' }),
    item({ id: 'a', title: 'Museum', startTime: '14:00' }),
  ];
  // check-in day, an interior day and the check-out day all say it once
  for (const d of ['2027-03-01', '2027-03-02', '2027-03-04']) {
    const text = dayShareText(cardFor(items, d), items, fmtDate, fmtTime(false));
    const hits = text.split('\n').filter(l => l.includes('Riad Yasmine'));
    assert.deepEqual(hits, ['\u{1F3E8} Staying at: Riad Yasmine'], `on ${d}`);
    assert.equal(text.includes('Check in'), false);
    assert.equal(text.includes('Check out'), false);
  }
});

test('dayShareText leaves out the stay line on a day no stay covers', () => {
  const items = [item({ id: 'a', title: 'Museum', startTime: '14:00' })];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(text.includes('Staying at:'), false);
});

test('dayShareText carries the confirmation code exactly where the .ics export carries it', () => {
  const items = [
    item({ id: 'a', type: 'flight', title: 'Paris to Lisbon', startTime: '06:40', confirmation: 'XK92QT' }),
    item({ id: 'b', title: 'Museum', startTime: '14:00' }),
  ];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.deepEqual(text.split('\n'), [
    '\u{1F4C5} Mar 2, 2027',
    '',
    '6:40 AM \u2708\uFE0F Paris to Lisbon',
    'Ref: XK92QT',
    '2:00 PM \u{1F39F}\uFE0F Museum',
  ]);
  // and the .ics agrees about which item carries one
  const ics = L.buildIcs({ name: 'T', currency: 'USD', items });
  assert.equal(ics.includes('Ref: XK92QT'), true);
});

test('dayShareText carries the hotel code on the check-in day only, where the card and the .ics both put it', () => {
  const items = [
    item({ id: 's', type: 'stay', title: 'Riad Yasmine', location: 'Marrakesh', startDate: '2027-03-01', endDate: '2027-03-04', confirmation: 'RY-7781' }),
    item({ id: 'a', title: 'Museum', startTime: '14:00' }),
  ];
  const checkIn = dayShareText(cardFor(items, '2027-03-01'), items, fmtDate, fmtTime(false));
  assert.deepEqual(checkIn.split('\n').slice(-2), ['\u{1F3E8} Staying at: Riad Yasmine', 'Ref: RY-7781']);
  // a night in the middle of the same stay repeats the bed, never the code
  const interior = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(interior.includes('Staying at: Riad Yasmine'), true);
  assert.equal(interior.includes('RY-7781'), false);
});

test('dayShareText writes no Ref line for an item with a blank confirmation', () => {
  const items = [item({ id: 'a', title: 'Museum', startTime: '14:00', confirmation: '   ' })];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(text.includes('Ref:'), false);
});

test('dayShareText says a cancelled row is cancelled, because displayTitle strips the prefix', () => {
  // a live row too: tripStats ignores cancelled dates, so a day made only of
  // them is not a day the card grid draws at all
  const items = [
    item({ id: 'a', title: 'Cancelled: Museum', startTime: '14:00', status: 'cancelled' }),
    item({ id: 'b', title: 'Dinner', startTime: '19:00' }),
  ];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(text.split('\n')[2], '2:00 PM \u{1F39F}\uFE0F Museum (Cancelled)');
  assert.equal(text.split('\n')[3], '7:00 PM \u{1F39F}\uFE0F Dinner');
});

test('dayShareText NEVER leaks trip essentials: they live on the trip, not the day', () => {
  const items = [item({ id: 'a', title: 'Museum', location: 'Paris', startTime: '14:00' })];
  const trip = {
    id: 't1', currency: 'USD', items,
    essentials: {
      contactName: 'Dana Reyes', contactPhone: '+1 555 0100',
      insurer: 'Northbound Travel Cover', insurerPhone: '+1 555 0199',
      medical: 'penicillin allergy',
    },
  };
  const card = dayCards(trip).find(c => c.date === '2027-03-02');
  const text = dayShareText(card, trip.items, fmtDate, fmtTime(false));
  for (const secret of Object.values(trip.essentials)) {
    assert.equal(text.includes(secret), false, secret);
  }
});

// ---------- weekStart / spendByWeek ----------

test('weekStart walks back to Monday, and a Sunday belongs to the week that opened six days earlier', () => {
  assert.equal(weekStart('2027-03-01'), '2027-03-01'); // Monday
  assert.equal(weekStart('2027-03-04'), '2027-03-01'); // Thursday
  assert.equal(weekStart('2027-03-07'), '2027-03-01'); // Sunday
  assert.equal(weekStart('2027-03-08'), '2027-03-08'); // next Monday
});

test('spendByWeek buckets booked costed items by the ISO week of their start date', () => {
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 100 }),
    item({ id: 'b', startDate: '2027-03-07', cost: 50 }),
    item({ id: 'c', startDate: '2027-03-08', cost: 25 }),
  ] };
  const weeks = spendByWeek(trip, { base: 'USD', rates: {} });
  assert.deepEqual(weeks.map(w => [w.start, w.total]), [
    ['2027-03-01', 150],
    ['2027-03-08', 25],
  ]);
});

test('spendByWeek counts only booked, costed items, so it agrees with the Confirmed total', () => {
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 100 }),
    item({ id: 'b', startDate: '2027-03-09', cost: 400, status: 'to-book' }),
    item({ id: 'c', startDate: '2027-03-09', cost: 900, status: 'cancelled' }),
    item({ id: 'd', startDate: '2027-03-09', cost: null }),
    item({ id: 'e', startDate: '2027-03-09', cost: 60 }),
  ] };
  const weeks = spendByWeek(trip, { base: 'USD', rates: {} });
  assert.deepEqual(weeks.map(w => [w.start, w.total]), [
    ['2027-03-01', 100],
    ['2027-03-08', 60],
  ]);
});

test('spendByWeek keeps a spend-free week between two spending ones, so the shape stays honest', () => {
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 100 }),
    item({ id: 'b', startDate: '2027-03-16', cost: 40 }),
  ] };
  const weeks = spendByWeek(trip, { base: 'USD', rates: {} });
  assert.deepEqual(weeks.map(w => [w.start, w.total]), [
    ['2027-03-01', 100],
    ['2027-03-08', 0],
    ['2027-03-15', 40],
  ]);
  // a zero week draws no bar rather than a stub that suggests spend
  assert.deepEqual(typeBarShares(weeks), [1, 0, 0.4]);
});

test('spendByWeek keeps the buckets sparse rather than filling millions of weeks for a mistyped year', () => {
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 100 }),
    item({ id: 'b', startDate: '9027-03-02', cost: 40 }),
  ] };
  const weeks = spendByWeek(trip, { base: 'USD', rates: {} });
  assert.equal(weeks.length, 2);
  assert.deepEqual(weeks.map(w => w.total), [100, 40]);
});

test('spendByWeek is empty when nothing is booked and costed, so the block can stay out of the DOM', () => {
  const trip = { id: 't1', currency: 'USD', items: [item({ id: 'a', startDate: '2027-03-02', status: 'to-book', cost: 100 })] };
  assert.deepEqual(spendByWeek(trip, { base: 'USD', rates: {} }), []);
});

test('spendByWeek sets an unconvertible amount aside in its own week instead of dropping it', () => {
  const rates = { base: 'USD', rates: { EUR: 0.9 } };
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 90, costCurrency: 'EUR' }),
    item({ id: 'b', startDate: '2027-03-03', cost: 5000, costCurrency: 'JPY' }),
  ] };
  const weeks = spendByWeek(trip, rates);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].total, 100);
  assert.deepEqual(weeks[0].unconverted.map(i => i.id), ['b']);
});

test('the bars add up to the Confirmed bookings total to the cent, in mixed currencies', () => {
  const rates = { base: 'USD', rates: { EUR: 0.9, GBP: 0.8, JPY: 150 } };
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 1234.56 }),
    item({ id: 'b', startDate: '2027-03-04', cost: 899.99, costCurrency: 'EUR' }),
    item({ id: 'c', startDate: '2027-03-11', cost: 44000, costCurrency: 'JPY' }),
    item({ id: 'd', startDate: '2027-03-12', cost: 67.4, costCurrency: 'GBP' }),
    item({ id: 'e', startDate: '2027-03-19', cost: -250.5 }),
    // excluded on both sides of the comparison, for the same reasons
    item({ id: 'f', startDate: '2027-03-19', cost: 800, status: 'to-book' }),
    item({ id: 'g', startDate: '2027-03-19', cost: 900, status: 'cancelled' }),
  ] };
  const confirmed = sumInCurrency(trip.items.filter(i => i.status === 'booked'), 'USD', rates);
  const weeks = spendByWeek(trip, rates);
  assert.equal(weeks.length, 3);
  assert.equal(confirmed.unconverted.length, 0);
  const sum = weeks.reduce((n, w) => n + w.total, 0);
  assert.equal(sum.toFixed(2), confirmed.total.toFixed(2));
});

test('an unconvertible item is missing from the bars and from the Confirmed total alike, and is counted in both', () => {
  const rates = { base: 'USD', rates: { EUR: 0.9 } };
  const trip = { id: 't1', currency: 'USD', items: [
    item({ id: 'a', startDate: '2027-03-02', cost: 300 }),
    item({ id: 'b', startDate: '2027-03-11', cost: 90, costCurrency: 'EUR' }),
    item({ id: 'c', startDate: '2027-03-11', cost: 900000, costCurrency: 'JPY' }),
  ] };
  const confirmed = sumInCurrency(trip.items.filter(i => i.status === 'booked'), 'USD', rates);
  const weeks = spendByWeek(trip, rates);
  const sum = weeks.reduce((n, w) => n + w.total, 0);
  assert.equal(sum.toFixed(2), confirmed.total.toFixed(2));
  assert.equal(weeks.reduce((n, w) => n + w.unconverted.length, 0), confirmed.unconverted.length);
});

// Owner-reported: a stay entered with only a title (Place left blank) printed
// no "Staying at" line, because the lookup reused dayHostStay, whose location
// requirement exists for the which-city question (weather chips, day
// headers). The copy uses shareHostStay: same date windows, no location gate.
test('dayShareText names a stay that has a title but no Place', () => {
  const items = [
    item({ id: 's', type: 'stay', title: 'Hotel Park Split', startDate: '2027-03-01', endDate: '2027-03-04' }),
    item({ id: 'a', title: 'Museum', startTime: '14:00' }),
  ];
  const text = dayShareText(cardFor(items, '2027-03-02'), items, fmtDate, fmtTime(false));
  assert.equal(text.split('\n').pop(), '\u{1F3E8} Staying at: Hotel Park Split');
});

test('shareHostStay keeps dayHostStay date windows: night wins, checkout still answers', () => {
  const stay = item({ id: 's', type: 'stay', title: 'Hotel Park Split', startDate: '2027-03-01', endDate: '2027-03-04' });
  assert.equal(L.shareHostStay([stay], '2027-03-01').id, 's'); // check-in night
  assert.equal(L.shareHostStay([stay], '2027-03-03').id, 's'); // last night
  assert.equal(L.shareHostStay([stay], '2027-03-04').id, 's'); // checkout morning
  assert.equal(L.shareHostStay([stay], '2027-03-05'), null);   // gone
  const cancelled = { ...stay, status: 'cancelled' };
  assert.equal(L.shareHostStay([cancelled], '2027-03-02'), null);
});
