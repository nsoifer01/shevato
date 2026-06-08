// Tests for Item 7: "how did it feel" marking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutExercise } from '../js/models/WorkoutExercise.js';
import { setReachesMaxReps, allSetsReachMax, latestFeelForExercise, nextFeel, shouldShowFeelModal } from '../js/utils/exercise-feel.js';

// -------------------------------------------------------
// WorkoutExercise.feel round-trip
// -------------------------------------------------------

test('WorkoutExercise: feel defaults to null', () => {
    const ex = new WorkoutExercise({ exerciseId: 'e1' });
    assert.equal(ex.feel, null);
});

test('WorkoutExercise: feel round-trips through toJSON/fromJSON', () => {
    // 'good' is the only value produced now, but legacy 'bad' must survive a
    // round-trip so existing saved sessions are not corrupted on load.
    for (const feel of ['good', 'bad']) {
        const ex = new WorkoutExercise({ exerciseId: 'e1', feel });
        const back = WorkoutExercise.fromJSON(ex.toJSON());
        assert.equal(back.feel, feel);
    }
});

test('WorkoutExercise: invalid feel coerces to null', () => {
    const ex = new WorkoutExercise({ exerciseId: 'e1', feel: 'meh' });
    assert.equal(ex.feel, null);
});

// -------------------------------------------------------
// setReachesMaxReps
// -------------------------------------------------------

test('setReachesMaxReps: true at or above the slot max', () => {
    assert.equal(setReachesMaxReps({ reps: 10 }, 10), true);
    assert.equal(setReachesMaxReps({ reps: 12 }, 10), true);
});

test('setReachesMaxReps: false below the slot max', () => {
    assert.equal(setReachesMaxReps({ reps: 8 }, 10), false);
});

test('setReachesMaxReps: duration sets are skipped', () => {
    assert.equal(setReachesMaxReps({ reps: 0, duration: 60 }, 10), false);
});

// -------------------------------------------------------
// allSetsReachMax — strict gating (Item R2-4)
// -------------------------------------------------------

// A rep range 8-12 across 3 sets: max per slot is 12.
const max12 = () => 12;

test('allSetsReachMax: 12/12/12 over 3 sets qualifies', () => {
    const sets = [{ reps: 12 }, { reps: 12 }, { reps: 12 }];
    assert.equal(allSetsReachMax(sets, 3, max12), true);
});

test('allSetsReachMax: 12/12/11 over 3 sets does NOT qualify (one below max)', () => {
    const sets = [{ reps: 12 }, { reps: 12 }, { reps: 11 }];
    assert.equal(allSetsReachMax(sets, 3, max12), false);
});

test('allSetsReachMax: fewer than target sets does not qualify', () => {
    const sets = [{ reps: 12 }, { reps: 12 }];
    assert.equal(allSetsReachMax(sets, 3, max12), false);
});

test('allSetsReachMax: above max still qualifies (>= max)', () => {
    const sets = [{ reps: 13 }, { reps: 12 }, { reps: 14 }];
    assert.equal(allSetsReachMax(sets, 3, max12), true);
});

test('allSetsReachMax: singular target 5/5/5 qualifies, 5/5/4 does not', () => {
    const max5 = () => 5;
    assert.equal(allSetsReachMax([{ reps: 5 }, { reps: 5 }, { reps: 5 }], 3, max5), true);
    assert.equal(allSetsReachMax([{ reps: 5 }, { reps: 5 }, { reps: 4 }], 3, max5), false);
});

test('allSetsReachMax: any duration set disqualifies the whole exercise', () => {
    const sets = [{ reps: 12 }, { reps: 12 }, { reps: 0, duration: 60 }];
    assert.equal(allSetsReachMax(sets, 3, max12), false);
});

test('allSetsReachMax: per-slot max resolved independently per set', () => {
    // Slot 0 max 10, slots 1+ max 12.
    const slotMax = (set, i) => (i === 0 ? 10 : 12);
    assert.equal(allSetsReachMax([{ reps: 10 }, { reps: 12 }, { reps: 12 }], 3, slotMax), true);
    assert.equal(allSetsReachMax([{ reps: 9 }, { reps: 12 }, { reps: 12 }], 3, slotMax), false);
});

