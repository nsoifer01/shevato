// What one tp-places request costs, measured at the HANDLER, not at the
// library.
//
// tp-places-search-accounting.test.mjs pins resolveQueries and releaseQuota
// directly, which proves the arithmetic and nothing about the wiring: a handler
// that computed the right numbers and then dropped one of them on the way into
// releaseQuota passed every test there. That is not hypothetical. The NAMED
// path shipped with one refund on 2026-09-11 (480 free searches, zero on every
// counter), and the DISCOVERY path kept that exact bug after the named path
// was fixed (2026-09-12 audit F-1: 1,000 discover requests admitted against a
// 60/hour per-client cap). Both times the library was right and the call site
// was wrong.
//
// So these drive the real default export through the @netlify/blobs stub and
// read the counters the handler actually wrote. The rule they pin:
//
//   an upstream Text Search costs RATE quota (per-client, per-network) even
//   when it finds nothing; a billed Place Details call costs MONEY
//   (billedMonth and the shared pools) and rate once, never twice; a request
//   that did no upstream work at all costs nothing.
//
// Also here, because they are the handler's own fail-closed boundaries and no
// other test makes them speak: sustained CAS contention answers 429 with a
// short Retry-After, and a store that cannot be reached answers 503
// store_unavailable. Neither may ever reach Google.
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

const { default: handler } = await import('../tp-places.mjs');
const { idCacheKey } = await import('../lib/tp-places-lookup.mjs');
const { DEFAULT_LIMITS } = await import('../lib/tp-places-quota.mjs');
const STORE = 'trip-planner-places';
const ADDR = '203.0.113.7';

const TOKYO = { city: 'Tokyo', country: 'Japan', lat: 35.6812, lon: 139.7671 };
const THEOBROMA = {
  displayName: { text: 'Musee Du Chocolat Theobroma' }, rating: 4.3, userRatingCount: 640,
  googleMapsUri: 'https://maps.google.com/?cid=11', location: { latitude: 35.6580, longitude: 139.6980 },
  formattedAddress: '2 Chome Shibuya, Shibuya City, Tokyo, Japan',
  addressComponents: [{ longText: 'Shibuya City' }, { longText: 'Tokyo' }, { longText: 'Japan' }],
};
const MARCOLINI = {
  displayName: { text: 'Pierre Marcolini Ginza' }, rating: 4.2, userRatingCount: 1180,
  googleMapsUri: 'https://maps.google.com/?cid=12', location: { latitude: 35.6717, longitude: 139.7650 },
  formattedAddress: '5 Chome Ginza, Chuo City, Tokyo, Japan',
  addressComponents: [{ longText: 'Chuo City' }, { longText: 'Tokyo' }, { longText: 'Japan' }],
};
const PLACES = { theobroma: THEOBROMA, marcolini: MARCOLINI };

let calls, realFetch, searchReturns;
function seed(map = new Map()) {
  map.set('config', { data: { placesKeyV2: 'test-key' }, etag: 'e1' });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq: 0 };
  return map;
}
beforeEach(() => {
  calls = [];
  searchReturns = [];
  seed();
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('places:searchText')) {
      calls.push({ kind: 'search' });
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
afterEach(() => { globalThis.fetch = realFetch; delete globalThis.__tpAssistBlobStub; });

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const call = (payload, clientId = 'c-acct') => handler(new Request(
  'https://shevato.com/.netlify/functions/tp-places',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shevato.com', 'x-nf-client-connection-ip': ADDR },
    body: JSON.stringify({ clientId, ...payload }),
  },
));
const named = (queries, clientId) => call({ queries }, clientId);
const discover = (spec, clientId) => call({ discover: spec }, clientId);

/** The counters as the handler left them, reduced to the numbers that matter. */
function counters(clientId = 'c-acct') {
  const e = globalThis.__tpAssistBlobStub.stores[STORE].get('usage');
  const u = e ? e.data : {};
  const only = m => (m ? Object.values(m).reduce((a, b) => a + b, 0) : 0);
  return {
    clientHour: (u.clientHour || {})[clientId] || 0,
    clientDay: (u.clientDay || {})[clientId] || 0,
    networkHour: only(u.networkHour),
    networkDay: only(u.networkDay),
    globalDay: u.globalDay || 0,
    billedMonth: u.billedMonth || 0,
  };
}
const searches = () => calls.filter(c => c.kind === 'search').length;
const detailsCalls = () => calls.filter(c => c.kind === 'details').length;

// ------------------------------------------------------------ discovery ---

test('F-1: a discovery search that finds nothing costs one search of rate quota and no money', opts, async () => {
  searchReturns = [];
  const res = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 3 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reason, 'no_candidates');
  assert.equal(searches(), 1, 'one real upstream search ran');
  assert.equal(detailsCalls(), 0);
  assert.deepEqual(counters(), {
    clientHour: 1, clientDay: 1, networkHour: 1, networkDay: 1,
    globalDay: 0, billedMonth: 0,
  }, 'the search is charged to the caller and the unused money comes back');
});

