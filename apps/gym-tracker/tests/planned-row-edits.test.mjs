/**
 * A manual edit to an UNFINISHED set row is ACTIVE-SESSION STATE.
 *
 * The pre-existing defect: typing into a planned row wrote nowhere. The value
 * lived only in the DOM input, so committing any OTHER set re-rendered the
 * exercise and rebuilt the row from the previous-session prefill - editing
 * set 2 to 65x8 and then ticking set 1 silently restored 60x12.
 *
 * `recordPlannedRowEdit` is lifted from the real workout-view.js source (the
 * class is DOM-bound and cannot be imported under node), so these tests move
 * with the implementation instead of mirroring it.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';
import { toCanonicalWeight } from '../js/utils/units.js';

const src = loadSource('js/views/workout-view.js');

/** Independently computed: 65 x 0.45359237 and 60 x 0.45359237. */
const KG_65_LB = 29.48350405;
const KG_60_LB = 27.2155422;

function makeInput(cls, value) {
    return {
        value,
        classList: { contains: (c) => c === cls },
    };
}

/**
 * A planned row stub. `sel` lookups mirror the real markup: `.set-weight`,
 * `.set-reps`, `.duration-min`, `.duration-sec`, and `.exercise-entry` as the
 * closest ancestor carrying the exercise index in its id.
 */
function makeRow(slot, { weight, reps, min, sec, exerciseIndex = 0 } = {}) {
    const fields = {
        '.set-weight': weight === undefined ? null : makeInput('set-weight', weight),
        '.set-reps': reps === undefined ? null : makeInput('set-reps', reps),
        '.duration-min': min === undefined ? null : makeInput('duration-min', min),
        '.duration-sec': sec === undefined ? null : makeInput('duration-sec', sec),
    };
    return {
        dataset: { slot: String(slot) },
        querySelector: (sel) => fields[sel] ?? null,
        closest: (sel) => (sel === '.exercise-entry' ? { id: `exercise-${exerciseIndex}` } : null),
    };
}

/** A view with the real method bound to a stub session. */
function makeView(exercises, { unit = 'lb' } = {}) {
    const methods = buildMethods(src, ['recordPlannedRowEdit'], {}, 'workout-view.js');
    const view = Object.create(methods);
    view.currentWorkoutSession = { exercises };
    view.persisted = 0;
    view.persistActiveWorkoutSoon = () => { view.persisted += 1; };
    // The real toStoredWeight converts the session-unit input into canonical kg.
    view.toStoredWeight = (v) => toCanonicalWeight(v, unit) ?? 0;
    return view;
}

const exercise = () => ({ exerciseId: 21, sets: [], stickyValues: {} });

test('a weight edit lands in active-session state, CANONICAL', () => {
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(1, { weight: '65', reps: '8' }));

    assert.ok(Math.abs(ex.stickyValues[1].weight - KG_65_LB) < 1e-9,
        `65 lb should store as ${KG_65_LB}, got ${ex.stickyValues[1].weight}`);
    assert.equal(ex.stickyValues[1].reps, 8);
    assert.equal(view.persisted, 1, 'the edit must reach the persistence path');
});

test('a reps-only edit keeps the weight already captured', () => {
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(1, { weight: '60', reps: '12' }));
    view.recordPlannedRowEdit(makeRow(1, { weight: '60', reps: '5' }));

    assert.ok(Math.abs(ex.stickyValues[1].weight - KG_60_LB) < 1e-9);
    assert.equal(ex.stickyValues[1].reps, 5);
});

test('clearing a field is an edit too, and must not silently refill', () => {
    // A row the lifter deliberately emptied must stay empty through a
    // re-render rather than repopulating from last time.
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(0, { weight: '65', reps: '8' }));
    view.recordPlannedRowEdit(makeRow(0, { weight: '', reps: '' }));

    assert.equal(ex.stickyValues[0].weight, '');
    assert.equal(ex.stickyValues[0].reps, '');
});

test('a timed row stores whole seconds', () => {
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(1, { min: '1', sec: '45' }));
    assert.equal(ex.stickyValues[1].duration, 105);
});

test('a timed row with only seconds still works', () => {
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(0, { min: '0', sec: '30' }));
    assert.equal(ex.stickyValues[0].duration, 30);
});

test('editing one slot never touches another', () => {
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(0, { weight: '60', reps: '12' }));
    view.recordPlannedRowEdit(makeRow(2, { weight: '95', reps: '3' }));

    assert.ok(Math.abs(ex.stickyValues[0].weight - KG_60_LB) < 1e-9);
    assert.equal(ex.stickyValues[0].reps, 12);
    assert.equal(ex.stickyValues[2].reps, 3);
    assert.equal(ex.stickyValues[1], undefined, 'an untouched slot stays untouched');
});

test('editing one EXERCISE never touches another', () => {
    // The feel prompt firing on exercise B must not disturb exercise A.
    const a = exercise();
    const b = exercise();
    const view = makeView([a, b]);
    view.recordPlannedRowEdit(makeRow(1, { weight: '155', reps: '4', exerciseIndex: 0 }));
    view.recordPlannedRowEdit(makeRow(1, { weight: '60', reps: '12', exerciseIndex: 1 }));

    assert.equal(a.stickyValues[1].reps, 4);
    assert.equal(b.stickyValues[1].reps, 12);
});

test('a kg session stores the typed number unchanged', () => {
    const ex = exercise();
    const view = makeView([ex], { unit: 'kg' });
    view.recordPlannedRowEdit(makeRow(0, { weight: '60', reps: '10' }));
    assert.equal(ex.stickyValues[0].weight, 60);
});

test('an exercise with no stickyValues yet gets one', () => {
    const ex = { exerciseId: 21, sets: [] };   // legacy shape, no stickyValues
    const view = makeView([ex]);
    view.recordPlannedRowEdit(makeRow(0, { weight: '60', reps: '10' }));
    assert.ok(ex.stickyValues && ex.stickyValues[0]);
});

test('junk input is ignored rather than corrupting state', () => {
    const ex = exercise();
    const view = makeView([ex]);
    view.recordPlannedRowEdit(null);
    view.recordPlannedRowEdit({ dataset: {}, querySelector: () => null, closest: () => null });
    assert.deepEqual(ex.stickyValues, {});
    assert.equal(view.persisted, 0);
});

test('an edit against a missing exercise is a no-op', () => {
    const view = makeView([]);
    view.recordPlannedRowEdit(makeRow(0, { weight: '60', reps: '10', exerciseIndex: 7 }));
    assert.equal(view.persisted, 0);
});
