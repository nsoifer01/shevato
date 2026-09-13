// Robust bidirectional localStorage ↔ Firebase sync module
// Improved version with better conflict resolution and reliability

import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  deleteField,
  deleteDoc,
  waitForPendingWrites,
  collection,
  collectionGroup,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { auth } from '../firebase-config.js';
import { db } from '../firebase-firestore.js';
import { createCrossTabChannel, CHANNEL_MESSAGE_TYPES } from './cross-tab-channel.mjs';
import {
  hashValue,
  parseValue,
  getTimestamp,
  sanitiseForFirestore,
  estimatePayloadBytes,
  sameKeySet,
  decideRemoteChange,
  remoteToken,
  pickConflictWinner,
  valueIndex,
  mergeValues,
  requeueFailedWrites,
  isPermanentWriteError,
  splitIntoChunks,
  planFlushBatches
} from './sync-helpers.mjs';

// Configuration
const DEBOUNCE_MS = 500; // Balanced: catches keystroke bursts without thrashing Firestore quota
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
// Auth-specific retry budget. On cold boot, `auth.currentUser` is restored
// from IndexedDB synchronously, but the first ID-token mint requires a
// network roundtrip; if onSnapshot attaches inside that window the listen
// request reaches Firestore with no token and the security rules return
// permission-denied. We retry on a tighter schedule than the generic
// network-error path because in practice the token usually lands in under
// 1s. Total budget: 250 + 500 + 1000 + 2000 = 3.75s.
const MAX_AUTH_RETRY_ATTEMPTS = 4;
const AUTH_RETRY_BASE_MS = 250;
// Firestore rejects documents > 1 MiB. We refuse to flush above 700 KB so a
// single namespace can't silently lose writes once payloads grow. With
// chunking (below) this is a last line of defence rather than a ceiling an
// app can actually grow into: every entry that would approach it is written
// out of line first, and what remains is split across commits.
const MAX_FLUSH_BYTES = 700 * 1024;

// --- Out-of-line values -----------------------------------------------
//
// One document per namespace does not scale: an app whose data grows with
// use (MapTap Rivals' game log grows as days x rivals) eventually cannot be
// written at all, and every write before that point re-ships the whole
// value. Rather than raise the ceiling (a bigger monolithic document is
// the same architecture with a later failure date), a value past this size
// is stored as an ordered run of part documents under
// `users/<uid>/apps/<ns>/chunks/`, leaving a small manifest inline:
//
//   data[key] = { chunked: true, parts: N, rev, updatedAt, hash }
//
// Reads reassemble the parts and then take exactly the same path an inline
// value takes, so nothing above this module can tell the difference. A
// value that shrinks back under the threshold returns to inline storage and
// its parts are deleted. Documents written before this existed carry no
// `chunked` flag and keep being read as plain inline values, so the format
// is backward-compatible in both directions.
//
// The deployed security rules already cover the subcollection: the
// recursive `match /users/{userId}/{document=**}` in firestore.rules grants
// the owner read/write over everything beneath their own user document.
//
// 128 K UTF-16 units is at most ~384 KB of UTF-8 in the worst case (every
// character 3 bytes), comfortably inside the 1 MiB per-document limit, and
// small enough that several changed keys still batch into one commit.
const MAX_INLINE_VALUE_CHARS = 128 * 1024;
const CHUNK_CHARS = 128 * 1024;
const CHUNK_COLLECTION = 'chunks';

// LEGACY device-wide owner marker, written before ownership was recorded per
// namespace (see lineageOf). Only read now, as evidence for local data this
// device synced before 2026-09-13. Not part of any namespace's key set.
const SYNC_OWNER_KEY = 'shevato:sync-owner';
// Another account's unsynced local work, kept on this device when a different
// account starts syncing the same namespace here (2026-09-12 audit S-2). One
// record per namespace with one slot per owning account, so switching back and
// forth replaces rather than accumulates. Never synced, never uploaded.
const SYNC_PARKED_KEY_PREFIX = 'shevato:sync-parked:';
// Whether each registered key's local value was produced by a person or only by
// an app writing its own defaults, recorded while no session owns the key
// (audit S-4). Never synced.
const SYNC_LOCAL_WORK_KEY = 'shevato:sync-local-work';
// The account-deletion latch (audit S-5), shared by every tab of the origin and
// read synchronously before anything is started, merged or sent.
const SYNC_DELETION_KEY = 'shevato:sync-deletion';
// { namespace: token }, changed before local data is moved for an account.
const SYNC_OWNERSHIP_EPOCH_KEY = 'shevato:sync-ownership-epoch';
// The owner of local data some account synced before per-namespace ownership
// existed, when that account cannot be named. Never equal to a real uid.
const UNKNOWN_OWNER = '?';
// A deletion whose tab has stopped confirming it is alive for this long is
// abandoned (the tab was closed or crashed), so it cannot disable sync for the
// account forever. Only consulted where no Web Locks API can answer exactly.
const DELETION_HEARTBEAT_MS = 2000;
const DELETION_STALE_MS = 30000;
// Deleted accounts stay latched (a stale tab can hold a still-valid ID token
// for up to an hour after the account is gone); only the most recent few.
const MAX_DELETED_ACCOUNTS_REMEMBERED = 10;
// Where the three-way merge base and the conflict copies live. All three are
// plain keys outside every namespace's key set, so none of them is ever
// itself synced and notifyLocalChange ignores them.
const SYNC_BASE_KEY_PREFIX = 'shevato:sync-base:';
const CONFLICT_KEY_PREFIX = 'shevato:sync-conflict:';
const CONFLICT_INDEX_KEY = 'shevato:sync-conflicts';
// Where the per-key revision map is parked between sessions. Same rules as
// the three above: a plain key outside every namespace's key set, so it is
// never itself synced and notifyLocalChange ignores it.
//
// It has to survive a reload or the Lamport counter restarts at zero on
// every page load, and a genuinely fresh local edit then arrives as "rev 1"
// against a cloud sitting at rev 40 and loses on revision alone. The stored
// form is one small record per REGISTERED key (rev, hash, updatedAt, dirty),
// so it is bounded by the app's key list and cannot grow with the data.
const SYNC_REV_KEY_PREFIX = 'shevato:sync-revs:';
// A device that conflicts repeatedly must not fill its own storage with
// evidence of it.
const MAX_CONFLICT_COPIES = 20;
// How many of this client's own published snapshots to remember per key, so
// their echoes off the watch stream are recognised as ours. A handful covers
// the pipeline depth of a debounced flush; the agreed-base hash covers
// everything older, including across a reload.
const MAX_OWN_WRITE_TOKENS = 12;
// Room for the `{ data: { ... }, meta: { lastUpdated } }` envelope each
// commit carries around the entries planFlushBatches packs.
const FLUSH_ENVELOPE_BYTES = 256;

/**
 * Document id for one part of a chunked value.
 *
 * Sync keys are app-chosen strings and may contain characters Firestore
 * forbids in a document id (`/` above all), so the readable part is
 * sanitised and disambiguated with the key's hash, so two different keys can
 * never collapse onto the same run of part documents.
 *
 * VERSIONED (2026-09-07 audit F04). Without `version` in the id, successive
 * versions of the same key wrote to the SAME part documents. Parts landed
 * before the manifest, so a reader holding the old manifest read the new
 * parts under it, and the assembled value was a mixture of two versions
 * that JSON.parse was perfectly happy to accept. A version token makes each
 * committed snapshot immutable: a new version writes new documents, the old
 * ones stay readable under the old manifest, and the old ones are collected
 * only after the new manifest is durable.
 *
 * `version` omitted reproduces the pre-2026-09-07 id, which is what old
 * manifests point at and what the first upgraded write has to sweep.
 */
function chunkDocId(key, seq, version) {
  const readable = String(key).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  const stem = `${readable}-${hashValue(key)}`;
  return version ? `${stem}__v${version}__${seq}` : `${stem}__${seq}`;
}

/**
 * The token that names one committed snapshot of a key.
 *
 * Revision alone is not enough: two devices can reach the same rev with
 * different content, and their part documents must not collide. Revision
 * plus the content hash cannot.
 */
