// Site-wide account deletion, executed rather than described.
//
// deleteAccount() is a destructive control, so the properties that matter are
// the ones that stop it doing damage or lying about what it did:
//
//   1. It walks APP_SYNC_CONFIG. A second hardcoded namespace list would drift
//      the next time an app is added, and the missed app's data would survive
//      an account deletion forever, so the list is derived from the config in
//      source and compared with what deletion actually attempts.
//   2. Partial failure is reported by name and never dressed up as success,
//      and it stops short of deleting the credential, because an account that
//      cannot sign in again can never retry.
//   3. The typed confirmation gate lives in the module, not only in the UI, so
//      it cannot be skipped by calling the function directly.
//
// The real module runs here. Firestore and the Firebase Auth SDK are swapped
// for recording stubs at the module boundary (helpers/account-deletion-hook),
// so nothing in this file can reach real data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');

register('./helpers/account-deletion-hook.mjs', import.meta.url, {
  data: {
    syncLayerUrl: pathToFileURL(join(here, 'helpers', 'sync-layer-stub.mjs')).href,
    firebaseAuthUrl: pathToFileURL(join(here, 'helpers', 'firebase-auth-stub.mjs')).href
  }
});

// app-sync-init.js wires itself to the page on load. Give it the minimum DOM
// it needs before importing, and an auth adapter that resolves immediately so
// it does not leave a retry timer running for the length of the test run.
globalThis.document = { readyState: 'complete', addEventListener() {} };
globalThis.window = {
  firebaseAuth: {
    isAvailable: () => true,
    onAuthStateChange() { return () => {}; },
    getCurrentUser: () => globalThis.__currentUser || null
  }
};

const {
  deleteAccount,
  getSyncNamespaces,
  getSyncedLocalKeys,
  isDeletionConfirmed,
  DELETE_CONFIRMATION_WORD
} = await import('../app-sync-init.js');

const APP_SYNC_INIT_SRC = readFileSync(join(REPO_ROOT, 'sync-system/app-sync-init.js'), 'utf8');

const USER = Object.freeze({ uid: 'uid-1', email: 'someone@example.com', isAnonymous: false });

// A device with data from two apps plus a key that no app syncs.
const SEED = Object.freeze({
  gymTrackerPrograms: '[{"id":"p1"}]',
  fplPlannerTeamId: '4231987',
  theme: 'dark',
  'trip-planner:geo:v2': '{"cached":"not synced"}'
});

function setup({ reauthError = null, deleteUserError = null, failures = {} } = {}) {
  const store = new Map(Object.entries(SEED));
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  globalThis.__currentUser = USER;
  globalThis.__deletionFakes = { calls: [], failures, reauthError, deleteUserError };
  return {
    store,
    calls: () => globalThis.__deletionFakes.calls,
    erased: () => globalThis.__deletionFakes.calls
      .filter(c => c.startsWith('eraseCloudData:'))
      .map(c => c.slice('eraseCloudData:'.length))
  };
}

/* -------------------- 1. one namespace list, no drift -------------------- */

test('getSyncNamespaces is exactly the namespaces declared in APP_SYNC_CONFIG', () => {
  // Read the namespaces straight out of the source text. If someone adds an
  // app to the config, this expectation grows automatically and the runtime
  // list has to grow with it.
  const declared = [...APP_SYNC_INIT_SRC.matchAll(/namespace:\s*'([^']+)'/g)].map(m => m[1]);

  assert.ok(declared.length >= 8, `expected the config to declare the app namespaces, found ${declared.length}`);
  assert.deepEqual(
    getSyncNamespaces().slice().sort(),
    declared.slice().sort(),
    'getSyncNamespaces() must be derived from APP_SYNC_CONFIG, not a second list'
  );
});

test('deletion attempts every namespace the config declares, plus the account root and rival network', async () => {
  const h = setup();

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(h.erased().slice().sort(), getSyncNamespaces().slice().sort());
  // The root users/{uid} document is not a namespace: Arena keeps its trivia
  // profile in fields on it, and Firestore deletes are not recursive.
  assert.ok(h.calls().includes('eraseAccountProfile'));
  assert.ok(h.calls().includes('eraseRivalNetworkIdentity'));
});

