// Module-resolution hook that lets `node --test` execute the REAL
// sync-system/storage-sync-robust.js.
//
// The engine imports the Firestore SDK from an https://www.gstatic.com/... URL
// and the site's firebase-config.js and firebase-firestore.js (which import
// SDK URLs and touch window at load time). None of that loads under Node, so
// those specifiers are redirected to local in-memory stubs. Everything else - sync-helpers.mjs, cross-tab-channel.mjs
// and the engine itself - runs unmodified, so the tests exercise the shipped
// control flow, not a re-implementation.

let stubs = null;

export async function initialize(data) {
  stubs = data;
}

export async function resolve(specifier, context, next) {
  if (specifier.includes('gstatic.com/firebasejs/') && specifier.includes('firebase-firestore.js')) {
    return { url: stubs.firestoreUrl, shortCircuit: true };
  }
  // The site's firebase-config.js and firebase-firestore.js share one stub:
  // the engine takes `auth` from the first and `db` from the second.
  if (specifier.endsWith('firebase-config.js') || specifier.endsWith('/firebase-firestore.js')) {
    return { url: stubs.firebaseConfigUrl, shortCircuit: true };
  }
  return next(specifier, context);
}

// storage-sync-robust.js ships as a browser ES module with a .js extension
// and the repo root has no "type": "module", so Node would parse it as
// CommonJS and fail on its import statements. Tell the loader what the
// browser already knows.
//
// The URL may carry a query string: a test that needs two engine instances (two
// tabs sharing one localStorage and one Firestore) imports the module twice as
// `storage-sync-robust.js?tab=1` and `?tab=2`, which Node treats as two modules.
export async function load(url, context, next) {
  if (new URL(url).pathname.endsWith('sync-system/storage-sync-robust.js')) {
    return next(url, { ...context, format: 'module' });
  }
  return next(url, context);
}
