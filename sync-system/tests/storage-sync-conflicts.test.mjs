// Conflict-detection harness for sync-system/storage-sync-robust.js - the
// REAL engine, executed under node:test.
//
// storage-sync-behavior.test.mjs covers the write path, the retry ladder and
// the mechanics of applying a remote change. This file covers the question
// that sits on top of all of it: WHEN IS SOMETHING ACTUALLY A CONFLICT?
//
// It exists because the answer used to be wrong in the loudest possible way.
// `decideRemoteChange` returned 'conflict' for any key that was `dirty` and
// whose remote hash differed, and `dirty` only means "this device has an
// unflushed write". A conflict is a THREE-WAY condition - both sides must
// have moved away from the state they last agreed on - and the second half
// was never checked. So the ordinary sequence
//
//     local write -> commit -> another local write -> echo of commit #1
//
// made a single device conflict with its own Firestore echo, and MapTap
// Rivals' "Sync all rivals" (one write per rival, a few hundred ms apart,
// against a 500 ms debounce) reproduced it several times per press. Every
// one of those told the user "Another device had changed this too" and wrote
// a recovery copy of a value nothing had changed.
//
// The reproductions below are the ones that found the bugs, kept as tests:
//
//   1. Own-write echoes         - the original one-device reproduction, plus
//                                 the minimal race inside it, plus the
//                                 latency-compensated pending-write snapshot.
//   2. Replay storms            - one unresolved disagreement re-fired on
//                                 every listener re-attach, forever.
//   3. Reload safety            - localRevisions was in-memory only, so a
//                                 reload reset the Lamport clock to zero and
//                                 a fresh local edit lost to the cloud on
//                                 revision alone.
//   4. Reconcile                - visibilitychange rebuilt the revision
//                                 record without `dirty`, silently
//                                 downgrading a pending edit to a clean one.
//   5. Chunked values           - applyChunkedRemoteChange dropped a
//                                 'conflict' verdict on the floor, so a
//                                 genuine cross-device conflict on a value
//                                 past the inline threshold was discarded.
//   6. Real conflicts           - everything above must not have blunted the
//                                 detector: two genuinely divergent clients
//                                 still merge, still pick a winner, still
//                                 keep a copy and still tell the page.
//   7. Derived-value policy     - a regenerable cache converges without
//                                 bothering the user about it.
//
// The engine is a module-level singleton, so tests share one manager.
// Isolation comes from per-test namespaces and per-test key names.

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
// Browser globals the engine touches at import time.
// ---------------------------------------------------------------------------

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
    tabId: 'conflict-test-tab',
    isLive: false,
    publish: () => {},
    subscribe: () => () => {},
    close: () => {}
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

const { authFakes } = await import('./helpers/firebase-config-stub.mjs');
const { firestoreFakes, isServerTimestampSentinel } =
  await import('./helpers/firestore-stub.mjs');

const USER = { uid: 'uid-1', getIdToken: async () => 'fake-token' };
authFakes().currentUser = USER;

const mod = await import('../storage-sync-robust.js');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function conflictIndex() {
  try { return JSON.parse(backingStore.get('shevato:sync-conflicts') || '[]'); }
  catch { return []; }
}
function conflictCopyValue(id) {
  return JSON.parse(backingStore.get(id)).value;
}

let nsCounter = 0;

/**
 * A namespace wired to a Firestore that behaves like the real one: a commit
 * lands in a server-side document, its serverTimestamp() sentinels resolve
 * to a monotonically increasing clock, and the resulting body comes back
 * through the onSnapshot listener when the test says so.
 *
 * That deferred echo is the whole point. The false conflicts were never
 * caused by a peer; they were caused by this client's own commit arriving
 * back a moment after the next local write had been queued, and a harness
 * that echoes synchronously cannot reproduce that at all.
 */
