// The shipped js/app.js, booted in a small fake browser for node:test.
//
// app.js is a 13,000-line browser IIFE with no exports, and for months the
// decisions that live only there (which trip a dialog writes to, what a sync
// delivery does to the trip on screen, what a shared view may do) could be
// pinned by the browser suite alone. This evaluates the REAL source, the way
// sync-system/tests/tab-sync.test.mjs evaluates tab-sync.js, and drives it
// through the same listeners a click would reach. Nothing here copies app logic.
//
// What the fake DOM is: every `$('#id')` is one stable element that remembers
// listeners, classes, values and innerHTML strings. It does not parse markup,
// so a test observes what the app WROTE (storage, the innerHTML it assigned,
// the toasts it appended), never layout. Timers never fire on their own
// (`runTimers()` runs them), fetch is recorded and refused, and the device is
// offline, so a run is deterministic and never touches the network.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (name) => readFileSync(fileURLToPath(new URL(`../js/${name}`, import.meta.url)), 'utf8');
const LOGIC_SRC = src('trip-logic.js');
const APP_SRC = src('app.js');

export const LS_KEY = 'trip-planner:v1';

/** One device's localStorage. Two tabs of one browser share one of these. */
export function makeStorage(init = {}) {
  const map = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    map,
    get: (k) => (map.has(k) ? map.get(k) : null),
    json: (k) => JSON.parse(map.get(k) || 'null'),
  };
}

function classList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function event(type, el, init) {
  return { type, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {}, key: '', ...init };
}

function makeElement(key = '') {
  const listeners = {};
  const kids = new Map();
  const attrs = {};
  const el = {
    key, id: key.startsWith('#') ? key.slice(1) : '',
    listeners, children: [], dataset: {}, style: {}, classList: classList(), options: [],
    value: '', textContent: '', innerHTML: '', className: '', title: '', hidden: false, disabled: false, checked: false,
    scrollTop: 0, scrollLeft: 0, offsetParent: null, files: [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    hasAttribute(k) { return k in attrs; },
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, makeElement(sel)); return kids.get(sel); },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    matches() { return false; },
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    append(...c) { el.children.push(...c); },
    prepend(...c) { el.children.unshift(...c); },
    insertAdjacentHTML() {},
    replaceChildren() { el.children.length = 0; },
    remove() {},
    focus() {}, blur() {}, select() {}, scrollIntoView() {}, scrollTo() {}, showPicker() {}, requestSubmit() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    // A programmatic click on a disabled control does nothing, as in a browser.
    click() { if (!el.disabled) el.dispatch('click'); },
    dispatch(type, init) {
      const ev = event(type, el, init);
      return (listeners[type] || []).slice().map((fn) => fn(ev));
    },
  };
  return el;
}

/**
 * A button-like event target whose `closest(selector)` answers for the exact
 * selector strings the handler under test asks for.
 */
export function target({ dataset = {}, matches = [], closest = {} } = {}) {
  const el = makeElement();
  Object.assign(el.dataset, dataset);
  el.closest = (sel) => (sel in closest ? closest[sel] : (matches.includes(sel) ? el : null));
  return el;
}

/**
 * Boot app.js against `storage` (a makeStorage()). Returns drivers and probes.
 * `hash` boots a share link or a view; call `until()` for the async share boot.
 */
