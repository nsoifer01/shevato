import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFplApi, NotFoundError, CACHE_PREFIX, labelFor } from '../js/data/api.js';
import { assembleSampleBundle } from '../js/data/sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

// A localStorage stand-in with the same surface the client uses.
function fakeStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (failWrites) throw new Error('QuotaExceededError'); map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

function proxyResponse(body, { fetchedAt = '2026-08-10T12:00:00Z', cache = 'miss', stale = false, status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'x-fpl-cache': cache,
      'x-fpl-fetched-at': fetchedAt,
      'x-fpl-stale': String(stale),
      'x-fpl-age-seconds': '0',
    },
  });
}

// A plain static dev server answering a request for a function it does not have.
const functionAbsent = () => new Response('<!doctype html><h1>Not Found</h1>', {
  status: 404, headers: { 'Content-Type': 'text/html' },
});

function recorder(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push(url); return handler(url, init); };
  fn.calls = calls;
  return fn;
}

const NOW = Date.parse('2026-08-10T12:00:00Z');

// ---------------------------------------------------------------- basics ----

test('a proxy response is returned with its freshness metadata', () => {
  const fetchImpl = recorder(() => proxyResponse({ ok: 1 }, { fetchedAt: '2026-08-10T11:59:00Z' }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  return api.getBootstrap().then(res => {
    assert.deepEqual(res.data, { ok: 1 });
    assert.equal(res.fetchedAt, '2026-08-10T11:59:00Z');
    assert.equal(res.stale, false);
    assert.equal(res.ageSeconds, 60, 'freshness is measured from when the DATA was fetched, not this request');
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(fetchImpl.calls[0], /\/\.netlify\/functions\/fpl\?path=bootstrap-static$/);
  });
});

test('paths are built from validated integers, and junk never reaches the network', async () => {
  // The team id is user input and ends up in a URL path.
  const fetchImpl = recorder(() => proxyResponse({}));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  for (const bad of ['abc', '', null, -1, 0, 1.5, '1/../admin', '12; drop']) {
    assert.throws(() => api.getEntry(bad), /invalid team id/);
  }
  assert.equal(fetchImpl.calls.length, 0, 'no request was made for any invalid id');

  await api.getEntryPicks('4231987', '6');
  assert.match(fetchImpl.calls[0], /path=entry%2F4231987%2Fevent%2F6%2Fpicks$/);
  assert.throws(() => api.getEntryPicks(1, 'x'), /invalid gameweek/);
});

// ---------------------------------------------------------------- caching ---

test('a fresh cache entry is served without touching the network', async () => {
  const fetchImpl = recorder(() => proxyResponse({ n: 1 }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  await api.getBootstrap();
  const second = await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(second.data, { n: 1 });
});

test('the cache expires per endpoint, and force always refetches', async () => {
  let clock = NOW;
  let n = 0;
  const fetchImpl = recorder(() => proxyResponse({ n: ++n }, { fetchedAt: new Date(clock).toISOString() }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => clock });

  await api.getBootstrap();
  clock += 9 * 60 * 1000;             // bootstrap TTL is 10 minutes
  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1, 'still fresh at 9 minutes');
  clock += 2 * 60 * 1000;
  const stale = await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 2, 'refetched past 10 minutes');
  assert.deepEqual(stale.data, { n: 2 });

  await api.getBootstrap({ force: true });
  assert.equal(fetchImpl.calls.length, 3);
});

test('one in-flight request per path, however many callers ask at once', async () => {
  let resolve;
  const gate = new Promise(r => { resolve = r; });
  const fetchImpl = recorder(async () => { await gate; return proxyResponse({ n: 1 }); });
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });

  const all = Promise.all([api.getBootstrap(), api.getBootstrap(), api.getBootstrap(), api.getFixtures()]);
  resolve();
  const [a, b, c] = await all;
  assert.equal(fetchImpl.calls.filter(u => u.includes('bootstrap')).length, 1, 'the 1.3 MB payload is fetched once');
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(b.data, c.data);
});

