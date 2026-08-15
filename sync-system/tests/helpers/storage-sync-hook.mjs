// Module-resolution hook that lets `node --test` execute the REAL
// sync-system/storage-sync-robust.js.
//
// The engine imports the Firestore and Realtime Database SDKs from
// https://www.gstatic.com/... URLs and the site's firebase-config.js (which
// itself imports those SDK URLs and touches window at load time). None of
// that loads under Node, so the three specifiers are redirected to local
// in-memory stubs. Everything else - sync-helpers.mjs, cross-tab-channel.mjs
// and the engine itself - runs unmodified, so the tests exercise the shipped
// control flow, not a re-implementation.

let stubs = null;

export async function initialize(data) {
  stubs = data;
}

export async function resolve(specifier, context, next) {
  if (specifier.includes('firebase-firestore.js')) {
    return { url: stubs.firestoreUrl, shortCircuit: true };
  }
  if (specifier.includes('firebase-database.js')) {
    return { url: stubs.databaseUrl, shortCircuit: true };
  }
  if (specifier.endsWith('firebase-config.js')) {
    return { url: stubs.firebaseConfigUrl, shortCircuit: true };
  }
  return next(specifier, context);
}

// storage-sync-robust.js ships as a browser ES module with a .js extension
// and the repo root has no "type": "module", so Node would parse it as
// CommonJS and fail on its import statements. Tell the loader what the
// browser already knows.
export async function load(url, context, next) {
  if (url.endsWith('sync-system/storage-sync-robust.js')) {
    return next(url, { ...context, format: 'module' });
  }
  return next(url, context);
}
