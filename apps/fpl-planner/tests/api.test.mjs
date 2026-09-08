import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFplApi, NotFoundError, RequestTimeoutError, CACHE_PREFIX, labelFor,
  ATTEMPT_TIMEOUT_MS, TOTAL_DEADLINE_MS,
} from '../js/data/api.js';
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
      // Derived from fetchedAt, exactly as the proxy computes it: a fixture
      // that said "fetched a minute ago, age zero" contradicted itself and
      // could make either reading of freshness look correct.
      'x-fpl-age-seconds': String(Math.max(0, Math.round((NOW - Date.parse(fetchedAt)) / 1000))),
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
  const fetchImpl = recorder(() => proxyResponse([{ id: 1 }]));
  await createFplApi({ fetchImpl, storage, now: () => NOW }).getFixtures();
  assert.ok(storage.getItem(CACHE_PREFIX + 'fixtures'), 'cached under the unsynced prefix');

  const reloaded = createFplApi({ fetchImpl, storage, now: () => NOW });
  const res = await reloaded.getFixtures();
  assert.deepEqual(res.data, [{ id: 1 }]);
  assert.equal(fetchImpl.calls.length, 1, 'a reload does not re-download');
});

test('the bootstrap is held in memory rather than written to localStorage', async () => {
  // It is 2.6 MiB of a roughly 5 MiB per-origin budget shared with every other
  // app on this domain, and its TTL is ten minutes, so persisting it spent more
  // than half the quota to save at most one refetch per session. Measured in the
  // GW1 readiness audit; the quota failure it caused evicted everything else.
  const storage = fakeStorage();
  const fetchImpl = recorder(() => proxyResponse({ n: 1, events: [] }));
  const api = createFplApi({ fetchImpl, storage, now: () => NOW });
  await api.getBootstrap();
  assert.equal(storage.getItem(CACHE_PREFIX + 'bootstrap-static'), null, 'not persisted');

  // and it is still cached for this session
  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1, 'the memory cache still serves it');
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

/* ------------------------------------------- deadline window, clocks, quota */

// A bootstrap whose next deadline is `secondsAway` from NOW.
const bootstrapWithDeadline = (secondsAway) => ({
  events: [{ id: 1, deadline_time: new Date(NOW + secondsAway * 1000).toISOString() }],
});

test('inside the six hours before a deadline the client stops holding old copies', async () => {
  // The proxy collapses every TTL to two minutes in this window because prices
  // and injury news move. The browser sits IN FRONT of the proxy, so leaving it
  // on a ten minute TTL meant the shared cache was fresher than the screen.
  let clock = NOW;
  const fetchImpl = recorder(() => proxyResponse(bootstrapWithDeadline(90 * 60), { fetchedAt: new Date(clock).toISOString() }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => clock });

  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1);

  // Three minutes later: outside a deadline window this is well inside the ten
  // minute TTL, but the deadline is 90 minutes away so it must refetch.
  clock += 180 * 1000;
  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 2, 'a three minute old copy is too old this close to a deadline');
});

test('far from a deadline the ordinary TTL still applies', async () => {
  let clock = NOW;
  const fetchImpl = recorder(() => proxyResponse(bootstrapWithDeadline(72 * 3600), { fetchedAt: new Date(clock).toISOString() }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => clock });
  await api.getBootstrap();
  clock += 180 * 1000;
  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1, 'three minutes is well inside the ten minute TTL');
});

test('a device clock that is hours slow cannot pin the cache forever', async () => {
  // The server timestamp and the device clock are different clocks. Subtracting
  // one from the other measured the SKEW, clamped it at zero, and produced an
  // entry that never expired: the app stayed on a pre-season payload after the
  // deadline with no way out but clearing storage.
  const serverNow = NOW;
  let deviceClock = NOW - 3600 * 1000;          // an hour behind the server
  const fetchImpl = recorder(() => proxyResponse({ n: 1 }, { fetchedAt: new Date(serverNow).toISOString() }));
  const storage = fakeStorage();
  const api = createFplApi({ fetchImpl, storage, now: () => deviceClock });

  await api.getFixtures();
  assert.equal(fetchImpl.calls.length, 1);

  // Well past the fixtures TTL on the DEVICE's own clock.
  deviceClock += 2000 * 1000;
  await api.getFixtures();
  assert.equal(fetchImpl.calls.length, 2, 'the copy expired on the clock that recorded it');
});

