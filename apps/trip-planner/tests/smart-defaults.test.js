'use strict';

// The 2026-08-18 automation round: everything a blank Add-item form can answer
// for itself, and the venue picker that completes an activity title.
//
// These are the lowest useful layer for this feature. The inference is pure
// (items in, defaults out) and the ranking is pure (a Photon payload in, rows
// out), so both are pinned here rather than through a browser. What the browser
// suite owns instead: that a field the traveller TYPED is never overwritten,
// which is a DOM fact about the form, not about these functions.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/trip-logic.js');

const {
  newItemCity, newItemDate, newItemType, newItemDefaults, stayDatesFrom,
  transportPrefillForGap, stayPrefillForGap, flightOriginCode, stayCheckoutFor,
  rankVenueResults, normalizeVenueRow, venueKindLabel,
  VENUE_CLASSES, VENUE_EXCLUDE_KEYS, PLACE_DEFAULT_TYPES,
} = T;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
let n = 0;
const item = (over = {}) => Object.assign({
  id: `i${++n}`, type: 'activity', title: 'Something', location: '',
  startDate: '2027-06-10', endDate: '', startTime: '', endTime: '',
  status: 'to-book', cost: null, details: '',
}, over);
const tripOf = (items) => ({ id: 't1', name: 'Trip', currency: 'USD', items });

// "Boston (BOS) to Keflavik (KEF)" - the shape this app writes and parses.
const flight = (over = {}) => item(Object.assign({
  type: 'flight', title: 'Boston (BOS) to Keflavik (KEF)',
  startDate: '2027-06-10', startTime: '21:30', endDate: '2027-06-11', endTime: '06:45',
  status: 'booked',
}, over));
const stay = (over = {}) => item(Object.assign({
  type: 'stay', title: 'Hotel Borg', location: 'Reykjavik',
  startDate: '2027-06-11', endDate: '2027-06-14', status: 'booked',
}, over));

// One Photon GeoJSON feature.
const feat = (name, key, value, city, lat = 35.6, lon = 139.7, over = {}) => ({
  properties: Object.assign({
    name, osm_key: key, osm_value: value, city, country: 'Japan', countrycode: 'JP',
  }, over),
  geometry: { coordinates: [lon, lat] },
});

// ---------------------------------------------------------------------------
// newItemCity: which city a new item on a given day belongs to
// ---------------------------------------------------------------------------
test('newItemCity: the stay covering the night wins over everything', () => {
  const items = [flight(), stay(), item({ location: 'Vik', startDate: '2027-06-12' })];
  assert.deepEqual(newItemCity(items, '2027-06-12'), { city: 'Reykjavik', source: 'stay' });
});

test('newItemCity: the morning of check-out still answers the stay you woke in', () => {
  assert.deepEqual(newItemCity([stay()], '2027-06-14'), { city: 'Reykjavik', source: 'stay' });
});

test('newItemCity: with no bed logged yet, the day a leg LANDS names its city', () => {
  // The headline case: log the flight, then add the hotel, and the city is
  // already there. The title's own words are the answer.
  assert.deepEqual(newItemCity([flight()], '2027-06-11'), { city: 'Keflavik', source: 'arrival' });
});

test('newItemCity: a same-day leg with no arrival date still lands that day', () => {
  const f = flight({ title: 'Dublin (DUB) to Lisbon (LIS)', startDate: '2027-06-10', endDate: '', startTime: '09:50', endTime: '13:00' });
  assert.deepEqual(newItemCity([f], '2027-06-10'), { city: 'Lisbon', source: 'arrival' });
});

test('newItemCity: a bare IATA code is never offered as a city name', () => {
  // stripPlaceCode only removes a PARENTHESISED code, so an imported or
  // hand-typed "SHV to HND" leaves "HND" in the city slot. A code is not a
  // place, with or without a table loaded to translate it.
  const f = flight({ title: 'SHV to HND', startDate: '2027-06-10', endDate: '', startTime: '09:00', endTime: '13:00' });
  assert.deepEqual(newItemCity([f], '2027-06-10'), { city: '', source: '' });
});

test('newItemCity: an injected airports table resolves a bare code instead', () => {
  const f = flight({ title: 'SHV to HND', startDate: '2027-06-10', endDate: '', startTime: '09:00', endTime: '13:00' });
  const resolveIata = (code) => (code === 'HND' ? 'Tokyo' : '');
  assert.deepEqual(newItemCity([f], '2027-06-10', { resolveIata }), { city: 'Tokyo', source: 'arrival' });
});

test('newItemCity: the last located item carries the city into an empty day', () => {
  const items = [item({ location: 'Rome', startDate: '2027-06-10' })];
  assert.deepEqual(newItemCity(items, '2027-06-13'), { city: 'Rome', source: 'carried' });
});

test('newItemCity: a LATER city is never carried backwards', () => {
  const items = [item({ location: 'Rome', startDate: '2027-06-20' })];
  assert.deepEqual(newItemCity(items, '2027-06-10'), { city: '', source: '' });
});

test('newItemCity: a cancelled item is not evidence of where anybody is', () => {
  const items = [item({ location: 'Rome', startDate: '2027-06-10', status: 'cancelled' })];
  assert.deepEqual(newItemCity(items, '2027-06-11'), { city: '', source: '' });
});

