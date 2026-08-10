// Service-worker activate cleanup, for BOTH shipped service workers.
//
// Every app on shevato.com shares one origin, so caches.keys() inside any one
// service worker also lists every OTHER app's caches. A cleanup written as
// "delete everything I am not keeping" therefore wiped a sibling app's offline
// shell on activate: opening gym-tracker destroyed trip-planner's offline copy
// and vice versa. Both workers must scope their deletes to their own cache-name
// prefix, so this test lives in one place and covers both files.
//
// sw.js is a classic script full of self.addEventListener, so it is loaded into
// a node:vm context with Cache Storage and the clients API stubbed (same
// approach as apps/mario-kart/tests/).

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRIP_SW = path.join(HERE, '..', 'sw.js');
const GYM_SW = path.join(HERE, '..', '..', 'gym-tracker', 'sw.js');

// The current cache names are derived from each file's own CACHE_VERSION so a
// routine version bump does not have to touch this test.
function cacheNames(swPath, prefix) {
  const src = fs.readFileSync(swPath, 'utf8');
  const m = /const CACHE_VERSION = '([^']+)'/.exec(src);
  assert.ok(m, `${swPath}: CACHE_VERSION not found`);
  return { precache: `${prefix}-precache-${m[1]}`, runtime: `${prefix}-runtime-${m[1]}` };
}

// Fires one sw.js activate handler against a stubbed origin holding
// `existing` caches. Returns what it deleted and what it told open tabs.
async function activate(swPath, existing) {
  const deleted = [];
  const posted = [];
  const listeners = {};
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => {},
      location: { origin: 'https://shevato.com' },
      clients: {
        claim: async () => {},
        matchAll: async () => [{ postMessage: (msg) => posted.push(msg) }],
      },
    },
    caches: {
      keys: async () => existing.slice(),
      delete: async (n) => { deleted.push(n); return true; },
      open: async () => ({ add: async () => {}, addAll: async () => {}, match: async () => null, put: async () => {} }),
      match: async () => null,
    },
    URL,
    Response: { error: () => ({}) },
    fetch: async () => ({ ok: false }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(swPath, 'utf8'), sandbox, { filename: swPath });

  assert.ok(listeners.activate, `${swPath}: no activate listener registered`);
  let work;
  listeners.activate({ waitUntil: (p) => { work = p; } });
  await work;
  // postMessage payloads are born in the vm realm, so expose plain field values
  return { deleted, postedTypes: posted.map((m) => m.type) };
}

const TRIP = cacheNames(TRIP_SW, 'trip');
const GYM = cacheNames(GYM_SW, 'gym');

const STALE_TRIP = ['trip-precache-0.0.1-old', 'trip-runtime-0.0.1-old'];
const STALE_GYM = ['gym-precache-0.0.1-old', 'gym-runtime-0.0.1-old'];

test('trip-planner activate deletes its own stale caches', async () => {
  const { deleted } = await activate(TRIP_SW, [TRIP.precache, TRIP.runtime, ...STALE_TRIP]);
  assert.deepEqual(deleted.sort(), [...STALE_TRIP].sort());
});

test('trip-planner activate leaves gym-tracker caches alone (shared origin)', async () => {
  const { deleted } = await activate(TRIP_SW, [
    TRIP.precache, TRIP.runtime, ...STALE_TRIP, GYM.precache, GYM.runtime,
  ]);
  assert.ok(!deleted.includes(GYM.precache), 'wiped gym-tracker precache');
  assert.ok(!deleted.includes(GYM.runtime), 'wiped gym-tracker runtime');
  assert.deepEqual(deleted.sort(), [...STALE_TRIP].sort());
});

test('trip-planner activate keeps its own current caches', async () => {
  const { deleted } = await activate(TRIP_SW, [TRIP.precache, TRIP.runtime, ...STALE_TRIP]);
  assert.ok(!deleted.includes(TRIP.precache));
  assert.ok(!deleted.includes(TRIP.runtime));
});

test('trip-planner tells open tabs when it replaced a previous install of itself', async () => {
  const { postedTypes } = await activate(TRIP_SW, [TRIP.precache, TRIP.runtime, ...STALE_TRIP]);
  assert.deepEqual(postedTypes, ['tp-update-available']);
});

test('trip-planner stays silent on first install, even with a foreign cache present', async () => {
  // A gym-tracker cache is not evidence that trip-planner ran here before, so
  // it must not trigger the "new version took over, reload?" offer.
  const { deleted, postedTypes } = await activate(TRIP_SW, [
    TRIP.precache, TRIP.runtime, GYM.precache,
  ]);
  assert.deepEqual(postedTypes, []);
  assert.deepEqual(deleted, []);
});

test('gym-tracker activate deletes its own stale caches', async () => {
  const { deleted } = await activate(GYM_SW, [GYM.precache, GYM.runtime, ...STALE_GYM]);
  assert.deepEqual(deleted.sort(), [...STALE_GYM].sort());
});

test('gym-tracker activate leaves trip-planner caches alone (shared origin)', async () => {
  const { deleted } = await activate(GYM_SW, [
    GYM.precache, GYM.runtime, ...STALE_GYM, TRIP.precache, TRIP.runtime,
  ]);
  assert.ok(!deleted.includes(TRIP.precache), 'wiped trip-planner precache');
  assert.ok(!deleted.includes(TRIP.runtime), 'wiped trip-planner runtime');
  assert.deepEqual(deleted.sort(), [...STALE_GYM].sort());
});

test('gym-tracker activate keeps its own current caches', async () => {
  const { deleted } = await activate(GYM_SW, [GYM.precache, GYM.runtime, ...STALE_GYM]);
  assert.ok(!deleted.includes(GYM.precache));
  assert.ok(!deleted.includes(GYM.runtime));
});
