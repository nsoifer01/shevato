import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBookings, parseDate, parseTime, parseMoney, findConfirmation, findRoute, toLines, inferDateOrder } from './extract-booking.mjs';

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

test('an all-numeric date is read MONTH-FIRST and flagged ambiguous', () => {
  // THE dangerous case: 08/12 is August 12th to a US carrier and 12th August
  // to a European one, and the string alone cannot say which. Month-first is
  // the owner's chosen default; the flag flips it.
  const a = parseDate('08/12/2027');
  assert.equal(a.ambiguous, true);
  assert.equal(a.iso, '2027-08-12');                                    // month-first default
  assert.equal(a.altIso, '2027-12-08');                                 // the other reading, named
  assert.equal(parseDate('08/12/2027', { dayFirst: true }).iso, '2027-12-08');
  assert.equal(parseDate('08/12/2027', { dayFirst: true }).altIso, '2027-08-12');

  // A number that cannot be a month settles it from the numbers alone, and
  // the default is not consulted either way.
  const b = parseDate('25/12/2027');
  assert.equal(b.ambiguous, false);
  assert.equal(b.iso, '2027-12-25');
  assert.equal(b.altIso, undefined);
  assert.equal(parseDate('25/12/2027', { dayFirst: true }).iso, '2027-12-25');
  const c = parseDate('12/25/2027');
  assert.equal(c.ambiguous, false);
  assert.equal(c.iso, '2027-12-25');
  assert.equal(parseDate('12/25/2027', { dayFirst: true }).iso, '2027-12-25');

  // Same number both sides is not ambiguous: both readings are the same day.
  assert.equal(parseDate('07/07/2027').ambiguous, false);
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

test('an ambiguous date downgrades confidence and names both readings', () => {
  const p = run(BA.replace('Sat, 12 Aug 2027', '08/12/2027')
    .replace('Sun, 13 Aug 2027', '09/12/2027')).proposals[0];
  assert.equal(p.confidence, 'medium');
  // month-first, so this lands on the same day the spelled-out version did
  assert.equal(p.item.startDate, '2027-08-12');
  const w = p.warnings.find(x => /no way to tell the order/i.test(x));
  assert.ok(w, 'no order warning');
  assert.match(w, /2027-08-12/);   // as read
  assert.match(w, /2027-12-08/);   // and the alternative, spelled out
});

test('the whole extraction honours the day-first flag when asked', () => {
  const text = BA.replace('Sat, 12 Aug 2027', '08/12/2027').replace('Sun, 13 Aug 2027', '09/12/2027');
  assert.equal(run(text).proposals[0].item.startDate, '2027-08-12');
  assert.equal(run(text, { dayFirst: true }).proposals[0].item.startDate, '2027-12-08');
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

// ---------- per-document date-order inference ----------

test('a decisive date settles the order for the whole document', () => {
  const dmy = inferDateOrder(toLines('Issued 25/12/2027\nDeparts 08/12/2027'));
  assert.equal(dmy.dayFirst, true);
  assert.equal(dmy.source, 'document');
  assert.equal(dmy.evidence[0].raw, '25/12/2027');

  const mdy = inferDateOrder(toLines('Issued 12/25/2027\nDeparts 08/12/2027'));
  assert.equal(mdy.dayFirst, false);
  assert.equal(mdy.source, 'document');
});

test('document evidence beats the caller default, in both directions', () => {
  // the caller asking for day-first does not override a document that
  // demonstrably writes month-first
  const o = inferDateOrder(toLines('Issued 12/25/2027'), { dayFirst: true });
  assert.equal(o.dayFirst, false);
  assert.equal(o.source, 'document');
});

test('with no decisive date the caller default is used and named as such', () => {
  const a = inferDateOrder(toLines('Departs 08/12/2027'));
  assert.equal(a.source, 'default');
  assert.equal(a.dayFirst, false);
  assert.deepEqual(a.evidence, []);
  assert.equal(inferDateOrder(toLines('Departs 08/12/2027'), { dayFirst: true }).dayFirst, true);
  assert.equal(inferDateOrder([]).source, 'default');
});

test('a date that is impossible under the order it forces does not vote', () => {
  // 31/02 looks day-first on its face, but 31 February is not a date, so it
  // is not evidence of anything
  assert.equal(inferDateOrder(toLines('Ref 31/02/2027')).source, 'default');
  assert.equal(inferDateOrder(toLines('Ref 20/30/2027')).source, 'default');
});

test('a document written in BOTH orders is refused rather than averaged', () => {
  const o = inferDateOrder(toLines('Issued 25/12/2027\nDeparts 12/25/2027'));
  assert.equal(o.conflict, true);
  assert.equal(o.source, 'conflict');
  assert.equal(o.dayFirst, false);     // falls back to the default
  assert.equal(o.evidence.length, 2);  // one example of each
});

const RYANAIR = `Ryanair - Booking confirmation
Booking reference: QJ8W2N
Flight FR 1928
Dublin DUB to Rome Ciampino CIA
Departs 08/12/2027 at 06:40
Arrives 08/12/2027 at 10:15
Return leg 22/12/2027
Total: EUR 148.00`;

test('an ambiguous date is resolved by a decisive one elsewhere in the document', () => {
  const r = run(RYANAIR);
  assert.equal(r.order.source, 'document');
  assert.equal(r.order.dayFirst, true);
  const p = r.proposals[0];
  // 08/12 is 8 December here, NOT 12 August, because 22/12 on the return line
  // can only be day-first
  assert.equal(p.item.startDate, '2027-12-08');
  // and because the document settled it, the date no longer costs confidence
  assert.equal(p.confidence, 'high');
  const note = p.warnings.find(w => /could be read either way/i.test(w));
  assert.ok(note, 'no resolution note');
  assert.match(note, /22\/12\/2027/);   // names the line that settled it
  assert.match(note, /2027-12-08/);
});

test('the same document with no decisive date falls back and stays flagged', () => {
  const p = run(RYANAIR.replace('Return leg 22/12/2027', 'Return leg to be confirmed')).proposals[0];
  assert.equal(p.item.startDate, '2027-08-12');   // month-first default
  assert.equal(p.confidence, 'medium');
  assert.ok(p.warnings.some(w => /no way to tell the order/i.test(w)));
});

test('a self-contradicting document warns loudly and trusts nothing', () => {
  const p = run(RYANAIR.replace('Return leg 22/12/2027', 'Issued 12/25/2027\nReturn leg 22/12/2027')).proposals[0];
  assert.equal(p.confidence, 'medium');
  const w = p.warnings.find(x => /BOTH orders/i.test(x));
  assert.ok(w, 'no conflict warning');
});

// ---------- which date is the departure ----------

const LH = `Lufthansa e-Ticket
Issued 03 June 2027
Booked on 03 June 2027
Booking reference: LH8842K
Flight LH 401
Frankfurt FRA to New York JFK
Departs 14 September 2027 at 13:20
Arrives 14 September 2027 at 16:05
Total: EUR 638.00`;

test('an issue date above the itinerary is not mistaken for the departure', () => {
  // The regression this anchoring exists for: taking the first date on the
  // page put this flight three months early.
  const p = run(LH).proposals[0];
  assert.equal(p.item.startDate, '2027-09-14');
  assert.notEqual(p.item.startDate, '2027-06-03');
  const ev = p.evidence.find(e => e.field === 'startDate');
  assert.match(ev.raw, /^Departs/);
});

test('dates on issue/booking/invoice lines are struck out and reported', () => {
  const p = run(LH).proposals[0];
  const w = p.warnings.find(x => /Ignored 2 dates/i.test(x));
  assert.ok(w, 'skipped dates not reported');
  assert.match(w, /Issued 03 June 2027/);
});

test('a labelled departure wins wherever it sits on the page', () => {
  // the departure line is BELOW a later-dated line that is not labelled
  const p = run(`Booking reference: AB12CD
Frankfurt FRA to New York JFK
Some note 20 December 2027
Departs 14 September 2027 at 13:20`).proposals[0];
  assert.equal(p.item.startDate, '2027-09-14');
});

test('with no labelled departure the date nearest the route is used, and said so', () => {
  const p = run(`Header 01 March 2027
Dublin DUB to Rome Ciampino CIA
15 April 2027 06:40
Booking reference: QJ8W2N`).proposals[0];
  assert.equal(p.item.startDate, '2027-04-15');
  assert.ok(p.warnings.some(w => /No line is labelled as the departure/i.test(w)));
});

test('a date printed on the route line itself is used', () => {
  const p = run(`Booking reference: QJ8W2N
Dublin DUB to Rome Ciampino CIA on 15 April 2027
Departs 06:40`).proposals[0];
  assert.equal(p.item.startDate, '2027-04-15');
});

// ---------- which date is the arrival ----------

test('an explicit arrival date beats the +1 inference', () => {
  const p = run(`Booking reference: AB12CD
London LHR to Singapore SIN
Departs 12 August 2027 at 21:30
Arrives 14 August 2027 at 06:45`).proposals[0];
  // the clock alone would have inferred +1 (06:45 < 21:30); the printed date
  // says +2, and the document wins
  assert.equal(p.item.endDate, '2027-08-14');
  assert.ok(p.warnings.some(w => /read from "Arrives/i.test(w)));
  assert.ok(p.evidence.some(e => e.field === 'endDate'));
});

test('the +1 inference still applies when no arrival date is printed', () => {
  const p = run(`Booking reference: AB12CD
London LHR to New York JFK
Departs 12 August 2027 at 21:30
Arrives 06:45`).proposals[0];
  assert.equal(p.item.endDate, '2027-08-13');
  assert.ok(p.warnings.some(w => /no arrival date was printed/i.test(w)));
});

test('an arrival date before the departure is refused and costs confidence', () => {
  const p = run(`Booking reference: AB12CD
London LHR to New York JFK
Departs 12 August 2027 at 21:30
Arrives 02 August 2027 at 06:45`).proposals[0];
  // The printed arrival date is not stored. The CLOCK is separate evidence
  // and still says the leg wraps past midnight, so +1 is kept rather than
  // throwing away a real overnight; the contradiction costs a confidence step.
  assert.equal(p.item.endDate, '2027-08-13');
  assert.notEqual(p.item.endDate, '2027-08-02');
  assert.equal(p.confidence, 'medium');
  assert.ok(p.warnings.some(w => /BEFORE the departure date/i.test(w)));
});

test('an implausible flight length is called out', () => {
  const p = run(`Booking reference: AB12CD
Chicago ORD to London LHR
Departs 08/12/2027 at 18:05
Arrives 09/12/2027 at 08:10`).proposals[0];
  // no decisive date, so month-first gives a 31-day "flight"
  assert.equal(p.item.startDate, '2027-08-12');
  assert.equal(p.item.endDate, '2027-09-12');
  const w = p.warnings.find(x => /not a plausible flight/i.test(x));
  assert.ok(w, 'implausible gap not flagged');
  assert.match(w, /31 days/);
});