test('newItemCity: the departure day is where the first leg LEAVES from', () => {
  // The day you fly out: no bed, nothing has landed, nothing is located. The
  // day CARD has always labelled it from the leg's origin half, so the form has
  // to agree or two surfaces describe the same day differently.
  const out = [flight()];   // Boston (BOS) to Keflavik (KEF), overnight
  assert.deepEqual(newItemCity(out, '2027-06-10'), { city: 'Boston', source: 'departure' });
  assert.deepEqual(newItemCity(out, '2027-06-11'), { city: 'Keflavik', source: 'arrival' });
});

test('newItemCity: the departure rung never reads a leg it cannot parse', () => {
  // "Return to hotel" is a `local` leg whose origin half parses to the word
  // "Return", and a bare code is not a place name.
  const local = [item({ type: 'local', title: 'Return to hotel', startDate: '2027-06-10', startTime: '19:00' })];
  assert.deepEqual(newItemCity(local, '2027-06-10'), { city: '', source: '' });
  const code = [item({ type: 'flight', title: 'SHV to HND', startDate: '2027-06-10', startTime: '09:00' })];
  assert.deepEqual(newItemCity(code, '2027-06-10'), { city: '', source: '' });
  // and a title with no "to" at all claims nothing
  const odd = [item({ type: 'flight', title: 'Ferry ride', startDate: '2027-06-10', startTime: '09:00' })];
  assert.deepEqual(newItemCity(odd, '2027-06-10'), { city: '', source: '' });
});

test('newItemCity: says nothing rather than guessing, on an empty trip', () => {
  assert.deepEqual(newItemCity([], '2027-06-10'), { city: '', source: '' });
  assert.deepEqual(newItemCity([stay()], 'not-a-date'), { city: '', source: '' });
});

// ---------------------------------------------------------------------------
// newItemDate / newItemType
// ---------------------------------------------------------------------------
test('newItemDate: a day card names its own day and always wins', () => {
  const trip = tripOf([flight(), stay()]);
  assert.equal(newItemDate(trip, { today: '2027-06-12', focusDate: '2027-06-13' }), '2027-06-13');
});

test('newItemDate: today, while the trip is running', () => {
  const trip = tripOf([flight(), stay()]);
  assert.equal(newItemDate(trip, { today: '2027-06-12' }), '2027-06-12');
});

test('newItemDate: the first day, while the trip is still ahead or already over', () => {
  const trip = tripOf([flight(), stay()]);
  assert.equal(newItemDate(trip, { today: '2027-01-01' }), '2027-06-10');
  assert.equal(newItemDate(trip, { today: '2028-01-01' }), '2027-06-10');
});

test('newItemDate: a trip with no dated item derives NOTHING', () => {
  // Adversarial review, 2026-08-18. Today is a guess about intent, not a
  // reading of the itinerary, and a first item silently dated today defines the
  // trip's whole span - which is then wrong on the strip, the day cards, the
  // coverage warnings and the totals. Blank is the honest answer.
  assert.equal(newItemDate(tripOf([]), { today: '2027-03-04' }), '');
  assert.equal(newItemDate(tripOf([item({ startDate: '' })]), { today: '2027-03-04' }), '');
  // a day card still names its own day, whatever the trip holds
  assert.equal(newItemDate(tripOf([]), { today: '2027-03-04', focusDate: '2027-05-01' }), '2027-05-01');
});

test('newItemDefaults: an empty trip fills nothing but the type', () => {
  assert.deepEqual(newItemDefaults(tripOf([]), { today: '2027-03-04' }), {
    type: 'flight', startDate: '', location: '', locationSource: '',
  });
});

