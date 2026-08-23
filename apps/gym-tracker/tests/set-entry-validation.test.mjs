// Live set-row validation (commit and edit share one parser).
//
// 2026-08-22 audit D1/D12: `commitPlannedSet` and `saveSetEdit` guarded reps
// with `!reps`, which a negative integer passes, so "60 x -3" was stored as a
// completed set and the session detail showed "VOLUME -240kg". The inputs'
// `min` attributes never applied because the commit is a button click, not a
// form submit. `parseInt` also silently turned "1e3" into 1 and "8.7" into 8.
//
// `parseSetEntry` is lifted from the REAL workout-view.js source, and the two
// methods are run with a DOM stub so the test proves the methods call it (a
// method that went back to `!reps` fails the negative-reps cases below).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunctions, buildMethods, loadSource } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');
const { parseSetEntry } = buildFunctions(src, ['parseSetEntry'], {}, 'workout-view.js');

test('parseSetEntry: reps must be an integer >= 1', () => {
    for (const reps of ['-3', '0', '-4', '8.7', '1e3', 'abc', '', ' ', 'Infinity']) {
        const r = parseSetEntry('60', reps);
        assert.equal(r.ok, false, `reps "${reps}" rejected`);
        assert.equal(r.field, 'reps');
        assert.ok(r.message.length > 0, 'carries a message for the inline error');
    }
    assert.deepEqual(parseSetEntry('60', '8'), { ok: true, weight: 60, reps: 8 });
    assert.deepEqual(parseSetEntry('60', ' 12 '), { ok: true, weight: 60, reps: 12 });
});

test('parseSetEntry: weight must be finite and >= 0 (0 is bodyweight work)', () => {
    for (const w of ['-1', '-0.5', 'abc', '', '1e400', 'NaN']) {
        const r = parseSetEntry(w, '8');
        assert.equal(r.ok, false, `weight "${w}" rejected`);
        assert.equal(r.field, 'weight');
    }
    assert.deepEqual(parseSetEntry('0', '10'), { ok: true, weight: 0, reps: 10 });
    assert.deepEqual(parseSetEntry('62.5', '8'), { ok: true, weight: 62.5, reps: 8 });
    assert.deepEqual(parseSetEntry('1e2', '8'), { ok: true, weight: 100, reps: 8 }, 'scientific weight is still a number');
});

/** Minimal DOM: the two inputs by id, a row that records the inline error. */
function makeDom(values) {
    const inputs = {};
    const attrs = {};
    const row = {
        classes: new Set(),
        classList: { add(c) { row.classes.add(c); }, remove(c) { row.classes.delete(c); } },
        children: [],
        querySelector(sel) { return sel === '.set-row-error' ? row.children[0] || null : null; },
        querySelectorAll() { return []; },
        appendChild(el) { row.children.push(el); },
    };
    const document = {
        getElementById(id) {
            if (!(id in values)) return null;
            if (!inputs[id]) {
                attrs[id] = {};
                inputs[id] = {
                    value: values[id],
                    focused: false,
                    setAttribute(k, v) { attrs[id][k] = v; },
                    removeAttribute(k) { delete attrs[id][k]; },
                    focus() { this.focused = true; },
                };
            }
            return inputs[id];
        },
        querySelector(sel) { return sel.includes('.set-row[data-slot=') ? row : null; },
        createElement() { return { setAttribute(k, v) { this[k] = v; }, textContent: '' }; },
        activeElement: null,
    };
    return { document, row, attrs, inputs };
}

const deps = (document) => ({
    document,
    parseSetEntry,
    Set: class { constructor(d) { Object.assign(this, d); } },
    HTMLElement: class {},
    showToast: () => { throw new Error('a toast is no longer the feedback channel'); },
    vibrate: () => {},
    AnalyticsService: { isSetPR: () => null },
    recordPrSupersede: () => {},
});

function makeView(document, methodNames) {
    const proto = buildMethods(src, methodNames, deps(document), 'workout-view.js');
    const exercise = { sets: [], targetSets: 3 };
    const view = Object.create(proto);
    Object.assign(view, {
        app: { settings: { vibrationAlerts: false }, workoutSessions: [] },
        currentWorkoutSession: { exercises: [exercise] },
        collapsedExercises: {}, _prevCompleteState: {}, sessionPrSlots: {},
        persistActiveWorkout() { view.persisted = (view.persisted || 0) + 1; },
        rerenderExercise() {}, announcePR() {}, maybeShowFeelPrompt() {},
        startRestForSet() {}, pulseRow() {}, maybeStartRestAfterCommit() {},
        toStoredWeight: (w) => w,
        findSetBySlot: (ex, slot) => ex.sets.find((s) => s.slot === slot) || null,
        rebuildSessionPrSlots() {}, _recomputeExerciseDerivedState() {},
    });
    return { view, exercise };
}

test('commitPlannedSet refuses negative and non-integer reps with an inline row error', () => {
    for (const reps of ['-3', '8.7', '1e3', '0']) {
        const { document, row, attrs, inputs } = makeDom({ 'weight-0-0': '60', 'reps-0-0': reps });
        const { view, exercise } = makeView(document, ['commitPlannedSet', 'showSetRowError', 'clearSetRowError']);
        try { view.commitPlannedSet(0, 0); } catch (e) {
            // The stubbed view stops at the first call outside the parse path;
            // a set must not have been appended before that point either way.
            if (exercise.sets.length) throw e;
        }
        assert.equal(exercise.sets.length, 0, `reps "${reps}" never reaches the session`);
        assert.ok(!view.persisted, 'nothing persisted');
        assert.ok(row.classes.has('set-row--invalid'), 'the row is marked invalid');
        assert.equal(attrs['reps-0-0']['aria-invalid'], 'true', 'the reps input is aria-invalid');
        assert.ok(inputs['reps-0-0'].focused, 'focus lands on the offending input');
        assert.ok(row.children[0].textContent.length > 0, 'an inline message is rendered');
    }
});

test('saveSetEdit refuses negative reps and negative weight without touching the set', () => {
    for (const [w, r, field] of [['60', '-4', 'reps'], ['-1', '8', 'weight'], ['60', '0', 'reps']]) {
        const { document, row, attrs } = makeDom({ 'edit-weight-0-0': w, 'edit-reps-0-0': r });
        const { view, exercise } = makeView(document, ['saveSetEdit', 'showSetRowError', 'clearSetRowError']);
        exercise.sets.push({ slot: 0, weight: 60, reps: 8, duration: 0, completed: true });
        view.saveSetEdit(0, 0);
        assert.deepEqual([exercise.sets[0].weight, exercise.sets[0].reps], [60, 8], `"${w} x ${r}" leaves the set alone`);
        assert.ok(!view.persisted);
        assert.ok(row.classes.has('set-row--invalid'));
        assert.equal(attrs[`edit-${field}-0-0`]['aria-invalid'], 'true', `the ${field} input is flagged`);
    }
});