async function startClient(t, shortKeys, { policies, namespace: reuse, seedCloud } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const namespace = reuse || `conflictNs${++nsCounter}`;
  const keys = shortKeys.map((k) => `${namespace}:${k}`);
  const docPath = `users/${USER.uid}/apps/${namespace}`;

  const declared = {};
  if (policies) for (const [short, policy] of Object.entries(policies)) declared[`${namespace}:${short}`] = policy;

  // The server-side document, and the pending commits waiting to be echoed.
  const cloud = seedCloud ? { ...seedCloud } : {};
  let serverClock = 1_700_000_000_000;
  let consumed = 0;

  const handle = mod.startStorageSync({ namespace, keys, policies: declared });
  await settle();

  const listener = () =>
    firestoreFakes().snapshotListeners.filter((l) => l.path === docPath && l.active).pop();

  /** Push the current server document at the listener. */
  const deliver = ({ fromCache = false, hasPendingWrites = false } = {}) => {
    const l = listener();
    assert.ok(l, 'no active snapshot listener');
    l.onNext({
      data: () => ({ data: { ...cloud } }),
      metadata: { fromCache, hasPendingWrites }
    });
  };

  /**
   * Commit everything this client has written since the last call into the
   * server document, resolving the timestamps, WITHOUT delivering it. The
   * test decides when the echo arrives, which is what lets it place a local
   * write inside the commit-to-echo window.
   */
  const commitPending = () => {
    const calls = firestoreFakes().setDocCalls;
    let committed = 0;
    for (; consumed < calls.length; consumed++) {
      const call = calls[consumed];
      if (call.path !== docPath) continue;                 // chunk part documents
      const ts = ++serverClock;
      for (const [key, entry] of Object.entries(call.payload.data || {})) {
        const resolved = { ...entry };
        if (isServerTimestampSentinel(resolved.updatedAt)) resolved.updatedAt = ts;
        cloud[key] = resolved;
      }
      committed++;
    }
    return committed;
  };

  /** Everything in one go: commit this client's writes, then echo them back. */
  const commitAndEcho = async () => {
    commitPending();
    deliver();
    await settle();
  };

  /** A write from somewhere else: a peer, another tab, an earlier session. */
  const peerWrite = (shortKey, value, rev) => {
    cloud[`${namespace}:${shortKey}`] = {
      value, rev, updatedAt: ++serverClock, hash: hashValue(value)
    };
  };

  const conflicts = [];
  const onConflict = (e) => { if (String(e.detail.key).startsWith(namespace + ':')) conflicts.push(e.detail); };
  windowTarget.addEventListener('syncConflict', onConflict);

  const copyBase = conflictIndex().length;

  t.after(() => {
    windowTarget.removeEventListener('syncConflict', onConflict);
    handle.stop();
  });

  return {
    namespace, keys, docPath, cloud, handle,
    deliver, commitPending, commitAndEcho, peerWrite,
    conflicts,
    copies: () => conflictIndex().slice(copyBase).filter((c) => String(c.key).startsWith(namespace + ':')),
    commits: () => firestoreFakes().setDocCalls.filter((c) => c.path === docPath),
    /** Drop every in-memory trace of this namespace: a page reload. */
    reload: async () => {
      mod.stopSync(namespace);
      await settle();
      const next = mod.startStorageSync({ namespace, keys, policies: declared });
      await settle();
      return next;
    }
  };
}

/* =========================================================================
 * 1. Own-write echoes
 * ====================================================================== */

test('THE ORIGINAL REPRODUCTION: one device, one tab, one Sync-all run, zero conflicts', async (t) => {
  // Verbatim shape of the MapTap Rivals bug report. One browser, one tab,
  // no peer anywhere. "Sync all rivals" walks five rivals; each one restamps
  // the profile snapshot and appends to the game log and the day map; the
  // 500 ms debounce turns those into a commit per rival; and the echo of
  // each commit lands AFTER the next rival's write has been queued.
  //
  // That is the exact interleaving that produced four "Another device had
  // changed this too" banners and four recovery copies per press.
  const h = await startClient(t, ['games', 'days', 'profile']);
  const [kGames, kDays, kProfile] = h.keys;

  const games = [{ id: 'g0', rivalId: 'r0', date: '2026-08-01', myScore: 500 }];
  const days = { '2026-08-01': [{ lat: 1, lng: 2 }] };
  localStorage.setItem(kGames, JSON.stringify(games));
  localStorage.setItem(kDays, JSON.stringify(days));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();                      // this device is settled and in sync

  const RIVALS = ['alice', 'bex', 'cy', 'dee', 'eve'];
  const verifiedAt = '2026-09-09T12:00:00.000Z';

  for (let i = 0; i < RIVALS.length; i++) {
    // The MapTap fetch for this rival: longer than the debounce, shorter
    // than the commit-to-echo round trip. This is the window.
    t.mock.timers.tick(700);
    await settle();

    localStorage.setItem(kProfile, JSON.stringify({ nickname: 'nikita', totalGames: 100 + i, verifiedAt }));
    games.push({ id: `g${i + 1}`, rivalId: `r${i}`, date: `2026-09-0${i + 1}`, myScore: 600 });
    days[`2026-09-0${i + 1}`] = [{ lat: 3, lng: 4 }];
    localStorage.setItem(kDays, JSON.stringify(days));
    localStorage.setItem(kGames, JSON.stringify(games));

    t.mock.timers.tick(500);                    // debounce fires, commit goes out
    await settle();
    h.commitPending();

    // The echo of THIS commit is deliberately not delivered yet. It arrives
    // below, after the NEXT rival's writes are already queued and dirty.
    if (i > 0) { h.deliver(); await settle(); }
  }
  await h.commitAndEcho();

  assert.deepEqual(h.conflicts, [], 'a device must never conflict with its own Firestore echo');
  assert.deepEqual(h.copies(), [], 'and must never write a recovery copy of its own write');

  assert.equal(JSON.parse(backingStore.get(kGames)).length, 6, 'every game survived');
  assert.equal(Object.keys(JSON.parse(backingStore.get(kDays))).length, 6, 'every day survived');
  assert.equal(JSON.parse(backingStore.get(kProfile)).totalGames, 104, 'the newest profile snapshot is live');
});

