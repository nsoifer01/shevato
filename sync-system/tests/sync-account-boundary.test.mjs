// The account boundary (2026-09-12 audit S-2, S-4, S-5, T-3), against the REAL
// engine.
//
// The merge core was right in all four findings; the edges around it were not.
// Whose data a local copy is, what counts as a person's work, what may happen
// while an account is being deleted, and when the first upload may go. The
// tests below prove four statements:
//
//   1. Account A's local data never uploads into account B.        (S-2)
//   2. Genuine signed-out work does not disappear on sign-in.        (S-4)
//   3. Account deletion cannot be undone by a competing session.    (S-5)
//   4. A namespace cannot upload before it has read and reconciled
//      its first server snapshot.                                    (T-3)
//
// A PAGE LOAD IS A FRESH ENGINE. The module is imported again under a new query
// string (helpers/storage-sync-hook.mjs accepts one), so two tabs, or a page and
// its reload, are two engines sharing one localStorage and one fake Firestore,
// exactly as two tabs share them. The window stub sets `immediateDebug`, which
// is what sync-immediate.js does on every app page, so each engine takes the
// production `useImmediateOverride()` path and hears only its own page's
// writes, through `processChange`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashValue, splitIntoChunks } from '../sync-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

register('./helpers/storage-sync-hook.mjs', import.meta.url, {
  data: {
    firestoreUrl: pathToFileURL(join(here, 'helpers', 'firestore-stub.mjs')).href,
    firebaseConfigUrl: pathToFileURL(join(here, 'helpers', 'firebase-config-stub.mjs')).href
  }
});

// Recorded, not printed: raw stdout from timer callbacks can desync the
// node:test IPC stream (see storage-sync-behavior.test.mjs).
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
const reloads = [];
globalThis.window = {
  addEventListener: (...args) => windowTarget.addEventListener(...args),
  removeEventListener: (...args) => windowTarget.removeEventListener(...args),
  dispatchEvent: (ev) => windowTarget.dispatchEvent(ev),
  __shevatoSyncChannel: { tabId: 'boundary', isLive: false, publish() {}, subscribe: () => () => {}, close() {} },
  immediateDebug: {},
  location: { reload: () => { reloads.push(Date.now()); } }
};

const documentListeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  }
};

const pageEvents = [];
for (const type of ['syncConflict', 'syncWriteRejected', 'appSyncFailed']) {
  windowTarget.addEventListener(type, (e) => pageEvents.push({ type, detail: e.detail }));
}

const { authFakes } = await import('./helpers/firebase-config-stub.mjs');
const { firestoreFakes } = await import('./helpers/firestore-stub.mjs');
const ENGINE = new URL('../storage-sync-robust.js', import.meta.url).href;

const A = { uid: 'uid-A', getIdToken: async () => 'token' };
const B = { uid: 'uid-B', getIdToken: async () => 'token' };
const signIn = (user) => { authFakes().currentUser = user; };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

let pageCounter = 0;

/**
 * A page load: a fresh engine. `configs` is what app-sync-init.js registers
 * when the page loads, which is also the moment the page's apps read storage.
 */
async function openPage(t, configs) {
  const mod = await import(`${ENGINE}?page=${++pageCounter}`);
  const engine = window.syncManager;   // this instance's constructor set it
  // Guarded so this file can also run against an engine that predates the
  // account boundary, which is how its tests were shown to fail before the fix.
  if (typeof mod.registerLocalNamespaces === 'function') mod.registerLocalNamespaces(configs);
  const handles = [];
  const page = {
    mod,
    /** An app on this page calls localStorage.setItem (routed by sync-immediate.js). */
    write(key, value) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      backingStore.set(key, raw);
      engine.processChange(key, raw);
    },
    /** A boot-window write sync-immediate.js buffered, replayed with its gesture state. */
    replay(key, value, work) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      backingStore.set(key, raw);
      engine.processChange(key, raw, { work });
    },
    start(namespace, keys) {
      const handle = mod.startStorageSync({ namespace, keys });
      handles.push(handle);
      return handle;
    },
    /** Sign-out on this page: initAppSync's stopAppSync. */
    stopAll() {
      for (const handle of handles.splice(0)) handle.stop();
    }
  };
  t.after(() => page.stopAll());
  return page;
}

function listenersFor(uid, namespace) {
  return firestoreFakes().snapshotListeners
    .filter((l) => l.path === `users/${uid}/apps/${namespace}` && l.active);
}
const listenerFor = (uid, namespace) => listenersFor(uid, namespace).pop() || null;

/** A server-confirmed snapshot, to every live listener on the document. */
function emit(uid, namespace, data) {
  const live = listenersFor(uid, namespace);
  assert.ok(live.length, `no live listener for ${uid}/${namespace}`);
  for (const l of live) l.onNext({ data: () => ({ data }), metadata: { fromCache: false, hasPendingWrites: false } });
}

let clock = 1_700_000_000_000;
const cloud = (value, rev) => ({ value, rev, hash: hashValue(value), updatedAt: (clock += 1000) });
const mark = () => firestoreFakes().setDocCalls.length;
const writesTo = (uid, from) => firestoreFakes().setDocCalls.slice(from).filter((c) => c.path.startsWith(`users/${uid}/`));
const sentText = (calls) => JSON.stringify(calls.map((c) => c.payload));
const stored = (key) => (backingStore.has(key) ? JSON.parse(backingStore.get(key)) : null);
const eventsSince = (from, type) => pageEvents.slice(from).filter((e) => e.type === type).map((e) => e.detail);
const copiesOf = (key) => JSON.parse(backingStore.get('shevato:sync-conflicts') || '[]').filter((c) => c.key === key);
const copyValue = (copy) => JSON.parse(backingStore.get(copy.id)).value;
const revsOf = (namespace) => JSON.parse(backingStore.get(`shevato:sync-revs:${namespace}`) || 'null');
const parkedFor = (namespace) => JSON.parse(backingStore.get(`shevato:sync-parked:${namespace}`) || 'null');

