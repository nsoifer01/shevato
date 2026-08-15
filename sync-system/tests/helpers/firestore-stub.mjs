// Stands in for the Firestore SDK under `node --test`.
//
// Only the functions storage-sync-robust.js imports. State lives on
// globalThis.__syncFirestoreFakes so the test file can:
//   - inspect every setDoc call (path, payload, options),
//   - make individual setDoc calls fail or hang via setDocResponders,
//   - emit fake document snapshots into the listeners the engine attached.
//
// Nothing here talks to a network.

export function firestoreFakes() {
  return (globalThis.__syncFirestoreFakes ||= {
    // Every setDoc invocation: { path, payload, options }.
    setDocCalls: [],
    // FIFO of functions (call) => Promise. Shifted per setDoc call; when
    // empty, setDoc resolves immediately. Lets a test reject a specific
    // flush or hold it in flight while the "user" keeps typing.
    setDocResponders: [],
    // Every onSnapshot attachment: { path, options, onNext, onError, active }.
    snapshotListeners: [],
    deleteDocCalls: []
  });
}

// The engine's estimatePayloadBytes helper recognises Firestore sentinels by
// constructor names containing "FieldValue"; mirror that so the 700 KB guard
// measures payloads exactly the way it does in production.
class StubFieldValue {
  constructor(kind) {
    this._methodName = kind;
  }
}

export function serverTimestamp() {
  return new StubFieldValue('serverTimestamp');
}

export function deleteField() {
  return new StubFieldValue('deleteField');
}

export function isServerTimestampSentinel(v) {
  return v instanceof StubFieldValue && v._methodName === 'serverTimestamp';
}

export function isDeleteSentinel(v) {
  return v instanceof StubFieldValue && v._methodName === 'deleteField';
}

export function doc(_db, ...segments) {
  return { __kind: 'doc', path: segments.join('/') };
}

export function onSnapshot(docRef, options, onNext, onError) {
  const listener = { path: docRef.path, options, onNext, onError, active: true };
  firestoreFakes().snapshotListeners.push(listener);
  return () => { listener.active = false; };
}

export function setDoc(docRef, payload, options) {
  const state = firestoreFakes();
  const call = { path: docRef.path, payload, options };
  state.setDocCalls.push(call);
  const responder = state.setDocResponders.shift();
  return responder ? responder(call) : Promise.resolve();
}

export function deleteDoc(docRef) {
  firestoreFakes().deleteDocCalls.push(docRef.path);
  return Promise.resolve();
}

export function collection(_db, name) {
  return { __kind: 'collection', name };
}

export function query(base) {
  return base;
}

export function where() {
  return { __kind: 'where' };
}

export function getDocs() {
  return Promise.resolve({ docs: [] });
}
