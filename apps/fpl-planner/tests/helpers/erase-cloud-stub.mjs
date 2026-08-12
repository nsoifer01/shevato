// Stands in for sync-system/storage-sync-robust.js under `node --test`.
//
// Loaded on the main thread by sync-module-hook.mjs, so the test reads the call
// log straight off globalThis.

export async function eraseCloudData(namespace) {
  const calls = (globalThis.__fplEraseCloudCalls ||= []);
  calls.push(namespace);
  if (globalThis.__fplEraseCloudFailure) throw new Error(globalThis.__fplEraseCloudFailure);
}
