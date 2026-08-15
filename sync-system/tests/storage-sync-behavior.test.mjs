// Behavioral harness for sync-system/storage-sync-robust.js - the REAL
// engine, executed under node:test.
//
// The engine guards every app's user data (localStorage <-> Firestore), and
// until now it was protected only by regex source-shape assertions
// (storage-sync-shape.test.mjs) plus unit tests of the pure helpers. This
// file runs the shipped module itself: the module-resolution hook
// (helpers/storage-sync-hook.mjs) redirects only the Firebase SDK URLs and
// firebase-config.js to in-memory stubs, exactly the pattern
// account-deletion.test.mjs established. sync-helpers.mjs and
// cross-tab-channel.mjs load for real.
//
// Covered at behavior level:
//   1. Write path: local setItem enqueues; the 500 ms debounced flush batches
//      multiple keys into ONE setDoc; only keys registered to a namespace are
//      written; payload is the surgical merge:true shape with serverTimestamp
//      sentinels; a hash-identical rewrite is dropped (no-op skip).
//   2. Retry: a failing flush requeues WITHOUT clobbering a newer write made
//      while the flush was in flight (the engine must pass the live queue and
//      the failed batch to requeueFailedWrites in that order).
//   3. Remote apply: an incoming snapshot flows through decideRemoteChange
//      and the verdict is applied to localStorage - newer-ts applies, stale
//      and older-than-local skip, hash-dedupe skips without touching storage.
//   4. Per-key drift reconcile on visibilitychange.
//   5. Initial-merge gating on !snapshot.metadata.fromCache.
//   6. MAX_FLUSH_BYTES oversize rejection (no setDoc ever issued; requeued
//      through the retry ladder; dropped from the queue after max retries).
//   7. stopSync cleanup (timer cancelled, listener detached, revisions
//      cleared) and getSyncStatus().queueSize accuracy throughout.
//   8. Listener error recovery: permission-denied tears the old listener down
//      before reattaching (no stacking), and abandons if the user changed.
//   9. Delayed start when auth has no current user yet.
//
// Deliberately NOT covered here, and why:
//   - The Realtime Database path (initRealtimeDbSync / flushToRealtimeDb).
//     Reachable via useFirestore:false, but production pins USE_FIRESTORE =
//     true and no caller passes false; the RTDB stub is inert.
//   - setCloudItem / eraseCloudData / eraseAccountProfile /
//     eraseRivalNetworkIdentity: exercised by account-deletion.test.mjs at
//     the orchestration level; re-testing them here would duplicate it.
//   - sync-loading-modal.js: pure DOM (createElement/innerHTML/querySelector),
//     needs a real document; out of scope for a node-only harness.
//
// The engine is a module-level singleton, so all tests share one manager.
// Isolation comes from per-test namespaces and per-test key names, plus
// stop() cleanup registered via t.after.

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

// ---------------------------------------------------------------------------
// Browser globals the engine touches at import time. Must exist BEFORE the
// dynamic import below.
// ---------------------------------------------------------------------------

// Mute console before the engine loads. The engine logs status lines (retry
// ladders, flush failures) from timer callbacks; under `node --test` that raw
// stdout interleaves with the runner's serialized IPC stream and can desync
// it, surfacing as a flaky "Unable to deserialize cloned data" uncaught
// exception (nodejs/node#48948 class). Messages are recorded, not discarded,
// so a future test can still assert on them.
export const consoleLines = [];
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

// Fake localStorage over a Map. The engine replaces setItem/removeItem with
// its override at construction; backingStore lets tests write "behind its
// back" to simulate drift (a peer tab's native storage write).
const backingStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (backingStore.has(k) ? backingStore.get(k) : null),
  setItem: (k, v) => { backingStore.set(k, String(v)); },
  removeItem: (k) => { backingStore.delete(k); }
};

const windowTarget = new EventTarget();
const channelPublishes = [];
const fakeChannel = {
  tabId: 'test-tab',
  isLive: false,
  publish: (type, payload) => channelPublishes.push({ type, payload }),
  subscribe: () => () => {},
  close: () => {}
};

globalThis.window = {
  addEventListener: (...args) => windowTarget.addEventListener(...args),
  removeEventListener: (...args) => windowTarget.removeEventListener(...args),
  dispatchEvent: (ev) => windowTarget.dispatchEvent(ev),
  __shevatoSyncChannel: fakeChannel
};