let nsCounter = 0;
const ns = (prefix) => `${prefix}${++nsCounter}`;

/** Deletion latch, provenance and the legacy marker are device-wide keys. */
function isolate(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    signIn(null);
    for (const key of ['shevato:sync-deletion', 'shevato:sync-local-work', 'shevato:sync-owner']) backingStore.delete(key);
    firestoreFakes().setDocResponders.length = 0;
    firestoreFakes().getDocResponders = [];
  });
}

/**
 * Whether the page has seen a user gesture (navigator.userActivation), which
 * is how the engine tells a person's signed-out write from an app's own.
 */
function userGesture(t, active) {
  const gesture = { active };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { userActivation: { get hasBeenActive() { return gesture.active; } } }
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });
  return gesture;
}

/** What another tab's localStorage write looks like to this one. */
function storageEvent(key) {
  windowTarget.dispatchEvent(Object.assign(new Event('storage'), { key }));
}

// ===========================================================================
// S-2: account A's local data never uploads into account B
// ===========================================================================

test('S-2: B signs in on a page that shows A\'s data, then edits: nothing of A\'s reaches B in any namespace, and B syncs after the reload', async (t) => {
  isolate(t);
  const games = ns('s2games'), prefs = ns('s2prefs');
  const kGames = `${games}:games`, kPrefs = `${prefs}:settings`;
  const configs = [{ namespace: games, keys: [kGames] }, { namespace: prefs, keys: [kPrefs] }];
  const aGames = [{ id: 'a1', who: 'A' }, { id: 'a2', who: 'A' }];

  // A uses this browser. One more game is still inside the debounce at sign-out.
  signIn(A);
  const pageA = await openPage(t, configs);
  pageA.start(games, [kGames]);
  pageA.start(prefs, [kPrefs]);
  await settle();
  emit(A.uid, games, { [kGames]: cloud(aGames, 4) });
  emit(A.uid, prefs, { [kPrefs]: cloud({ units: 'kg', who: 'A' }, 2) });
  await settle();
  pageA.write(kGames, [...aGames, { id: 'a3', who: 'A' }]);
  pageA.stopAll();
  signIn(null);

  // A page loads signed out, showing A's data. B signs in on it.
  const shown = await openPage(t, configs);
  const from = mark();
  const reloadsBefore = reloads.length;
  signIn(B);
  shown.start(games, [kGames]);
  shown.start(prefs, [kPrefs]);
  await settle();
  assert.ok(reloads.length > reloadsBefore, 'the page whose apps hold A\'s data reloads before syncing for B');
  assert.equal(listenerFor(B.uid, games), null, 'and starts no session for B until it has');
  assert.equal(backingStore.has(kGames) || backingStore.has(kPrefs), false, 'A\'s data is no longer live');
  assert.equal(revsOf(games).uid, B.uid, 'the namespace now belongs to B on this device');

  // Before the reload lands, the page's apps save what they still hold (R2).
  shown.write(kGames, [...aGames, { id: 'a3', who: 'A' }]);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(B.uid, from).length, 0, 'nothing is sent from the page that has not reloaded');

  // The reload.
  const reloaded = await openPage(t, configs);
  reloaded.start(games, [kGames]);
  reloaded.start(prefs, [kPrefs]);
  await settle();
  assert.ok(listenerFor(B.uid, games), 'the reloaded page syncs for B');
  emit(B.uid, games, {});
  emit(B.uid, prefs, {});
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(B.uid, from).length, 0, 'no start-up path uploads anything when B has not edited');

  reloaded.write(kGames, [{ id: 'b1', who: 'B' }]);
  reloaded.write(kPrefs, { units: 'lb', who: 'B' });
  t.mock.timers.tick(500);
  await settle();
  const toB = writesTo(B.uid, from);
  assert.ok(toB.length >= 1, 'B\'s own edits sync');
  assert.doesNotMatch(sentText(toB), /"who":"A"/, 'nothing of A\'s is in anything sent to B');
  assert.match(sentText(toB), /"b1"/);
  assert.match(sentText(toB), /"lb"/);

  assert.match(parkedFor(games).owners[A.uid].keys[kGames].raw, /"a3"/,
    'A\'s unsynced game is kept on this device, for A');
  assert.equal(parkedFor(prefs), null, 'A\'s prefs were already in A\'s cloud, so nothing needed keeping');
});

test('S-2 and S-4: A signs out and back in: no reload, no parking, and A\'s signed-out edit goes to A as a new revision over the older cloud value', async (t) => {
  isolate(t);
  const space = ns('s2again');
  const k = `${space}:prefs`;
  const configs = [{ namespace: space, keys: [k] }];

  signIn(A);
  const first = await openPage(t, configs);
  first.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud('v1', 2) });
  await settle();
  first.stopAll();
  signIn(null);
  first.write(k, '"v2 made while signed out"');

  const again = await openPage(t, configs);
  const from = mark();
  const reloadsBefore = reloads.length;
  signIn(A);
  again.start(space, [k]);
  await settle();
  assert.equal(reloads.length, reloadsBefore, 'the same account does not reload');
  emit(A.uid, space, { [k]: cloud('v1', 2) });
  await settle();

  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1, 'the signed-out edit is uploaded');
  assert.equal(toA[0].payload.data[k].value, 'v2 made while signed out');
  assert.equal(toA[0].payload.data[k].rev, 3, 'as a new revision over the cloud\'s rev 2');
  assert.equal(parkedFor(space), null, 'nothing is parked for the owner itself');
});