test('every app in APP_SYNC_CONFIG has its namespace deleted, so a new app cannot be missed', async () => {
  const h = setup();
  await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  const erased = new Set(h.erased());
  for (const namespace of getSyncNamespaces()) {
    assert.ok(erased.has(namespace), `namespace ${namespace} was never deleted`);
  }
});

test('live sync listeners are stopped before any document is deleted', async () => {
  // An attached onSnapshot reads a vanishing document as "the cloud is empty"
  // and re-uploads the local keys, which would silently undo the deletion.
  const h = setup();
  await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  const calls = h.calls();
  assert.ok(calls.indexOf('stopAllSyncs') > -1, 'syncs were never stopped');
  assert.ok(
    calls.indexOf('stopAllSyncs') < calls.findIndex(c => c.startsWith('eraseCloudData:')),
    'syncs must stop before the first delete'
  );
});

/* -------------------- 2. honest partial failure -------------------- */

test('one failed namespace names the failure and does not claim success', async () => {
  const h = setup({ failures: { gymTrackerApp: 'permission-denied' } });

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'data-delete-failed');
  assert.deepEqual(result.failed.map(f => f.target), ['gymTrackerApp']);
  assert.match(result.message, /gymTrackerApp/, 'the message must name what failed');
});

test('a failed namespace does not stop the others being attempted', async () => {
  const h = setup({ failures: { gymTrackerApp: 'permission-denied' } });

  await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.deepEqual(h.erased().slice().sort(), getSyncNamespaces().slice().sort());
});

test('a failed namespace leaves the account signed-in-able, so the user can retry', async () => {
  const h = setup({ failures: { risingSeasonsApp: 'unavailable' } });

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.equal(result.ok, false);
  assert.ok(
    !h.calls().some(c => c.startsWith('deleteUser:')),
    'the credential must survive a partial data delete, otherwise the leftovers are unreachable forever'
  );
  assert.equal(result.clearedKeys, undefined, 'local data must not be cleared on a partial failure');
});

test('a failed rival-network delete is reported by name too', async () => {
  const h = setup({ failures: { eraseRivalNetworkIdentity: 'permission-denied' } });

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map(f => f.target), ['rival network entry']);
  assert.match(result.message, /rival network entry/);
});

/* -------------------- 3. the confirmation gate -------------------- */

