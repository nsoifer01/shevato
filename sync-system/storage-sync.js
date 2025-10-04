// Bidirectional localStorage ↔ Firebase sync module
// Supports both Firestore and Realtime Database backends

import { 
  doc, 
  getDoc, 
  setDoc, 
  onSnapshot, 
  serverTimestamp,
  runTransaction,
  deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import {
  ref,
  get,
  set,
  onValue,
  serverTimestamp as rtdbServerTimestamp,
  runTransaction as rtdbTransaction,
  off
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

import { db, rtdb, auth } from '../firebase-config.js';

// Configuration
const DEBOUNCE_MS = 500;
const USE_FIRESTORE = true; // Set to false for Realtime Database

// Internal state management
const syncState = new Map(); // namespace -> sync state
const writeQueues = new Map(); // namespace -> pending writes
const localRevisions = new Map(); // key -> { rev, updatedAt }

/**
 * Start bidirectional sync for a namespace and set of keys
 * @param {Object} config - Configuration object
 * @param {string} config.namespace - App namespace (e.g., 'todoApp')
 * @param {string[]} config.keys - localStorage keys to sync
 * @param {boolean} [config.useFirestore=true] - Use Firestore (true) or RTDB (false)
 * @returns {{ stop: Function }} - Control object with stop method
 */
export function startStorageSync({ namespace, keys, useFirestore = USE_FIRESTORE }) {
  const user = auth.currentUser;
  if (!user) {
    console.warn('No authenticated user - sync disabled');
    return { stop: () => {} };
  }

  // Initialize sync state
  const state = {
    namespace,
    keys: new Set(keys),
    userId: user.uid,
    useFirestore,
    listeners: [],
    writeTimer: null,
    stopped: false
  };
  
  syncState.set(namespace, state);
  
  // Initialize write queue
  if (!writeQueues.has(namespace)) {
    writeQueues.set(namespace, new Map());
  }

  // Start sync based on backend
  if (useFirestore) {
    initFirestoreSync(state);
  } else {
    initRealtimeDbSync(state);
  }

  // Set up localStorage monitoring
  initLocalStorageWatcher(state);

  // Perform initial merge
  performInitialMerge(state);

  // Return control object
  return {
    stop: () => stopSync(namespace)
  };
}

/**
 * Initialize Firestore sync
 */
function initFirestoreSync(state) {
  const docPath = `users/${state.userId}/apps/${state.namespace}`;
  const docRef = doc(db, docPath);

  // Set up real-time listener
  const unsubscribe = onSnapshot(docRef, (snapshot) => {
    if (state.stopped) return;
    
    const data = snapshot.data();
    if (!data || !data.data) return;

    // Apply remote changes to localStorage
    for (const [key, info] of Object.entries(data.data)) {
      if (!state.keys.has(key)) continue;
      
      // Check if remote version is newer
      if (shouldApplyRemoteChange(key, info)) {
        applyToLocalStorage(key, info);
      }
    }
  }, (error) => {
    console.error(`Firestore sync error for ${state.namespace}:`, error);
  });

  state.listeners.push(() => unsubscribe());
}

/**
 * Initialize Realtime Database sync
 */
function initRealtimeDbSync(state) {
  const dbPath = `users/${state.userId}/apps/${state.namespace}`;
  const dbRef = ref(rtdb, dbPath);

  // Set up real-time listener
  const callback = (snapshot) => {
    if (state.stopped) return;
    
    const data = snapshot.val();
    if (!data || !data.data) return;

    // Apply remote changes to localStorage
    for (const [key, info] of Object.entries(data.data)) {
      if (!state.keys.has(key)) continue;
      
      // Check if remote version is newer
      if (shouldApplyRemoteChange(key, info)) {
        applyToLocalStorage(key, info);
      }
    }
  };

  onValue(dbRef, callback, (error) => {
    console.error(`RTDB sync error for ${state.namespace}:`, error);
  });

  state.listeners.push(() => off(dbRef, 'value', callback));
}

/**
 * Set up localStorage change detection
 */
function initLocalStorageWatcher(state) {
  // Override localStorage.setItem to detect changes
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);

  // Create custom setItem
  const customSetItem = (key, value) => {
    originalSetItem(key, value);
    if (state.keys.has(key) && !state.stopped) {
      queueWrite(state, key, value);
    }
  };

  // Create custom removeItem  
  const customRemoveItem = (key) => {
    originalRemoveItem(key);
    if (state.keys.has(key) && !state.stopped) {
      queueWrite(state, key, null); // null indicates deletion
    }
  };

  // Store original methods for cleanup
  state._originalSetItem = originalSetItem;
  state._originalRemoveItem = originalRemoveItem;
  
  // Apply overrides
  localStorage.setItem = customSetItem;
  localStorage.removeItem = customRemoveItem;

  // Listen for storage events (cross-tab changes)
  const storageHandler = (e) => {
    if (e.key && state.keys.has(e.key) && !state.stopped) {
      queueWrite(state, e.key, e.newValue);
    }
  };
  
  window.addEventListener('storage', storageHandler);
  state.listeners.push(() => {
    window.removeEventListener('storage', storageHandler);
    // Restore original methods
    localStorage.setItem = state._originalSetItem;
    localStorage.removeItem = state._originalRemoveItem;
  });
}

/**
 * Queue a write operation with debouncing
 */
function queueWrite(state, key, value) {
  const queue = writeQueues.get(state.namespace);
  
  // Parse value if it's a string JSON
  let parsedValue = value;
  if (value !== null && value !== undefined) {
    try {
      parsedValue = JSON.parse(value);
    } catch {
      // Keep as string if not valid JSON
    }
  }

  // Update revision
  const currentRev = localRevisions.get(key) || { rev: 0 };
  const newRev = currentRev.rev + 1;
  
  queue.set(key, {
    value: parsedValue,
    rev: newRev,
    updatedAt: Date.now(), // Client timestamp for immediate tracking
    deleted: value === null
  });

  localRevisions.set(key, { rev: newRev, updatedAt: Date.now() });

  // Clear existing timer
  if (state.writeTimer) {
    clearTimeout(state.writeTimer);
  }

  // Set new debounced write
  state.writeTimer = setTimeout(() => {
    flushWrites(state);
  }, DEBOUNCE_MS);
}

/**
 * Flush pending writes to Firebase
 */
async function flushWrites(state) {
  const queue = writeQueues.get(state.namespace);
  if (!queue || queue.size === 0) return;

  // Copy queue and clear it
  const writes = new Map(queue);
  queue.clear();

  try {
    if (state.useFirestore) {
      await flushToFirestore(state, writes);
    } else {
      await flushToRealtimeDb(state, writes);
    }
  } catch (error) {
    console.error(`Failed to flush writes for ${state.namespace}:`, error);
    // Re-queue failed writes
    for (const [key, value] of writes) {
      queue.set(key, value);
    }
  }
}

/**
 * Flush writes to Firestore
 */
async function flushToFirestore(state, writes) {
  const docPath = `users/${state.userId}/apps/${state.namespace}`;
  const docRef = doc(db, docPath);

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(docRef);
    const currentData = snapshot.data() || { data: {}, meta: {} };

    // Prepare update object
    const updates = {
      data: { ...currentData.data },
      meta: {
        ...currentData.meta,
        lastUpdated: serverTimestamp()
      }
    };

    // Apply each write
    for (const [key, info] of writes) {
      if (info.deleted) {
        updates.data[key] = deleteField();
      } else {
        updates.data[key] = {
          value: info.value,
          rev: info.rev,
          updatedAt: serverTimestamp()
        };
      }
    }

    transaction.set(docRef, updates, { merge: true });
  });
}

