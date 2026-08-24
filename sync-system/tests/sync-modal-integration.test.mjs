// Behavioral tests for sync-system/sync-modal-integration.js.
//
// The script shows the shared "Syncing..." modal and then RELOADS the page
// whenever a user signs in after the initial page load. Anonymous (guest)
// sign-ins must never trigger that: guests have no synced namespace, and the
// reload interrupted Arena's guest bootstrap mid-create (2026-08-22 audit
// D2: first-time "Create room" ended in the lobby with an orphan room doc).
// The script is executed for real via node:vm against a fake window that
// records SyncLoadingModal.show() calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(resolve(here, '..', 'sync-modal-integration.js'), 'utf8');

// Boots one fresh copy of the script. Returns the auth callback the script
// registered plus the recorded modal calls. Timers are captured and run by
// hand so the 1 s delayed init and the 10 s failsafe are deterministic.
function boot() {
  const shown = [];
  const timers = [];
  let authCallback = null;
  const session = new Map();
  const fakeWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    SyncLoadingModal: {
      show: () => shown.push('show'),
      hide: () => shown.push('hide'),
      updateMessage: (a, b) => shown.push(`msg:${a}`),
    },
    firebaseAuth: { onAuthStateChange: (cb) => { authCallback = cb; return () => {}; } },
    location: { reload: () => shown.push('reload') },
  };
  const context = vm.createContext({
    window: fakeWindow,
    document: { readyState: 'complete', addEventListener: () => {} },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k),
    },
    localStorage: { setItem() {}, getItem: () => null },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    console: { log() {}, warn() {}, error() {} },
    Date,
    parseInt,
  });
  vm.runInContext(SCRIPT, context, { filename: 'sync-modal-integration.js' });
  // delayedInitialization -> setupAuthListener after 1000 ms.
  const init = timers.find((t) => t.ms === 1000);
  assert.ok(init, 'the script schedules its delayed auth-listener setup');
  init.fn();
  assert.equal(typeof authCallback, 'function', 'auth listener registered');
  return { authCallback, shown, session, isAwaiting: () => fakeWindow.SyncModalIntegration.isAwaitingSync() };
}

test('a registered sign-in after initial load shows the sync modal (the behaviour the script exists for)', () => {
  const { authCallback, shown, isAwaiting } = boot();
  authCallback(null);                                   // initial load: signed out
  authCallback({ uid: 'real-1', isAnonymous: false });  // later: real sign-in
  assert.deepEqual(shown, ['show']);
  assert.equal(isAwaiting(), true);
});

test('an anonymous (guest) sign-in after initial load never shows the modal nor arms the reload', () => {
  // Arena's Create/Join buttons call signInAsGuest on first use: exactly the
  // "user appears after initial load" shape that used to fire the modal.
  const { authCallback, shown, session, isAwaiting } = boot();
  authCallback(null);
  authCallback({ uid: 'anon-1', isAnonymous: true });
  assert.deepEqual(shown, [], 'no modal for guests');
  assert.equal(isAwaiting(), false, 'no sync watch, so no reload can follow');
  assert.equal(session.has('lastSyncModalTime'), false, 'the dedupe key is not consumed for guests');
});

test('a guest who later upgrades to a real account still gets the modal once', () => {
  const { authCallback, shown } = boot();
  authCallback(null);
  authCallback({ uid: 'anon-1', isAnonymous: true });
  authCallback({ uid: 'real-2', isAnonymous: false });
  assert.deepEqual(shown, ['show']);
});

test('an anonymous user present at initial load is treated as initial load (no modal on the first callback)', () => {
  const { authCallback, shown } = boot();
  authCallback({ uid: 'anon-1', isAnonymous: true });
  assert.deepEqual(shown, []);
});
