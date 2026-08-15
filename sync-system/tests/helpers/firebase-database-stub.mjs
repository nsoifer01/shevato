// Stands in for the Realtime Database SDK under `node --test`.
//
// storage-sync-robust.js imports these five symbols unconditionally, but the
// production configuration (USE_FIRESTORE = true) never calls them. They are
// inert recorders so the import graph loads; the behavioral suite covers the
// Firestore path.

export function databaseFakes() {
  return (globalThis.__syncDatabaseFakes ||= {
    onValueCalls: [],
    transactionCalls: []
  });
}

export function ref(_rtdb, path) {
  return { __kind: 'rtdb-ref', path };
}

export function onValue(dbRef, callback, onError) {
  databaseFakes().onValueCalls.push({ path: dbRef.path, callback, onError });
}

export function serverTimestamp() {
  return { '.sv': 'timestamp' };
}

export async function runTransaction(dbRef, updateFn) {
  const result = updateFn(null);
  databaseFakes().transactionCalls.push({ path: dbRef.path, result });
  return { committed: true, snapshot: null };
}

export function off() {}