/**
 * Flush writes to Realtime Database
 */
async function flushToRealtimeDb(state, writes) {
  const dbPath = `users/${state.userId}/apps/${state.namespace}`;
  const dbRef = ref(rtdb, dbPath);

  await rtdbTransaction(dbRef, (currentData) => {
    const data = currentData || { data: {}, meta: {} };

    // Apply each write
    for (const [key, info] of writes) {
      if (info.deleted) {
        delete data.data[key];
      } else {
        data.data[key] = {
          value: info.value,
          rev: info.rev,
          updatedAt: rtdbServerTimestamp()
        };
      }
    }

    data.meta = {
      ...data.meta,
      lastUpdated: rtdbServerTimestamp()
    };

    return data;
  });
}

/**
 * Perform initial merge on first sync
 */
async function performInitialMerge(state) {
  try {
    let remoteData;
    
    if (state.useFirestore) {
      const docRef = doc(db, `users/${state.userId}/apps/${state.namespace}`);
      const snapshot = await getDoc(docRef);
      remoteData = snapshot.data();
    } else {
      const dbRef = ref(rtdb, `users/${state.userId}/apps/${state.namespace}`);
      const snapshot = await get(dbRef);
      remoteData = snapshot.val();
    }

    if (!remoteData || !remoteData.data) {
      // No remote data - push all local data
      const localWrites = new Map();
      for (const key of state.keys) {
        const value = localStorage.getItem(key);
        if (value !== null) {
          localWrites.set(key, {
            value: JSON.parse(value),
            rev: 1,
            updatedAt: Date.now()
          });
          localRevisions.set(key, { rev: 1, updatedAt: Date.now() });
        }
      }
      if (localWrites.size > 0) {
        await flushWrites(state);
      }
      return;
    }

    // Merge remote with local
    const mergeWrites = new Map();
    
    for (const key of state.keys) {
      const localValue = localStorage.getItem(key);
      const remoteInfo = remoteData.data[key];

      if (!remoteInfo && localValue !== null) {
        // Local only - push to remote
        mergeWrites.set(key, {
          value: JSON.parse(localValue),
          rev: 1,
          updatedAt: Date.now()
        });
      } else if (remoteInfo && localValue === null) {
        // Remote only - apply to local
        applyToLocalStorage(key, remoteInfo);
      } else if (remoteInfo && localValue !== null) {
        // Both exist - use latest
        // Since we don't have local timestamps initially, prefer remote
        applyToLocalStorage(key, remoteInfo);
      }
    }

    if (mergeWrites.size > 0) {
      if (state.useFirestore) {
        await flushToFirestore(state, mergeWrites);
      } else {
        await flushToRealtimeDb(state, mergeWrites);
      }
    }
  } catch (error) {
    console.error(`Initial merge failed for ${state.namespace}:`, error);
  }
}