test('S-2: A, then B, then A: A\'s unsynced work waits on the device while B uses it, then goes to A\'s cloud and never to B\'s', async (t) => {
  isolate(t);
  const space = ns('s2swap');
  const k = `${space}:log`;
  const configs = [{ namespace: space, keys: [k] }];

  signIn(A);
  const a1 = await openPage(t, configs);
  a1.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud([{ id: 'a1' }], 3) });
  await settle();
  a1.write(k, [{ id: 'a1' }, { id: 'a2-unsynced' }]);     // still in the debounce
  a1.stopAll();
  signIn(null);
  const from = mark();

  // B signs in on a page that loaded A's data, reloads, uses the device, signs out.
  const bShown = await openPage(t, configs);
  signIn(B);
  bShown.start(space, [k]);
  await settle();
  const bPage = await openPage(t, configs);
  bPage.start(space, [k]);
  await settle();
  emit(B.uid, space, {});
  await settle();
  bPage.write(k, [{ id: 'b1' }]);
  t.mock.timers.tick(500);
  await settle();
  bPage.stopAll();
  signIn(null);

  // A signs back in on a page that loaded B's data, reloads, syncs.
  const aShown = await openPage(t, configs);
  signIn(A);
  aShown.start(space, [k]);
  await settle();
  assert.deepEqual(stored(k).map((r) => r.id), ['a1', 'a2-unsynced'], 'A\'s parked work is back in place');
  const aPage = await openPage(t, configs);
  aPage.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud([{ id: 'a1' }], 3) });
  await settle();
  t.mock.timers.tick(500);
  await settle();

  assert.doesNotMatch(sentText(writesTo(B.uid, from)), /a2-unsynced/, 'B never received A\'s work');
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.deepEqual(toA[0].payload.data[k].value.map((r) => r.id), ['a1', 'a2-unsynced'], 'A\'s work reached A');
  assert.equal(toA[0].payload.data[k].rev, 4, 'at the revision that never landed');
  assert.doesNotMatch(sentText(toA), /"b1"/, 'and nothing of B\'s went to A');
});

test('S-2: another tab still showing A\'s data never uploads it: its stale session keeps its edit for A, and its late stop cannot hand the device back to A', async (t) => {
  isolate(t);
  const space = ns('s2tabs');
  const k = `${space}:log`;
  const configs = [{ namespace: space, keys: [k] }];

  signIn(A);
  const tabX = await openPage(t, configs);
  const tabY = await openPage(t, configs);
  tabX.start(space, [k]);
  tabY.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud([{ id: 'a1' }], 2) });
  await settle();
  const from = mark();

  // Tab X switches to B. Tab Y has not heard about it yet.
  signIn(B);
  tabX.start(space, [k]);
  await settle();
  assert.equal(revsOf(space).uid, B.uid);

  // Tab Y's app saves an edit A made there, and its debounce fires.
  signIn(A);
  tabY.write(k, [{ id: 'a1' }, { id: 'a2-from-tab-y' }]);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(writesTo(A.uid, from).length + writesTo(B.uid, from).length, 0, 'the edit is sent nowhere');
  assert.equal(revsOf(space).uid, B.uid, 'tab Y stopping did not stamp A back over B');
  assert.match(parkedFor(space).owners[A.uid].keys[k].raw, /a2-from-tab-y/, 'the edit is kept for A');
  assert.equal(backingStore.has(k), false, 'and is not left live for B to adopt');

  // Tab Y receives the auth change: it loaded A's data, so it reloads too.
  signIn(B);
  const reloadsBefore = reloads.length;
  tabY.start(space, [k]);
  await settle();
  assert.ok(reloads.length > reloadsBefore);
  assert.equal(listenerFor(B.uid, space), null);
});

// ===========================================================================
// S-4: genuine signed-out work does not disappear on sign-in
// ===========================================================================

test('S-4: data created while signed out, then a sign-in to an account with nothing in the cloud: it is uploaded', async (t) => {
  isolate(t);
  const space = ns('s4create');
  const k = `${space}:races`;
  const configs = [{ namespace: space, keys: [k] }];
  const page = await openPage(t, configs);
  page.write(k, [{ id: 'o1' }]);

  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  assert.ok(listenerFor(A.uid, space), 'data nobody has synced is not another account\'s: no reload');
  emit(A.uid, space, {});
  await settle();
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.deepEqual(toA[0].payload.data[k].value, [{ id: 'o1' }]);
});

test('S-4: signed-out edits meet a cloud that moved: records merge, and a value that cannot merge keeps the cloud\'s live and the local one as a recovery copy', async (t) => {
  isolate(t);
  const space = ns('s4moved');
  const kLog = `${space}:log`, kTheme = `${space}:theme`;
  const configs = [{ namespace: space, keys: [kLog, kTheme] }];

  signIn(A);
  const first = await openPage(t, configs);
  first.start(space, [kLog, kTheme]);
  await settle();
  emit(A.uid, space, { [kLog]: cloud([{ id: 'r1' }], 2), [kTheme]: cloud('dark', 2) });
  await settle();
  first.stopAll();
  signIn(null);
  first.write(kLog, [{ id: 'r1' }, { id: 'local-r2' }]);
  first.write(kTheme, '"light"');

  const events = pageEvents.length;
  const from = mark();
  const next = await openPage(t, configs);
  signIn(A);
  next.start(space, [kLog, kTheme]);
  await settle();
  // Another device moved both keys meanwhile.
  emit(A.uid, space, { [kLog]: cloud([{ id: 'r1' }, { id: 'cloud-r3' }], 5), [kTheme]: cloud('blue', 5) });
  await settle();
  t.mock.timers.tick(500);
  await settle();

  assert.deepEqual(stored(kLog).map((r) => r.id).sort(), ['cloud-r3', 'local-r2', 'r1'], 'both devices\' records survive');
  assert.match(sentText(writesTo(A.uid, from)), /local-r2/, 'and the merge is uploaded');
  assert.equal(backingStore.get(kTheme), 'blue', 'the moved cloud value stays live');
  const copies = copiesOf(kTheme);
  assert.equal(copies.length, 1);
  assert.equal(copyValue(copies[0]), 'light', 'the signed-out value is kept as a recovery copy');
  assert.ok(eventsSince(events, 'syncConflict').some((e) => e.key === kTheme), 'and the page is told');
});