test('the echo of commit N, arriving after local write N+1, is recognised as ours', async (t) => {
  // The original reproduction boiled down to its three moves.
  const h = await startClient(t, ['v']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ n: 1 }));
  t.mock.timers.tick(500);
  await settle();
  h.commitPending();                            // commit #1 is on the server

  localStorage.setItem(k, JSON.stringify({ n: 2 }));   // ...and now we write again
  await settle();

  h.deliver();                                  // commit #1 finally echoes back
  await settle();

  assert.deepEqual(h.conflicts, [], 'our own commit is not another device');
  assert.deepEqual(JSON.parse(backingStore.get(k)), { n: 2 }, 'the newer local value stands');
});

test('an own-write echo is still recognised after the token list has rolled over', async (t) => {
  // The in-memory token list is deliberately small. Past it, the agreed
  // BASE HASH is what proves an incoming body is one we already published,
  // and that record is on disk rather than in memory - which is also what
  // makes recognition survive a reload.
  const h = await startClient(t, ['v']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ n: 0 }));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  const echoOfFirst = { ...h.cloud[k] };

  for (let n = 1; n <= 20; n++) {               // well past MAX_OWN_WRITE_TOKENS
    localStorage.setItem(k, JSON.stringify({ n }));
    t.mock.timers.tick(500);
    await settle();
    await h.commitAndEcho();
  }

  assert.deepEqual(h.conflicts, [], 'no conflict during twenty of our own round trips');

  // A very late redelivery of the FIRST commit, long since aged out of the
  // token list. It is older than everything, so it is stale rather than a
  // conflict, and either way it is not somebody else's edit.
  h.cloud[k] = echoOfFirst;
  h.deliver();
  await settle();
  assert.deepEqual(h.conflicts, [], 'a stale redelivery of our own old commit is not a conflict');
  assert.deepEqual(JSON.parse(backingStore.get(k)), { n: 20 }, 'and it does not roll the value back');
});

test('a pending-write snapshot carries no news and is not treated as one', async (t) => {
  // Firestore delivers un-acknowledged writes straight back with
  // hasPendingWrites true and every serverTimestamp() still unresolved.
  const h = await startClient(t, ['v']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ n: 1 }));
  t.mock.timers.tick(500);
  await settle();

  // The latency-compensated view: our own entry, timestamp not yet resolved.
  h.cloud[k] = { value: { n: 1 }, rev: 1, updatedAt: null, hash: hashValue({ n: 1 }) };
  localStorage.setItem(k, JSON.stringify({ n: 2 }));
  await settle();
  h.deliver({ hasPendingWrites: true });
  await settle();

  assert.deepEqual(h.conflicts, [], 'a pending-write view is not a remote edit');
  assert.deepEqual(JSON.parse(backingStore.get(k)), { n: 2 });
});

/* =========================================================================
 * 2. Replay storms
 * ====================================================================== */

