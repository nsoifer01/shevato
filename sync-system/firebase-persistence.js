// Firebase offline persistence module
// Enables IndexedDB caching for Firestore with graceful fallbacks

import { 
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
  disableNetwork,
  enableNetwork
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Enable offline persistence for Firestore
 * @param {Firestore} db - Firestore instance
 * @param {boolean} multiTab - Enable multi-tab support (default: true)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function enablePersistence(db, multiTab = true) {
  try {
    // Check if persistence is already enabled
    if (window._firestorePersistenceEnabled) {
      return { success: true, message: 'Persistence already enabled' };
    }

    // Try multi-tab persistence first (recommended)
    if (multiTab) {
      try {
        // Note: Using deprecated API temporarily - modern API caused connection issues
        await enableMultiTabIndexedDbPersistence(db);
        window._firestorePersistenceEnabled = true;
        return { success: true, message: 'Multi-tab persistence enabled (deprecated API)' };
      } catch (err) {
        // Fall back to single-tab if multi-tab fails
        console.warn('Multi-tab persistence failed, trying single-tab:', err.message);
      }
    }

    // Single-tab persistence
    await enableIndexedDbPersistence(db);
    window._firestorePersistenceEnabled = true;
    return { success: true, message: 'Single-tab persistence enabled (deprecated API)' };

  } catch (err) {
    // Handle common errors
    let message = 'Persistence not available: ';
    
    if (err.code === 'failed-precondition') {
      // Multiple tabs open
      message += 'Multiple tabs open. Close other tabs and reload.';
    } else if (err.code === 'unimplemented') {
      // Browser doesn't support persistence
      message += 'Browser doesn\'t support offline persistence.';
    } else if (err.name === 'QuotaExceededError') {
      // Storage quota exceeded
      message += 'Storage quota exceeded. Clear browser data.';
    } else if (window.location.protocol === 'file:') {
      // File protocol doesn't support IndexedDB
      message += 'File protocol detected. Use HTTP(S) server.';
    } else {
      message += err.message;
    }

    console.warn(message);
    return { success: false, message };
  }
}

/**
 * Toggle network connection for testing offline behavior
 * @param {Firestore} db - Firestore instance
 * @param {boolean} online - True to enable network, false to disable
 */
export async function toggleNetwork(db, online) {
  try {
    if (online) {
      await enableNetwork(db);
      console.log('Network enabled');
    } else {
      await disableNetwork(db);
      console.log('Network disabled - offline mode');
    }
  } catch (err) {
    console.error('Failed to toggle network:', err);
  }
}

// Browser compatibility notes
export const PERSISTENCE_CAVEATS = {
  safari: 'Safari in Private Mode blocks IndexedDB. Persistence will fail.',
  firefox: 'Firefox in Private Mode has limited IndexedDB quota.',
  chrome: 'Chrome works best with multi-tab persistence.',
  mobile: 'Mobile browsers may clear IndexedDB when storage is low.',
  quota: 'Default quota is ~50MB. Monitor usage to avoid data loss.'
};