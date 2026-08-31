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
//   6. Large values: a value past MAX_INLINE_VALUE_CHARS is written out of
//      line as part documents plus an inline manifest and read back by
//      reassembly; an unchanged rewrite stays a no-op; a shrunk value
//      returns inline and sweeps its stale parts; a batch too big for one
//      commit is split rather than refused; erasing a namespace sweeps the
//      part documents too; and a PERMANENT rejection is not retried (the
//      MapTap Rivals 760 KB -> 890 KB incident).
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
// 6. Large values: out-of-line chunking, batching, permanent rejections
// ---------------------------------------------------------------------------

// A namespace's Firestore document is capped at 1 MiB, and an app whose data
// grows with use (MapTap Rivals' game log grows as days x rivals) walks into
// that ceiling. The engine writes such a value as an ordered run of part
// documents with a small manifest left inline, so the ceiling stops being a
// wall. These tests pin that the round trip is lossless, that it does not
// re-ship or re-fetch unchanged data, and that it cleans up after itself.

const CHUNK_PATH = /\/chunks\/(.+)__(\d+)$/;

function chunkCalls(calls, namespace) {
  return calls.filter((c) => c.path.startsWith(`users/uid-1/apps/${namespace}/chunks/`));
}

function manifestCalls(calls, namespace) {
  return calls.filter((c) => c.path === `users/uid-1/apps/${namespace}`);
}

/** Rejoin the part documents of one key, in sequence order. */
function reassemble(calls, namespace, key) {
  const parts = [];
  for (const call of chunkCalls(calls, namespace)) {
    const m = CHUNK_PATH.exec(call.path);
    if (!m || call.payload.key !== key) continue;
    parts[Number(m[2])] = call.payload.part;
  }
  return parts.join('');
}

test('a value past the inline ceiling is chunked into part documents, not refused', async (t) => {
  const h = await startHarness(t, ['huge']);
  const [k] = h.keys;

  // 800 KB: the size that used to be refused outright, and the size the
  // MapTap Rivals game log actually reached.
  const value = { rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'x'.repeat(200) })) };
  localStorage.setItem(k, JSON.stringify(value));

  t.mock.timers.tick(500);
  await settle();

  const calls = h.setDocCalls();
  const chunks = chunkCalls(calls, h.namespace);
  const manifests = manifestCalls(calls, h.namespace);

  assert.ok(chunks.length >= 2, `an 800 KB value must span several parts, got ${chunks.length}`);
  assert.equal(manifests.length, 1, 'the inline document is still written exactly once');

  const entry = manifests[0].payload.data[k];
  assert.equal(entry.chunked, true, 'the inline entry must be a manifest');
  assert.equal(entry.parts, chunks.length, 'the manifest must count every part written');
  assert.equal(entry.value, undefined, 'a chunked manifest must not also carry the value inline');
  assert.equal(entry.hash, hashValue(value), 'the manifest hash still describes the whole value');
  assert.ok(isServerTimestampSentinel(entry.updatedAt));

  for (const c of chunks) {
    assert.ok(c.payload.part.length <= 128 * 1024, 'no part may exceed the chunk size');
    assert.equal(c.payload.key, k, 'each part names the key it belongs to');
  }

  assert.deepEqual(JSON.parse(reassemble(calls, h.namespace, k)), value,
    'rejoining the parts must reproduce the value exactly');

  // Parts are written BEFORE the manifest: a peer reading in between must
  // never find a manifest pointing at documents that do not exist yet.
  const firstManifestIndex = calls.indexOf(manifests[0]);
  const lastChunkIndex = calls.indexOf(chunks[chunks.length - 1]);
  assert.ok(lastChunkIndex < firstManifestIndex, 'every part must land before the manifest');

  assert.equal(h.status().retryCount, 0, 'a chunked write is a success, not a retry');
  assert.equal(h.status().queueSize, 0, 'the queue drains');
});

test('re-saving an unchanged large value writes nothing at all', async (t) => {
  const h = await startHarness(t, ['huge']);
  const [k] = h.keys;

  const serialised = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'y'.repeat(200) })) });
  localStorage.setItem(k, serialised);
  t.mock.timers.tick(500);
  await settle();
  const first = h.setDocCalls().length;
  assert.ok(first > 1);

  // Idempotence: the app re-saving the same state (every render loop in
  // this repo does) must not re-ship a megabyte.
  localStorage.setItem(k, serialised);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.setDocCalls().length, first, 'an identical large value must not be rewritten');
  assert.equal(h.status().queueSize, 0);
});