test('one genuine conflict stays one, however many times the snapshot replays', async (t) => {
  // Firestore re-emits the whole document on every listener re-attach
  // (network blip, tab focus, SDK session refresh). The local-wins branch
  // used to return without recording that it had considered the entry, so
  // every re-attach re-resolved the SAME body: another banner, another
  // recovery copy, until the twenty-copy cap started evicting evidence.
  const h = await startClient(t, ['v']);
  const [k] = h.keys;

  // A plain string, so the disagreement is genuinely unmergeable and a
  // recovery copy is written every time it is resolved. That is what makes
  // the replay count visible: under the old behaviour six re-attaches left
  // six copies behind.
  localStorage.setItem(k, 'original');
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  // A genuine peer edit, and a local edit on top of it that never flushes.
  h.peerWrite('v', 'theirs', 1);
  localStorage.setItem(k, 'mine, written later');
  await settle();

  for (let i = 0; i < 6; i++) { h.deliver(); await settle(); }

  assert.equal(h.conflicts.length, 1, 'six identical re-attaches, one conflict');
  assert.equal(h.copies().length, 1, 'and exactly one recovery copy');
});

test('a replayed snapshot cannot re-fire a conflict even with a fresh timestamp', async (t) => {
  // Belt and braces: the (rev, hash) of a body already resolved is
  // remembered, so a redelivery cannot sneak past on a newer clock reading.
  const h = await startClient(t, ['v']);
  const [k] = h.keys;

  localStorage.setItem(k, 'original');
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  h.peerWrite('v', 'theirs', 5);
  localStorage.setItem(k, 'mine');
  await settle();
  h.deliver();
  await settle();
  assert.equal(h.conflicts.length, 1);

  const replay = { ...h.cloud[k] };
  for (let i = 0; i < 4; i++) {
    replay.updatedAt += 1000;                   // same rev, same hash, later clock
    h.cloud[k] = { ...replay };
    h.deliver();
    await settle();
  }
  assert.equal(h.conflicts.length, 1, 'identical content is identical content');
  assert.equal(h.copies().length, 1);
});

/* =========================================================================
 * 3. Reload safety
 * ====================================================================== */

test('RELOAD: a fresh local edit is not lost to a higher cloud revision', async (t) => {
  // The data-loss path found in the diagnosis. localRevisions was in-memory
  // only, so a reload reset the Lamport clock to zero: the first edit the
  // user made after opening the page was rev 1 against a cloud sitting at
  // rev 40, pickConflictWinner handed the cloud the win on revision alone,
  // and the just-made local edit survived only as a recovery copy nothing
  // in the app could reach.
  const h = await startClient(t, ['doc']);
  const [k] = h.keys;

  // A plain string, so nothing can merge and the outcome turns purely on
  // the revision comparison - which is the thing the reload used to reset.
  //
  // Get this device up to a high revision the honest way.
  for (let n = 1; n <= 40; n++) {
    localStorage.setItem(k, `edit ${n}`);
    t.mock.timers.tick(500);
    await settle();
    await h.commitAndEcho();
  }
  assert.equal(h.cloud[k].rev, 40, 'forty revisions deep, on both ends');

  await h.reload();                             // <- the page reloads here

  // The user types something the moment the page comes back...
  localStorage.setItem(k, 'typed after the reload');
  await settle();

  // ...and the cloud has genuinely moved on too, so this cannot be waved
  // away as "the cloud has not changed": it is a real conflict, and the
  // question is only whether the fresh local edit is allowed to compete.
  h.peerWrite('doc', 'from the other device', 40);
  h.deliver();
  await settle();

  assert.equal(h.conflicts.length, 1, 'a real disagreement is still reported');
  assert.equal(h.conflicts[0].resolution, 'local-wins');
  assert.equal(
    backingStore.get(k),
    'typed after the reload',
    'the edit made after the reload wins on revision 41, not loses on revision 1'
  );
  assert.equal(h.copies()[0].reason, 'remote-superseded', 'and the other side is what is preserved');
});

test('RELOAD: an unchanged cloud is not a conflict at all after a restart', async (t) => {
  // The commoner half of the same reload story: nothing has happened
  // anywhere else, the cloud is exactly where this device left it, and the
  // first snapshot after the reload must be silent.
  const h = await startClient(t, ['doc']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ v: 1 }));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  await h.reload();

  localStorage.setItem(k, JSON.stringify({ v: 2 }));
  await settle();
  h.deliver();                                  // the cloud, still holding v: 1
  await settle();

  assert.deepEqual(h.conflicts, [], 'an unchanged cloud has not "also been changed"');
  assert.deepEqual(JSON.parse(backingStore.get(k)), { v: 2 });
});

