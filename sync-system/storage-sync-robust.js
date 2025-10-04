// Robust bidirectional localStorage ↔ Firebase sync module
// Improved version with better conflict resolution and reliability

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
const DEBOUNCE_MS = 300; // Reduced for faster sync
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const USE_FIRESTORE = true;

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
      console.log('🔗 Using immediate sync override');
      this.useImmediateOverride();
    } else {
      console.log('⚠️  Immediate override not found, installing fallback');
      this.installGlobalOverride();
    }
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
    console.log('🔧 Integrated with immediate localStorage override');
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
    console.log('🔧 Global localStorage override installed');
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
   * Create a hash of the value for change detection
   */
  hashValue(value) {
    if (value === null || value === undefined) return 'null';
    
    const jsonString = JSON.stringify(value);
    
    try {
      // Try btoa first (faster for Latin1)
      return btoa(jsonString).slice(0, 16);
    } catch (error) {
      // Fallback for Unicode characters (emojis, special chars, etc.)
      // Use a simple hash function that works with all Unicode
      let hash = 0;
      for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      // Return as hex string, padded to 16 chars
      return Math.abs(hash).toString(16).padStart(16, '0').slice(0, 16);
    }
  }

  /**
   * Start sync for a namespace
   */
  startStorageSync({ namespace, keys, useFirestore = USE_FIRESTORE }) {
    const user = auth.currentUser;
    if (!user) {
      console.warn('❌ No authenticated user - sync will retry when user signs in');
      // Return a sync object that will start when auth is ready
      let actualSync = null;
      const delayedSync = {
        stop: () => {
          if (actualSync) actualSync.stop();
        }
      };
      
      // Wait for auth state to be ready
      const unsubscribe = auth.onAuthStateChanged((authUser) => {
        if (authUser && !actualSync) {
          console.log('🔄 Auth ready, starting delayed sync for', namespace);
          actualSync = this._startSyncForUser(authUser, { namespace, keys, useFirestore });
          unsubscribe(); // Only need this once
        }
      });
      
      return delayedSync;
    }
    
    return this._startSyncForUser(user, { namespace, keys, useFirestore });
  }
  
  /**
   * Internal method to start sync for an authenticated user
   */
  _startSyncForUser(user, { namespace, keys, useFirestore = USE_FIRESTORE }) {
    // Stop existing sync for this namespace
    if (this.syncStates.has(namespace)) {
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
      lastSyncTime: Date.now()
    };
    
    this.syncStates.set(namespace, state);
    
    // Initialize write queue
    if (!this.writeQueues.has(namespace)) {
      this.writeQueues.set(namespace, new Map());
    }

    // Start Firebase listener
    if (useFirestore) {
      this.initFirestoreSync(state);
    } else {
      this.initRealtimeDbSync(state);
    }

    // Perform initial merge after a short delay
    setTimeout(() => this.performInitialMerge(state), 500);

    console.log(`✅ Sync started for ${namespace} (${keys.length} keys)`);

    return {
      stop: () => this.stopSync(namespace),
      getStatus: () => this.getSyncStatus(namespace)
    };
  }

  /**
   * Enhanced Firestore sync with retry logic
   */
  initFirestoreSync(state) {
    const docPath = `users/${state.userId}/apps/${state.namespace}`;
    const docRef = doc(db, docPath);

    let retryAttempts = 0;
    const setupListener = () => {
      const unsubscribe = onSnapshot(docRef, 
        (snapshot) => {
          if (state.stopped) return;
          
          const data = snapshot.data();
          if (!data || !data.data) return;

          console.log(`🔄 Firebase → Local sync for ${state.namespace}`);
          
          // Apply remote changes to localStorage
          for (const [key, info] of Object.entries(data.data)) {
            if (!state.keys.has(key)) continue;
            
            this.applyRemoteChange(key, info);
          }
          
          retryAttempts = 0; // Reset on success
        }, 
        (error) => {
          // Better error classification and handling
          if (error.code === 'permission-denied' || error.code === 'unauthenticated') {
            console.error(`🔐 Authentication error for ${state.namespace}:`, error.message);
            console.log('💡 User may need to sign in again');
            return; // Don't retry auth errors
          }
          
          if (error.code === 'unavailable' || error.message?.includes('offline') || error.code === 'failed-precondition') {
            console.warn(`📡 Network/connection error for ${state.namespace}:`, error.message);
          } else {
            console.error(`❌ Firestore sync error for ${state.namespace}:`, error);
          }
          
          if (retryAttempts < MAX_RETRY_ATTEMPTS) {
            retryAttempts++;
            const delay = RETRY_DELAY_MS * Math.pow(2, retryAttempts - 1); // Exponential backoff
            console.log(`🔄 Retrying Firestore listener in ${delay}ms (${retryAttempts}/${MAX_RETRY_ATTEMPTS})`);
            setTimeout(setupListener, delay);
          } else {
            console.error(`💥 Max retries exceeded for ${state.namespace} - sync disabled`);
          }
        }
      );

      state.listeners.push(() => unsubscribe());
    };

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
      if (!data || !data.data) return;

      console.log(`🔄 RTDB → Local sync for ${state.namespace}`);

      for (const [key, info] of Object.entries(data.data)) {
        if (!state.keys.has(key)) continue;
        this.applyRemoteChange(key, info);
      }
    };

    onValue(dbRef, callback, (error) => {
      console.error(`❌ RTDB sync error for ${state.namespace}:`, error);
    });

    state.listeners.push(() => off(dbRef, 'value', callback));
  }

  /**
   * Apply remote change with improved conflict resolution
   */
  applyRemoteChange(key, remoteInfo) {
    const localRev = this.localRevisions.get(key);
    const remoteTimestamp = this.getTimestamp(remoteInfo.updatedAt);
    const lastRemoteUpdate = this.lastRemoteUpdates.get(key) || 0;
    
    // Skip if we just processed this change
    if (remoteTimestamp <= lastRemoteUpdate) {
      return;
    }
    
    // Conflict resolution logic
    let shouldApply = true;
    
    if (localRev) {
      // Compare timestamps first
      if (remoteTimestamp < localRev.updatedAt) {
        shouldApply = false; // Local is newer
      } else if (remoteTimestamp === localRev.updatedAt) {
        // Same timestamp - compare revision numbers
        shouldApply = (remoteInfo.rev || 0) > (localRev.rev || 0);
      }
      // If remote timestamp > local timestamp, apply (shouldApply stays true)
    }
    
    if (shouldApply) {
      console.log(`📥 Applying remote change for ${key}`);
      
      // Set sync lock to prevent echo
      this.syncLocks.set(key, true);
      
      try {
        // Use original methods if available, otherwise fall back to localStorage directly
        const setItem = this.originalMethods?.setItem || localStorage.setItem.bind(localStorage);
        const removeItem = this.originalMethods?.removeItem || localStorage.removeItem.bind(localStorage);
        
        if (remoteInfo.deleted || remoteInfo.value === undefined || remoteInfo.value === null) {
          removeItem(key);
        } else {
          const value = typeof remoteInfo.value === 'object' ? 
            JSON.stringify(remoteInfo.value) : String(remoteInfo.value);
          setItem(key, value);
        }
        
        // Update local tracking
        this.localRevisions.set(key, {
          rev: remoteInfo.rev || 0,
          updatedAt: remoteTimestamp,
          hash: this.hashValue(remoteInfo.value)
        });
        
        this.lastRemoteUpdates.set(key, remoteTimestamp);
        
        // Dispatch custom event for apps that want to listen
        window.dispatchEvent(new CustomEvent('localStorageSync', {
          detail: { key, value: remoteInfo.value, source: 'remote' }
        }));
        
      } finally {
        // Clear sync lock after a brief delay
        setTimeout(() => this.syncLocks.delete(key), 100);
      }
    }
  }

  /**
   * Enhanced write queueing with deduplication
   */
  queueWrite(state, key, value) {
    const queue = this.writeQueues.get(state.namespace);
    const currentHash = this.hashValue(value);
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

    console.log(`📤 Queued write for ${key} (rev: ${newRev})`);
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
      console.log(`🚀 Flushing ${writes.size} writes for ${state.namespace}`);
      
      if (state.useFirestore) {
        await this.flushToFirestore(state, writes);
      } else {
        await this.flushToRealtimeDb(state, writes);
      }
      
      state.retryCount = 0;
      state.lastSyncTime = Date.now();
      
      console.log(`✅ Successfully synced ${writes.size} changes for ${state.namespace}`);
      
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
   * Enhanced Firestore flush with better transaction handling
   */
  async flushToFirestore(state, writes) {
    const docPath = `users/${state.userId}/apps/${state.namespace}`;
    const docRef = doc(db, docPath);

    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(docRef);
      const currentData = snapshot.data() || { data: {}, meta: {} };

      const updates = {
        data: { ...currentData.data },
        meta: {
          ...currentData.meta,
          lastUpdated: serverTimestamp(),
          syncVersion: (currentData.meta?.syncVersion || 0) + 1
        }
      };

      for (const [key, info] of writes) {
        if (info.deleted) {
          updates.data[key] = deleteField();
        } else {
          updates.data[key] = {
            value: info.value,
            rev: info.rev,
            updatedAt: serverTimestamp(),
            hash: info.hash
          };
        }
      }

      transaction.set(docRef, updates, { merge: true });
    });
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
   * Enhanced initial merge with better conflict resolution
   */
  async performInitialMerge(state) {
    try {
      console.log(`🔄 Performing initial merge for ${state.namespace}`);
      
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

      const localWrites = new Map();
      const keysToApply = [];

      console.log(`🔄 Analyzing ${state.keys.size} keys for initial merge...`);

      for (const key of state.keys) {
        const localValue = this.originalMethods?.getItem ? 
          this.originalMethods.getItem(key) : localStorage.getItem(key);
        const remoteInfo = remoteData?.data?.[key];

        console.log(`🔍 Key "${key}":`, {
          hasLocal: localValue !== null,
          hasRemote: !!remoteInfo,
          localLength: localValue ? localValue.length : 0,
          remoteValue: remoteInfo ? 'present' : 'missing'
        });

        if (!remoteInfo && localValue !== null) {
          // Local only - queue for upload
          console.log(`⬆️  Local only: ${key} - will upload`);
          localWrites.set(key, {
            value: this.parseValue(localValue),
            rev: 1,
            updatedAt: Date.now(),
            hash: this.hashValue(this.parseValue(localValue))
          });
        } else if (remoteInfo && localValue === null) {
          // Remote only - apply locally  
          console.log(`⬇️  Remote only: ${key} - will download`);
          keysToApply.push({ key, info: remoteInfo });
        } else if (remoteInfo && localValue !== null) {
          // Both exist - resolve conflict
          const remoteTimestamp = this.getTimestamp(remoteInfo.updatedAt);
          const localHash = this.hashValue(this.parseValue(localValue));
          
          console.log(`⚖️  Conflict: ${key}`, {
            remoteHash: remoteInfo.hash,
            localHash: localHash,
            different: remoteInfo.hash !== localHash
          });
          
          if (remoteInfo.hash !== localHash) {
            // Values are different - prefer remote for safety on initial merge
            console.log(`⬇️  Using remote version of: ${key}`);
            keysToApply.push({ key, info: remoteInfo });
          }
        } else {
          console.log(`➖ No data for key: ${key}`);
        }
      }

      console.log(`📊 Initial merge plan: ${keysToApply.length} to download, ${localWrites.size} to upload`);

      // Apply remote changes
      for (const { key, info } of keysToApply) {
        console.log(`📥 Applying remote data for: ${key}`);
        this.applyRemoteChange(key, info);
      }

      // Upload local changes
      if (localWrites.size > 0) {
        console.log(`📤 Uploading ${localWrites.size} local keys to Firebase...`);
        if (state.useFirestore) {
          await this.flushToFirestore(state, localWrites);
        } else {
          await this.flushToRealtimeDb(state, localWrites);
        }
      }

      console.log(`✅ Initial merge complete for ${state.namespace}: ${keysToApply.length} downloaded, ${localWrites.size} uploaded`);
      
    } catch (error) {
      // Check if this is an authentication/permission error
      if (error.code === 'permission-denied' || error.code === 'unauthenticated') {
        console.error(`🔐 Auth error for ${state.namespace}:`, error.message);
        console.log('💡 Waiting for user to sign in...');
        return; // Don't retry auth errors
      }
      
      // Check if this is a network/offline error
      if (error.code === 'unavailable' || error.message?.includes('offline')) {
        console.warn(`📡 Network error for ${state.namespace} - will retry when online:`, error.message);
      } else {
        console.error(`❌ Initial merge failed for ${state.namespace}:`, error);
      }
      
      // Retry initial merge with exponential backoff
      if (state.retryCount < 3) {
        state.retryCount++;
        const backoffDelay = RETRY_DELAY_MS * Math.pow(2, state.retryCount - 1);
        console.log(`🔄 Retrying initial merge in ${backoffDelay}ms (attempt ${state.retryCount}/3)`);
        setTimeout(() => this.performInitialMerge(state), backoffDelay);
      } else {
        console.error(`❌ Initial merge gave up for ${state.namespace} after 3 attempts`);
      }
    }
  }

  /**
   * Utility: Parse value from localStorage
   */
  parseValue(value) {
    if (value === null || value === undefined) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Utility: Get timestamp from Firebase timestamp
   */
  getTimestamp(timestamp) {
    if (!timestamp) return 0;
    if (typeof timestamp === 'number') return timestamp;
    if (timestamp.toMillis) return timestamp.toMillis();
    if (timestamp.seconds) return timestamp.seconds * 1000;
    return 0;
  }

  /**
   * Stop sync for a namespace
   */
  stopSync(namespace) {
    const state = this.syncStates.get(namespace);
    if (!state) return;

    console.log(`🛑 Stopping sync for ${namespace}`);
    
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
    console.log('🛑 Stopping all syncs');
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
    return {
      activeNamespaces: this.syncStates.size,
      totalKeys: Array.from(this.syncStates.values()).reduce((sum, state) => sum + state.keys.size, 0),
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

// Debug helpers
window._debugSync = {
  status: () => syncManager.getGlobalStatus(),
  namespaces: () => Array.from(syncManager.syncStates.keys()),
  locks: () => Array.from(syncManager.syncLocks.keys()),
  revisions: () => Object.fromEntries(syncManager.localRevisions),
  
  // Manual initial merge trigger
  async triggerInitialMerge(namespace) {
    const state = syncManager.syncStates.get(namespace);
    if (!state) {
      console.error(`❌ Namespace "${namespace}" not found`);
      return;
    }
    
    console.log(`🔄 Manually triggering initial merge for ${namespace}...`);
    await syncManager.performInitialMerge(state);
  },
  
  // Get all available namespaces
  getAvailableNamespaces() {
    return Array.from(syncManager.syncStates.keys());
  }
};

console.log('🔧 Robust Storage Sync loaded - use window._debugSync for debugging');