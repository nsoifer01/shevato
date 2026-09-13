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
  w.fire('syncWriteRejected', { namespace: 'maptapRivalsApp', keys: ['maptapRivalsGames'], code: 'invalid-argument' });
  assert.equal(w.banner.hidden, false);
  assert.equal(w.banner.dataset.state, 'failed');
  const text = w.banner.children.map(c => c.textContent).join(' ');
  // Changed 2026-09-13: this used a made-up id and asserted the id itself
  // appeared, which pinned internal namespace ids in visitor-facing copy.
  assert.match(text, /in MapTap Rivals /, 'the message names which app is affected, by its site name');
  assert.ok(!text.includes('maptapRivalsApp'), 'and never by its namespace id');
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

// ---------- retryable vs permanent, and recovery (2026-09-12 audit S-3) ----------
//
// The engine now tells the two apart. A write that ran out of retries on a
// network failure is parked and will be resent (`retryable: true`); a write
// the server refused outright is not (`retryable: false`). Either way the
// namespace is NOT saved until the engine says `syncWriteRecovered` for it,
// and until then the widget must never read "Synced".

test('a retryable rejection reads as not saved yet, never Synced, and survives the poll', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'tripPlannerApp', keys: ['k'], code: 'unavailable', retryable: true });
  assert.equal(w.pill.dataset.state, 'unsaved');
  assert.equal(w.pill.textContent, 'Not saved to cloud yet');
  w.tick();
  w.tick();
  assert.equal(w.pill.textContent, 'Not saved to cloud yet', 'a healthy poll is not evidence the write landed');
  assert.equal(w.banner.hidden, false);
  assert.equal(w.banner.dataset.state, 'unsaved');
  const text = w.banner.children.map(c => c.textContent).join(' ');
  assert.match(text, /in Trip Planner /, 'the app is named the way the site names it');
  assert.match(text, /safe on this device/i);
  assert.match(text, /try again/i, 'the retryable copy says it will be retried');
});

test('a permanent rejection reads as not saved and stays until that namespace recovers', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'gymTrackerApp', keys: ['k'], code: 'permission-denied', retryable: false });
  assert.equal(w.pill.dataset.state, 'failed');
  assert.equal(w.pill.textContent, 'Not saved to cloud');

  w.fire('syncWriteRecovered', { namespace: 'someOtherApp' });
  w.tick();
  assert.equal(w.pill.textContent, 'Not saved to cloud', 'another namespace recovering is not this one recovering');

  w.fire('syncWriteRecovered', { namespace: 'gymTrackerApp' });
  assert.equal(w.pill.dataset.state, 'synced');
  assert.equal(w.pill.textContent, 'Synced');
  assert.equal(w.banner.hidden, true, 'the failure banner comes down with the failure');
});

test('a retryable rejection clears on recovery', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'marioKart', keys: ['k'], code: 'deadline-exceeded', retryable: true });
  w.fire('syncWriteRecovered', { namespace: 'marioKart' });
  assert.equal(w.pill.textContent, 'Synced');
});

test('with two namespaces failing, one recovering still does not read Synced', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'a', keys: ['k'], code: 'unavailable', retryable: true });
  w.fire('syncWriteRejected', { namespace: 'b', keys: ['k'], code: 'permission-denied', retryable: false });
  assert.equal(w.pill.textContent, 'Not saved to cloud', 'the permanent failure is the one shown');

  w.fire('syncWriteRecovered', { namespace: 'b' });
  assert.equal(w.pill.textContent, 'Not saved to cloud yet', 'the retryable one is still outstanding');

  w.fire('syncWriteRecovered', { namespace: 'a' });
  assert.equal(w.pill.textContent, 'Synced');
});

test('a namespace that failed permanently is not downgraded by a later retryable failure', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'a', keys: ['k1'], code: 'invalid-argument', retryable: false });
  w.fire('syncWriteRejected', { namespace: 'a', keys: ['k2'], code: 'unavailable', retryable: true });
  assert.equal(w.pill.textContent, 'Not saved to cloud');
});

