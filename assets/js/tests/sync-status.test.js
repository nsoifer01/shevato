'use strict';

// The sync widget must never say "Synced" over a write that did not sync.
//
// The engine has always reported both of these. `syncWriteRejected` fires when
// a flush is refused in a way retrying cannot fix (payload too large, an
// invalid document); `appSyncFailed` fires when sync could not start at all.
// Both were dispatched into an empty room: a repo-wide grep found zero
// listeners, so the pill went on reading "Synced" while the user's changes sat
// in localStorage with no path to Firestore. These tests pin the listeners and,
// more importantly, the precedence rules around them.
//
// sync-status.js is an IIFE that wires itself up on load, so it is loaded into
// a fresh vm context per test with a stubbed window/document, the same shape
// analytics.test.js uses for the same reason.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sync-status.js'), 'utf8');

function fakeEl(tag) {
  return {
    tagName: tag,
    hidden: true,
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    children: [],
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    getBoundingClientRect() { return { bottom: 0 }; },
  };
}

/**
 * Load sync-status.js against a stubbed page.
 * @param {object} opts
 * @param {object|null} opts.status  what gymGetGlobalSyncStatus returns
 * @param {boolean} [opts.signedIn]
 * @returns {{pill: object, banner: object, fire: Function, tick: Function}}
 */
function load(opts) {
  const listeners = {};
  const timers = [];
  const pill = fakeEl('div');
  const banner = fakeEl('div');
  const slot = fakeEl('div');

  const sandbox = {
    console, Date, JSON, Math, Object, Array, String, Number, Boolean,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: () => {},
    document: {
      readyState: 'complete',
      addEventListener(type, fn) { listeners['doc:' + type] = fn; },
      getElementById: (id) => (id === 'sync-banner' ? banner : null),
      querySelectorAll: () => [slot],
      createElement: (tag) => fakeEl(tag),
    },
  };
  // `state` is mutable so a test can drive a recovery or a disconnection the
  // way the real page does: the widget re-reads both on every render.
  const state = { status: opts.status, onLine: true };
  sandbox.window = {
    addEventListener(type, fn) { listeners[type] = fn; },
    navigator: { get onLine() { return state.onLine; } },
    gymGetGlobalSyncStatus: () => state.status,
    firebaseAuth: { getCurrentUser: () => (opts.signedIn ? { uid: 'u1' } : null) },
  };
  sandbox.navigator = sandbox.window.navigator;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sync-status.js' });

  // The pill the widget built is the one it appended into our slot.
  const built = slot.children[0];
  return {
    pill: built,
    banner,
    fire: (type, detail) => listeners[type] && listeners[type]({ detail }),
    tick: () => timers.forEach(fn => fn()),
    setStatus: (next) => { state.status = next; },
    setOnline: (v) => { state.onLine = v; },
  };
}

const HEALTHY = { totalQueueSize: 0, activeNamespaces: 2 };

// ---------- the baseline the bug hid behind ----------

test('a healthy signed-in session still reads Synced', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  assert.equal(w.pill.dataset.state, 'synced');
  assert.equal(w.pill.textContent, 'Synced');
});

// ---------- a permanently rejected write ----------

test('a rejected write stops the pill claiming Synced', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'gymTracker', keys: ['gymTrackerSessions'], code: 'payload-too-large' });
  assert.equal(w.pill.dataset.state, 'failed');
  assert.notEqual(w.pill.textContent, 'Synced');
});

test('the rejected-write banner names the app and says the data is safe locally', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'maptapRivals', keys: ['maptapRivalsGames'], code: 'invalid-argument' });
  assert.equal(w.banner.hidden, false);
  assert.equal(w.banner.dataset.state, 'failed');
  const text = w.banner.children.map(c => c.textContent).join(' ');
  assert.match(text, /maptapRivals/, 'the message names which app is affected');
  assert.match(text, /safe on this device/i);
});

test('a rejected write survives the poll, because it can never resolve itself', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'gymTracker', keys: ['k'], code: 'payload-too-large' });
  w.tick();
  w.tick();
  assert.equal(w.pill.dataset.state, 'failed', 'still failed after two poll ticks');
  assert.equal(w.banner.hidden, false, 'and the banner is still up');
});

// ---------- sync that never started ----------

test('a failed init reads as unavailable, not Synced', () => {
  const w = load({ status: { totalQueueSize: 0, activeNamespaces: 0 }, signedIn: true });
  w.fire('appSyncFailed', { message: 'firestore unreachable' });
  assert.equal(w.pill.dataset.state, 'failed');
  assert.equal(w.pill.textContent, 'Sync unavailable');
});

test('a failed init clears itself once a namespace is actually syncing', () => {
  // Unlike a rejected write, a failed start CAN come good: if sync is running
  // now, the thing that failed is working, and continuing to say otherwise
  // would be the same lie in the other direction.
  const w = load({ status: { totalQueueSize: 0, activeNamespaces: 0 }, signedIn: true });
  w.fire('appSyncFailed', { message: 'firestore unreachable' });
  assert.equal(w.pill.dataset.state, 'failed');

  w.setStatus(HEALTHY);
  w.tick();
  assert.equal(w.pill.dataset.state, 'synced', 'the failure is retired by real evidence, not by a timer');
  assert.equal(w.banner.hidden, true);
});

test('a rejected write is NOT cleared by a later healthy poll', () => {
  // The contrast case, and the reason the two failures are handled
  // differently: the rejected write is never going to land, so a green
  // namespace elsewhere is not evidence that it did.
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'gymTracker', keys: ['k'], code: 'payload-too-large' });
  w.setStatus(HEALTHY);
  w.tick();
  assert.equal(w.pill.dataset.state, 'failed');
});

// ---------- precedence ----------

test('offline outranks a standing failure, because offline is the more useful truth', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'gymTracker', keys: ['k'], code: 'payload-too-large' });
  assert.equal(w.pill.dataset.state, 'failed');
  w.setOnline(false);
  w.fire('offline');
  assert.equal(w.pill.dataset.state, 'offline');

  // ...and the failure is still there when the connection comes back.
  w.setOnline(true);
  w.fire('online');
  assert.equal(w.pill.dataset.state, 'failed');
});