const documentListeners = new Map();
globalThis.document = {
  visibilityState: 'hidden',
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  }
};

// Record every localStorageSync event the engine dispatches to apps.
const syncEvents = [];
windowTarget.addEventListener('localStorageSync', (e) => syncEvents.push(e.detail));

const { authFakes } = await import('./helpers/firebase-config-stub.mjs');
const { firestoreFakes, isServerTimestampSentinel, isDeleteSentinel } =
  await import('./helpers/firestore-stub.mjs');

const USER = { uid: 'uid-1', getIdToken: async () => 'fake-token' };
authFakes().currentUser = USER;

const mod = await import('../storage-sync-robust.js');

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

// Drain microtasks plus one macrotask turn. setImmediate stays REAL because
// mock timers are enabled for setTimeout only.
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function activeListeners(namespace) {
  const path = `users/${USER.uid}/apps/${namespace}`;
  return firestoreFakes().snapshotListeners.filter((l) => l.path === path && l.active);
}

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let nsCounter = 0;

/**
 * Start a real sync session for a fresh namespace. Enables mocked setTimeout
 * (Date stays real), waits for the onSnapshot attach, optionally emits the
 * first server-confirmed snapshot, and returns scoped views over the shared
 * recorders so each test only sees its own traffic.
 */
async function startHarness(t, shortKeys, { emitInitial = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const namespace = `behaviorNs${++nsCounter}`;
  const keys = shortKeys.map((k) => `${namespace}:${k}`);

  const handle = mod.startStorageSync({ namespace, keys });
  await settle();
  assert.equal(activeListeners(namespace).length, 1, 'onSnapshot must attach exactly once');

  const emit = (dataBody, { fromCache = false } = {}) => {
    const listeners = activeListeners(namespace);
    assert.ok(listeners.length > 0, 'no active snapshot listener to emit into');
    listeners[listeners.length - 1].onNext({
      data: () => ({ data: dataBody }),
      metadata: { fromCache }
    });
  };

  if (emitInitial) {
    emit({}, { fromCache: false });
    await settle();
  }

  const setDocBase = firestoreFakes().setDocCalls.length;
  const eventBase = syncEvents.length;
  const publishBase = channelPublishes.length;

  t.after(() => { handle.stop(); });

  return {
    namespace,
    keys,
    handle,
    emit,
    status: () => mod.getSyncStatus(namespace),
    setDocCalls: () => firestoreFakes().setDocCalls.slice(setDocBase),
    events: () => syncEvents.slice(eventBase),
    publishes: () => channelPublishes.slice(publishBase)
  };
}

// ---------------------------------------------------------------------------
// 1. Write path
// ---------------------------------------------------------------------------

test('debounced flush batches multiple keys into one surgical merge:true write', async (t) => {
  const h = await startHarness(t, ['a', 'b']);
  const [kA, kB] = h.keys;

  localStorage.setItem(kA, JSON.stringify({ sets: [1, 2] }));
  localStorage.setItem(kB, 'plain-string');
  localStorage.setItem('behavior-unregistered-key', 'never-synced');

  assert.equal(h.status().queueSize, 2, 'both owned keys queued; unregistered key ignored');

  t.mock.timers.tick(499);
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'nothing flushes before the 500 ms debounce');

  t.mock.timers.tick(1);
  await settle();

  const calls = h.setDocCalls();
  assert.equal(calls.length, 1, 'both keys must batch into a single setDoc');
  const call = calls[0];
  assert.equal(call.path, `users/uid-1/apps/${h.namespace}`);
  assert.deepEqual(call.options, { merge: true }, 'surgical write must use merge:true');

  assert.deepEqual(Object.keys(call.payload.data).sort(), [kA, kB].sort(),
    'payload carries exactly the owned keys that changed');
  const entryA = call.payload.data[kA];
  assert.deepEqual(entryA.value, { sets: [1, 2] });
  assert.equal(entryA.rev, 1);
  assert.equal(entryA.hash, hashValue({ sets: [1, 2] }));
  assert.ok(isServerTimestampSentinel(entryA.updatedAt), 'updatedAt must be the serverTimestamp sentinel');
  assert.equal(call.payload.data[kB].value, 'plain-string');
  assert.ok(isServerTimestampSentinel(call.payload.meta.lastUpdated));

  assert.equal(h.status().queueSize, 0, 'queue drains after a successful flush');

  const dataUpdated = h.publishes().filter((p) => p.type === 'data-updated');
  assert.equal(dataUpdated.length, 1, 'peer tabs are notified once per flush');
  assert.equal(dataUpdated[0].payload.namespace, h.namespace);
  assert.deepEqual(dataUpdated[0].payload.keys.sort(), [kA, kB].sort());
});