test('a value that shrinks back under the ceiling returns inline and sweeps its stale parts', async (t) => {
  const h = await startHarness(t, ['shrink']);
  const [k] = h.keys;
  const deleteBase = firestoreFakes().deleteDocCalls.length;

  localStorage.setItem(k, JSON.stringify({ pad: 'z'.repeat(400 * 1024) }));
  t.mock.timers.tick(500);
  await settle();
  const partCount = chunkCalls(h.setDocCalls(), h.namespace).length;
  assert.ok(partCount >= 2);

  localStorage.setItem(k, JSON.stringify({ pad: 'small' }));
  t.mock.timers.tick(500);
  await settle();

  const manifests = manifestCalls(h.setDocCalls(), h.namespace);
  const last = manifests[manifests.length - 1].payload.data[k];
  assert.deepEqual(last.value, { pad: 'small' }, 'a small value goes back inline');
  assert.equal(last.chunked, undefined, 'no manifest flag once the value fits inline');

  const deletes = firestoreFakes().deleteDocCalls.slice(deleteBase)
    .filter((p) => p.includes(`/apps/${h.namespace}/chunks/`));
  assert.equal(deletes.length, partCount, 'every part left behind must be deleted');
});

test('a remote chunked manifest is reassembled and applied like any other value', async (t) => {
  const h = await startHarness(t, ['remote']);
  const [k] = h.keys;

  const value = { games: Array.from({ length: 3000 }, (_, i) => ({ i, note: 'synced from MapTap' })) };
  const serialised = JSON.stringify(value);
  const parts = [serialised.slice(0, 40000), serialised.slice(40000)];

  // Seed the part documents the way a peer device's flush would have.
  const docs = firestoreFakes().docs;
  const base = `users/uid-1/apps/${h.namespace}/chunks`;
  const readable = k.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  parts.forEach((part, seq) => {
    docs.set(`${base}/${readable}-${hashValue(k)}__${seq}`, { key: k, seq, part });
  });

  h.emit({
    [k]: { chunked: true, parts: parts.length, rev: 7, updatedAt: Date.now() + 5000, hash: hashValue(value) }
  });
  await settle();

  assert.equal(backingStore.get(k), serialised, 'the reassembled value lands in localStorage');
  const applied = h.events().filter((e) => e.key === k && e.source === 'remote');
  assert.equal(applied.length, 1, 'apps are notified exactly once');
  assert.deepEqual(applied[0].value, value);
});

test('a re-emitted chunked manifest does not refetch the parts', async (t) => {
  const h = await startHarness(t, ['reemit']);
  const [k] = h.keys;

  const value = { pad: 'q'.repeat(50000) };
  const serialised = JSON.stringify(value);
  const base = `users/uid-1/apps/${h.namespace}/chunks`;
  const readable = k.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  firestoreFakes().docs.set(`${base}/${readable}-${hashValue(k)}__0`, { key: k, seq: 0, part: serialised });

  const manifest = { chunked: true, parts: 1, rev: 3, updatedAt: Date.now() + 5000, hash: hashValue(value) };
  h.emit({ [k]: manifest });
  await settle();
  assert.equal(h.events().filter((e) => e.key === k).length, 1);

  // Firestore re-emits the whole document on every listener re-attach. The
  // manifest carries the hash, so the verdict is taken without a read.
  h.emit({ [k]: { ...manifest, updatedAt: Date.now() + 9000 } });
  await settle();
  assert.equal(h.events().filter((e) => e.key === k).length, 1,
    'a hash-identical manifest must not re-apply');
});

