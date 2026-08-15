// Smoke-level behavioral tests for sync-system/sync-immediate.js.
//
// That file is a classic (non-module) script whose whole job is the boot
// window: it overrides localStorage before any app script runs, buffers
// writes until storage-sync-robust.js signals `syncSystemReady`, replays the
// buffer, and from then on forwards every write to
// window.syncManager.processChange. If forwarding breaks, Firestore silently
// stops seeing writes and the next refresh clobbers local changes with stale
// remote state - so the handoff choreography is worth pinning.
//
// The script is executed for real via node:vm against fake window/localStorage
// globals. sync-loading-modal.js is NOT covered here: it is pure DOM work
// (createElement / innerHTML / querySelector) and needs a real document.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(resolve(here, '..', 'sync-immediate.js'), 'utf8');

// The script installs once per page (idempotency guard on window), so mirror
// that: one context for the whole file, tests run in declaration order and
// walk the same lifecycle a page would.
const store = new Map();
const forwarded = [];
const windowTarget = new EventTarget();

const fakeWindow = {
  addEventListener: (...args) => windowTarget.addEventListener(...args),
  dispatchEvent: (ev) => windowTarget.dispatchEvent(ev)
};

const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); }
};

before(() => {
  const context = vm.createContext({
    window: fakeWindow,
    localStorage: fakeLocalStorage,
    // Silent recorder: raw console output from the script under test can
    // desync the node --test IPC stream (see storage-sync-behavior.test.mjs).
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date,
    Map,
    Event,
    Error
  });
  vm.runInContext(SCRIPT, context, { filename: 'sync-immediate.js' });
});

test('installs exactly once and exposes the debug surface', () => {
  assert.equal(fakeWindow.__gymTrackerImmediateSyncInstalled, true);
  assert.equal(typeof fakeWindow.immediateDebug.getPendingChanges, 'function');
  assert.equal(fakeWindow.immediateDebug.isHandedOff(), false);
});

test('pre-handoff writes hit storage AND are buffered, not forwarded', () => {
  fakeLocalStorage.setItem('bootKey', '{"boot":true}');
  fakeLocalStorage.removeItem('staleKey');

  assert.equal(store.get('bootKey'), '{"boot":true}', 'the native write must always land');
  assert.equal(forwarded.length, 0, 'nothing forwards before the sync layer exists');

  const pending = new Map(fakeWindow.immediateDebug.getPendingChanges());
  assert.equal(pending.get('bootKey').action, 'set');
  assert.equal(pending.get('bootKey').value, '{"boot":true}');
  assert.equal(pending.get('staleKey').action, 'remove');
});

test('syncSystemReady replays the buffer into processChange and flips to forward mode', () => {
  fakeWindow.syncManager = {
    processChange: (key, value) => forwarded.push({ key, value })
  };

  fakeWindow.dispatchEvent(new Event('syncSystemReady'));

  assert.deepEqual(forwarded, [
    { key: 'bootKey', value: '{"boot":true}' },
    { key: 'staleKey', value: null }
  ], 'buffered set replays with its value, buffered remove replays as null');
  assert.equal(fakeWindow.immediateDebug.isHandedOff(), true);
  // .length, not deepEqual against []: the array is built inside the vm
  // realm, so its prototype is not this realm's Array.prototype.
  assert.equal(fakeWindow.immediateDebug.getPendingChanges().length, 0, 'buffer drains on handoff');
});

test('post-handoff writes forward immediately, removals forward as null', () => {
  forwarded.length = 0;

  fakeLocalStorage.setItem('liveKey', '"v1"');
  assert.deepEqual(forwarded, [{ key: 'liveKey', value: '"v1"' }]);
  assert.equal(store.get('liveKey'), '"v1"');

  fakeLocalStorage.removeItem('liveKey');
  assert.deepEqual(forwarded.at(-1), { key: 'liveKey', value: null });
  assert.equal(store.has('liveKey'), false);
});

test('a throwing processChange never breaks the localStorage write itself', () => {
  fakeWindow.syncManager = {
    processChange() { throw new Error('sync layer exploded'); }
  };

  fakeLocalStorage.setItem('resilientKey', '"still-written"');
  assert.equal(store.get('resilientKey'), '"still-written"',
    'the native write must survive a forwarding failure');
});

test('a second install attempt is a no-op (idempotency guard)', () => {
  // Re-running the script must not re-wrap localStorage: the wrapped setItem
  // identity stays the same, so no double-forwarding chain can build up.
  const wrappedSetItem = fakeLocalStorage.setItem;
  const context = vm.createContext({
    window: fakeWindow,
    localStorage: fakeLocalStorage,
    // Silent recorder: raw console output from the script under test can
    // desync the node --test IPC stream (see storage-sync-behavior.test.mjs).
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date,
    Map,
    Event,
    Error
  });
  vm.runInContext(SCRIPT, context, { filename: 'sync-immediate.js (second load)' });
  assert.equal(fakeLocalStorage.setItem, wrappedSetItem, 'override must not be re-wrapped');
});
