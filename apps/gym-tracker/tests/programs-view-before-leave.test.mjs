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
import { buildMethods as extractMethods, loadSource } from './helpers/source-extract.mjs';

const src = loadSource('js/views/programs-view.js');

const METHODS = [
    'beforeLeave',
    'closeProgramModal',
    'closeExercisePicker',
    'editorSnapshot',
    'isEditorDirty',
    'requestCloseProgramModal',
];

// The REAL method text, evaluated against stubs. No mirror: if
// programs-view.js changes shape or behaviour these tests move with it.
const buildMethods = (document, showConfirmModal) =>
    extractMethods(src, METHODS, { document, showConfirmModal }, 'programs-view.js');

function makeEl(id, classes = [], value = '') {
    const set = new Set(classes);
    return {
        id,
        hidden: false,
        value,
        classList: {
            add: c => set.add(c),
            remove: c => set.delete(c),
            contains: c => set.has(c),
        },
        classes: set,
    };
}

// GT-08: the discard guard asks before throwing unsaved edits away. The fake
// records every prompt so a test can assert both that it fired and what the
// user's answer did.
function makeConfirm() {
    const calls = [];
    let answer = true;
    const fn = (opts) => { calls.push(opts); return Promise.resolve(answer); };
    fn.calls = calls;
    fn.answerWith = (v) => { answer = v; };
    return fn;
}

// `open` mirrors the DOM after openProgramModal(): editor active, picker closed.
function makeView({
    open = true, workoutMode = false, pickerOpen = false, returnToView = null, dirty = false,
} = {}) {
    const els = {
        'program-name': makeEl('program-name', [], 'Push Day A'),
        'program-description': makeEl('program-description', [], ''),
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
    const confirm = makeConfirm();
    const view = Object.create(buildMethods(document, confirm));
    view.app = { showView: v => shown.push(v), programs: stored };
    view.returnToView = returnToView;
    view.enteredFromWorkout = workoutMode;
    // The staged deep clone the editor mutates; Cancel and this hook discard it.
    const staged = { id: 1, name: 'Push Day A EDITED', exercises: [{ sets: [{ repsMin: 3, repsMax: 3 }] }] };
    staged.toJSON = () => ({ id: staged.id, name: staged.name, exercises: staged.exercises });
    view.currentProgram = staged;
    // A baseline captured at open time is what makes the editor "clean";
    // `dirty: true` seeds a baseline that no longer matches the staged clone.
    view.editorBaseline = dirty
        ? JSON.stringify({ name: 'something else', description: '', program: staged.toJSON() })
        : view.editorSnapshot();

    return { view, els, shown, stored, confirm };
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

// ---------------------------------------------------------------------------
// GT-08: closing the editor with unsaved work asks before discarding it.
//
// Escape, Cancel and the X all funnel through requestCloseProgramModal, and
// leaving the Programs view funnels through beforeLeave. Building an
// 8-exercise program with per-set rep ranges is the longest flow in the app,
// and every one of those routes used to throw it away instantly and silently.
// ---------------------------------------------------------------------------

test('a clean editor closes immediately, with no prompt', async () => {
    const { view, els, confirm } = makeView();
    assert.equal(view.isEditorDirty(), false);
    const closed = await view.requestCloseProgramModal();
    assert.equal(closed, true);
    assert.equal(confirm.calls.length, 0, 'nothing changed, so nothing to ask about');
    assert.equal(els['program-modal'].classList.contains('active'), false);
});

test('a dirty editor asks before discarding, and closes when confirmed', async () => {
    const { view, els, confirm } = makeView({ dirty: true });
    assert.equal(view.isEditorDirty(), true);
    const closed = await view.requestCloseProgramModal();
    assert.equal(closed, true);
    assert.equal(confirm.calls.length, 1);
    assert.match(confirm.calls[0].title, /discard/i);
    assert.equal(els['program-modal'].classList.contains('active'), false);
});

test('declining the prompt keeps the editor open and the staged clone alive', async () => {
    const { view, els, confirm } = makeView({ dirty: true });
    confirm.answerWith(false);
    const closed = await view.requestCloseProgramModal();
    assert.equal(closed, false);
    assert.equal(els['program-modal'].classList.contains('active'), true, 'still editing');
    assert.notEqual(view.currentProgram, null, 'the staged edits survive');
});

test('a typed program name counts as dirty even before it reaches the clone', () => {
    // The name and description live in the inputs until save, so the snapshot
    // has to read the DOM as well as the staged clone.
    const { view, els } = makeView();
    assert.equal(view.isEditorDirty(), false);
    els['program-name'].value = 'Push Day A v2';
    assert.equal(view.isEditorDirty(), true);
});

test('an exercise added to the staged clone counts as dirty', () => {
    const { view } = makeView();
    assert.equal(view.isEditorDirty(), false);
    view.currentProgram.exercises.push({ sets: [{ repsMin: 8, repsMax: 10 }] });
    assert.equal(view.isEditorDirty(), true);
});

test('beforeLeave defers navigation while the discard prompt is open', async () => {
    const { view, shown, confirm } = makeView({ dirty: true });
    confirm.answerWith(false);
    assert.equal(view.beforeLeave('home'), false, 'navigation waits for the answer');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(shown, [], 'and does not happen when the user keeps editing');
});

test('beforeLeave completes the navigation once the user confirms the discard', async () => {
    const { view, shown, confirm } = makeView({ dirty: true, returnToView: 'home' });
    assert.equal(view.beforeLeave('calendar'), false);
    // Let the confirm promise and its continuation settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(shown, ['calendar'], 'lands where the user asked, not on returnToView');
    assert.equal(confirm.calls.length, 1);
});

test('beforeLeave on a CLEAN editor still proceeds without a prompt', () => {
    const { view, confirm } = makeView();
    assert.notEqual(view.beforeLeave('home'), false);
    assert.equal(confirm.calls.length, 0);
});
