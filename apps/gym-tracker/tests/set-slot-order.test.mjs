/**
 * A set's NUMBER is its `slot`, not its position in `exercise.sets` (audit G-3).
 *
 * The live workout addresses set rows by `set.slot`: `commitPlannedSet`
 * APPENDS the new set to the dense array and `deleteSet` SPLICES by slot. So
 * the array is in commit order, and the two orders part company after the most
 * ordinary correction there is (un-tick set 2 to fix a typo, tick it again) or
 * when the lifter simply ticks set 3 before set 2. `deleteSet`, the renderer
 * and the CSV export already read the slot. Two readers did not:
 *
 *   - previous-session prefill handed planned row `i` the i-th COMPLETED set in
 *     array order, so after a re-tick set 2 was prefilled from last time's set 3
 *     and set 3 from set 2, and the "same as last time" chip compared against
 *     the wrong set;
 *   - the history session detail numbered rows by array index, so it called a
 *     set "Set 3" that the CSV export of the same session called "Set 2".
 *
 * The methods are lifted from the real source (tests/helpers/source-extract.mjs).
 * Both orders are covered: a reordered session must follow the slots, and an
 * ordinary in-order session must come out exactly as it always did.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';
import { sameId } from '../js/utils/id-utils.js';
import * as sessionMetrics from '../js/utils/session-metrics.js';
import { displayWeight, formatDurationLong, normalizeWeightUnit, volumeIn } from '../js/utils/units.js';
import { buildSetsCsv, escapeHtml } from '../js/utils/helpers.js';

const { completedSetsInSlotOrder } = sessionMetrics;

const set = (slot, weight, reps = 8) => ({ weight, reps, duration: 0, completed: true, slot });

/**
 * Last session: set 1 at 60, set 2 at 65, set 3 at 70. Then set 2 was
 * un-ticked (spliced out) and ticked again (appended), so the stored array is
 * slot order 0, 2, 1.
 */
const REORDERED = [set(0, 60), set(2, 70), set(1, 65)];
/** The same three sets logged in order: array order IS slot order. */
const IN_ORDER = [set(0, 60), set(1, 65), set(2, 70)];

// ---------------------------------------------------------------------------
// The shared helper
// ---------------------------------------------------------------------------

test('completedSetsInSlotOrder: sets come back in slot order with their slot', () => {
    const out = completedSetsInSlotOrder({ sets: REORDERED });
    assert.deepEqual(out.map(({ slot }) => slot), [0, 1, 2]);
    assert.deepEqual(out.map(({ set: s }) => s.weight), [60, 65, 70]);
});

test('completedSetsInSlotOrder: an in-order exercise is returned untouched', () => {
    const out = completedSetsInSlotOrder({ sets: IN_ORDER });
    assert.deepEqual(out.map(({ set: s }) => s), IN_ORDER);
    assert.deepEqual(out.map(({ slot }) => slot), [0, 1, 2]);
});

test('completedSetsInSlotOrder: a legacy set with no slot keeps its array position', () => {
    // Pre-2.0 sessions carry no slot; the renderer, deleteSet and the CSV all
    // fall back to the array index, and so must this.
    const legacy = [
        { weight: 50, reps: 5, completed: true },
        { weight: 55, reps: 5, completed: true },
    ];
    const out = completedSetsInSlotOrder({ sets: legacy });
    assert.deepEqual(out.map(({ slot }) => slot), [0, 1]);
    assert.deepEqual(out.map(({ set: s }) => s.weight), [50, 55]);
});

test('completedSetsInSlotOrder: uncompleted rows and missing sets are skipped', () => {
    const out = completedSetsInSlotOrder({ sets: [set(0, 60), { ...set(1, 65), completed: false }, set(2, 70)] });
    assert.deepEqual(out.map(({ slot }) => slot), [0, 2]);
    assert.deepEqual(completedSetsInSlotOrder({}), []);
    assert.deepEqual(completedSetsInSlotOrder(null), []);
});

// ---------------------------------------------------------------------------
// Previous-session prefill (workout-view.js getPreviousExerciseData)
// ---------------------------------------------------------------------------

const workoutSrc = loadSource('js/views/workout-view.js');
const prefillMethods = buildMethods(workoutSrc, ['getPreviousExerciseData'], {
    sameId,
    completedSetsInSlotOrder,
}, 'workout-view.js');

function previousSetsFor(sets) {
    const view = Object.create(prefillMethods);
    view.app = {
        workoutSessions: [{
            sortTimestamp: '2026-09-10T18:00:00.000Z',
            exercises: [{ exerciseId: 3, sets }],
        }],
    };
    return view.getPreviousExerciseData(3);
}

