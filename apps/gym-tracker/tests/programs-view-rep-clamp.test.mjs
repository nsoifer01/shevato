// Mirror of ProgramsView.setRepValue (js/views/programs-view.js). Kept in sync
// by hand: the real method hangs off a DOM-bound class.
//
// What these tests pin: a rep value the user types is clamped to 1..100 before
// it reaches the model, and the FIELD the user just left must be rewritten with
// the clamped number. Before this fix only the sibling field was refreshed, so
// typing 250 and tabbing out left "250" on screen while the model held 100; the
// save wrote 100 and the next open of the editor showed a number the user had
// never seen. The rewrite is a targeted .value assignment on purpose: the change
// event fires on tab-out, and re-rendering #program-exercises-list would destroy
// the input being blurred and strand the browser's focus advance on a detached
// node.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fake inputs keyed the way the real selectors address them:
// [data-action="set-reps-min|max"][data-exercise-index][data-set-index]
function makeInputs(sets) {
    const inputs = {};
    sets.forEach((row, si) => {
        inputs[`min:0:${si}`] = { value: String(row.repsMin) };
        inputs[`max:0:${si}`] = { value: String(row.repsMax) };
    });
    return inputs;
}

function makeEditor(sets) {
    const program = { exercises: [{ sets: sets.map(s => ({ ...s })) }], updatedAt: null };
    const inputs = makeInputs(sets);

    function setRepValue(exerciseIndex, setIndex, minOrMax, rawValue) {
        const ex = program.exercises[exerciseIndex];
        if (!ex || !Array.isArray(ex.sets)) return;
        const row = ex.sets[setIndex];
        if (!row) return;
        const val = Math.max(1, Math.min(100, Math.round(Number(rawValue) || 1)));
        let siblingChanged = null;
        if (minOrMax === 'min') {
            const wasSingle = row.repsMin === row.repsMax;
            row.repsMin = val;
            if (wasSingle) {
                row.repsMax = val;
                siblingChanged = 'max';
            } else if (row.repsMax < row.repsMin) {
                row.repsMax = row.repsMin;
                siblingChanged = 'max';
            }
        } else {
            row.repsMax = val;
            if (row.repsMin > row.repsMax) {
                row.repsMin = row.repsMax;
                siblingChanged = 'min';
            }
        }
        program.updatedAt = new Date().toISOString();

        const repsInput = (kind) => inputs[`${kind}:${exerciseIndex}:${setIndex}`];
        const edited = repsInput(minOrMax);
        if (edited) edited.value = minOrMax === 'min' ? row.repsMin : row.repsMax;

        if (siblingChanged === 'max') {
            const maxInput = repsInput('max');
            if (maxInput) maxInput.value = row.repsMax;
        } else if (siblingChanged === 'min') {
            const minInput = repsInput('min');
            if (minInput) minInput.value = row.repsMin;
        }
    }

    // Simulate the user typing into a field and tabbing out (the change event).
    const type = (kind, si, typed) => {
        inputs[`${kind}:0:${si}`].value = String(typed);
        setRepValue(0, si, kind, Number(typed));
    };
    const shown = (kind, si = 0) => Number(inputs[`${kind}:0:${si}`].value);
    const model = (si = 0) => program.exercises[0].sets[si];

    return { type, shown, model };
}

test('rep clamp: a value over the max lands at 100 in the model AND in the field', () => {
    const ed = makeEditor([{ repsMin: 8, repsMax: 12 }]);
    ed.type('max', 0, 250);
    assert.equal(ed.model().repsMax, 100, 'model clamps to the max of 100');
    assert.equal(ed.shown('max'), 100, 'the edited field shows the clamped value, not "250"');
    assert.equal(ed.model().repsMin, 8, 'the untouched min is left alone');
});

test('rep clamp: a value under the min lands at 1 in the model AND in the field', () => {
    const ed = makeEditor([{ repsMin: 8, repsMax: 12 }]);
    ed.type('min', 0, 0);
    assert.equal(ed.model().repsMin, 1, 'model clamps up to the min of 1');
    assert.equal(ed.shown('min'), 1, 'the edited field shows 1, not "0"');
});

test('rep clamp: empty / non-numeric input falls back to 1 in the field', () => {
    const ed = makeEditor([{ repsMin: 8, repsMax: 12 }]);
    ed.type('min', 0, '');
    assert.equal(ed.model().repsMin, 1);
    assert.equal(ed.shown('min'), 1, 'a blanked field is refilled rather than left empty');
});

test('rep clamp: single mode keeps min and max in sync, in the model and both fields', () => {
    const ed = makeEditor([{ repsMin: 10, repsMax: 10 }]);
    ed.type('min', 0, 250);
    assert.equal(ed.model().repsMin, 100, 'min clamps');
    assert.equal(ed.model().repsMax, 100, 'max follows so the row stays a single target');
    assert.equal(ed.shown('min'), 100, 'the edited field shows the clamped value');
    assert.equal(ed.shown('max'), 100, 'the hidden sibling field stays in sync');
});

test('rep clamp: single mode with an in-range value still syncs both fields', () => {
    const ed = makeEditor([{ repsMin: 10, repsMax: 10 }]);
    ed.type('min', 0, 6);
    assert.equal(ed.model().repsMin, 6);
    assert.equal(ed.model().repsMax, 6);
    assert.equal(ed.shown('min'), 6);
    assert.equal(ed.shown('max'), 6);
});

test('rep clamp: a max dropped below the min pulls the min down in both places', () => {
    const ed = makeEditor([{ repsMin: 8, repsMax: 12 }]);
    ed.type('max', 0, 5);
    assert.equal(ed.model().repsMin, 5, 'min follows the lowered max');
    assert.equal(ed.model().repsMax, 5);
    assert.equal(ed.shown('min'), 5, 'the sibling field is refreshed');
    assert.equal(ed.shown('max'), 5, 'the edited field keeps the accepted value');
});

test('rep clamp: an in-range edit leaves the typed value untouched', () => {
    const ed = makeEditor([{ repsMin: 8, repsMax: 12 }]);
    ed.type('max', 0, 15);
    assert.equal(ed.model().repsMax, 15);
    assert.equal(ed.shown('max'), 15, 'no needless rewrite of a valid entry');
    assert.equal(ed.shown('min'), 8);
});

test('rep clamp: only the edited set row is touched', () => {
    const ed = makeEditor([{ repsMin: 8, repsMax: 12 }, { repsMin: 5, repsMax: 5 }]);
    ed.type('min', 0, 250);
    assert.equal(ed.model(1).repsMin, 5, 'the second set row is unchanged');
    assert.equal(ed.shown('min', 1), 5);
});
