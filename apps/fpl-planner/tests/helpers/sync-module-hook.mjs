// A module-resolution hook that swaps the real sync layer for a stub.
//
// js/ui/settings.js reaches the cloud through a dynamic
// `import('../../../sync-system/storage-sync-robust.js')`, and that module
// imports Firebase from https:// URLs, so it cannot load under `node --test` at
// all. Redirecting the specifier is what makes the signed-in deletion path
// testable without a Firebase session: the real click handler runs, and the
// erase call it makes is recorded instead of hitting Firestore.

let stubUrl = null;

export async function initialize(data) {
  stubUrl = data.stubUrl;
}

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('sync-system/storage-sync-robust.js')) {
    return { url: stubUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