function chunkVersionToken(rev, hash) {
  return `${Number(rev) || 0}-${String(hash || 'null').replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/**
 * One payload entry, measured the same way the flush guard measures the
 * whole document, so the packing decision and the guard cannot disagree.
 * `estimatePayloadBytes` is what knows how to price a Firestore sentinel.
 */
function measureEntry(key, entry) {
  return { key, entry, bytes: estimatePayloadBytes({ [key]: entry }) };
}

// Global state management (singleton pattern)
class StorageSyncManager {
  constructor() {
    this.syncStates = new Map(); // namespace -> sync state
    this.writeQueues = new Map(); // namespace -> pending writes
    this.localRevisions = new Map(); // key -> { rev, updatedAt, hash }
    this.isOverrideInstalled = false;
    this.originalMethods = null;
    this.syncLocks = new Map(); // key -> boolean (prevent echo loops)
    this.lastRemoteUpdates = new Map(); // key -> timestamp
    // Out-of-line value bookkeeping. `chunkCounts` is the highest part
    // count we have ever seen for a key (written or read), which is what
    // tells a shrinking value which part documents are now garbage.
    // `chunkFetches` de-duplicates in-flight reassemblies, because
    // Firestore re-emits the whole document on every listener re-attach.
    this.chunkCounts = new Map(); // `${namespace}\u0000${key}` -> part count
    // The snapshot whose part documents are currently referenced by the
    // manifest we last wrote or last read: `${ns}\u0000${key}` ->
    // { version, parts }. `version` null means the legacy unversioned run.
    // This is what a new write collects AFTER its own manifest is durable,
    // and never before.
    this.committedChunks = new Map();
    // ---- F05 conflict machinery -----------------------------------------
    // The state the two sides last AGREED on, per key: a shape tag plus an
    // entry -> content-hash index of what is in it (see valueIndex), plus
    // the hash of the whole agreed value. The index is what tells an
    // addition apart from a deletion when both devices have moved; the whole
    // hash is what tells "the cloud has moved" apart from "the cloud is
    // still exactly where we left it", which is the difference between a
    // real conflict and this device arguing with its own echo. It is an
    // index rather than a copy of the value because a second copy of an
    // 800 KB game log is a real cost on a 5 MB storage budget.
    this.syncBases = new Map();   // `${ns}\u0000${key}` -> id->hash index | null
    // Every snapshot THIS client has published, per key, as `rev:hash`
    // tokens. A device cannot conflict with its own write, and without this
    // the ordinary sequence "write, commit, write again, first commit echoes
    // back" was reported to the user as an edit made on another device.
    // Bounded per key; the agreed-base hash covers anything older, including
    // across a reload.
    this.ownWrites = new Map();   // key -> string[]
    // The last remote snapshot of each key this client has already decided
    // about. Firestore re-emits the whole document on every listener
    // re-attach, and without this a single unresolved disagreement re-fired
    // a conflict (and wrote another recovery copy) on every one of them.
    this.lastRemoteSeen = new Map(); // key -> `rev:hash`
    // Per-key conflict policy, declared by the app at registration. Two
    // values, and the engine knows nothing about any particular app:
    //   'auto'    - index, merge, else deterministic winner + recovery copy.
    //   'derived' - a regenerable cache (a re-fetchable profile snapshot, a
    //               UI selection). Still resolved deterministically so both
    //               ends converge, but never worth a recovery copy or a
    //               message, because nothing the user typed can be lost.
    this.keyPolicies = new Map(); // key -> 'auto' | 'derived'
    // Namespaces with a revision-map write pending on the microtask queue,
    // so one flush touching nine keys costs one localStorage write.
    this.revisionWrites = new Set();
    // Conflict copies written this session, newest last, so a page can offer
    // recovery without re-reading storage.
    this.conflictRecords = [];
    this.chunkFetches = new Set(); // `${key}:${hash}:${rev}`
    // Keys the page has been told did not reach the cloud, per namespace
    // (`syncWriteRejected`). Emptied key by key as each one is acknowledged;
    // `syncWriteRecovered` goes out when the set for a namespace is empty.
    // Per manager, not per session, so a sign-out and back in on the same
    // page still retires the message the page is showing.
    this.rejectedWrites = new Map(); // namespace -> Set<key>
    // ---- the account boundary (audits S-2, S-4, S-5, T-3) -----------------
    // Registered key -> namespace, known before anyone signs in, so a write no
    // session owns can still be attributed (signed-out work provenance).
    this.localKeyNamespaces = new Map();
    // Which account's data this page's apps may hold in memory, per namespace:
    // { owner, hadData }. Recorded when the page loads (what it read from
    // storage) and whenever a session runs here (what sync delivered). A page
    // holding one account's data must not sync for a different one unreloaded.
    this.bootLineage = new Map();
    // Provenance of writes made before app-sync-init registered its keys.
    this.pendingLocalWork = new Map();
    // Signed-out writes not yet recorded: key -> { value, work, owner }. They
    // are hashed and recorded in one batch after the write, never inside it:
    // parsing and hashing a multi-megabyte log on every setItem is a cost a
    // signed-out page never used to pay. Anything that reads provenance
    // records the batch first (flushUnsessionedWrites).
    this.unsessionedWrites = new Map();
    this.unsessionedFlushTimer = null;
    // The deletion this tab is running: { uid, id }.
    this.deletionLatch = null;
    this.deletionHeartbeat = null;
    this.releaseDeletionLock = null;
    // Flushes on the wire, so account deletion can wait for them to land.
    this.activeFlushes = new Set();
    // Namespaces this page must reload for, with the account whose data the
    // page loaded. Writes the page's apps make while waiting are that
    // account's, and are recorded as such (noteUnsessionedWrite).
    this.foreignPageNamespaces = new Map();
    
    // Check if immediate sync override is already installed
    if (window.immediateDebug) {
      this.useImmediateOverride();
    } else {
      this.installGlobalOverride();
    }

    this.installCrossTabChannel();
    this.installVisibilityHook();
    this.installFlushTriggers();
    this.installAccountBoundaryListeners();
  }

  /**
   * Wire the cross-tab BroadcastChannel into the sync manager. Shares
   * the same channel instance with firebase-config.js so we don't open
   * multiple channels per tab.
   *
   * Outbound: after a successful Firestore flush we publish
   * `data-updated` with the namespace and the keys that changed.
   *
   * Inbound: when a peer tab posts `data-updated`, we treat it as a
   * hint that our own onSnapshot may be stale (e.g. backgrounded tab
   * during a reconnect window). For every key in our active namespaces
   * we re-dispatch `localStorageSync` against the current localStorage
   * value so app render listeners pick it up. This is safe even when
   * onSnapshot is healthy — the apps' debounced re-render loops fold
   * the duplicate event.
   */
  installCrossTabChannel() {
    this.channel = (typeof window !== 'undefined' && window.__shevatoSyncChannel)
      ? window.__shevatoSyncChannel
      : createCrossTabChannel();
    if (typeof window !== 'undefined') {
      window.__shevatoSyncChannel = this.channel;
    }

    this.channelUnsubscribe = this.channel.subscribe(
      CHANNEL_MESSAGE_TYPES.DATA_UPDATED,
      (msg) => this.onCrossTabDataUpdated(msg)
    );
  }

  /**
   * Refresh active namespaces when the tab becomes visible again.
   *
   * Firebase's onSnapshot listener auto-reconnects on tab focus, but
   * there is a window (sometimes seconds, occasionally longer on
   * mobile) where queued remote writes have already landed in
   * IndexedDB-backed localStorage via the native 'storage' event but
   * the listener has not yet re-fired. We bridge that by re-dispatching
   * `localStorageSync` for any key whose current localStorage hash
   * disagrees with what we last recorded.
   *
   * We also `enableNetwork(db)` defensively — it's a no-op when the
   * SDK is already online but forces a fresh long-poll connection if
   * the network stack was suspended by the browser.
   */
  installVisibilityHook() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    if (this._visibilityHookInstalled) return;
    this._visibilityHookInstalled = true;

    document.addEventListener('visibilitychange', () => {
      // Hidden is often the last event a mobile page ever gets (the OS kills
      // it in the background without a pagehide), so a pending debounced
      // edit goes out now rather than in 500 ms that may never come.
      if (document.visibilityState === 'hidden') {
        this.flushPendingNow();
        return;
      }
      if (document.visibilityState !== 'visible') return;
      this.handleTabVisible();
    });
  }

  handleTabVisible() {
    for (const [, state] of this.syncStates) {
      if (state.stopped) continue;
      this.reconcileFromLocalStorage(state);
      // Coming back to the tab is one of the bounded resend triggers.
      this.resumeParkedWrites(state);
    }
  }

  /* ---------------------------------------------------------------------
   * When a write is (re)sent, and the promise that nothing is lost quietly
   * (2026-09-12 audit S-3).
   *
   * Four ways a write used to vanish, and what replaced each:
   *
   *   - A RETRYABLE failure (network, `unavailable`, ...) that outlasted the
   *     retry ladder was dropped from the queue. It is now requeued and
   *     PARKED: no timer resends it, the page is told (`syncWriteRejected`,
   *     `retryable: true`), and it goes out again on the next bounded
   *     trigger - a local change in the namespace, the window `online`
   *     event, the tab becoming visible, or the next sync start for the same
   *     user. Each trigger runs at most one normal ladder, so a backend that
   *     stays down costs four attempts per trigger, never a loop.
   *   - A PERMANENT failure (see isPermanentWriteError) gets one attempt and
   *     no ladder. The keys stay dirty, the page is told (`retryable:
   *     false`), and the next sync start tries them once (requeueDirtyKeys).
   *   - An edit inside the 500 ms debounce window before the tab closed, the
   *     tab was hidden or the user signed out never left the device.
   *     `pagehide` and `visibilitychange` to hidden now flush a pending
   *     debounced write at once, and firebase-config.js awaits
   *     `window.__shevatoFlushSync` (flushAllNow) before auth.signOut(),
   *     because a write attempted after sign-out is refused.
   *   - stopSync still drops the in-memory queue (by then the auth may be
   *     gone, so flushing there is too late), but the dirty flags are
   *     persisted and requeueDirtyKeys puts those writes back on the next
   *     start for the same user.
   *
   * `syncWriteRecovered` ({ namespace }) goes out once every key that was
   * announced as rejected in that namespace has been acknowledged.
   * ------------------------------------------------------------------- */

  installFlushTriggers() {
    if (this._flushTriggersInstalled) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._flushTriggersInstalled = true;
    // pagehide rather than beforeunload/unload: it is the one that fires on
    // mobile Safari and for pages entering the back/forward cache. setDoc is
    // reached within this event's microtask checkpoint, after which
    // Firestore's persistent cache owns the write.
    window.addEventListener('pagehide', () => {
      this.flushUnsessionedWrites();
      this.flushPendingNow();
    });
    window.addEventListener('online', () => {
      for (const [, state] of this.syncStates) this.resumeParkedWrites(state);
    });
  }

  /** (Re)arm the debounced flush for a session. */
  armFlushTimer(state, delay) {
    if (state.writeTimer) clearTimeout(state.writeTimer);
    state.writeTimer = setTimeout(() => {
      state.writeTimer = null;
      this.flushWrites(state);
    }, delay);
  }

  /**
   * Send every write that is waiting on a timer (a debounce or a retry
   * backoff) right now. A parked write with no timer is NOT sent: hiding a
   * tab is not one of its resend triggers, and a page that hides and shows
   * repeatedly must not turn into a retry loop.
   */
  flushPendingNow() {
    const flights = [];
    for (const [, state] of this.syncStates) {
      // Never before the initial merge (T-3): a write that has not met the
      // cloud yet waits, dirty and persisted, for the next session.
      if (state.stopped || !state.initialMergeDone || (!state.writeTimer && !state.retryTimer)) continue;
      if (state.writeTimer) {
        clearTimeout(state.writeTimer);
        state.writeTimer = null;
      }
      flights.push(this.flushWrites(state));
    }
    return Promise.all(flights).then(() => undefined);
  }

  /**
   * The sign-out flush: everything queued in every live session, parked
   * writes included, because this is the last moment the user's credentials
   * are available to send them. Resolves once each flush has had its answer
   * (flushWrites never rejects); the caller bounds the wait.
   */
  flushAllNow() {
    const flights = [];
    for (const [, state] of this.syncStates) {
      if (state.stopped || !state.initialMergeDone) continue;
      if (state.writeTimer) {
        clearTimeout(state.writeTimer);
        state.writeTimer = null;
      }
      const queue = this.writeQueues.get(state.namespace);
      if (!queue || queue.size === 0) continue;
      flights.push(this.flushWrites(state));
    }
    return Promise.all(flights).then(() => undefined);
  }

  /** One resend of a parked write, on one of its bounded triggers. */
  resumeParkedWrites(state) {
    if (!state || state.stopped || !state.parked) return;
    this.flushWrites(state);   // clears `parked`; a new failure parks it again
  }

  /**
   * Queue every write this device holds that the cloud has not accepted.
   * Runs once, at the end of the initial merge (completeInitialMerge), after
   * every key has already been compared with the cloud, so a cloud that moved
   * while this device was away was merged (and the merge queued) instead of
   * being overwritten blind. A key already queued is left alone.
   *
   * Two kinds of dirty key, and the revision each goes at:
   *   - the exact write that never landed (its value still hashes to the dirty
   *     record persisted last session) goes at that write's own revision;
   *   - anything newer (signed-out work on this account's data, or a value
   *     created on this device that the cloud has never had) is a new revision
   *     on top of the last one this device reached.
   * A value an app only wrote for itself was never marked dirty in the first
   * place (see restoreRevisions and synthesizeLocalWork), so it is not here.
   * A write the cloud acknowledged is clean and is never resent, and neither
   * is a dirty value the cloud turns out to hold already.
   */
  requeueDirtyKeys(state) {
    if (!state || state.stopped) return;
    const queue = this.writeQueues.get(state.namespace);
    if (!queue) return;
    const persisted = state.restoredRevisions || {};

    let added = 0;
    for (const key of state.keys) {
      const rev = this.localRevisions.get(key);
      if (!rev || !rev.dirty || queue.has(key)) continue;
      const value = this.readLocalValue(key);
      const hash = hashValue(value);
      const seen = String(this.lastRemoteSeen.get(key) || '');
      if (seen && seen.slice(seen.indexOf(':') + 1) === hash) {
        this.localRevisions.set(key, { ...rev, hash, dirty: false });
        continue;
      }
      const entry = persisted[key];
      const unsentWrite = !!(entry && entry.dirty && String(entry.hash || '') === hash);
      const nextRev = (Number(rev.rev) || 0) + (unsentWrite ? 0 : 1);
      queue.set(key, {
        value,
        rev: nextRev,
        updatedAt: Date.now(),
        deleted: value === null,
        hash
      });
      this.localRevisions.set(key, { ...rev, rev: nextRev, hash, dirty: true });
      added++;
    }
    if (added) this.armFlushTimer(state, DEBOUNCE_MS);
  }

  /**
   * For each key registered in the given sync state, compare the
   * current localStorage hash against our last-known hash and dispatch
   * a `localStorageSync` event when they differ. Used by the visibility
   * hook and the cross-tab `data-updated` receiver.
   */
  reconcileFromLocalStorage(state) {
    if (!state || state.stopped) return;
    const getItem = this.originalMethods?.getItem
      ? this.originalMethods.getItem
      : localStorage.getItem.bind(localStorage);

    for (const key of state.keys) {
      const raw = getItem(key);
      const parsed = parseValue(raw);
      const currentHash = hashValue(parsed);
      const known = this.localRevisions.get(key);
      if (known && known.hash === currentHash) continue;

      this.localRevisions.set(key, {
        rev: known?.rev || 0,
        updatedAt: known?.updatedAt || Date.now(),
        hash: currentHash,
        // DIRTY, always. We only reach this line because what is on disk is
        // not what the cloud last acknowledged, which is the definition of
        // unacknowledged local work. Omitting the flag here (it defaulted to
        // undefined) meant a tab coming back to the foreground silently
        // downgraded a pending edit to a clean revision, and the next remote
        // delivery then replaced it without so much as a conflict.
        dirty: true
      });
      // Source is 'remote' because every app's localStorageSync listener
      // gates on that label (they only re-render on remote-origin events,
      // not on writes they themselves just made). Reconcile is exactly the
      // case the apps mean by 'remote' — data on disk is fresher than the
      // app's in-memory view, sourced from a peer tab or onSnapshot delivery
      // we missed while backgrounded.
      window.dispatchEvent(new CustomEvent('localStorageSync', {
        detail: { key, value: parsed, source: 'remote' }
      }));
    }
    this.schedulePersistRevisions(state.namespace);
  }

  /**
   * Receive a `data-updated` broadcast from a peer tab. If we have an
   * active sync state for that namespace, force a reconcile so any
   * key whose localStorage value has drifted from our last-known hash
   * fires a fresh `localStorageSync` event.
   */
  onCrossTabDataUpdated(msg) {
    if (!msg || typeof msg !== 'object') return;
    const namespace = msg.namespace;
    if (typeof namespace !== 'string') return;
    const state = this.syncStates.get(namespace);
    if (!state) return;
    this.reconcileFromLocalStorage(state);
  }

  /**
   * Use the immediate override system
   */
  useImmediateOverride() {
    // Store original methods for use in applyRemoteChange
    this.originalMethods = {
      setItem: localStorage.setItem.bind(localStorage),
      removeItem: localStorage.removeItem.bind(localStorage),
      getItem: localStorage.getItem.bind(localStorage)
    };
    
    // Set up the sync manager for immediate override to use
    window.syncManager = {
      // `meta.work` comes with a boot-window write sync-immediate.js buffered:
      // the gesture state when the write was made, which a replay after the
      // (async) sync modules load would otherwise read too late.
      processChange: (key, value, meta) => {
        const work = meta && typeof meta.work === 'boolean' ? meta.work : undefined;
        this.notifyLocalChange(key, value, { work });
      }
    };
    
    // Signal that sync system is ready
    window.syncSystemInitialized = true;
    window.dispatchEvent(new CustomEvent('syncSystemReady'));

    this.isOverrideInstalled = true;
  }

  /**
   * Install global localStorage override (once) - fallback
   */
  installGlobalOverride() {
    if (this.isOverrideInstalled) return;

    // Store original methods
    this.originalMethods = {
      setItem: localStorage.setItem.bind(localStorage),
      removeItem: localStorage.removeItem.bind(localStorage),
      getItem: localStorage.getItem.bind(localStorage)
    };

    // Global override for setItem
    localStorage.setItem = (key, value) => {
      // Always call original first
      this.originalMethods.setItem(key, value);
      
      // Then notify all relevant sync states
      this.notifyLocalChange(key, value);
    };

    // Global override for removeItem
    localStorage.removeItem = (key) => {
      this.originalMethods.removeItem(key);
      this.notifyLocalChange(key, null);
    };

    // Listen for storage events (cross-tab)
    window.addEventListener('storage', (e) => {
      if (e.key) {
        this.notifyLocalChange(e.key, e.newValue, { crossTab: true });
      }
    });

    this.isOverrideInstalled = true;
  }

  /**
   * Notify all sync states about a localStorage change
   */
  notifyLocalChange(key, value, { crossTab = false, work } = {}) {
    // Check if we're in a sync lock (prevent echo)
    if (this.syncLocks.get(key)) {
      return;
    }

    // Find all sync states that care about this key
    let owned = false;
    for (const [, state] of this.syncStates) {
      if (state.keys.has(key) && !state.stopped) {
        owned = true;
        this.queueWrite(state, key, value);
      }
    }
    // No session owns it (signed out, or before sync starts): remember whether
    // a person or an app produced it, which is the question the first sign-in
    // on this device has to answer (audit S-4). The engine's own bookkeeping
    // keys are never app data, and another tab's write is that tab's to
    // record: its gesture, its page, and it already has.
    if (!owned && !crossTab && typeof key === 'string' && !key.startsWith('shevato:')) {
      this.noteUnsessionedWrite(key, value, work);
    }
  }

  /**
   * Hash a value for change detection. Thin wrapper around the pure
   * helper so debug code keeps working; new code should import the
   * helper directly.
   */
  hashValue(value) { return hashValue(value); }

  /**
   * Record the conflict policy an app declares for its own keys.
   *
   * The engine stays app-agnostic: it understands 'auto' and 'derived' and
   * nothing else, and an app that declares nothing gets 'auto' for every
   * key, which is what every app got before policies existed. Keys the
   * caller does not mention are explicitly reset, so a policy cannot linger
   * after an app stops declaring it.
   *
   * @param {string[]} keys the namespace's registered keys
   * @param {Object<string,string>} [policies] key -> 'auto' | 'derived'
   */
  registerKeyPolicies(keys, policies) {
    const declared = policies && typeof policies === 'object' ? policies : {};
    for (const key of Array.isArray(keys) ? keys : []) {
      if (declared[key] === 'derived') this.keyPolicies.set(key, 'derived');
      else this.keyPolicies.delete(key);
    }
  }

  /**
   * Start sync for a namespace.
   *
   * Single auth source — the modular SDK auth instance imported from
   * firebase-config.js. The previous version maintained a compat-SDK
   * fallback because the site loaded both SDKs simultaneously and the
   * mobile auth iframe race could leave `auth.currentUser` null. The
   * compat SDK has been removed entirely (see firebase-config.js for
   * the full story) so this path is now straightforward: try
   * `auth.currentUser` immediately, fall back to a one-shot
   * `onAuthStateChanged` if not yet available.
   */
  startStorageSync({ namespace, keys, policies }) {
    const user = auth.currentUser;
    if (user) {
      return this._startSyncForUser(user, { namespace, keys, policies });
    }

    console.warn('❌ No authenticated user — sync will start once auth is ready');
    let actualSync = null;
    const delayedSync = {
      stop: () => { if (actualSync) actualSync.stop(); }
    };

    const unsubscribe = auth.onAuthStateChanged((authUser) => {
      if (authUser?.uid && !actualSync) {
        actualSync = this._startSyncForUser(authUser, { namespace, keys, policies });
        unsubscribe();
      }
    });

    return delayedSync;
  }
  
  /**
   * Internal method to start sync for an authenticated user.
   *
   * Idempotent against duplicate calls. `auth.onAuthStateChanged` fires
   * on every Firebase token refresh, not just on real sign-in/out, so
   * `initAppSync()` was being called repeatedly during a normal
   * session. Each call previously tore down the active sync and rebuilt
   * it — fresh `onSnapshot` attach plus a fresh `getDoc` for the
   * initial merge. Across multiple tabs and an hour-long session that
   * was enough cumulative read traffic to trip Firestore's per-user
   * rate limit (`429 Too Many Requests` on `/documents:batchGet`). We
   * now skip the rebuild when the existing sync already matches the
   * incoming user+namespace+keys.
   */
  _startSyncForUser(user, { namespace, keys, policies }) {
    this.registerKeyPolicies(keys, policies);

    const existing = this.syncStates.get(namespace);
    // S-5: an account being deleted (or already deleted) gets no session in
    // any tab, whatever re-entered initAppSync.
    if (this.isAccountDeletionLatched(user.uid)) {
      if (existing) this.stopSync(namespace);
      console.warn(`Sync for ${namespace} not started: this account is being deleted`);
      return this.inertHandle(namespace);
    }
    if (existing && !existing.stopped
        && existing.userId === user.uid
        && sameKeySet(existing.keys, keys)) {
      // The next sync start for this user is one of the bounded triggers a
      // parked write is waiting for.
      this.resumeParkedWrites(existing);
      return {
        stop: () => this.stopSync(namespace),
        getStatus: () => this.getSyncStatus(namespace)
      };
    }

    if (existing) {
      this.stopSync(namespace);
    }

    // S-2 / S-4: whose local data this is, settled before a session exists.
    this.registerLocalNamespaces([{ namespace, keys }]);
    const boundary = this.prepareNamespaceForUser(namespace, keys, user.uid);
    if (boundary.hold) {
      console.warn(`Sync for ${namespace} is paused on this device: ${boundary.hold}`);
      this.notifyAppSyncHeld(namespace, boundary.hold);
      return this.inertHandle(namespace);
    }
    if (boundary.reload) {
      this.requestReload();
      return this.inertHandle(namespace);
    }
    // From now on this page's apps may hold this account's data for the
    // namespace, however empty the page was when it loaded: the session is
    // about to deliver it. A later session for a different account on this
    // same page must reload first, exactly as if the page had loaded with it.
    this.bootLineage.set(namespace, { owner: user.uid, hadData: true });

    // Initialize sync state
    const state = {
      namespace,
      keys: new Set(keys),
      userId: user.uid,
      listeners: [],
      writeTimer: null,
      // The retry ladder's pending backoff, so stopSync and an early flush
      // can cancel it. A failed ladder never re-arms itself: see `parked`.
      retryTimer: null,
      // true when the ladder ran out on a retryable failure: the writes are
      // back in the queue and wait for a bounded trigger.
      parked: false,
      // Keys handed to Firestore and not yet answered, so status cannot read
      // "Synced" while the only copy of an edit is on the wire.
      inFlight: 0,
      stopped: false,
      retryCount: 0,
      lastSyncTime: Date.now(),
      // T-3: the first server-confirmed snapshot has arrived and is being
      // reconciled (initialMergeStarted), and has been reconciled
      // (initialMergeDone). Nothing is sent before the second is true.
      initialMergeStarted: false,
      initialMergeDone: false,
      // Keys written before the initial merge: the revision each had first,
      // and whether any of those writes followed a user gesture.
      preMergePrior: new Map(),
      preMergeWork: new Map()
    };

    this.syncStates.set(namespace, state);

    // Initialize write queue
    if (!this.writeQueues.has(namespace)) {
      this.writeQueues.set(namespace, new Map());
    }

    // Before the listener attaches, so the first snapshot is judged against
    // the revisions this device actually reached, not against zero.
    this.restoreRevisions(state);
    this.synthesizeLocalWork(state);
    this.persistRevisions(namespace);

    // Start Firebase listener — the listener's first snapshot doubles
    // as the initial merge, so we no longer need a separate `getDoc`
    // (that was the read costing us 429s on auth-state churn).
    this.initFirestoreSync(state);

    return {
      stop: () => this.stopSync(namespace),
      getStatus: () => this.getSyncStatus(namespace)
    };
  }

  /**
   * Firestore listener with retry logic.
   *
   * Important: any error path must tear down the previous `onSnapshot`
   * before reattaching. Earlier versions skipped that step and pushed
   * a fresh `unsubscribe` onto `state.listeners` on every retry, so
   * each transient blip stacked another long-poll connection on top of
   * the dead one. Google's Listen gateway then started returning 404
   * for the orphaned session IDs (`/Listen/channel ... 404 (Not Found)`
   * in the browser console) and the duplicate live listeners produced
   * redundant `applyRemoteChange` calls that re-rendered views under
   * the cursor — the source of the hover flicker.
   *
   * We now keep a single `state.unsubscribe` slot, swap it on every
   * (re)attach, and only register one cleanup callback in
   * `state.listeners` for `stopSync()` to invoke.
   */
  initFirestoreSync(state) {
    const docPath = `users/${state.userId}/apps/${state.namespace}`;
    const docRef = doc(db, docPath);

    let retryAttempts = 0;
    let authRetryAttempts = 0;

    const tearDown = () => {
      if (state.unsubscribe) {
        try { state.unsubscribe(); } catch (_) { /* SDK already gone */ }
        state.unsubscribe = null;
      }
    };

    const setupListener = async () => {
      tearDown();
      if (state.stopped) return;

      // Cold-boot guard: wait for a fresh ID token before letting
      // onSnapshot fire its first listen request. auth.currentUser
      // populates synchronously from IndexedDB but the network mint
      // of a token can take a few hundred ms; without this await the
      // initial listen reaches Firestore with no Authorization header
      // and the rules deny it (the "permission-denied on first load"
      // bug). getIdToken() resolves immediately if a valid token is
      // already cached, so this is a one-off cost paid only when the
      // SDK actually needs to fetch.
      const user = auth.currentUser;
      if (!user || user.uid !== state.userId) return;
      try {
        await user.getIdToken();
      } catch (err) {
        console.warn(`🔐 Failed to acquire ID token for ${state.namespace}, falling through to listener:`, err?.message);
      }
      if (state.stopped) return;

      const unsubscribe = onSnapshot(docRef,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (state.stopped) return;
          // S-5: never merge, and never answer with an upload, a snapshot of an
          // account that is being deleted, however this listener got here.
          if (this.isAccountDeletionLatched(state.userId)) {
            this.stopSync(state.namespace);
            return;
          }
          // S-2: another tab handed this namespace's local copy to a different
          // account. This listener's values must not be written into it.
          if (!this.ownsNamespace(state)) {
            this.stopSync(state.namespace);
            return;
          }

          const data = snapshot.data();
          const remoteData = data?.data || {};
          // T-3: the first server-confirmed snapshot is the initial merge.
          const firstServerSnapshot = !snapshot.metadata?.fromCache && !state.initialMergeStarted;
          if (firstServerSnapshot) this.prepareInitialReconciliation(state, remoteData);
          const chunkFlights = [];
          // Firestore's latency compensation delivers this client's own
          // un-acknowledged writes straight back, with every
          // serverTimestamp() still unresolved. Passing the flag down lets
          // decideRemoteChange name that case instead of relying on the
          // unresolved sentinel happening to read as timestamp zero. It is
          // NOT on its own a fix for own-write echoes: the echo that caused
          // the false conflicts is fully committed and server-confirmed, and
          // carries hasPendingWrites false like anyone else's write.
          const snapshotOptions = { pendingWrites: !!snapshot.metadata?.hasPendingWrites };

          for (const [key, info] of Object.entries(remoteData)) {
            if (!state.keys.has(key)) continue;
            // A null or non-object entry (hand-edited document, an older
            // format) used to reach applyRemoteChange, which dereferences
            // `remoteInfo.updatedAt` and threw INSIDE the snapshot callback:
            // every key after it in iteration order was skipped and the
            // initial merge never ran for the session. Skip the bad entry
            // and keep going.
            if (!info || typeof info !== 'object') {
              console.warn(`Ignoring malformed remote entry for ${key} in ${state.namespace}`);
              continue;
            }
            try {
              // A chunked entry is a manifest, not a value: its parts live in
              // the `chunks` subcollection and have to be fetched. Everything
              // after reassembly is the shared inline path.
              if (info.chunked) chunkFlights.push(this.applyChunkedRemoteChange(state, key, info, snapshotOptions));
              else this.applyRemoteChange(key, info, snapshotOptions);
            } catch (err) {
              // One unreadable key must not cost the user every other key.
              console.error(`Failed to apply remote change for ${key} in ${state.namespace}:`, err);
            }
          }

          // Initial merge: queue any keys we have locally but Firestore
          // doesn't. Gate on !fromCache because persistent IndexedDB
          // cache means the first snapshot can come from an empty/stale
          // local cache; uploading local-only keys against that view
          // silently overwrites whatever a different browser already
          // wrote to the same keys (the "sometimes data is kept,
          // sometimes not" cross-browser bug). includeMetadataChanges
          // guarantees we get a callback when the snapshot transitions
          // from cached to server-confirmed even if the data is
          // unchanged.
          if (firstServerSnapshot) {
            state.initialMergeStarted = true;
            // Released only once every chunked value in this snapshot has been
            // assembled and reconciled: a queued edit to one of them must not
            // be sent over a cloud value this device has not read yet.
            Promise.all(chunkFlights).then(() => this.completeInitialMerge(state, remoteData));
          }

          retryAttempts = 0;
          authRetryAttempts = 0;
        },
        (error) => {
          if (error.code === 'permission-denied' || error.code === 'unauthenticated') {
            // Cold-boot race: getIdToken() above usually prevents this,
            // but it can still fire if the cached token is rejected
            // (token revoked, clock skew, multi-tab refresh contention).
            // Retry on a tighter cadence than the generic network path,
            // gated on the same user still being signed in — if they
            // really did sign out, we abandon instead of looping.
            if (auth.currentUser?.uid !== state.userId) {
              console.warn(`🔐 User changed during permission-denied recovery for ${state.namespace} — abandoning`);
              tearDown();
              return;
            }
            if (authRetryAttempts < MAX_AUTH_RETRY_ATTEMPTS) {
              authRetryAttempts++;
              const delay = AUTH_RETRY_BASE_MS * Math.pow(2, authRetryAttempts - 1);
              console.log(`🔐 Auth not ready for ${state.namespace}, retrying in ${delay}ms (${authRetryAttempts}/${MAX_AUTH_RETRY_ATTEMPTS})`);
              setTimeout(setupListener, delay);
              return;
            }
            console.error(`🔐 Authentication error for ${state.namespace} after ${MAX_AUTH_RETRY_ATTEMPTS} retries:`, error.message);
            tearDown();
            this.noteSnapshotUnavailable(state, error);
            return;
          }

          if (error.code === 'unavailable' || error.message?.includes('offline') || error.code === 'failed-precondition') {
            console.warn(`📡 Network/connection error for ${state.namespace}:`, error.message);
          } else {
            console.error(`❌ Firestore sync error for ${state.namespace}:`, error);
          }

          if (retryAttempts < MAX_RETRY_ATTEMPTS) {
            retryAttempts++;
            const delay = RETRY_DELAY_MS * Math.pow(2, retryAttempts - 1);
            console.log(`🔄 Retrying Firestore listener in ${delay}ms (${retryAttempts}/${MAX_RETRY_ATTEMPTS})`);
            setTimeout(setupListener, delay);
          } else {
            console.error(`💥 Max retries exceeded for ${state.namespace} - sync disabled`);
            tearDown();
            this.noteSnapshotUnavailable(state, error);
          }
        }
      );

      state.unsubscribe = unsubscribe;
    };

    state.listeners.push(tearDown);
    setupListener();
  }

  /**
   * Apply a remote change to localStorage. Conflict decision is
   * delegated to `decideRemoteChange` in sync-helpers.js so the
   * verdict logic can be unit-tested without a Firestore mock.
   *
   * Hash-equality short-circuit is critical: Firestore re-emits the
   * same document body whenever a listener reattaches (network blip,
   * tab focus, SDK session refresh). Without this guard the app
   * re-loads localStorage and re-renders every view on every reattach,
   * which the user sees as flicker on hover when the cursor is over a
   * card whose DOM gets rebuilt mid-interaction.
   */
  applyRemoteChange(key, remoteInfo, options = {}) {
    const localRev = this.localRevisions.get(key);
    const remoteTimestamp = getTimestamp(remoteInfo.updatedAt);
    const incomingToken = remoteToken(remoteInfo);
    // The body the CLOUD is holding, kept aside because the conflict branch
    // below replaces `remoteInfo` with whatever it resolved to.
    const cloudValue = remoteInfo.deleted ? null : remoteInfo.value;
    const verdict = this.verdictFor(key, remoteInfo, options);

    if (this.noteRemoteSkip(key, verdict, remoteInfo, incomingToken)) return;

    if (verdict === 'conflict') {
      // Recorded BEFORE resolving, and unconditionally, so a redelivery of
      // this same body cannot be resolved a second time. The local-wins
      // branch used to return without either, which is why an unresolved
      // disagreement re-fired the banner (and wrote another recovery copy)
      // on every listener re-attach, forever.
      this.lastRemoteUpdates.set(key, remoteTimestamp);
      this.markRemoteSeen(key, incomingToken);
      const resolved = this.resolveConflict(key, localRev, remoteInfo);
      if (!resolved) return;                 // local kept; a copy was preserved
      remoteInfo = resolved;                 // apply the merged/winning value
    }

    // Echo-prevention lock. Held only across the synchronous body below
    // so that any forward through the immediate-sync override (which
    // runs synchronously inside setItem) sees the lock and skips. Older
    // versions cleared this via setTimeout(..., 100) which silently
    // dropped any local user write that happened during that window.
    this.syncLocks.set(key, true);

    try {
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      const removeItem = this.originalMethods?.removeItem || localStorage.removeItem.bind(localStorage);

      if (remoteInfo.deleted || remoteInfo.value === undefined || remoteInfo.value === null) {
        removeItem(key);
      } else {
        const value = typeof remoteInfo.value === 'object'
          ? JSON.stringify(remoteInfo.value)
          : String(remoteInfo.value);
        setItem(key, value);
      }

      this.localRevisions.set(key, {
        // LAMPORT, not "theirs". Advancing to max(local, remote) is what
        // makes rev a causal order every device agrees on, which is what
        // replaced the wall-clock comparison in decideRemoteChange. Taking
        // the remote rev outright let a device that was ahead fall back and
        // then re-collide at a revision it had already used.
        rev: Math.max((localRev && localRev.rev) || 0, remoteInfo.rev || 0),
        updatedAt: remoteTimestamp,
        hash: hashValue(remoteInfo.value),
        // Clean when it came straight from the cloud; still dirty when it is
        // a merge this device produced and has only QUEUED for upload.
        dirty: !!options.stillDirty || remoteInfo.queuedLocally === true
      });
      // THE CLOUD'S value, not ours. A merge is a state only this device
      // holds until the upload lands, so recording it as "agreed" claimed an
      // agreement that did not exist: a second remote delivery then merged
      // against our own un-uploaded merge, and every record the first merge
      // had contributed looked like something the peer had deleted. What the
      // two sides genuinely last agreed on is the body the cloud sent.
      this.rememberSyncBaseForKey(key, verdict === 'conflict' ? cloudValue : remoteInfo.value);
      this.schedulePersistRevisions(this.namespaceOfKey(key));

      this.lastRemoteUpdates.set(key, remoteTimestamp);
      this.markRemoteSeen(key, incomingToken);

      window.dispatchEvent(new CustomEvent('localStorageSync', {
        detail: { key, value: remoteInfo.value, source: 'remote' }
      }));
    } finally {
      this.syncLocks.delete(key);
    }
  }

  /* ---------------------------------------------------------------------
   * Own-write recognition: how this client tells its own Firestore traffic
   * apart from somebody else's edit.
   *
   * Three mechanisms, each covering a window the others cannot:
   *
   *   1. `pendingWrites` (snapshot metadata) covers the latency-compensated
   *      snapshot Firestore delivers the instant setDoc is called, before
   *      the server has seen it. Its serverTimestamp() sentinels are still
   *      unresolved, so there is nothing in it to compare against anyway.
   *   2. `ownWrites` (rev:hash tokens, in memory) covers the committed echo
   *      that arrives off the watch stream between issuing a write and
   *      finishing the flush - the exact window a debounced burst lives in,
   *      and the window the MapTap Rivals "Sync all rivals" run sat in.
   *   3. The agreed BASE HASH (persisted) covers everything after that,
   *      including after a reload, when the token list is gone: a cloud
   *      value identical to the state the two sides last agreed on has not
   *      moved, whoever wrote it.
   *
   * `metadata.hasPendingWrites` alone would have fixed none of this: the
   * echo that caused the false conflicts is a fully committed, server-
   * confirmed snapshot, indistinguishable by metadata from a peer's write.
   * ------------------------------------------------------------------- */

  /** The verdict for one remote entry, with everything we know about it. */
  verdictFor(key, remoteInfo, options = {}) {
    return decideRemoteChange(
      this.localRevisions.get(key),
      remoteInfo,
      this.lastRemoteUpdates.get(key) || 0,
      {
        ownEcho: this.isOwnEcho(key, remoteToken(remoteInfo)),
        baseHash: this.syncBaseHashFor(key),
        seenToken: this.lastRemoteSeen.get(key) || null,
        pendingWrites: !!options.pendingWrites
      }
    );
  }

  /**
   * Bookkeeping for every verdict that is not 'apply' or 'conflict'.
   *
   * @returns {boolean} true when the caller should stop here.
   */
  noteRemoteSkip(key, verdict, remoteInfo, token) {
    const remoteTimestamp = getTimestamp(remoteInfo.updatedAt);

    // Nothing to record: a pending-write view carries no server state, a
    // stale entry is one we already accounted for, and a seen token was
    // accounted for the first time round.
    if (verdict === 'skip-pending' || verdict === 'skip-stale' || verdict === 'skip-seen') return true;

    if (verdict === 'skip-older') {
      // The cloud is BEHIND this device, which normally means a peer flushed
      // an older logical version over ours. Ignoring it silently is how the
      // two ends stay permanently different, so republish: our value carries
      // a higher rev and the peer, being clean, will take it.
      this.lastRemoteUpdates.set(key, remoteTimestamp);
      this.markRemoteSeen(key, token);
      this.republishLocalValue(key);
      return true;
    }

    if (verdict === 'skip-deduped' || verdict === 'skip-own') {
      this.lastRemoteUpdates.set(key, remoteTimestamp);
      this.markRemoteSeen(key, token);
      // Our own value, confirmed by the server: this is the moment the two
      // sides agree, and recording it is what lets a LATER echo of the same
      // snapshot be recognised even after the token list has aged out or a
      // reload has emptied it.
      if (remoteInfo.value !== undefined) this.rememberSyncBaseForKey(key, remoteInfo.value);
      return true;
    }

    if (verdict === 'skip-agreed') {
      // The cloud has not moved since we last agreed. Our own pending work
      // is still pending and will be flushed; there is nothing to merge and
      // certainly nothing to tell the user about.
      this.lastRemoteUpdates.set(key, remoteTimestamp);
      this.markRemoteSeen(key, token);
      return true;
    }

    return false;
  }

  /**
   * Drop every trace of a namespace's sync bookkeeping, on disk and in
   * memory. Used when the cloud document itself is deleted, so the next
   * session does not compare against revisions and an agreed base that
   * describe a document that is gone.
   */
  forgetSyncMetadata(namespace) {
    const state = this.syncStates.get(namespace);
    const keys = state ? [...state.keys] : [];
    for (const key of keys) {
      this.localRevisions.delete(key);
      this.lastRemoteUpdates.delete(key);
      this.ownWrites.delete(key);
      this.lastRemoteSeen.delete(key);
      this.syncBases.delete(this.chunkCountKey(namespace, key));
    }
    try {
      const removeItem = this.originalMethods?.removeItem || localStorage.removeItem.bind(localStorage);
      removeItem(SYNC_REV_KEY_PREFIX + namespace);
      removeItem(SYNC_BASE_KEY_PREFIX + namespace);
    } catch (_) { /* nothing to forget */ }
  }

  /** Remember that this client published a snapshot, so its echo is ours. */
  rememberOwnWrites(writes) {
    if (!writes) return;
    for (const [key, info] of writes) {
      const token = remoteToken(info);
      const list = this.ownWrites.get(key) || [];
      if (list[list.length - 1] !== token) list.push(token);
      while (list.length > MAX_OWN_WRITE_TOKENS) list.shift();
      this.ownWrites.set(key, list);
    }
  }

  isOwnEcho(key, token) {
    const list = this.ownWrites.get(key);
    return Array.isArray(list) && list.indexOf(token) !== -1;
  }

  markRemoteSeen(key, token) {
    this.lastRemoteSeen.set(key, token);
  }

  /** The declared conflict policy for a key; 'auto' unless an app said otherwise. */
  policyForKey(key) {
    return this.keyPolicies.get(key) === 'derived' ? 'derived' : 'auto';
  }

  /* ---------------------------------------------------------------------
   * F05: conflicts, and what happens to the side that does not win.
   * ------------------------------------------------------------------- */

  /** Which namespace owns a key, so the base index can be filed per app. */
  namespaceOfKey(key) {
    for (const [namespace, state] of this.syncStates) {
      if (state && state.keys && state.keys.has(key)) return namespace;
    }
    return null;
  }

  /**
   * Record the state the two sides now agree on, as an id -> content-hash
   * index. Persisted (outside every namespace's key set, so it never syncs
   * itself) because the three-way merge has to survive a reload: without a
   * base, "this record is missing from their copy" cannot be told apart from
   * "they deleted it", and a two-way union resurrects every deletion.
   */
  rememberSyncBase(namespace, key, value, uid) {
    if (!namespace) return;
    const owner = uid || this.syncStates.get(namespace)?.userId || null;
    const empty = value === null || value === undefined;
    // `hash` is the whole agreed value; `entries` is the per-entry index the
    // three-way merge needs. A value with no internal structure (a string, a
    // preference) still gets a base record, because the hash alone is what
    // proves the cloud has not moved.
    const base = empty
      ? null
      : { ...(valueIndex(value) || { kind: 'opaque', entries: null }), hash: hashValue(value) };
    try {
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const storeKey = SYNC_BASE_KEY_PREFIX + namespace;
      let all = {};
      try { all = JSON.parse(getItem(storeKey) || '{}') || {}; } catch (_) { all = {}; }
      // The agreed state belongs to one account. Another tab may already have
      // handed this namespace to a different account on this device (S-2); a
      // late acknowledgement from the old session must not write its base
      // under the new owner.
      if (all.__owner && owner && all.__owner !== owner) return;
      this.syncBases.set(this.chunkCountKey(namespace, key), base);
      if (owner) all.__owner = owner;
      if (base) all[key] = base; else delete all[key];
      setItem(storeKey, JSON.stringify(all));
    } catch (_) {
      // Storage full or blocked. The in-memory base still works for this
      // session; after a reload the merge degrades to a conflict copy, which
      // is the safe direction.
    }
  }

  rememberSyncBaseForKey(key, value) {
    this.rememberSyncBase(this.namespaceOfKey(key), key, value);
  }

  /**
   * The agreed base record for a key, from memory or from the last session.
   *
   * Reads both the current tagged form and the bare id->hash object written
   * before maps were mergeable, so an upgrading device keeps the base it
   * already had. A legacy record has no `hash`, so it still merges but
   * cannot short-circuit an unchanged cloud until the next agreement.
   */
  syncBaseRecordFor(key) {
    const namespace = this.namespaceOfKey(key);
    if (!namespace) return null;
    const mapKey = this.chunkCountKey(namespace, key);
    if (this.syncBases.has(mapKey)) return this.syncBases.get(mapKey);
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const all = JSON.parse(getItem(SYNC_BASE_KEY_PREFIX + namespace) || '{}') || {};
      const reader = this.syncStates.get(namespace);
      if (all && all.__owner && reader && all.__owner !== reader.userId) {
        this.syncBases.set(mapKey, null);
        return null;
      }
      const base = all && typeof all[key] === 'object' ? all[key] : null;
      this.syncBases.set(mapKey, base);
      return base;
    } catch (_) { return null; }
  }

  /** The hash of the whole value the two sides last agreed on, if known. */
  syncBaseHashFor(key) {
    const base = this.syncBaseRecordFor(key);
    return base && typeof base.hash === 'string' ? base.hash : null;
  }

  /** The agreed base as the merge wants it: a shape tag and an entry index. */
  syncBaseFor(key) {
    return this.syncBaseRecordFor(key);
  }

  /* ---------------------------------------------------------------------
   * Revision persistence.
   *
   * `rev` is a Lamport counter, and a counter that restarts at zero on every
   * page load is not one. Before this, a reload put the map back to empty,
   * so the first edit a user made after opening the page was rev 1 against a
   * cloud sitting at rev 40, and pickConflictWinner handed the cloud the
   * win on revision alone: a fresh local edit replaced by an older cloud
   * value, surviving only as an unreachable recovery copy.
   *
   * Stored per namespace, one small record per REGISTERED key, so the size
   * is bounded by the app's key list and cannot grow with the data. Stamped
   * with the uid that wrote it, because a second account on a shared browser
   * must not inherit the first one's revisions.
   * ------------------------------------------------------------------- */

  persistRevisions(namespace) {
    const state = this.syncStates.get(namespace);
    if (!state || state.stopped) return;
    // Compare-and-set on the owner. Another tab may have handed this namespace
    // to a different account (S-2); this session stopping late must not stamp
    // the old account back over it.
    const stored = this.readStoredJson(SYNC_REV_KEY_PREFIX + namespace);
    if (stored && stored.uid && stored.uid !== state.userId) return;
    const out = { uid: state.userId, keys: {} };
    for (const key of state.keys) {
      const rev = this.localRevisions.get(key);
      if (!rev) continue;
      out.keys[key] = {
        rev: Number(rev.rev) || 0,
        hash: String(rev.hash || ''),
        updatedAt: Number(rev.updatedAt) || 0,
        dirty: !!rev.dirty
      };
    }
    try {
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      setItem(SYNC_REV_KEY_PREFIX + namespace, JSON.stringify(out));
    } catch (_) {
      // Storage full or blocked: this session still has the in-memory map,
      // and the next reload degrades to the old zero-based behaviour.
    }
  }

  /** Coalesce a burst of revision changes into one localStorage write. */
  schedulePersistRevisions(namespace) {
    if (!namespace || this.revisionWrites.has(namespace)) return;
    this.revisionWrites.add(namespace);
    const run = () => {
      this.revisionWrites.delete(namespace);
      this.persistRevisions(namespace);
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  /**
   * Restore the revision map for a namespace that is starting up.
   *
   * The stored hash is checked against what is actually in localStorage now.
   * A value that changed while this device was not running (another tab, an
   * import, a hand edit) is unacknowledged work: the revision is kept, so
   * the Lamport clock does not fall back, and the key is marked dirty, so
   * the next remote delivery treats it as ours to defend rather than as a
   * clean copy to silently overwrite.
   */
  restoreRevisions(state) {
    let stored = null;
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      stored = JSON.parse(getItem(SYNC_REV_KEY_PREFIX + state.namespace) || 'null');
    } catch (_) { return; }
    if (!stored || typeof stored !== 'object') return;
    if (stored.uid !== state.userId) return;   // a different account's counters
    const saved = stored.keys && typeof stored.keys === 'object' ? stored.keys : {};
    // What was on disk, untouched, so requeueDirtyKeys can tell the write that
    // never landed apart from a value that drifted afterwards.
    state.restoredRevisions = saved;

    for (const key of state.keys) {
      const entry = saved[key];
      if (!entry || typeof entry !== 'object') continue;
      const currentHash = hashValue(this.readLocalValue(key));
      const drifted = currentHash !== String(entry.hash || '');
      // A value an app rewrote for itself while no session ran (defaults, a
      // floor record) is not the account's work: it stays clean and the agreed
      // base is dropped, so the cloud's value replaces it instead of it being
      // defended or uploaded (audit S-4).
      const placeholder = drifted && this.isPlaceholder(key);
      if (placeholder) {
        // Revision 0 as well: a restored revision above the cloud's would make
        // the cloud look OLDER, and skip-older would republish the placeholder.
        this.forgetSyncBase(state.namespace, key);
        this.localRevisions.set(key, { rev: 0, updatedAt: 0, hash: currentHash, dirty: false });
        continue;
      }
      this.localRevisions.set(key, {
        rev: Number(entry.rev) || 0,
        updatedAt: Number(entry.updatedAt) || 0,
        hash: currentHash,
        dirty: !!entry.dirty || drifted
      });
    }
  }

  /** This device's current value for a key, parsed. */
  readLocalValue(key) {
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const raw = getItem(key);
      if (raw === null || raw === undefined) return null;
      return parseValue(raw);
    } catch (_) { return null; }
  }

  /**
   * Resolve a conflict: both this device and the cloud have changed a key
   * since they last agreed.
   *
   * Order of preference:
   *   1. MERGE, when the value is a collection of identified records. A
   *      three-way merge against the agreed base keeps both devices'
   *      additions, honours both devices' deletions, and only falls back to
   *      a per-record winner for records both sides edited. This is the case
   *      that matters: gymTrackerSessions, footballH2HGames,
   *      maptapRivalsGames and marioKartRaces are all one localStorage value
   *      holding many independent records, so before this an evening logged
   *      on a phone and an evening logged on a laptop competed for the whole
   *      collection and one of them lost.
   *   2. Otherwise a deterministic winner, with the LOSER PRESERVED as a
   *      recoverable copy and the page told, rather than silently dropped.
   *
   * @returns {object|null} the remoteInfo to apply, or null when the local
   *          value stands (in which case it is re-queued so the cloud
   *          converges on it).
   */
  resolveConflict(key, localRev, remoteInfo) {
    const localValue = this.readLocalValue(key);
    const remoteValue = remoteInfo.deleted ? null : remoteInfo.value;
    const nextRev = Math.max((localRev && localRev.rev) || 0, remoteInfo.rev || 0) + 1;

    // A DERIVED value is a cache the app can rebuild (a fetched profile
    // snapshot, a UI selection). Both ends still have to converge, so the
    // same deterministic winner is chosen, but keeping a recovery copy of a
    // regenerable value and telling the user about it is noise: there is
    // nothing they typed to recover and nothing for them to do.
    if (this.policyForKey(key) === 'derived') {
      if (pickConflictWinner(localRev, remoteInfo) === 'remote') return remoteInfo;
      this.publishResolved(key, localValue, nextRev);
      return null;
    }

    // NO AGREED BASE (audits S-4, T-3): this device's copy was made without
    // ever seeing the cloud's (signed-out work on a first sign-in, or an edit
    // made before the first server snapshot). The cloud is the account's
    // established state, so where the two genuinely disagree it stays live and
    // this device's version is kept as a recovery copy; the content-hash
    // tie-break would hand an arbitrary half of the entries to a copy that
    // never saw the other. Entries only one side holds are unaffected.
    const hasBase = !!this.syncBaseRecordFor(key);
    const merge = (remoteValue === null || localValue === null)
      ? null
      : mergeValues(this.syncBaseFor(key), localValue, remoteValue, { preferRemote: !hasBase });

    if (merge) {
      // A merge loses nothing structurally, so a conflict copy is only kept
      // when individual records genuinely disagreed.
      if (merge.conflicts.length) {
        this.preserveConflictCopy(key, localValue, 'record-conflict', merge.conflicts);
      }
      // Nothing of this device's survives beyond what the cloud already holds
      // (and what the copy above kept): apply the cloud as it is, rather than
      // re-uploading an identical value at a new revision.
      if (typeof remoteInfo.hash === 'string' && hashValue(merge.merged) === remoteInfo.hash) {
        if (merge.conflicts.length) {
          this.notifyConflict(key, { resolution: 'remote-wins', conflictedRecordIds: merge.conflicts });
        }
        return remoteInfo;
      }
      this.publishResolved(key, merge.merged, nextRev);
      this.notifyConflict(key, {
        resolution: 'merged',
        recordCount: Array.isArray(merge.merged)
          ? merge.merged.length
          : Object.keys(merge.merged).length,
        conflictedRecordIds: merge.conflicts,
      });
      return {
        rev: nextRev,
        updatedAt: remoteInfo.updatedAt,
        hash: hashValue(merge.merged),
        value: merge.merged,
        // The merged value has been QUEUED by publishResolved, not accepted
        // by the cloud, so it is still unacknowledged work. Without this the
        // apply path below stamped it clean a moment after publishResolved
        // marked it dirty, and the next remote delivery was then entitled to
        // replace a merge this device had not managed to upload yet.
        queuedLocally: true,
      };
    }

    const winner = hasBase
      ? pickConflictWinner(localRev, remoteInfo)
      : (((localRev && localRev.rev) || 0) > (remoteInfo.rev || 0) ? 'local' : 'remote');
    if (winner === 'remote') {
      this.preserveConflictCopy(key, localValue, 'local-superseded', []);
      this.notifyConflict(key, { resolution: 'remote-wins' });
      return remoteInfo;
    }
    // Local stands. Preserve THEIR version and republish ours so the cloud
    // stops holding a value nobody is looking at.
    this.preserveConflictCopy(key, remoteValue, 'remote-superseded', []);
    this.publishResolved(key, localValue, nextRev);
    this.notifyConflict(key, { resolution: 'local-wins' });
    return null;
  }

  /**
   * Write the losing side of a conflict where it can be recovered.
   *
   * Deliberately a plain localStorage key outside every namespace's key set:
   * it must never sync (a conflict copy is device-local evidence, not shared
   * state) and must never be mistaken for the live value. Capped, oldest
   * first, so a device that conflicts repeatedly cannot fill its own storage.
   */
  preserveConflictCopy(key, value, reason, recordIds) {
    if (value === null || value === undefined) return;
    const entry = {
      key,
      reason,
      recordIds: Array.isArray(recordIds) ? recordIds.slice(0, 50) : [],
      at: new Date().toISOString(),
      value,
    };
    try {
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const removeItem = this.originalMethods?.removeItem || localStorage.removeItem.bind(localStorage);
      let index = [];
      try { index = JSON.parse(getItem(CONFLICT_INDEX_KEY) || '[]') || []; } catch (_) { index = []; }
      const id = `${CONFLICT_KEY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setItem(id, JSON.stringify(entry));
      index.push({ id, key, reason, at: entry.at });
      while (index.length > MAX_CONFLICT_COPIES) {
        const dropped = index.shift();
        try { removeItem(dropped.id); } catch (_) { /* already gone */ }
      }
      setItem(CONFLICT_INDEX_KEY, JSON.stringify(index));
      this.conflictRecords.push({ id, key, reason, at: entry.at });
    } catch (_) {
      // A conflict copy we cannot store must not stop the resolution: the
      // merge or the winner still applies, and the page is still told.
    }
  }

  /** The recovery-copy index this device is holding, oldest first. */
  listConflictCopies() {
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const index = JSON.parse(getItem(CONFLICT_INDEX_KEY) || '[]');
      return Array.isArray(index) ? index : [];
    } catch (_) { return []; }
  }

  /** One recovery copy by id, or null when it has aged out of the cap. */
  readConflictCopy(id) {
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const raw = getItem(String(id));
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  /** Queue a resolved value for upload without going through setItem. */
  publishResolved(key, value, rev) {
    const namespace = this.namespaceOfKey(key);
    const state = namespace ? this.syncStates.get(namespace) : null;
    if (!state) return;
    const queue = this.writeQueues.get(namespace);
    if (!queue) return;
    const hash = hashValue(value);
    queue.set(key, { value, rev, updatedAt: Date.now(), deleted: false, hash });
    this.localRevisions.set(key, { rev, updatedAt: Date.now(), hash, dirty: true });
    this.schedulePersistRevisions(namespace);
    this.armFlushTimer(state, DEBOUNCE_MS);
  }

  /**
   * Re-send this device's current value because the cloud is holding an
   * older logical version of it. Without this, `skip-older` left the two
   * ends permanently different with nothing to repair them.
   */
  republishLocalValue(key) {
    const value = this.readLocalValue(key);
    if (value === null) return;
    const localRev = this.localRevisions.get(key);
    this.publishResolved(key, value, ((localRev && localRev.rev) || 0) + 1);
  }

  /** Tell the page a conflict happened, so it can offer recovery. */
  notifyConflict(key, detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try {
      window.dispatchEvent(new CustomEvent('syncConflict', {
        detail: { key, ...detail, copies: this.conflictRecords.slice(-5) }
      }));
    } catch (_) { /* never let a notification break a sync */ }
  }

  /**
   * Enhanced write queueing with deduplication.
   *
   * Hash basis must be the parsed value, not the raw setItem string. The
   * two paths that touch `localRevisions[key].hash` are this function
   * (after a local setItem) and `applyRemoteChange` (after a remote
   * delivery); the latter hashes the parsed object it just installed.
   * Hashing the raw string here and the parsed object there produces
   * different digests for the *same* JSON content, so the no-op skip
   * below misses local writebacks of remote data — every UI re-render
   * loop that calls `setItem` with the same value (e.g. football's
   * `updateUI` → `updatePlayerNames` → `savePlayers`) gets requeued and
   * flushed, the peer sees a write, fires its own re-render, the cycle
   * repeats once per RTT. Parse first, hash the parsed form.
   */
  queueWrite(state, key, value) {
    const queue = this.writeQueues.get(state.namespace);

    let parsedValue = value;
    if (value !== null && value !== undefined) {
      try {
        parsedValue = JSON.parse(value);
      } catch {
        // Keep as string if not valid JSON.
      }
    }

    const currentHash = hashValue(parsedValue);
    const localRev = this.localRevisions.get(key) || { rev: 0, hash: '' };

    // Skip if value hasn't actually changed.
    if (currentHash === localRev.hash) {
      return;
    }

    const newRev = localRev.rev + 1;
    const now = Date.now();

    // Before the initial merge (T-3) the write only waits. Remember what the
    // key was before it and whether a person made it, so an app's own boot
    // write can still give way to the cloud's value (prepareInitialReconciliation).
    if (!state.initialMergeDone) {
      if (!state.preMergePrior.has(key)) state.preMergePrior.set(key, this.localRevisions.get(key) || null);
      state.preMergeWork.set(key, !!state.preMergeWork.get(key) || this.userHasInteracted());
    }
    
    queue.set(key, {
      value: parsedValue,
      rev: newRev,
      updatedAt: now,
      deleted: value === null,
      hash: currentHash
    });

    this.localRevisions.set(key, {
      rev: newRev,
      updatedAt: now,
      hash: currentHash,
      // DIRTY until the cloud accepts it. This, not a clock comparison, is
      // what decideRemoteChange uses to tell "the cloud moved and we did
      // not" (take theirs) from "we both moved" (a conflict). Comparing a
      // device's Date.now() against a Firestore server timestamp made the
      // answer depend on how well the two clocks happened to agree, and a
      // device one hour fast rejected every legitimate update for an hour.
      dirty: true
    });
    this.schedulePersistRevisions(state.namespace);

    // Debounced write with exponential backoff on failure. Also the "next
    // local change" trigger for a parked write: the flush sends the whole
    // queue, parked entries included.
    const delay = state.retryCount > 0 ? 
      DEBOUNCE_MS * Math.pow(2, state.retryCount) : DEBOUNCE_MS;
    this.armFlushTimer(state, delay);
  }

  /**
   * Send the queue. Success marks the keys clean; failure is classified:
   * permanent (one attempt, announced, keys stay dirty), retryable within the
   * ladder (requeue, back off), or retryable past it (requeue, park,
   * announce). See the S-3 block above installFlushTriggers.
   */
  flushWrites(state) {
    const flight = this.runFlush(state);
    this.activeFlushes.add(flight);
    flight.then(() => this.activeFlushes.delete(flight));
    return flight;
  }

  async runFlush(state) {
    // A stopped session's queue belongs to nobody. writeQueues is keyed by
    // namespace, so a timer outliving stopSync would otherwise flush the
    // namespace's NEXT session's queue under this session's uid.
    if (state.stopped) return;
    // T-3: nothing leaves before the cloud has been read and reconciled. The
    // queue is left intact; completeInitialMerge sends it.
    if (!state.initialMergeDone) return;
    // S-5: the account is being deleted. This session must not write again.
    if (this.isAccountDeletionLatched(state.userId)) {
      this.stopSync(state.namespace);
      return;
    }
    // S-2: another tab handed this namespace's local copy to a different
    // account. What this session queued is its own account's work: it is not
    // sent (the stamp says the local copy is someone else's now), and where it
    // is still the stored value it is parked for this session's account rather
    // than left for the new owner to adopt.
    if (!this.ownsNamespace(state)) {
      const queued = this.writeQueues.get(state.namespace);
      if (queued && queued.size) {
        const stillOurs = Array.from(queued)
          .filter(([key, entry]) => hashValue(this.readLocalValue(key)) === entry.hash)
          .map(([key]) => key);
        if (stillOurs.length) this.parkForeignLocalData(state.namespace, stillOurs, state.userId);
      }
      this.stopSync(state.namespace);
      return;
    }
    const queue = this.writeQueues.get(state.namespace);
    if (!queue || queue.size === 0) return;

    // Whatever caused this flush is the one resend a parked write gets, and a
    // pending backoff is superseded by it.
    state.parked = false;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    // Copy queue and clear it
    const writes = new Map(queue);
    queue.clear();
    state.inFlight = (state.inFlight || 0) + writes.size;

    try {
      await this.flushToFirestore(state, writes);

      state.retryCount = 0;
      state.lastSyncTime = Date.now();

      // The cloud has accepted these values, so this device no longer holds
      // anything the cloud has not seen: the keys are clean, and what was
      // written is now the state both sides agree on.
      for (const [key, info] of writes) {
        const rev = this.localRevisions.get(key);
        if (rev && rev.rev === info.rev) this.localRevisions.set(key, { ...rev, dirty: false });
        this.rememberSyncBase(state.namespace, key, info.deleted ? null : info.value, state.userId);
      }
      // Stopped while this was on the wire (a sign-out whose bounded wait ran
      // out, say) and nothing has restarted: there is no live revision map to
      // persist, and the one on disk still says dirty, so the next start
      // would send the write a second time.
      if (!this.syncStates.has(state.namespace)) this.markAckedOnDisk(state, writes);
      this.schedulePersistRevisions(state.namespace);
      this.noteWriteRecovered(state, writes);

      // Broadcast to peer tabs that this namespace just changed. Their
      // onSnapshot listeners will eventually fire too, but a same-origin
      // BroadcastChannel post arrives synchronously and lets a stale
      // listener tab (backgrounded, mid-reconnect) re-render immediately.
      if (this.channel) {
        this.channel.publish(CHANNEL_MESSAGE_TYPES.DATA_UPDATED, {
          namespace: state.namespace,
          keys: Array.from(writes.keys())
        });
      }

    } catch (error) {
      console.error(`❌ Failed to flush writes for ${state.namespace}:`, error);

      // A deterministic rejection (our size guard, Firestore refusing the
      // document shape, the rules refusing the write) fails identically
      // however often it is resent, so the retry ladder is pure waste, and
      // worse than waste while the app keeps appending to the same key
      // between attempts, which is how the MapTap Rivals incident turned a
      // 760 KB refusal into an 890 KB one. Do not requeue the batch; its keys
      // stay dirty, so the next sync start tries them once. Tell the page.
      if (isPermanentWriteError(error)) {
        console.error(`🛑 Permanent write rejection for ${state.namespace}; not retrying:`, error.message);
        state.retryCount = 0;
        this.notifyWriteRejected(state, writes, error, false);
        return;
      }

      // Re-queue failed writes, but never OVER a newer entry the user made
      // while this flush was in flight; see requeueFailedWrites for the
      // data-loss race this guards against.
      requeueFailedWrites(queue, writes);

      if (state.retryCount < MAX_RETRY_ATTEMPTS) {
        state.retryCount++;
        console.log(`🔄 Retrying write flush (${state.retryCount}/${MAX_RETRY_ATTEMPTS})`);
        if (!state.stopped) {
          state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            this.flushWrites(state);
          }, RETRY_DELAY_MS * state.retryCount);
        }
      } else {
        // Out of retries on a failure that CAN still succeed. This used to
        // drop the batch with nothing but this console line, while the key
        // stayed dirty and the pill read "Synced". The writes are back in the
        // queue; they wait for a bounded trigger rather than a timer, so a
        // backend that stays down is not hammered forever.
        console.error(`💥 Max retry attempts exceeded for ${state.namespace}; parked until the next trigger`);
        state.retryCount = 0;
        state.parked = true;
        this.notifyWriteRejected(state, writes, error, true);
      }
    } finally {
      state.inFlight = Math.max(0, (state.inFlight || 0) - writes.size);
    }
  }

  /**
   * Record, on disk, that writes from a STOPPED session were acknowledged.
   * Only an entry still describing exactly the write that landed (same rev,
   * same hash) is marked clean; anything newer stays dirty.
   */
  markAckedOnDisk(state, writes) {
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      const storeKey = SYNC_REV_KEY_PREFIX + state.namespace;
      const stored = JSON.parse(getItem(storeKey) || 'null');
      if (!stored || stored.uid !== state.userId || !stored.keys || typeof stored.keys !== 'object') return;
      let changed = false;
      for (const [key, info] of writes) {
        const entry = stored.keys[key];
        if (entry && entry.dirty
            && Number(entry.rev) === Number(info.rev)
            && String(entry.hash || '') === String(info.hash || '')) {
          entry.dirty = false;
          changed = true;
        }
      }
      if (changed) setItem(storeKey, JSON.stringify(stored));
    } catch (_) {
      // Storage blocked or unreadable: the worst case is one duplicate of a
      // write the cloud already holds, which is idempotent.
    }
  }

  /**
   * Tell the page a namespace it was told about has fully landed.
   *
   * Key by key, not flush by flush: a different key succeeding is not
   * evidence that the rejected one did.
   */
  noteWriteRecovered(state, writes) {
    const pending = this.rejectedWrites.get(state.namespace);
    if (!pending) return;
    const live = this.syncStates.has(state.namespace);
    for (const key of Array.from(pending)) {
      const rev = this.localRevisions.get(key);
      // With a live session the revision map is the truth; without one, only
      // what this very flush carried is known to have landed.
      if (live ? (!rev || !rev.dirty) : writes.has(key)) pending.delete(key);
    }
    if (pending.size) return;
    this.rejectedWrites.delete(state.namespace);
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try {
      window.dispatchEvent(new CustomEvent('syncWriteRecovered', {
        detail: { namespace: state.namespace }
      }));
    } catch (_) { /* never let a notification break a sync */ }
  }

  /**
   * Surface a batch that did not reach the cloud.
   *
   * The data is safe in localStorage either way; what differs is whether the
   * engine will send it again by itself. EVENT CONTRACT (the shared
   * sync-status widget and app pills code against it; add fields, never
   * rename or remove):
   *
   *   syncWriteRejected  { namespace, keys, code, message, retryable }
   *     retryable true:  parked after the retry ladder; resent on the next
   *                      bounded trigger.
   *     retryable false: refused; the keys stay dirty and the next sync start
   *                      tries once.
   *   syncWriteRecovered { namespace } once every rejected key has landed.
   *
   * @param {object} state sync state whose flush failed
   * @param {Map<string, object>} writes the batch that did not land
   * @param {Error} error the failure
   * @param {boolean} retryable whether the engine will resend it itself
   */
  notifyWriteRejected(state, writes, error, retryable) {
    const keys = Array.from(writes.keys());
    let pending = this.rejectedWrites.get(state.namespace);
    if (!pending) {
      pending = new Set();
      this.rejectedWrites.set(state.namespace, pending);
    }
    for (const key of keys) pending.add(key);
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try {
      window.dispatchEvent(new CustomEvent('syncWriteRejected', {
        detail: {
          namespace: state.namespace,
          keys,
          code: error?.code || 'unknown',
          message: error?.message || String(error),
          retryable: retryable === true
        }
      }));
    } catch (_) {
      // An app must never break because we could not announce a failure.
    }
  }

  /**
   * Firestore flush — surgical merge of only the keys this flush owns.
   *
   * Earlier versions wrapped this in `runTransaction` and spread the
   * whole `currentData.data` back into the write payload (to bump a
   * never-read `syncVersion`). When two browsers were signed into the
   * same account, that pattern reliably produced a `400 Bad Request`
   * at `/documents:commit`: the spread re-included field paths whose
   * values had just been touched by `serverTimestamp()` on the other
   * browser, and Firestore rejects a literal + transform on the same
   * field path in a single commit. The spread also bloated payloads
   * toward the 1 MiB doc limit. We now write only the changed keys,
   * letting `merge: true` preserve everything else, and drop the
   * unused syncVersion bookkeeping.
   *
   * Each value is sanitised through `JSON.parse(JSON.stringify(...))`
   * to strip any `undefined` fields — Firestore rejects undefined and
   * the override path can hand us them via `JSON.parse` round-trips.
   */
  async flushToFirestore(state, writes) {
    const docPath = `users/${state.userId}/apps/${state.namespace}`;
    const docRef = doc(db, docPath);

    // BEFORE the network call, not after it. The committed echo can reach
    // the watch stream while this function is still working through its
    // chunk writes and its stale-part sweep, and an echo we do not yet
    // recognise as ours is exactly the false conflict this fixes.
    this.rememberOwnWrites(writes);

    const entries = [];       // { key, entry, bytes } for the inline document
    const chunkWrites = [];   // part documents to write before the manifest
    const staleChunks = [];   // part documents of the SUPERSEDED snapshot
    const newlyCommitted = [];// countKey -> { version, parts } once published

    for (const [key, info] of writes) {
      if (info.deleted) {
        // TOMBSTONE, not deleteField(). The reader loop only visits keys that
        // are PRESENT in the document (see initFirestoreSync), so a removed
        // field is invisible to every peer: the key survived on the other
        // device, and that device's next initial merge saw a key it had and
        // the cloud did not, so uploadLocalOnlyKeys put it straight back.
        // "Disconnect your FPL team" and Gym's "Delete cloud data" both
        // promise the opposite. An explicit `deleted: true` entry is the
        // shape applyRemoteChange already knows how to honour, it carries a
        // rev and a timestamp so the usual last-writer-wins comparison
        // applies, and uploadLocalOnlyKeys treats it as "present remotely"
        // so the delete is not undone on the next load.
        entries.push(measureEntry(key, {
          deleted: true,
          value: null,
          rev: info.rev,
          updatedAt: serverTimestamp(),
          hash: hashValue(null)
        }));
        staleChunks.push(...this.supersededChunkRefs(state, key));
        continue;
      }

      const value = sanitiseForFirestore(info.value);
      const serialised = JSON.stringify(value === undefined ? null : value);

      if (serialised.length <= MAX_INLINE_VALUE_CHARS) {
        const entry = { value, rev: info.rev, updatedAt: serverTimestamp(), hash: info.hash };
        entries.push(measureEntry(key, entry));
        // A value that shrank back under the threshold leaves its old parts
        // behind; they are unreferenced the moment this manifest-free entry
        // lands, so they are swept below.
        staleChunks.push(...this.supersededChunkRefs(state, key));
        continue;
      }

      // Immutable snapshot: a fresh version token means fresh part documents,
      // so nothing another reader may currently be assembling is overwritten.
      const version = chunkVersionToken(info.rev, info.hash);
      const parts = splitIntoChunks(serialised, CHUNK_CHARS);
      parts.forEach((part, seq) => {
        chunkWrites.push({
          ref: doc(db, `${docPath}/${CHUNK_COLLECTION}/${chunkDocId(key, seq, version)}`),
          body: { key, seq, part, version }
        });
      });
      const entry = {
        chunked: true,
        parts: parts.length,
        rev: info.rev,
        updatedAt: serverTimestamp(),
        hash: info.hash,
        // What the reader checks the reassembled value against. `chars` is
        // the serialised length, so a short read is caught before JSON.parse
        // gets a chance to accept a truncation that happens to still parse.
        chunkVersion: version,
        chars: serialised.length
      };
      entries.push(measureEntry(key, entry));
      // The PREVIOUS snapshot, collected below - after this manifest lands.
      staleChunks.push(...this.supersededChunkRefs(state, key));
      this.chunkCounts.set(this.chunkCountKey(state.namespace, key), parts.length);
      newlyCommitted.push([this.chunkCountKey(state.namespace, key), { version, parts: parts.length }]);
    }

    // Parts first, manifest second. A peer whose listener fires between the
    // two writes must never see a manifest pointing at documents that are
    // not there yet: it would reassemble a truncated value and JSON.parse
    // would throw. In the other order it simply reads the previous version.
    await Promise.all(chunkWrites.map(({ ref, body }) => setDoc(ref, body)));

    // Refuse to ship a payload that would breach Firestore's 1 MiB doc
    // ceiling. After chunking no single entry can reach it, so this is a
    // guard against a shape we have not anticipated; it is raised as a
    // PERMANENT error because resending it would fail identically.
    const { batches, oversized } = planFlushBatches(entries, MAX_FLUSH_BYTES - FLUSH_ENVELOPE_BYTES);
    if (oversized.length) {
      const error = new Error(
        `Refusing to flush ${state.namespace}: ${oversized.join(', ')} exceeds ${MAX_FLUSH_BYTES}B on its own`
      );
      error.code = 'payload-too-large';
      error.permanent = true;
      throw error;
    }

    for (const batch of batches) {
      await setDoc(docRef, {
        data: batch,
        meta: { lastUpdated: serverTimestamp() }
      }, { merge: true });
    }

    // ONLY NOW. Every part above is written before the manifest, and the
    // previous snapshot's parts are deleted only after it - so at no instant
    // is there a published manifest whose parts are absent or belong to a
    // different version. A reader caught in the middle reads the previous
    // committed snapshot, whole.
    //
    // Best-effort deletion: an orphan part document is never read (the
    // manifest names its version) and costs a little storage until the next
    // sweep. Losing the pointer to it is worse than leaving it, so the
    // bookkeeping below only advances for keys whose manifest landed.
    for (const [countKey, committed] of newlyCommitted) {
      this.committedChunks.set(countKey, committed);
    }
    for (const ref of staleChunks) {
      try { await deleteDoc(ref); } catch (_) { /* swept again next time */ }
    }
  }

  // Which account the synced localStorage keys on this device belong to.
  // Deliberately a plain key outside every namespace's key set, so it is
  // never itself synced and notifyLocalChange ignores it.
  syncedDataOwner() {
    try {
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      return getItem(SYNC_OWNER_KEY) || null;
    } catch (_) { return null; }
  }

  /* ---------------------------------------------------------------------
   * The account boundary (2026-09-12 audit S-2, S-4, S-5, T-3).
   *
   * The merge core above (tombstones, Lamport revisions, versioned chunks,
   * the three-way merge, own-write recognition) decides what happens between
   * two copies of ONE account's data. This section decides whose data a local
   * copy is, whether it may be sent at all, and when. Four invariants:
   *
   *   1. OWNERSHIP. Each namespace's revision record (shevato:sync-revs:<ns>)
   *      names the account the local copy belongs to, stamped when a session
   *      starts. A session for a different account never adopts it: that
   *      account's unsynced work is parked (shevato:sync-parked:<ns>) and put
   *      back when it signs in here again, its clean data (already in its own
   *      cloud) is removed, and a page that LOADED it reloads before syncing,
   *      because the page's apps still hold it in memory. Every write re-checks
   *      the stamp, so another tab cannot switch the owner under a session.
   *   2. SIGNED-OUT WORK. A local value this account's session has no revision
   *      for was made while no session ran. If a person produced it (a write
   *      after the page saw a user gesture, or provenance unknown), it is
   *      unacknowledged local work: it meets the cloud through the normal
   *      conflict path, and is uploaded where the cloud has nothing. If only an
   *      app's own boot produced it (defaults, Trip Planner's floor trip), it
   *      is a placeholder and the cloud replaces it without a copy or a notice.
   *   3. DELETION. From the moment deletion begins, a latch in localStorage
   *      names the account, and no tab starts, merges or sends for it. A
   *      finished deletion keeps the account on the latch; a failed one clears
   *      it; an abandoned one (its tab closed) is recognised when its lock is
   *      released or its heartbeat stops.
   *   4. INITIALISATION. A namespace sends nothing until its first
   *      server-confirmed snapshot has been applied, chunked values included.
   *      Edits made before that stay queued and dirty, meet the cloud through
   *      the normal merge, and go afterwards.
   * ------------------------------------------------------------------- */

  installAccountBoundaryListeners() {
    if (this._boundaryListenersInstalled) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this._boundaryListenersInstalled = true;
    // Another tab began deleting an account (or its heartbeat ticked): stop
    // every session for it here before a debounce or a snapshot can send.
    window.addEventListener('storage', (event) => {
      if (!event || event.key !== SYNC_DELETION_KEY) return;
      const { active } = this.readDeletionRecord();
      if (active) this.suspendSyncForDeletion(active.uid);
    });
  }

  rawStorage() {
    return {
      getItem: this.originalMethods?.getItem || localStorage.getItem.bind(localStorage),
      setItem: this.originalMethods?.setItem || localStorage.setItem.bind(localStorage),
      removeItem: this.originalMethods?.removeItem || localStorage.removeItem.bind(localStorage)
    };
  }

  readStoredJson(key) {
    try { return JSON.parse(this.rawStorage().getItem(key) || 'null'); } catch (_) { return null; }
  }

  readRaw(key) {
    try { return this.rawStorage().getItem(key); } catch (_) { return null; }
  }

  /** Put an exact stored string back (or remove it) under the echo lock. */
  writeRawUnderLock(key, raw) {
    this.syncLocks.set(key, true);
    try {
      const { setItem, removeItem } = this.rawStorage();
      if (raw === null || raw === undefined) removeItem(key);
      else setItem(key, String(raw));
    } finally {
      this.syncLocks.delete(key);
    }
  }

  newLatchId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** What startStorageSync hands back when no session was started. */
  inertHandle(namespace) {
    return { stop: () => {}, getStatus: () => this.getSyncStatus(namespace) };
  }

  notifyAppSyncHeld(namespace, message) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try {
      window.dispatchEvent(new CustomEvent('appSyncFailed', { detail: { namespace, message } }));
    } catch (_) { /* never let a notification break a page */ }
  }

  // ---- 1. ownership ------------------------------------------------------

  /**
   * Which account the local copy of a namespace belongs to: a uid, the
   * UNKNOWN_OWNER of data some account synced before ownership was recorded
   * per namespace, or null for data this device has never synced.
   */
  readOwnershipEpochs(raw) {
    try {
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  /**
   * Whether local data in this namespace was moved for an account after this
   * page started loading. sync-immediate.js, the first script on every app
   * page, records the tokens before any app reads storage.
   */
  ownershipMovedSinceBoot(namespace) {
    const boot = typeof window !== 'undefined' ? window.__shevatoSyncBoot : null;
    if (!boot || !Object.prototype.hasOwnProperty.call(boot, 'ownershipEpochs')) return false;
    const then = this.readOwnershipEpochs(boot.ownershipEpochs)[namespace] || null;
    const now = this.readOwnershipEpochs(this.readRaw(SYNC_OWNERSHIP_EPOCH_KEY))[namespace] || null;
    return then !== now;
  }

  /**
   * Called BEFORE local data is parked, restored or cleared for an account, so
   * a page registering late sees either the lineage its apps read or a moved
   * token, never the moved data under an unchanged one. False if unrecorded,
   * in which case the caller leaves the data where it is.
   */
  bumpOwnershipEpoch(namespaces) {
    try {
      const all = this.readOwnershipEpochs(this.readRaw(SYNC_OWNERSHIP_EPOCH_KEY));
      for (const namespace of [].concat(namespaces)) all[namespace] = this.newLatchId();
      this.rawStorage().setItem(SYNC_OWNERSHIP_EPOCH_KEY, JSON.stringify(all));
      return true;
    } catch (_) { return false; }
  }

  lineageOf(namespace) {
    const revs = this.readStoredJson(SYNC_REV_KEY_PREFIX + namespace);
    if (revs && typeof revs.uid === 'string' && revs.uid) return { owner: revs.uid };
    // No revision record, but an agreed base: some account synced this before
    // the record existed. The old device-wide marker may name it.
    const base = this.readStoredJson(SYNC_BASE_KEY_PREFIX + namespace);
    const synced = !!base && typeof base === 'object' && Object.keys(base).some((k) => k !== '__owner');
    if (synced) return { owner: base.__owner || this.syncedDataOwner() || UNKNOWN_OWNER };
    return { owner: null };
  }

  hasLocalData(keys) {
    for (const key of keys) if (this.readRaw(key) !== null) return true;
    return false;
  }

  /**
   * Every namespace and its keys, known before anyone signs in (app-sync-init
   * registers them at load). The first registration of a namespace records
   * what this page loaded, which is what `bootLineage` means.
   */
  registerLocalNamespaces(configs) {
    this.flushUnsessionedWrites();
    for (const config of Array.isArray(configs) ? configs : []) {
      const namespace = config && config.namespace;
      const keys = config && Array.isArray(config.keys) ? config.keys : [];
      if (typeof namespace !== 'string' || !namespace) continue;
      for (const key of keys) this.localKeyNamespaces.set(key, namespace);
      if (!this.bootLineage.has(namespace)) {
        // The sync modules load async, so this can run well after the page's
        // apps read storage. If another tab moved this namespace's data for an
        // account in between, what the apps hold is unknown, and the page
        // reloads before it syncs anyone.
        this.bootLineage.set(namespace, this.ownershipMovedSinceBoot(namespace)
          ? { owner: UNKNOWN_OWNER, hadData: true }
          : { owner: this.lineageOf(namespace).owner, hadData: this.hasLocalData(keys) });
      }
      for (const key of keys) {
        const pending = this.pendingLocalWork.get(key);
        if (!pending) continue;
        this.pendingLocalWork.delete(key);
        this.recordLocalWork(key, pending.hash, pending.work);
      }
    }
  }

  /** Settle who owns the local copy before a session for `uid` exists. */
  prepareNamespaceForUser(namespace, keys, uid) {
    const hadData = this.hasLocalData(keys);
    const lineage = this.lineageOf(namespace);
    const newOwner = lineage.owner !== uid;
    if (hadData && lineage.owner !== null && newOwner
        && !this.parkForeignLocalData(namespace, keys, lineage.owner)) {
      return { hold: 'the previous account\'s unsynced data could not be set aside' };
    }
    const restored = this.restoreParkedLocalData(namespace, keys, uid);
    this.stampNamespaceOwner(namespace, uid, restored, newOwner);
    // Writes a page made while it was waiting to reload for a different
    // account carry that page's account; they are parked, never adopted.
    if (!this.parkStrayForeignWrites(namespace, keys, uid)) {
      return { hold: 'another account\'s data written on this device could not be set aside' };
    }

    const boot = this.bootLineage.get(namespace);
    if (boot && boot.hadData && boot.owner !== null && boot.owner !== uid) {
      this.foreignPageNamespaces.set(namespace, boot.owner);
      return this.reloadGuardAllows(namespace, uid)
        ? { reload: true }
        : { hold: 'this page loaded another account\'s data and has not reloaded' };
    }
    this.clearReloadMarker(namespace);
    return {};
  }

  /**
   * Keep another account's unsynced local work and clear its live copy.
   * Returns false, leaving everything untouched, when the copy cannot be kept.
   */
  parkForeignLocalData(namespace, keys, owner) {
    const revs = this.readStoredJson(SYNC_REV_KEY_PREFIX + namespace);
    const revKeys = revs && revs.uid === owner && revs.keys && typeof revs.keys === 'object' ? revs.keys : {};
    const bases = this.readStoredJson(SYNC_BASE_KEY_PREFIX + namespace) || {};
    const parkKey = SYNC_PARKED_KEY_PREFIX + namespace;
    const stored = this.readStoredJson(parkKey);
    const record = stored && typeof stored === 'object' && stored.owners && typeof stored.owners === 'object'
      ? stored : { v: 1, owners: {} };
    const slot = record.owners[owner] && typeof record.owners[owner] === 'object'
        && record.owners[owner].keys && typeof record.owners[owner].keys === 'object'
      ? record.owners[owner] : { keys: {} };

    const present = [];
    for (const key of keys) {
      const raw = this.readRaw(key);
      if (raw === null) continue;
      present.push(key);
      const hash = hashValue(parseValue(raw));
      const rev = revKeys[key] && typeof revKeys[key] === 'object' ? revKeys[key] : null;
      // Exactly what that account's cloud already holds: signing in as it
      // brings it back, so there is nothing to keep.
      if (owner !== UNKNOWN_OWNER && rev && !rev.dirty && String(rev.hash || '') === hash) {
        delete slot.keys[key];
        continue;
      }
      const provenance = this.localWorkFor(key);
      slot.keys[key] = {
        raw,
        hash,
        rev: rev ? Number(rev.rev) || 0 : 0,
        syncedHash: rev ? String(rev.hash || '') : '',
        dirty: !!(rev && rev.dirty),
        base: bases && typeof bases[key] === 'object' ? bases[key] : null,
        work: provenance ? provenance.work !== false : true
      };
    }
    if (!present.length) return true;

    if (!this.bumpOwnershipEpoch(namespace)) return false;
    slot.at = new Date().toISOString();
    if (Object.keys(slot.keys).length) record.owners[owner] = slot;
    else delete record.owners[owner];
    try {
      const { setItem, removeItem } = this.rawStorage();
      if (Object.keys(record.owners).length) setItem(parkKey, JSON.stringify(record));
      else removeItem(parkKey);
    } catch (_) {
      // Storage refused the copy. The live data is then the only copy, so it
      // stays exactly where it is and this namespace does not sync here.
      return false;
    }

    for (const key of present) {
      this.writeRawUnderLock(key, null);
      this.localRevisions.delete(key);
      this.lastRemoteUpdates.delete(key);
      this.ownWrites.delete(key);
      this.lastRemoteSeen.delete(key);
    }
    this.forgetLocalWork(present);
    return true;
  }

  /** Put this account's parked work back wherever nothing has taken its place. */
  restoreParkedLocalData(namespace, keys, uid) {
    const parkKey = SYNC_PARKED_KEY_PREFIX + namespace;
    const record = this.readStoredJson(parkKey);
    const slot = record && record.owners && typeof record.owners === 'object' ? record.owners[uid] : null;
    if (!slot || !slot.keys || typeof slot.keys !== 'object') return null;
    const restorable = keys.some((key) => {
      const entry = slot.keys[key];
      return !!entry && typeof entry === 'object' && typeof entry.raw === 'string' && this.readRaw(key) === null;
    });
    if (restorable && !this.bumpOwnershipEpoch(namespace)) return null;

    const revs = {};
    const bases = {};
    let restored = 0;
    for (const key of keys) {
      const entry = slot.keys[key];
      if (!entry || typeof entry !== 'object' || typeof entry.raw !== 'string') continue;
      if (this.readRaw(key) !== null) {
        // Something lives here already (work made while signed out since):
        // keep both, the parked version as a recovery copy.
        this.preserveConflictCopy(key, parseValue(entry.raw), 'parked-account-work', []);
        continue;
      }
      this.writeRawUnderLock(key, entry.raw);
      revs[key] = {
        rev: Number(entry.rev) || 0,
        hash: String(entry.syncedHash || ''),
        updatedAt: 0,
        dirty: !!entry.dirty
      };
      if (entry.base && typeof entry.base === 'object') bases[key] = entry.base;
      if (entry.work === false) this.recordLocalWork(key, String(entry.hash || ''), false);
      restored++;
    }
    delete record.owners[uid];
    try {
      const { setItem, removeItem } = this.rawStorage();
      if (Object.keys(record.owners).length) setItem(parkKey, JSON.stringify(record));
      else removeItem(parkKey);
    } catch (_) { /* restored already; a stale slot restores into occupied keys as copies */ }
    return { restored, revs, bases };
  }

  /**
   * A value whose provenance names another account and still matches what is
   * stored: an app wrote it on a page that had loaded that account's data and
   * was waiting to reload. Park it for that account. False if it could not be.
   */
  parkStrayForeignWrites(namespace, keys, uid) {
    const byOwner = new Map();
    for (const key of keys) {
      const provenance = this.localWorkFor(key);
      if (!provenance || !provenance.owner || provenance.owner === uid) continue;
      if (String(provenance.hash) !== hashValue(this.readLocalValue(key))) continue;
      if (!byOwner.has(provenance.owner)) byOwner.set(provenance.owner, []);
      byOwner.get(provenance.owner).push(key);
    }
    for (const [owner, strayKeys] of byOwner) {
      if (!this.parkForeignLocalData(namespace, strayKeys, owner)) return false;
    }
    return true;
  }

  /** Record `uid` as the owner of this namespace's local copy. */
  stampNamespaceOwner(namespace, uid, restored, newOwner) {
    try {
      const { setItem } = this.rawStorage();
      const revKey = SYNC_REV_KEY_PREFIX + namespace;
      const current = newOwner ? null : this.readStoredJson(revKey);
      const keys = current && current.uid === uid && current.keys && typeof current.keys === 'object'
        ? current.keys : {};
      if (restored && restored.revs) Object.assign(keys, restored.revs);
      setItem(revKey, JSON.stringify({ uid, keys }));

      const baseKey = SYNC_BASE_KEY_PREFIX + namespace;
      const currentBases = newOwner ? null : this.readStoredJson(baseKey);
      const bases = currentBases && typeof currentBases === 'object'
          && (!currentBases.__owner || currentBases.__owner === uid)
        ? currentBases : {};
      if (restored && restored.bases) Object.assign(bases, restored.bases);
      bases.__owner = uid;
      setItem(baseKey, JSON.stringify(bases));
    } catch (_) { /* unstamped: the next start classifies the data again */ }
    if (newOwner) {
      const prefix = this.chunkCountKey(namespace, '');
      for (const mapKey of Array.from(this.syncBases.keys())) {
        if (mapKey.startsWith(prefix)) this.syncBases.delete(mapKey);
      }
    }
  }

  // One reload per account per namespace per tab: if a reload did not fix the
  // mismatch (the stamp could not be written), the namespace holds instead of
  // reloading forever.
  reloadGuardAllows(namespace, uid) {
    try {
      if (typeof sessionStorage === 'undefined' || !sessionStorage) return true;
      const marker = `shevato:sync-owner-reload:${namespace}`;
      if (sessionStorage.getItem(marker) === uid) return false;
      sessionStorage.setItem(marker, uid);
    } catch (_) { /* no session storage: nothing to loop on */ }
    return true;
  }

  clearReloadMarker(namespace) {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage) {
        sessionStorage.removeItem(`shevato:sync-owner-reload:${namespace}`);
      }
    } catch (_) { /* nothing to clear */ }
  }

  requestReload() {
    // Not latched: reload() is idempotent while a navigation is pending, and a
    // second namespace on the same page asks for the same reload.
    try {
      if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
        window.location.reload();
      }
    } catch (_) { /* a page that cannot reload simply does not sync this app */ }
  }

  /** Whether this session's account is still the stamped owner of its namespace. */
  ownsNamespace(state) {
    const revs = this.readStoredJson(SYNC_REV_KEY_PREFIX + state.namespace);
    return !revs || !revs.uid || revs.uid === state.userId;
  }

  // ---- 2. signed-out work ------------------------------------------------

  userHasInteracted() {
    try {
      const activation = typeof navigator !== 'undefined' ? navigator.userActivation : null;
      if (activation && typeof activation.hasBeenActive === 'boolean') return activation.hasBeenActive;
    } catch (_) { /* fall through */ }
    // Cannot tell: count it as a person's write, which is the side that keeps data.
    return true;
  }

  /** A registered key changed while no session owns it. */
  noteUnsessionedWrite(key, value, work) {
    const namespace = this.localKeyNamespaces.get(key);
    if (!namespace && this.localKeyNamespaces.size > 0) return;
    const prior = this.unsessionedWrites.get(key);
    if (!prior && !namespace && this.unsessionedWrites.size >= 500) return;
    // Only what must be read at the moment of the write is read now: whether
    // a person had acted on the page, and whose data the page had loaded. A
    // replayed boot-window write brings the gesture state it was made with.
    this.unsessionedWrites.set(key, {
      value,
      work: (typeof work === 'boolean' ? work : this.userHasInteracted()) || !!(prior && prior.work),
      owner: namespace ? (this.foreignPageNamespaces.get(namespace) || null) : null
    });
    if (this.unsessionedFlushTimer === null) {
      this.unsessionedFlushTimer = setTimeout(() => this.flushUnsessionedWrites(), 0);
    }
  }

  /** Hash and record every signed-out write since the last batch, once per key. */
  flushUnsessionedWrites() {
    if (this.unsessionedFlushTimer !== null) {
      clearTimeout(this.unsessionedFlushTimer);
      this.unsessionedFlushTimer = null;
    }
    if (!this.unsessionedWrites.size) return;
    const batch = this.unsessionedWrites;
    this.unsessionedWrites = new Map();
    const records = [];
    for (const [key, entry] of batch) {
      const hash = hashValue(entry.value === null || entry.value === undefined ? null : parseValue(entry.value));
      if (this.localKeyNamespaces.has(key)) {
        records.push({ key, hash, work: entry.work, owner: entry.owner });
        continue;
      }
      // Before app-sync-init has registered anything (a boot-window write
      // replayed by sync-immediate.js): hold it until the key list is known.
      if (this.pendingLocalWork.size < 500 || this.pendingLocalWork.has(key)) {
        const prior = this.pendingLocalWork.get(key);
        this.pendingLocalWork.set(key, { hash, work: entry.work || !!(prior && prior.work) });
      }
    }
    this.writeLocalWork(records);
  }

  recordLocalWork(key, hash, work, owner = null) {
    // Earlier signed-out writes to the key land first, so this one stays last.
    this.flushUnsessionedWrites();
    this.writeLocalWork([{ key, hash, work, owner }]);
  }

  writeLocalWork(records) {
    if (!records.length) return;
    try {
      const all = this.readStoredJson(SYNC_LOCAL_WORK_KEY);
      const map = all && typeof all === 'object' ? all : {};
      for (const { key, hash, work, owner } of records) {
        const previous = map[key];
        // Sticky: whatever an app writes on top of a value a person shaped is
        // still built on their work. `owner` names the account whose data the
        // writing page had loaded, when that is not the account now stamped.
        map[key] = { hash: String(hash), work: !!work || !!(previous && previous.work) };
        if (owner) map[key].owner = owner;
      }
      this.rawStorage().setItem(SYNC_LOCAL_WORK_KEY, JSON.stringify(map));
    } catch (_) { /* unknown provenance counts as work */ }
  }

  localWorkFor(key) {
    this.flushUnsessionedWrites();
    const all = this.readStoredJson(SYNC_LOCAL_WORK_KEY);
    const entry = all && typeof all === 'object' ? all[key] : null;
    return entry && typeof entry === 'object' ? entry : null;
  }

  /** Only an app's own untouched write; unknown provenance is not a placeholder. */
  isPlaceholder(key) {
    const entry = this.localWorkFor(key);
    if (!entry || entry.work !== false) return false;
    return String(entry.hash) === hashValue(this.readLocalValue(key));
  }

  forgetLocalWork(keys) {
    this.flushUnsessionedWrites();
    const all = this.readStoredJson(SYNC_LOCAL_WORK_KEY);
    if (!all || typeof all !== 'object') return;
    let changed = false;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(all, key)) {
        delete all[key];
        changed = true;
      }
    }
    if (!changed) return;
    try {
      const { setItem, removeItem } = this.rawStorage();
      if (Object.keys(all).length) setItem(SYNC_LOCAL_WORK_KEY, JSON.stringify(all));
      else removeItem(SYNC_LOCAL_WORK_KEY);
    } catch (_) { /* a stale entry only describes a value that has moved on */ }
  }

  /**
   * A local value this session holds no revision for, made by a person, is
   * unacknowledged local work (rev 0, dirty). Placeholders get no revision, so
   * the cloud's value applies to them cleanly.
   */
  synthesizeLocalWork(state) {
    for (const key of state.keys) {
      if (this.localRevisions.has(key)) continue;
      const raw = this.readRaw(key);
      if (raw === null) continue;
      if (this.isPlaceholder(key)) continue;
      this.localRevisions.set(key, { rev: 0, updatedAt: 0, hash: hashValue(parseValue(raw)), dirty: true });
    }
  }

  forgetSyncBase(namespace, key) {
    this.syncBases.set(this.chunkCountKey(namespace, key), null);
    try {
      const { getItem, setItem } = this.rawStorage();
      const storeKey = SYNC_BASE_KEY_PREFIX + namespace;
      const all = JSON.parse(getItem(storeKey) || '{}') || {};
      if (!Object.prototype.hasOwnProperty.call(all, key)) return;
      delete all[key];
      setItem(storeKey, JSON.stringify(all));
    } catch (_) { /* the in-memory base is already gone */ }
  }

  // ---- 4. initialisation ---------------------------------------------------

  /**
   * Just before the first server snapshot is applied. A write an app made on
   * its own while the cloud was unread gives way to the cloud's value where
   * the cloud has one (the write is not a person's edit, and the agreed base
   * it would otherwise "agree" with is dropped so the cloud applies). Then
   * any local value with no revision is classified as work or placeholder.
   */
  prepareInitialReconciliation(state, remoteData) {
    const queue = this.writeQueues.get(state.namespace);
    for (const [key, prior] of state.preMergePrior) {
      if (state.preMergeWork.get(key)) continue;
      if (prior && prior.dirty) continue;
      if (remoteData[key] === undefined) continue;
      if (queue) queue.delete(key);
      // Clean at revision 0 with the value that is actually stored: the prior
      // record describes the value BEFORE the app's write, so keeping it would
      // make an unchanged cloud look deduped, and a higher revision would make
      // it look older. Either way the app's write would outlive the cloud's.
      this.localRevisions.set(key, { rev: 0, updatedAt: 0, hash: hashValue(this.readLocalValue(key)), dirty: false });
      this.forgetSyncBase(state.namespace, key);
    }
    this.synthesizeLocalWork(state);
  }

  /** The first server snapshot has been applied in full: release the queue. */
  completeInitialMerge(state, remoteData) {
    if (state.stopped || state.initialMergeDone) return;
    if (this.isAccountDeletionLatched(state.userId)) {
      this.stopSync(state.namespace);
      return;
    }
    state.initialMergeDone = true;
    // Dirty keys first, at the revisions they carry; then keys the cloud has
    // never had. The other order queued a stranded write as a local-only key
    // at a NEW revision, so it no longer matched the write that never landed.
    this.requeueDirtyKeys(state);
    this.enqueueLocalOnlyKeys(state, remoteData || {});
    this.dropStaleQueuedWrites(state);
    this.forgetLocalWork(state.keys);
    state.preMergePrior.clear();
    state.preMergeWork.clear();
    this.schedulePersistRevisions(state.namespace);

    const queue = this.writeQueues.get(state.namespace);
    if (!queue || queue.size === 0) return;
    if (state.writeTimer) {
      clearTimeout(state.writeTimer);
      state.writeTimer = null;
    }
    this.flushWrites(state);
  }

  /**
   * A queued write whose value the initial merge replaced (the cloud won, or a
   * merge was queued in its place) must not be sent: it would overwrite the
   * very state the merge just decided on.
   */
  dropStaleQueuedWrites(state) {
    const queue = this.writeQueues.get(state.namespace);
    if (!queue) return;
    for (const [key, entry] of Array.from(queue)) {
      const rev = this.localRevisions.get(key);
      if (!rev || !rev.dirty || rev.hash !== entry.hash) queue.delete(key);
    }
  }

  /** The listener gave up before the initial merge: say the queued edits are not saved. */
  noteSnapshotUnavailable(state, error) {
    if (!state || state.initialMergeDone) return;
    const queue = this.writeQueues.get(state.namespace);
    if (!queue || queue.size === 0) return;
    this.notifyWriteRejected(state, new Map(queue), error, true);
  }

  // ---- 3. deletion ---------------------------------------------------------

  readDeletionRecord() {
    const record = this.readStoredJson(SYNC_DELETION_KEY);
    const active = record && record.active && typeof record.active === 'object'
        && typeof record.active.uid === 'string' && record.active.uid
      ? record.active : null;
    const deleted = record && Array.isArray(record.deleted)
      ? record.deleted.filter((uid) => typeof uid === 'string' && uid) : [];
    return { active, deleted };
  }

  writeDeletionRecord(record) {
    try {
      const { setItem, removeItem } = this.rawStorage();
      if (!record.active && !record.deleted.length) removeItem(SYNC_DELETION_KEY);
      else setItem(SYNC_DELETION_KEY, JSON.stringify(record));
    } catch (_) { /* this tab's in-memory latch still holds */ }
  }

  isAccountDeletionLatched(uid) {
    if (!uid) return false;
    if (this.deletionLatch && this.deletionLatch.uid === uid) return true;
    const { active, deleted } = this.readDeletionRecord();
    return (!!active && active.uid === uid) || deleted.includes(uid);
  }

  beginAccountDeletion(uid) {
    if (typeof uid !== 'string' || !uid) throw new Error('beginAccountDeletion: uid is required');
    const now = Date.now();
    const id = this.newLatchId();
    this.deletionLatch = { uid, id };
    const record = this.readDeletionRecord();
    record.active = { uid, id, startedAt: now, heartbeatAt: now };
    this.writeDeletionRecord(record);
    this.suspendSyncForDeletion(uid);
    this.startDeletionHeartbeat();
    this.holdDeletionLock(uid);
    return id;
  }

  endAccountDeletion(uid, id, { deleted = false } = {}) {
    if (this.deletionLatch && this.deletionLatch.id === id) this.deletionLatch = null;
    this.stopDeletionHeartbeat();
    if (typeof this.releaseDeletionLock === 'function') {
      try { this.releaseDeletionLock(); } catch (_) { /* already released */ }
      this.releaseDeletionLock = null;
    }
    const record = this.readDeletionRecord();
    if (record.active && record.active.id === id) record.active = null;
    if (deleted && uid && !record.deleted.includes(uid)) {
      record.deleted.push(uid);
      while (record.deleted.length > MAX_DELETED_ACCOUNTS_REMEMBERED) record.deleted.shift();
    }
    this.writeDeletionRecord(record);
  }

  suspendSyncForDeletion(uid) {
    for (const [namespace, state] of Array.from(this.syncStates)) {
      if (state && state.userId === uid) this.stopSync(namespace);
    }
  }

  startDeletionHeartbeat() {
    this.stopDeletionHeartbeat();
    const beat = () => {
      this.deletionHeartbeat = null;
      if (!this.deletionLatch) return;
      const record = this.readDeletionRecord();
      if (record.active && record.active.id === this.deletionLatch.id) {
        record.active.heartbeatAt = Date.now();
        this.writeDeletionRecord(record);
      }
      this.deletionHeartbeat = setTimeout(beat, DELETION_HEARTBEAT_MS);
    };
    this.deletionHeartbeat = setTimeout(beat, DELETION_HEARTBEAT_MS);
  }

  stopDeletionHeartbeat() {
    if (this.deletionHeartbeat) clearTimeout(this.deletionHeartbeat);
    this.deletionHeartbeat = null;
  }

  // Held for as long as the deletion runs. The browser releases it when the
  // tab closes or crashes, which is an exact answer to "is anyone still
  // deleting?" where the Web Locks API exists.
  holdDeletionLock(uid) {
    try {
      if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') return;
      const held = new Promise((resolve) => { this.releaseDeletionLock = resolve; });
      navigator.locks.request(`shevato-account-deletion:${uid}`, () => held).catch(() => {});
    } catch (_) { /* the heartbeat answers instead */ }
  }

  async clearAbandonedAccountDeletion(uid) {
    const { active } = this.readDeletionRecord();
    if (!active || active.uid !== uid) return false;
    if (this.deletionLatch && this.deletionLatch.id === active.id) return false;
    let live;
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.query === 'function') {
        const snapshot = await navigator.locks.query();
        const name = `shevato-account-deletion:${uid}`;
        live = Array.isArray(snapshot && snapshot.held) && snapshot.held.some((lock) => lock && lock.name === name);
      }
    } catch (_) { live = undefined; }
    if (live === undefined) {
      live = Date.now() - (Number(active.heartbeatAt) || Number(active.startedAt) || 0) < DELETION_STALE_MS;
    }
    if (live) return false;
    const record = this.readDeletionRecord();
    if (!record.active || record.active.id !== active.id) return false;
    record.active = null;
    this.writeDeletionRecord(record);
    return true;
  }

  /** Wait for this tab's flushes and every pending Firestore write to land. */
  async settleBeforeAccountDeletion() {
    await Promise.all(Array.from(this.activeFlushes));
    try { await waitForPendingWrites(db); } catch (_) { /* offline: every delete waits anyway */ }
  }

  forgetAccountLocalState(uid, namespaces, keys) {
    const { setItem, removeItem } = this.rawStorage();
    for (const namespace of Array.isArray(namespaces) ? namespaces : []) {
      try {
        const parkKey = SYNC_PARKED_KEY_PREFIX + namespace;
        const parked = this.readStoredJson(parkKey);
        if (parked && parked.owners && typeof parked.owners === 'object' && parked.owners[uid]) {
          delete parked.owners[uid];
          if (Object.keys(parked.owners).length) setItem(parkKey, JSON.stringify(parked));
          else removeItem(parkKey);
        }
        const revs = this.readStoredJson(SYNC_REV_KEY_PREFIX + namespace);
        if (revs && revs.uid === uid) removeItem(SYNC_REV_KEY_PREFIX + namespace);
        const base = this.readStoredJson(SYNC_BASE_KEY_PREFIX + namespace);
        if (base && (!base.__owner || base.__owner === uid)) removeItem(SYNC_BASE_KEY_PREFIX + namespace);
      } catch (_) { /* best effort: the account is gone either way */ }
    }
    this.forgetLocalWork(Array.isArray(keys) ? keys : []);
    try {
      if (this.syncedDataOwner() === uid) removeItem(SYNC_OWNER_KEY);
    } catch (_) { /* nothing to clear */ }
  }

  chunkCountKey(namespace, key) {
    return `${namespace}\u0000${key}`;
  }

  /**
   * Every part document of the snapshot this write supersedes.
   *
   * The old `staleChunkRefs(state, key, keep)` only ever returned the TAIL a
   * shrinking value left behind, because the head was overwritten in place -
   * which is precisely the behaviour F04 removes. A versioned write shares
   * no document with its predecessor, so the whole predecessor is garbage,
   * and the caller deletes it only once the new manifest is durable.
   *
   * The legacy (unversioned) run is handled by the `version === null` branch:
   * the first write after the upgrade collects the parts the pre-upgrade
   * engine left at the old ids, so a device does not accumulate two copies.
   */
  supersededChunkRefs(state, key) {
    const countKey = this.chunkCountKey(state.namespace, key);
    const committed = this.committedChunks.get(countKey);
    const base = `users/${state.userId}/apps/${state.namespace}/${CHUNK_COLLECTION}`;
    const refs = [];
    if (committed) {
      for (let seq = 0; seq < committed.parts; seq++) {
        refs.push(doc(db, `${base}/${chunkDocId(key, seq, committed.version)}`));
      }
      this.committedChunks.delete(countKey);
    } else {
      // Nothing recorded: either the key was never chunked here, or this is
      // the first write since the upgrade and the predecessor is a legacy
      // unversioned run whose length chunkCounts remembers.
      const known = this.chunkCounts.get(countKey) || 0;
      for (let seq = 0; seq < known; seq++) {
        refs.push(doc(db, `${base}/${chunkDocId(key, seq)}`));
      }
    }
    this.chunkCounts.set(countKey, 0);
    return refs;
  }

  /**
   * Reassemble a chunked remote value and hand it to `applyRemoteChange`.
   *
   * The verdict is taken from the MANIFEST before any part document is
   * fetched. Firestore re-emits the entire document on every listener
   * re-attach (network blip, tab focus, SDK session refresh), and fetching
   * a megabyte of parts on each of those would be slow, expensive, and
   * would re-render every view. The manifest carries the same rev,
   * updatedAt and hash the inline entry would, so the existing
   * `decideRemoteChange` short-circuits identically.
   *
   * A CONFLICT IS NOT A SHORT-CIRCUIT. This used to `return` on any verdict
   * other than 'apply', which quietly threw away every genuine conflict on
   * a value big enough to be chunked: MapTap Rivals' game log crosses the
   * inline threshold at roughly a thousand rows, so past that point a real
   * cross-device edit was discarded with no merge, no recovery copy and no
   * message, and this device's next flush overwrote it. Conflicts now take
   * the same route 'apply' does - fetch the parts, hand the assembled value
   * to applyRemoteChange - so there is exactly one conflict system whatever
   * the size of the value.
   */
  async applyChunkedRemoteChange(state, key, manifest, options = {}) {
    const parts = Number(manifest?.parts) || 0;
    const countKey = this.chunkCountKey(state.namespace, key);
    this.chunkCounts.set(countKey, Math.max(this.chunkCounts.get(countKey) || 0, parts));
    // Remember which snapshot the cloud currently points at, so a later
    // write from THIS device collects that one rather than guessing.
    const manifestVersion = typeof manifest?.chunkVersion === 'string' ? manifest.chunkVersion : null;
    this.committedChunks.set(countKey, { version: manifestVersion, parts });

    const verdict = this.verdictFor(key, manifest, options);
    if (verdict !== 'apply' && verdict !== 'conflict') {
      // Identical bookkeeping to the inline path, so a chunked key's
      // own-write echoes, agreed-base short-circuits and re-attach replays
      // are recorded the same way an inline key's are.
      this.noteRemoteSkip(key, verdict, manifest, remoteToken(manifest));
      return;
    }

    const token = `${key}:${manifest.hash}:${manifest.rev}`;
    if (this.chunkFetches.has(token)) return;
    this.chunkFetches.add(token);

    try {
      const base = `users/${state.userId}/apps/${state.namespace}/${CHUNK_COLLECTION}`;
      // A manifest with no chunkVersion was written by the pre-2026-09-07
      // engine and points at the unversioned ids. Reading it must keep
      // working: an upgraded device may well find its own cloud document
      // still in the old shape.
      const snapshots = await Promise.all(
        Array.from({ length: parts },
          (_, seq) => getDoc(doc(db, `${base}/${chunkDocId(key, seq, manifestVersion)}`)))
      );
      if (state.stopped) return;

      let joined = '';
      for (let seq = 0; seq < snapshots.length; seq++) {
        const snapshot = snapshots[seq];
        const data = (snapshot && typeof snapshot.exists === 'function' && snapshot.exists())
          ? snapshot.data()
          : null;
        const part = data ? data.part : null;
        if (typeof part !== 'string') {
          throw new Error(`part ${seq} of ${parts} is missing`);
        }
        // A versioned part carries the version it belongs to. Checking it
        // costs nothing and turns "these documents happened to be at these
        // ids" into "these documents are this snapshot".
        if (manifestVersion && data.version !== undefined && data.version !== manifestVersion) {
          throw new Error(`part ${seq} belongs to version ${data.version}, not ${manifestVersion}`);
        }
        joined += part;
      }

      // INTEGRITY, BEFORE ANYTHING IS APPLIED. Valid JSON was never proof
      // that the parts belonged together: the old engine overwrote parts in
      // place, so a reader could assemble the head of one version and the
      // tail of another into a document that parsed perfectly and was wrong.
      // The manifest carries the length and the content hash of the value it
      // describes, and both are checked here. A mismatch is not applied and
      // not recorded, so the next snapshot retries against whatever the
      // cloud settled on.
      if (Number.isFinite(manifest.chars) && joined.length !== manifest.chars) {
        throw new Error(`assembled ${joined.length} chars, manifest says ${manifest.chars}`);
      }
      const value = JSON.parse(joined);
      if (typeof manifest.hash === 'string' && hashValue(value) !== manifest.hash) {
        throw new Error(`assembled content does not match the manifest digest ${manifest.hash}`);
      }

      // Deliberately the same entry point an inline value uses: conflict
      // resolution, the echo lock, the revision bookkeeping and the
      // localStorageSync dispatch must not fork per storage format.
      this.applyRemoteChange(key, {
        rev: manifest.rev,
        updatedAt: manifest.updatedAt,
        hash: manifest.hash,
        value
      }, options);
    } catch (error) {
      // Leave lastRemoteUpdates untouched so the next snapshot retries.
      console.warn(`⚠️ Could not assemble chunked value for ${key}:`, error?.message || error);
    } finally {
      this.chunkFetches.delete(token);
    }
  }

  /**
   * Queue every key this device holds that the cloud document does not.
   *
   * Runs once per session, from completeInitialMerge, so it is judged against
   * a server-confirmed view (a cached snapshot can look empty and would
   * overwrite another browser's writes). A tombstone counts as present, so a
   * delete is never undone. Keys whose local copy belonged to another account
   * never reach this point: prepareNamespaceForUser parked them before the
   * session existed.
   *
   * These used to be written straight to Firestore from here, outside the
   * queue, which is why a failed first upload was only ever a console line and
   * why it bypassed every gate the flush has. They now go through flushWrites
   * like any other write: the barrier, the deletion latch, the owner check,
   * the retry ladder, `syncWriteRejected`, and dirty persistence.
   */
  enqueueLocalOnlyKeys(state, remoteData) {
    const queue = this.writeQueues.get(state.namespace);
    if (!queue) return;
    const getItem = this.originalMethods?.getItem
      ? this.originalMethods.getItem
      : localStorage.getItem.bind(localStorage);

    for (const key of state.keys) {
      let localValue = null;
      try { localValue = getItem(key); } catch (_) { localValue = null; }
      if (localValue === null || localValue === undefined) continue;
      if (remoteData[key] !== undefined) continue;
      // Already on its way at a revision of its own (a pre-merge edit or a
      // restored dirty write); queueing it again would send it twice.
      if (queue.has(key)) continue;

      const parsed = parseValue(localValue);
      const known = this.localRevisions.get(key);
      // Never BELOW what this device has already reached. A key can be missing
      // from the cloud while this device holds a restored revision (last
      // session's flush never landed), and publishing it as rev 1 would walk
      // the Lamport counter backwards.
      const rev = Math.max(1, ((known && known.rev) || 0) + (known ? 1 : 0));
      const hash = hashValue(parsed);
      const now = Date.now();
      queue.set(key, { value: parsed, rev, updatedAt: now, hash, deleted: false });
      this.localRevisions.set(key, { rev, updatedAt: now, hash, dirty: true });
    }
  }

  /** Debug entry point: queue local-only keys against a remote view and send them. */
  uploadLocalOnlyKeys(state, remoteData) {
    this.enqueueLocalOnlyKeys(state, remoteData || {});
    const queue = this.writeQueues.get(state.namespace);
    if (queue && queue.size) return this.flushWrites(state);
    return Promise.resolve();
  }

  /**
   * Stop sync for a namespace
   */
  stopSync(namespace) {
    const state = this.syncStates.get(namespace);
    if (!state) return;

    // Flush the revision map first: a restart (a key-set change, a token
    // refresh) must not put the Lamport counters back to zero, which is the
    // reload data-loss path in miniature.
    this.persistRevisions(namespace);

    state.stopped = true;

    // The queue below is dropped, deliberately without a flush: stopSync runs
    // from the auth-state listener AFTER a sign-out, when a write would be
    // refused for want of credentials. Nothing is lost by that. The dirty
    // flags were just persisted, and requeueDirtyKeys sends those writes on
    // the next start for this user. The flush that CAN still succeed happens
    // before sign-out (flushAllNow) and on pagehide (flushPendingNow).
    if (state.writeTimer) {
      clearTimeout(state.writeTimer);
    }
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    state.listeners.forEach(cleanup => cleanup());

    this.syncStates.delete(namespace);
    this.writeQueues.delete(namespace);
    
    for (const key of state.keys) {
      this.localRevisions.delete(key);
      this.syncLocks.delete(key);
      this.lastRemoteUpdates.delete(key);
      this.ownWrites.delete(key);
      this.lastRemoteSeen.delete(key);
      this.chunkCounts.delete(this.chunkCountKey(namespace, key));
    }
  }

  /**
   * Stop all syncs
   */
  stopAllSyncs() {
    for (const namespace of this.syncStates.keys()) {
      this.stopSync(namespace);
    }
  }

  /**
   * Get sync status for debugging
   */
  getSyncStatus(namespace) {
    const state = this.syncStates.get(namespace);
    if (!state) return null;

    return {
      namespace,
      active: !state.stopped,
      keyCount: state.keys.size,
      retryCount: state.retryCount,
      lastSyncTime: state.lastSyncTime,
      queueSize: this.writeQueues.get(namespace)?.size || 0,
      // Keys handed to Firestore and not yet answered.
      inFlight: state.inFlight || 0,
      // Out of retries on a retryable failure, waiting for a trigger.
      parked: !!state.parked,
      // T-3: false until the first server snapshot has been reconciled; nothing
      // queued is sent before then.
      initialMergeDone: !!state.initialMergeDone
    };
  }

  /**
   * Get global status
   */
  getGlobalStatus() {
    let totalQueueSize = 0;
    for (const queue of this.writeQueues.values()) {
      totalQueueSize += queue.size;
    }
    let inFlightWrites = 0;
    for (const state of this.syncStates.values()) {
      inFlightWrites += state.inFlight || 0;
    }
    return {
      activeNamespaces: this.syncStates.size,
      totalKeys: Array.from(this.syncStates.values()).reduce((sum, state) => sum + state.keys.size, 0),
      // Queued AND on the wire. flushWrites empties the queue before the
      // network call, so counting the queue alone let the sync pill read
      // "Synced" while the only copy of an edit was still in flight
      // (2026-09-12 audit F9). Both pills read this field.
      totalQueueSize: totalQueueSize + inFlightWrites,
      inFlightWrites,
      syncLocks: this.syncLocks.size,
      overrideInstalled: this.isOverrideInstalled
    };
  }
}