test('S-4: a signed-out edit on top of A\'s leftovers is still A\'s: B does not adopt it as B\'s own work, and it is kept for A', async (t) => {
  isolate(t);
  const space = ns('s4foreign');
  const k = `${space}:log`;
  const configs = [{ namespace: space, keys: [k] }];

  signIn(A);
  const pageA = await openPage(t, configs);
  pageA.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud([{ id: 'a1' }], 2) });
  await settle();
  pageA.stopAll();
  signIn(null);
  pageA.write(k, [{ id: 'a1' }, { id: 'edited-signed-out' }]);  // a person's edit, no session

  const from = mark();
  const shown = await openPage(t, configs);
  signIn(B);
  shown.start(space, [k]);
  await settle();
  const reloaded = await openPage(t, configs);
  reloaded.start(space, [k]);
  await settle();
  emit(B.uid, space, {});
  await settle();
  t.mock.timers.tick(5000);
  await settle();

  assert.equal(writesTo(B.uid, from).length, 0, 'not uploaded to B');
  assert.equal(backingStore.has(k), false, 'not live for B');
  assert.match(parkedFor(space).owners[A.uid].keys[k].raw, /edited-signed-out/, 'kept on this device for A');
});

test('S-4: work made on a device that never synced meets the account\'s records: both sets survive and the page is told', async (t) => {
  isolate(t);
  const space = ns('s4anon');
  const k = `${space}:sessions`;
  const configs = [{ namespace: space, keys: [k] }];
  const page = await openPage(t, configs);
  page.write(k, [{ id: 'offline-1' }, { id: 'offline-2' }]);

  const events = pageEvents.length;
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud([{ id: 'cloud-1' }], 7) });
  await settle();
  t.mock.timers.tick(500);
  await settle();

  assert.deepEqual(stored(k).map((r) => r.id).sort(), ['cloud-1', 'offline-1', 'offline-2'], 'nothing is silently replaced');
  const sent = sentText(writesTo(A.uid, from));
  assert.match(sent, /offline-1/);
  assert.match(sent, /cloud-1/);
  assert.equal(eventsSince(events, 'syncConflict').filter((e) => e.key === k).length, 1);
});

test('S-4: a value an app wrote for itself before any user gesture is a placeholder: the cloud replaces it with no copy and no notice', async (t) => {
  isolate(t);
  userGesture(t, false);
  const space = ns('s4floor');
  const k = `${space}:v1`;
  const configs = [{ namespace: space, keys: [k] }];
  const floor = { version: 1, activeTripId: 'f1', trips: [{ id: 'f1', name: 'My trip', items: [] }] };
  const cloudDb = { version: 1, activeTripId: 'c1', trips: [{ id: 'c1', name: 'Lisbon', items: [{ id: 'i1' }] }] };
  const page = await openPage(t, configs);
  page.write(k, floor);                                   // the app's own floor trip, at boot

  const events = pageEvents.length;
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  emit(A.uid, space, { [k]: cloud(cloudDb, 7) });
  await settle();
  t.mock.timers.tick(5000);
  await settle();

  assert.deepEqual(stored(k), cloudDb);
  assert.equal(copiesOf(k).length, 0, 'no recovery copy of a placeholder');
  assert.equal(eventsSince(events, 'syncConflict').length, 0, 'and no notice');
  assert.equal(writesTo(A.uid, from).length, 0, 'and nothing uploaded');
});

test('S-4: a placeholder is still uploaded where the account has nothing (a first sign-in on a new account)', async (t) => {
  isolate(t);
  userGesture(t, false);
  const space = ns('s4defaults');
  const k = `${space}:settings`;
  const configs = [{ namespace: space, keys: [k] }];
  const page = await openPage(t, configs);
  page.write(k, { weightUnit: 'kg' });

  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  emit(A.uid, space, {});
  await settle();
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.deepEqual(toA[0].payload.data[k].value, { weightUnit: 'kg' });
});

// ===========================================================================
// S-5: account deletion cannot be undone by a competing session
// ===========================================================================