test('a flush too large for one commit is split into several merge writes', async (t) => {
  // Eight keys of ~120 KB each: every one fits inline, their sum does not.
  // uploadLocalOnlyKeys ships exactly this shape on a first sign-in.
  const names = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
  const h = await startHarness(t, names);

  for (const key of h.keys) localStorage.setItem(key, JSON.stringify({ pad: 'w'.repeat(120 * 1024) }));
  t.mock.timers.tick(500);
  await settle();

  const manifests = manifestCalls(h.setDocCalls(), h.namespace);
  assert.ok(manifests.length > 1, 'the batch must be split, not refused');
  assert.equal(chunkCalls(h.setDocCalls(), h.namespace).length, 0, 'no single key needed chunking');

  const written = new Set();
  for (const call of manifests) {
    const bytes = JSON.stringify(call.payload).length;
    assert.ok(bytes <= 700 * 1024, `each commit must fit the 700 KB guard, got ${bytes}`);
    for (const key of Object.keys(call.payload.data)) written.add(key);
  }
  assert.deepEqual([...written].sort(), [...h.keys].sort(), 'every key still reaches Firestore');
  assert.equal(h.status().queueSize, 0);
});

test('a permanent write rejection is not retried and is announced to the page', async (t) => {
  const h = await startHarness(t, ['bad']);
  const [k] = h.keys;

  const rejections = [];
  const onRejected = (e) => rejections.push(e.detail);
  window.addEventListener('syncWriteRejected', onRejected);
  t.after(() => window.removeEventListener('syncWriteRejected', onRejected));

  // Firestore refusing the document shape. Deterministic: resending the
  // identical batch fails identically, and the app appending to the same
  // key between attempts only makes the next one bigger.
  const invalid = Object.assign(new Error('Document shape rejected'), { code: 'invalid-argument' });
  firestoreFakes().setDocResponders.push(() => Promise.reject(invalid));

  localStorage.setItem(k, JSON.stringify({ nope: true }));
  t.mock.timers.tick(500);
  await settle();

  assert.equal(h.setDocCalls().length, 1, 'exactly one attempt');
  assert.equal(h.status().retryCount, 0, 'the retry ladder must not start');
  assert.equal(h.status().queueSize, 0, 'a batch that can never land is not requeued');

  t.mock.timers.tick(10000);
  await settle();
  assert.equal(h.setDocCalls().length, 1, 'and it is never resent');

  assert.equal(rejections.length, 1, 'the page is told the write was dropped');
  assert.equal(rejections[0].namespace, h.namespace);
  assert.deepEqual(rejections[0].keys, [k]);
  assert.equal(rejections[0].code, 'invalid-argument');

  // The data itself is untouched: it is safe locally, it just is not synced.
  assert.equal(backingStore.get(k), JSON.stringify({ nope: true }));
});

test('erasing a namespace also deletes the part documents of its chunked values', async (t) => {
  // Firestore deletes are not recursive, and the parts are where the user's
  // data actually lives, so a delete that only removed the manifest would
  // strand the content the privacy policy promises to erase.
  const h = await startHarness(t, ['erase']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ pad: 'e'.repeat(400 * 1024) }));
  t.mock.timers.tick(500);
  await settle();
  const partPaths = chunkCalls(h.setDocCalls(), h.namespace).map((c) => c.path);
  assert.ok(partPaths.length >= 2);

  const deleteBase = firestoreFakes().deleteDocCalls.length;
  await mod.eraseCloudData(h.namespace);
  const deleted = firestoreFakes().deleteDocCalls.slice(deleteBase);

  for (const path of partPaths) {
    assert.ok(deleted.includes(path), `part ${path} must be deleted`);
  }
  assert.ok(deleted.includes(`users/uid-1/apps/${h.namespace}`), 'and the namespace document itself');
  assert.ok(deleted.indexOf(partPaths[0]) < deleted.indexOf(`users/uid-1/apps/${h.namespace}`),
    'parts go first, so a failure part-way leaves an empty manifest rather than orphaned content');
});

test('a transient write failure still climbs the retry ladder', async (t) => {
  const h = await startHarness(t, ['flaky']);
  const [k] = h.keys;

  const unavailable = Object.assign(new Error('backend unavailable'), { code: 'unavailable' });
  firestoreFakes().setDocResponders.push(() => Promise.reject(unavailable));

  localStorage.setItem(k, '"transient"');
  t.mock.timers.tick(500);
  await settle();
  assert.equal(h.status().retryCount, 1, 'an unknown/transient code keeps the old behaviour');
  assert.equal(h.status().queueSize, 1, 'and the batch is requeued');

  t.mock.timers.tick(1000);
  await settle();
  assert.equal(h.setDocCalls().length, 2, 'the retry actually resends');
  assert.equal(h.status().queueSize, 0, 'the retry succeeded');
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
