// Exercise-picker selection defaults, tray markup, and remove-confirmation,
// all run from the REAL programs-view.js source text.
//
// Why it matters:
//   - a picked exercise must land in the tray with usable defaults (3 sets of
//     10, equipment-appropriate rest) so committing without tweaking anything
//     still produces a sane program row;
//   - the tray row is a simple name + remove control on purpose: the old
//     in-tray steppers were removed (targets are edited on the program card),
//     so .tray-steppers must never come back;
//   - removing an exercise from a program is destructive and must go through
//     the confirmation modal.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Program, defaultRestForEquipment } from '../js/models/Program.js';
import { loadSource, buildMethods } from './helpers/source-extract.mjs';

// Dependency stub: the real helpers.escapeHtml escapes via a detached DOM
// element (document.createElement), unavailable under node. This mirrors
// exactly what textContent -> innerHTML escapes: & < >.
const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const src = loadSource('js/views/programs-view.js');

// ---------------------------------------------------------------------------
// Harness: real togglePickerExercise + renderExercisePickerTray against stubs
// ---------------------------------------------------------------------------

function makePicker(catalog) {
    const makeEl = (extra = {}) => ({
        hidden: false,
        innerHTML: '',
        textContent: '',
        attrs: {},
        classes: new Set(),
        classList: {
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); },
            toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
        },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        ...extra,
    });
    const wire = (el) => { el.classList._set = el.classes; return el; };
    const els = {
        'exercise-picker-tray': wire(makeEl({ hidden: true })),
        'exercise-picker-tray-list': wire(makeEl({ hidden: true })),
        // GT-17: the chip is a button that expands the list; its text lives in
        // a child span so the chevron icon survives a re-render.
        'exercise-picker-tray-count': wire(makeEl()),
        'exercise-picker-tray-count-text': wire(makeEl()),
    };
    const document = {
        getElementById: (id) => els[id] || null,
        // The picker card the toggle re-paints; absent in this harness (the
        // method guards with `if (card)`).
        querySelector: () => null,
    };
    const methods = buildMethods(
        src,
        ['togglePickerExercise', 'renderExercisePickerTray'],
        { document, defaultRestForEquipment, escapeHtml },
        'programs-view.js'
    );
    const view = Object.create(methods);
    view.app = { getExerciseById: (id) => catalog.find(e => e.id === id) || null };
    view.pickerSelection = new Map();
    return { view, els };
}

// -------------------------------------------------------
// Picker defaults
// -------------------------------------------------------

test('picker item: barbell exercise gets restSeconds=180 (defaultRestForEquipment)', () => {
    const { view } = makePicker([{ id: 3, name: 'Bench Press', equipment: 'barbell' }]);
    view.togglePickerExercise(3);
    const item = view.pickerSelection.get(3);
    assert.equal(item.restSeconds, defaultRestForEquipment('barbell'));
    assert.equal(item.restSeconds, 180);
    assert.equal(item.restAfterSeconds, 180);
});

test('picker item: bodyweight exercise gets restSeconds=60', () => {
    const { view } = makePicker([{ id: 99, name: 'Push-up', equipment: 'bodyweight' }]);
    view.togglePickerExercise(99);
    const item = view.pickerSelection.get(99);
    assert.equal(item.restSeconds, 60);
    assert.equal(item.restAfterSeconds, 60);
});

test('picker item: always has targetSets=3 and targetReps=10', () => {
    const { view } = makePicker([{ id: 1, name: 'Any', equipment: 'dumbbell' }]);
    view.togglePickerExercise(1);
    const item = view.pickerSelection.get(1);
    assert.equal(item.targetSets, 3);
    assert.equal(item.targetReps, 10);
});

test('picker toggle: picking again removes the exercise from the selection', () => {
    const { view } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.togglePickerExercise(5);
    assert.equal(view.pickerSelection.size, 1);
    view.togglePickerExercise(5);
    assert.equal(view.pickerSelection.size, 0, 'second tap deselects');
});

test('picker toggle: an unknown exercise id is ignored', () => {
    const { view } = makePicker([]);
    view.togglePickerExercise(12345);
    assert.equal(view.pickerSelection.size, 0);
});

test('picker item passed to addExercise produces a 3-set program exercise', () => {
    const { view } = makePicker([{ id: 3, name: 'Bench Press', equipment: 'barbell' }]);
    view.togglePickerExercise(3);
    const item = view.pickerSelection.get(3);
    const p = new Program({ name: 'Test' });
    p.addExercise(item.id, item.name, item.targetSets, item.targetReps, '', item.restSeconds, item.restAfterSeconds);
    assert.equal(p.exercises.length, 1);
    assert.equal(p.exercises[0].sets.length, 3, '3 sets created from default');
    p.exercises[0].sets.forEach(s => {
        assert.equal(s.repsMin, 10);
        assert.equal(s.repsMax, 10);
    });
    assert.equal(p.exercises[0].restSeconds, 180);
});

// -------------------------------------------------------
// Tray markup, as the real renderExercisePickerTray paints it
// -------------------------------------------------------