test('a fresh write resets the debounce timer so a burst becomes one flush', async (t) => {
  const h = await startHarness(t, ['a', 'b']);
  const [kA, kB] = h.keys;

  localStorage.setItem(kA, '"first"');
  t.mock.timers.tick(300);
  localStorage.setItem(kB, '"second"');
  t.mock.timers.tick(300); // 600 ms after the FIRST write, 300 after the second
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'timer must reset on the second write');

  t.mock.timers.tick(200);
  await settle();
  assert.equal(h.setDocCalls().length, 1);
  assert.deepEqual(Object.keys(h.setDocCalls()[0].payload.data).sort(), [kA, kB].sort());
});

test('removeItem flushes as a deleteField sentinel', async (t) => {
  const h = await startHarness(t, ['gone']);
  const [k] = h.keys;

  localStorage.setItem(k, '"exists"');
  t.mock.timers.tick(500);
  await settle();

  localStorage.removeItem(k);
  t.mock.timers.tick(500);
  await settle();

  const calls = h.setDocCalls();
  assert.equal(calls.length, 2);
  assert.ok(isDeleteSentinel(calls[1].payload.data[k]),
    'a removed key must ship as deleteField(), not as a value');
});

test('rewriting the same value is dropped as a no-op (writeback loop guard)', async (t) => {
  const h = await startHarness(t, ['same']);
  const [k] = h.keys;

  localStorage.setItem(k, '{"a":1,"b":2}');
  localStorage.setItem(k, '{"a":1,"b":2}');
  assert.equal(h.status().queueSize, 1, 'identical rewrite must not enqueue again');

  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.setDocCalls().length, 1);
  assert.equal(h.setDocCalls()[0].payload.data[k].rev, 1, 'no phantom rev bump');

  // Key-order-insensitive: what a re-render writes back after a remote apply.
  localStorage.setItem(k, '{"b":2,"a":1}');
  assert.equal(h.status().queueSize, 0, 'content-identical writeback must be skipped');
  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.setDocCalls().length, 1, 'no second flush for a no-op rewrite');
});

// ---------------------------------------------------------------------------
// 2. Retry without clobbering newer work
// ---------------------------------------------------------------------------

test('a failed flush requeues without clobbering a newer write made in flight', async (t) => {
  const h = await startHarness(t, ['doc']);
  const [k] = h.keys;

  const deferred = makeDeferred();
  firestoreFakes().setDocResponders.push(() => deferred.promise);

  localStorage.setItem(k, '"v1"');
  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.setDocCalls().length, 1, 'first flush is in flight');
  assert.equal(h.status().queueSize, 0, 'queue was copied and cleared for the flight');

  // The user keeps editing while the flush is stuck on the network.
  localStorage.setItem(k, '"v2"');
  assert.equal(h.status().queueSize, 1, 'newer write lands in the emptied queue');

  deferred.reject(new Error('simulated network failure'));
  await settle();

  // requeueFailedWrites must keep rev 2, not restore the failed rev 1 copy.
  assert.equal(h.status().queueSize, 1);
  assert.equal(h.status().retryCount, 1, 'engine entered the retry ladder');

  // The v2 debounce timer fires first (500 ms after the v2 write).
  t.mock.timers.tick(500);
  await settle();
  const calls = h.setDocCalls();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.data[k].value, 'v2',
    'the NEWER value must be what reaches Firestore after the failure');
  assert.equal(calls[1].payload.data[k].rev, 2);
  assert.equal(h.status().retryCount, 0, 'retry counter resets on success');

  // The scheduled retry finds an empty queue and must not double-write.
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(h.setDocCalls().length, 2, 'the pending retry is a no-op on an empty queue');
  assert.equal(h.status().queueSize, 0);
});

