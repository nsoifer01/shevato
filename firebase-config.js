// Firebase configuration + auth adapter — single source of truth.
//
// This file is loaded once per page as `<script type="module">`. It
// initialises the Firebase modular v10 SDK exactly once and exposes a
// minimal auth adapter on `window.firebaseAuth` for the non-module
// scripts (assets/js/main.js, sync-modal-integration.js,
// sync-debug.js) that need to read auth state without importing
// modules themselves.
//
// History: the site previously loaded BOTH the v9 compat SDK (via
// `<script src="firebase-app-compat.js">` + `firebase-auth-compat.js`)
// AND this modular SDK. Each created its own `<authDomain>/__/auth/iframe`
// for cross-origin auth-state sharing; each iframe pulled
// `apis.google.com/js/api.js?onload=__iframefcb<id>` and registered a
// callback by that name on `window`. On mobile the two iframes raced
// — one iframe's `__iframefcb<id>` slot was cleared before that
// iframe's gapi.js finished loading, so gapi tried to invoke a
// callback that was already `undefined` (`Uncaught TypeError:
// u[v] is not a function`). The compat SDK has been removed; the
// adapter below provides the same surface main.js needs.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  setLogLevel as setFirestoreLogLevel
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Silence Firestore's INFO/WARN logs. The most common offender is the
// "BloomFilter error" warning the SDK emits when it tears down a
// listen-stream while a server-side existence-filter check is in flight —
// purely an internal optimization log, harmless to callers, but visible
// in production consoles every time a user leaves a room. Errors still
// surface so real failures aren't hidden.
setFirestoreLogLevel('error');
// Re-export the Firestore SDK as a single namespace so app modules can
// reach `doc`, `onSnapshot`, etc. without re-importing the SDK URL
// themselves. The invariant test in sync-system/tests/firebase-config-shape.test.mjs
// (`no app file imports Firestore directly except the sync layer`) keeps
// every consumer routed through this file.
export * as firestore from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getDatabase, connectDatabaseEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInAnonymously,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { createCrossTabChannel, CHANNEL_MESSAGE_TYPES } from './sync-system/cross-tab-channel.mjs';
import {
  shouldUseFirebaseEmulators,
  FIREBASE_EMULATOR_FLAG_KEY,
  FIREBASE_EMULATOR_PORTS
} from './sync-system/firebase-emulator-flag.mjs';

