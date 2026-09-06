// DISCOVERY WITH AN HOUR ATTACHED: a replacement that is shut is not a
// replacement.
//
// A replacement search exists because a slot lost a candidate. The slot has an
// hour on it, so handing back the first well-rated restaurant Google ranks -
// which is exactly what the 08:00 report was full of - buys the same failure a
// second time, at $0.02 a go.
//
// The Details response this search already pays for CONTAINS the opening hours,
// so the gate costs nothing: the search walks further down the free ID page
// instead of stopping at a shut venue. The client re-runs the identical check
// on the identical normalized hours when the answer lands (one rule, applied
// where the decision is made); this is the saving, never the source of truth.
import { register } from 'node:module';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let hooksOk = true;
try {
  register('./tp-assist-blobs-hooks.mjs', import.meta.url);
} catch {
  hooksOk = false;
}
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable; the handler needs the @netlify/blobs hook' };

const { default: handler, clampDiscover } = await import('../tp-places.mjs');
const { foodTypeOf } = await import('../lib/tp-places-match.mjs');
const STORE = 'trip-planner-places';

// Google's own shape: regularOpeningHours.periods, day 0 = Sunday, hour/minute.
const weekly = (openH, openM, closeH, closeM) => ({
  periods: [0, 1, 2, 3, 4, 5, 6].map(day => ({
    open: { day, hour: openH, minute: openM },
    close: { day, hour: closeH, minute: closeM },
  })),
});

const KRABI_ADDR = {
  formattedAddress: '123 Ao Nang, Mueang Krabi District, Krabi 81000, Thailand',
  addressComponents: [{ longText: 'Ao Nang' }, { longText: 'Mueang Krabi District' }, { longText: 'Krabi' }, { longText: 'Thailand' }],
};

// Four real-shaped Ao Nang restaurants. The first two are the reported failure:
// well rated, genuinely there, and shut at breakfast.
const PLACES = {
  noodles: {
    displayName: { text: 'Only Noodles' }, rating: 4.7, userRatingCount: 1481,
    googleMapsUri: 'https://maps.google.com/?cid=21', location: { latitude: 8.0320, longitude: 98.8210 },
    regularOpeningHours: weekly(10, 30, 22, 0), ...KRABI_ADDR,
  },
  lateOne: {
    displayName: { text: 'Late Kitchen' }, rating: 4.6, userRatingCount: 900,
    googleMapsUri: 'https://maps.google.com/?cid=22', location: { latitude: 8.0325, longitude: 98.8215 },
    regularOpeningHours: weekly(12, 0, 22, 0), ...KRABI_ADDR,
  },
  earlyOne: {
    displayName: { text: 'Sunrise Cafe' }, rating: 4.4, userRatingCount: 320,
    googleMapsUri: 'https://maps.google.com/?cid=23', location: { latitude: 8.0330, longitude: 98.8220 },
    regularOpeningHours: weekly(6, 30, 12, 0), ...KRABI_ADDR,
  },
  earlyTwo: {
    displayName: { text: 'Morning Market Kitchen' }, rating: 4.2, userRatingCount: 210,
    googleMapsUri: 'https://maps.google.com/?cid=24', location: { latitude: 8.0335, longitude: 98.8225 },
    regularOpeningHours: weekly(7, 30, 15, 0), ...KRABI_ADDR,
  },
  noHours: {
    displayName: { text: 'Beach Shack' }, rating: 4.1, userRatingCount: 90,
    googleMapsUri: 'https://maps.google.com/?cid=25', location: { latitude: 8.0340, longitude: 98.8230 },
    ...KRABI_ADDR,
  },
};

let calls, realFetch, searchReturns;
beforeEach(() => {
  calls = [];
  searchReturns = ['noodles', 'lateOne', 'earlyOne', 'earlyTwo'];
  const map = new Map();
  map.set('config', { data: { placesKeyV2: 'test-key' }, etag: 'e1' });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq: 0 };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('places:searchText')) {
      const body = JSON.parse(init.body || '{}');
      calls.push({ kind: 'search', body });
      return json({ places: searchReturns.map(id => ({ id })) });
    }
    const m = /\/v1\/places\/([^?]+)/.exec(href);
    if (m) {
      calls.push({ kind: 'details', id: m[1] });
      return PLACES[m[1]] ? json(PLACES[m[1]]) : json({ error: 'NOT_FOUND' }, 404);
    }
    throw new Error('unexpected fetch ' + href);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const discover = (spec, clientId = 'c-hours') => handler(new Request(
  'https://shevato.com/.netlify/functions/tp-places',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shevato.com' },
    body: JSON.stringify({ clientId, discover: spec }),
  },
));

