'use strict';

// Every mid-round Firestore write that a player is actively WAITING on must
// tell that player when it fails.
//
// WHY: markReadyForNext (the Globe Drop "Ready" vote during the reveal) had a
// catch block that only called console.warn. The button is re-enabled by the
// snapshot, and meReady stays false because the marker was never written, so a
// failed vote looked exactly like a vote not yet cast: the player taps Ready,
// nothing visibly changes, and the room quietly waits out the full 10-second
// reveal window (Config.GLOBE_DROP_REVEAL_TIME_MS) instead of advancing early.
// The only evidence was a console line in a tab nobody has open.
//
// The other two writes of the same class already handled this - submitGuess
// ("Guess did not save") and submitAnswer ("Your answer did not save") - so
// this pins the rule they were already following rather than inventing one.
//
// app.js is a browser module that touches the DOM at import time, so the
// functions are read out of source rather than imported. What is being pinned
// is the failure-is-visible rule, which source is enough to show.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

// Reads a top-level `async function NAME(...) { ... }` by matching braces, so
// a nested object literal or arrow body cannot end the extraction early.
function bodyOf(name) {
    const start = SRC.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} must still be a top-level async function in app.js`);
    const open = SRC.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < SRC.length; i++) {
        const ch = SRC[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return SRC.slice(open + 1, i);
        }
    }
    throw new Error(`unbalanced braces while reading ${name}`);
}

// Every `catch (...) { ... }` inside a function body, again brace-matched.
function catchBlocks(body) {
    const blocks = [];
    const re = /catch\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(body))) {
        const open = body.indexOf('{', m.index);
        let depth = 0;
        for (let i = open; i < body.length; i++) {
            const ch = body[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { blocks.push(body.slice(open + 1, i)); break; }
            }
        }
    }
    return blocks;
}

// The three writes a player stares at the screen waiting for.
const WAITED_ON_WRITES = ['markReadyForNext', 'submitGuess', 'submitAnswer'];

for (const name of WAITED_ON_WRITES) {
    test(`${name} surfaces a failed write to the player, not just the console`, () => {
        const blocks = catchBlocks(bodyOf(name));
        assert.ok(blocks.length > 0, `${name} must still catch its write failure`);
        const telling = blocks.filter((b) => /showToast\s*\(/.test(b));
        assert.ok(telling.length > 0,
            `${name} swallows its write failure: no catch block calls showToast, so the ` +
            'player is left waiting on a write that already failed');
    });
}

test('a swallowed failure is what this pins - a console-only catch does not pass', () => {
    // Guards the checker itself: the pre-fix markReadyForNext catch was exactly
    // this, and it must not read as compliant.
    const preFix = ["console.warn('markReadyForNext failed:', err);"];
    assert.equal(preFix.filter((b) => /showToast\s*\(/.test(b)).length, 0);
});