// Global singleton instance
const syncManager = new StorageSyncManager();

// Export public API
export function startStorageSync(config) {
  return syncManager.startStorageSync(config);
}

export function stopSync(namespace) {
  syncManager.stopSync(namespace);
}

export function stopAllSyncs() {
  syncManager.stopAllSyncs();
}

export async function setCloudItem(key, value) {
  // Find namespace for this key
  for (const [namespace, state] of syncManager.syncStates) {
    if (state.keys.has(key)) {
      syncManager.queueWrite(state, key, typeof value === 'object' ? JSON.stringify(value) : value);
      await syncManager.flushWrites(state);
      return;
    }
  }
  throw new Error(`Key ${key} not registered for sync`);
}

export function getSyncStatus(namespace) {
  return syncManager.getSyncStatus(namespace);
}

export function getGlobalSyncStatus() {
  return syncManager.getGlobalStatus();
}

/**
 * Tell the engine every namespace and its keys at page load, signed in or not
 * (app-sync-init.js). It is what lets a write made while signed out be
 * attributed, and what records the owner of the data this page loaded.
 *
 * @param {Array<{namespace: string, keys: string[]}>} configs
 */
export function registerLocalNamespaces(configs) {
  syncManager.registerLocalNamespaces(configs);
}

/**
 * Latch account deletion for `uid` in every tab, before anything is deleted.
 * Returns the latch id endAccountDeletion needs.
 */
