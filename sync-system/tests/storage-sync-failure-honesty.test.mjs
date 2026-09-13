// Sync failure honesty (2026-09-12 audit S-3), against the REAL engine.
//
// The engine used to lose writes in four quiet ways, and the shared sync pill
// went on reading "Synced" over every one of them:
//
//   1. A retryable failure (network, `unavailable`) that outlasted the retry
//      ladder was dropped from the queue with nothing but a console line. The
//      key stayed dirty, so nothing ever re-sent it either.
//   2. `permission-denied` was treated as transient: three pointless resends
//      of a rules rejection, then the same silent drop.
//   3. An edit made inside the 500 ms debounce window before a sign-out, a
//      restart or a closed tab was persisted DIRTY, and on the next start
//      restoreRevisions put the dirty flag back and nothing re-enqueued it.
//   4. The queue is cleared before the network call, so the pill read
//      "Synced" while the only copy of the edit was still on the wire.
//
// What must hold now, and what each test below pins:
//
//   - retryable: keep the write (dirty and queued), stop retrying on a timer,
//     announce `syncWriteRejected` with `retryable: true`, and resend only on
//     a bounded trigger (online, tab visible, the next local change, the next
//     sync start), each of which runs at most one ladder;
//   - permanent: one attempt, `retryable: false`, keys stay dirty so the next
//     sync start tries once;
//   - `syncWriteRecovered` once every rejected key has actually landed;
//   - dirty keys restored on start are flushed after the first server
//     snapshot, and a write the cloud already accepted is never resent;
//   - pagehide / hidden flush a pending debounced edit immediately, and the
//     sign-out flush hands one over before auth goes away;
//   - status counts a flush in flight.
//
// Same loader hook and stubs as storage-sync-behavior.test.mjs: only the
// Firebase SDK URLs and firebase-config.js are replaced, everything else is
// the shipped module. The engine is a singleton, so every test uses its own
// namespace and stops what it started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashValue } from '../sync-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

register('./helpers/storage-sync-hook.mjs', import.meta.url, {
  data: {
    firestoreUrl: pathToFileURL(join(here, 'helpers', 'firestore-stub.mjs')).href,
    databaseUrl: pathToFileURL(join(here, 'helpers', 'firebase-database-stub.mjs')).href,
    firebaseConfigUrl: pathToFileURL(join(here, 'helpers', 'firebase-config-stub.mjs')).href
  }
});

// Recorded, not printed: raw stdout from timer callbacks can desync the
// node:test IPC stream (see the note in storage-sync-behavior.test.mjs).
const consoleLines = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => { consoleLines.push({ level, args }); };
}

if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail ?? null;
    }
  };
}

const backingStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (backingStore.has(k) ? backingStore.get(k) : null),
  setItem: (k, v) => { backingStore.set(k, String(v)); },
  removeItem: (k) => { backingStore.delete(k); }
};

const windowTarget = new EventTarget();
globalThis.window = {
  addEventListener: (...args) => windowTarget.addEventListener(...args),
  removeEventListener: (...args) => windowTarget.removeEventListener(...args),
  dispatchEvent: (ev) => windowTarget.dispatchEvent(ev),
  __shevatoSyncChannel: {
    tabId: 'honesty-tab', isLive: false, publish() {}, subscribe: () => () => {}, close() {}
  }
};

const documentListeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  }
};

function setVisibility(state) {
  globalThis.document.visibilityState = state;
  for (const fn of documentListeners.get('visibilitychange') || []) fn();
}

function fireWindow(type) {
  windowTarget.dispatchEvent(new Event(type));
}

// Everything the page can hear about sync health, in order.
const pageEvents = [];
for (const type of ['syncWriteRejected', 'syncWriteRecovered', 'syncConflict']) {
  windowTarget.addEventListener(type, (e) => pageEvents.push({ type, detail: e.detail }));
}

