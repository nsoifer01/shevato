// Rest steppers in the Edit Program modal.
//
// What these tests pin: a +/- click updates ONE stepper in place. It used to
// call renderProgramExercises(), which reassigns the whole
// #program-exercises-list innerHTML, so a single click on one card's rest "+"
// destroyed all seven cards and every control in them, and focus fell from the
// clicked button to <body>, so a user could not press "+" twice without
// re-aiming. Same story for the program-level "Rest duration" stepper, which
// rebuilt its own container. So:
//   - the model still does the clamping (Program.updateExercise -> 0..900),
//     the view only reads the normalized value back and displays it;
//   - repeated clicks must accumulate (five * +15 from 3m lands on 4:15, which
//     is only true if each click reads the CURRENT model value);
//   - the only DOM writes allowed are the value text and the disabled state of
//     the two buttons at the bounds. The value text node is mutated, never
//     replaced, so nothing under the pointer is torn down.
//
// syncStepperUI / adjustExerciseTarget / formatRestLabel are mirrored from
// js/views/programs-view.js by hand (the real ones hang off a DOM-bound class);
// keep them in sync. The clamping is NOT mirrored: the real Program model is
// imported so a change to its bounds fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Program } = await import('../js/models/Program.js');

// ---- mirrors of programs-view.js ---------------------------------------

function formatRestLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`;
}

function syncStepperUI(stepper, value, min, max, valueLabel = null) {
    if (!stepper) return;
    stepper.querySelector('.pex-stepper-value').firstChild.data = valueLabel ?? String(value);
    stepper.querySelectorAll('[data-stepper]').forEach(btn => {
        btn.disabled = Number(btn.dataset.delta) < 0 ? value <= min : value >= max;
    });
}

// ---- the stepper markup stepperHTML() emits, as objects ----------------

function fakeStepper(field, value, step = 15) {
    // <span class="pex-stepper-value">3m</span> is a single text node; the
    // buttons carry data-stepper / data-field / data-delta and start disabled
    // at the bounds.
    const textNode = { data: formatRestLabel(value) };
    const valueSpan = { firstChild: textNode, get textContent() { return textNode.data; } };
    const buttons = [-step, step].map(delta => ({
        dataset: { stepper: '', index: '0', field, delta: String(delta) },
        disabled: delta < 0 ? value <= 0 : value >= 900,
    }));
    return {
        field,
        textNode,
        buttons,
        minus: buttons[0],
        plus: buttons[1],
        shown: () => valueSpan.textContent,
        querySelector: (sel) => (sel === '.pex-stepper-value' ? valueSpan : null),
        querySelectorAll: (sel) => (sel === '[data-stepper]' ? buttons : []),
    };
}

// ---- the editor: one program, one stepper per rest field per exercise ---

function makeEditor(exercises) {
    const program = new Program({ name: 'Push', exercises });
    const steppers = program.exercises.flatMap((ex, i) => [
        Object.assign(fakeStepper('rest', ex.restSeconds), { index: i }),
        Object.assign(fakeStepper('restAfter', ex.restAfterSeconds), { index: i }),
    ]);
    const stepperFor = (index, field) => steppers.find(s => s.index === index && s.field === field);

    // Mirror of ProgramsView.adjustExerciseTarget.
    function adjustExerciseTarget(index, field, delta) {
        const ex = program.exercises[index];
        if (!ex) return;
        const key = field === 'rest' ? 'restSeconds' : field === 'restAfter' ? 'restAfterSeconds' : null;
        if (!key) return;
        program.updateExercise(index, { [key]: ex[key] + delta });
        const value = program.exercises[index][key];
        syncStepperUI(stepperFor(index, field), value, 0, 900, formatRestLabel(value));
    }

    // What a user click does: read the delta off the button that was pressed.
    const click = (index, field, sign, times = 1) => {
        for (let i = 0; i < times; i++) {
            const st = stepperFor(index, field);
            const btn = sign === '-' ? st.minus : st.plus;
            if (btn.disabled) continue; // a disabled button eats the click
            adjustExerciseTarget(index, field, Number(btn.dataset.delta));
        }
    };

    return {
        click,
        adjust: adjustExerciseTarget,
        stepper: stepperFor,
        shown: (index, field) => stepperFor(index, field).shown(),
        model: (index, field) => program.exercises[index][field === 'rest' ? 'restSeconds' : 'restAfterSeconds'],
    };
}

const oneExercise = [{ exerciseId: 'e1', exerciseName: 'Bench', restSeconds: 180, restAfterSeconds: 180, sets: [{ repsMin: 6, repsMax: 8 }] }];

// -------------------------------------------------------
// The value moves, and it accumulates across clicks
// -------------------------------------------------------

test('rest stepper: one "+" advances the model and the label together', () => {
    const ed = makeEditor(oneExercise);
    assert.equal(ed.shown(0, 'rest'), '3m');
    ed.click(0, 'rest', '+');
    assert.equal(ed.model(0, 'rest'), 195);
    assert.equal(ed.shown(0, 'rest'), '3:15', 'the displayed label is refreshed from the model');
});

test('rest stepper: five "+" clicks accumulate to 4:15, not 3:15', () => {
    // The regression this guards: each click must read the CURRENT model value.
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 5);
    assert.equal(ed.model(0, 'rest'), 255);
    assert.equal(ed.shown(0, 'rest'), '4:15');
});

test('rest stepper: "-" walks back down through the same values', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 2);
    ed.click(0, 'rest', '-', 3);
    assert.equal(ed.model(0, 'rest'), 165);
    assert.equal(ed.shown(0, 'rest'), '2:45');
});

// -------------------------------------------------------
// Bounds: clamped by the model, reflected by the buttons
// -------------------------------------------------------

test('rest stepper: the floor is the model\'s 0, and "-" disables there', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '-', 40); // 180 / 15 = 12 clicks reach 0, the rest are eaten
    assert.equal(ed.model(0, 'rest'), 0, 'Program.updateExercise clamps at 0');
    assert.equal(ed.shown(0, 'rest'), '0s');
    assert.equal(ed.stepper(0, 'rest').minus.disabled, true, 'cannot go lower');
    assert.equal(ed.stepper(0, 'rest').plus.disabled, false, 'can still go up');
});

test('rest stepper: the ceiling is the model\'s 900, and "+" disables there', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 70);
    assert.equal(ed.model(0, 'rest'), 900, 'Program.updateExercise clamps at 900');
    assert.equal(ed.shown(0, 'rest'), '15m');
    assert.equal(ed.stepper(0, 'rest').plus.disabled, true, 'cannot go higher');
    assert.equal(ed.stepper(0, 'rest').minus.disabled, false);
});

test('rest stepper: stepping back off a bound re-enables the button', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 70);
    ed.click(0, 'rest', '-');
    assert.equal(ed.model(0, 'rest'), 885);
    assert.equal(ed.shown(0, 'rest'), '14:45');
    assert.equal(ed.stepper(0, 'rest').plus.disabled, false, '"+" comes back as soon as there is room');
});

// -------------------------------------------------------
// Nothing beyond the one stepper is touched
// -------------------------------------------------------

test('rest stepper: the value text node is mutated, never replaced', () => {
    // Replacing it is what re-rendering did, and that is what dropped focus.
    const ed = makeEditor(oneExercise);
    const node = ed.stepper(0, 'rest').textNode;
    ed.click(0, 'rest', '+', 3);
    assert.equal(ed.stepper(0, 'rest').textNode, node, 'same text node instance');
    assert.equal(node.data, '3:45', 'and it carries the new label');
});

test('rest stepper: "Rest between sets" and "Rest after exercise" move independently', () => {
    const ed = makeEditor(oneExercise);
    ed.click(0, 'rest', '+', 2);
    ed.click(0, 'restAfter', '-', 2);
    assert.equal(ed.model(0, 'rest'), 210);
    assert.equal(ed.shown(0, 'rest'), '3:30');
    assert.equal(ed.model(0, 'restAfter'), 150);
    assert.equal(ed.shown(0, 'restAfter'), '2:30');
});

test('rest stepper: a click on one exercise leaves the other exercises alone', () => {
    const ed = makeEditor([
        ...oneExercise,
        { exerciseId: 'e2', exerciseName: 'Fly', restSeconds: 90, restAfterSeconds: 90, sets: [{ repsMin: 10, repsMax: 10 }] },
    ]);
    ed.click(1, 'rest', '+', 2);
    assert.equal(ed.model(1, 'rest'), 120);
    assert.equal(ed.shown(1, 'rest'), '2m');
    assert.equal(ed.model(0, 'rest'), 180, 'exercise 1 is untouched');
    assert.equal(ed.shown(0, 'rest'), '3m', 'and its stepper was never rewritten');
});

test('rest stepper: only the two rest fields are writable, and only real rows', () => {
    // The handler is delegated off data-field, so it must ignore anything that
    // is not one of the two rest fields instead of writing a junk key.
    const ed = makeEditor(oneExercise);
    ed.adjust(0, 'targetSets', 15);
    ed.adjust(9, 'rest', 15);
    assert.equal(ed.model(0, 'rest'), 180);
    assert.equal(ed.model(0, 'restAfter'), 180);
    assert.equal(ed.shown(0, 'rest'), '3m');
});

// -------------------------------------------------------
// Label formatting the stepper depends on
// -------------------------------------------------------

test('formatRestLabel: seconds, whole minutes, and m:ss', () => {
    assert.equal(formatRestLabel(0), '0s');
    assert.equal(formatRestLabel(45), '45s');
    assert.equal(formatRestLabel(60), '1m');
    assert.equal(formatRestLabel(90), '1:30');
    assert.equal(formatRestLabel(900), '15m');
});