// ---------------------------------------------------------------------------
// 3. Remote apply through decideRemoteChange
// ---------------------------------------------------------------------------

test('a newer remote change is applied to localStorage and announced to the app', async (t) => {
  const h = await startHarness(t, ['inbox']);
  const [k] = h.keys;
  const ts = Date.now() - 10_000;

  h.emit({ [k]: { value: { x: 1 }, rev: 3, updatedAt: ts, hash: hashValue({ x: 1 }) } });

  assert.equal(backingStore.get(k), JSON.stringify({ x: 1 }),
    'remote object must land in localStorage as JSON');
  const events = h.events();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { key: k, value: { x: 1 }, source: 'remote' });
  assert.equal(globalThis.window._debugSync.revisions()[k].rev, 3,
    'local revision adopts the remote rev');

  // Firestore re-emits the same body on listener reattach: skip-stale.
  h.emit({ [k]: { value: { x: 1 }, rev: 3, updatedAt: ts, hash: hashValue({ x: 1 }) } });
  assert.equal(h.events().length, 1, 're-emitted identical snapshot must not re-fire the app');

  // And the apply must never echo back into the write queue.
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'a remote apply must not trigger an outbound write');
});

test('a remote change older than the local copy is skipped', async (t) => {
  const h = await startHarness(t, ['keep']);
  const [k] = h.keys;

  localStorage.setItem(k, '"local-latest"');
  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.setDocCalls().length, 1);

  h.emit({ [k]: { value: 'remote-old', rev: 9, updatedAt: Date.now() - 5000, hash: hashValue('remote-old') } });

  assert.equal(backingStore.get(k), '"local-latest"', 'older remote must not overwrite newer local');
  assert.ok(!h.events().some((e) => e.value === 'remote-old'), 'no app event for a skipped change');
});

test('a hash-identical remote is deduped: no write, no event, but timestamp recorded', async (t) => {
  const h = await startHarness(t, ['dedupe']);
  const [k] = h.keys;
  const value = { list: [1, 2, 3] };

  localStorage.setItem(k, JSON.stringify(value));
  t.mock.timers.tick(500);
  await settle();
  const eventsAfterFlush = h.events().length;

  // Same content coming back from the server, with a newer timestamp.
  const echoTs = Date.now() + 5000;
  h.emit({ [k]: { value, rev: 2, updatedAt: echoTs, hash: hashValue(value) } });
  assert.equal(h.events().length, eventsAfterFlush, 'deduped remote must not re-fire the app');
  assert.equal(globalThis.window._debugSync.revisions()[k].rev, 1,
    'dedupe must not adopt the remote revision');

  // The dedupe recorded lastRemoteUpdate, so an older follow-up is now stale.
  h.emit({ [k]: { value: 'sneaky', rev: 5, updatedAt: echoTs - 1000, hash: hashValue('sneaky') } });
  assert.equal(backingStore.get(k), JSON.stringify(value), 'stale follow-up must be ignored');

  // A genuinely newer different value still applies.
  h.emit({ [k]: { value: 'fresh', rev: 6, updatedAt: echoTs + 1000, hash: hashValue('fresh') } });
  assert.equal(backingStore.get(k), 'fresh');
  assert.equal(h.events().at(-1).value, 'fresh');
});

test('snapshot keys outside the registered set are ignored', async (t) => {
  const h = await startHarness(t, ['mine']);

  h.emit({ 'someone-elses-key': { value: 'x', rev: 1, updatedAt: Date.now(), hash: hashValue('x') } });

  assert.equal(backingStore.has('someone-elses-key'), false);
  assert.equal(h.events().length, 0);
});

test('a remote deletion removes the key from localStorage', async (t) => {
  const h = await startHarness(t, ['del']);
  const [k] = h.keys;

  h.emit({ [k]: { value: 'here', rev: 1, updatedAt: Date.now() - 2000, hash: hashValue('here') } });
  assert.equal(backingStore.get(k), 'here');

  h.emit({ [k]: { deleted: true, rev: 2, updatedAt: Date.now() - 1000 } });
  assert.equal(backingStore.has(k), false, 'deleted remote entry must remove the local key');
  assert.equal(h.events().at(-1).key, k);
});