export function beginAccountDeletion(uid) {
  return syncManager.beginAccountDeletion(uid);
}

/**
 * Release this tab's deletion latch. `deleted: true` (the auth user is gone)
 * keeps the account latched for good; anything else clears it so sync can
 * resume for an account that still exists.
 */
export function endAccountDeletion(uid, id, options) {
  syncManager.endAccountDeletion(uid, id, options);
}

export function isAccountDeletionLatched(uid) {
  return syncManager.isAccountDeletionLatched(uid);
}

/** Clear a deletion latch whose tab is gone. Resolves true if it cleared one. */
export function clearAbandonedAccountDeletion(uid) {
  return syncManager.clearAbandonedAccountDeletion(uid);
}

/** Wait for this tab's flushes and every pending Firestore write to land. */
export function settleBeforeAccountDeletion() {
  return syncManager.settleBeforeAccountDeletion();
}

/**
 * After the deletes: any namespace document a write that was already on its
 * way re-created is deleted again. Resolves the namespaces that had come back.
 *
 * @param {string[]} namespaces
 * @returns {Promise<string[]>}
 */
export async function confirmCloudDataErased(namespaces) {
  const user = auth.currentUser;
  if (!user) throw new Error('confirmCloudDataErased: not signed in');
  await syncManager.settleBeforeAccountDeletion();
  const reappeared = [];
  for (const namespace of Array.isArray(namespaces) ? namespaces : []) {
    const snapshot = await getDoc(doc(db, `users/${user.uid}/apps/${namespace}`));
    if (snapshot && typeof snapshot.exists === 'function' && snapshot.exists()) {
      reappeared.push(namespace);
      await eraseCloudData(namespace);
    }
  }
  return reappeared;
}