test('S-5: deletion in tab 1 while tab 2 is live and a third page loads: nothing is re-uploaded, and the cloud document ends absent', async (t) => {
  isolate(t);
  const space = ns('s5tabs');
  const k1 = `${space}:one`, k2 = `${space}:two`;
  const keys = [k1, k2];
  const configs = [{ namespace: space, keys }];
  const docPath = `users/${A.uid}/apps/${space}`;

  signIn(A);
  const tab1 = await openPage(t, configs);
  const tab2 = await openPage(t, configs);
  tab1.start(space, keys);
  tab2.start(space, keys);
  await settle();
  emit(A.uid, space, { [k1]: cloud('one', 1), [k2]: cloud('two', 1) });
  await settle();
  firestoreFakes().docs.set(docPath, { data: { [k1]: cloud('one', 1), [k2]: cloud('two', 1) } });
  tab2.write(k1, '"edited in tab 2"');                     // waiting in tab 2's debounce

  // Tab 1: deleteAccount, after reauthentication.
  const from = mark();
  const latch = tab1.mod.beginAccountDeletion(A.uid);
  storageEvent('shevato:sync-deletion');                   // what tab 2 hears
  assert.equal(listenerFor(A.uid, space), null, 'every live session for A, in both tabs, stopped');

  // During the deletes a third page loads, and tab 2 re-enters initAppSync (the auth re-fan).
  const tab3 = await openPage(t, configs);
  tab3.start(space, keys);
  tab2.start(space, keys);
  await settle();
  assert.equal(listenerFor(A.uid, space), null, 'no session can start for the account being deleted');

  await tab1.mod.settleBeforeAccountDeletion();
  await tab1.mod.eraseCloudData(space);
  tab2.write(k2, '"edited during the deletes"');
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(await tab1.mod.confirmCloudDataErased([space]), []);
  assert.equal(writesTo(A.uid, from).length, 0, 'nothing was written for the account after the latch');
  assert.equal(firestoreFakes().docs.has(docPath), false, 'the cloud document is absent');

  tab1.mod.endAccountDeletion(A.uid, latch, { deleted: true });
  tab3.start(space, keys);
  await settle();
  assert.equal(listenerFor(A.uid, space), null, 'a deleted account stays latched: a stale tab cannot re-attach');
});

test('S-5: a session whose first snapshot arrives after deletion began uploads nothing: not its local-only keys, not its queued edit', async (t) => {
  isolate(t);
  const space = ns('s5pending');
  const k = `${space}:log`;
  const configs = [{ namespace: space, keys: [k] }];

  signIn(A);
  const deleting = await openPage(t, configs);
  const pending = await openPage(t, configs);
  pending.write(k, [{ id: 'local-only' }]);
  pending.start(space, [k]);
  await settle();
  pending.write(k, [{ id: 'local-only' }, { id: 'queued-edit' }]);  // held by the barrier

  const from = mark();
  const latch = deleting.mod.beginAccountDeletion(A.uid);   // tab 2 has not heard yet
  emit(A.uid, space, {});                                    // the emptied document arrives
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0);
  assert.equal(listenerFor(A.uid, space), null, 'the session stopped instead of merging');
  deleting.mod.endAccountDeletion(A.uid, latch, { deleted: true });
});

test('S-5: a namespace document a late write re-created is deleted again by the final check', async (t) => {
  isolate(t);
  const space = ns('s5late');
  const docPath = `users/${A.uid}/apps/${space}`;
  signIn(A);
  const page = await openPage(t, [{ namespace: space, keys: [`${space}:k`] }]);
  firestoreFakes().docs.set(docPath, { data: { [`${space}:k`]: cloud('arrived late', 2) } });
  assert.deepEqual(await page.mod.confirmCloudDataErased([space]), [space]);
  assert.equal(firestoreFakes().docs.has(docPath), false);
});

test('S-5: a failed deletion clears the latch and the account syncs again; a deletion whose tab is gone is recognised, a live one is not', async (t) => {
  isolate(t);
  const space = ns('s5failed');
  const k = `${space}:prefs`;
  const configs = [{ namespace: space, keys: [k] }];

  signIn(A);
  const page = await openPage(t, configs);
  const latch = page.mod.beginAccountDeletion(A.uid);
  page.start(space, [k]);
  await settle();
  assert.equal(listenerFor(A.uid, space), null, 'latched: nothing starts');

  page.mod.endAccountDeletion(A.uid, latch, { deleted: false });   // e.g. data-delete-failed
  assert.equal(page.mod.isAccountDeletionLatched(A.uid), false, 'the latch is released');
  const from = mark();
  page.start(space, [k]);
  await settle();
  emit(A.uid, space, {});
  await settle();
  page.write(k, '"after a failed deletion"');
  t.mock.timers.tick(500);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 1, 'the account is not left sync-disabled');

  // Another tab's deletion: alive, then abandoned (its heartbeat stopped).
  const record = (heartbeatAt) => JSON.stringify({
    active: { uid: B.uid, id: 'other-tab', startedAt: heartbeatAt, heartbeatAt }, deleted: []
  });
  backingStore.set('shevato:sync-deletion', record(Date.now()));
  assert.equal(await page.mod.clearAbandonedAccountDeletion(B.uid), false, 'a live deletion is left alone');
  assert.equal(page.mod.isAccountDeletionLatched(B.uid), true);
  backingStore.set('shevato:sync-deletion', record(Date.now() - 120_000));
  assert.equal(await page.mod.clearAbandonedAccountDeletion(B.uid), true, 'an abandoned one is cleared');
  assert.equal(page.mod.isAccountDeletionLatched(B.uid), false);
});

test('S-5: deletion waits for a write that left before the latch, so it lands before the deletes rather than after', async (t) => {
  isolate(t);
  const space = ns('s5inflight');
  const k = `${space}:prefs`;
  const configs = [{ namespace: space, keys: [k] }];
  signIn(A);
  const page = await openPage(t, configs);
  page.start(space, [k]);
  await settle();
  emit(A.uid, space, {});
  await settle();

  const wire = deferred();
  firestoreFakes().setDocResponders.push(() => wire.promise);
  page.write(k, '"on the wire"');
  t.mock.timers.tick(500);
  await settle();

  const latch = page.mod.beginAccountDeletion(A.uid);
  let settled = false;
  const waiting = page.mod.settleBeforeAccountDeletion().then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, 'the deletes do not begin while the write is on the wire');
  wire.resolve();
  await waiting;
  assert.equal(settled, true);
  page.mod.endAccountDeletion(A.uid, latch, { deleted: false });
});

