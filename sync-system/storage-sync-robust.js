// Robust bidirectional localStorage ↔ Firebase sync module
// Improved version with better conflict resolution and reliability

import {
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  deleteField,
  deleteDoc
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
  decideRemoteChange
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
// single namespace can't silently lose writes once payloads grow.
const MAX_FLUSH_BYTES = 700 * 1024;

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
        hash: currentHash
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
  startStorageSync({ namespace, keys, useFirestore = USE_FIRESTORE }) {
    const user = auth.currentUser;
    if (user) {
      return this._startSyncForUser(user, { namespace, keys, useFirestore });
    }

    console.warn('❌ No authenticated user — sync will start once auth is ready');
    let actualSync = null;
    const delayedSync = {
      stop: () => { if (actualSync) actualSync.stop(); }
    };

    const unsubscribe = auth.onAuthStateChanged((authUser) => {
      if (authUser?.uid && !actualSync) {
        actualSync = this._startSyncForUser(authUser, { namespace, keys, useFirestore });
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
  _startSyncForUser(user, { namespace, keys, useFirestore = USE_FIRESTORE }) {
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

          for (const [key, info] of Object.entries(remoteData)) {
            if (!state.keys.has(key)) continue;
            this.applyRemoteChange(key, info);
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
  applyRemoteChange(key, remoteInfo) {
    const localRev = this.localRevisions.get(key);
    const remoteTimestamp = getTimestamp(remoteInfo.updatedAt);
    const lastRemoteUpdate = this.lastRemoteUpdates.get(key) || 0;
    const verdict = decideRemoteChange(localRev, remoteInfo, lastRemoteUpdate);

    if (verdict === 'skip-stale' || verdict === 'skip-older') return;
    if (verdict === 'skip-deduped') {
      this.lastRemoteUpdates.set(key, remoteTimestamp);
      return;
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
        rev: remoteInfo.rev || 0,
        updatedAt: remoteTimestamp,
        hash: hashValue(remoteInfo.value)
      });

      this.lastRemoteUpdates.set(key, remoteTimestamp);

      window.dispatchEvent(new CustomEvent('localStorageSync', {
        detail: { key, value: remoteInfo.value, source: 'remote' }
      }));
    } finally {
      this.syncLocks.delete(key);
    }
  }

  /**
   * Enhanced write queueing with deduplication
   */
  queueWrite(state, key, value) {
    const queue = this.writeQueues.get(state.namespace);
    const currentHash = hashValue(value);
    const localRev = this.localRevisions.get(key) || { rev: 0, hash: '' };
    
    // Skip if value hasn't actually changed
    if (currentHash === localRev.hash) {
      return;
    }
    
    // Parse value if it's a string JSON
    let parsedValue = value;
    if (value !== null && value !== undefined) {
      try {
        parsedValue = JSON.parse(value);
      } catch {
        // Keep as string if not valid JSON
      }
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
      hash: currentHash
    });

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
      
      // Retry logic
      if (state.retryCount < MAX_RETRY_ATTEMPTS) {
        state.retryCount++;
        console.log(`🔄 Retrying write flush (${state.retryCount}/${MAX_RETRY_ATTEMPTS})`);
        
        // Re-queue failed writes
        for (const [key, value] of writes) {
          queue.set(key, value);
        }
        
        // Retry with exponential backoff
        setTimeout(() => this.flushWrites(state), RETRY_DELAY_MS * state.retryCount);
      } else {
        console.error(`💥 Max retry attempts exceeded for ${state.namespace}`);
        state.retryCount = 0;
      }
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

    const dataPayload = {};
    for (const [key, info] of writes) {
      if (info.deleted) {
        dataPayload[key] = deleteField();
      } else {
        dataPayload[key] = {
          value: sanitiseForFirestore(info.value),
          rev: info.rev,
          updatedAt: serverTimestamp(),
          hash: info.hash
        };
      }
    }

    // Refuse to ship a payload that would breach Firestore's 1 MiB doc
    // ceiling. Surface as a real error so the retry path requeues and the
    // user sees something instead of a silent drop.
    const approxBytes = estimatePayloadBytes(dataPayload);
    if (approxBytes > MAX_FLUSH_BYTES) {
      throw new Error(
        `Refusing to flush ${state.namespace}: payload ~${approxBytes}B exceeds ${MAX_FLUSH_BYTES}B`
      );
    }

    await setDoc(docRef, {
      data: dataPayload,
      meta: { lastUpdated: serverTimestamp() }
    }, { merge: true });
  }

  /**
   * Enhanced RTDB flush
   */
  async flushToRealtimeDb(state, writes) {
    const dbPath = `users/${state.userId}/apps/${state.namespace}`;
    const dbRef = ref(rtdb, dbPath);

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

    for (const key of state.keys) {
      const localValue = getItem(key);
      if (localValue === null || localValue === undefined) continue;
      if (remoteData[key] !== undefined) continue;

      const parsed = parseValue(localValue);
      localWrites.set(key, {
        value: parsed,
        rev: 1,
        updatedAt: Date.now(),
        hash: hashValue(parsed),
        deleted: false
      });
    }

    if (localWrites.size === 0) return;

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
  const docRef = doc(db, `users/${user.uid}/apps/${namespace}`);
  await deleteDoc(docRef);
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