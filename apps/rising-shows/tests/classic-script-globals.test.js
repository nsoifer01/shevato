'use strict';

// THE CLASSIC LIBRARIES STILL REACH window.
//
// index.html loads scripts/match.js, finder-lib.js and providers-lib.js as
// plain <script> tags, and app.js reads what they attach to `window`. When one
// of them dies at load, app.js fails far away from the cause: on PR #530 a
// second top-level `const API` killed finder-lib.js and the Show Finder
// rendered nothing (`ReferenceError: RisingShowsFinder is not defined`).
//
// WHICH TEST CATCHES WHAT. The name clash itself is now caught for every
// published page, this one included, by tests/static/classic-script-scope.test.mjs,
// which instantiates each page's classic scripts together without running
// them. That test cannot see a library that parses and declares cleanly but
// never assigns its namespace, so this one EXECUTES the three files in one
// shared context, in the order index.html lists them, and checks each export.
//
// SCOPE: only the CLASSIC scripts are evaluated. integrations-lib.js is loaded
// with `type="module"` on index.html, so it gets its own scope and is not part
// of this page's shared one.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const INDEX_HTML = path.join(__dirname, '..', 'index.html');

/** The scripts/*.js files index.html loads as classic scripts, in order. */
function classicScriptsFromIndexHtml() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    return [...html.matchAll(/<script\b[^>]*\bsrc="scripts\/([^"]+\.js)"[^>]*>/g)]
        .filter(([tag]) => !/type=["']module["']/.test(tag))
        .map(([, file]) => file);
}

test('each classic library still reaches the browser under its own global', () => {
    const classic = classicScriptsFromIndexHtml();
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
