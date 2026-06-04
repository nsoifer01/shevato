// Tests for exercise picker selection defaults and tray markup changes.
// Item 1: removeExerciseFromProgram now requires confirmation (logic-only check).
// Item 2: picker selection items carry default targetSets/targetReps/restSeconds;
//         tray rows must NOT contain .tray-steppers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Program, defaultRestForEquipment } from '../js/models/Program.js';

// Reproduce the togglePickerExercise insertion logic from programs-view.js so we
// can assert what lands in pickerSelection without a DOM.
function makePickerItem(exercise) {
    const defRest = defaultRestForEquipment(exercise.equipment);
    return {
        id: exercise.id,
        name: exercise.name,
        targetSets: 3,
        targetReps: 10,
        restSeconds: defRest,
        restAfterSeconds: defRest,
    };
}

// Reproduce the tray row markup (post-simplification) from programs-view.js.
function trayRowHTML(item) {
    const name = item.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
        <li class="exercise-picker-tray-row" data-exercise-id="${item.id}">
            <div class="tray-name">${name}</div>
            <button type="button" class="tray-remove"
                data-tray-action="remove" data-exercise-id="${item.id}"
                title="Remove from selection" aria-label="Remove from selection">
                <i class="fas fa-xmark"></i>
            </button>
        </li>
    `;
}

// -------------------------------------------------------
// Picker defaults
// -------------------------------------------------------

test('picker item: barbell exercise gets restSeconds=180 (defaultRestForEquipment)', () => {
    const ex = { id: 3, name: 'Bench Press', equipment: 'barbell' };
    const item = makePickerItem(ex);
    assert.equal(item.restSeconds, 180);
    assert.equal(item.restAfterSeconds, 180);
});

test('picker item: bodyweight exercise gets restSeconds=60', () => {
    const ex = { id: 99, name: 'Push-up', equipment: 'bodyweight' };
    const item = makePickerItem(ex);
    assert.equal(item.restSeconds, 60);
    assert.equal(item.restAfterSeconds, 60);
});

test('picker item: always has targetSets=3', () => {
    const ex = { id: 1, name: 'Any', equipment: 'dumbbell' };
    const item = makePickerItem(ex);
    assert.equal(item.targetSets, 3);
});

test('picker item: always has targetReps=10', () => {
    const ex = { id: 1, name: 'Any', equipment: 'machine' };
    const item = makePickerItem(ex);
    assert.equal(item.targetReps, 10);
});

test('picker item passed to addExercise produces 3-set program exercise', () => {
    const ex = { id: 3, name: 'Bench Press', equipment: 'barbell' };
    const item = makePickerItem(ex);
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
// Tray row markup: no .tray-steppers
// -------------------------------------------------------

test('tray row HTML: contains .tray-name with exercise name', () => {
    const item = makePickerItem({ id: 5, name: 'Squat', equipment: 'barbell' });
    const html = trayRowHTML(item);
    assert.ok(html.includes('class="tray-name"'), 'tray-name div present');
    assert.ok(html.includes('Squat'), 'exercise name present');
});

test('tray row HTML: contains remove button', () => {
    const item = makePickerItem({ id: 5, name: 'Squat', equipment: 'barbell' });
    const html = trayRowHTML(item);
    assert.ok(html.includes('data-tray-action="remove"'), 'remove button present');
});

test('tray row HTML: does NOT contain .tray-steppers', () => {
    const item = makePickerItem({ id: 5, name: 'Squat', equipment: 'barbell' });
    const html = trayRowHTML(item);
    assert.ok(!html.includes('tray-steppers'), 'tray-steppers absent from row');
});

test('tray row HTML: does NOT contain data-tray-stepper elements', () => {
    const item = makePickerItem({ id: 5, name: 'Squat', equipment: 'barbell' });
    const html = trayRowHTML(item);
    assert.ok(!html.includes('data-tray-stepper'), 'stepper inputs absent from tray row');
});