test('RELOAD: a value edited while the app was closed comes back as unacknowledged', async (t) => {
  // An import, another tab, a hand edit: whatever moved the value, it is not
  // what the cloud acknowledged, so it must come back dirty rather than as a
  // clean copy the next remote delivery may silently replace.
  const h = await startClient(t, ['doc']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ v: 1 }));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  mod.stopSync(h.namespace);
  await settle();
  backingStore.set(k, JSON.stringify({ v: 'changed while we were away' }));   // behind the engine's back
  const restarted = mod.startStorageSync({ namespace: h.namespace, keys: h.keys });
  t.after(() => restarted.stop());
  await settle();

  h.peerWrite('doc', { v: 'from the peer' }, 9);
  h.deliver();
  await settle();

  assert.equal(h.conflicts.length, 1, 'the offline edit is defended, not overwritten in silence');
  assert.equal(h.copies().length, 1);
});

test('RELOAD: revisions saved by one account are never inherited by another', async (t) => {
  const h = await startClient(t, ['doc']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ v: 1 }));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  const stored = JSON.parse(backingStore.get(`shevato:sync-revs:${h.namespace}`));
  assert.equal(stored.uid, 'uid-1', 'the stored map names the account that wrote it');

  mod.stopSync(h.namespace);
  await settle();
  authFakes().currentUser = { uid: 'uid-2', getIdToken: async () => 'fake-token' };
  const other = mod.startStorageSync({ namespace: h.namespace, keys: h.keys });
  t.after(() => {
    other.stop();
    authFakes().currentUser = USER;
  });
  await settle();

  const status = mod.getSyncStatus(h.namespace);
  assert.ok(status && status.active, 'the second account syncs normally');
  // Its revision map starts empty rather than inheriting uid-1's counters:
  // a first write from uid-2 is rev 1, not rev 2.
  localStorage.setItem(k, JSON.stringify({ v: 'uid-2 writes' }));
  t.mock.timers.tick(500);
  await settle();
  const own = firestoreFakes().setDocCalls
    .filter((c) => c.path === `users/uid-2/apps/${h.namespace}`).pop();
  assert.ok(own, 'the write goes to the second account’s own document');
  assert.equal(own.payload.data[k].rev, 1, 'and starts its own revision sequence');
});

/* =========================================================================
 * 4. Reconcile
 * ====================================================================== */

test('a focus reconcile does not downgrade a pending local edit to a clean one', async (t) => {
  // reconcileFromLocalStorage rebuilt the revision record from scratch and
  // simply omitted `dirty`, so bringing the tab to the foreground turned an
  // unacknowledged edit into a "clean" copy that the next remote delivery
  // was entitled to overwrite without even calling it a conflict.
  const h = await startClient(t, ['doc']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ v: 1 }));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  // An edit made behind the engine's back (a peer tab in this browser), so
  // reconcile is what discovers it - exactly the path that lost the flag.
  backingStore.set(k, JSON.stringify({ v: 'edited in another tab' }));
  for (const fn of documentListeners.get('visibilitychange') || []) fn();
  await settle();

  h.peerWrite('doc', { v: 'from the other device' }, 7);
  h.deliver();
  await settle();

  assert.equal(h.conflicts.length, 1, 'the discovered edit is unacknowledged work and is defended');
  assert.deepEqual(
    JSON.parse(backingStore.get(k)),
    { v: 'edited in another tab' },
    'it is not silently replaced by the remote value'
  );
});

/* =========================================================================
 * 5. Chunked values - one conflict system, whatever the size
 * ====================================================================== */

// Comfortably past MAX_INLINE_VALUE_CHARS (128 K) ON ITS OWN, so a value
// built from a single one of these is already stored out of line as part
// documents plus a manifest.
const FAT = 'x'.repeat(140 * 1024);
const bigRecords = (ids) => ids.map((id) => ({ id, blob: FAT }));

/**
 * Guard against the fixtures quietly shrinking back under the inline
 * threshold, which would leave these tests passing while testing nothing
 * about chunked storage at all.
 */
function assertStoredOutOfLine(h, key, why) {
  const last = h.commits().filter((c) => c.payload.data && c.payload.data[key]).pop();
  assert.ok(last, `${why}: expected a commit carrying ${key}`);
  assert.equal(last.payload.data[key].chunked, true, `${why}: the fixture must exceed the inline threshold`);
}