// Ao Nang, and 2027-01-27 is a Wednesday - a real future itinerary date.
const AO_NANG = { city: 'Ao Nang', country: 'Thailand', lat: 8.0320, lon: 98.8210 };
const BREAKFAST = { date: '2027-01-27', time: '08:00', windowMin: 45 };

test('the reported case: a breakfast search skips the venues that open at 10:30', opts, async () => {
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 2, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  const names = body.results.map(r => r.name);
  assert.deepEqual(names, ['Sunrise Cafe', 'Morning Market Kitchen'],
    'the two that are open at 08:00, in the order the page offered them');
  assert.ok(!names.includes('Only Noodles'), 'a 10:30 opening cannot answer an 08:00 slot');
  assert.ok(!names.includes('Late Kitchen'));
});

test('the shut ones still cost their Details call, and the search keeps walking the page', opts, async () => {
  // The hours only exist inside the (billed) Details response, so a shut
  // candidate is discovered by paying for it. What the gate buys is that the
  // loop CONTINUES instead of returning it: 4 details for 2 usable answers,
  // rather than 2 details for 2 useless ones.
  await discover({ q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 2, meal: 'breakfast', schedule: BREAKFAST });
  const details = calls.filter(c => c.kind === 'details').map(c => c.id);
  assert.deepEqual(details, ['noodles', 'lateOne', 'earlyOne', 'earlyTwo']);
  assert.equal(calls.filter(c => c.kind === 'search').length, 1, 'one free ID search, as always');
});

test('hours travel back with the answer, so the client can re-check them itself', opts, async () => {
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 1, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  const hours = body.results[0].hours;
  assert.ok(hours && Array.isArray(hours.periods) && hours.periods.length === 7);
  assert.equal(hours.periods[0].open.min, 6 * 60 + 30, 'normalized to minutes past midnight');
  assert.equal(hours.periods[0].close.min, 12 * 60);
});

test('a place Google has no hours for is NOT filtered out: unknown is not closed', opts, async () => {
  searchReturns = ['noHours'];
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 2, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  assert.deepEqual(body.results.map(r => r.name), ['Beach Shack']);
  assert.equal(body.results[0].hours, undefined, 'and it says so by carrying no hours at all');
});

test('an area full of places that are all shut at that hour says so in its own word', opts, async () => {
  searchReturns = ['noodles', 'lateOne'];
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 2, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  assert.deepEqual(body.results, []);
  assert.equal(body.reason, 'no_open_candidates',
    'different from no_candidates (nothing there) and from upstream (nothing checked)');
});

test('no schedule on the spec means no hours filtering at all - every other caller is unchanged', opts, async () => {
  const body = await (await discover({ q: 'restaurant Ao Nang', ...AO_NANG, limit: 2 })).json();
  assert.deepEqual(body.results.map(r => r.name), ['Only Noodles', 'Late Kitchen'],
    'without an hour to judge against, the top of the page wins as it always has');
});

test('a FUTURE weekday is what decides, not today and not "open now"', opts, async () => {
  // Open Mondays only, 07:00-11:00. 2027-02-01 is a Monday; 2027-02-02 a Tuesday.
  const mondayOnly = {
    ...PLACES.earlyOne,
    displayName: { text: 'Monday Only Kitchen' },
    regularOpeningHours: { periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 11, minute: 0 } }] },
  };
  PLACES.mondayOnly = mondayOnly;
  searchReturns = ['mondayOnly'];

  const monday = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 1, meal: 'breakfast',
    schedule: { date: '2027-02-01', time: '08:00', windowMin: 45 },
  })).json();
  assert.deepEqual(monday.results.map(r => r.name), ['Monday Only Kitchen']);

  const tuesday = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 1, meal: 'breakfast',
    schedule: { date: '2027-02-02', time: '08:00', windowMin: 45 },
  })).json();
  assert.deepEqual(tuesday.results, []);
  assert.equal(tuesday.reason, 'no_open_candidates');
  // The request never carries an openNow flag: the trip is not now.
  const search = calls.find(c => c.kind === 'search');
  assert.equal(search.body.openNow, undefined);
  assert.equal(JSON.stringify(search.body).includes('openNow'), false);
});