test('allSetsReachMax: targetSets defaults to >= 1', () => {
    assert.equal(allSetsReachMax([{ reps: 12 }], 1, max12), true);
    assert.equal(allSetsReachMax([], 1, max12), false);
});

// -------------------------------------------------------
// latestFeelForExercise
// -------------------------------------------------------

test('latestFeelForExercise: returns most recent non-null feel', () => {
    const sessions = [
        {
            completed: true,
            sortTimestamp: '2026-01-01T10:00:00Z',
            exercises: [{ exerciseId: 'e1', feel: 'bad' }],
        },
        {
            completed: true,
            sortTimestamp: '2026-03-01T10:00:00Z',
            exercises: [{ exerciseId: 'e1', feel: 'good' }],
        },
        {
            completed: true,
            sortTimestamp: '2026-02-01T10:00:00Z',
            exercises: [{ exerciseId: 'e1', feel: 'bad' }],
        },
    ];
    assert.equal(latestFeelForExercise(sessions, 'e1', s => s.sortTimestamp), 'good');
});

test('latestFeelForExercise: null when no marking exists', () => {
    const sessions = [
        { completed: true, sortTimestamp: '2026-01-01', exercises: [{ exerciseId: 'e1', feel: null }] },
        { completed: true, sortTimestamp: '2026-02-01', exercises: [{ exerciseId: 'e2', feel: 'good' }] },
    ];
    assert.equal(latestFeelForExercise(sessions, 'e1', s => s.sortTimestamp), null);
});

test('latestFeelForExercise: ignores sessions without the exercise', () => {
    const sessions = [
        { completed: true, sortTimestamp: '2026-02-01', exercises: [{ exerciseId: 'e9', feel: 'good' }] },
    ];
    assert.equal(latestFeelForExercise(sessions, 'e1', s => s.sortTimestamp), null);
});

test('latestFeelForExercise: legacy bad-only history yields null (no gray icon)', () => {
    const sessions = [
        { completed: true, sortTimestamp: '2026-01-01', exercises: [{ exerciseId: 'e1', feel: 'bad' }] },
        { completed: true, sortTimestamp: '2026-02-01', exercises: [{ exerciseId: 'e1', feel: 'bad' }] },
    ];
    assert.equal(latestFeelForExercise(sessions, 'e1', s => s.sortTimestamp), null);
});

test('latestFeelForExercise: a newer bad does not override an older good', () => {
    const sessions = [
        { completed: true, sortTimestamp: '2026-01-01', exercises: [{ exerciseId: 'e1', feel: 'good' }] },
        { completed: true, sortTimestamp: '2026-03-01', exercises: [{ exerciseId: 'e1', feel: 'bad' }] },
    ];
    assert.equal(latestFeelForExercise(sessions, 'e1', s => s.sortTimestamp), 'good');
});

// -------------------------------------------------------
// Item R3-4: feel cycle (header icon) + once-per-session modal bookkeeping
// -------------------------------------------------------

test('nextFeel: toggles good <-> none (never bad)', () => {
    assert.equal(nextFeel('good'), null);
    assert.equal(nextFeel(null), 'good');
    assert.equal(nextFeel(undefined), 'good');
    // Legacy 'bad' is treated as "not good", so toggling it marks 'good'.
    assert.equal(nextFeel('bad'), 'good');
});

test('shouldShowFeelModal: only when reaches-max and not already shown', () => {
    const shown = {};
    // Not reaching max: never show.
    assert.equal(shouldShowFeelModal(shown, 0, false), false);
    // Reaches max, not yet shown: show.
    assert.equal(shouldShowFeelModal(shown, 0, true), true);
    // Caller marks it shown; second satisfaction must NOT re-show.
    shown[0] = true;
    assert.equal(shouldShowFeelModal(shown, 0, true), false);
    // A different exercise index is independent.
    assert.equal(shouldShowFeelModal(shown, 1, true), true);
});