/**
 * Check if remote change should be applied
 */
function shouldApplyRemoteChange(key, remoteInfo) {
  const localRev = localRevisions.get(key);
  if (!localRev) return true;

  // Compare timestamps first (if available)
  if (remoteInfo.updatedAt && localRev.updatedAt) {
    const remoteTime = remoteInfo.updatedAt.toMillis ? 
      remoteInfo.updatedAt.toMillis() : remoteInfo.updatedAt;
    
    if (remoteTime > localRev.updatedAt) return true;
    if (remoteTime < localRev.updatedAt) return false;
  }

  // Timestamps equal or unavailable - compare revisions
  return remoteInfo.rev > localRev.rev;
}

/**
 * Apply remote change to localStorage
 */
function applyToLocalStorage(key, info) {
  // Temporarily disable watcher to avoid echo
  const state = Array.from(syncState.values()).find(s => s.keys.has(key));
  if (state) {
    const originalSetItem = state._originalSetItem || localStorage.setItem.bind(localStorage);
    
    if (info.deleted || info.value === undefined || info.value === null) {
      localStorage.removeItem(key);
    } else {
      const value = typeof info.value === 'object' ? 
        JSON.stringify(info.value) : String(info.value);
      originalSetItem(key, value);
    }
    
    // Update local revision tracking
    localRevisions.set(key, {
      rev: info.rev || 0,
      updatedAt: info.updatedAt?.toMillis ? 
        info.updatedAt.toMillis() : info.updatedAt || Date.now()
    });
  }
}

/**
 * Stop sync for a namespace
 */
function stopSync(namespace) {
  const state = syncState.get(namespace);
  if (!state) return;

  state.stopped = true;

  // Clear pending writes
  if (state.writeTimer) {
    clearTimeout(state.writeTimer);
  }

  // Clean up listeners
  state.listeners.forEach(cleanup => cleanup());

  // Clean up state
  syncState.delete(namespace);
  writeQueues.delete(namespace);
  
  // Clear local revisions for this namespace's keys
  for (const key of state.keys) {
    localRevisions.delete(key);
  }
}

/**
 * Helper: Manually set a cloud item (optional)
 */
export async function setCloudItem(key, value) {
  const user = auth.currentUser;
  if (!user) throw new Error('No authenticated user');

  // Find namespace for this key
  let namespace = null;
  for (const [ns, state] of syncState) {
    if (state.keys.has(key)) {
      namespace = ns;
      break;
    }
  }

  if (!namespace) throw new Error(`Key ${key} not registered for sync`);

  const state = syncState.get(namespace);
  queueWrite(state, key, typeof value === 'object' ? JSON.stringify(value) : value);
  await flushWrites(state);
}

/**
 * Stop all active syncs (useful for sign-out)
 */
export function stopAllSyncs() {
  for (const namespace of syncState.keys()) {
    stopSync(namespace);
  }
}