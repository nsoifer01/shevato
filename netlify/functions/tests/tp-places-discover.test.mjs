// DISCOVERY MODE: find real candidates, so a failed recommendation can be
// REPLACED rather than shown.
//
// The gates here are deliberately different from a named lookup's, and the
// difference is the whole design:
//
//   named lookup   "the model said Royce' Tokyo Station" -> the NAME gate is
//                  the point: is this the same business?
//   discovery      "the traveller wants chocolate shops in Tokyo" -> nobody
//                  named a venue, so there is no name to check. What replaces
//                  it is that the SEARCH is restricted to the area and every
//                  candidate still goes through verifyArea.
//
// Applying the name gate here would reject every correct answer:
// matchConfidence("nama chocolate Tokyo", "Musee Du Chocolat Theobroma") is 0.
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
const { DISCOVERY_DETAILS_MAX } = await import('../lib/tp-places-lookup.mjs');
const STORE = 'trip-planner-places';

// Real Tokyo chocolate shops, real coordinates; plus one Hokkaido ringer that
// must never survive a Tokyo discovery.
const PLACES = {
  theobroma: {
    displayName: { text: 'Musee Du Chocolat Theobroma' }, rating: 4.3, userRatingCount: 640,
    googleMapsUri: 'https://maps.google.com/?cid=11', location: { latitude: 35.6580, longitude: 139.6980 },
    formattedAddress: '2 Chome Shibuya, Shibuya City, Tokyo, Japan',
    addressComponents: [{ longText: 'Shibuya City' }, { longText: 'Tokyo' }, { longText: 'Japan' }],
  },
  marcolini: {
    displayName: { text: 'Pierre Marcolini Ginza' }, rating: 4.2, userRatingCount: 1180,
    googleMapsUri: 'https://maps.google.com/?cid=12', location: { latitude: 35.6717, longitude: 139.7650 },
    formattedAddress: '5 Chome Ginza, Chuo City, Tokyo, Japan',
    addressComponents: [{ longText: 'Chuo City' }, { longText: 'Tokyo' }, { longText: 'Japan' }],
  },
  unrated: {
    displayName: { text: 'Tiny Chocolate Counter' }, userRatingCount: 0,
    googleMapsUri: 'https://maps.google.com/?cid=13', location: { latitude: 35.66, longitude: 139.70 },
    formattedAddress: '1 Chome Shibuya, Shibuya City, Tokyo, Japan',
    addressComponents: [{ longText: 'Shibuya City' }, { longText: 'Tokyo' }, { longText: 'Japan' }],
  },
  hokkaido: {
    displayName: { text: "ROYCE' Chocolate World" }, rating: 4.4, userRatingCount: 3187,
    googleMapsUri: 'https://maps.google.com/?cid=14', location: { latitude: 42.7878, longitude: 141.6810 },
    formattedAddress: 'New Chitose Airport, Chitose, Hokkaido, Japan',
    addressComponents: [{ longText: 'Chitose' }, { longText: 'Hokkaido' }, { longText: 'Japan' }],
  },
};

let calls, realFetch, searchReturns;
beforeEach(() => {
  calls = [];
  searchReturns = ['theobroma', 'marcolini'];
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

const discover = (spec, clientId = 'c-disc') => handler(new Request(
  'https://shevato.com/.netlify/functions/tp-places',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shevato.com' },
    body: JSON.stringify({ clientId, discover: spec }),
  },
));

const TOKYO = { city: 'Tokyo', country: 'Japan', lat: 35.6812, lon: 139.7671 };

test('discovery returns verified candidates for a category query', opts, async () => {
  const body = await (await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 })).json();
  assert.equal(body.discovered, true);
  assert.equal(body.results.length, 2);
  assert.deepEqual(body.results.map(r => r.name),
    ['Musee Du Chocolat Theobroma', 'Pierre Marcolini Ginza']);
  assert.ok(body.results.every(r => r.verified === true));
  assert.ok(body.results.every(r => r.placeId));
  assert.ok(body.results.every(r => typeof r.rating === 'number'));
});