const { authFakes } = await import('./helpers/firebase-config-stub.mjs');
const { firestoreFakes } = await import('./helpers/firestore-stub.mjs');

const USER = { uid: 'uid-honest', getIdToken: async () => 'fake-token' };
authFakes().currentUser = USER;

const mod = await import('../storage-sync-robust.js');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const failWith = (code) => () => Promise.reject(Object.assign(new Error(`simulated ${code}`), { code }));

function activeListeners(namespace) {
  const path = `users/${USER.uid}/apps/${namespace}`;
  return firestoreFakes().snapshotListeners.filter((l) => l.path === path && l.active);
}

let nsCounter = 0;

/**
 * A real sync session on a fresh namespace, first server snapshot delivered.
 * `restart()` is a genuine stop + start (a sign-out and back in, or a reload
 * as far as the engine can tell); `reenter()` is the same-user re-entry that
 * initAppSync makes on every auth-state delivery.
 */
async function startHarness(t, shortKeys) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const namespace = `honestyNs${++nsCounter}`;
  const keys = shortKeys.map((k) => `${namespace}:${k}`);
  const docPath = `users/${USER.uid}/apps/${namespace}`;
  const setDocBase = firestoreFakes().setDocCalls.length;
  const eventBase = pageEvents.length;

  const session = { handle: null };
  const emit = (dataBody) => {
    const listeners = activeListeners(namespace);
    assert.ok(listeners.length > 0, 'no active snapshot listener to emit into');
    listeners[listeners.length - 1].onNext({ data: () => ({ data: dataBody }), metadata: { fromCache: false } });
  };
  const open = async (initial = {}) => {
    session.handle = mod.startStorageSync({ namespace, keys });
    await settle();
    emit(initial);
    await settle();
  };
  await open();
  t.after(() => { if (session.handle) session.handle.stop(); });

  return {
    namespace,
    keys,
    emit,
    stop: () => session.handle.stop(),
    restart: async (initial) => { session.handle.stop(); await open(initial); },
    reenter: () => mod.startStorageSync({ namespace, keys }),
    status: () => mod.getSyncStatus(namespace),
    rev: (key) => globalThis.window._debugSync.revisions()[key],
    // Writes to THIS namespace's document only (not chunk parts).
    writes: () => firestoreFakes().setDocCalls.slice(setDocBase).filter((c) => c.path === docPath),
    events: (type) => pageEvents.slice(eventBase).filter((e) => !type || e.type === type).map((e) => e.detail)
  };
}

/** Let a failing flush climb the whole ladder: the attempt plus three retries. */
async function exhaustLadder(t) {
  t.mock.timers.tick(500); await settle();    // debounced attempt
  t.mock.timers.tick(1000); await settle();   // retry 1
  t.mock.timers.tick(2000); await settle();   // retry 2
  t.mock.timers.tick(3000); await settle();   // retry 3, ladder exhausted
}

/** Push `n` failures of one code onto the setDoc responder queue. */
function failNext(n, code) {
  for (let i = 0; i < n; i++) firestoreFakes().setDocResponders.push(failWith(code));
}

/** Drop any responders a test left unconsumed, so they cannot leak forward. */
function clearResponders(t) {
  t.after(() => { firestoreFakes().setDocResponders.length = 0; });
}

// ---------------------------------------------------------------------------
// Retryable failures
// ---------------------------------------------------------------------------

