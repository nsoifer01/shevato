// THE RETRY HAS TO BE AFFORDABLE, or it does not exist.
//
// Found on 2026-08-27 during live validation of the wrong-branch fix, by
// reading the upstream call log of a REAL handler run rather than a unit test:
// the geographically constrained retry never fired. The pipeline tests had
// passed because they call resolveQueries directly with an injected budget;
// the HANDLER reserves one slot per query, so a query's own first Place Details
// took the only slot and the retry's claim() always failed.
//
// That made the retry dead code in the commonest batch of all - a single
// recommendation, which is exactly the shape of the bug report it was written
// for. These tests drive the whole handler so the budget is the real one.
import { register } from 'node:module';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let hooksOk = true;
try {
  register('./tp-assist-blobs-hooks.mjs', import.meta.url);
} catch {
  hooksOk = false; // Node < 20.6: no customization hooks, the handler path is unreachable
}
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable; the handler needs the @netlify/blobs hook' };

const { default: handler } = await import('../tp-places.mjs');
const STORE = 'trip-planner-places';

// Two places with the SAME name: one far outside the expected area (what an
// unrestricted search returns) and one inside it (what a restricted search
// returns). The name gate passes for both; only geography tells them apart.
const FAR = {
  displayName: { text: 'Chain Cafe' },
  googleMapsUri: 'https://maps.google.com/?cid=111',
  rating: 4.6, userRatingCount: 2900,
  location: { latitude: 43.0590, longitude: 141.3540 },
  formattedAddress: 'Chuo Ward, Sapporo, Hokkaido, Japan',
  addressComponents: [{ longText: 'Sapporo' }, { longText: 'Hokkaido' }, { longText: 'Japan' }],
};
const NEAR = {
  displayName: { text: 'Chain Cafe' },
  googleMapsUri: 'https://maps.google.com/?cid=222',
  rating: 4.0, userRatingCount: 87,
  location: { latitude: 35.6827, longitude: 139.7658 },
  formattedAddress: '1 Chome-9-1 Marunouchi, Chiyoda City, Tokyo, Japan',
  addressComponents: [{ longText: 'Chiyoda City' }, { longText: 'Tokyo' }, { longText: 'Japan' }],
};

let calls;
let realFetch;
beforeEach(() => {
  calls = [];
  const map = new Map();
  map.set('config', { data: { placesKeyV2: 'test-key' }, etag: 'e1' });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq: 0 };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('places:searchText')) {
      const body = JSON.parse(init.body || '{}');
      const restricted = !!body.locationRestriction;
      calls.push({ kind: 'search', restricted, q: body.textQuery });
      // A restriction EXCLUDES: only the in-area place can come back.
      return json({ places: [{ id: restricted ? 'near' : 'far' }] });
    }
    const m = /\/v1\/places\/([^?]+)/.exec(href);
    if (m) {
      calls.push({ kind: 'details', id: m[1] });
      return json(m[1] === 'near' ? NEAR : FAR);
    }
    throw new Error('unexpected fetch ' + href);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const post = (queries, clientId = 'c-retry') => handler(new Request(
  'https://shevato.com/.netlify/functions/tp-places',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shevato.com' },
    body: JSON.stringify({ clientId, queries }),
  },
));

const TOKYO = { city: 'Tokyo', country: 'Japan', lat: 35.6812, lon: 139.7671 };

test('a SINGLE rejected recommendation can still afford its retry', opts, async () => {
  // The regression. One query is the whole batch, so before the fix the only
  // reserved slot was already spent on the wrong candidate and the rescue
  // never happened: the traveller saw an unresolved card for a place that was
  // findable all along.
  const res = await post([{ id: 'chain@tokyo', q: 'Chain Cafe Tokyo Station', ...TOKYO }]);
  const body = await res.json();
  const r = body.results[0];

  assert.equal(calls.filter(c => c.kind === 'search').length, 2, 'the retry search must happen');
  assert.equal(calls.filter(c => c.kind === 'search')[1].restricted, true, 'and it must be RESTRICTED');
  assert.equal(calls.filter(c => c.kind === 'details').length, 2, 'both candidates were fetched');
  assert.equal(r.status, 'ok', 'the retry rescued the recommendation');
  assert.equal(r.placeId, 'near');
  assert.equal(r.verified, true);
  assert.equal(r.rating, NEAR.rating, "the IN-AREA branch's rating, not the famous one's");
  assert.equal(r.lat, NEAR.location.latitude);
});

test('the rescue is what gets billed, and the wrong candidate is not kept', opts, async () => {
  await post([{ id: 'chain@tokyo', q: 'Chain Cafe Tokyo Station', ...TOKYO }]);
  const usage = globalThis.__tpAssistBlobStub.stores[STORE].get('usage').data;
  assert.equal(usage.billedMonth, 2, 'two Place Details calls were actually made, and both are counted');
  // The place-ID cache must hold the RESCUED id, so the next render does not
  // pay to rediscover the wrong one.
  const idKey = [...globalThis.__tpAssistBlobStub.stores[STORE].keys()].find(k => k.startsWith('id:'));
  assert.equal(globalThis.__tpAssistBlobStub.stores[STORE].get(idKey).data.placeId, 'near');
});

test('headroom is reserved but RELEASED when no retry is needed', opts, async () => {
  // The reservation is an upper bound, not a charge. A batch whose candidates
  // all resolve first time must leave the counters at exactly what it spent,
  // or every clean batch would quietly burn the traveller's hourly allowance.
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('places:searchText')) return json({ places: [{ id: 'near' }] });
    return json(NEAR);
  };
  await post([
    { id: 'a@tokyo', q: 'Chain Cafe Marunouchi Tokyo', ...TOKYO },
    { id: 'b@tokyo', q: 'Chain Cafe Chiyoda Tokyo', ...TOKYO },
  ]);
  const usage = globalThis.__tpAssistBlobStub.stores[STORE].get('usage').data;
  assert.equal(usage.billedMonth, 2, 'two queries, two calls, no headroom left reserved');
  assert.equal(usage.clientHour['c-retry'], 2);
});

test('the headroom is bounded, so a full batch cannot reserve without limit', opts, async () => {
  // 12 queries must not reserve 24: the monthly ceiling is the one thing
  // standing between this app and an invoice, and a transient over-reservation
  // is still a reservation while it is held.
  const { retryHeadroom } = await import('../tp-places.mjs');
  assert.equal(retryHeadroom(1), 1, 'a single recommendation can afford one rescue');
  assert.equal(retryHeadroom(2), 2);
  assert.ok(retryHeadroom(12) <= 4, 'a full batch reserves a bounded number of rescues');
  assert.equal(retryHeadroom(0), 0, 'nothing billable, nothing reserved');
});