// ---------------------------------------------------------------------------
// 4. Drift reconcile on visibilitychange
// ---------------------------------------------------------------------------

function fireVisibilityChange() {
  for (const fn of documentListeners.get('visibilitychange') || []) fn();
}

test('returning to a visible tab reconciles drifted keys via localStorageSync', async (t) => {
  const h = await startHarness(t, ['drift']);
  const [k] = h.keys;

  // A peer tab wrote through native storage while we were backgrounded:
  // the value changed on disk but no override or snapshot told us.
  backingStore.set(k, '{"from":"peer-tab"}');

  globalThis.document.visibilityState = 'hidden';
  fireVisibilityChange();
  assert.equal(h.events().length, 0, 'hidden tabs must not reconcile');

  globalThis.document.visibilityState = 'visible';
  fireVisibilityChange();
  const events = h.events();
  assert.equal(events.length, 1, 'drifted key fires exactly one event');
  assert.deepEqual(events[0], { key: k, value: { from: 'peer-tab' }, source: 'remote' });

  fireVisibilityChange();
  assert.equal(h.events().length, 1, 'no duplicate event once the hash is recorded');

  backingStore.set(k, '{"from":"peer-tab-2"}');
  fireVisibilityChange();
  assert.equal(h.events().length, 2, 'fresh drift reconciles again');
  assert.deepEqual(h.events()[1].value, { from: 'peer-tab-2' });

  globalThis.document.visibilityState = 'hidden';
});

// ---------------------------------------------------------------------------
// 5. Initial-merge gating on !fromCache
// ---------------------------------------------------------------------------

test('local-only keys upload once, only after a server-confirmed snapshot', async (t) => {
  nsCounter++; // reserve the namespace id before seeding keys
  const namespace = `behaviorNs${nsCounter}`;
  const kLocal = `${namespace}:local-only`;
  const kBoth = `${namespace}:both-sides`;
  backingStore.set(kLocal, '{"mine":true}');
  backingStore.set(kBoth, '"local-version"');
  nsCounter--; // startHarness re-increments to the same id

  const h = await startHarness(t, ['local-only', 'both-sides'], { emitInitial: false });

  // First snapshot from the IndexedDB cache: an empty/stale local view.
  // Uploading against it would overwrite what another browser already wrote.
  h.emit({}, { fromCache: true });
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'cached snapshot must NOT trigger the initial merge');

  // Server-confirmed snapshot: remote owns kBoth, has never seen kLocal.
  const remoteTs = Date.now() + 1000;
  h.emit(
    { [kBoth]: { value: 'remote-version', rev: 4, updatedAt: remoteTs, hash: hashValue('remote-version') } },
    { fromCache: false }
  );
  await settle();

  const calls = h.setDocCalls();
  assert.equal(calls.length, 1, 'initial merge uploads exactly once');
  assert.deepEqual(Object.keys(calls[0].payload.data), [kLocal],
    'only the local-only key uploads; the contested key is left to applyRemoteChange');
  assert.deepEqual(calls[0].payload.data[kLocal].value, { mine: true });
  assert.equal(backingStore.get(kBoth), 'remote-version', 'remote wins the contested key on initial merge');

  // A later server snapshot must not re-run the merge.
  h.emit({}, { fromCache: false });
  await settle();
  assert.equal(h.setDocCalls().length, 1, 'initial merge is one-shot per session');
});

// ---------------------------------------------------------------------------
// 6. MAX_FLUSH_BYTES oversize rejection
// ---------------------------------------------------------------------------

test('an oversize payload is refused before setDoc and retried, then dropped from the queue', async (t) => {
  const h = await startHarness(t, ['huge']);
  const [k] = h.keys;

  // 800 KB > the 700 KB MAX_FLUSH_BYTES guard.
  localStorage.setItem(k, JSON.stringify('x'.repeat(800 * 1024)));

  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'the guard must throw BEFORE setDoc is called');
  assert.equal(h.status().queueSize, 1, 'the refused batch is requeued');
  assert.equal(h.status().retryCount, 1);

  // Retry ladder: 1000, 2000, 3000 ms. Oversize is deterministic, so every
  // retry refuses again.
  for (const [delay, expectedRetry] of [[1000, 2], [2000, 3]]) {
    t.mock.timers.tick(delay);
    await settle();
    assert.equal(h.setDocCalls().length, 0);
    assert.equal(h.status().retryCount, expectedRetry);
    assert.equal(h.status().queueSize, 1);
  }

  // Final attempt exhausts MAX_RETRY_ATTEMPTS: the engine gives up and the
  // batch is NOT requeued. The data itself is still safe in localStorage;
  // it just stops being pushed to the cloud until the next local write.
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'an oversize payload must never reach Firestore');
  assert.equal(h.status().retryCount, 0, 'counter resets after giving up');
  assert.equal(h.status().queueSize, 0, 'exhausted batch leaves the queue');
});