test('F-1: repeated no-result discovery is refused once the per-client hourly cap is reached', opts, async () => {
  // THE ABUSE, end to end. Before the fix every one of these was admitted at
  // zero cost, so the loop never ended: the audit stopped counting at 1,000.
  searchReturns = [];
  const cap = DEFAULT_LIMITS.perClientHour;
  for (let i = 0; i < cap; i++) {
    const res = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 1 });
    assert.equal(res.status, 200, `request ${i + 1} of ${cap} is still inside the cap`);
  }
  const refused = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 1 });
  assert.equal(refused.status, 429, 'the search after the cap is refused');
  const body = await refused.json();
  assert.ok(['client_hour', 'network_hour'].includes(body.scope), `refused by a rate bucket, got ${body.scope}`);
  assert.equal(searches(), cap, 'and the refused request never reached Google');
  assert.equal(counters().billedMonth, 0, 'none of it was ever billed');
});

test('F-1: a rotated clientId from the same network is refused by the network cap', opts, async () => {
  // The network dimension is the one the caller cannot choose, and it has to
  // count the search too, or rotating ids reopens the same hole.
  searchReturns = [];
  const cap = DEFAULT_LIMITS.perNetworkHour;
  for (let i = 0; i < cap; i++) {
    const res = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 1 }, 'rotating-' + i);
    assert.equal(res.status, 200);
  }
  const refused = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 1 }, 'rotating-fresh');
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).scope, 'network_hour');
});

test('F-1: a discovery search that fails upstream still counts the search it made', opts, async () => {
  // Same rule as the named path (resolveOne reports searched: 1 when the
  // search throws): the request reached Google, so it is not free to repeat.
  globalThis.fetch = async (url) => {
    calls.push({ kind: String(url).includes('places:searchText') ? 'search' : 'details' });
    return json({ error: 'UNAVAILABLE' }, 503);
  };
  const res = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 });
  assert.equal((await res.json()).reason, 'upstream');
  const c = counters();
  assert.equal(c.clientHour, 1);
  assert.equal(c.networkHour, 1);
  assert.equal(c.billedMonth, 0, 'a failed search bills nothing');
});

test('F-1: a successful discovery charges money once per billed call and rate once, never twice', opts, async () => {
  // limit 4 against two candidates: the two unused slots come back on BOTH
  // dimensions, and the search that found the two is not charged on top of
  // the two Details calls (the rate counter tracks units of work the same way
  // the named path does, max(spent, searched)).
  searchReturns = ['theobroma', 'marcolini'];
  const res = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 4 });
  assert.equal((await res.json()).results.length, 2);
  assert.equal(detailsCalls(), 2);
  assert.deepEqual(counters(), {
    clientHour: 2, clientDay: 2, networkHour: 2, networkDay: 2,
    globalDay: 2, billedMonth: 2,
  });
});

// ---------------------------------------------------------------- named ---

test('Q-3: the named path keeps the search on the rate counters when it resolves to nothing', opts, async () => {
  // THE WIRING TEST. Drop the seventh argument of the named-path releaseQuota
  // call and the rate refund defaults to the money refund: this reads 0 on
  // every rate counter and fails.
  searchReturns = [];
  const res = await named([{ q: 'Nowhere Cafe Atlantis', id: 'a', ...TOKYO }]);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results[0].status, 'no_match');
  assert.equal(searches(), 1);
  assert.deepEqual(counters(), {
    clientHour: 1, clientDay: 1, networkHour: 1, networkDay: 1,
    globalDay: 0, billedMonth: 0,
  });
});