const firebaseConfig = {
  apiKey: "AIzaSyDlawczS-pufHS_Oi5LUeU_EzcwTFyU_2I",
  authDomain: "shevato-site.firebaseapp.com",
  projectId: "shevato-site",
  storageBucket: "shevato-site.firebasestorage.app",
  messagingSenderId: "1082724320778",
  appId: "1:1082724320778:web:e374cbaeeae1bdaeee81f3",
  measurementId: "G-2C9F2PCXHP",
  databaseURL: "https://shevato-site-default-rtdb.firebaseio.com/"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Firestore with offline persistence configured at init time (modern API).
// Replaces the deprecated enableMultiTabIndexedDbPersistence() call that used
// to live in a separate persistence shim (sync-system/firebase-persistence.js,
// now retired). If IndexedDB is unavailable (Safari private mode, etc.), the
// SDK falls back to in-memory cache itself.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
export const rtdb = getDatabase(app);
export { app };

// Test-only emulator seam. Provably inert in production: enabling it
// requires BOTH a loopback hostname AND an explicit per-origin opt-in
// (localStorage['shevato:firebase-emulators'] === '1'), so no deployed
// host can ever qualify and ordinary local development against
// production Firebase stays unchanged until a developer or a test
// harness opts in. The decision logic is a pure module
// (sync-system/firebase-emulator-flag.mjs) with its own unit tests; the
// Arena emulator e2e (apps/arena/e2e/) is the intended consumer. Must
// run before any Firestore/Auth/RTDB network traffic, hence directly
// after the instances are created.
const useEmulators = (() => {
  try {
    return typeof window !== 'undefined' && shouldUseFirebaseEmulators(
      window.location.hostname,
      window.localStorage.getItem(FIREBASE_EMULATOR_FLAG_KEY)
    );
  } catch (_) {
    // Storage access can throw (privacy modes); production behavior wins.
    return false;
  }
})();
if (useEmulators) {
  connectAuthEmulator(auth, `http://127.0.0.1:${FIREBASE_EMULATOR_PORTS.auth}`, { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', FIREBASE_EMULATOR_PORTS.firestore);
  connectDatabaseEmulator(rtdb, '127.0.0.1', FIREBASE_EMULATOR_PORTS.database);
  console.warn('[firebase-config] EMULATOR MODE: all Firebase traffic is routed to local emulators.');
}

// Persistence — survive reloads across tabs. Best-effort; mobile
// private mode and quota-exhausted browsers fall back to in-memory.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('Firebase auth persistence setup failed:', err.message);
});

// Adapter for non-module callers.
let currentUser = null;
const listeners = new Set();
let authReady = false;
let resolveReady;
const readyPromise = new Promise((r) => { resolveReady = r; });

// Cross-tab signal. Shared singleton on the window so storage-sync-robust
// and any future module can reuse the same channel (BroadcastChannel
// instances are cheap, but a single broadcast surface is easier to reason
// about — and tests can swap a fake into window.__shevatoSyncChannel
// before this module loads).
export const crossTabChannel = (typeof window !== 'undefined' && window.__shevatoSyncChannel)
  ? window.__shevatoSyncChannel
  : createCrossTabChannel();
if (typeof window !== 'undefined') {
  window.__shevatoSyncChannel = crossTabChannel;
}

function notifyAuthListeners(user) {
  for (const cb of listeners) {
    try { cb(user); } catch (err) { console.error('Auth listener error:', err); }
  }
}

onAuthStateChanged(auth, (user) => {
  const prevUid = currentUser?.uid || null;
  currentUser = user;
  if (!authReady) {
    authReady = true;
    resolveReady();
  }
  notifyAuthListeners(user);

  // Tell sibling tabs immediately. They will re-check their own auth state
  // (Firebase's IndexedDB cross-tab eventually catches up, but the broadcast
  // is synchronous between same-origin tabs and avoids the multi-second
  // mobile latency window).
  const nextUid = user?.uid || null;
  if (prevUid !== nextUid) {
    crossTabChannel.publish(CHANNEL_MESSAGE_TYPES.AUTH_CHANGED, { uid: nextUid });
  }
});

// Remote tab signalled an auth change. Re-fire our listeners with the
// current `auth.currentUser` so app UI re-evaluates without waiting for
// Firebase's own IndexedDB-backed cross-tab sync. This is a hint, not a
// source of truth: `auth.currentUser` is still owned by the Firebase SDK.
// We let the SDK settle for one tick before re-fanning so its IndexedDB
// listener has a chance to update `currentUser` first.
crossTabChannel.subscribe(CHANNEL_MESSAGE_TYPES.AUTH_CHANGED, () => {
  // Microtask delay is enough — Firebase's storage listener fires
  // synchronously on the IndexedDB write event from the peer tab.
  Promise.resolve().then(() => {
    notifyAuthListeners(auth.currentUser);
  });
});

// Every message a visitor can see. The fallback is deliberately generic:
// the raw SDK string ("Firebase: Error (auth/network-request-failed).") is
// never shown, whatever code comes back. Unmapped codes are logged by the
// callers so they can be added here.
const ERROR_MESSAGES = {
  'auth/user-not-found': 'No account found with this email address.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/invalid-login-credentials': 'Invalid email or password. Please check your credentials and try again.',
  'auth/invalid-credential': 'Invalid email or password. Please check your credentials and try again.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Password should be at least 6 characters.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/missing-password': 'Please enter your password.',
  'auth/too-many-requests': 'Too many failed attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'We could not reach the sign-in service. Check your connection and try again.',
  'auth/user-disabled': 'This account has been disabled. Contact us if you think that is a mistake.',
  'auth/operation-not-allowed': 'Email sign-in is not enabled right now. Please try again later.',
  'auth/requires-recent-login': 'Please sign in again to continue.',
  'auth/user-token-expired': 'Your session has expired. Please sign in again.',
  'auth/internal-error': 'Something went wrong on the sign-in service. Please try again.'
};
const GENERIC_AUTH_ERROR = 'Sign-in failed. Please try again in a moment.';

function formatAuthError(err) {
  return new Error(ERROR_MESSAGES[err?.code] || GENERIC_AUTH_ERROR);
}

window.firebaseConfig = firebaseConfig;

window.firebaseAuth = {
  initialized: true,
  isAvailable: () => true,
  getCurrentUser: () => currentUser,
  isSignedIn: () => currentUser !== null,
  ready: () => readyPromise,
  onAuthStateChange(callback) {
    listeners.add(callback);
    if (authReady) {
      try { callback(currentUser); } catch (err) { console.error('Auth listener error:', err); }
    }
    return () => listeners.delete(callback);
  },
  async signIn(email, password) {
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      return cred.user;
    } catch (err) {
      console.error('Sign in error:', err);
      throw formatAuthError(err);
    }
  },
  async signUp(email, password) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      return cred.user;
    } catch (err) {
      console.error('Sign up error:', err);
      throw formatAuthError(err);
    }
  },
  // Send a password-reset email. Privacy: never reveal whether an address is
  // registered. Firebase throws `auth/user-not-found` for unknown emails
  // unless the project has Email Enumeration Protection enabled, so we swallow
  // that specific code and resolve as if it succeeded. The caller shows the
  // same neutral confirmation either way, so the modal cannot be used to probe
  // which emails exist. Other errors (invalid address, rate limit) still throw.
  async resetPassword(email) {
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (err) {
      if (err?.code === 'auth/user-not-found') {
        return;
      }
      console.error('Password reset error:', err);
      throw formatAuthError(err);
    }
  },
  // Guest mode — used by Arena to let users try multiplayer without
  // creating an account. The returned uid is per-device and resets when
  // browser storage is cleared, so callers must NOT write to any
  // persistent collection (leaderboard, profile, H2H) for anon users.
  async signInAsGuest() {
    try {
      const cred = await signInAnonymously(auth);
      return cred.user;
    } catch (err) {
      console.error('Anonymous sign in error:', err);
      throw formatAuthError(err);
    }
  },
  async signOut() {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Sign out error:', err);
      throw err;
    }
  }
};

// Signal readiness. Non-module scripts (main.js's AuthUI) listen for
// this; if they load AFTER this file evaluates, they fall back to the
// `window.firebaseAuth` flag which is already set above.
window.dispatchEvent(new CustomEvent('firebaseAuthReady'));
