// Tests for sync-system/tab-sync.js, the cross-tab coherence helper added by
// the 2026-08-22 site-wide audit remediation.
//
// The helper is a classic script that installs itself on `window`, so these
// tests evaluate the real source in a tiny fake DOM rather than importing it.
// That keeps them honest: they exercise the shipped file, not a copy of its
// logic.
//
// The behaviour under test is a data-integrity guarantee, not a convenience:
// four apps (football-h2h, mario-kart, trip-planner, gym-tracker) lost user
// data to two open tabs before this existed, and Trip Planner's "You can undo
// this" promise was broken specifically by a WRITE made from inside a storage
// handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'tab-sync.js'), 'utf8');

/**
 * A minimal window/localStorage pair shaped like the browser's: real methods
 * live on a prototype, so an "own property" override (which is what
 * storage-sync-robust.js installs) shadows them exactly as it does in Chrome.
 */
function makeEnv() {
  const store = new Map();
  const listeners = [];
  const errors = [];
  const proto = {
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
  };
  const localStorage = Object.create(proto);
  const window = {
    localStorage,
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const console = { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} };
  const install = () => new Function('window', 'localStorage', 'console', SRC)(window, localStorage, console);
  const fire = (key, newValue) => {
    for (const fn of listeners) fn({ key, newValue, oldValue: null, storageArea: localStorage });
  };
  // What storage-sync-robust.js does when cloud sync starts: capture the
  // current method and install an OWN property that calls it.
  const installSyncOverride = () => {
    const orig = localStorage.setItem.bind(localStorage);
    const notified = [];
    localStorage.setItem = (k, v) => { orig(k, v); notified.push(k); };
    return notified;
  };
  return { store, errors, window, localStorage, install, fire, installSyncOverride };
}

test('a foreign change reaches the watcher for a watched key only', () => {
  const env = makeEnv();
  env.install();
  const seen = [];
  env.window.ShevatoTabSync.watch(['mine'], (change) => seen.push(change.key));
  env.fire('mine', 'a');
  env.fire('someone-elses', 'b');
  assert.deepEqual(seen, ['mine']);
});

test('localStorage.clear() in another tab notifies every watched key', () => {
  const env = makeEnv();
  env.install();
  const seen = [];
  env.window.ShevatoTabSync.watch(['a', 'b'], (c) => seen.push(c.key));
  env.fire(null, null);
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('a write attempted from inside a handler is refused, and reported', () => {
  const env = makeEnv();
  env.install();
  env.store.set('k', 'from-the-other-tab');
  env.window.ShevatoTabSync.watch(['k'], () => {
    env.localStorage.setItem('k', 'FLOOR-WRITE');
    env.localStorage.removeItem('k');
  });
  env.fire('k', 'from-the-other-tab');
  assert.equal(env.store.get('k'), 'from-the-other-tab', 'the other tab\'s value survived');
  assert.equal(env.errors.length, 2, 'both the set and the remove were reported');
  assert.match(env.errors[0], /refused localStorage\.setItem/);
});

test('ordinary writes still work before and after a handler runs', () => {
  const env = makeEnv();
  env.install();
  env.window.ShevatoTabSync.watch(['k'], () => {});
  env.localStorage.setItem('k', 'before');
  assert.equal(env.store.get('k'), 'before');
  env.fire('k', 'foreign');
  env.localStorage.setItem('k', 'after');
  assert.equal(env.store.get('k'), 'after');
});

// The ordering matters in production: tab-sync installs at app init, the sync
// engine installs its own override on sign-in, which is later. But a page that
// signs in before an app calls watch() would flip the order, and an own
// property shadows the prototype patch. Both orders must hold.
for (const order of ['tab-sync installs first', 'the sync engine installs first']) {
  test(`the guard holds when ${order}`, () => {
    const env = makeEnv();
    let notified;
    if (order === 'tab-sync installs first') {
      env.install();
      env.window.ShevatoTabSync.watch(['k'], () => env.localStorage.setItem('k', 'LEAK'));
      notified = env.installSyncOverride();
    } else {
      notified = env.installSyncOverride();
      env.install();
      env.window.ShevatoTabSync.watch(['k'], () => env.localStorage.setItem('k', 'LEAK'));
    }
    env.store.set('k', 'from-the-other-tab');
    env.fire('k', 'from-the-other-tab');
    assert.equal(env.store.get('k'), 'from-the-other-tab', 'the handler write was blocked');

    // and the sync engine still sees ordinary writes, so guarding it did not
    // break cloud sync's change notification
    env.localStorage.setItem('k', 'normal');
    assert.equal(env.store.get('k'), 'normal');
    assert.ok(notified.includes('k'), 'the sync override still ran for a normal write');
  });
}

test('readBeforeWrite merges against what storage holds now, not a stale copy', () => {
  const env = makeEnv();
  env.install();
  env.store.set('list', JSON.stringify([1, 2]));
  // Another tab appended 3 while we held [1,2].
  env.store.set('list', JSON.stringify([1, 2, 3]));
  const out = env.window.ShevatoTabSync.readBeforeWrite('list', (current) => [...current, 4]);
  assert.deepEqual(out, [1, 2, 3, 4]);
  assert.deepEqual(JSON.parse(env.store.get('list')), [1, 2, 3, 4]);
});

test('readBeforeWrite treats unreadable JSON as absent rather than throwing', () => {
  const env = makeEnv();
  env.install();
  env.store.set('list', '{not json');
  const out = env.window.ShevatoTabSync.readBeforeWrite('list', (current) => {
    assert.equal(current, null);
    return ['fresh'];
  });
  assert.deepEqual(out, ['fresh']);
});

test('a throwing handler is contained and does not stop the other watchers', () => {
  const env = makeEnv();
  env.install();
  const seen = [];
  env.window.ShevatoTabSync.watch(['k'], () => { throw new Error('boom'); });
  env.window.ShevatoTabSync.watch(['k'], () => seen.push('second ran'));
  env.fire('k', 'v');
  assert.deepEqual(seen, ['second ran']);
  assert.ok(env.errors.some((e) => /handler failed/.test(e)));
  // and the guard is not left armed by the throw
  env.localStorage.setItem('k', 'after-throw');
  assert.equal(env.store.get('k'), 'after-throw');
});

test('unwatch stops delivery', () => {
  const env = makeEnv();
  env.install();
  const seen = [];
  const off = env.window.ShevatoTabSync.watch(['k'], () => seen.push(1));
  env.fire('k', 'a');
  off();
  env.fire('k', 'b');
  assert.equal(seen.length, 1);
});