test('retry exhaustion keeps the write: dirty, queued, announced as retryable, and nothing resends it on a timer', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['log']);
  const [k] = h.keys;

  failNext(4, 'unavailable');
  localStorage.setItem(k, JSON.stringify([{ id: 1 }, { id: 2 }]));
  await exhaustLadder(t);

  assert.equal(h.writes().length, 4, 'the attempt and three retries were made');
  const rejected = h.events('syncWriteRejected');
  assert.equal(rejected.length, 1, 'the page is told, once, when the ladder runs out');
  assert.equal(rejected[0].namespace, h.namespace);
  assert.deepEqual(rejected[0].keys, [k]);
  assert.equal(rejected[0].code, 'unavailable');
  assert.equal(rejected[0].retryable, true, 'a network failure can still land, and the page must know that');

  assert.equal(h.rev(k).dirty, true, 'the key is still unacknowledged local work');
  assert.equal(h.status().queueSize, 1, 'and the value is still queued, so it can be resent');
  assert.equal(mod.getGlobalSyncStatus().totalQueueSize >= 1, true, 'status does not claim everything is saved');

  // No self-restarting ladder: a minute of silence sends nothing.
  t.mock.timers.tick(60_000); await settle();
  assert.equal(h.writes().length, 4, 'exhaustion stops automatic retrying');
  assert.equal(h.events('syncWriteRejected').length, 1, 'and does not re-announce on its own');
});

test('the online event resends a parked write once, and the page hears that it recovered', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['online']);
  const [k] = h.keys;

  failNext(4, 'unavailable');
  localStorage.setItem(k, '"written offline"');
  await exhaustLadder(t);
  assert.equal(h.writes().length, 4);

  fireWindow('online');
  await settle();

  const writes = h.writes();
  assert.equal(writes.length, 5, 'coming back online sends the parked value');
  assert.equal(writes[4].payload.data[k].value, 'written offline');
  assert.equal(h.rev(k).dirty, false, 'the cloud accepted it, so the key is clean');
  assert.equal(h.status().queueSize, 0);
  assert.deepEqual(h.events('syncWriteRecovered'), [{ namespace: h.namespace }],
    'the namespace that was announced as failing is announced as recovered');

  fireWindow('online');
  await settle();
  assert.equal(h.writes().length, 5, 'a trigger with nothing parked sends nothing');
});

test('a trigger that fails again runs exactly one ladder, then parks again', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['again']);
  const [k] = h.keys;

  failNext(4, 'deadline-exceeded');
  localStorage.setItem(k, '"stubborn"');
  await exhaustLadder(t);
  assert.equal(h.writes().length, 4);

  // The tab comes back to the foreground while the backend is still down.
  failNext(4, 'deadline-exceeded');
  setVisibility('hidden');
  setVisibility('visible');
  await settle();
  assert.equal(h.writes().length, 5, 'becoming visible resends immediately');
  t.mock.timers.tick(1000); await settle();
  t.mock.timers.tick(2000); await settle();
  t.mock.timers.tick(3000); await settle();
  assert.equal(h.writes().length, 8, 'one trigger, one ladder: four attempts');

  t.mock.timers.tick(120_000); await settle();
  assert.equal(h.writes().length, 8, 'and then it parks again instead of looping');
  const rejected = h.events('syncWriteRejected');
  assert.equal(rejected.length, 2, 'each exhausted ladder is announced');
  assert.equal(rejected[1].retryable, true);
  assert.equal(h.rev(k).dirty, true);
  assert.equal(h.status().queueSize, 1);
  assert.equal(h.events('syncWriteRecovered').length, 0, 'nothing has recovered');
});

test('the next local change in the namespace carries a parked write with it', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['parked', 'other']);
  const [parked, other] = h.keys;

  failNext(4, 'unavailable');
  localStorage.setItem(parked, '"stuck"');
  await exhaustLadder(t);
  assert.equal(h.writes().length, 4);

  localStorage.setItem(other, '"a later edit"');
  t.mock.timers.tick(500); await settle();

  const writes = h.writes();
  assert.equal(writes.length, 5, 'one flush');
  assert.equal(writes[4].payload.data[parked].value, 'stuck', 'the parked value rides along');
  assert.equal(writes[4].payload.data[other].value, 'a later edit');
  assert.equal(h.rev(parked).dirty, false);
  assert.equal(h.events('syncWriteRecovered').length, 1);
});

