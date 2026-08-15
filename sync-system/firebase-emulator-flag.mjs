// Decision logic for the Firebase emulator seam in firebase-config.js.
//
// Kept as a dependency-free pure module so `node --test` can prove the
// seam is inert in production: connecting to the local emulators
// requires BOTH conditions, each independently sufficient to keep every
// deployed page on production Firebase:
//   1. the page is served from a loopback hostname (shevato.com, deploy
//      previews and every other real host can never qualify), AND
//   2. an explicit per-origin opt-in - localStorage[FLAG_KEY] === '1' -
//      so ordinary local development against production Firebase keeps
//      working unchanged until a developer (or a test harness) opts in.
//
// The Arena emulator e2e (apps/arena/e2e/) sets the flag before the app
// boots; nothing in production code ever writes it.

export const FIREBASE_EMULATOR_FLAG_KEY = 'shevato:firebase-emulators';

// Emulator ports. firestore/database mirror firebase.json's emulators
// block; auth is the firebase-tools default (also pinned in firebase.json).
export const FIREBASE_EMULATOR_PORTS = Object.freeze({
    firestore: 8085,
    database: 9000,
    auth: 9099,
});

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * @param {string} hostname - window.location.hostname
 * @param {string|null} flagValue - localStorage.getItem(FIREBASE_EMULATOR_FLAG_KEY)
 * @returns {boolean} true ONLY for loopback + explicit '1' opt-in
 */
export function shouldUseFirebaseEmulators(hostname, flagValue) {
    return LOOPBACK_HOSTNAMES.has(String(hostname || '').toLowerCase())
        && flagValue === '1';
}