/**
 * Mark the namespaces' local data as moving, before clearing it for an
 * account, so a page whose sync modules register afterwards reloads rather
 * than trusting what its apps read.
 */
export function bumpOwnershipEpochs(namespaces) {
  return syncManager.bumpOwnershipEpoch(Array.isArray(namespaces) ? namespaces : []);
}

/**
 * Forget every trace of a deleted account on this device: its parked copies,
 * its ownership stamps and agreed bases, the provenance of the keys, and the
 * legacy owner marker if it names the account.
 */
export function forgetAccountLocalState(uid, namespaces, keys) {
  syncManager.forgetAccountLocalState(uid, namespaces, keys);
}

/**
 * The recovery copies this device is holding, newest last.
 *
 * A conflict copy is only written for a GENUINE unresolved conflict now (an
 * own-write echo, a replayed snapshot and an unchanged cloud are all
 * recognised before it gets that far), which makes the remaining ones worth
 * being able to reach. There is deliberately no management UI for them: they
 * are rare, they are per-device, and the honest thing to expose is the data
 * itself rather than a screen for a situation most users will never hit.
 *
 * @returns {Array<{id: string, key: string, reason: string, at: string}>}
 */
export function listConflictCopies() {
  return syncManager.listConflictCopies();
}

/**
 * The value held by one recovery copy, or null when it has aged out.
 *
 * @param {string} id an id from listConflictCopies()
 * @returns {{key: string, reason: string, at: string, recordIds: string[], value: *} | null}
 */
