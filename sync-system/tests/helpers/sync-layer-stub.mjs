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

export function startStorageSync() { return { stop() {} }; }
export function stopAllSyncs() { fakes().calls.push('stopAllSyncs'); }
export function getSyncStatus() { return null; }
export function getGlobalSyncStatus() { return {}; }

export function eraseCloudData(namespace) { return record('eraseCloudData', namespace); }
export function eraseAccountProfile() { return record('eraseAccountProfile'); }
export function eraseRivalNetworkIdentity() { return record('eraseRivalNetworkIdentity'); }
