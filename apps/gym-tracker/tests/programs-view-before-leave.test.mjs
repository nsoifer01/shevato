// ProgramsView.beforeLeave: the navigation hook that dismisses the program
// editor when the user leaves the Programs view.
//
// Why it exists: #program-modal is a document-level element (a `.view` animates,
// which would make its `position: fixed` resolve against the view box and render
// the dialog off-screen). app.showView() hides views by setting display:none on
// every `.view`, so a modal outside the view tree survives a view change and
// floats over whatever view you land on. Pressing Back with the editor open left
// it on top of the Dashboard.
//
// The methods are lifted from the real source text (they hang off a DOM-bound
// class that cannot be imported under node) and run against a stub document, so
// these tests fail if programs-view.js drifts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/views/programs-view.js', import.meta.url), 'utf8');

function methodSource(name) {
    const start = src.indexOf(`\n    ${name}(`);
    assert.notEqual(start, -1, `${name}() not found in programs-view.js`);
    let depth = 0;
    let i = src.indexOf('{', start);
    const bodyStart = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start + 1, i + 1).trim();
}

// Object-literal shorthand matches the class-method syntax exactly, so the
// extracted text can be evaluated as-is with `document` shadowed by a stub.
const buildMethods = new Function(
    'document',
    `"use strict"; return { ${methodSource('beforeLeave')}, ${methodSource('closeProgramModal')}, ${methodSource('closeExercisePicker')} };`
);

function makeEl(id, classes = []) {
    const set = new Set(classes);
    return {
        id,
        hidden: false,
        classList: {
            add: c => set.add(c),
            remove: c => set.delete(c),
            contains: c => set.has(c),
        },
        classes: set,
    };
}

// `open` mirrors the DOM after openProgramModal(): editor active, picker closed.
function makeView({ open = true, workoutMode = false, pickerOpen = false, returnToView = null } = {}) {
    const els = {
        'program-modal': makeEl('program-modal', [
            ...(open ? ['modal', 'active'] : ['modal']),
            ...(workoutMode ? ['program-editor-workout-mode'] : []),
        ]),
        'exercise-picker-modal': makeEl('exercise-picker-modal', pickerOpen ? ['modal', 'active'] : ['modal']),
        'return-to-workout-btn': makeEl('return-to-workout-btn'),
        'program-modal-workout-actions': makeEl('program-modal-workout-actions'),
    };
    els['program-modal-workout-actions'].hidden = !workoutMode;
    els['return-to-workout-btn'].hidden = true;

    const document = { getElementById: id => els[id] || null };
    const shown = [];
    const stored = [{ id: 1, name: 'Push Day A', exercises: [{ sets: [{ repsMin: 6, repsMax: 8 }] }] }];
    const view = Object.create(buildMethods(document));
    view.app = { showView: v => shown.push(v), programs: stored };
    view.returnToView = returnToView;
    view.enteredFromWorkout = workoutMode;
    // The staged deep clone the editor mutates; Cancel and this hook discard it.
    view.currentProgram = { id: 1, name: 'Push Day A EDITED', exercises: [{ sets: [{ repsMin: 3, repsMax: 3 }] }] };

    return { view, els, shown, stored };
}

test('beforeLeave dismisses the open editor so it cannot float over the next view', () => {
    const { view, els } = makeView();
    view.beforeLeave('home');
    assert.equal(els['program-modal'].classList.contains('active'), false);
});

test('beforeLeave lets navigation proceed (never returns false)', () => {
    const open = makeView();
    assert.notEqual(open.view.beforeLeave('home'), false, 'an open editor must not defer navigation');
    const closed = makeView({ open: false });
    assert.notEqual(closed.view.beforeLeave('home'), false, 'no editor open is still a clean pass');
});

test('beforeLeave does not re-enter showView via returnToView', () => {
    // closeProgramModal() calls app.showView(returnToView); beforeLeave is itself
    // called from inside showView, so the field has to be cleared first.
    const { view, shown } = makeView({ returnToView: 'home' });
    view.beforeLeave('home');
    assert.deepEqual(shown, [], 'no nested showView call');
    assert.equal(view.returnToView, null);
});

test('beforeLeave resets workout-edit state exactly as closing the editor does', () => {
    const { view, els } = makeView({ workoutMode: true });
    view.beforeLeave('workout');
    assert.equal(els['program-modal'].classList.contains('program-editor-workout-mode'), false);
    assert.equal(els['program-modal-workout-actions'].hidden, true);
    assert.equal(els['return-to-workout-btn'].hidden, true);
    assert.equal(view.enteredFromWorkout, false, 'the next open must not inherit workout mode');
});

test('beforeLeave also closes the exercise picker', () => {
    // The picker is a child of the editor (document-level, stacked above it);
    // its `active` class holds the shared modal scroll lock on <body>, so no
    // route out of the Programs view may leave it set.
    const { view, els } = makeView({ pickerOpen: true });
    view.beforeLeave('home');
    assert.equal(els['exercise-picker-modal'].classList.contains('active'), false);
});

test('beforeLeave with only the picker somehow open still clears it', () => {
    // Defensive branch: the picker cannot open without the editor, but if the
    // invariant is ever broken the view-leave path must still release it.
    const { view, els } = makeView({ open: false, pickerOpen: true });
    view.beforeLeave('home');
    assert.equal(els['exercise-picker-modal'].classList.contains('active'), false);
});

test('closing the editor releases the staged clone', () => {
    // commitExercisePickerSelection guards on currentProgram: after any close,
    // a stray commit must find nothing to write into (the original
    // lost-exercise bug wrote into a discarded staged clone).
    const { view } = makeView();
    view.beforeLeave('home');
    assert.equal(view.currentProgram, null);
});

test('beforeLeave discards the staged edits instead of committing them', () => {
    const { view, stored } = makeView();
    view.beforeLeave('home');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'Push Day A', 'the stored program keeps its original name');
    assert.equal(stored[0].exercises[0].sets[0].repsMin, 6, 'and its original reps');
});

test('beforeLeave with the editor already closed touches nothing', () => {
    const { view, shown, els } = makeView({ open: false, returnToView: 'home' });
    view.beforeLeave('home');
    assert.deepEqual(shown, []);
    assert.equal(els['program-modal'].classList.contains('active'), false);
    assert.equal(view.returnToView, 'home', 'a pending return target is left for closeProgramModal');
});