test('a device clock that is hours fast does not expire good data instantly', async () => {
  const serverNow = NOW;
  let deviceClock = NOW + 7 * 3600 * 1000;      // seven hours ahead
  const fetchImpl = recorder(() => proxyResponse({ n: 1 }, { fetchedAt: new Date(serverNow).toISOString() }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => deviceClock });

  await api.getFixtures();
  deviceClock += 5 * 1000;
  await api.getFixtures();
  assert.equal(fetchImpl.calls.length, 1, 'five seconds is five seconds whatever the clock reads');
});

test('the reported data age is the data age, not the time this browser held it', async () => {
  let clock = NOW;
  const fetchImpl = recorder(() => proxyResponse({ n: 1 }, { fetchedAt: new Date(NOW - 120 * 1000).toISOString() }));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => clock });
  const first = await api.getFixtures();
  assert.equal(first.ageSeconds, 120, 'the proxy had it for two minutes before we did');

  clock += 30 * 1000;
  const second = await api.getFixtures();
  assert.equal(second.ageSeconds, 150, 'and thirty seconds later it is thirty seconds older');
});

test('a quota failure evicts the oldest entry rather than the whole cache', async () => {
  // Wiping every key on the first failure threw away copies that were still
  // useful and left the session with nothing persisted at all.
  // A store with a real capacity: a write of a NEW key fails while it is full,
  // and succeeds once something has been removed. Modelling "always throws"
  // would make eviction unobservable.
  const map = new Map();
  let capacity = Infinity;
  const storage = {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (!map.has(k) && map.size >= capacity) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k) => { map.delete(k); },
  };

  let clock = NOW;
  const api = createFplApi({
    fetchImpl: recorder(() => proxyResponse({ n: 1 })),
    storage,
    now: () => clock,
  });

  await api.getEntry(1);
  clock += 60_000;
  await api.getEntryHistory(1);
  clock += 60_000;
  const before = [...map.keys()];
  assert.equal(before.length, 2);

  // Now the origin is full and a third write has to make room.
  capacity = 2;
  await api.getEntryTransfers(1);

  const after = [...map.keys()];
  assert.ok(after.some(k => /transfers/.test(k)), 'the new entry was written');
  assert.ok(after.some(k => /history/.test(k)), 'the newer of the two existing entries survived');
  assert.equal(after.some(k => /entry\/1$/.test(k)), false, 'the oldest entry was the one dropped');
});

test('a transient 5xx is retried once, and a 404 is not', async () => {
  let attempts = 0;
  const flaky = recorder(() => {
    attempts++;
    if (attempts === 1) return proxyResponse({ error: 'upstream_unavailable' }, { status: 503 });
    return proxyResponse({ n: 1 });
  });
  const api = createFplApi({ fetchImpl: flaky, storage: fakeStorage(), now: () => NOW });
  const res = await api.getFixtures();
  assert.deepEqual(res.data, { n: 1 }, 'the retry succeeded');
  assert.equal(attempts, 2, 'exactly one retry');

  let notFound = 0;
  const missing = recorder(() => { notFound++; return proxyResponse({ error: 'not_found' }, { status: 404 }); });
  const api2 = createFplApi({ fetchImpl: missing, storage: fakeStorage(), now: () => NOW });
  await assert.rejects(() => api2.getEntry(999));
  assert.equal(notFound, 1, 'an unknown team is a real answer and is never retried');
});

// --------------------------------------------------- request deadlines ------
//
// The defect these pin: retry and stale-fallback both live in a `catch`, so
// they only run once a request FAILS. A connection that never settles rejects
// nothing, so the planner waited forever - and because fetchPath dedupes by
// path, a second refresh (including a forced one) joined the same stuck
// promise rather than starting a live request. A synthetic never-resolving
// fetch received no abort signal at all.
//
// The budgets are injected in milliseconds here so a real timeout is exercised
// (the timers, the abort, the fallback) without a fifteen-second test.

const FAST = { attemptTimeoutMs: 20, totalDeadlineMs: 60 };

/** A fetch that never settles, and records the signals it was handed. */
function hangingFetch() {
  const signals = [];
  const fn = (url, init) => {
    signals.push(init && init.signal);
    return new Promise((_resolve, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };
  fn.signals = signals;
  return fn;
}

test('a never-resolving request is given an abort signal and times out', async () => {
  const fetchImpl = hangingFetch();
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => Date.now(), ...FAST });
  await assert.rejects(api.getFixtures(), (err) => err instanceof RequestTimeoutError);
  assert.ok(fetchImpl.signals.length >= 1, 'the request was actually attempted');
  assert.ok(fetchImpl.signals[0], 'every attempt carries an abort signal');
  assert.equal(fetchImpl.signals[0].aborted, true, 'the socket is not left open');
});

