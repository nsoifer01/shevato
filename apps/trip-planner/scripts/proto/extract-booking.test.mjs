import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBookings, parseDate, parseTime, parseMoney, findConfirmation, findRoute, toLines } from './extract-booking.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(readFileSync(resolve(HERE, '../../data/airports.json'), 'utf8'));
const AIRPORTS = payload.rows.map(r => ({
  iata: r[0], name: r[1], city: r[2], cc: r[3], lat: r[4], lon: r[5], big: r[6] === 1, alt: r[7],
}));
const run = (text, opts) => extractBookings(text, { airports: AIRPORTS, ...opts });
const byIata = new Map(AIRPORTS.map(a => [a.iata, a]));

// ---------- dates ----------

test('parseDate reads the formats confirmations actually print', () => {
  assert.equal(parseDate('2027-08-12').iso, '2027-08-12');
  assert.equal(parseDate('12 Aug 2027').iso, '2027-08-12');
  assert.equal(parseDate('12 August 2027').iso, '2027-08-12');
  assert.equal(parseDate('Aug 12, 2027').iso, '2027-08-12');
  assert.equal(parseDate('August 12 2027').iso, '2027-08-12');
  assert.equal(parseDate('Departs: Sat, 12 Aug 2027').iso, '2027-08-12');
  assert.equal(parseDate('12-Aug-2027').iso, '2027-08-12');
});

