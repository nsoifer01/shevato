// Stands in for sync-system/storage-sync-robust.js under `node --test`.
//
// Records every call on globalThis.__deletionFakes so the test can assert
// which namespaces deletion attempted, in what order, and can make any single
// target fail without touching real data.

function fakes() {
  return (globalThis.__deletionFakes ||= { calls: [], failures: {} });
}

function record(name, arg) {
  const state = fakes();
  state.calls.push(arg === undefined ? name : `${name}:${arg}`);
  const key = arg === undefined ? name : arg;
  if (state.failures[key]) {
    return Promise.reject(new Error(state.failures[key]));
  }
  return Promise.resolve();
}

export function startStorageSync(config) {
  fakes().calls.push(`startStorageSync:${config && config.namespace}`);
  return { stop() {} };
}
export function stopSync(namespace) { fakes().calls.push(`stopSync:${namespace}`); }
export function stopAllSyncs() { fakes().calls.push('stopAllSyncs'); }
export function getSyncStatus() { return null; }
export function getGlobalSyncStatus() { return {}; }

export function eraseCloudData(namespace) { return record('eraseCloudData', namespace); }
export function eraseAccountProfile() { return record('eraseAccountProfile'); }
export function eraseRivalNetworkIdentity() { return record('eraseRivalNetworkIdentity'); }
export function eraseArenaIdentity() { return record('eraseArenaIdentity'); }

// The account boundary (2026-09-12 audit S-5). The latch is modelled as one
// value on the fakes so a test can see what deletion set and released, and can
// hold a latch to check that initAppSync starts nothing while it is set.
export function registerLocalNamespaces(configs) { fakes().registered = configs; }
export function beginAccountDeletion(uid) {
  fakes().calls.push(`beginAccountDeletion:${uid}`);
  fakes().latched = uid;
  return 'latch-1';
}
export function endAccountDeletion(uid, id, options) {
  const deleted = !!(options && options.deleted);
  fakes().calls.push(`endAccountDeletion:${uid}:${id}:${deleted ? 'deleted' : 'cleared'}`);
  if (!deleted) fakes().latched = null;
}
export function isAccountDeletionLatched(uid) { return !!uid && fakes().latched === uid; }
export async function clearAbandonedAccountDeletion(uid) {
  fakes().calls.push(`clearAbandonedAccountDeletion:${uid}`);
  if (fakes().latchAbandoned) { fakes().latched = null; return true; }
  return false;
}
export async function settleBeforeAccountDeletion() { fakes().calls.push('settleBeforeAccountDeletion'); }
export function confirmCloudDataErased() { return record('confirmCloudDataErased').then(() => []); }
export function forgetAccountLocalState(uid) { fakes().calls.push(`forgetAccountLocalState:${uid}`); }
