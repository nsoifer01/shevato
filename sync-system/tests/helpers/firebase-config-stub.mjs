// Stands in for the repo root's firebase-config.js under `node --test`.
//
// The real file initialises the Firebase app from SDK URLs and wires auth
// adapters onto window; the sync engine only needs `db`, `rtdb` and `auth`.
// The current user is read from globalThis.__syncAuthFakes so a test can
// swap users or sign out between assertions.

export const db = { __kind: 'fake-firestore-db' };
export const rtdb = { __kind: 'fake-rtdb' };

export function authFakes() {
  return (globalThis.__syncAuthFakes ||= { currentUser: null, authListeners: [] });
}

export const auth = {
  get currentUser() {
    return authFakes().currentUser;
  },
  onAuthStateChanged(callback) {
    authFakes().authListeners.push(callback);
    return () => {
      const listeners = authFakes().authListeners;
      const i = listeners.indexOf(callback);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
};