export function readConflictCopy(id) {
  return syncManager.readConflictCopy(id);
}

/**
 * Delete a user's cloud-side app document. Single canonical entry point
 * for app-level "wipe cloud data" buttons — previously the gym tracker
 * imported Firestore directly to do this, which violated the rule that
 * only the sync module talks to Firestore. Callers pass the namespace
 * exactly as it appears in app-sync-init.js (e.g. 'gymTrackerApp').
 *
 * @param {string} namespace App namespace as registered in APP_SYNC_CONFIG.
 * @returns {Promise<void>}
 */
export async function eraseCloudData(namespace) {
  if (typeof namespace !== 'string' || !namespace) {
    throw new Error('eraseCloudData: namespace is required');
  }
  const user = auth.currentUser;
  if (!user) {
    throw new Error('eraseCloudData: not signed in');
  }
  const docPath = `users/${user.uid}/apps/${namespace}`;
  // Part documents FIRST. Firestore deletes are not recursive, so a value
  // stored out of line (see MAX_INLINE_VALUE_CHARS) survives a delete of the
  // document that references it, and the parts are where the user's actual
  // data lives. Removing them first means a failure part-way through leaves
  // an empty manifest, never orphaned content.
  await deleteChunkDocuments(docPath);
  await deleteDoc(doc(db, docPath));
  // The revisions and the agreed base describe a document that no longer
  // exists. Left behind, they would tell the next session the cloud is at
  // rev 40 and holding a value it agreed with, when it is holding nothing.
  syncManager.forgetSyncMetadata(namespace);
}