test('tray: a picked exercise renders a named row with a remove button', () => {
    const { view, els } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.togglePickerExercise(5);
    const html = els['exercise-picker-tray-list'].innerHTML;
    assert.ok(html.includes('class="tray-name"'), 'tray-name div present');
    assert.ok(html.includes('Squat'), 'exercise name present');
    assert.ok(html.includes('data-tray-action="remove"'), 'remove button present');
    assert.equal(els['exercise-picker-tray'].hidden, false, 'tray shown');
    assert.equal(els['exercise-picker-tray-count-text'].textContent, '1 added');
});

// ---------------------------------------------------------------------------
// GT-17: the tray must not eat the result list.
//
// With 8 exercises selected at 390x844 the expanded tray grew to 352px over a
// 717px sheet and left ZERO exercise cards fully visible, so building an
// 8-exercise program - the primary onboarding task - degraded to
// search-blind-tap-search. It now collapses to a count chip by default.
// ---------------------------------------------------------------------------

test('tray: starts collapsed, so the results list keeps its room', () => {
    const { view, els } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.pickerTrayExpanded = false;
    view.togglePickerExercise(5);
    assert.equal(els['exercise-picker-tray'].classes.has('is-collapsed'), true);
    assert.equal(els['exercise-picker-tray-list'].hidden, true, 'the list is not rendered open');
    assert.equal(els['exercise-picker-tray-count'].attrs['aria-expanded'], 'false');
});

test('tray: expanding shows the list and flips the control state', () => {
    const { view, els } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.togglePickerExercise(5);
    view.pickerTrayExpanded = true;
    view.renderExercisePickerTray();
    assert.equal(els['exercise-picker-tray'].classes.has('is-collapsed'), false);
    assert.equal(els['exercise-picker-tray-list'].hidden, false);
    assert.equal(els['exercise-picker-tray-count'].attrs['aria-expanded'], 'true');
});

test('tray: the count chip singularises and stays accurate as picks accumulate', () => {
    const catalog = Array.from({ length: 8 }, (_, i) => ({
        id: i + 1, name: `Exercise ${i + 1}`, equipment: 'barbell',
    }));
    const { view, els } = makePicker(catalog);
    view.togglePickerExercise(1);
    assert.equal(els['exercise-picker-tray-count-text'].textContent, '1 added');
    for (let id = 2; id <= 8; id++) view.togglePickerExercise(id);
    assert.equal(els['exercise-picker-tray-count-text'].textContent, '8 added');
    assert.equal(els['exercise-picker-tray-list'].hidden, true, 'still collapsed at 8');
});

test('tray: clearing the last pick hides the tray entirely', () => {
    const { view, els } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.togglePickerExercise(5);
    view.togglePickerExercise(5);
    assert.equal(els['exercise-picker-tray'].hidden, true);
});

test('tray: exercise names are HTML-escaped', () => {
    const { view, els } = makePicker([{ id: 8, name: 'Bench <img src=x onerror=alert(1)>', equipment: 'barbell' }]);
    view.togglePickerExercise(8);
    const html = els['exercise-picker-tray-list'].innerHTML;
    assert.ok(!html.includes('<img'), 'raw markup never lands in the tray');
    assert.ok(html.includes('&lt;img'), 'escaped form present');
});

test('tray: rows carry no steppers (targets are edited on the program card)', () => {
    const { view, els } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.togglePickerExercise(5);
    const html = els['exercise-picker-tray-list'].innerHTML;
    assert.ok(!html.includes('tray-steppers'), '.tray-steppers absent from row');
    assert.ok(!html.includes('data-tray-stepper'), 'stepper inputs absent from tray row');
});

test('tray: deselecting the last exercise hides the tray again', () => {
    const { view, els } = makePicker([{ id: 5, name: 'Squat', equipment: 'barbell' }]);
    view.togglePickerExercise(5);
    view.togglePickerExercise(5);
    assert.equal(els['exercise-picker-tray'].hidden, true);
    assert.equal(els['exercise-picker-tray-list'].innerHTML, '');
});

// -------------------------------------------------------
// Removing an exercise from the program requires confirmation
// -------------------------------------------------------

function makeRemover(confirmAnswer) {
    const calls = [];
    const showConfirmModal = async (opts) => { calls.push(opts); return confirmAnswer; };
    const methods = buildMethods(
        src,
        ['async removeExerciseFromProgram'],
        { showConfirmModal, escapeHtml },
        'programs-view.js'
    );
    const view = Object.create(methods);
    view.currentProgram = new Program({
        name: 'P',
        exercises: [{ exerciseId: 3, exerciseName: 'Bench Press', sets: [{ repsMin: 10, repsMax: 10 }], restSeconds: 90, restAfterSeconds: 90 }],
    });
    view.app = { getExerciseDisplayName: (_id, snapshot) => snapshot };
    view.renderProgramExercises = () => {};
    return { view, calls };
}

test('removeExerciseFromProgram: cancelling the confirm keeps the exercise', async () => {
    const { view, calls } = makeRemover(false);
    await view.removeExerciseFromProgram(0);
    assert.equal(calls.length, 1, 'confirmation modal was shown');
    assert.equal(calls[0].isDangerous, true, 'styled as a dangerous action');
    assert.equal(view.currentProgram.exercises.length, 1, 'exercise survives a cancel');
});

test('removeExerciseFromProgram: confirming removes the exercise', async () => {
    const { view } = makeRemover(true);
    await view.removeExerciseFromProgram(0);
    assert.equal(view.currentProgram.exercises.length, 0);
});