// ===========================================================================
// T-3: nothing uploads before the first server snapshot is reconciled
// ===========================================================================

test('T-3: an edit made before the first snapshot is not sent over the unread cloud trips; the cloud stays live and the edit is kept', async (t) => {
  isolate(t);
  const gesture = userGesture(t, false);
  const space = ns('t3trips');
  const k = `${space}:v1`;
  const configs = [{ namespace: space, keys: [k] }];
  const floor = { version: 1, activeTripId: 'f1', trips: [{ id: 'f1', name: 'My trip', items: [] }] };
  const cloudDb = {
    version: 1, activeTripId: 'c1',
    trips: [{ id: 'c1', name: 'Lisbon', items: [{ id: 'i1' }] }, { id: 'c2', name: 'Tokyo', items: [] }]
  };

  const page = await openPage(t, configs);
  page.write(k, floor);                                    // boot floor, no gesture
  const events = pageEvents.length;
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  gesture.active = true;
  const edited = { ...floor, trips: [{ ...floor.trips[0], items: [{ id: 'n1', title: 'Dinner' }] }] };
  page.write(k, edited);                                   // the slow network has not answered yet
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0, 'nothing is sent before the cloud has been read');

  emit(A.uid, space, { [k]: cloud(cloudDb, 7) });
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual(stored(k), cloudDb, 'the account\'s trips stay live');
  assert.equal(writesTo(A.uid, from).length, 0, 'the floor never replaces them in the cloud');
  const copies = copiesOf(k);
  assert.equal(copies.length, 1);
  assert.equal(copyValue(copies[0]).trips[0].items[0].title, 'Dinner', 'the early edit is kept as a recovery copy');
  assert.equal(eventsSince(events, 'syncConflict').filter((e) => e.key === k).length, 1, 'and the page is told');
});

test('T-3: an early addition to a record collection is merged with the cloud\'s records and sent only after the snapshot', async (t) => {
  isolate(t);
  const space = ns('t3records');
  const k = `${space}:games`;
  const configs = [{ namespace: space, keys: [k] }];
  const page = await openPage(t, configs);
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, [{ id: 'early' }]);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0);

  emit(A.uid, space, { [k]: cloud([{ id: 'c1' }], 3) });
  await settle();
  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(stored(k).map((r) => r.id).sort(), ['c1', 'early']);
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.deepEqual(toA[0].payload.data[k].value.map((r) => r.id).sort(), ['c1', 'early']);
});

test('T-3: an empty cloud releases the barrier and the early edit is uploaded at once', async (t) => {
  isolate(t);
  const space = ns('t3empty');
  const k = `${space}:prefs`;
  const page = await openPage(t, [{ namespace: space, keys: [k] }]);
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, '"early"');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0);
  emit(A.uid, space, {});
  await settle();
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.equal(toA[0].payload.data[k].value, 'early');
});

test('T-3: a first snapshot that never arrives does not hang: flushes resolve, nothing is sent, the edit stays dirty and the page is told', async (t) => {
  isolate(t);
  const space = ns('t3error');
  const k = `${space}:prefs`;
  const page = await openPage(t, [{ namespace: space, keys: [k] }]);
  const events = pageEvents.length;
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, '"typed offline"');

  const fail = () => listenerFor(A.uid, space).onError({ code: 'unavailable', message: 'offline' });
  fail(); t.mock.timers.tick(1000); await settle();
  fail(); t.mock.timers.tick(2000); await settle();
  fail(); t.mock.timers.tick(4000); await settle();
  fail(); await settle();                                  // out of retries

  await window.__shevatoFlushSync();                       // the sign-out flush resolves
  windowTarget.dispatchEvent(new Event('pagehide'));
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0, 'nothing sent, however it is asked');
  assert.equal(revsOf(space).keys[k].dirty, true, 'the edit is persisted as unsaved');
  const rejected = eventsSince(events, 'syncWriteRejected').filter((e) => e.namespace === space);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].retryable, true);
});

test('T-3: signing out while the first snapshot is pending sends nothing late, and the edit goes after the next session\'s snapshot', async (t) => {
  isolate(t);
  const space = ns('t3signout');
  const k = `${space}:prefs`;
  const configs = [{ namespace: space, keys: [k] }];
  const page = await openPage(t, configs);
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, '"typed while loading"');
  page.stopAll();
  signIn(null);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0, 'no late upload after sign-out');

  const next = await openPage(t, configs);
  signIn(A);
  next.start(space, [k]);
  await settle();
  emit(A.uid, space, {});
  await settle();
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.equal(toA[0].payload.data[k].value, 'typed while loading');
});

test('T-3: a slow namespace does not hold back one that has already read its cloud', async (t) => {
  isolate(t);
  const slow = ns('t3slow'), fast = ns('t3fast');
  const kSlow = `${slow}:x`, kFast = `${fast}:y`;
  const page = await openPage(t, [{ namespace: slow, keys: [kSlow] }, { namespace: fast, keys: [kFast] }]);
  const from = mark();
  signIn(A);
  page.start(slow, [kSlow]);
  page.start(fast, [kFast]);
  await settle();
  emit(A.uid, fast, {});
  await settle();
  page.write(kSlow, '"waits"');
  page.write(kFast, '"goes"');
  t.mock.timers.tick(500);
  await settle();
  const toA = writesTo(A.uid, from);
  assert.equal(toA.length, 1);
  assert.equal(toA[0].path, `users/${A.uid}/apps/${fast}`);
});

