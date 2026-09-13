// Stands in for EVERY Firebase SDK URL firebase-config.js imports (app,
// firestore, database, auth) under `node --test`, so the real config module
// can be evaluated and its window.firebaseAuth adapter exercised.
//
// Only what firebase-config.js touches at load time or from the adapter.
// Calls are recorded on globalThis.__firebaseSdkFakes in order, so a test can
// assert what happened before what (the sign-out flush must precede
// auth.signOut). Nothing here talks to a network.

export function sdkFakes() {
  return (globalThis.__firebaseSdkFakes ||= { calls: [], authListeners: [] });
}

const noop = () => {};

// firebase-app
export function initializeApp() { return { __kind: 'fake-app' }; }

// firebase-firestore
export function initializeFirestore() { return { __kind: 'fake-firestore' }; }
export function persistentLocalCache(options) { return { __kind: 'persistentLocalCache', options }; }
export function persistentMultipleTabManager() { return { __kind: 'persistentMultipleTabManager' }; }
export const connectFirestoreEmulator = noop;
export const setLogLevel = noop;

// firebase-database
export function getDatabase() { return { __kind: 'fake-rtdb' }; }
export const connectDatabaseEmulator = noop;

// firebase-auth
export function getAuth() { return { __kind: 'fake-auth', currentUser: null }; }
export const connectAuthEmulator = noop;
export const browserLocalPersistence = { __kind: 'browserLocalPersistence' };
export function setPersistence() { return Promise.resolve(); }
export function onAuthStateChanged(_auth, callback) {
  sdkFakes().authListeners.push(callback);
  return noop;
}
export function signOut() {
  sdkFakes().calls.push('signOut');
  return Promise.resolve();
}
export function signInWithEmailAndPassword() { return Promise.reject(new Error('not stubbed')); }
export function createUserWithEmailAndPassword() { return Promise.reject(new Error('not stubbed')); }
export function sendPasswordResetEmail() { return Promise.resolve(); }
export function signInAnonymously() { return Promise.reject(new Error('not stubbed')); }
