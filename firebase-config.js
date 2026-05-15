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
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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
// to live in sync-system/firebase-persistence.js. If IndexedDB is unavailable
// (Safari private mode, etc.), the SDK falls back to in-memory cache itself.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
export const rtdb = getDatabase(app);
export { app };

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

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (!authReady) {
    authReady = true;
    resolveReady();
  }
  for (const cb of listeners) {
    try { cb(user); } catch (err) { console.error('Auth listener error:', err); }
  }
});

const ERROR_MESSAGES = {
  'auth/user-not-found': 'No account found with this email address.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/invalid-login-credentials': 'Invalid email or password. Please check your credentials and try again.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Password should be at least 6 characters.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/too-many-requests': 'Too many failed attempts. Please try again later.'
};

function formatAuthError(err) {
  return new Error(ERROR_MESSAGES[err?.code] || err?.message || 'Authentication failed');
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