test('a rejection without a retryable flag keeps the old permanent reading', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'a', keys: ['k'], code: 'payload-too-large' });
  assert.equal(w.pill.dataset.state, 'failed');
  assert.equal(w.pill.textContent, 'Not saved to cloud');
});

test('a write failure is not cleared by sync coming up, the way an init failure is', () => {
  const w = load({ status: { totalQueueSize: 0, activeNamespaces: 0 }, signedIn: true });
  w.fire('appSyncFailed', { message: 'x' });
  w.fire('syncWriteRejected', { namespace: 'a', keys: ['k'], code: 'unavailable', retryable: true });
  w.setStatus(HEALTHY);
  w.tick();
  assert.equal(w.pill.textContent, 'Not saved to cloud yet');
  w.fire('syncWriteRecovered', { namespace: 'a' });
  assert.equal(w.pill.textContent, 'Synced', 'and the init failure was already retired by the live namespace');
});

// The stub banner keeps every render's children (label, close), so a test that
// fires more than once reads the latest render only.
const latestBannerText = (w) => w.banner.children.slice(-2).map(c => c.textContent).join(' ');

// ---------- the banner names apps, never internal namespace ids ----------
//
// The copy used to interpolate the engine's namespace id, so a visitor read
// "Some changes in tripPlannerApp have not been saved". Every namespace the
// sync init registers must reach the banner as the app's own name, and an id
// the widget does not know is left out rather than shown raw.

const INIT_SRC = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sync-system', 'app-sync-init.js'), 'utf8');
const REGISTERED = Array.from(INIT_SRC.matchAll(/namespace:\s*'([A-Za-z0-9_]+)'/g), m => m[1]);

test('the namespace scan found the registered namespaces', () => {
  assert.ok(REGISTERED.length >= 8, REGISTERED.join(', '));
});

for (const retryable of [true, false]) {
  for (const ns of REGISTERED) {
    test(`a ${retryable ? 'retryable' : 'permanent'} failure in ${ns} names the app, not the id`, () => {
      const w = load({ status: HEALTHY, signedIn: true });
      w.fire('syncWriteRejected', { namespace: ns, keys: ['k'], code: retryable ? 'unavailable' : 'permission-denied', retryable });
      const text = w.banner.children.map(c => c.textContent).join(' ');
      assert.ok(!text.includes(ns), `raw id in: ${text}`);
      assert.doesNotMatch(text, /\b[a-z]+[A-Z][A-Za-z]*App\b|globalPrefs/, text);
      assert.match(text, /^Some changes in (your site settings|[A-Z0-9][^,]*) (could not|have not)/, text);
    });
  }
}

test('two failing apps are both named, once each', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'gymTrackerApp', keys: ['a'], code: 'unavailable', retryable: true });
  w.fire('syncWriteRejected', { namespace: 'fplPlannerApp', keys: ['b'], code: 'unavailable', retryable: true });
  const text = latestBannerText(w);
  assert.match(text, /^Some changes in Gym Tracker, FPL Planner have not been saved/, text);
});

test('an unknown namespace is left out of the sentence, never shown raw', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'someFutureApp', keys: ['k'], code: 'unavailable', retryable: true });
  const text = w.banner.children.map(c => c.textContent).join(' ');
  assert.ok(!text.includes('someFutureApp'), text);
  assert.match(text, /^Some changes have not been saved to the cloud yet/, text);
});

test('an unknown refused namespace still outranks a known pending one', () => {
  const w = load({ status: HEALTHY, signedIn: true });
  w.fire('syncWriteRejected', { namespace: 'tripPlannerApp', keys: ['a'], code: 'unavailable', retryable: true });
  w.fire('syncWriteRejected', { namespace: 'someFutureApp', keys: ['b'], code: 'permission-denied', retryable: false });
  assert.equal(w.pill.dataset.state, 'failed', 'a refused write is never softened because its app has no name');
  const text = latestBannerText(w);
  assert.match(text, /^Some changes could not be saved to the cloud/, text);
});
