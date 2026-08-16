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

function makeFakeCaches() {
    const stores = new Map(); // cacheName -> Map(url -> response)
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const caches = {
        keys: async () => [...stores.keys()],
        delete: async (n) => stores.delete(n),
        open: async (name) => {
            const store = storeFor(name);
            return {
                addAll: async (urls) => {
                    // Real addAll fetches each URL; here every fetch "succeeds"
                    // with a synthetic response so install can complete.
                    urls.forEach((u) => store.set(new URL(u, `${ORIGIN}/apps/gym-tracker/`).href, {
                        ok: true, body: `precached:${u}`, clone() { return this; },
                    }));
                },
                match: async (req) => store.get(typeof req === 'string' ? req : req.url),
                put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
            };
        },
        match: async () => undefined,
    };
    return { caches, stores, storeFor };
}

/** Load sw.js into a vm sandbox. `online` is a mutable switch for fetch. */
function loadWorker() {
    const { caches, stores, storeFor } = makeFakeCaches();
    const listeners = {};
    const state = { online: true };
    const sandbox = {
        self: {
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: async () => {},
            location: { origin: ORIGIN },
            clients: { claim: async () => {} },
        },
        caches,
        URL,
        fetch: async (req) => {
            if (!state.online) throw new TypeError('Failed to fetch (offline)');
            return { ok: true, body: `network:${typeof req === 'string' ? req : req.url}`, clone() { return this; } };
        },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: SW_PATH });
    return { listeners, stores, storeFor, state };
}

async function install(worker) {
    let work;
    worker.listeners.install({ waitUntil: (p) => { work = p; } });
    await work;
}

/** Drive the fetch handler for one GET and return what respondWith resolved. */
async function driveFetch(worker, url, { method = 'GET' } = {}) {
    let responded = false;
    let promise = null;
    worker.listeners.fetch({
        request: { method, url },
        respondWith: (p) => { responded = true; promise = p; },
    });
    return { responded, response: responded ? await promise : undefined };
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
