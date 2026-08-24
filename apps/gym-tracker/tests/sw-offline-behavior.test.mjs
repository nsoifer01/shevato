// Service-worker runtime behavior, driven in node:vm with a fake Cache
// Storage and controllable network (same approach as
// apps/trip-planner/tests/sw-activate.test.mjs, which owns the activate
// cleanup pins for both workers).
//
// What matters here: install must populate the precache, and the fetch
// handler must actually deliver offline - a cached response has to come back
// when fetch() rejects, including for precached-but-never-runtime-fetched
// URLs (audit defect 16, fixed 2026-08-15: the handler now falls back to the
// gym precache on a runtime miss; the final test is its regression).
process.env.TZ = 'UTC';

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SW_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sw.js');
const ORIGIN = 'https://shevato.com';

/**
 * Minimal Request: enough of the real one for the worker to construct
 * `new Request(req, { cache })` and for the fakes to read url/mode/cache.
 */
class FakeRequest {
    constructor(input, init = {}) {
        const base = typeof input === 'string' ? { url: input } : input;
        // Real behaviour, and the reason the worker needs a fallback: a
        // request whose mode is 'navigate' cannot be re-constructed with a
        // non-empty init. Getting this wrong rejected the whole fetch handler
        // for every navigation, so the fake has to be just as strict.
        if (typeof input !== 'string' && base.mode === 'navigate' && Object.keys(init).length) {
            throw new TypeError("Cannot construct a Request with a Request whose mode is 'navigate' and a non-empty RequestInit");
        }
        this.url = new URL(base.url, `${ORIGIN}/apps/gym-tracker/`).href;
        this.method = base.method || 'GET';
        this.mode = base.mode || 'cors';
        this.cache = init.cache || base.cache || 'default';
    }
}

const stripSearch = (href) => href.split('?')[0];

function makeFakeCaches() {
    const stores = new Map(); // cacheName -> Map(url -> response)
    const addAllRequests = [];
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const keyOf = (req) => (typeof req === 'string' ? new URL(req, `${ORIGIN}/apps/gym-tracker/`).href : req.url);
    const caches = {
        keys: async () => [...stores.keys()],
        delete: async (n) => stores.delete(n),
        open: async (name) => {
            const store = storeFor(name);
            return {
                addAll: async (reqs) => {
                    // Real addAll fetches each URL; here every fetch "succeeds"
                    // with a synthetic response so install can complete.
                    reqs.forEach((r) => {
                        addAllRequests.push(r);
                        const u = typeof r === 'string' ? r : r.url;
                        store.set(keyOf(r), { ok: true, body: `precached:${u}`, clone() { return this; } });
                    });
                },
                match: async (req, opts = {}) => {
                    const key = keyOf(req);
                    if (store.has(key)) return store.get(key);
                    if (opts.ignoreSearch) {
                        for (const [k, v] of store) if (stripSearch(k) === stripSearch(key)) return v;
                    }
                    return undefined;
                },
                put: async (req, res) => { store.set(keyOf(req), res); },
            };
        },
        match: async () => undefined,
    };
    return { caches, stores, storeFor, addAllRequests };
}

/** Load sw.js into a vm sandbox. `online` is a mutable switch for fetch. */
function loadWorker() {
    const { caches, stores, storeFor, addAllRequests } = makeFakeCaches();
    const listeners = {};
    const state = { online: true, fetches: [] };
    const sandbox = {
        self: {
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: async () => {},
            location: { origin: ORIGIN },
            clients: { claim: async () => {} },
        },
        caches,
        URL,
        Request: FakeRequest,
        fetch: async (req) => {
            state.fetches.push(req);
            if (!state.online) throw new TypeError('Failed to fetch (offline)');
            return { ok: true, body: `network:${typeof req === 'string' ? req : req.url}`, clone() { return this; } };
        },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: SW_PATH });
    return { listeners, stores, storeFor, state, addAllRequests };
}

async function install(worker) {
    let work;
    worker.listeners.install({ waitUntil: (p) => { work = p; } });
    await work;
}

/** Drive the fetch handler for one GET and return what respondWith resolved. */
async function driveFetch(worker, url, { method = 'GET', mode = 'cors' } = {}) {
    let responded = false;
    let promise = null;
    const extended = [];
    worker.listeners.fetch({
        request: { method, url, mode },
        respondWith: (p) => { responded = true; promise = p; },
        waitUntil: (p) => extended.push(p),
    });
    const response = responded ? await promise : undefined;
    await Promise.all(extended.map((p) => p.catch(() => {})));
    return { responded, response, extended };
}

