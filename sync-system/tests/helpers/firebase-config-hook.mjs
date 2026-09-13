// Module-resolution hook that lets `node --test` evaluate the REAL
// firebase-config.js from the repo root.
//
// Every https://www.gstatic.com/firebasejs/... import is redirected to one
// local stub (helpers/firebase-sdk-stub.mjs). The two local modules it
// imports (cross-tab-channel.mjs, firebase-emulator-flag.mjs) load for real.

let stubs = null;

export async function initialize(data) {
  stubs = data;
}

export async function resolve(specifier, context, next) {
  if (specifier.includes('gstatic.com/firebasejs/')) {
    return { url: stubs.sdkUrl, shortCircuit: true };
  }
  return next(specifier, context);
}

// firebase-config.js is a browser ES module with a .js extension and the repo
// root has no "type": "module", so Node would parse it as CommonJS.
export async function load(url, context, next) {
  if (url.endsWith('/firebase-config.js')) {
    return next(url, { ...context, format: 'module' });
  }
  return next(url, context);
}