test('a same-user sync re-entry resends a parked write', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['reenter']);
  const [k] = h.keys;

  failNext(4, 'internal');
  localStorage.setItem(k, '"waiting"');
  await exhaustLadder(t);
  assert.equal(h.writes().length, 4);

  h.reenter();
  await settle();
  assert.equal(h.writes().length, 5, 'the next sync start for this user resends it');
  assert.equal(h.writes()[4].payload.data[k].value, 'waiting');
  assert.equal(h.events('syncWriteRecovered').length, 1);
});

// ---------------------------------------------------------------------------
// Permanent failures
// ---------------------------------------------------------------------------

test('permission-denied is permanent: one attempt, announced as not retryable, and the key stays dirty', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['denied']);
  const [k] = h.keys;

  failNext(4, 'permission-denied');
  localStorage.setItem(k, '"secret"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 1, 'exactly one attempt');
  assert.equal(h.status().retryCount, 0, 'no retry ladder for a rules rejection');

  t.mock.timers.tick(60_000); await settle();
  fireWindow('online'); await settle();
  setVisibility('hidden'); setVisibility('visible'); await settle();
  assert.equal(h.writes().length, 1, 'and neither timers nor connectivity triggers resend it');

  const rejected = h.events('syncWriteRejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 'permission-denied');
  assert.equal(rejected[0].retryable, false);
  assert.deepEqual(rejected[0].keys, [k]);
  assert.equal(h.rev(k).dirty, true, 'not a silent drop: the key is still marked unsaved');
  assert.equal(backingStore.get(k), '"secret"', 'and the data is safe locally');
});

test('a permanently rejected key is tried once on the next sync start, and recovery waits for THAT key', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['blocked', 'fine']);
  const [blocked, fine] = h.keys;

  failNext(1, 'unauthenticated');
  localStorage.setItem(blocked, '"needs re-auth"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 1);
  assert.equal(h.events('syncWriteRejected')[0].retryable, false);

  // A different key landing is not evidence that the rejected one did.
  localStorage.setItem(fine, '"unrelated"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 2);
  assert.equal(Object.keys(h.writes()[1].payload.data).includes(blocked), false,
    'a permanent rejection is not resent on the next local change');
  assert.equal(h.events('syncWriteRecovered').length, 0,
    'recovery is not announced while the rejected key is still unsaved');

  // Signed back in: a fresh start for the same user. The cloud has `fine`.
  await h.restart({ [fine]: { value: 'unrelated', rev: 1, hash: hashValue('unrelated'), updatedAt: Date.now() } });
  t.mock.timers.tick(500); await settle();

  const retried = h.writes().slice(2).filter((c) => c.payload.data[blocked]);
  assert.equal(retried.length, 1, 'the dirty key is tried exactly once');
  assert.equal(retried[0].payload.data[blocked].value, 'needs re-auth');
  assert.equal(retried[0].payload.data[blocked].rev, 1, 'at the revision that never landed, not a new one');
  assert.equal(h.rev(blocked).dirty, false);
  assert.deepEqual(h.events('syncWriteRecovered'), [{ namespace: h.namespace }]);
});

// ---------------------------------------------------------------------------
// Dirty keys across a stop / start
// ---------------------------------------------------------------------------

test('an edit inside the debounce window survives a stop: restored dirty, re-enqueued, flushed after the first snapshot', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['prefs']);
  const [k] = h.keys;

  localStorage.setItem(k, '"v1"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 1, 'v1 landed, so v1 is the agreed state');

  localStorage.setItem(k, '"v2"');
  await settle();
  h.stop();                                  // signed out / navigated within 500 ms
  t.mock.timers.tick(5000); await settle();
  assert.equal(h.writes().length, 1, 'stopping does not write (the auth may already be gone)');

  // Same user, next start. The cloud still holds v1.
  await h.restart({ [k]: { value: 'v1', rev: 1, hash: hashValue('v1'), updatedAt: Date.now() } });
  t.mock.timers.tick(500); await settle();

  const writes = h.writes();
  assert.equal(writes.length, 2, 'the stranded edit is uploaded');
  assert.equal(writes[1].payload.data[k].value, 'v2');
  assert.equal(writes[1].payload.data[k].rev, 2);
  assert.equal(h.rev(k).dirty, false);
  assert.equal(backingStore.get(k), '"v2"', 'and the older cloud copy did not overwrite it');
});