const swSrc = fs.readFileSync(SW_PATH, 'utf8');
const PRECACHE_URLS = JSON.parse(
    /const PRECACHE_URLS = (\[[\s\S]*?\]);/.exec(swSrc)[1].replace(/'/g, '"').replace(/,\s*\]/, ']')
);
const CACHE_VERSION = /const CACHE_VERSION = '([^']+)'/.exec(swSrc)[1];
const PRECACHE_NAME = `gym-precache-${CACHE_VERSION}`;
const RUNTIME_NAME = `gym-runtime-${CACHE_VERSION}`;

test('install populates the precache with every PRECACHE_URLS entry', async () => {
    const worker = loadWorker();
    await install(worker);
    const store = worker.storeFor(PRECACHE_NAME);
    assert.equal(store.size, PRECACHE_URLS.length, 'one cached entry per precache URL');
    const appJsUrl = new URL('./js/app.js', `${ORIGIN}/apps/gym-tracker/`).href;
    assert.ok(store.get(appJsUrl), 'js/app.js landed in the precache');
});

test('online fetch of a NON-precached URL: network response served and stored in the runtime cache', async () => {
    const worker = loadWorker();
    await install(worker);
    // Deliberately not in PRECACHE_URLS, so the only source online is the network.
    const url = `${ORIGIN}/apps/gym-tracker/exercises/bench-press/index.html`;
    const { responded, response } = await driveFetch(worker, url);
    assert.equal(responded, true, 'same-origin GET is intercepted');
    assert.equal(response.body, `network:${url}`, 'network response returned');
    // The background cache.put is fire-and-forget; give the microtask a turn.
    await new Promise((r) => setImmediate(r));
    assert.ok(worker.storeFor(RUNTIME_NAME).get(url), 'response cached for next time');
});

test('online fetch of a precached URL: served instantly from the precache, refreshed into the runtime cache', async () => {
    // Since the precache-fallback fix (TESTING-AUDIT.md #16), "cached" in the
    // stale-while-revalidate strategy includes the app's own precache: a
    // precached URL is served from it even online (instant load), while the
    // background network refresh still lands in the RUNTIME cache.
    const worker = loadWorker();
    await install(worker);
    const url = `${ORIGIN}/apps/gym-tracker/js/views/workout-view.js`;
    const { responded, response } = await driveFetch(worker, url);
    assert.equal(responded, true, 'same-origin GET is intercepted');
    assert.match(String(response.body), /^precached:/, 'precached copy served without waiting on the network');
    await new Promise((r) => setImmediate(r));
    assert.ok(worker.storeFor(RUNTIME_NAME).get(url), 'background refresh stored for next time');
});

test('offline fetch: a runtime-cached URL is served from cache', async () => {
    const worker = loadWorker();
    await install(worker);
    const url = `${ORIGIN}/apps/gym-tracker/js/views/workout-view.js`;
    await driveFetch(worker, url); // warm the runtime cache online
    await new Promise((r) => setImmediate(r));
    worker.state.online = false;
    const { response } = await driveFetch(worker, url);
    assert.ok(response, 'a response is served offline');
    assert.equal(response.body, `network:${url}`, 'it is the previously cached copy');
});

test('non-GET requests are not intercepted', async () => {
    const worker = loadWorker();
    await install(worker);
    const { responded } = await driveFetch(worker, `${ORIGIN}/apps/gym-tracker/index.html`, { method: 'POST' });
    assert.equal(responded, false);
});

test('cross-origin requests (Firebase, fonts) are not intercepted', async () => {
    const worker = loadWorker();
    await install(worker);
    const { responded } = await driveFetch(worker, 'https://firestore.googleapis.com/v1/whatever');
    assert.equal(responded, false);
});

// Regression test for the 2026-08-15 audit defect (TESTING-AUDIT.md #16,
// resolved): the fetch handler used to open only the RUNTIME cache, so a
// first-visit-offline request for a precached URL got respondWith(undefined)
// and the install-time precache was dead weight. The handler now falls back
// to the gym precache on a runtime miss.
test(
    'offline fetch of a PRECACHED URL that was never runtime-fetched is served from the precache',
    async () => {
        const worker = loadWorker();
        await install(worker);
        worker.state.online = false;
        // Precached at install, but the page never fetched it while online in
        // this SW generation, so the RUNTIME cache has no copy.
        const url = new URL('./js/app.js', `${ORIGIN}/apps/gym-tracker/`).href;
        assert.ok(worker.storeFor(PRECACHE_NAME).get(url), 'sanity: the URL IS in the precache');
        const { response } = await driveFetch(worker, url);
        assert.ok(response, 'correct behavior: the precached copy must be served offline');
    }
);