test('newItemType: the defaults match what real itineraries are made of', () => {
  // The rule is a measured one, not a hunch, and the sample library is the
  // repo's own corpus of realistic trips. If its shape ever changes enough to
  // invalidate this, the default should be revisited rather than left standing.
  const counts = {};
  let firstIsFlight = 0, templates = 0;
  for (const opt of T.sampleTripOptions()) {
    const items = T.sortedItems(T.buildSampleTrip(opt.id, {}));
    templates++;
    if (items[0] && items[0].type === 'flight') firstIsFlight++;
    for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  // measured 2026-08-18: 382 of 529 items (72%) are activities, and all 13
  // templates open with a flight
  assert.equal(top[0], 'activity', `most common type is ${top[0]}`);
  assert.ok(top[1] / total > 0.5, `activities are ${top[1]}/${total}`);
  assert.equal(firstIsFlight, templates, `${firstIsFlight}/${templates} templates open on a flight`);
});

test('newItemType: flight on an empty trip, activity once it holds anything', () => {
  assert.equal(newItemType(tripOf([])), 'flight');
  assert.equal(newItemType(tripOf([flight()])), 'activity');
  // a trip whose only item is cancelled is still an empty plan
  assert.equal(newItemType(tripOf([flight({ status: 'cancelled' })])), 'flight');
});

// ---------------------------------------------------------------------------
// newItemDefaults: the whole blank form
// ---------------------------------------------------------------------------
test('newItemDefaults: type, date and city together, from the trip alone', () => {
  const trip = tripOf([flight(), stay()]);
  assert.deepEqual(newItemDefaults(trip, { today: '2027-06-12' }), {
    type: 'activity', startDate: '2027-06-12', location: 'Reykjavik', locationSource: 'stay',
  });
});

test('newItemDefaults: an explicit type is honoured over the derived one', () => {
  const trip = tripOf([flight(), stay()]);
  assert.equal(newItemDefaults(trip, { today: '2027-06-12', type: 'note' }).type, 'note');
});

test('newItemDefaults: a flight and a between-cities transport never take a city', () => {
  // Their route lives in the TITLE (parseTravelOrigin / parseTravelArrival read
  // it), and giving a flight a city would make dayMorningCity read a departure
  // day as its destination.
  const trip = tripOf([flight(), stay()]);
  for (const type of ['flight', 'transport']) {
    assert.equal(newItemDefaults(trip, { today: '2027-06-12', type }).location, '', type);
  }
  for (const type of ['stay', 'activity', 'local']) {
    assert.equal(newItemDefaults(trip, { today: '2027-06-12', type }).location, 'Reykjavik', type);
  }
  assert.deepEqual(Object.keys(PLACE_DEFAULT_TYPES).sort(), ['activity', 'local', 'stay']);
});

// ---------------------------------------------------------------------------
// stayDatesFrom: choosing Stay should not mean opening a calendar twice
// ---------------------------------------------------------------------------
test('stayDatesFrom: the first uncovered night after the day in hand', () => {
  // Reykjavik covers the 11th-14th; the trip runs to the 16th via a flight home.
  const trip = tripOf([
    flight(), stay(),
    flight({ title: 'Akureyri (AEY) to Boston (BOS)', startDate: '2027-06-16', endDate: '', endTime: '' }),
  ]);
  assert.deepEqual(stayDatesFrom(trip, '2027-06-11'), { startDate: '2027-06-14', endDate: '2027-06-16' });
});

test('stayDatesFrom: a hole already open starts on the day the traveller is on', () => {
  const trip = tripOf([
    stay({ startDate: '2027-06-11', endDate: '2027-06-12' }),
    stay({ id: 'z', title: 'Second', location: 'Vik', startDate: '2027-06-16', endDate: '2027-06-18' }),
  ]);
  // the hole is the 12th-16th; pressing + on the 14th means the 14th
  assert.deepEqual(stayDatesFrom(trip, '2027-06-14'), { startDate: '2027-06-14', endDate: '2027-06-16' });
});

test('stayDatesFrom: a fully covered trip falls back to one night', () => {
  const trip = tripOf([stay()]);
  assert.deepEqual(stayDatesFrom(trip, '2027-07-01'), { startDate: '2027-07-01', endDate: '2027-07-02' });
});

test('stayDatesFrom: with no stays yet, a red-eye books the night you LAND', () => {
  // Log the flight, then book the hotel: the commonest two-item sequence there
  // is. The overnight leg is that night's bed (tripStats counts it as one), so
  // opening the stay on the departure date would be a day early.
  const overnight = tripOf([flight()]);   // 06-10 21:30 -> 06-11 06:45
  assert.deepEqual(stayDatesFrom(overnight, '2027-06-10'), { startDate: '2027-06-11', endDate: '2027-06-12' });
  // a same-day flight needs a bed the night it lands, which is the day it left
  const sameDay = tripOf([flight({ startDate: '2027-06-10', endDate: '', startTime: '09:50', endTime: '13:00' })]);
  assert.deepEqual(stayDatesFrom(sameDay, '2027-06-10'), { startDate: '2027-06-10', endDate: '2027-06-11' });
  // and a cancelled red-eye is not anybody's bed
  const cancelled = tripOf([flight({ status: 'cancelled' })]);
  assert.deepEqual(stayDatesFrom(cancelled, '2027-06-10'), { startDate: '2027-06-10', endDate: '2027-06-11' });
});

test('stayDatesFrom: two stacked red-eyes are both skipped, not just the first', () => {
  // A long-haul routed through an overnight layover: out Monday night, land
  // Tuesday, onward Tuesday night, land Wednesday. Skipping only the first leg
  // booked a hotel for a night still spent in the air.
  const trip = tripOf([
    flight({ title: 'A (AAA) to B (BBB)', startDate: '2027-06-10', endDate: '2027-06-11', startTime: '22:00', endTime: '06:00' }),
    flight({ id: 'f2', title: 'B (BBB) to C (CCC)', startDate: '2027-06-11', endDate: '2027-06-12', startTime: '23:00', endTime: '07:00' }),
  ]);
  assert.deepEqual(stayDatesFrom(trip, '2027-06-10'), { startDate: '2027-06-12', endDate: '2027-06-13' });
});

test('stayDatesFrom: a trip with no stays at all still opens on a legal range', () => {
  assert.deepEqual(stayDatesFrom(tripOf([]), '2027-07-01'), { startDate: '2027-07-01', endDate: '2027-07-02' });
  assert.equal(stayDatesFrom(tripOf([]), 'nope'), null);
});

test('stayDatesFrom: every answer is a range a stay can legally be saved with', () => {
  // validateItem refuses a check-out on or before check-in, so a default that
  // could produce one would open a form that cannot be saved.
  const trips = [tripOf([]), tripOf([stay()]), tripOf([flight(), stay()])];
  for (const trip of trips) {
    for (const from of ['2027-06-10', '2027-06-12', '2027-06-14', '2027-08-01']) {
      const d = stayDatesFrom(trip, from);
      const errs = T.validateItem({ type: 'stay', title: 'x', startDate: d.startDate, endDate: d.endDate });
      assert.deepEqual(errs, {}, `${from} -> ${JSON.stringify(d)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// stayCheckoutFor: a check-in already on screen is the anchor
// ---------------------------------------------------------------------------
test('stayCheckoutFor: a typed check-in never inherits another hole length', () => {
  // The bug this exists for (adversarial review, 2026-08-18): a trip covered
  // the 5th-8th and the 10th-12th, opened on the 6th because the trip is
  // running. stayDatesFrom answers "the next hole starts on the 8th and ends on
  // the 10th", and applying its END to a check-in of the 6th wrote a four-night
  // stay straddling BOTH existing bookings.
  const trip = tripOf([
    stay({ title: 'H1', location: 'Paris', startDate: '2027-06-05', endDate: '2027-06-08' }),
    stay({ id: 'z', title: 'H2', location: 'Lyon', startDate: '2027-06-10', endDate: '2027-06-12' }),
  ]);
  assert.equal(stayCheckoutFor(trip, '2027-06-06'), '2027-06-07');
  // a check-in INSIDE the hole gets the hole's own length
  assert.equal(stayCheckoutFor(trip, '2027-06-08'), '2027-06-10');
  // and one past everything is a single night
  assert.equal(stayCheckoutFor(trip, '2027-08-01'), '2027-08-02');
  assert.equal(stayCheckoutFor(trip, 'nope'), '');
});

test('stayCheckoutFor: the answer is always a range validateItem accepts', () => {
  const trips = [tripOf([]), tripOf([stay()]), tripOf([flight(), stay()])];
  for (const trip of trips) {
    for (const d of ['2027-06-09', '2027-06-11', '2027-06-14', '2027-09-01']) {
      const end = stayCheckoutFor(trip, d);
      assert.deepEqual(T.validateItem({ type: 'stay', title: 'x', startDate: d, endDate: end }), {}, `${d} -> ${end}`);
    }
  }
});

// ---------------------------------------------------------------------------
// the two prefilled warning fixes
// ---------------------------------------------------------------------------
test('transportPrefillForGap: the leg the warning already describes', () => {
  const gap = { fromLocation: 'Paris', toLocation: 'Brussels', gapStart: '2027-06-14', gapEnd: '2027-06-14' };
  assert.deepEqual(transportPrefillForGap(gap), {
    type: 'transport', title: 'Paris to Brussels', startDate: '2027-06-14',
  });
});

test('transportPrefillForGap: the title is the shape the app itself parses back', () => {
  const pre = transportPrefillForGap({ fromLocation: 'Kyoto', toLocation: 'Osaka', gapStart: '2027-06-14' });
  assert.equal(T.parseTravelOrigin(pre.title), 'Kyoto');
  assert.equal(T.parseTravelArrival(pre.title).city, 'Osaka');
});

test('transportPrefillForGap: nothing to offer without both ends and a day', () => {
  assert.equal(transportPrefillForGap(null), null);
  assert.equal(transportPrefillForGap({ fromLocation: 'Paris', gapStart: '2027-06-14' }), null);
  assert.equal(transportPrefillForGap({ fromLocation: 'Paris', toLocation: 'Brussels' }), null);
});

test('stayPrefillForGap: the old one-argument shape is unchanged', () => {
  const gap = { start: '2027-06-14', end: '2027-06-16', nights: 2 };
  assert.deepEqual(stayPrefillForGap(gap), {
    type: 'stay', startDate: '2027-06-14', endDate: '2027-06-16', nights: 2,
  });
});

test('stayPrefillForGap: given the trip, it also carries the city', () => {
  const items = [flight(), stay()];   // Reykjavik, 11th-14th
  const gap = { start: '2027-06-14', end: '2027-06-16', nights: 2 };
  assert.equal(stayPrefillForGap(gap, items).location, 'Reykjavik');
});

test('stayPrefillForGap: no city to name adds no key at all', () => {
  const gap = { start: '2027-06-14', end: '2027-06-16', nights: 2 };
  assert.equal('location' in stayPrefillForGap(gap, []), false);
});

// ---------------------------------------------------------------------------
// flightOriginCode
// ---------------------------------------------------------------------------
test('flightOriginCode: a new flight leaves from wherever the last one landed', () => {
  assert.equal(flightOriginCode([flight(), stay()], '2027-06-16'), 'KEF');
});

test('flightOriginCode: only flights already flown by that date count', () => {
  const later = flight({ title: 'Tokyo (HND) to Osaka (ITM)', startDate: '2027-06-20' });
  assert.equal(flightOriginCode([flight(), later], '2027-06-16'), 'KEF');
  assert.equal(flightOriginCode([flight(), later], '2027-06-25'), 'ITM');
});

test('flightOriginCode: never guesses from a title this app did not write', () => {
  assert.equal(flightOriginCode([flight({ title: 'Ferry to Naxos' })], '2027-06-16'), '');
  assert.equal(flightOriginCode([flight({ status: 'cancelled' })], '2027-06-16'), '');
  assert.equal(flightOriginCode([], '2027-06-16'), '');
  // a transport leg is not a flight and names no airport
  assert.equal(flightOriginCode([item({ type: 'transport', title: 'Kyoto to Osaka' })], '2027-06-16'), '');
});

// ---------------------------------------------------------------------------
// the whole example library as a corpus
// ---------------------------------------------------------------------------
test('every day of every example trip derives a city, and it agrees with the bed', () => {
  // The library is the repo's own corpus of realistic itineraries, including a
  // 30-day road trip with 18 stays. If the city rung ever disagreed with the
  // stay covering the night, the day cards and this form would be telling the
  // traveller two different things about where they are.
  for (const opt of T.sampleTripOptions()) {
    const trip = T.buildSampleTrip(opt.id, {});
    const stats = T.tripStats(trip);
    for (let d = stats.start; d <= stats.renderEnd; d = T.addDays(d, 1)) {
      const host = T.dayHostStay(trip.items, d);
      const derived = newItemCity(trip.items, d);
      assert.ok(derived.city, `${opt.id} ${d} derived no city at all`);
      if (host) assert.equal(derived.city, String(host.location).trim(), `${opt.id} ${d}`);
    }
  }
});

test('every stay default on every example day is a range that can be saved', () => {
  for (const opt of T.sampleTripOptions()) {
    const trip = T.buildSampleTrip(opt.id, {});
    const stats = T.tripStats(trip);
    for (let d = stats.start; d <= stats.renderEnd; d = T.addDays(d, 1)) {
      const r = stayDatesFrom(trip, d);
      assert.deepEqual(T.validateItem({ type: 'stay', title: 'x', startDate: r.startDate, endDate: r.endDate }), {},
        `${opt.id} stayDatesFrom(${d}) -> ${JSON.stringify(r)}`);
      const end = stayCheckoutFor(trip, d);
      assert.deepEqual(T.validateItem({ type: 'stay', title: 'x', startDate: d, endDate: end }), {},
        `${opt.id} stayCheckoutFor(${d}) -> ${end}`);
    }
  }
});

// ---------------------------------------------------------------------------
// the join with booking import
// ---------------------------------------------------------------------------
test('an imported flight confirmation feeds the city to the next item added', () => {
  // Nothing was written to make this work: readFlight titles a parsed leg
  // "City (CODE) to City (CODE)" through airportLabel, which is the same shape
  // newItemCity's arrival rung reads. Pinned because it is the join between two
  // features that were built years apart and neither one knows about.
  const table = T.airportIndex({
    fields: ['iata', 'name', 'city', 'cc', 'lat', 'lon', 'big', 'alt'],
    countries: { JP: 'Japan', US: 'United States' },
    rows: [
      ['HND', 'Tokyo Haneda International Airport', 'Tokyo', 'JP', 35.5523, 139.7798, 1, ''],
      ['SHV', 'Shreveport Regional Airport', 'Shreveport', 'US', 32.4466, -93.8256, 0, ''],
    ],
  });
  const doc = [
    'Flight confirmation',
    'Booking reference: XJ7K2Q',
    'Depart: SHV Shreveport 08/12/2027 08:00',
    'Arrive: HND Tokyo 08/13/2027 14:25',
  ].join('\n');
  const found = T.extractBookings(doc, { airports: table });
  const flights = found.proposals.filter(p => p.item && p.item.type === 'flight');
  assert.ok(flights.length, `no flight parsed from the fixture: ${JSON.stringify(found.proposals)}`);
  const parsed = flights[0].item;
  // the importer's own title is what carries the city
  assert.match(parsed.title, /\(HND\)/);
  const arriveDate = parsed.endDate || parsed.startDate;
  assert.deepEqual(newItemCity([parsed], arriveDate), { city: 'Tokyo', source: 'arrival' });
});

// ---------------------------------------------------------------------------
// routeSuggestion: what the A-to-B dialog opens on from the toolbar
// ---------------------------------------------------------------------------
test('routeSuggestion: the city change with no leg logged for it comes first', () => {
  const trip = tripOf([
    stay({ title: 'Hotel Paris', location: 'Paris', startDate: '2027-06-01', endDate: '2027-06-04' }),
    stay({ title: 'Hotel Brussels', location: 'Brussels', startDate: '2027-06-04', endDate: '2027-06-06' }),
  ]);
  assert.deepEqual(T.routeSuggestion(trip), { from: 'Paris', to: 'Brussels', date: '2027-06-04' });
});

test('routeSuggestion: with every leg logged it still offers the first city change', () => {
  const trip = tripOf([
    stay({ title: 'Hotel Paris', location: 'Paris', startDate: '2027-06-01', endDate: '2027-06-04' }),
    item({ type: 'transport', title: 'Paris to Brussels', startDate: '2027-06-04', status: 'booked' }),
    stay({ title: 'Hotel Brussels', location: 'Brussels', startDate: '2027-06-04', endDate: '2027-06-06' }),
  ]);
  assert.deepEqual(T.routeSuggestion(trip), { from: 'Paris', to: 'Brussels', date: '2027-06-04' });
});

test('routeSuggestion: a trip naming one city or none suggests nothing', () => {
  assert.equal(T.routeSuggestion(tripOf([stay()])), null);
  assert.equal(T.routeSuggestion(tripOf([])), null);
  // two stays in the SAME city is not a journey
  assert.equal(T.routeSuggestion(tripOf([
    stay({ startDate: '2027-06-01', endDate: '2027-06-03' }),
    stay({ id: 'z', startDate: '2027-06-03', endDate: '2027-06-05' }),
  ])), null);
});

// ---------------------------------------------------------------------------
// the venue picker: ranking
// ---------------------------------------------------------------------------
test('rankVenueResults: the named place the traveller meant comes first', () => {
  // Photon's live answer for "teamLab" biased to Tokyo, in its own order.
  const payload = { features: [
    feat('teamLab Planets', 'tourism', 'museum', 'Tokyo', 35.649, 139.789),
    feat('teamLab Borderless', 'tourism', 'museum', 'Tokyo', 35.625, 139.775),
    feat('teamLab BioVortex', 'tourism', 'attraction', 'Kyoto', 35.0, 135.7),
  ] };
  const rows = rankVenueResults('teamLab', payload, 'Tokyo', 8);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].value, 'teamLab Planets');
  assert.equal(rows[0].kindLabel, 'Museum');
  assert.equal(rows[0].locality, 'Tokyo');
});

test('rankVenueResults: the city in the Place field outranks Photon own order', () => {
  // Same class on both, so only the city can be what moves it: the Kyoto row
  // sits four places down and still wins once "Kyoto" is in the Place field.
  const payload = { features: [
    feat('Kiyomizu Ramen', 'amenity', 'restaurant', 'Osaka', 34.7, 135.5),
    feat('Kiyomizu Bar', 'amenity', 'restaurant', 'Kobe', 34.69, 135.19),
    feat('Kiyomizu Cafe', 'amenity', 'restaurant', 'Nara', 34.68, 135.80),
    feat('Kiyomizu Grill', 'amenity', 'restaurant', 'Osaka', 34.71, 135.51),
    feat('Kiyomizu Sushi', 'amenity', 'restaurant', 'Kyoto', 35.0, 135.77),
  ] };
  assert.equal(rankVenueResults('kiyomizu', payload, 'Kyoto', 8)[0].value, 'Kiyomizu Sushi');
  // with no city to go on, rows of one class keep the order Photon gave them
  assert.deepEqual(rankVenueResults('kiyomizu', payload, '', 8).map(r => r.value),
    ['Kiyomizu Ramen', 'Kiyomizu Bar', 'Kiyomizu Cafe', 'Kiyomizu Grill', 'Kiyomizu Sushi']);
});

test('rankVenueResults: a landmark beats the shop that shares its name', () => {
  // The live case this rule exists for: Barcelona holds a basilica, an ice
  // cream shop, a supermarket and six railway stops all called "Sagrada
  // Família", and Photon returns the shop above the basilica. Two things fix
  // it - the dedup key keeps them apart as different classes, and the basilica
  // is a mapped AREA (Photon returns an `extent` for it) while the shop is a
  // bare point.
  const area = (name, k, v, city, over) => feat(name, k, v, city, 41.4, 2.17, { extent: [2.17, 41.41, 2.18, 41.40], ...(over || {}) });
  const payload = { features: [
    feat('Sagrada Familia', 'amenity', 'ice_cream', 'Barcelona', 41.4, 2.17),
    feat('Sagrada Familia', 'shop', 'bakery', 'Barcelona', 41.4, 2.17),
    area('Sagrada Familia', 'amenity', 'place_of_worship', 'Barcelona'),
  ] };
  const rows = rankVenueResults('Sagrada Familia', payload, 'Barcelona', 8);
  assert.equal(rows[0].value, 'Sagrada Familia');
  assert.equal(rows[0].kindLabel, 'Place of worship');
  // and all three are still offered: same name, same town, different places
  assert.equal(rows.length, 3);
});

test('rankVenueResults: the same feature twice is still one row', () => {
  // The node-and-way duplicate the dedup exists for: same name, same town,
  // same class. Only the class was added to the key, so this must not regress.
  const payload = { features: [
    feat('Louvre Museum', 'tourism', 'museum', 'Paris', 48.861, 2.336),
    feat('Louvre Museum', 'tourism', 'museum', 'Paris', 48.8611, 2.3362),
  ] };
  assert.equal(rankVenueResults('louvre', payload, 'Paris', 8).length, 1);
});

test('rankVenueResults: a station named on its track node is still offered', () => {
  // "Amsterdam Centraal" answered an EMPTY dropdown: all fifteen rows Photon
  // returned were `railway:stop` (the node ON the track), which the class list
  // did not name. Fifteen identical stops collapse to one row.
  const stop = (name) => feat(name, 'railway', 'stop', 'Amsterdam', 52.379, 4.900);
  const payload = { features: [stop('Amsterdam Centraal'), stop('Amsterdam Centraal'), stop('Amsterdam Centraal')] };
  const rows = rankVenueResults('Amsterdam Centraal', payload, 'Amsterdam', 8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kindLabel, 'Station');
});

test('rankVenueResults: three station tags render as one row, not three', () => {
  // `station`, `halt` and `stop` all read "Station", so keying the dedup on the
  // raw TAG put rows a traveller cannot tell apart next to each other
  // ("Tsukiji  Station" twice). The key is the label for that reason.
  const payload = { features: [
    feat('Tsukiji', 'railway', 'stop', 'Tokyo', 35.666, 139.770),
    feat('Tsukiji', 'railway', 'station', 'Tokyo', 35.666, 139.771),
    feat('Tsukiji', 'railway', 'halt', 'Tokyo', 35.667, 139.770),
    feat('Tsukiji', 'amenity', 'restaurant', 'Tokyo', 35.665, 139.772),
  ] };
  const rows = rankVenueResults('Tsukiji', payload, 'Tokyo', 8);
  assert.deepEqual(rows.map(r => r.kindLabel).sort(), ['Restaurant', 'Station']);
});

test('rankVenueResults: a named lake is a destination', () => {
  // Lake Bled, Lake Como and Loch Ness are all `water:lake` and all came back
  // at position 0 from the live service; the class list dropped every one.
  const payload = { features: [feat('Lake Bled', 'water', 'lake', 'Bled', 46.364, 14.094)] };
  const rows = rankVenueResults('Lake Bled', payload, 'Bled', 8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kindLabel, 'Lake');
});

test('venueKindLabel: a pill never claims more than the tag says', () => {
  // A beach RESORT is not a beach and a cable car STATION is not a cable car:
  // the pill is the app's wording for someone else's tag, so it may generalise
  // but must never upgrade.
  assert.equal(venueKindLabel('leisure', 'beach_resort'), 'Beach resort');
  assert.equal(venueKindLabel('natural', 'beach'), 'Beach');
  assert.equal(venueKindLabel('aerialway', 'station'), 'Cable car station');
});

test('rankVenueResults: an exact name match outranks a longer one that contains it', () => {
  const payload = { features: [
    feat('Vondelpark Open Air Theatre', 'amenity', 'theatre', 'Amsterdam', 52.358, 4.869),
    feat('Vondelpark', 'leisure', 'park', 'Amsterdam', 52.358, 4.868),
  ] };
  assert.equal(rankVenueResults('Vondelpark', payload, 'Amsterdam', 8)[0].value, 'Vondelpark');
});

test('rankVenueResults: nothing is invented that the payload did not carry', () => {
  // Every field on a row must be traceable to the response: no locality where
  // Photon gave none, no country, no coordinates, and no pill for a class it
  // did not state.
  const bare = { properties: { name: 'Somewhere', osm_key: 'tourism', osm_value: 'attraction' }, geometry: { coordinates: [2.0, 48.0] } };
  const row = normalizeVenueRow(bare);
  assert.equal(row.value, 'Somewhere');
  assert.equal(row.locality, '');
  assert.equal(row.country, '');
  assert.equal(row.cc, '');
  assert.equal(row.detail, '');
  assert.equal(row.area, false);
  assert.equal(row.kindLabel, 'Attraction');
  // and a class the payload does not state at all is not a row
  assert.equal(normalizeVenueRow({ properties: { name: 'X' }, geometry: { coordinates: [2, 48] } }), null);
});

test('rankVenueResults: a mapped area is a bonus, never a filter', () => {
  // teamLab Planets is a plain node with no extent and is exactly the kind of
  // answer this picker exists for, so a point must never be excluded.
  const payload = { features: [feat('teamLab Planets', 'tourism', 'museum', 'Tokyo', 35.649, 139.789)] };
  const rows = rankVenueResults('teamLab', payload, 'Tokyo', 8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].area, false);
});

test('rankVenueResults: a class the list does not name is DROPPED, not shown bare', () => {
  // The live "Eiffel" answer: one tower worth having, and six bus stops.
  const payload = { features: [
    feat('Eiffel Tower', 'man_made', 'tower', 'Paris', 48.858, 2.294),
    feat('Eiffel', 'highway', 'bus_stop', 'Levallois-Perret'),
    feat('Eiffel', 'building', 'office', 'Villepinte'),
    feat('Eiffel Tower', 'information', 'screen', 'Paris'),
    feat('EiffelVet', 'amenity', 'veterinary', 'Paris'),
    feat('Eiffel café', 'amenity', 'cafe', 'Paris', 48.86, 2.29),
  ] };
  const rows = rankVenueResults('Eiffel', payload, 'Paris', 8);
  assert.deepEqual(rows.map(r => r.value), ['Eiffel Tower', 'Eiffel café']);
  assert.deepEqual(rows.map(r => r.kindLabel), ['Tower', 'Cafe']);
});

test('rankVenueResults: lodging belongs to the stay picker and never appears here', () => {
  const payload = { features: [
    feat('Central Park Inn', 'tourism', 'hostel', 'New York', 40.8, -73.9),
    feat('Central Park', 'leisure', 'park', 'New York', 40.782, -73.965),
    feat('Central Park Zoo', 'tourism', 'zoo', 'New York', 40.768, -73.972),
  ] };
  const rows = rankVenueResults('Central Park', payload, 'New York', 8);
  assert.deepEqual(rows.map(r => r.value), ['Central Park', 'Central Park Zoo']);
  for (const t of T.HOTEL_TAGS.keys()) {
    assert.equal(venueKindLabel('tourism', t), '', `tourism:${t} must not be a venue class`);
  }
});

test('rankVenueResults: a city or a village is a destination, not a stop', () => {
  // The Place field's job. Offering one here would put a whole destination in a
  // field that names one thing to do.
  const payload = { features: [
    feat('Temalac', 'place', 'village', 'Guerrero'),
    feat('Museum Square', 'place', 'square', 'Amsterdam', 52.357, 4.881),
  ] };
  assert.deepEqual(rankVenueResults('mus', payload, '', 8).map(r => r.value), ['Museum Square']);
  for (const v of ['city', 'town', 'village', 'suburb', 'neighbourhood', 'isolated_dwelling']) {
    assert.equal(venueKindLabel('place', v), '', `place:${v}`);
  }
});

test('rankVenueResults: a row with no usable coordinate never reaches the list', () => {
  // Number('') is 0, a real coordinate in the Gulf of Guinea: the same trap the
  // city and hotel normalizers guard.
  const payload = { features: [
    { properties: { name: 'Nowhere', osm_key: 'tourism', osm_value: 'museum', city: 'X' }, geometry: { coordinates: [] } },
    { properties: { name: 'Missing lat', osm_key: 'tourism', osm_value: 'museum', city: 'X' }, geometry: { coordinates: [12.5, null] } },
    feat('Real', 'tourism', 'museum', 'X', 1.5, 2.5),
  ] };
  assert.deepEqual(rankVenueResults('m', payload, '', 8).map(r => r.value), ['Real']);
});

test('rankVenueResults: nothing usable is an empty list, never a throw', () => {
  for (const p of [null, undefined, {}, { features: null }, { features: [] }, { features: [{}] },
    { features: [{ properties: { name: 'x' } }] }]) {
    assert.deepEqual(rankVenueResults('q', p, 'Paris', 8), []);
  }
});

test('rankVenueResults: honours the row cap', () => {
  const payload = { features: Array.from({ length: 15 }, (_, i) => feat(`Museum ${i}`, 'tourism', 'museum', 'Tokyo', 35 + i / 100, 139)) };
  assert.equal(rankVenueResults('museum', payload, 'Tokyo', 8).length, 8);
});

test('normalizeVenueRow: the stored value is the BARE name, the detail is the place', () => {
  const row = normalizeVenueRow(feat('teamLab Planets', 'tourism', 'museum', 'Tokyo', 35.649, 139.789));
  assert.equal(row.value, 'teamLab Planets');       // what lands in the title
  assert.equal(row.detail, 'Tokyo, Japan');          // the disambiguating line
  assert.equal(row.locality, 'Tokyo');               // what fills an empty Place
  assert.equal(row.lat, 35.649);
  assert.equal(row.lon, 139.789);
  assert.equal(row.cc, 'JP');
});

test('normalizeVenueRow: a locality that only repeats the name is not doubled', () => {
  const row = normalizeVenueRow(feat('Kyoto', 'place', 'square', 'Kyoto', 35, 135));
  assert.equal(row.detail, 'Japan');
});

test('normalizeVenueRow: district or state stands in when there is no city', () => {
  const row = normalizeVenueRow(feat('Cliff walk', 'tourism', 'attraction', undefined, 35, 135, { district: 'Higashiyama' }));
  assert.equal(row.locality, 'Higashiyama');
});

// ---------------------------------------------------------------------------
// the exclusion invariant
// ---------------------------------------------------------------------------
test('VENUE_EXCLUDE_KEYS can only ever save bandwidth, never hide a row', () => {
  // The wire carries `osm_tag=!key` for each of these. If one were also a class
  // the picker shows, the exclusion would silently remove rows a traveller could
  // otherwise have picked - and because Photon answers 200 with a shorter list,
  // nothing would ever look broken.
  for (const key of VENUE_EXCLUDE_KEYS) {
    assert.equal(VENUE_CLASSES.has(key), false, `${key} is excluded on the wire AND allowed by the class list`);
  }
});

test('VENUE_CLASSES: every class carries a human label, and no label is a bare tag', () => {
  for (const [key, values] of VENUE_CLASSES) {
    assert.ok(values instanceof Map && values.size, `${key} has no values`);
    for (const [value, label] of values) {
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 1, `${key}:${value} label`);
      assert.ok(!label.includes('_'), `${key}:${value} label is a raw tag`);
      assert.equal(label[0], label[0].toUpperCase(), `${key}:${value} label is not sentence case`);
    }
  }
});

test('VENUE_CLASSES: the categories a traveller would look for are all covered', () => {
  // The list this feature was asked for, each checked through the same lookup
  // the picker uses rather than by reading the table above.
  const wanted = [
    ['tourism', 'attraction'], ['tourism', 'museum'], ['amenity', 'restaurant'],
    ['amenity', 'cafe'], ['amenity', 'bar'], ['leisure', 'park'], ['natural', 'beach'],
    ['historic', 'castle'], ['man_made', 'tower'], ['amenity', 'theatre'],
    ['amenity', 'nightclub'], ['shop', 'mall'], ['railway', 'station'], ['amenity', 'marketplace'],
  ];
  for (const [k, v] of wanted) assert.ok(venueKindLabel(k, v), `${k}:${v} is not offered`);
});
