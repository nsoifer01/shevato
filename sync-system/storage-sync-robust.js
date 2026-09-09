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
  collection,
  collectionGroup,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  ref,
  onValue,
  serverTimestamp as rtdbServerTimestamp,
  runTransaction as rtdbTransaction,
  off
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

import { db, rtdb, auth } from '../firebase-config.js';
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
const USE_FIRESTORE = true;
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

// Marks which account the synced localStorage keys on this device belong to,
// so a second account signing in on a shared browser does not upload the
// first account's data into its own cloud document. Not part of any
// namespace's key set, so it never syncs itself.
const SYNC_OWNER_KEY = 'shevato:sync-owner';
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
    
    // Check if immediate sync override is already installed
    if (window.immediateDebug) {
      this.useImmediateOverride();
    } else {
      this.installGlobalOverride();
    }

    this.installCrossTabChannel();
    this.installVisibilityHook();
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
      if (document.visibilityState !== 'visible') return;
      this.handleTabVisible();
    });
  }

  handleTabVisible() {
    for (const [, state] of this.syncStates) {
      if (state.stopped) continue;
      this.reconcileFromLocalStorage(state);
    }
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
      processChange: (key, value) => {
        this.notifyLocalChange(key, value);
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
        this.notifyLocalChange(e.key, e.newValue);
      }
    });

    this.isOverrideInstalled = true;
  }

  /**
   * Notify all sync states about a localStorage change
   */
  notifyLocalChange(key, value) {
    // Check if we're in a sync lock (prevent echo)
    if (this.syncLocks.get(key)) {
      return;
    }

    // Find all sync states that care about this key
    for (const [namespace, state] of this.syncStates) {
      if (state.keys.has(key) && !state.stopped) {
        this.queueWrite(state, key, value);
      }
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
  startStorageSync({ namespace, keys, useFirestore = USE_FIRESTORE, policies }) {
    const user = auth.currentUser;
    if (user) {
      return this._startSyncForUser(user, { namespace, keys, useFirestore, policies });
    }

    console.warn('❌ No authenticated user — sync will start once auth is ready');
    let actualSync = null;
    const delayedSync = {
      stop: () => { if (actualSync) actualSync.stop(); }
    };

    const unsubscribe = auth.onAuthStateChanged((authUser) => {
      if (authUser?.uid && !actualSync) {
        actualSync = this._startSyncForUser(authUser, { namespace, keys, useFirestore, policies });
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
  _startSyncForUser(user, { namespace, keys, useFirestore = USE_FIRESTORE, policies }) {
    this.registerKeyPolicies(keys, policies);

    const existing = this.syncStates.get(namespace);
    if (existing && !existing.stopped
        && existing.userId === user.uid
        && existing.useFirestore === useFirestore
        && sameKeySet(existing.keys, keys)) {
      return {
        stop: () => this.stopSync(namespace),
        getStatus: () => this.getSyncStatus(namespace)
      };
    }

    if (existing) {
      this.stopSync(namespace);
    }

    // Initialize sync state
    const state = {
      namespace,
      keys: new Set(keys),
      userId: user.uid,
      useFirestore,
      listeners: [],
      writeTimer: null,
      stopped: false,
      retryCount: 0,
      lastSyncTime: Date.now(),
      initialMergeDone: false
    };

    this.syncStates.set(namespace, state);

    // Initialize write queue
    if (!this.writeQueues.has(namespace)) {
      this.writeQueues.set(namespace, new Map());
    }

    // Before the listener attaches, so the first snapshot is judged against
    // the revisions this device actually reached, not against zero.
    this.restoreRevisions(state);

    // Start Firebase listener — the listener's first snapshot doubles
    // as the initial merge, so we no longer need a separate `getDoc`
    // (that was the read costing us 429s on auth-state churn).
    if (useFirestore) {
      this.initFirestoreSync(state);
    } else {
      this.initRealtimeDbSync(state);
    }

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

          const data = snapshot.data();
          const remoteData = data?.data || {};
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
              if (info.chunked) this.applyChunkedRemoteChange(state, key, info, snapshotOptions);
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
          if (!state.initialMergeDone && !snapshot.metadata.fromCache) {
            state.initialMergeDone = true;
            this.uploadLocalOnlyKeys(state, remoteData);
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
          }
        }
      );

      state.unsubscribe = unsubscribe;
    };

    state.listeners.push(tearDown);
    setupListener();
  }

  /**
   * Enhanced Realtime Database sync
   */
  initRealtimeDbSync(state) {
    const dbPath = `users/${state.userId}/apps/${state.namespace}`;
    const dbRef = ref(rtdb, dbPath);

    const callback = (snapshot) => {
      if (state.stopped) return;

      const data = snapshot.val();
      const remoteData = data?.data || {};

      for (const [key, info] of Object.entries(remoteData)) {
        if (!state.keys.has(key)) continue;
        this.applyRemoteChange(key, info);
      }

      if (!state.initialMergeDone) {
        state.initialMergeDone = true;
        this.uploadLocalOnlyKeys(state, remoteData);
      }
    };

    onValue(dbRef, callback, (error) => {
      console.error(`❌ RTDB sync error for ${state.namespace}:`, error);
    });

    state.listeners.push(() => off(dbRef, 'value', callback));
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
  rememberSyncBase(namespace, key, value) {
    if (!namespace) return;
    const empty = value === null || value === undefined;
    // `hash` is the whole agreed value; `entries` is the per-entry index the
    // three-way merge needs. A value with no internal structure (a string, a
    // preference) still gets a base record, because the hash alone is what
    // proves the cloud has not moved.
    const base = empty
      ? null
      : { ...(valueIndex(value) || { kind: 'opaque', entries: null }), hash: hashValue(value) };
    this.syncBases.set(this.chunkCountKey(namespace, key), base);
    try {
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      const getItem = this.originalMethods?.getItem || localStorage.getItem.bind(localStorage);
      const storeKey = SYNC_BASE_KEY_PREFIX + namespace;
      let all = {};
      try { all = JSON.parse(getItem(storeKey) || '{}') || {}; } catch (_) { all = {}; }
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

    for (const key of state.keys) {
      const entry = saved[key];
      if (!entry || typeof entry !== 'object') continue;
      const currentHash = hashValue(this.readLocalValue(key));
      const drifted = currentHash !== String(entry.hash || '');
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

    const merge = (remoteValue === null || localValue === null)
      ? null
      : mergeValues(this.syncBaseFor(key), localValue, remoteValue);

    if (merge) {
      // A merge loses nothing structurally, so a conflict copy is only kept
      // when individual records genuinely disagreed.
      if (merge.conflicts.length) {
        this.preserveConflictCopy(key, localValue, 'record-conflict', merge.conflicts);
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

    const winner = pickConflictWinner(localRev, remoteInfo);
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
    if (state.writeTimer) clearTimeout(state.writeTimer);
    state.writeTimer = setTimeout(() => this.flushWrites(state), DEBOUNCE_MS);
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

    // Clear existing timer
    if (state.writeTimer) {
      clearTimeout(state.writeTimer);
    }

    // Debounced write with exponential backoff on failure
    const delay = state.retryCount > 0 ? 
      DEBOUNCE_MS * Math.pow(2, state.retryCount) : DEBOUNCE_MS;
    
    state.writeTimer = setTimeout(() => {
      this.flushWrites(state);
    }, delay);
  }

  /**
   * Enhanced write flushing with retry logic
   */
  async flushWrites(state) {
    const queue = this.writeQueues.get(state.namespace);
    if (!queue || queue.size === 0) return;

    // Copy queue and clear it
    const writes = new Map(queue);
    queue.clear();

    try {
      if (state.useFirestore) {
        await this.flushToFirestore(state, writes);
      } else {
        await this.flushToRealtimeDb(state, writes);
      }

      state.retryCount = 0;
      state.lastSyncTime = Date.now();

      // The cloud has accepted these values, so this device no longer holds
      // anything the cloud has not seen: the keys are clean, and what was
      // written is now the state both sides agree on.
      for (const [key, info] of writes) {
        const rev = this.localRevisions.get(key);
        if (rev && rev.rev === info.rev) this.localRevisions.set(key, { ...rev, dirty: false });
        this.rememberSyncBase(state.namespace, key, info.deleted ? null : info.value);
      }
      this.schedulePersistRevisions(state.namespace);

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

      // A deterministic rejection (our size guard, or Firestore refusing
      // the document shape) fails identically however often it is resent,
      // so the retry ladder is pure waste, and worse than waste while the
      // app keeps appending to the same key between attempts, which is how
      // the MapTap Rivals incident turned a 760 KB refusal into an 890 KB
      // one. Drop the batch, reset the ladder, and tell the page.
      if (isPermanentWriteError(error)) {
        console.error(`🛑 Permanent write rejection for ${state.namespace}; not retrying:`, error.message);
        state.retryCount = 0;
        this.notifyWriteRejected(state, writes, error);
        return;
      }

      // Retry logic
      if (state.retryCount < MAX_RETRY_ATTEMPTS) {
        state.retryCount++;
        console.log(`🔄 Retrying write flush (${state.retryCount}/${MAX_RETRY_ATTEMPTS})`);
        
        // Re-queue failed writes, but never OVER a newer entry the user made
        // while this flush was in flight; see requeueFailedWrites for the
        // data-loss race this guards against.
        requeueFailedWrites(queue, writes);
        
        // Retry with exponential backoff
        setTimeout(() => this.flushWrites(state), RETRY_DELAY_MS * state.retryCount);
      } else {
        console.error(`💥 Max retry attempts exceeded for ${state.namespace}`);
        state.retryCount = 0;
      }
    }
  }

  /**
   * Surface a permanently-rejected batch.
   *
   * The write is gone: the data is still safe in localStorage, but this
   * device will not push it to the cloud until the value changes into
   * something writable. That is worth more than a console line, so it also
   * goes out as a DOM event any app (or a test) can listen for.
   *
   * @param {object} state sync state whose flush was rejected
   * @param {Map<string, object>} writes the batch that will not be resent
   * @param {Error} error the rejection
   */
  notifyWriteRejected(state, writes, error) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try {
      window.dispatchEvent(new CustomEvent('syncWriteRejected', {
        detail: {
          namespace: state.namespace,
          keys: Array.from(writes.keys()),
          code: error?.code || 'unknown',
          message: error?.message || String(error)
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

  claimSyncedData(uid) {
    if (!uid) return;
    try {
      const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
      setItem(SYNC_OWNER_KEY, uid);
    } catch (_) { /* storage full or blocked: the guard simply does not arm */ }
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
   * Enhanced RTDB flush
   */
  async flushToRealtimeDb(state, writes) {
    const dbPath = `users/${state.userId}/apps/${state.namespace}`;
    const dbRef = ref(rtdb, dbPath);

    this.rememberOwnWrites(writes);

    await rtdbTransaction(dbRef, (currentData) => {
      const data = currentData || { data: {}, meta: {} };

      for (const [key, info] of writes) {
        if (info.deleted) {
          delete data.data[key];
        } else {
          data.data[key] = {
            value: info.value,
            rev: info.rev,
            updatedAt: rtdbServerTimestamp(),
            hash: info.hash
          };
        }
      }

      data.meta = {
        ...data.meta,
        lastUpdated: rtdbServerTimestamp(),
        syncVersion: (data.meta?.syncVersion || 0) + 1
      };

      return data;
    });
  }

  /**
   * Upload any keys we have in localStorage that are missing from the
   * remote document. Invoked exactly once per sync session, from the
   * first snapshot the realtime listener delivers — that snapshot
   * gives us the same remote view that a separate `getDoc` used to
   * fetch, so this replaces the read-heavy `performInitialMerge` that
   * previously triggered `429 Too Many Requests` on auth-state churn.
   *
   * Conflicts where both sides exist are deliberately left to
   * `applyRemoteChange` (which the snapshot loop already invoked):
   * remote wins on a fresh state because the local revision map is
   * empty at that moment, matching the previous "prefer remote on
   * initial merge" behaviour without a second code path.
   */
  uploadLocalOnlyKeys(state, remoteData) {
    const localWrites = new Map();
    const getItem = this.originalMethods?.getItem
      ? this.originalMethods.getItem
      : localStorage.getItem.bind(localStorage);

    // Never hand one account's data to another. Signing out leaves the synced
    // keys in localStorage on purpose (a signed-out user keeps working
    // locally), so on a shared browser the next person to sign in arrives
    // with the previous person's trips, workouts or races still in storage.
    // Those keys are missing from THEIR cloud document, so this function used
    // to upload them into it: one person's data copied into another person's
    // account with no gesture from either. Claim the local copy for the uid
    // that first synced it and upload only for that uid; a different uid
    // still READS its own cloud data normally, and applyRemoteChange
    // overwrites the stale local values as the snapshot arrives.
    const owner = this.syncedDataOwner();
    if (owner && owner !== state.userId) {
      console.warn(
        `Skipping local-only upload for ${state.namespace}: these keys were last synced by a different account`
      );
      return;
    }

    for (const key of state.keys) {
      const localValue = getItem(key);
      if (localValue === null || localValue === undefined) continue;
      if (remoteData[key] !== undefined) continue;

      const parsed = parseValue(localValue);
      const known = this.localRevisions.get(key);
      localWrites.set(key, {
        value: parsed,
        // Never BELOW what this device has already reached. A key can be
        // missing from the cloud while this device holds a restored
        // revision (last session's flush never landed), and publishing it
        // as rev 1 would walk the Lamport counter backwards.
        rev: Math.max(1, ((known && known.rev) || 0) + (known ? 1 : 0)),
        updatedAt: Date.now(),
        hash: hashValue(parsed),
        deleted: false
      });
    }

    if (localWrites.size === 0) return;

    this.claimSyncedData(state.userId);

    const flush = state.useFirestore
      ? this.flushToFirestore(state, localWrites)
      : this.flushToRealtimeDb(state, localWrites);

    flush.catch((error) => {
      if (error.code === 'permission-denied' || error.code === 'unauthenticated') {
        console.error(`🔐 Auth error uploading local-only keys for ${state.namespace}:`, error.message);
        return;
      }
      // Don't retry-loop here; the next user write will requeue these
      // through the normal flush path. Retrying would re-hit the same
      // rate limit that motivated this rewrite.
      console.warn(`⚠️ Initial upload of local-only keys failed for ${state.namespace}:`, error.message);
    });
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

    if (state.writeTimer) {
      clearTimeout(state.writeTimer);
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
      queueSize: this.writeQueues.get(namespace)?.size || 0
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
    return {
      activeNamespaces: this.syncStates.size,
      totalKeys: Array.from(this.syncStates.values()).reduce((sum, state) => sum + state.keys.size, 0),
      totalQueueSize,
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
    state.initialMergeDone = false;
    syncManager.uploadLocalOnlyKeys(state, {});
    state.initialMergeDone = true;
  },
  
  // Get all available namespaces
  getAvailableNamespaces() {
    return Array.from(syncManager.syncStates.keys());
  }
};