// Module-resolution hook that lets `node --test` execute the real
// account-deletion orchestrator in sync-system/app-sync-init.js.
//
// That module imports the sync layer (which imports Firestore from an https://
// URL) and the Firebase Auth SDK (also https://), neither of which Node can
// load. Redirecting both specifiers to local stubs means the shipped control
// flow runs for real and every cloud call is recorded instead of reaching
// Firebase. Nothing here deletes anything.

let stubs = null;

export async function initialize(data) {
  stubs = data;
}

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('storage-sync-robust.js')) {
    return { url: stubs.syncLayerUrl, shortCircuit: true };
  }
  if (specifier.includes('firebasejs') && specifier.includes('firebase-auth')) {
    return { url: stubs.firebaseAuthUrl, shortCircuit: true };
  }
  return next(specifier, context);
}

// sync-system ships browser ES modules with a .js extension (they are loaded
// as <script type="module">), and the repo root has no "type": "module", so
// Node would otherwise parse app-sync-init.js as CommonJS and fail on its
// import statements. Tell the loader what the browser already knows instead of
// adding a package.json marker just to satisfy the test runner.
export async function load(url, context, next) {
  if (url.endsWith('sync-system/app-sync-init.js')) {
    return next(url, { ...context, format: 'module' });
  }
  return next(url, context);
}
