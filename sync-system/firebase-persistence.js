// Firebase offline persistence module
// Persistence is now configured at Firestore init time in firebase-config.js
// using the modern persistentLocalCache + persistentMultipleTabManager API.
// This module's enablePersistence() is kept as a no-op so existing callers
// (sync-system/app-sync-init.js, the per-app preload <script> tags) continue
// to work without changes.

import {
  disableNetwork,
  enableNetwork
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * No-op shim: persistence is configured at initializeFirestore() time now.
 * Kept for backwards compatibility with existing call sites.
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function enablePersistence() {
  return { success: true, message: 'Persistence configured at init (modern cache API)' };
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