/**
 * Delete every part document under one namespace's `chunks` subcollection.
 *
 * @param {string} docPath `users/<uid>/apps/<namespace>`
 * @returns {Promise<void>}
 */
async function deleteChunkDocuments(docPath) {
  const parts = await getDocs(collection(db, `${docPath}/${CHUNK_COLLECTION}`));
  for (const part of parts.docs) {
    await deleteDoc(part.ref);
  }
}

/**
 * Delete the account's root document, users/{uid}.
 *
 * Not the same job as eraseCloudData(): Arena writes its trivia profile (xp,
 * wins, games played, custom pack) as fields ON users/{uid} rather than under
 * apps/, and Firestore deletes are not recursive, so removing the root
 * document leaves the per-namespace documents behind and vice versa. Account
 * deletion has to do both.
 *
 * @returns {Promise<void>}
 */
export async function eraseAccountProfile() {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('eraseAccountProfile: not signed in');
  }
  await deleteDoc(doc(db, 'users', user.uid));
}

/**
 * Collections that hold ARENA identity outside users/{uid}.
 *
 * Mirrors the collection names in apps/arena/js/app.js; the invariant test in
 * sync-system/tests/account-deletion.test.mjs asserts the two stay equal.
 */
export const ARENA_IDENTITY_COLLECTIONS = Object.freeze({
  leaderboard: 'triviaLeaderboard',
  daily: 'globeDropDailyLeaderboard',
  h2h: 'triviaH2H'
});

