// Firestore for the code that uses it: the sync engine
// (sync-system/storage-sync-robust.js), Arena, and the MapTap Rivals rival
// network. Importing this module is what brings the Firestore SDK in.
//
// Split out of firebase-config.js on 2026-09-13 (audit S-7). firebase-config.js
// is on every page for the header's sign-in, and it used to import and start
// the Firestore SDK and its IndexedDB cache, plus the Realtime Database SDK, on
// marketing pages that use neither. The invariant tests in
// sync-system/tests/firebase-config-shape.test.mjs keep every consumer routed
// through this file rather than the SDK URL.

import { app, firebaseEmulatorsEnabled } from './firebase-config.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  setLogLevel as setFirestoreLogLevel
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { FIREBASE_EMULATOR_PORTS } from './sync-system/firebase-emulator-flag.mjs';

// Silence Firestore's INFO/WARN logs. The most common offender is the
// "BloomFilter error" warning the SDK emits when it tears down a listen stream
// while a server-side existence-filter check is in flight: an internal
// optimization log, harmless to callers, but visible in production consoles
// every time a user leaves a room. Errors still surface.
setFirestoreLogLevel('error');

// The Firestore SDK as one namespace, so app modules reach `doc`, `onSnapshot`
// and the rest without importing the SDK URL themselves.
export * as firestore from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Offline persistence configured at init time. If IndexedDB is unavailable
// (Safari private mode and the like) the SDK falls back to a memory cache.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

// The same opt-in emulator seam as auth in firebase-config.js (a loopback
// hostname AND the explicit localStorage flag), before any Firestore traffic.
if (firebaseEmulatorsEnabled) {
  connectFirestoreEmulator(db, '127.0.0.1', FIREBASE_EMULATOR_PORTS.firestore);
}