test('the cache survives a page reload through localStorage', async () => {
  const storage = fakeStorage();
  const fetchImpl = recorder(() => proxyResponse({ n: 1 }));
  await createFplApi({ fetchImpl, storage, now: () => NOW }).getBootstrap();
  assert.ok(storage.getItem(CACHE_PREFIX + 'bootstrap-static'), 'cached under the unsynced prefix');

  const reloaded = createFplApi({ fetchImpl, storage, now: () => NOW });
  const res = await reloaded.getBootstrap();
  assert.deepEqual(res.data, { n: 1 });
  assert.equal(fetchImpl.calls.length, 1, 'a reload does not re-download');
});

test('a full localStorage degrades to the memory cache instead of failing', async () => {
  // shevato.com's apps share one origin quota and bootstrap-static is over a
  // megabyte, so this is a real condition, not a hypothetical.
  const fetchImpl = recorder(() => proxyResponse({ n: 1 }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage({ failWrites: true }), now: () => NOW });
  await api.getBootstrap();
  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1);
});

test('cached entries are only ever written under the unsynced cache prefix', async () => {
  const storage = fakeStorage();
  const api = createFplApi({ fetchImpl: recorder(() => proxyResponse({ n: 1 })), storage, now: () => NOW });
  await api.getBootstrap();
  await api.getEntry(1);
  for (const key of storage._map.keys()) {
    assert.ok(key.startsWith(CACHE_PREFIX), `${key} would be picked up by the sync namespace`);
  }
  api.clearCache();
  assert.equal(storage._map.size, 0);
});

// ---------------------------------------------------------------- fallback --

test('a missing Netlify function falls back to a direct upstream fetch', async () => {
  const fetchImpl = recorder((url) => (
    url.includes('/.netlify/') ? functionAbsent() : new Response(JSON.stringify({ direct: true }), { status: 200 })
  ));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  const res = await api.getBootstrap();
  assert.deepEqual(res.data, { direct: true });
  assert.match(fetchImpl.calls[1], /^https:\/\/fantasy\.premierleague\.com\/api\/bootstrap-static\/$/);

  // And it stops probing for the function it already knows is absent.
  await api.getFixtures();
  assert.equal(fetchImpl.calls.filter(u => u.includes('/.netlify/')).length, 1);
});

test('an upstream 404 is a real answer, not a missing function', async () => {
  // Both are 404s. Only our function stamps x-fpl-cache, which is what tells
  // "this team id does not exist" apart from "this dev server has no functions".
  const fetchImpl = recorder(() => proxyResponse({ error: 'not_found' }, { status: 404 }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  await assert.rejects(api.getEntry(999999999), NotFoundError);
  assert.equal(fetchImpl.calls.length, 1, 'it did not fall through to a direct fetch');
});

test('a network failure serves the cached copy, flagged stale', async () => {
  let clock = NOW;
  let mode = 'ok';
  const fetchImpl = recorder(() => {
    if (mode === 'fail') throw new Error('network down');
    return proxyResponse({ n: 1 }, { fetchedAt: new Date(clock).toISOString() });
  });
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => clock });
  await api.getBootstrap();

  clock += 60 * 60 * 1000;
  mode = 'fail';
  const res = await api.getBootstrap();
  assert.deepEqual(res.data, { n: 1 });
  assert.equal(res.stale, true, 'a stale plan must never be presented as current');
  assert.equal(res.ageSeconds, 3600);

  const status = api.getDataStatus().sources.find(s => s.path === 'bootstrap-static');
  assert.equal(status.ok, false);
  assert.match(status.error, /network down/);
});

test('a network failure with nothing cached fails loudly', async () => {
  const fetchImpl = recorder(() => { throw new Error('network down'); });
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  await assert.rejects(api.getBootstrap(), /network down/);
  // A failed request must never be retried forever by a stuck in-flight entry.
  await assert.rejects(api.getBootstrap(), /network down/);
  assert.equal(fetchImpl.calls.length, 2);
});

// ---------------------------------------------------------------- status ----

test('data status reports every source the app has asked for', async () => {
  const fetchImpl = recorder((url) => (
    url.includes('history') ? proxyResponse({ e: 1 }, { status: 404 }) : proxyResponse({ ok: 1 })
  ));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  await api.getBootstrap();
  await api.getFixtures();
  await api.getEntryHistory(4231987).catch(() => {});

  const { sources, sample } = api.getDataStatus();
  assert.equal(sample, false);
  assert.deepEqual(sources.map(s => s.name), ['Players, prices and news', 'Fixtures', 'Your season history']);
  assert.deepEqual(sources.map(s => s.ok), [true, true, false]);
  for (const s of sources.slice(0, 2)) {
    assert.equal(s.fetchedAt, '2026-08-10T12:00:00Z');
    assert.equal(s.ageSeconds, 0);
    assert.equal(s.error, null);
  }
  assert.equal(labelFor('entry/1/event/6/picks'), 'Your squad');
  assert.equal(labelFor('something-else'), 'something-else');
});