test('parseDate rejects impossible dates rather than normalising them', () => {
  assert.equal(parseDate('31 Feb 2027'), null);
  assert.equal(parseDate('2027-02-30'), null);
  assert.equal(parseDate('no date here'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
});

test('an all-numeric date is flagged ambiguous instead of silently guessed', () => {
  // THE dangerous case: 08/12 is August 12th to a US carrier and 12th August
  // to a European one, and the string alone cannot say which.
  const a = parseDate('08/12/2027');
  assert.equal(a.ambiguous, true);
  assert.equal(a.iso, '2027-12-08');            // day-first default...
  assert.equal(parseDate('08/12/2027', { dayFirst: false }).iso, '2027-08-12');  // ...and the flip

  // Unambiguous whenever one number cannot be a month.
  const b = parseDate('25/12/2027');
  assert.equal(b.ambiguous, false);
  assert.equal(b.iso, '2027-12-25');
  const c = parseDate('12/25/2027');
  assert.equal(c.ambiguous, false);
  assert.equal(c.iso, '2027-12-25');
});

// ---------- times, money, references ----------

test('parseTime handles 24h and am/pm', () => {
  assert.equal(parseTime('21:30'), '21:30');
  assert.equal(parseTime('09:05'), '09:05');
  assert.equal(parseTime('9:30 PM'), '21:30');
  assert.equal(parseTime('9:30 am'), '09:30');
  assert.equal(parseTime('12:15 AM'), '00:15');
  assert.equal(parseTime('12:15 PM'), '12:15');
  assert.equal(parseTime('no time'), null);
});

test('parseMoney reads symbols before and codes on either side', () => {
  assert.deepEqual(parseMoney('Total: £1,234.56'), { value: 1234.56, currency: 'GBP' });
  assert.deepEqual(parseMoney('Total EUR 220.00'), { value: 220, currency: 'EUR' });
  assert.deepEqual(parseMoney('220.00 USD'), { value: 220, currency: 'USD' });
  assert.equal(parseMoney('no price'), null);
});

test('a booking reference is only read next to a label', () => {
  assert.equal(findConfirmation(toLines('Booking reference: XJ7K2Q')).code, 'XJ7K2Q');
  assert.equal(findConfirmation(toLines('Confirmation code\nAB12CD')).code, 'AB12CD');
  assert.equal(findConfirmation(toLines('PNR 7QRSTU')).code, '7QRSTU');
  // An unlabelled six-character token is far more often a fare class or an
  // aircraft type than a PNR, and a confident wrong code is worse than none.
  assert.equal(findConfirmation(toLines('Aircraft B77W Economy Y')), null);
  assert.equal(findConfirmation(toLines('Nothing here at all')), null);
});

// ---------- routes ----------

test('an explicit route is trusted and resolved against the airport table', () => {
  const r = findRoute(toLines('LHR -> JFK'), byIata);
  assert.equal(r.from, 'LHR');
  assert.equal(r.to, 'JFK');
  assert.equal(r.explicit, true);
  assert.equal(findRoute(toLines('London LHR to New York JFK'), byIata).explicit, true);
  assert.equal(findRoute(toLines('NRT / SIN'), byIata).from, 'NRT');
});

test('three-letter words that are also real airports do not become routes', () => {
  // ALL (Albenga), ARE (Arecibo), CAR (Caruaru), ONE (Onepusu) and VAT
  // (Vatomandry) are all genuine IATA codes, so the airport table cannot
  // reject them on its own.
  assert.equal(findRoute(toLines('ALL FARES ARE SUBJECT TO TAX'), byIata), null);
  assert.equal(findRoute(toLines('ONE CAR PER BOOKING'), byIata), null);
  assert.equal(findRoute(toLines('VAT INCLUDED FOR THE NEW FEE'), byIata), null);
});

test('two bare codes are accepted but marked non-explicit', () => {
  const r = findRoute(toLines('Departure LHR\nArrival JFK'), byIata);
  assert.equal(r.explicit, false);
  assert.equal(r.from, 'LHR');
  // three or more bare codes is too weak a claim to guess a direction from
  assert.equal(findRoute(toLines('LHR\nJFK\nCDG'), byIata), null);
});

// ---------- whole confirmations ----------

const BA = `British Airways - Electronic Ticket Receipt
Booking reference: XJ7K2Q
Passenger: MR A TRAVELLER

Flight BA 179
London Heathrow (LHR) to New York JFK (JFK)
Departs: Sat, 12 Aug 2027 at 21:30
Arrives: Sun, 13 Aug 2027 at 06:45
Cabin: World Traveller Plus
Total fare: GBP 812.40`;

test('a realistic airline confirmation extracts as one flight item', () => {
  const { proposals } = run(BA);
  assert.equal(proposals.length, 1);
  const p = proposals[0];
  assert.equal(p.kind, 'flight');
  assert.equal(p.confidence, 'high');
  assert.equal(p.item.type, 'flight');
  assert.equal(p.item.startDate, '2027-08-12');
  assert.equal(p.item.startTime, '21:30');
  assert.equal(p.item.endTime, '06:45');
  assert.equal(p.item.confirmation, 'XJ7K2Q');
  assert.equal(p.item.cost, 812.4);
  assert.equal(p.item.costCurrency, 'GBP');
  assert.match(p.item.title, /\(LHR\) to .*\(JFK\)/);
  assert.match(p.item.details, /BA179/);
  // status is booked, not to-book: this came off the traveller's own
  // confirmation, not from a model's suggestion
  assert.equal(p.item.status, 'booked');
});

test('the overnight leg gets an explicit landing date', () => {
  const p = run(BA).proposals[0];
  assert.equal(p.item.endDate, '2027-08-13');
  assert.ok(p.warnings.some(w => /overnight/i.test(w)));
});

test('the composed title is the shape the day cards already parse', () => {
  // dayMorningCity runs parseTravelOrigin + stripPlaceCode over this to decide
  // which city a travel day starts in, so the shape is load-bearing.
  const t = run(BA).proposals[0].item.title;
  assert.equal(/^(.*?)\s+to\s+.+$/.exec(t)[1].replace(/\([^)]*\)/g, '').trim(), 'London');
});

test('every proposal carries the source line for each field it filled', () => {
  const p = run(BA).proposals[0];
  const fields = p.evidence.map(e => e.field);
  for (const f of ['route', 'startDate', 'startTime', 'confirmation', 'cost']) {
    assert.ok(fields.includes(f), 'missing evidence for ' + f);
  }
  // every piece of evidence points at a real line of the document
  for (const e of p.evidence) {
    assert.ok(e.line >= 0 && typeof e.raw === 'string' && e.raw.length > 0);
  }
});

test('an ambiguous date downgrades confidence and says why', () => {
  const p = run(BA.replace('Sat, 12 Aug 2027', '08/12/2027')
    .replace('Sun, 13 Aug 2027', '09/12/2027')).proposals[0];
  assert.equal(p.confidence, 'medium');
  assert.ok(p.warnings.some(w => /ambiguous/i.test(w)));
});

test('an inferred (non-explicit) route downgrades to low and warns', () => {
  const p = run(`Booking reference: XJ7K2Q
Departure airport LHR
Arrival airport JFK
Departs 12 Aug 2027 21:30
Arrives 13 Aug 2027 06:45`).proposals[0];
  assert.equal(p.confidence, 'low');
  assert.ok(p.warnings.some(w => /inferred/i.test(w)));
});

const HOTEL = `Hotel Estherea
Singel 303, Amsterdam
Reservation confirmed
Confirmation number: 4471QP
Check-in: 12 August 2027
Check-out: 16 August 2027
4 nights, 1 double room
Total price: EUR 760.00`;

test('a hotel confirmation extracts as a stay with both dates', () => {
  const { proposals } = run(HOTEL);
  const stay = proposals.find(p => p.kind === 'stay');
  assert.ok(stay, 'no stay proposal');
  assert.equal(stay.item.type, 'stay');
  assert.equal(stay.item.startDate, '2027-08-12');
  assert.equal(stay.item.endDate, '2027-08-16');
  assert.equal(stay.item.title, 'Hotel Estherea');
  assert.equal(stay.item.confirmation, '4471QP');
  assert.equal(stay.item.cost, 760);
  assert.equal(stay.item.costCurrency, 'EUR');
  // a property name is free text with no code to anchor it, so a hotel never
  // claims high confidence
  assert.notEqual(stay.confidence, 'high');
});

test('reversed stay dates are reported rather than quietly swapped', () => {
  const stay = run(HOTEL.replace('Check-in: 12 August 2027', 'Check-in: 20 August 2027'))
    .proposals.find(p => p.kind === 'stay');
  assert.ok(stay.warnings.some(w => /not after/i.test(w)));
});

test('unreadable input yields nothing rather than a guess', () => {
  const r = run('Thank you for your purchase. Your order will arrive soon.');
  assert.deepEqual(r.proposals, []);
  assert.equal(r.stats.unreadable, true);
  assert.deepEqual(run('').proposals, []);
});

test('extracted fields survive the app\'s own sanitiser shape', () => {
  // The proposal has to be expressible in the fields the app accepts, or the
  // whole approach fails at the hand-off.
  const { item } = run(BA).proposals[0];
  const allowed = new Set(['type', 'title', 'location', 'startDate', 'endDate',
    'startTime', 'endTime', 'status', 'cost', 'costCurrency', 'costNote',
    'details', 'mapsQuery', 'confirmation']);
  for (const k of Object.keys(item)) assert.ok(allowed.has(k), 'unexpected field: ' + k);
  assert.match(item.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(item.startTime, /^\d{2}:\d{2}$/);
  assert.ok(item.cost >= 0);
  assert.match(item.costCurrency, /^[A-Z]{3}$/);
});