/** Put a chunked value into the cloud the way a peer's commit would. */
async function seedChunkedPeerValue(h, shortKey, value, rev) {
  const key = `${h.namespace}:${shortKey}`;
  const serialised = JSON.stringify(value);
  const { splitIntoChunks } = await import('../sync-helpers.mjs');
  const version = `${rev}-${hashValue(value)}`.replace(/[^A-Za-z0-9_-]/g, '');
  const parts = splitIntoChunks(serialised, 128 * 1024);
  const readable = String(key).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  const stem = `${readable}-${hashValue(key)}`;
  const { docs } = firestoreFakes();
  parts.forEach((part, seq) => {
    docs.set(`${h.docPath}/chunks/${stem}__v${version}__${seq}`, { key, seq, part, version });
  });
  h.cloud[key] = {
    chunked: true, parts: parts.length, rev,
    updatedAt: Date.now() + rev, hash: hashValue(value),
    chunkVersion: version, chars: serialised.length
  };
}

test('CHUNKED: a genuine mergeable conflict merges instead of being discarded', async (t) => {
  // applyChunkedRemoteChange used to `return` on any verdict but 'apply', so
  // a real cross-device conflict on a value big enough to be chunked was
  // thrown away: no merge, no copy, no message, and this device's next flush
  // overwrote the other side. MapTap Rivals' game log crosses the inline
  // threshold at roughly a thousand rows, so heavy users were exactly the
  // ones losing data.
  const h = await startClient(t, ['log']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify(bigRecords(['a', 'b'])));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();
  assertStoredOutOfLine(h, k, 'chunked mergeable conflict');

  localStorage.setItem(k, JSON.stringify(bigRecords(['a', 'b', 'mine'])));
  await settle();
  await seedChunkedPeerValue(h, 'log', bigRecords(['a', 'b', 'theirs']), 9);
  h.deliver();
  await settle(12);

  assert.equal(h.conflicts.length, 1, 'a chunked conflict is reported like any other');
  assert.equal(h.conflicts[0].resolution, 'merged');
  assert.deepEqual(
    JSON.parse(backingStore.get(k)).map((r) => r.id).sort(),
    ['a', 'b', 'mine', 'theirs'],
    'both devices’ records survive a conflict on an out-of-line value'
  );
  assert.equal(h.copies().length, 0, 'a clean merge loses nothing, so preserves nothing');
});

// A long STRING has no internal structure to reconcile, so it exercises the
// deterministic-winner half of the resolver rather than the merge half - and
// it is well past the inline threshold, so it exercises it out of line.
const bigString = (tag) => `${tag}:${FAT}`;

test('CHUNKED: a non-mergeable conflict picks a winner and keeps the loser', async (t) => {
  const h = await startClient(t, ['blob']);
  const [k] = h.keys;

  localStorage.setItem(k, bigString('base'));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();
  assertStoredOutOfLine(h, k, 'chunked non-mergeable conflict');

  localStorage.setItem(k, bigString('mine'));
  await settle();
  await seedChunkedPeerValue(h, 'blob', bigString('theirs'), 9);
  h.deliver();
  await settle(12);

  assert.equal(h.conflicts.length, 1);
  assert.ok(['local-wins', 'remote-wins'].includes(h.conflicts[0].resolution));
  const live = backingStore.get(k);
  assert.ok([bigString('mine'), bigString('theirs')].includes(live), 'the live value is one of the two');
  assert.equal(h.copies().length, 1, 'the losing side is recoverable');
  const kept = conflictCopyValue(h.copies()[0].id);
  assert.deepEqual([live, kept].sort(), [bigString('mine'), bigString('theirs')].sort(),
    'live and preserved are the two versions that conflicted');
});

test('CHUNKED: local wins on the higher revision, and republishes', async (t) => {
  const h = await startClient(t, ['blob']);
  const [k] = h.keys;

  for (let n = 0; n < 3; n++) {                 // climb to rev 3 locally
    localStorage.setItem(k, bigString(`v${n}`));
    t.mock.timers.tick(500);
    await settle();
    await h.commitAndEcho();
  }
  localStorage.setItem(k, bigString('mine'));
  await settle();
  await seedChunkedPeerValue(h, 'blob', bigString('theirs'), 1);   // an older peer
  h.deliver();
  await settle(12);

  assert.equal(h.conflicts[0].resolution, 'local-wins');
  assert.equal(backingStore.get(k), bigString('mine'), 'the higher revision stays live');
  assert.equal(h.copies().length, 1);
  assert.equal(conflictCopyValue(h.copies()[0].id), bigString('theirs'), 'the superseded remote is kept');
  t.mock.timers.tick(500);
  await settle();
  const last = h.commits().pop();
  assert.equal(last.payload.data[k].chunked, true, 'the winner is republished so the cloud converges');
});