test('the planned duration counts: a venue closing 15 minutes in is skipped', opts, async () => {
  PLACES.closingSoon = {
    ...PLACES.earlyOne,
    displayName: { text: 'Closing Soon Kitchen' },
    regularOpeningHours: weekly(6, 0, 8, 15),
  };
  searchReturns = ['closingSoon', 'earlyOne'];
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 1, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  assert.deepEqual(body.results.map(r => r.name), ['Sunrise Cafe'],
    'a 45-minute breakfast cannot happen in the 15 minutes before the shutters');
});

// ---------- the food type, which is what makes a breakfast place a
// ---------- breakfast place rather than merely an open one ----------

test('Google\'s own food type travels with the answer', opts, async () => {
  PLACES.typedCafe = {
    ...PLACES.earlyOne,
    displayName: { text: 'Typed Cafe' },
    primaryType: 'breakfast_restaurant',
    types: ['breakfast_restaurant', 'restaurant', 'food', 'point_of_interest'],
  };
  searchReturns = ['typedCafe'];
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 1, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  assert.equal(body.results[0].foodType, 'breakfast_restaurant');
});

test('the type is the MOST SPECIFIC one, and `restaurant` is the answer of last resort', opts, () => {
  assert.equal(foodTypeOf({ primaryType: 'steak_house', types: ['steak_house', 'restaurant'] }), 'steak_house');
  assert.equal(foodTypeOf({ primaryType: 'restaurant', types: ['restaurant', 'bakery'] }), 'bakery',
    'a specific type in the list beats a generic primaryType');
  assert.equal(foodTypeOf({ primaryType: 'restaurant', types: ['restaurant', 'food'] }), 'restaurant');
  // no opinion is the normal case for the long tail, and must stay empty
  assert.equal(foodTypeOf({ types: ['point_of_interest', 'establishment'] }), '');
  assert.equal(foodTypeOf({ primaryType: 'thai_restaurant', types: ['thai_restaurant'] }), '',
    'a cuisine is not a daypart, so it is not in the allowlist');
  assert.equal(foodTypeOf({}), '');
  assert.equal(foodTypeOf(null), '');
});

test('a place with no types at all still answers, it just says nothing about its daypart', opts, async () => {
  searchReturns = ['earlyOne'];
  const body = await (await discover({
    q: 'breakfast restaurant Ao Nang', ...AO_NANG, limit: 1, meal: 'breakfast', schedule: BREAKFAST,
  })).json();
  assert.equal(body.results[0].name, 'Sunrise Cafe');
  assert.equal(body.results[0].foodType, undefined, 'absent, never guessed');
});

// ---------- the clamp ----------

test('the schedule is validated to shape like everything else in the body', opts, () => {
  const base = { q: 'breakfast restaurant', limit: 2 };
  assert.deepEqual(clampDiscover({ ...base, schedule: { date: '2027-01-27', time: '08:00', windowMin: 45 } }).schedule,
    { date: '2027-01-27', time: '08:00', windowMin: 45 });
  // a malformed schedule is DROPPED entirely, never half-applied: a partial
  // hours filter would silently refuse real venues
  for (const bad of [
    { date: '27/01/2027', time: '08:00' },
    { date: '2027-01-27', time: '8:00' },
    { date: '2027-01-27' },
    { time: '08:00' },
    'nonsense', null, 42, [],
  ]) {
    assert.equal(clampDiscover({ ...base, schedule: bad }).schedule, undefined, JSON.stringify(bad));
  }
  // an absurd window is clamped rather than trusted
  assert.equal(clampDiscover({ ...base, schedule: { date: '2027-01-27', time: '08:00', windowMin: 99999 } }).schedule.windowMin, 240);
  assert.equal(clampDiscover({ ...base, schedule: { date: '2027-01-27', time: '08:00', windowMin: -5 } }).schedule.windowMin, 0);
  assert.equal(clampDiscover({ ...base, schedule: { date: '2027-01-27', time: '08:00' } }).schedule.windowMin, 0);
});