for (const typed of [undefined, null, '', 'delete', 'Delete', 'DELETE ME', 'yes', 'D E L E T E']) {
  test(`confirmation ${JSON.stringify(typed)} is rejected and deletes nothing`, async () => {
    const h = setup();

    const result = await deleteAccount({ confirmation: typed, password: 'pw' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-confirmed');
    assert.deepEqual(h.calls(), [], 'nothing may be called before the gate passes');
    assert.equal(h.store.get('gymTrackerPrograms'), '[{"id":"p1"}]');
  });
}

test('the exact word passes, and surrounding whitespace is tolerated', () => {
  assert.equal(isDeletionConfirmed(DELETE_CONFIRMATION_WORD), true);
  assert.equal(isDeletionConfirmed('  DELETE  '), true);
  assert.equal(isDeletionConfirmed('delete'), false);
});

test('the gate is enforced in the module, not only in the UI', async () => {
  // Calling the exported function directly, exactly as a console user would,
  // must still be refused.
  const h = setup();
  const result = await deleteAccount({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-confirmed');
  assert.deepEqual(h.calls(), []);
});

test('a missing password is refused before anything is deleted', async () => {
  const h = setup();

  const result = await deleteAccount({ confirmation: 'DELETE', password: '' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'password-required');
  assert.deepEqual(h.calls(), []);
});

test('signed out and guest sessions are refused', async () => {
  setup();
  globalThis.__currentUser = null;
  const signedOut = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });
  assert.equal(signedOut.reason, 'not-signed-in');

  setup();
  globalThis.__currentUser = { uid: 'anon', email: null, isAnonymous: true };
  const guest = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });
  assert.equal(guest.reason, 'guest-account');
  assert.deepEqual(globalThis.__deletionFakes.calls, []);
});

/* -------------------- 4. reauthentication -------------------- */

test('the password is proven before any data is deleted', async () => {
  const h = setup();
  await deleteAccount({ confirmation: 'DELETE', password: 'hunter2' });

  const calls = h.calls();
  const reauthIdx = calls.findIndex(c => c.startsWith('reauthenticate:'));
  assert.ok(reauthIdx > -1, 'reauthentication never happened');
  assert.equal(calls[reauthIdx], 'reauthenticate:someone@example.com:hunter2');
  assert.ok(
    reauthIdx < calls.findIndex(c => c.startsWith('eraseCloudData:')),
    'reauthentication must precede the first delete'
  );
});

test('a wrong password deletes nothing and says so in plain words', async () => {
  const h = setup({ reauthError: 'auth/wrong-password' });

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'nope' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reauth-failed');
  assert.match(result.message, /password is not correct/i);
  assert.doesNotMatch(result.message, /auth\//, 'raw Firebase error codes must not reach the user');
  assert.ok(!h.calls().some(c => c.startsWith('eraseCloudData:')));
});

test('requires-recent-login is explained rather than shown as a code', async () => {
  // Reauthenticating up front means deleteUser() should never see this, but
  // if it ever does the user gets an instruction, not auth/requires-recent-login.
  const h = setup({ deleteUserError: 'auth/requires-recent-login' });

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'auth-delete-failed');
  assert.match(result.message, /sign out, sign back in/i);
  assert.doesNotMatch(result.message, /auth\/requires-recent-login/);
  assert.match(result.message, /already been deleted/i, 'must admit the data is gone');
});

/* -------------------- 5. local data -------------------- */

test('a successful deletion clears synced keys on this device and leaves unsynced ones', async () => {
  const h = setup();

  const result = await deleteAccount({ confirmation: 'DELETE', password: 'pw' });

  assert.equal(result.ok, true);
  assert.equal(h.store.get('gymTrackerPrograms'), undefined);
  assert.equal(h.store.get('fplPlannerTeamId'), undefined);
  assert.equal(h.store.get('theme'), undefined);
  assert.deepEqual(result.clearedKeys.slice().sort(), ['fplPlannerTeamId', 'gymTrackerPrograms', 'theme']);
  // Device-local caches are not part of the account and are not in the config.
  assert.equal(h.store.get('trip-planner:geo:v2'), '{"cached":"not synced"}');
});

test('the synced-key list is derived from the same config as the namespaces', () => {
  const keys = getSyncedLocalKeys();
  for (const key of ['gymTrackerPrograms', 'fplPlannerTeamId', 'marioKartRaces', 'theme']) {
    assert.ok(keys.includes(key), `expected ${key} in the synced key list`);
  }
  assert.equal(new Set(keys).size, keys.length, 'the key list must not contain duplicates');
});

/* -------------------- 6. structural invariants -------------------- */

test('the rival-network collection names match the ones MapTap Rivals writes', () => {
  // These three collections sit outside users/{uid}, so deletion addresses
  // them by name. If the app renames one, this fails instead of silently
  // stranding a deleted user's published profile.
  const syncSrc = readFileSync(join(REPO_ROOT, 'sync-system/storage-sync-robust.js'), 'utf8');
  const appSrc = readFileSync(join(REPO_ROOT, 'apps/maptap-rivals/js/app.js'), 'utf8');

  for (const constant of ['NET_HANDLES', 'NET_PROFILES', 'NET_LINKS']) {
    const declared = appSrc.match(new RegExp(`const ${constant} = '([^']+)'`));
    assert.ok(declared, `could not find ${constant} in maptap-rivals/js/app.js`);
    assert.match(
      syncSrc,
      new RegExp(`'${declared[1]}'`),
      `storage-sync-robust must delete ${declared[1]}`
    );
  }
});

test('every Firebase SDK import in the project is pinned to one version', () => {
  // Account deletion added a firebase-auth import outside firebase-config.js.
  // Two versions loaded at once is what produced the racing-auth-iframe crash
  // the config file documents, so pin the whole set together.
  const files = [
    'firebase-config.js',
    'sync-system/storage-sync-robust.js',
    'sync-system/app-sync-init.js'
  ];
  const versions = new Set();
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of src.matchAll(/firebasejs\/([0-9.]+)\//g)) versions.add(m[1]);
  }
  assert.equal(versions.size, 1, `expected a single Firebase version, found: ${[...versions].join(', ')}`);
});