// Changed 2026-09-13 (audit S-4). This used to be one test, "a value that
// changed after its dirty record is NOT uploaded on restart": ANY drift was
// held back, because nothing could tell a person's signed-out edit from an app
// saving its own default, and uploading a default could replace agreed cloud
// data. The engine now records, for each write no session owns, whether the
// page had seen a user gesture. So the two cases are two tests: a person's work
// goes up, an app's own rewrite gives way to the cloud.

/** Make the next writes look like an app's own boot writes: no user gesture yet. */
function withNoUserGesture(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userActivation: { hasBeenActive: false } }, configurable: true, writable: true
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });
}

test('signed-out work written over a stranded edit is uploaded as new work when the account signs back in', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['drift']);
  const [k] = h.keys;

  localStorage.setItem(k, '"v1"');
  t.mock.timers.tick(500); await settle();
  localStorage.setItem(k, '"v2"');
  await settle();
  h.stop();                                           // v2 is stranded, dirty
  localStorage.setItem(k, '"v3 made while signed out"'); // a person's edit, no session

  await h.restart({ [k]: { value: 'v1', rev: 1, hash: hashValue('v1'), updatedAt: Date.now() } });
  t.mock.timers.tick(5000); await settle();
  const writes = h.writes();
  assert.equal(writes.length, 2, 'v1, then the signed-out work');
  assert.equal(writes[1].payload.data[k].value, 'v3 made while signed out');
  assert.equal(writes[1].payload.data[k].rev, 3, 'a new revision above the stranded rev 2');
  assert.equal(h.rev(k).dirty, false);
});

test('an app rewriting its own value while signed out (no user gesture) is not uploaded, and the cloud replaces it', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['placeholder']);
  const [k] = h.keys;

  localStorage.setItem(k, '"v1"');
  t.mock.timers.tick(500); await settle();
  localStorage.setItem(k, '"v2"');
  await settle();
  h.stop();                                           // v2 stranded, dirty
  withNoUserGesture(t);
  localStorage.setItem(k, '"default the app wrote at boot"');

  await h.restart({ [k]: { value: 'v1', rev: 1, hash: hashValue('v1'), updatedAt: Date.now() } });
  t.mock.timers.tick(5000); await settle();
  assert.equal(h.writes().length, 1, 'only the original v1 write: the default is never uploaded');
  assert.equal(backingStore.get(k), 'v1', 'the account\'s value replaces the default');
  assert.equal(h.rev(k).dirty, false);
  assert.equal(h.events('syncConflict').length, 0, 'and nobody is told about a conflict that is not one');
});

test('a write the cloud already accepted is not resent after a restart', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['acked']);
  const [k] = h.keys;

  localStorage.setItem(k, '"landed"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 1);
  assert.equal(h.rev(k).dirty, false);

  await h.restart({ [k]: { value: 'landed', rev: 1, hash: hashValue('landed'), updatedAt: Date.now() } });
  t.mock.timers.tick(5000); await settle();
  assert.equal(h.writes().length, 1, 'no duplicate of a successful write');
});

