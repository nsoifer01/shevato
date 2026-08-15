'use strict';

// Shared node:vm harness for the football-h2h classic scripts.
//
// js/sidebar.js and js/football-h2h.js are plain <script> files: no module
// exports, top-level function declarations, and one shared global scope. They
// are loaded into a vm context with a stub document / localStorage, the same
// way apps/mario-kart/tests/core.test.js loads its sources.
//
// Three things to know before writing a test against them:
//
//  * `window` is aliased to the context's globalThis (as in a browser), so
//    `window.games = games` really does publish a global, and a stub dropped
//    on ctx.window is visible to bare identifier calls inside the scripts.
//  * Top-level `let` bindings (games, currentDateFilter, actionHistory,
//    customStartDate, ...) live in the global LEXICAL environment and are
//    invisible as ctx.<name> properties. Read or seed them with runIn().
//  * Objects built inside the context carry the context's prototypes, so
//    assert.deepEqual against a host literal fails on the prototype check.
//    Run them through toHost() first.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS_DIR = path.join(__dirname, '..', 'js');

// Minimal element stub: enough surface for the getters/setters the app code
// touches (value, textContent, innerHTML, style, classList, appendChild).
function makeElement(props = {}) {
    const classes = new Set();
    const el = {
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        title: '',
        selectedIndex: 0,
        style: {},
        classes,
        classList: {
            add: (...names) => names.forEach((n) => classes.add(n)),
            remove: (...names) => names.forEach((n) => classes.delete(n)),
            contains: (n) => classes.has(n),
            toggle: (n) => (classes.has(n) ? classes.delete(n) : classes.add(n)),
        },
        children: [],
        appendChild(child) { el.children.push(child); return child; },
        replaceChildren() { el.children.length = 0; },
        insertAdjacentHTML() {},
        remove() {},
        focus() {},
        setAttribute() {},
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        contains: () => false,
        ...props,
    };
    return el;
}

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        clear: () => { map.clear(); },
        get length() { return map.size; },
    };
}

/**
 * Build a contextified sandbox.
 *   elements  - id -> element stub returned by document.getElementById
 *   selectors - css selector -> value returned by querySelector /
 *               querySelectorAll (querySelectorAll defaults to [])
 *   readyState - document.readyState; the default 'loading' keeps
 *               football-h2h.js's bottom-of-file initializeApp() deferred so a
 *               load does not run the whole boot sequence.
 * Everything else is merged onto the sandbox as-is (Date, stub functions...).
 */
function makeContext({ elements = {}, selectors = {}, readyState = 'loading', ...extra } = {}) {
    const storage = extra.localStorage || memoryStorage();
    const sandbox = {
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        document: {
            readyState,
            getElementById: (id) => (id in elements ? elements[id] : null),
            querySelector: (sel) => (sel in selectors ? selectors[sel] : null),
            querySelectorAll: (sel) => (sel in selectors ? selectors[sel] : []),
            createElement: () => makeElement(),
            createDocumentFragment: () => makeElement(),
            body: makeElement(),
            addEventListener() {},
            removeEventListener() {},
            activeElement: null,
        },
        localStorage: storage,
        location: { hash: '', href: 'http://localhost/' },
        history: { replaceState() {} },
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        escapeHtml: (v) => String(v == null ? '' : v),
        showToast: () => {},
        ...extra,
    };
    const ctx = vm.createContext(sandbox);
    // Browser parity: window IS the global object. Without this the scripts'
    // `window.x = ...` exports would land on a detached object and every bare
    // identifier call between the two files would miss.
    vm.runInContext('globalThis.window = globalThis;', ctx);
    ctx.__elements = elements;
    ctx.__selectors = selectors;
    return ctx;
}

function loadInto(ctx, file) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
}

// Evaluate an expression inside the context (the only way to reach top-level
// `let` bindings such as `games` or `currentDateFilter`).
function runIn(ctx, expression) {
    return vm.runInContext(expression, ctx);
}

// Copy a value out of the context into this realm so assert.deepEqual can
// compare it against a plain literal. JSON round-trip, so undefined-valued
// keys are dropped (assert those with runIn/typeof instead).
function toHost(value) {
    return JSON.parse(JSON.stringify(value));
}

// Read the app's persisted games list back out of the stub localStorage.
function storedGames(ctx) {
    const raw = ctx.localStorage.getItem('footballH2HGames');
    return raw === null ? null : JSON.parse(raw);
}

// A Date whose zero-argument constructor and .now() are pinned to `iso`.
// Every other constructor form behaves normally, so the app's
// `new Date(y, m, d, ...)` and `new Date(isoString)` calls are untouched.
function fixedDate(iso) {
    const fixed = new Date(iso).getTime();
    return class FixedDate extends Date {
        constructor(...args) {
            if (args.length === 0) super(fixed);
            else super(...args);
        }
        static now() { return fixed; }
    };
}

module.exports = {
    JS_DIR,
    makeElement,
    memoryStorage,
    makeContext,
    loadInto,
    runIn,
    toHost,
    storedGames,
    fixedDate,
};