test('CHUNKED: remote wins on the higher revision, and the local copy is recoverable', async (t) => {
  const h = await startClient(t, ['blob']);
  const [k] = h.keys;

  localStorage.setItem(k, bigString('base'));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();
  assertStoredOutOfLine(h, k, 'chunked remote-wins');

  localStorage.setItem(k, bigString('mine'));
  await settle();
  await seedChunkedPeerValue(h, 'blob', bigString('theirs'), 50);   // far ahead
  h.deliver();
  await settle(12);

  assert.equal(h.conflicts[0].resolution, 'remote-wins');
  assert.equal(backingStore.get(k), bigString('theirs'), 'the later revision becomes live');
  assert.equal(conflictCopyValue(h.copies()[0].id), bigString('mine'), 'and ours is preserved, not dropped');
});

test('CHUNKED: this device’s own echo of a chunked write is not a conflict', async (t) => {
  const h = await startClient(t, ['log']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify(bigRecords(['a'])));
  t.mock.timers.tick(500);
  await settle();
  assertStoredOutOfLine(h, k, 'chunked own echo');
  h.commitPending();                            // manifest committed, not yet echoed

  localStorage.setItem(k, JSON.stringify(bigRecords(['a', 'b'])));   // write again first
  await settle();
  h.deliver();                                  // now the first manifest comes back
  await settle(12);

  assert.deepEqual(h.conflicts, [], 'a chunked own-write echo is still our own write');
  assert.deepEqual(JSON.parse(backingStore.get(k)).map((r) => r.id), ['a', 'b']);
});

/* =========================================================================
 * 6. Real conflicts are still detected
 * ====================================================================== */

test('REAL CONFLICT: two clients adding different records still merge', async (t) => {
  const h = await startClient(t, ['games']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify([{ id: 'shared', v: 1 }]));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  localStorage.setItem(k, JSON.stringify([{ id: 'shared', v: 1 }, { id: 'mine', v: 2 }]));
  await settle();
  h.peerWrite('games', [{ id: 'shared', v: 1 }, { id: 'theirs', v: 3 }], 2);
  h.deliver();
  await settle();

  assert.equal(h.conflicts.length, 1, 'a genuine two-client divergence is still noticed');
  assert.equal(h.conflicts[0].resolution, 'merged');
  assert.deepEqual(
    JSON.parse(backingStore.get(k)).map((r) => r.id).sort(),
    ['mine', 'shared', 'theirs']
  );
});

test('REAL CONFLICT: a deletion on one side is honoured, not resurrected', async (t) => {
  const h = await startClient(t, ['games']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify([{ id: 'a', v: 1 }, { id: 'b', v: 1 }]));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  localStorage.setItem(k, JSON.stringify([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }]));
  await settle();
  h.peerWrite('games', [{ id: 'a', v: 1 }], 2);       // the peer deleted 'b'
  h.deliver();
  await settle();

  assert.deepEqual(
    JSON.parse(backingStore.get(k)).map((r) => r.id).sort(),
    ['a', 'c'],
    'their deletion sticks and our addition survives'
  );
});

test('REAL CONFLICT: a merge this device has only queued is still unacknowledged work', async (t) => {
  // Found while fixing the rest of this. resolveConflict queues the merged
  // value through publishResolved, which marks it dirty - and the apply path
  // then stamped it clean a moment later. So between producing a merge and
  // managing to upload it, this device believed its own merge had come from
  // the cloud, and a second remote delivery could replace it outright
  // instead of merging into it. The second peer's record would be kept and
  // the first merge's additions quietly dropped.
  const h = await startClient(t, ['games']);
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify([{ id: 'base', v: 1 }]));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  localStorage.setItem(k, JSON.stringify([{ id: 'base', v: 1 }, { id: 'mine', v: 1 }]));
  await settle();
  h.peerWrite('games', [{ id: 'base', v: 1 }, { id: 'peer1', v: 1 }], 2);
  h.deliver();
  await settle();
  assert.equal(h.conflicts.length, 1, 'first merge happened');

  // A SECOND peer edit arrives before this device manages to flush its merge.
  // Relative to what the cloud last sent, the peer has added peer2 and
  // dropped peer1, so peer1 going is the correct three-way answer - but
  // `mine` was never in anything the cloud sent and must survive.
  h.peerWrite('games', [{ id: 'base', v: 1 }, { id: 'peer2', v: 1 }], 3);
  h.deliver();
  await settle();

  assert.deepEqual(
    JSON.parse(backingStore.get(k)).map((r) => r.id).sort(),
    ['base', 'mine', 'peer2'],
    'the un-uploaded merge is defended and merged into, not replaced wholesale'
  );
});