test('prefill: after an un-tick + re-tick, set 2 still prefills from set 2', () => {
    const prev = previousSetsFor(REORDERED);
    // The renderer reads previousSets[i] for planned row i.
    assert.equal(prev[0].weight, 60, 'set 1 from set 1');
    assert.equal(prev[1].weight, 65, 'set 2 from last time\'s set 2 (65), not set 3');
    assert.equal(prev[2].weight, 70, 'set 3 from last time\'s set 3 (70), not set 2');
    // The renderer's "more sets than last time" fallback reads the last entry.
    assert.equal(prev[prev.length - 1].weight, 70, 'the fallback is the last set of the exercise');
});

test('prefill: sets ticked out of order (3 before 2) follow the set numbers', () => {
    const prev = previousSetsFor([set(0, 60), set(2, 70, 6), set(1, 65, 7)]);
    assert.deepEqual(prev.map(p => [p.weight, p.reps]), [[60, 8], [65, 7], [70, 6]]);
});

test('prefill: an in-order session is exactly what it always was', () => {
    assert.deepEqual(previousSetsFor(IN_ORDER), [
        { weight: 60, reps: 8, duration: 0, originalWeight: 60 },
        { weight: 65, reps: 8, duration: 0, originalWeight: 65 },
        { weight: 70, reps: 8, duration: 0, originalWeight: 70 },
    ]);
});

test('prefill: a set skipped last time gives that row no match, so it takes the fallback', () => {
    // Last time set 1 was never logged (sets 2 and 3 were). Set 2 must still
    // come from set 2, and row 1 falls back to the last set, the same rule the
    // renderer applies when last time had fewer sets.
    const prev = previousSetsFor([set(1, 65), set(2, 70)]);
    assert.equal(prev[0], undefined, 'last time had no set 1');
    assert.equal(prev[1].weight, 65);
    assert.equal(prev[2].weight, 70);
    assert.equal(prev[prev.length - 1].weight, 70);
});

// ---------------------------------------------------------------------------
// History session detail (history-view.js showWorkoutDetails)
// ---------------------------------------------------------------------------

const historySrc = loadSource('js/views/history-view.js');

function renderDetail(sets) {
    const content = { innerHTML: '' };
    const modal = {
        classList: { add() {} },
        querySelector: (sel) => (sel === '.modal-body' ? { appendChild() {} } : null),
    };
    const elements = {
        'workout-detail-modal': modal,
        'workout-detail-title': { textContent: '' },
        'workout-detail-content': content,
    };
    const methods = buildMethods(historySrc, ['showWorkoutDetails'], {
        sameId,
        normalizeWeightUnit,
        displayWeight,
        volumeIn,
        formatDurationLong,
        escapeHtml,
        performedExerciseCount: sessionMetrics.performedExerciseCount,
        sessionTimedSeconds: sessionMetrics.sessionTimedSeconds,
        completedSetsInSlotOrder,
        formatSessionDateTime: () => 'Sep 10',
        trapModalFocus: () => {},
        document: {
            getElementById: (id) => elements[id] || null,
            createElement: () => ({ addEventListener() {} }),
        },
    }, 'history-view.js');
    const view = Object.create(methods);
    const session = {
        id: 1,
        workoutDayName: 'Push',
        duration: 50,
        totalVolume: 1560,
        totalSets: sets.length,
        exercises: [{ exerciseId: 3, exerciseName: 'Bench Press', sets }],
    };
    view.app = {
        workoutSessions: [session],
        settings: { weightUnit: 'kg' },
        getExerciseById: () => null,
    };
    view.buildExerciseTrendChart = () => '';
    view.showWorkoutDetails(1);
    // [set label, weight cell] per table row.
    const rows = [...content.innerHTML.matchAll(/<tr><td>(\d+)<\/td>\s*<td>([\d.,]+)kg<\/td>/g)]
        .map(m => [Number(m[1]), Number(m[2])]);
    return { rows, session };
}

test('history detail: rows are numbered and ordered by set, matching the CSV export', () => {
    const { rows, session } = renderDetail(REORDERED);
    assert.deepEqual(rows, [[1, 60], [2, 65], [3, 70]],
        'Set 2 is the 65 kg set, in the order the lifter did them');

    // The CSV export of the same session already numbers by slot. The two
    // exports must agree on which set was "Set 2".
    const csvSetTwo = buildSetsCsv([{ date: '2026-09-10', ...session }], 'kg').csv
        .split('\r\n').slice(1).map(line => line.split(','))
        .find(cells => cells[3] === '2');
    assert.equal(Number(csvSetTwo[4]), 65);
});

test('history detail: an in-order session renders exactly as before', () => {
    assert.deepEqual(renderDetail(IN_ORDER).rows, [[1, 60], [2, 65], [3, 70]]);
});