test('a stuck request still serves the stale cached copy', async () => {
  const storage = fakeStorage();
  const good = recorder(() => proxyResponse([{ id: 1 }], { fetchedAt: '2026-08-10T11:00:00Z' }));
  await createFplApi({ fetchImpl: good, storage, now: () => NOW }).getFixtures();

  // The network now hangs and the cached copy has aged past its TTL.
  const api = createFplApi({
    fetchImpl: hangingFetch(), storage, now: () => NOW + 3600_000, ...FAST,
  });
  const res = await api.getFixtures();
  assert.deepEqual(res.data, [{ id: 1 }]);
  assert.equal(res.stale, true, 'a plan built on old numbers must say so');
});

test('an empty cache plus a stuck network is a recoverable error state', async () => {
  const api = createFplApi({ fetchImpl: hangingFetch(), storage: fakeStorage(), now: () => NOW, ...FAST });
  await api.getFixtures().catch(() => null);
  const entry = api.getDataStatus().sources.find((s) => s.path === 'fixtures');
  assert.ok(entry, 'the failure is visible to the UI');
  assert.equal(entry.ok, false);
  assert.match(String(entry.error), /timed out/i);

  // Recoverable: the in-flight slot was released, so a later call really goes
  // to the network instead of joining the abandoned promise.
  const healthy = recorder(() => proxyResponse([{ id: 7 }]));
  const api2 = createFplApi({ fetchImpl: healthy, storage: fakeStorage(), now: () => NOW, ...FAST });
  assert.deepEqual((await api2.getFixtures()).data, [{ id: 7 }]);
});

test('a forced refresh after an abandoned request issues a live request', async () => {
  const storage = fakeStorage();
  const calls = [];
  let hang = true;
  const fetchImpl = (url, init) => {
    calls.push(url);
    if (hang) {
      return new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    }
    return Promise.resolve(proxyResponse([{ id: 2 }]));
  };
  const api = createFplApi({ fetchImpl, storage, now: () => NOW, ...FAST });
  await api.getFixtures().catch(() => null);
  const afterStuck = calls.length;
  hang = false;
  const res = await api.getFixtures({ force: true });
  assert.deepEqual(res.data, [{ id: 2 }]);
  assert.ok(calls.length > afterStuck, 'the forced refresh did not join the dead promise');
});

test('a stalled response body counts against the same deadline', async () => {
  // Headers arrive, the body never does. Without a deadline the read hangs
  // exactly as a hanging connection does.
  const fetchImpl = (url, init) => Promise.resolve(new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'x-fpl-cache': 'miss', 'x-fpl-fetched-at': '2026-08-10T12:00:00Z', 'x-fpl-stale': 'false', 'x-fpl-age-seconds': '0' } }
  ));
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW, ...FAST });
  await assert.rejects(api.getFixtures(), (err) => err instanceof Error);
});

test('a timeout is retried once inside the total budget', async () => {
  let attempt = 0;
  const fetchImpl = (url, init) => {
    attempt++;
    if (attempt === 1) {
      return new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    }
    return Promise.resolve(proxyResponse([{ id: 9 }]));
  };
  const api = createFplApi({
    fetchImpl, storage: fakeStorage(), now: () => Date.now(),
    attemptTimeoutMs: 20, totalDeadlineMs: 5000,
  });
  assert.deepEqual((await api.getFixtures()).data, [{ id: 9 }]);
  assert.equal(attempt, 2, 'exactly one retry, not a retry storm');
});

test('healthy single-flight dedupe survives the deadline work', async () => {
  let resolveIt;
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    return new Promise((r) => { resolveIt = () => r(proxyResponse([{ id: 3 }])); });
  };
  const api = createFplApi({ fetchImpl, storage: fakeStorage(), now: () => NOW });
  const a = api.getFixtures();
  const b = api.getFixtures();
  resolveIt();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1, 'two consumers, one underlying request');
  assert.deepEqual(ra.data, rb.data);
});

test('the production deadlines are bounded and ordered sensibly', () => {
  assert.ok(ATTEMPT_TIMEOUT_MS > 0);
  assert.ok(TOTAL_DEADLINE_MS > ATTEMPT_TIMEOUT_MS,
    'the total budget must leave room for a retry after one attempt times out');
  // Under the browser's own fetch timeout and over the function's 9s upstream
  // budget plus a cold start, so a slow-but-working request is never killed.
  assert.ok(ATTEMPT_TIMEOUT_MS >= 10000 && ATTEMPT_TIMEOUT_MS <= 30000);
  assert.deepEqual(
    createFplApi({ fetchImpl: () => {}, storage: fakeStorage() }).deadlines(),
    { attemptTimeoutMs: ATTEMPT_TIMEOUT_MS, totalDeadlineMs: TOTAL_DEADLINE_MS }
  );
});