test('T-3: the barrier waits for a chunked value in the first snapshot to be assembled before sending an early edit to it', async (t) => {
  isolate(t);
  const space = ns('t3chunk');
  const k = `${space}:log`;
  const fat = 'x'.repeat(140 * 1024);
  const cloudRecords = [{ id: 'c1', blob: fat }];
  const serialised = JSON.stringify(cloudRecords);
  const rev = 5;
  const version = `${rev}-${hashValue(cloudRecords)}`.replace(/[^A-Za-z0-9_-]/g, '');
  const parts = splitIntoChunks(serialised, 128 * 1024);
  const stem = `${String(k).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}-${hashValue(k)}`;
  parts.forEach((part, seq) => {
    firestoreFakes().docs.set(`users/${A.uid}/apps/${space}/chunks/${stem}__v${version}__${seq}`, { key: k, seq, part, version });
  });
  const manifest = {
    chunked: true, parts: parts.length, rev, updatedAt: (clock += 1000),
    hash: hashValue(cloudRecords), chunkVersion: version, chars: serialised.length
  };

  const page = await openPage(t, [{ namespace: space, keys: [k] }]);
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, [{ id: 'early' }]);
  const gate = deferred();
  firestoreFakes().getDocResponders = parts.map(() => () => gate.promise);
  emit(A.uid, space, { [k]: manifest });
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0, 'nothing is sent while the chunked value is still being read');

  gate.resolve();
  await settle(16);
  t.mock.timers.tick(500);
  await settle(16);
  assert.deepEqual(stored(k).map((r) => r.id).sort(), ['c1', 'early']);
  assert.match(sentText(writesTo(A.uid, from)), /early/, 'then the merge goes');
});

test('T-3: closing the page during initialisation does not force out a write that never met the cloud', async (t) => {
  isolate(t);
  const space = ns('t3pagehide');
  const k = `${space}:prefs`;
  const page = await openPage(t, [{ namespace: space, keys: [k] }]);
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, '"typed while loading"');
  windowTarget.dispatchEvent(new Event('pagehide'));
  document.visibilityState = 'hidden';
  for (const fn of documentListeners.get('visibilitychange') || []) fn();
  document.visibilityState = 'visible';
  await settle();
  assert.equal(writesTo(A.uid, from).length, 0);
  emit(A.uid, space, {});
  await settle();
  assert.equal(writesTo(A.uid, from).length, 1, 'it goes once the cloud has been read');
});

test('T-3: an app\'s own write while the cloud is unread (no gesture) gives way to the cloud value without a copy', async (t) => {
  isolate(t);
  userGesture(t, false);
  const space = ns('t3boot');
  const k = `${space}:settings`;
  const page = await openPage(t, [{ namespace: space, keys: [k] }]);
  const events = pageEvents.length;
  const from = mark();
  signIn(A);
  page.start(space, [k]);
  await settle();
  page.write(k, { units: 'kg', default: true });
  emit(A.uid, space, { [k]: cloud({ units: 'lb' }, 2) });
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(stored(k), { units: 'lb' });
  assert.equal(copiesOf(k).length, 0);
  assert.equal(eventsSince(events, 'syncConflict').length, 0);
  assert.equal(writesTo(A.uid, from).length, 0);
});

// ---------------------------------------------------------------------------
// Provenance costs a signed-out page nothing on the write itself
// ---------------------------------------------------------------------------
//
// Recording whether a person or an app made a signed-out write means hashing
// the value, and a log can be megabytes (3.7 MB parses and hashes in ~87 ms).
// That runs after the write, once per key however many writes there were, and
// anything that reads provenance records the batch first, so a sign-in in the
// same task still sees it.

test('S-4 provenance: signed-out writes are recorded after the write, once per key, with the last value', async (t) => {
  isolate(t);
  userGesture(t, true);
  const namespace = ns('provenanceBatch');
  const [log, days] = [`${namespace}-log`, `${namespace}-days`];
  const page = await openPage(t, [{ namespace, keys: [log, days] }]);
  backingStore.delete('shevato:sync-local-work');

  page.write(log, [{ id: 1 }]);
  page.write(days, { d: 1 });
  page.write(log, [{ id: 1 }, { id: 2 }]);
  assert.equal(backingStore.has('shevato:sync-local-work'), false,
    'nothing is hashed or written inside the app\'s setItem');

  t.mock.timers.tick(1);
  const provenance = stored('shevato:sync-local-work');
  assert.deepEqual(provenance[log], { hash: hashValue([{ id: 1 }, { id: 2 }]), work: true },
    'one record for the key, describing the value it ended on');
  assert.deepEqual(provenance[days], { hash: hashValue({ d: 1 }), work: true });
});

test('S-4 provenance: a page closing before the batch runs still records its writes', async (t) => {
  isolate(t);
  userGesture(t, false);
  const namespace = ns('provenanceClose');
  const key = `${namespace}-log`;
  const page = await openPage(t, [{ namespace, keys: [key] }]);
  backingStore.delete('shevato:sync-local-work');

  page.write(key, ['floor']);
  window.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(stored('shevato:sync-local-work')?.[key], { hash: hashValue(['floor']), work: false },
    'recorded on pagehide, gesture state as it was at the write');
});

