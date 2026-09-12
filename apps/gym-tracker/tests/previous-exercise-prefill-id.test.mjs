/**
 * Previous-session prefill joins on `exerciseId`, so it must use `sameId`.
 *
 * Ids are generated numerically but do not stay numeric. A JSON export/import
 * round trip, a Firestore document read, and anything that has been through a
 * DOM `dataset` can all hand back `"37"` where the catalog holds `37`, and
 * `js/utils/import-sanitize.js` deliberately never coerces `exerciseId` (it
 * repairs dates, numbers and missing record ids, not join keys). The rest of
 * workout-view.js joins with `sameId` for exactly this reason; this one lookup
 * used `===` and failed silently: no prefilled weight or reps, no "same as
 * last time" chip, and an empty Last Time panel, on a lifter whose history was
 * perfectly intact.
 *
 * The method is lifted from the real source rather than mirrored
 * (tests/helpers/source-extract.mjs), so it moves with the implementation.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';
import { sameId } from '../js/utils/id-utils.js';

const src = loadSource('js/views/workout-view.js');

const methods = buildMethods(src, ['getPreviousExerciseData'], { sameId }, 'workout-view.js');

/** One finished session that logged `exerciseId` for 60 kg x 8 and 62.5 kg x 6. */
function sessionWith(exerciseId, sortTimestamp = '2026-09-01T18:00:00.000Z') {
    return {
        sortTimestamp,
        exercises: [{
            exerciseId,
            sets: [
                { weight: 60, reps: 8, duration: null, completed: true },
                { weight: 62.5, reps: 6, duration: null, completed: true },
            ],
        }],
    };
}

function viewWith(sessions) {
    const view = Object.create(methods);
    view.app = { workoutSessions: sessions };
    return view;
}

test('a numeric stored id prefills from a numeric lookup (the happy path)', () => {
    const sets = viewWith([sessionWith(37)]).getPreviousExerciseData(37);
    assert.deepEqual(sets, [
        { weight: 60, reps: 8, duration: null, originalWeight: 60 },
        { weight: 62.5, reps: 6, duration: null, originalWeight: 62.5 },
    ]);
});

test('a STRING stored id still prefills when looked up numerically', () => {
    // How this happens in the field: the lifter exported their data, imported
    // it on a new phone, and the ids came back as JSON strings.
    const sets = viewWith([sessionWith('37')]).getPreviousExerciseData(37);
    assert.ok(sets, 'history exists for this exercise, so prefill must find it');
    assert.equal(sets.length, 2);
    assert.equal(sets[0].weight, 60);
});

test('a numeric stored id still prefills when looked up with a string', () => {
    // And the mirror case: the id arrives from a dataset attribute.
    const sets = viewWith([sessionWith(37)]).getPreviousExerciseData('37');
    assert.ok(sets, 'history exists for this exercise, so prefill must find it');
    assert.equal(sets[1].reps, 6);
});

test('a genuinely different exercise still returns no prefill', () => {
    // sameId must not become "any id matches": 37 and 371 are different lifts.
    assert.equal(viewWith([sessionWith(37)]).getPreviousExerciseData(371), null);
    assert.equal(viewWith([sessionWith('37')]).getPreviousExerciseData('3'), null);
});

test('the most recent session wins regardless of id spelling', () => {
    const older = sessionWith('37', '2026-08-01T09:00:00.000Z');
    const newer = sessionWith(37, '2026-09-05T18:00:00.000Z');
    newer.exercises[0].sets = [{ weight: 70, reps: 5, duration: null, completed: true }];
    const sets = viewWith([older, newer]).getPreviousExerciseData('37');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].weight, 70);
});
