'use strict';

// Shared vm harness for the mario-kart suites.
//
// Mario-kart's scripts use the classic globals pattern (no module.exports).
// Each test loads the relevant file into a fresh vm context with the runtime
// globals it expects (window, document, races, players, etc.) stubbed.
//
// Two things bite when writing tests against these files:
//   - top-level `let`/`const` bindings (races, currentDateFilter, MAX_HISTORY)
//     live in the script's global lexical scope, which vm does NOT mirror onto
//     the context object. Read or seed them with vm.runInContext, or drive them
//     through the app's own setters.
//   - values built inside the vm come from the vm's own intrinsics, so
//     assert.deepEqual against a host array/object trips the cross-realm
//     prototype check. Compare joined strings or copy the values out.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// MK_JS_DIR lets a test run point at another copy of js/ (used once per fix
// round to prove a new regression fails against the pre-fix sources).
const JS_DIR = process.env.MK_JS_DIR || path.join(__dirname, '..', 'js');

function makeContext(extra = {}) {
  const noopFn = () => null;
  const sandbox = {
    console,
    Date,
    Intl,
    JSON,
    Math,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: {},
    document: {
      getElementById: noopFn,
      querySelector: noopFn,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: (() => {
      const map = new Map();
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
      };
    })(),
    showMessage: () => {},
    updateDisplay: () => {},
    updateAchievements: () => {},
    ...extra,
  };
  sandbox.window = sandbox.window || {};
  sandbox.window.localStorage = sandbox.localStorage;
  return vm.createContext(sandbox);
}

function loadInto(ctx, file) {
  const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
  vm.runInContext(src, ctx, { filename: file });
}

// Date replacement for the sandbox: `new Date()` (no args) always returns the
// same instant, everything else behaves normally. Needed because the rolling
// date filters and the race timestamp are built from "now".
function freezeDate(isoNow) {
  const fixed = new Date(isoNow).getTime();
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  };
}

// Read a top-level `let`/`const` binding (or any expression) out of a context.
function evalIn(ctx, expression) {
  return vm.runInContext(expression, ctx);
}

module.exports = { JS_DIR, makeContext, loadInto, freezeDate, evalIn };