// ---------------------------------------------------------------------------
// 7. stopSync cleanup and status accuracy
// ---------------------------------------------------------------------------

test('stopSync cancels the pending flush, detaches the listener and clears bookkeeping', async (t) => {
  const h = await startHarness(t, ['s1', 's2']);
  const [k1, k2] = h.keys;

  localStorage.setItem(k1, '"pending"');
  assert.equal(h.status().queueSize, 1);
  assert.equal(h.status().active, true);
  assert.equal(h.status().keyCount, 2);

  h.handle.stop();

  assert.equal(mod.getSyncStatus(h.namespace), null, 'status is gone after stop');
  assert.equal(activeListeners(h.namespace).length, 0, 'onSnapshot listener must be detached');

  t.mock.timers.tick(5000);
  await settle();
  assert.equal(h.setDocCalls().length, 0, 'the queued write must never flush after stop');

  const revisions = globalThis.window._debugSync.revisions();
  assert.ok(!(k1 in revisions) && !(k2 in revisions), 'per-key revisions are cleared');

  // Writes after stop are plain localStorage writes: stored, never queued.
  localStorage.setItem(k2, '"after-stop"');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(h.setDocCalls().length, 0);
  assert.equal(backingStore.get(k2), '"after-stop"');
});

// ---------------------------------------------------------------------------
// 8. Listener error recovery
// ---------------------------------------------------------------------------

test('permission-denied reattaches after backoff without stacking listeners', async (t) => {
  const h = await startHarness(t, ['auth']);

  const first = activeListeners(h.namespace)[0];
  first.onError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' });
  await settle();

  t.mock.timers.tick(250); // AUTH_RETRY_BASE_MS
  await settle();

  const active = activeListeners(h.namespace);
  assert.equal(active.length, 1, 'exactly one live listener after the retry (no stacking)');
  assert.notEqual(active[0], first, 'the retry attached a FRESH listener');
  assert.equal(first.active, false, 'the failed listener was torn down first');
});

test('permission-denied with a changed user abandons instead of retrying', async (t) => {
  const h = await startHarness(t, ['switch']);

  const listener = activeListeners(h.namespace)[0];
  authFakes().currentUser = { uid: 'someone-else', getIdToken: async () => 't' };
  t.after(() => { authFakes().currentUser = USER; });

  listener.onError({ code: 'permission-denied', message: 'denied' });
  await settle();
  t.mock.timers.tick(10_000);
  await settle();

  assert.equal(activeListeners(h.namespace).length, 0,
    'no reattach may happen for a user who signed out or switched');
});

// ---------------------------------------------------------------------------
// 9. Delayed start when auth is not ready
// ---------------------------------------------------------------------------

test('startStorageSync before auth resolves defers, then starts on the auth callback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const namespace = `behaviorNsDeferred${++nsCounter}`;
  const key = `${namespace}:k`;

  authFakes().currentUser = null;
  t.after(() => { authFakes().currentUser = USER; });

  const before = authFakes().authListeners.length;
  const handle = mod.startStorageSync({ namespace, keys: [key] });
  await settle();
  assert.equal(activeListeners(namespace).length, 0, 'no listener before auth is ready');
  assert.equal(authFakes().authListeners.length, before + 1, 'engine waits on onAuthStateChanged');

  authFakes().currentUser = USER;
  for (const cb of authFakes().authListeners.slice(before)) cb(USER);
  await settle();

  assert.equal(activeListeners(namespace).length, 1, 'sync starts once auth delivers a user');
  assert.equal(mod.getSyncStatus(namespace)?.active, true);

  handle.stop();
  assert.equal(mod.getSyncStatus(namespace), null, 'the deferred handle still stops the real sync');
});
