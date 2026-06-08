// Tests for Item 4: re-syncing a paused session with an edited program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessionWithProgram } from '../js/utils/session-merge.js';

const makeSessionExercise = (p) => ({
    exerciseId: p.exerciseId,
    exerciseName: p.exerciseName,
    sets: [],
    targetSets: p.targetSets,
    targetReps: p.targetReps,
    restSeconds: p.restSeconds,
    restAfterSeconds: p.restAfterSeconds,
    groupId: p.groupId || null,
});

test('merge: exercise with committed sets is kept untouched', () => {
    const session = [
        { exerciseId: 'a', exerciseName: 'Squat', sets: [{ slot: 0, weight: 100, reps: 5 }], targetSets: 3, targetReps: 5 },
    ];
    const program = [
        { exerciseId: 'a', exerciseName: 'Squat (renamed)', targetSets: 5, targetReps: 8, restSeconds: 120, restAfterSeconds: 120 },
    ];
    const out = mergeSessionWithProgram(session, program, makeSessionExercise);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].sets, [{ slot: 0, weight: 100, reps: 5 }]);
    assert.equal(out[0].exerciseName, 'Squat'); // untouched
    assert.equal(out[0].targetSets, 3);
});

test('merge: target updates apply to exercises without committed sets', () => {
    const session = [
        { exerciseId: 'a', exerciseName: 'Bench', sets: [], targetSets: 3, targetReps: 10, restSeconds: 90, restAfterSeconds: 90 },
    ];
    const program = [
        { exerciseId: 'a', exerciseName: 'Bench Press', targetSets: 5, targetReps: 6, restSeconds: 150, restAfterSeconds: 150 },
    ];
    const out = mergeSessionWithProgram(session, program, makeSessionExercise);
    assert.equal(out[0].targetSets, 5);
    assert.equal(out[0].targetReps, 6);
    assert.equal(out[0].restSeconds, 150);
    assert.equal(out[0].exerciseName, 'Bench Press');
});

test('merge: program-added exercise is appended', () => {
    const session = [
        { exerciseId: 'a', exerciseName: 'Bench', sets: [], targetSets: 3, targetReps: 10 },
    ];
    const program = [
        { exerciseId: 'a', exerciseName: 'Bench', targetSets: 3, targetReps: 10, restSeconds: 90, restAfterSeconds: 90 },
        { exerciseId: 'b', exerciseName: 'Row', targetSets: 4, targetReps: 12, restSeconds: 60, restAfterSeconds: 60 },
    ];
    const out = mergeSessionWithProgram(session, program, makeSessionExercise);
    assert.equal(out.length, 2);
    assert.equal(out[1].exerciseId, 'b');
    assert.deepEqual(out[1].sets, []);
});

test('merge: removed exercise without committed sets is dropped', () => {
    const session = [
        { exerciseId: 'a', exerciseName: 'Bench', sets: [], targetSets: 3, targetReps: 10 },
        { exerciseId: 'b', exerciseName: 'Row', sets: [], targetSets: 3, targetReps: 10 },
    ];
    const program = [
        { exerciseId: 'a', exerciseName: 'Bench', targetSets: 3, targetReps: 10, restSeconds: 90, restAfterSeconds: 90 },
    ];
    const out = mergeSessionWithProgram(session, program, makeSessionExercise);
    assert.equal(out.length, 1);
    assert.equal(out[0].exerciseId, 'a');
});

test('merge: removed exercise WITH committed sets survives', () => {
    const session = [
        { exerciseId: 'b', exerciseName: 'Row', sets: [{ slot: 0, weight: 50, reps: 12 }], targetSets: 3, targetReps: 10 },
    ];
    const program = [
        { exerciseId: 'a', exerciseName: 'Bench', targetSets: 3, targetReps: 10, restSeconds: 90, restAfterSeconds: 90 },
    ];
    const out = mergeSessionWithProgram(session, program, makeSessionExercise);
    // b survives (has sets) + a is appended.
    const ids = out.map(e => e.exerciseId).sort();
    assert.deepEqual(ids, ['a', 'b']);
    const b = out.find(e => e.exerciseId === 'b');
    assert.equal(b.sets.length, 1);
});

test('merge: does not mutate inputs', () => {
    const session = [{ exerciseId: 'a', exerciseName: 'Bench', sets: [], targetSets: 3, targetReps: 10 }];
    const program = [{ exerciseId: 'a', exerciseName: 'Bench Press', targetSets: 5, targetReps: 6, restSeconds: 150, restAfterSeconds: 150 }];
    const sessionCopy = JSON.parse(JSON.stringify(session));
    mergeSessionWithProgram(session, program, makeSessionExercise);
    assert.deepEqual(session, sessionCopy);
});
