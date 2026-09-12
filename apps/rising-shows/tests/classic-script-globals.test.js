'use strict';

// THREE CLASSIC SCRIPTS, ONE GLOBAL LEXICAL SCOPE.
//
// index.html loads scripts/match.js, finder-lib.js and providers-lib.js as
// plain <script> tags. They are not modules, so every top-level `const` lands
// in the SAME global lexical scope, and a second declaration of the same name
// is a SyntaxError that kills the whole file it appears in. That file's
// exports then never run, and the next thing to touch its global dies with
// `X is not defined`.
//
// This branch added a second `const API`, in match.js, alongside the one
// finder-lib.js already had. match.js loads first, so finder-lib.js was the
// casualty, and app.js reads `RisingShowsFinder` 20 times: the Show Finder
// stopped working entirely. CI caught it as
// `SyntaxError: Identifier 'API' has already been declared` followed by
// `ReferenceError: RisingShowsFinder is not defined`.
//
// It was invisible to `npm test`, because each file imports cleanly on its own
// under node:test, which is the only way the unit estate ever loads them. Only
// a browser puts them in one scope. This test does the same thing in a single
// vm context, which is cheap and needs no browser.
//
// SCOPE, and it matters: only the CLASSIC scripts share a scope.
// integrations-lib.js is loaded with `type="module"`, so it gets its own and
// cannot participate in this collision. Including it here would be a false
// positive, and a first draft of this test did exactly that.
//
// The rule this pins: a top-level name in any classic script here must be
// unique across all of them. Prefix it (MATCH_API) rather than hoping the load
// order stays lucky.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const INDEX_HTML = path.join(__dirname, '..', 'index.html');

/**
 * The scripts/*.js files index.html loads, split by how they are loaded.
 * Only the classic ones share a global lexical scope.
 */
function scriptsFromIndexHtml() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const tags = [...html.matchAll(/<script\b[^>]*\bsrc="scripts\/([^"]+\.js)"[^>]*>/g)];
    const classic = [];
    const modules = [];
    for (const [tag, file] of tags) {
        (/type=["']module["']/.test(tag) ? modules : classic).push(file);
    }
    return { classic, modules };
}

test('index.html still loads several of these as classic scripts, so this test still has a premise', () => {
    const { classic } = scriptsFromIndexHtml();
    assert.ok(
        classic.length >= 2,
        `expected at least two classic scripts sharing a scope, got ${classic.length}. `
        + 'If they all became modules the collision is impossible and this test should be retired, '
        + 'not left passing for the wrong reason.',
    );
});

test('every CLASSIC script index.html loads evaluates in one shared global scope', () => {
    const { classic: files } = scriptsFromIndexHtml();
    const sandbox = { window: {}, console, module: undefined, document: undefined };
    const ctx = vm.createContext(sandbox);

    const failures = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
        try {
            vm.runInContext(src, ctx, { filename: f });
        } catch (err) {
            failures.push(`${f}: ${err.message}`);
        }
    }

    assert.deepEqual(
        failures, [],
        'A file failed to evaluate alongside its siblings. A "has already been declared" message '
        + 'means two of these files use the same top-level name; prefix one of them. '
        + 'Failures:\n  ' + failures.join('\n  '),
    );
});

test('each classic library still reaches the browser under its own global', () => {
    const { classic } = scriptsFromIndexHtml();
    const sandbox = { window: {}, console, module: undefined, document: undefined };
    const ctx = vm.createContext(sandbox);
    for (const f of classic) {
        vm.runInContext(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'), ctx, { filename: f });
    }

    // RisingShowsFinder is the load-bearing one: app.js reads it 20 times, and
    // it is what broke. RisingShowsIntegrations is deliberately absent from
    // this list because its file is a module and is not evaluated here.
    for (const global of ['RisingShowsMatch', 'RisingShowsFinder', 'RisingShowsProviders']) {
        assert.ok(
            sandbox.window[global] && typeof sandbox.window[global] === 'object',
            `window.${global} was not exposed; its file probably failed to evaluate`,
        );
        assert.ok(
            Object.keys(sandbox.window[global]).length > 0,
            `window.${global} is empty`,
        );
    }
});