/** What a departed player's name becomes on a record two people share. */
export const ARENA_ANONYMOUS_NAME = 'Former player';

/**
 * Remove or anonymise the Arena records that live OUTSIDE users/{uid}
 * (2026-09-05 audit F18).
 *
 * Until this existed, privacy.html had to say out loud that closing an
 * account left three things behind for good: a public XP leaderboard row, a
 * daily-challenge score on every day you played, and a head-to-head record
 * against every opponent. None of them had a deletion rule the owner could
 * use, so "delete my account" left a permanent public record of somebody who
 * had left, removable only by emailing the owner.
 *
 * Two different treatments, because they are two different things:
 *
 *   - The leaderboard row and the daily scores are YOURS. They are deleted.
 *   - A head-to-head record is SHARED: it is the other player's history too,
 *     and deleting it would take their games with it. So the identity is
 *     removed and the record is kept - your display name becomes "Former
 *     player" and the counts stand. firestore.rules enforces that each side
 *     can only rewrite its own name.
 *
 * Best effort per document, and never fatal: a daily score whose date
 * document has been swept, or a pair row an opponent has already tidied, is
 * not a reason to abandon an account deletion half way through.
 */
export async function eraseArenaIdentity() {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('eraseArenaIdentity: not signed in');
  }
  const uid = user.uid;

  await deleteDoc(doc(db, ARENA_IDENTITY_COLLECTIONS.leaderboard, uid));

  // Daily scores live at globeDropDailyLeaderboard/{date}/scores/{uid}. A
  // collection-group query finds every one of them in a single read; without
  // it there is no way to learn which dates a player appears on, because the
  // date documents themselves are not readable as a list.
  try {
    const scores = await getDocs(query(
      collectionGroup(db, 'scores'),
      where('uid', '==', uid)
    ));
    for (const score of scores.docs) {
      try { await deleteDoc(score.ref); } catch (_) { /* already gone */ }
    }
  } catch (error) {
    // A missing composite index makes this query fail rather than return
    // nothing, and that must not sink the whole deletion: everything else has
    // already been removed, and the rows that remain are the ones the policy
    // page names.
    console.warn('Arena daily scores could not be enumerated:', error?.message || error);
  }

  // Head-to-head: anonymise BOTH orderings, since a pair key names the two
  // uids sorted and this account can be either side of it.
  for (const field of ['uidA', 'uidB']) {
    try {
      const pairs = await getDocs(query(
        collection(db, ARENA_IDENTITY_COLLECTIONS.h2h),
        where(field, '==', uid)
      ));
      for (const pair of pairs.docs) {
        const patch = field === 'uidA'
          ? { displayNameA: ARENA_ANONYMOUS_NAME }
          : { displayNameB: ARENA_ANONYMOUS_NAME };
        try { await setDoc(pair.ref, patch, { merge: true }); } catch (_) { /* leave it */ }
      }
    } catch (error) {
      console.warn(`Arena H2H rows (${field}) could not be enumerated:`, error?.message || error);
    }
  }
}

/**
 * Collection names for the opt-in MapTap Rivals network. Mirrors the
 * constants in apps/maptap-rivals/js/app.js; the invariant test in
 * sync-system/tests/account-deletion.test.mjs asserts the two stay equal, so
 * a rename over there fails the build rather than silently leaving a deleted
 * user's published profile behind forever.
 */
export const RIVAL_NETWORK_COLLECTIONS = Object.freeze({
  handles: 'maptapRivalsHandles',
  profiles: 'maptapRivalsNetwork',
  links: 'maptapRivalsLinks'
});

/**
 * Delete the account's MapTap Rivals network identity.
 *
 * These three collections sit outside users/{uid}, but every document here is
 * keyed to one uid and the deployed rules let its owner delete it. They hold
 * a published handle, display name and the handles of tracked rivals, so
 * leaving them would strand a public profile that nobody can ever remove once
 * the auth user is gone. Deleting a pair link also drops the connection on
 * the other member's side, which is the correct outcome.
 *
 * A user who never joined the network simply has nothing to match: deleting a
 * missing document succeeds, and both queries come back empty.
 *
 * @returns {Promise<void>}
 */
export async function eraseRivalNetworkIdentity() {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('eraseRivalNetworkIdentity: not signed in');
  }
  const uid = user.uid;

  await deleteDoc(doc(db, RIVAL_NETWORK_COLLECTIONS.profiles, uid));

  const claims = await getDocs(query(
    collection(db, RIVAL_NETWORK_COLLECTIONS.handles),
    where('uid', '==', uid)
  ));
  for (const claim of claims.docs) {
    await deleteDoc(claim.ref);
  }

  const links = await getDocs(query(
    collection(db, RIVAL_NETWORK_COLLECTIONS.links),
    where('uids', 'array-contains', uid)
  ));
  for (const link of links.docs) {
    await deleteDoc(link.ref);
  }
}

// Expose the global-status getter to non-module code (e.g. the gym
// tracker's sync status pill, which is loaded as an ES module but reads
// state through window because the sync layer is loaded before it).
if (typeof window !== 'undefined') {
  window.gymGetGlobalSyncStatus = () => syncManager.getGlobalStatus();
  // Called by firebase-config.js before auth.signOut(), with a bounded wait:
  // a write attempted after sign-out is refused, so the last edits have to
  // leave first. firebase-config.js cannot import this module (this module
  // imports it), hence the window hook.
  window.__shevatoFlushSync = () => syncManager.flushAllNow();
}

// Debug helpers
window._debugSync = {
  status: () => syncManager.getGlobalStatus(),
  namespaces: () => Array.from(syncManager.syncStates.keys()),
  locks: () => Array.from(syncManager.syncLocks.keys()),
  revisions: () => Object.fromEntries(syncManager.localRevisions),
  
  // Manual re-upload of any keys present locally but missing remotely.
  // The initial merge no longer has a dedicated method (the snapshot
  // listener covers it on attach); this debug entry just re-runs the
  // local-only-keys upload against an empty remote snapshot.
  async triggerInitialMerge(namespace) {
    const state = syncManager.syncStates.get(namespace);
    if (!state) {
      console.error(`❌ Namespace "${namespace}" not found`);
      return;
    }
    await syncManager.uploadLocalOnlyKeys(state, {});
  },
  
  // Get all available namespaces
  getAvailableNamespaces() {
    return Array.from(syncManager.syncStates.keys());
  }
};