test('a write acknowledged after the sync stopped is not resent after a restart', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['late']);
  const [k] = h.keys;

  const inFlight = makeDeferred();
  firestoreFakes().setDocResponders.push(() => inFlight.promise);
  localStorage.setItem(k, '"on the wire"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 1, 'in flight');

  h.stop();                     // persisted dirty: the ack has not arrived
  inFlight.resolve();           // ...and then it does
  await settle();

  await h.restart({ [k]: { value: 'on the wire', rev: 1, hash: hashValue('on the wire'), updatedAt: Date.now() } });
  t.mock.timers.tick(5000); await settle();
  assert.equal(h.writes().length, 1, 'the late acknowledgement is remembered, so nothing is sent twice');
  assert.equal(h.rev(k).dirty, false);
});

// ---------------------------------------------------------------------------
// Last-second edits
// ---------------------------------------------------------------------------

test('pagehide flushes a debounced edit immediately', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['closing']);
  const [k] = h.keys;

  localStorage.setItem(k, '"typed then closed"');
  fireWindow('pagehide');
  await settle();

  const writes = h.writes();
  assert.equal(writes.length, 1, 'no waiting out the debounce: the page is going away');
  assert.equal(writes[0].payload.data[k].value, 'typed then closed');

  t.mock.timers.tick(5000); await settle();
  assert.equal(h.writes().length, 1, 'and the cancelled debounce does not send it again');
  assert.equal(h.events('syncWriteRecovered').length, 0, 'nothing failed, so nothing recovers');
});

test('hiding the tab flushes a debounced edit immediately, but does not resend a parked write', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['hidden', 'stuck']);
  const [k, stuck] = h.keys;

  failNext(4, 'unavailable');
  localStorage.setItem(stuck, '"parked"');
  await exhaustLadder(t);
  assert.equal(h.writes().length, 4);

  setVisibility('hidden');
  await settle();
  assert.equal(h.writes().length, 4, 'hidden is not a resend trigger for a parked write');

  localStorage.setItem(k, '"switched apps"');
  setVisibility('hidden');
  await settle();
  const writes = h.writes();
  assert.equal(writes.length, 5, 'a pending edit goes out the moment the tab is hidden');
  assert.equal(writes[4].payload.data[k].value, 'switched apps');
  setVisibility('visible');
});

test('the sign-out flush sends a pending edit and settles only when the cloud answers', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['signout']);
  const [k] = h.keys;

  assert.equal(typeof globalThis.window.__shevatoFlushSync, 'function',
    'firebase-config.js calls this before auth.signOut()');

  const answer = makeDeferred();
  firestoreFakes().setDocResponders.push(() => answer.promise);
  localStorage.setItem(k, '"last edit before sign out"');

  let settled = false;
  globalThis.window.__shevatoFlushSync().then(() => { settled = true; });
  await settle();
  assert.equal(h.writes().length, 1, 'the debounced edit is sent at once');
  assert.equal(h.writes()[0].payload.data[k].value, 'last edit before sign out');
  assert.equal(settled, false, 'sign-out waits while the write is on the wire');

  answer.resolve();
  await settle();
  assert.equal(settled, true);
  assert.equal(h.rev(k).dirty, false);
});

// ---------------------------------------------------------------------------
// Status while a flush is in flight (audit P3 F9)
// ---------------------------------------------------------------------------

test('status counts a flush in flight, so the pill cannot read Synced before the server accepts', async (t) => {
  clearResponders(t);
  const h = await startHarness(t, ['flight']);
  const [k] = h.keys;
  const before = mod.getGlobalSyncStatus().totalQueueSize;

  const answer = makeDeferred();
  firestoreFakes().setDocResponders.push(() => answer.promise);
  localStorage.setItem(k, '"typed"');
  t.mock.timers.tick(500); await settle();
  assert.equal(h.writes().length, 1, 'setDoc is in flight');
  assert.equal(h.status().queueSize, 0, 'the queue itself is empty during the flight');
  assert.equal(mod.getGlobalSyncStatus().totalQueueSize - before, 1,
    'but the global status still reports the unsaved write');

  answer.resolve();
  await settle();
  assert.equal(mod.getGlobalSyncStatus().totalQueueSize - before, 0, 'and clears once it is accepted');
});
