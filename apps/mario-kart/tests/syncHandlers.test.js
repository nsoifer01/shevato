'use strict';

// The two "storage changed underneath us" handlers in js/main.js must agree.
//
// WHY: `races` is replaced wholesale by loadSavedData(), while the undo stack
// holds actions describing the OLD array (ADD_RACE undo is `races.pop()`).
// Replaying that stack against another device's rows deletes a race nobody
// asked to delete, and because sync is per-key last-writer-wins, the deletion
// then propagates to every device. The cross-tab handler has always dropped
// the stack for exactly this reason; the CLOUD handler did not, so pressing
// Undo after a remote sync deleted whichever race was last in the other
// device's log.
//
// This is a source-shape assertion on purpose. main.js is a 1,800-line
// classic script whose handlers are registered inside DOM bootstrap, so
// driving the real listener needs the whole page; what actually regressed is
// one missing line in one callback, and that is what this pins.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(
    path.join(process.env.MK_JS_DIR || path.join(__dirname, '..', 'js'), 'main.js'),
    'utf8'
);

/** The body of the setTimeout callback that follows `marker`. */
function refreshBodyAfter(marker) {
    const at = MAIN.indexOf(marker);
    assert.notEqual(at, -1, `${marker} not found in main.js`);
    const timerAt = MAIN.indexOf('setTimeout(', at);
    assert.notEqual(timerAt, -1, `no debounced refresh after ${marker}`);
    let depth = 0;
    for (let i = MAIN.indexOf('{', timerAt); i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}') {
            depth--;
            if (depth === 0) return MAIN.slice(timerAt, i + 1);
        }
    }
    throw new Error(`unbalanced braces after ${marker}`);
}

test('the cloud-sync refresh drops the undo stack', () => {
    const body = refreshBodyAfter("window.addEventListener('localStorageSync'");
    assert.ok(/loadSavedData/.test(body), 'sanity: the handler re-reads storage');
    assert.ok(
        /resetActionHistory\s*\(/.test(body),
        'a remote refresh replaces `races`, so the undo stack must be reset; '
        + 'without it Undo pops a race from the OTHER device\'s log and syncs the deletion'
    );
});

test('the cross-tab refresh still drops the undo stack', () => {
    // The handler that was already correct. Pinned so a future refactor
    // cannot fix one and break the other.
    const body = refreshBodyAfter('window.ShevatoTabSync.watch');
    assert.ok(/loadSavedData/.test(body), 'sanity: the handler re-reads storage');
    assert.ok(/resetActionHistory\s*\(/.test(body), 'the cross-tab refresh must reset the undo stack');
});

test('both refreshes re-read storage before re-rendering', () => {
    for (const marker of ["window.addEventListener('localStorageSync'", 'window.ShevatoTabSync.watch']) {
        const body = refreshBodyAfter(marker);
        assert.ok(
            body.indexOf('loadSavedData') < body.indexOf('updateDisplay'),
            `${marker}: storage must be re-read before the re-render`
        );
    }
});
