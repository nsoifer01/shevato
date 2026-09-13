// Sign-out hands pending sync writes over BEFORE auth goes away
// (2026-09-12 audit S-3).
//
// The sync engine debounces writes by 500 ms. An edit made in that window and
// followed by a click on "Sign out" used to be stranded: auth.signOut() ran
// first, the auth-state listener stopped every sync, and a flush attempted
// after that point is rejected because the request no longer carries the
// user's credentials. So the adapter in firebase-config.js now asks the
// engine to flush (window.__shevatoFlushSync, registered by
// storage-sync-robust.js) and waits for it, with a short upper bound so a slow
// or offline network can never hold a sign-out hostage. Once setDoc has been
// called, Firestore's persistent cache owns the write even if the wait times
// out.
//
// This runs the real firebase-config.js with every Firebase SDK URL swapped
// for helpers/firebase-sdk-stub.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

register('./helpers/firebase-config-hook.mjs', import.meta.url, {
  data: { sdkUrl: pathToFileURL(join(here, 'helpers', 'firebase-sdk-stub.mjs')).href }
});

for (const level of ['log', 'warn', 'error']) console[level] = () => {};

if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail ?? null;
    }
  };
}

const windowTarget = new EventTarget();
globalThis.window = {
  addEventListener: (...args) => windowTarget.addEventListener(...args),
  removeEventListener: (...args) => windowTarget.removeEventListener(...args),
  dispatchEvent: (ev) => windowTarget.dispatchEvent(ev),
  location: { hostname: 'shevato.com' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  __shevatoSyncChannel: { tabId: 'signout-tab', isLive: false, publish() {}, subscribe: () => () => {}, close() {} }
};

const { sdkFakes } = await import('./helpers/firebase-sdk-stub.mjs');
await import('../../firebase-config.js');

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function reset() {
  sdkFakes().calls.length = 0;
  delete globalThis.window.__shevatoFlushSync;
}

test('sign-out waits for the pending sync flush before calling auth.signOut', async () => {
  reset();
  let finish;
  globalThis.window.__shevatoFlushSync = () => {
    sdkFakes().calls.push('flush');
    return new Promise((resolve) => { finish = resolve; });
  };

  const done = globalThis.window.firebaseAuth.signOut();
  await settle();
  assert.deepEqual(sdkFakes().calls, ['flush'],
    'the flush starts first, and auth is still signed in while it runs');

  finish();
  await done;
  assert.deepEqual(sdkFakes().calls, ['flush', 'signOut'], 'then, and only then, sign out');
});

test('a flush that never answers cannot hold sign-out hostage', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.window.__shevatoFlushSync = () => {
    sdkFakes().calls.push('flush');
    return new Promise(() => {});      // offline: the write sits in the SDK cache
  };

  const done = globalThis.window.firebaseAuth.signOut();
  await settle();
  assert.deepEqual(sdkFakes().calls, ['flush']);

  t.mock.timers.tick(2000);
  await done;
  assert.deepEqual(sdkFakes().calls, ['flush', 'signOut'], 'the bounded wait expires and sign-out proceeds');
});

test('a flush that throws still signs out', async () => {
  reset();
  globalThis.window.__shevatoFlushSync = () => { throw new Error('engine broke'); };
  await globalThis.window.firebaseAuth.signOut();
  assert.deepEqual(sdkFakes().calls, ['signOut']);
});

test('a page without the sync engine signs out exactly as before', async () => {
  reset();
  await globalThis.window.firebaseAuth.signOut();
  assert.deepEqual(sdkFakes().calls, ['signOut']);
});