test('S-4 provenance: another tab\'s write reaching this tab as a storage event is not recorded as this tab\'s', async (t) => {
  isolate(t);
  // The fallback override (pages without sync-immediate.js) is the path that
  // hears other tabs through `storage` events.
  const saved = { immediateDebug: window.immediateDebug, setItem: localStorage.setItem, removeItem: localStorage.removeItem };
  delete window.immediateDebug;
  t.after(() => {
    window.immediateDebug = saved.immediateDebug;
    localStorage.setItem = saved.setItem;
    localStorage.removeItem = saved.removeItem;
  });
  const namespace = ns('provenanceCrossTab');
  const [theirs, mine] = [`${namespace}-theirs`, `${namespace}-mine`];
  const mod = await import(`${ENGINE}?page=${++pageCounter}`);
  mod.registerLocalNamespaces([{ namespace, keys: [theirs, mine] }]);
  backingStore.delete('shevato:sync-local-work');
  userGesture(t, true);   // this tab has been used; the other tab's write says nothing about that

  backingStore.set(theirs, JSON.stringify(['other tab']));
  const event = new Event('storage');
  Object.assign(event, { key: theirs, newValue: JSON.stringify(['other tab']) });
  window.dispatchEvent(event);
  localStorage.setItem(mine, JSON.stringify(['this tab']));
  t.mock.timers.tick(1);

  const provenance = stored('shevato:sync-local-work') || {};
  assert.equal(provenance[theirs], undefined, 'the tab that wrote it records it');
  assert.deepEqual(provenance[mine], { hash: hashValue(['this tab']), work: true }, 'while this tab\'s own writes still are');
});


// ---------------------------------------------------------------------------
// The sync modules load async (since #535), so a page registers late
// ---------------------------------------------------------------------------
//
// firebase-config.js, storage-sync-robust.js and app-sync-init.js carry
// `async`, so a page's apps can read storage long before its engine registers
// the namespaces. sync-immediate.js, the first script on the page, records the
// ownership tokens before any app runs; the engine compares them.

test('S-2 late registration: another tab moved the data while this page loaded, so the page reloads before syncing', async (t) => {
  isolate(t);
  const namespace = ns('lateRegistration');
  const key = `${namespace}-trips`;
  backingStore.set(key, JSON.stringify(['A trip']));
  backingStore.set(`shevato:sync-revs:${namespace}`, JSON.stringify({
    uid: A.uid, keys: { [key]: { rev: 2, hash: hashValue(['A trip']), updatedAt: 1, dirty: false } }
  }));
  t.after(() => { delete window.__shevatoSyncBoot; backingStore.delete('shevato:sync-ownership-epoch'); });

  // Page X starts loading: sync-immediate.js records the tokens, the apps read A's trip.
  window.__shevatoSyncBoot = { ownershipEpochs: backingStore.get('shevato:sync-ownership-epoch') ?? null };
  // Meanwhile tab Y, already open, signs in as B and sets A's trip aside.
  const tabY = await openPage(t, [{ namespace, keys: [key] }]);
  signIn(B);
  tabY.start(namespace, [key]);
  await settle();
  assert.equal(backingStore.has(key), false, 'tab Y parked A\'s trip');

  // Page X's sync modules register only now, after the move.
  const from = mark();
  const reloadsBefore = reloads.length;
  const pageX = await openPage(t, [{ namespace, keys: [key] }]);
  pageX.start(namespace, [key]);
  await settle();
  assert.equal(reloads.length, reloadsBefore + 1, 'page X reloads: its apps may still hold A\'s trip');
  assert.equal(listenersFor(B.uid, namespace).length, 0, 'and syncs nobody before it has');

  // The app saves what it holds while the reload is under way.
  pageX.write(key, ['A trip', 'edited on X']);
  t.mock.timers.tick(1);

  // The reloaded page reads storage after the move, so its tokens match.
  window.__shevatoSyncBoot = { ownershipEpochs: backingStore.get('shevato:sync-ownership-epoch') ?? null };
  const reloaded = await openPage(t, [{ namespace, keys: [key] }]);
  reloaded.start(namespace, [key]);
  await settle();
  assert.equal(reloads.length, reloadsBefore + 1, 'no second reload');
  emit(B.uid, namespace, {});
  await settle();
  t.mock.timers.tick(600);
  await settle();
  assert.equal(sentText(writesTo(B.uid, from)).includes('A trip'), false, 'A\'s trip never reaches B');
});

test('S-2 late registration: a page whose data nobody moved registers late and syncs without a reload', async (t) => {
  isolate(t);
  const namespace = ns('lateQuiet');
  const key = `${namespace}-trips`;
  backingStore.set(key, JSON.stringify(['B trip']));
  backingStore.set(`shevato:sync-revs:${namespace}`, JSON.stringify({
    uid: B.uid, keys: { [key]: { rev: 1, hash: hashValue(['B trip']), updatedAt: 1, dirty: false } }
  }));
  t.after(() => { delete window.__shevatoSyncBoot; });
  window.__shevatoSyncBoot = { ownershipEpochs: backingStore.get('shevato:sync-ownership-epoch') ?? null };

  const reloadsBefore = reloads.length;
  const page = await openPage(t, [{ namespace, keys: [key] }]);
  signIn(B);
  page.start(namespace, [key]);
  await settle();
  assert.equal(reloads.length, reloadsBefore, 'nothing moved, nothing to reload for');
  assert.equal(listenersFor(B.uid, namespace).length, 1, 'the session starts');
});

test('S-4 provenance: a boot-window write replayed after a click is still the app\'s own', async (t) => {
  isolate(t);
  userGesture(t, true);   // the person clicked before the sync modules finished loading
  const namespace = ns('replayGesture');
  const key = `${namespace}-floor`;
  const page = await openPage(t, [{ namespace, keys: [key] }]);
  backingStore.delete('shevato:sync-local-work');

  page.replay(key, ['floor'], false);
  t.mock.timers.tick(1);
  assert.deepEqual(stored('shevato:sync-local-work')?.[key], { hash: hashValue(['floor']), work: false },
    'recorded with the gesture state the write was made with');
});