test('Q-3: a named lookup answered from the cache does no upstream work and costs nothing', opts, async () => {
  // A cached "no match" for this exact query and area: the handler still
  // RESERVES before it knows (it cannot tell a hit from a miss up front), and
  // then refunds the whole reservation on both dimensions, because nothing
  // upstream happened. This is the property a traveller re-opening an
  // itinerary depends on. Discovery has no cache by design (a category's
  // answer changes with the world), so it has no equivalent case.
  const now = Date.now();
  const map = seed();
  const area = { city: TOKYO.city, country: TOKYO.country, lat: TOKYO.lat, lon: TOKYO.lon };
  const { normalizeArea } = await import('../lib/tp-places-match.mjs');
  map.set(idCacheKey('Nowhere Cafe Atlantis', normalizeArea(area)),
    { data: { placeId: null, reason: 'not_found', at: now }, etag: 'e2' });
  const res = await named([{ q: 'Nowhere Cafe Atlantis', id: 'a', ...TOKYO }]);
  assert.equal((await res.json()).results[0].status, 'no_match');
  assert.equal(calls.length, 0, 'no search, no details');
  assert.deepEqual(counters(), {
    clientHour: 0, clientDay: 0, networkHour: 0, networkDay: 0,
    globalDay: 0, billedMonth: 0,
  });
});

test('Q-3: the named path and discovery charge the same for the same outcome', opts, async () => {
  // One search, nothing found, through each path, from two different clients
  // on two different networks. If either path ever refunds differently the
  // two ledgers stop matching.
  searchReturns = [];
  await named([{ q: 'Nowhere Cafe Atlantis', id: 'a', ...TOKYO }], 'c-named');
  const namedCounters = counters('c-named');
  seed();
  await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 1 }, 'c-disc');
  const discCounters = counters('c-disc');
  assert.deepEqual(discCounters, namedCounters);
  assert.equal(discCounters.clientHour, 1);
  assert.equal(discCounters.billedMonth, 0);
});

// ------------------------------------------------- fail-closed boundaries ---

/**
 * A usage blob another writer changes between every read and every write:
 * each read hands out a new etag, so every conditional write loses its race.
 * That is exactly what sustained contention looks like to lib/blob-cas.mjs.
 */
class RacingMap extends Map {
  constructor(racedKey) { super(); this.racedKey = racedKey; this.reads = 0; }
  get(key) {
    const e = super.get(key);
    if (key !== this.racedKey) return e;
    this.reads += 1;
    return { data: e ? e.data : {}, etag: 'racer-' + this.reads };
  }
}

test('Q-3: sustained CAS contention on the counters is a 429 with a 2 s Retry-After, and never reaches Google', opts, async () => {
  const map = seed(new RacingMap('usage'));
  searchReturns = ['theobroma'];
  const res = await named([{ q: 'Ichiran Ramen Shibuya', id: 'a', ...TOKYO }]);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '2');
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.scope, 'contention');
  assert.equal(calls.length, 0, 'fails CLOSED: no reservation landed, so nothing is spent');
  assert.ok(map.reads >= 5, 'it really retried before giving up');
  assert.equal(Map.prototype.get.call(map, 'usage'), undefined, 'and no write ever landed');

  const disc = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 });
  assert.equal(disc.status, 429, 'discovery shares the same boundary');
  assert.equal(calls.length, 0);
});

test('Q-3: a store that cannot be acquired answers 503 store_unavailable before any upstream call', opts, async () => {
  delete globalThis.__tpAssistBlobStub; // getStore() now throws, like a Blobs incident
  const res = await named([{ q: 'Ichiran Ramen Shibuya', id: 'a', ...TOKYO }]);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'store_unavailable' });
  assert.equal(calls.length, 0);
});

test('Q-3: a store whose read throws answers 503 store_unavailable, not a bodyless 500', opts, async () => {
  class ThrowingMap extends Map { get() { throw new Error('blobs 500'); } }
  seed(new ThrowingMap());
  const res = await discover({ q: 'nama chocolate Tokyo', ...TOKYO, limit: 2 });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'store_unavailable' });
  assert.equal(calls.length, 0);
});