// ---------------------------------------------------------------- sample ----

test('sample data is served only when explicitly installed, and always labelled', async () => {
  const sample = assembleSampleBundle({
    meta: read('..', 'data', 'sample', 'meta.json'),
    bootstrap: read('..', 'data', 'sample', 'bootstrap.json'),
    fixtures: read('..', 'data', 'sample', 'fixtures.json'),
    entry: read('..', 'data', 'sample', 'entry.json'),
    'entry-history': read('..', 'data', 'sample', 'entry-history.json'),
    'entry-transfers': read('..', 'data', 'sample', 'entry-transfers.json'),
    'entry-picks': read('..', 'data', 'sample', 'entry-picks.json'),
  });
  const fetchImpl = recorder(() => proxyResponse({ live: true }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });

  assert.equal(api.isSampleMode(), false);
  api.useSampleData(sample);
  assert.equal(api.isSampleMode(), true);

  const res = await api.getBootstrap();
  assert.equal(res.sample, true);
  assert.equal(res.data.sample, true);
  assert.equal(fetchImpl.calls.length, 0, 'demo mode never calls the network');
  assert.equal(api.getDataStatus().sample, true);

  const squad = await api.getEntryPicks(sample.entryId, sample.currentEvent);
  assert.equal(squad.data.picks.length, 15);
  await assert.rejects(api.getEntryPicks(sample.entryId, 1), NotFoundError, 'the demo does not invent gameweeks it has no data for');
});

test('an unlabelled bundle is refused, so sample data can never be a silent fallback', () => {
  const api = createFplApi({ fetchImpl: recorder(() => proxyResponse({})), storage: fakeStorage(), now: () => NOW });
  assert.throws(() => api.useSampleData({ byPath: {} }), /not labelled sample/);
  assert.throws(() => api.useSampleData(null), /not labelled sample/);
  assert.equal(api.isSampleMode(), false);
});

// --- proxy-unavailable diagnosis ------------------------------------------
//
// Regression test for a real support case: `netlify dev` listens on TWO ports,
// an internal static file server (commonly 3999) and the Netlify proxy
// (commonly 8888). Only the proxy routes /.netlify/functions/*. Opening the
// file server port produced a 404 on every function call, then a CORS failure
// on the direct fallback, and the user saw a generic network error with no clue
// which port to use.

test('a missing proxy plus a blocked fallback reports the port problem, not a generic failure', async () => {
  const calls = [];
  const api = createFplApi({
    storage: null,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/.netlify/functions/fpl')) {
        // The static server answers 404 WITHOUT our x-fpl-cache header, which
        // is how the client tells "function absent" from "team not found".
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
      }
      throw new TypeError('Failed to fetch');   // what CORS looks like to fetch()
    },
  });

  await assert.rejects(
    () => api.getBootstrap(),
    (err) => {
      assert.equal(err.name, 'ProxyUnavailableError');
      assert.match(err.message, /did not respond|not reachable/);
      return true;
    },
  );
  assert.ok(calls.some(u => u.includes('/.netlify/functions/fpl')), 'must try the proxy first');
  assert.ok(calls.some(u => u.includes('fantasy.premierleague.com')), 'then the direct fallback');
});

test('an unknown team id still reads as not found, never as a proxy problem', async () => {
  const api = createFplApi({
    storage: null,
    fetchImpl: async (url) => {
      if (String(url).includes('/.netlify/functions/fpl')) {
        // Our function DOES answer, stamping its header, and passes through a
        // genuine upstream 404. That must keep its meaning.
        return { ok: false, status: 404, headers: { get: (h) => (h === 'x-fpl-cache' ? 'miss' : null) }, json: async () => ({}) };
      }
      throw new Error('the direct fallback must not be reached here');
    },
  });
  await assert.rejects(() => api.getEntry(81223), (err) => {
    assert.equal(err.name, 'NotFoundError');
    return true;
  });
});