test('the discovery search is RESTRICTED, never merely biased', opts, async () => {
  // A biased discovery search is how the original bug happened: ask the planet
  // for a chocolate shop and the famous one wins, wherever it is.
  await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 });
  const search = calls.find(c => c.kind === 'search');
  assert.ok(search.body.locationRestriction, 'a restriction, not a bias');
  assert.equal(search.body.locationBias, undefined);
  assert.ok(search.body.pageSize > 1, 'discovery chooses among candidates rather than confirming one');
});

test('WRONG-AREA candidates are rejected here too - the gate is not weakened to fill a count', opts, async () => {
  // The restricted search should already have excluded it; this proves the
  // second net holds even when the provider hands one over anyway.
  searchReturns = ['hokkaido', 'theobroma'];
  const body = await (await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 })).json();
  assert.deepEqual(body.results.map(r => r.name), ['Musee Du Chocolat Theobroma']);
  assert.equal(body.results.some(r => /ROYCE/.test(r.name)), false);
});

test('an UNRATED place is not offered as a replacement', opts, async () => {
  // It is a real place, and a named lookup would keep it. But the traveller
  // asked for GOOD places and this one is only being offered because another
  // failed - "we found you something, we just cannot say if it is any good"
  // is not a recommendation.
  searchReturns = ['unrated', 'marcolini'];
  const body = await (await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 })).json();
  assert.deepEqual(body.results.map(r => r.name), ['Pierre Marcolini Ginza']);
});

test('DEDUPE AT THE SOURCE: excluded place IDs are never fetched', opts, async () => {
  // Not just filtered from the results - never looked at, because looking costs
  // $0.02. The client sends everything it already offered AND everything it
  // already rejected.
  searchReturns = ['theobroma', 'marcolini'];
  const body = await (await discover({
    q: 'nama chocolate Tokyo', ...TOKYO, limit: 2, exclude: ['theobroma'],
  })).json();
  assert.deepEqual(body.results.map(r => r.name), ['Pierre Marcolini Ginza']);
  assert.equal(calls.some(c => c.kind === 'details' && c.id === 'theobroma'), false,
    'an excluded candidate is not paid for');
});

test('the billed ceiling is respected however many candidates come back', opts, async () => {
  searchReturns = ['theobroma', 'marcolini', 'unrated', 'hokkaido', 'theobroma2', 'x', 'y', 'z'];
  await discover({ q: 'chocolate Tokyo', ...TOKYO, limit: 99 });
  const details = calls.filter(c => c.kind === 'details').length;
  assert.ok(details <= DISCOVERY_DETAILS_MAX, `${details} details calls exceeds the ceiling`);
});

test('only what was actually looked at is billed', opts, async () => {
  await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 4 });
  const usage = globalThis.__tpAssistBlobStub.stores[STORE].get('usage').data;
  const details = calls.filter(c => c.kind === 'details').length;
  assert.equal(usage.billedMonth, details, 'the reservation headroom is released');
});

test('a discovery request with nothing findable answers empty, not wrong', opts, async () => {
  searchReturns = [];
  const body = await (await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 3 })).json();
  assert.deepEqual(body.results, []);
  const usage = globalThis.__tpAssistBlobStub.stores[STORE].get('usage').data;
  assert.equal(usage.billedMonth, 0, 'a free search that finds nothing costs nothing');
});

test('clampDiscover bounds every field a hostile body could send', () => {
  const out = clampDiscover({
    q: 'x'.repeat(500), city: 'y'.repeat(500), country: 'z'.repeat(500),
    lat: 999, lon: 0, limit: 9999,
    exclude: [...Array(100)].map((_, i) => 'id' + i).concat([null, 42]),
  });
  assert.equal(out.q.length, 200);
  assert.equal(out.city.length, 80);
  assert.equal(out.country.length, 80);
  assert.equal(out.lat, undefined, 'an out-of-range coordinate never travels');
  assert.ok(out.limit <= DISCOVERY_DETAILS_MAX);
  assert.ok(out.exclude.length <= 24);
  assert.ok(out.exclude.every(x => typeof x === 'string'));
  assert.equal(clampDiscover({ q: '' }), null);
  assert.equal(clampDiscover(null), null);
});