// ---------------------------------------------------------------------------
// Freshness after a deploy (2026-08-22 audit D5). netlify.toml gives js/,
// css/ and data/ a max-age while HTML and sw.js are max-age=0, so with the
// default request cache mode the background refresh and the precache fill
// both came from the browser's HTTP cache: new index.html ran against old
// modules for up to five minutes after every deploy, and a CACHE_VERSION
// bump inside that window precached the stale modules under the new name.
// ---------------------------------------------------------------------------

test('the background refresh fetch bypasses the HTTP cache (cache: no-cache)', async () => {
    const worker = loadWorker();
    await install(worker);
    const url = `${ORIGIN}/apps/gym-tracker/js/app.js`;
    await driveFetch(worker, url);
    const req = worker.state.fetches.at(-1);
    assert.equal(req.url, url);
    assert.equal(req.cache, 'no-cache', 'the worker revalidates with the origin, never the HTTP cache');
});

test('the install-time precache fill bypasses the HTTP cache too', async () => {
    const worker = loadWorker();
    await install(worker);
    assert.equal(worker.addAllRequests.length, PRECACHE_URLS.length);
    assert.ok(worker.addAllRequests.every((r) => r.cache === 'no-cache'),
        'a CACHE_VERSION bump must precache what the server has NOW, not what the HTTP cache holds');
});

// 2026-08-22 audit D14: offline, `/?utm_source=x` fell to the browser error
// page (exact-URL match) and a generated /exercises/ page had no fallback.
test('offline navigation with a query string is served from the cached shell (ignoreSearch)', async () => {
    const worker = loadWorker();
    await install(worker);
    worker.state.online = false;
    const { response } = await driveFetch(worker, `${ORIGIN}/apps/gym-tracker/?utm_source=x`, { mode: 'navigate' });
    assert.ok(response, 'a response is served');
    assert.equal(response.body, `precached:${ORIGIN}/apps/gym-tracker/`, 'the precached shell answers the query-string variant');
});

test('offline navigation to a never-cached page gets the precached offline page, not undefined', async () => {
    const worker = loadWorker();
    await install(worker);
    worker.state.online = false;
    const { response } = await driveFetch(worker, `${ORIGIN}/apps/gym-tracker/exercises/barbell-bench-press/`, { mode: 'navigate' });
    assert.ok(response, 'a response is served');
    assert.match(String(response.body), /^precached:.*\/offline\/index\.html$/);
});

test('offline non-navigation miss still resolves to the cached value or nothing (no offline page for assets)', async () => {
    const worker = loadWorker();
    await install(worker);
    worker.state.online = false;
    const { response } = await driveFetch(worker, `${ORIGIN}/apps/gym-tracker/css/exercise-page.css`);
    assert.equal(response, undefined);
});

test('a navigation request is refreshed with no-cache too (the clone fallback)', async () => {
    // `new Request(navReq, init)` throws, so the worker rebuilds the request
    // from its URL. Before that fallback existed the throw rejected the whole
    // handler and every navigation fell through to a browser error page.
    const worker = loadWorker();
    await install(worker);
    const url = `${ORIGIN}/apps/gym-tracker/`;
    const { responded, response } = await driveFetch(worker, url, { mode: 'navigate' });
    assert.equal(responded, true);
    assert.ok(response, 'the navigation is answered, not rejected');
    const req = worker.state.fetches.at(-1);
    assert.equal(req.cache, 'no-cache', 'the rebuilt request still bypasses the HTTP cache');
    assert.equal(req.url, url);
});

test('the background refresh is held open with waitUntil so an idle worker cannot cancel it', async () => {
    // Without waitUntil the revalidation is cancelled whenever the worker is
    // terminated after respondWith settles, which is how a module stayed
    // stale for load after load even with a fresh cache mode (D5).
    const worker = loadWorker();
    await install(worker);
    const url = `${ORIGIN}/apps/gym-tracker/js/app.js`;
    const { extended, response } = await driveFetch(worker, url);
    assert.ok(response, 'the precached copy is served immediately');
    assert.equal(extended.length, 1, 'exactly one extend-lifetime promise: the refresh');
    assert.equal(worker.storeFor(RUNTIME_NAME).get(url).body, `network:${url}`,
        'and the refresh has landed in the runtime cache by the time it settles');
});