test('REAL CONFLICT: a genuinely unmergeable value still warns and still preserves', async (t) => {
  const h = await startClient(t, ['name']);
  const [k] = h.keys;

  localStorage.setItem(k, 'original');
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  localStorage.setItem(k, 'mine');
  await settle();
  h.peerWrite('name', 'theirs', 5);
  h.deliver();
  await settle();

  assert.equal(h.conflicts.length, 1, 'the page is told');
  assert.ok(['local-wins', 'remote-wins'].includes(h.conflicts[0].resolution));
  assert.equal(h.copies().length, 1, 'and the losing string is recoverable');
  const kept = conflictCopyValue(h.copies()[0].id);
  const live = backingStore.get(k);
  assert.deepEqual([live, kept].sort(), ['mine', 'theirs'], 'live and preserved are the two versions');
});

test('REAL CONFLICT: recovery copies are reachable through the public API', async (t) => {
  // The message promises "a copy was saved on this device". Nothing in the
  // site could reach one, which made the promise unredeemable; there is no
  // management screen for a situation this rare, but the data itself is
  // exposed rather than merely asserted to exist.
  const h = await startClient(t, ['name']);
  const [k] = h.keys;

  localStorage.setItem(k, 'original');
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();
  localStorage.setItem(k, 'mine');
  await settle();
  h.peerWrite('name', 'theirs', 5);
  h.deliver();
  await settle();

  const listed = mod.listConflictCopies().filter((c) => c.key === k);
  assert.equal(listed.length, 1);
  const copy = mod.readConflictCopy(listed[0].id);
  assert.equal(copy.key, k);
  assert.ok(['mine', 'theirs'].includes(copy.value));
  assert.equal(mod.readConflictCopy('shevato:sync-conflict:not-a-real-id'), null);
});

/* =========================================================================
 * 7. Derived values
 * ====================================================================== */

test('DERIVED: a regenerable cache converges without a copy or a warning', async (t) => {
  // A fetched profile snapshot or a "which rival am I looking at" selection.
  // Both ends still have to agree, so a deterministic winner is still
  // chosen, but there is nothing the user typed to recover and nothing for
  // them to do about it, so no copy is kept and no banner is raised.
  const h = await startClient(t, ['profile'], { policies: { profile: 'derived' } });
  const [k] = h.keys;

  localStorage.setItem(k, JSON.stringify({ nickname: 'nikita', verifiedAt: 'T0' }));
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  localStorage.setItem(k, JSON.stringify({ nickname: 'nikita', verifiedAt: 'T1' }));
  await settle();
  h.peerWrite('profile', { nickname: 'nikita', verifiedAt: 'T2' }, 9);
  h.deliver();
  await settle();

  assert.deepEqual(h.conflicts, [], 'a cache disagreement is not the user’s problem');
  assert.deepEqual(h.copies(), [], 'and is not worth a recovery copy');
  const live = JSON.parse(backingStore.get(k));
  assert.ok(['T1', 'T2'].includes(live.verifiedAt), 'one of the two wins, deterministically');
});

test('DERIVED: the policy is per key, not per namespace', async (t) => {
  const h = await startClient(t, ['profile', 'games'], { policies: { profile: 'derived' } });
  const [kProfile, kGames] = h.keys;

  localStorage.setItem(kProfile, JSON.stringify({ v: 0 }));
  localStorage.setItem(kGames, 'plain-user-data');
  t.mock.timers.tick(500);
  await settle();
  await h.commitAndEcho();

  localStorage.setItem(kProfile, JSON.stringify({ v: 1 }));
  localStorage.setItem(kGames, 'mine');
  await settle();
  h.peerWrite('profile', { v: 2 }, 9);
  h.peerWrite('games', 'theirs', 9);
  h.deliver();
  await settle();

  assert.equal(h.conflicts.length, 1, 'only the non-derived key raises anything');
  assert.equal(h.conflicts[0].key, kGames);
  assert.deepEqual(h.copies().map((c) => c.key), [kGames]);
});
