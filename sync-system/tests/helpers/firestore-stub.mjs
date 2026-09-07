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
    deleteDocCalls: [],
    // path -> last written body, so getDoc can serve chunk part documents.
    docs: new Map()
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

/**
 * Backing store for chunked values: path -> document body. `setDoc` fills
 * it for every write so `getDoc` can serve the part documents the engine
 * reassembles, which is the only read path the engine has.
 */
export function getDoc(docRef) {
  const state = firestoreFakes();
  const stored = state.docs.get(docRef.path);
  return Promise.resolve({
    exists: () => stored !== undefined,
    data: () => stored
  });
}

export function setDoc(docRef, payload, options) {
  const state = firestoreFakes();
  const call = { path: docRef.path, payload, options };
  state.setDocCalls.push(call);
  // `{ merge: true }` MERGES, top level, the way Firestore does. It used to
  // replace, which is the opposite: a caller writing one field to keep the
  // rest (account deletion anonymising its own name on a record two people
  // share) looked like it had wiped the document, and a test could not tell
  // the two apart. Nested merge is deliberately not modelled - nothing in
  // this repo relies on it, and a half-right merge would be worse than none.
  if (options && options.merge && state.docs.has(docRef.path)) {
    state.docs.set(docRef.path, { ...state.docs.get(docRef.path), ...payload });
  } else {
    state.docs.set(docRef.path, payload);
  }
  const responder = state.setDocResponders.shift();
  return responder ? responder(call) : Promise.resolve();
}

export function deleteDoc(docRef) {
  const state = firestoreFakes();
  state.deleteDocCalls.push(docRef.path);
  state.docs.delete(docRef.path);
  return Promise.resolve();
}

export function collection(_db, name) {
  return { __kind: 'collection', name };
}

/**
 * A collection-group query matches every collection with this NAME at any
 * depth: `collectionGroup(db, 'scores')` finds
 * globeDropDailyLeaderboard/2026-09-07/scores/<uid> as well as any other
 * `scores` collection. Account deletion uses it to find a user's daily
 * scores, whose date documents cannot be listed.
 */
export function collectionGroup(_db, name) {
  return { __kind: 'collectionGroup', name };
}

/** Every stored document directly under a collection path. */
function docsUnder(prefix) {
  const state = firestoreFakes();
  const out = [];
  for (const [path, data] of state.docs) {
    if (!path.startsWith(prefix + '/')) continue;
    if (path.slice(prefix.length + 1).includes('/')) continue;
    out.push({ ref: { __kind: 'doc', path }, data: () => data, exists: () => true });
  }
  return out;
}

/** Every document whose PARENT collection segment is `name`, at any depth. */
function docsInGroup(name) {
  const state = firestoreFakes();
  const out = [];
  for (const [path, data] of state.docs) {
    const parts = path.split('/');
    if (parts.length < 2 || parts[parts.length - 2] !== name) continue;
    out.push({ ref: { __kind: 'doc', path }, data: () => data, exists: () => true });
  }
  return out;
}

/**
 * `where` clauses are RECORDED and applied, not discarded.
 *
 * They used to be dropped, so `getDocs(query(collection(...), where('uid',
 * '==', me)))` returned every document in the collection and a test could not
 * tell "deleted only mine" from "deleted everyone's" - which is exactly the
 * distinction account deletion has to get right.
 */
export function query(base, ...clauses) {
  return { __kind: 'query', base, clauses: clauses.filter((c) => c && c.__kind === 'where') };
}

export function where(field, op, value) {
  return { __kind: 'where', field, op, value };
}

function matches(data, clause) {
  const actual = data ? data[clause.field] : undefined;
  if (clause.op === '==') return actual === clause.value;
  if (clause.op === 'array-contains') return Array.isArray(actual) && actual.includes(clause.value);
  return true;
}

export function getDocs(base) {
  const source = base && base.__kind === 'query' ? base.base : base;
  const clauses = base && base.__kind === 'query' ? base.clauses : [];
  let docs = [];
  if (source && source.__kind === 'collection') docs = docsUnder(source.name);
  else if (source && source.__kind === 'collectionGroup') docs = docsInGroup(source.name);
  for (const clause of clauses) docs = docs.filter((d) => matches(d.data(), clause));
  return Promise.resolve({ docs });
}
