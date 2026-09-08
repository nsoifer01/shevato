'use strict';

// Loads js/app.js into a vm context that stubs the browser globals it touches
// at parse + init time, and hands back the helpers it exports for testing.
//
// Extracted from app-features.test.js so a second suite can drive the same
// app.js without a second copy of the sandbox - two copies would drift, and a
// drifted stub is a test that passes against a browser that does not exist.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Load app.js into a vm context that stubs the browser globals it touches at
// parse + init time. Execution stops before load() does anything real, because
// the stubbed fetch() rejects immediately.
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

function makeContext(extra = {}) {
  const noopEl = () => {
    const el = {
      querySelector() { return noopEl(); },
      querySelectorAll() { return []; },
      getAttribute() { return null; },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      replaceChildren() {},
      appendChild() {},
      insertBefore() {},
      insertAdjacentElement() {},
      closest() { return null; },
      cloneNode() { return noopEl(); },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      style: {},
      dataset: {},
      hidden: true,
      textContent: '',
      value: '',
      disabled: false,
      children: [],
      firstChild: null,
      childElementCount: 0,
      // Template element content stub
      get content() {
        return {
          firstElementChild: { cloneNode() { return noopEl(); } },
        };
      },
    };
    return el;
  };

  // Web Storage stand-in. Values are stringified on the way in, exactly as the
  // real thing does, so `getItem` returning "640" rather than 640 is faithful.
  const makeStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
    };
  };

  const sandbox = {
    // Core JS globals
    console,
    Date, Math, JSON, Array, Object, Number, String, Boolean,
    Symbol, Map, Set, Promise, Error, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    parseInt, parseFloat, isFinite, isNaN,
    encodeURIComponent, decodeURIComponent,

    // Browser globals that app.js accesses at top level
    window: {},
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1024,
    // Scroll restoration measures the reachable offset as
    // documentElement.scrollHeight - innerHeight, so both have to exist.
    innerHeight: 768,
    document: {
      getElementById: () => noopEl(),
      querySelector: () => noopEl(),
      querySelectorAll: () => [],
      createElement: () => noopEl(),
      createElementNS: () => noopEl(),
      createTextNode: (t) => ({ textContent: t }),
      createDocumentFragment: () => {
        const frag = { childNodes: [], children: [], childElementCount: 0 };
        frag.appendChild = () => {};
        frag.replaceChildren = () => {};
        return frag;
      },
      body: {
        appendChild() {}, children: [], classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, style: {},
      },
      documentElement: { style: {}, scrollHeight: 0, scrollTop: 0 },
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: makeStorage(),
    // Per-tab storage: where the saved scroll offset lives.
    sessionStorage: makeStorage(),
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost' },
    history: { replaceState() {} },
    navigator: { clipboard: null, share: undefined, canShare: undefined },
    CSS: { escape: (s) => s },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    // Never-settling fetch so load()'s async chain never throws an unhandled rejection.
    fetch: () => new Promise(() => {}),
    // index.html loads scripts/finder-lib.js BEFORE js/app.js, and app.js
    // takes its search folding from it (2026-09-05 audit F08 moved the
    // implementation there so the build could stamp `titleSearch` into the
    // index with the same function the finder searches with). Without this
    // the sandbox exercises app.js's degraded fallback instead of the page.
    RisingShowsFinder: require('../scripts/finder-lib.js'),
    ...extra,
  };
  // window self-reference
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

let ctx;
ctx = makeContext();
let loadError = null;
try {
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
} catch (e) {
  // Synchronous errors from load() (skeleton/DOM stubs) are expected AFTER the
  // export block runs. One thrown earlier - a missing browser global, a parse
  // error - leaves _rsTestExports undefined, and every assertion below would
  // then read a property of `{}` and pass on undefined. Fail loudly instead.
  loadError = e;
}

const helpers = ctx._rsTestExports || {};

assert.ok(
  Object.keys(helpers).length > 0,
  'app.js did not expose window._rsTestExports, so nothing in this file is actually under test. '
  + (loadError
    ? `app.js threw while loading: ${loadError.stack}`
    : 'app.js loaded without throwing; check the export block at the bottom of js/app.js.'),
);
module.exports = { helpers, ctx, makeContext, loadError, APP_JS };
