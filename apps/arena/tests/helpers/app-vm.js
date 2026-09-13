'use strict';

// Runs named top-level functions from js/app.js inside a node:vm context, so a
// test can drive the REAL glue code against an in-memory Firestore.
//
// app.js is an ES module that imports the Firebase SDK and touches the DOM at
// import time, so it cannot be required. The other source-level tests read its
// text and match it, which pins wording rather than behaviour. For the few
// functions whose bug is in what they DO (which write they issue, what state
// they leave behind for the next snapshot), each is lifted out by bracket
// matching and evaluated in a context holding exactly the collaborators the
// test supplies. A collaborator the test forgot surfaces as a ReferenceError,
// never as a silent pass.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'app.js'), 'utf8');

// Index just past the bracket that closes the one opened at `open`.
function closeOf(open, openCh, closeCh) {
    let depth = 0;
    for (let i = open; i < SRC.length; i++) {
        if (SRC[i] === openCh) depth++;
        else if (SRC[i] === closeCh) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    throw new Error(`unbalanced ${openCh}${closeCh} in app.js`);
}

/** The full text of a top-level `function NAME(...) {...}` (async or not). */
function functionSource(name) {
    const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(SRC);
    assert.ok(m, `${name} must still be a top-level function in app.js`);
    const paramsEnd = closeOf(m.index + m[0].length - 1, '(', ')');
    const bodyOpen = SRC.indexOf('{', paramsEnd);
    return SRC.slice(m.index, closeOf(bodyOpen, '{', '}'));
}

/** A vm context holding `globals` plus the named app.js functions. */
function loadAppFunctions(names, globals) {
    const context = vm.createContext(Object.assign({ console: { warn() {}, log() {} } }, globals));
    vm.runInContext(names.map(functionSource).join('\n\n'), context, { filename: 'app.js (extracted)' });
    return context;
}

const ts = (ms) => ({ toMillis: () => ms });
const DELETE = Symbol('deleteField');
const SERVER_TIME = Symbol('serverTimestamp');

/**
 * In-memory documents with the write semantics the app relies on: set
 * (optionally merged), update of an existing doc, delete, the deleteField and
 * serverTimestamp sentinels. `onWrite(path)` runs after every write, which is
 * where a test hands the new copy back the way onSnapshot would.
 */
function createFirestoreFake() {
    const docs = new Map();
    const fake = {
        db: {},
        onWrite: null,
        doc: (_db, ...segments) => ({ path: segments.join('/') }),
        collection: (_db, ...segments) => ({ path: segments.join('/') }),
        deleteField: () => DELETE,
        serverTimestamp: () => SERVER_TIME,
        seed(p, data) { docs.set(p, Object.assign({}, data)); },
        read(p) { return docs.has(p) ? Object.assign({}, docs.get(p)) : null; },
        async getDoc(ref) {
            const d = docs.get(ref.path);
            return { exists: () => !!d, data: () => (d ? Object.assign({}, d) : undefined) };
        },
        async setDoc(ref, data, opts) {
            const merge = !!(opts && opts.merge);
            const target = merge && docs.has(ref.path) ? docs.get(ref.path) : {};
            for (const [k, v] of Object.entries(data)) {
                if (v === DELETE) {
                    assert.ok(merge, 'deleteField() is only valid in an update or a merged set');
                    delete target[k];
                } else {
                    target[k] = v === SERVER_TIME ? ts(Date.now()) : v;
                }
            }
            docs.set(ref.path, target);
            if (fake.onWrite) fake.onWrite(ref.path);
        },
        async updateDoc(ref, patch) {
            const target = docs.get(ref.path);
            if (!target) throw Object.assign(new Error(`no document at ${ref.path}`), { code: 'not-found' });
            for (const [k, v] of Object.entries(patch)) {
                if (v === DELETE) delete target[k];
                else target[k] = v === SERVER_TIME ? ts(Date.now()) : v;
            }
            if (fake.onWrite) fake.onWrite(ref.path);
        },
        async deleteDoc(ref) {
            docs.delete(ref.path);
            if (fake.onWrite) fake.onWrite(ref.path);
        },
    };
    return fake;
}

module.exports = { functionSource, loadAppFunctions, createFirestoreFake, ts };