export function bootApp({ storage = makeStorage(), hash = '' } = {}) {
  const elements = new Map();
  const $ = (sel) => { if (!elements.has(sel)) elements.set(sel, makeElement(sel)); return elements.get(sel); };
  // index.html ships the panel hidden; the fake has no markup to read it from
  $('#assistPanel').hidden = true;

  const writes = [];
  const localStorage = {
    getItem: (k) => storage.get(k),
    setItem: (k, v) => { storage.map.set(k, String(v)); writes.push(k); },
    removeItem: (k) => { storage.map.delete(k); writes.push(k); },
    key: (i) => [...storage.map.keys()][i] ?? null,
    get length() { return storage.map.size; },
  };

  const timers = [];
  const fetches = [];
  const errors = [];
  const winListeners = {};
  const body = makeElement('body');
  const document = {
    body, head: makeElement('head'), activeElement: null, baseURI: 'http://localhost/apps/trip-planner/',
    querySelector: $,
    getElementById: (id) => $('#' + id),
    querySelectorAll: (sel) => (sel === '.overlay.open'
      ? [...elements.values()].filter((e) => /Overlay$/.test(e.key) && e.classList.contains('open'))
      : []),
    createElement: () => makeElement(),
    createTextNode: (t) => ({ textContent: t }),
    addEventListener() {},
    contains: () => false,
    elementFromPoint: () => null,
  };
  const window = {
    innerWidth: 1280, innerHeight: 900, scrollY: 0,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent() {},
    scrollTo() {},
    prompt() {},
  };
  const globals = {
    window, document, localStorage,
    navigator: { onLine: false, clipboard: { writeText: async () => {} } },
    location: { hash, search: '', pathname: '/apps/trip-planner/', href: 'http://localhost/apps/trip-planner/' + hash, hostname: 'localhost', reload() {} },
    history: { replaceState() {} },
    performance: { now: () => 0 },
    CSS: { escape: (s) => String(s) },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    queueMicrotask,
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
    fetch: (url) => { fetches.push(String(url)); return Promise.reject(new Error('offline in tests')); },
    getComputedStyle: () => ({}),
    crypto: globalThis.crypto, Intl, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    Blob, Response, atob, btoa, structuredClone, CompressionStream, DecompressionStream,
  };
  Object.assign(window, globals);
  const ctx = vm.createContext(globals);
  vm.runInContext(LOGIC_SRC, ctx, { filename: 'trip-logic.js' });
  vm.runInContext(APP_SRC, ctx, { filename: 'app.js' });

  const fireWindow = (type, init) => (winListeners[type] || []).slice().map((fn) => fn({ type, ...init }));

  return {
    $, storage, writes, fetches, errors,
    /** Dispatch `type` on `$(sel)` and wait for any async listener. */
    async fire(sel, type, init) { await Promise.all($(sel).dispatch(type, init)); },
    /** A trip-menu row, as a click on the menu panel reaches it. */
    async menu(act) {
      const btn = target({ dataset: { act }, matches: ['button[data-act]'] });
      await Promise.all($('#tripMenu').querySelector('.tp-menu-panel').dispatch('click', { target: btn }));
    },
    /** A button inside a Days-view day card. */
    async dayAct(act, date) {
      const btn = target({ dataset: { act, date }, matches: ['button[data-act]'] });
      await Promise.all($('#daysList').dispatch('click', { target: btn }));
    },
    /** A row of the phone "More" menu, which proxies a click to the real control. */
    async moreRow(proxy) {
      const row = target({ dataset: { proxy }, matches: ['button'] });
      await Promise.all($('#tbMoreMenu').dispatch('click', { target: row }));
    },
    /** This device's sync layer delivering a value another device wrote. */
    deliverRemote(key, value) {
      storage.map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      fireWindow('localStorageSync', { detail: { key, source: 'remote' } });
    },
    /** The native cross-tab `storage` event, for a key another tab wrote. */
    storageEvent(key) { fireWindow('storage', { key, newValue: storage.get(key) }); },
    /** The trip the picker shows as selected on this page. */
    openTripId() {
      const m = /<option value="([^"]*)" selected>/.exec($('#tripSelect').innerHTML);
      return m ? m[1] : null;
    },
    overlayOpen: (sel) => $(sel).classList.contains('open'),
    bodyHas: (cls) => body.classList.contains(cls),
    toasts: () => $('#toasts').children.map((t) => String(t.innerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
    /** Proposal cards the app appended anywhere under `$(sel)`, in order. */
    proposalCards(sel) {
      const out = [];
      const walk = (el) => {
        for (const c of el.children || []) {
          if (/(^|\s)assist-proposal(\s|$)/.test(c.className || '')) out.push(c);
          walk(c);
        }
      };
      walk($(sel));
      return out;
    },
    runTimers() { while (timers.length) timers.shift()(); },
    /** Let promise chains already started run out (a bounded number of turns, no clock). */
    async settle(turns = 50) { for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r)); },
    /** Resolve once `pred()` holds, turning the event loop; never a fixed sleep. */
    async until(pred, what = 'condition') {
      for (let i = 0; i < 500; i++) {
        if (pred()) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
  };
}

// ---- fixtures ------------------------------------------------------------

export function item(over = {}) {
  return {
    id: over.id || `i-${Math.random().toString(36).slice(2, 9)}`,
    type: 'activity', title: 'Untitled', location: '', startDate: '2027-06-10', endDate: '',
    startTime: '', endTime: '', status: 'to-book', cost: null, costNote: '', details: '',
    createdAt: '2027-01-01T00:00:00.000Z',
    ...over,
  };
}

export function trip(id, name, items = []) {
  return { id, name, currency: 'USD', items };
}

export function dbOf(trips, activeTripId = trips[0] && trips[0].id) {
  return { version: 1, activeTripId, trips };
}
