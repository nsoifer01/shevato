// Modal stacking is DOM-order based: every `.modal` overlay shares one
// z-index, so whichever comes later in the document paints on top.
//
// The exercise picker is a child of the program editor (it opens over it and
// returns to it), so it must sit AFTER #program-modal - and the confirmation
// modal must come after both so destructive confirms always paint on top.
// The picker also must NOT live inside a `.view` container: views animate
// with a transform, which turns them into containing blocks for
// position:fixed, and being inside #programs-view is what once painted the
// picker UNDERNEATH the editor (the "added exercise silently lost" bug).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const idx = (needle) => {
    const i = html.indexOf(needle);
    assert.notEqual(i, -1, `expected to find ${needle} in index.html`);
    return i;
};

test('picker paints over the editor: program-modal < exercise-picker-modal < confirm-modal', () => {
    const program = idx('id="program-modal"');
    const picker = idx('id="exercise-picker-modal"');
    const confirm = idx('id="confirm-modal"');
    assert.ok(program < picker,
        '#exercise-picker-modal must come after #program-modal (it stacks over the editor)');
    assert.ok(picker < confirm,
        '#confirm-modal must come after the picker (confirms stack over everything)');
});

test('picker lives at document level, outside every .view container', () => {
    // All `.view` containers live inside #main-content / the app views block;
    // #workout-view is the view that directly follows #programs-view. If the
    // picker sits before #workout-view it is back inside #programs-view.
    const workoutView = idx('id="workout-view"');
    const picker = idx('id="exercise-picker-modal"');
    assert.ok(picker > workoutView,
        '#exercise-picker-modal must not be nested inside #programs-view');
});
