// Tests for Item 7: "how did it feel" marking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutExercise } from '../js/models/WorkoutExercise.js';
import { setReachesMaxReps, allSetsReachMax, previousSessionFeelForExercise, nextFeel, shouldShowFeelModal } from '../js/utils/exercise-feel.js';

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

// ---------------------------------------------------------------------------
// previousSessionFeelForExercise
//
// The smiley means "I marked this good LAST time". It lasts exactly one
// following workout and must be renewed. These cases are the owner's, stated
// verbatim, because the previous implementation returned the most recent
// 'good' ANYWHERE in history and the icon therefore never expired.
// ---------------------------------------------------------------------------

const TS = (s) => s.sortTimestamp;
/** A performed exercise entry: at least one completed set. */
const performed = (id, feel = null, weight = 60, reps = 10) => ({
    exerciseId: id, feel,
    sets: [{ weight, reps, duration: 0, completed: true, slot: 0 }],
});
const session = (sortTimestamp, exercises) => ({ sortTimestamp, completed: true, exercises });

test('A: good, then a session with no marking -> the smiley is gone', () => {
    // Workout A marked good; workout B did not. Workout C must show nothing.
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good')]),
        session('2026-08-08T18:00:00Z', [performed('e1', null)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null);
});

test('A: after only the good session, the very next workout DOES show it', () => {
    const sessions = [session('2026-08-01T18:00:00Z', [performed('e1', 'good')])];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), 'good');
});

test('B: heavier weight without an explicit good does not keep the smiley', () => {
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good', 60, 10)]),
        session('2026-08-08T18:00:00Z', [performed('e1', null, 80, 8)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null);
});

test('C: marking good again renews it', () => {
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good')]),
        session('2026-08-08T18:00:00Z', [performed('e1', 'good')]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), 'good');
});

test('D: an objectively better session without a marking still expires it', () => {
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good', 60, 8)]),
        session('2026-08-08T18:00:00Z', [performed('e1', null, 100, 12)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null);
});

test('it is the PREVIOUS session that counts, not the most recent good', () => {
    // The exact shape the old implementation got wrong: a good far back, then
    // three unmarked sessions. It used to keep returning 'good' for ever.
    const sessions = [
        session('2026-06-01T18:00:00Z', [performed('e1', 'good')]),
        session('2026-06-08T18:00:00Z', [performed('e1', null)]),
        session('2026-06-15T18:00:00Z', [performed('e1', null)]),
        session('2026-06-22T18:00:00Z', [performed('e1', null)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null);
});

test('session order in the array does not matter, only the timestamp', () => {
    const sessions = [
        session('2026-08-08T18:00:00Z', [performed('e1', null)]),
        session('2026-08-01T18:00:00Z', [performed('e1', 'good')]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null);
});

test('two workouts on the SAME DAY resolve by time of day', () => {
    const sessions = [
        session('2026-08-08T09:00:00Z', [performed('e1', 'good')]),
        session('2026-08-08T19:00:00Z', [performed('e1', null)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null,
        'the evening session is the previous one');
});

test('a legacy bad marking expires the smiley like any unmarked session', () => {
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good')]),
        session('2026-08-08T18:00:00Z', [performed('e1', 'bad')]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), null);
});

test('a session that did not perform the exercise is not "the previous one"', () => {
    // Skipping an exercise is not evidence about it, so the mark survives.
    const skipped = { exerciseId: 'e1', feel: null, sets: [{ weight: 60, reps: 0, completed: false, slot: 0 }] };
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good')]),
        session('2026-08-08T18:00:00Z', [skipped]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), 'good');
});

test('other exercises in the same session are ignored', () => {
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed('e1', 'good')]),
        session('2026-08-08T18:00:00Z', [performed('e2', null)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), 'good');
    assert.equal(previousSessionFeelForExercise(sessions, 'e2', TS), null);
});

test('ids compare through sameId: "21" and 21 are one exercise', () => {
    const sessions = [
        session('2026-08-01T18:00:00Z', [performed(21, 'good')]),
        session('2026-08-08T18:00:00Z', [performed('21', null)]),
    ];
    assert.equal(previousSessionFeelForExercise(sessions, '21', TS), null,
        'a string id from an export must not read as a different exercise');
    assert.equal(previousSessionFeelForExercise(sessions, 21, TS), null);
});

test('an unfinished session is not counted', () => {
    const inProgress = { sortTimestamp: '2026-08-08T18:00:00Z', completed: false,
        exercises: [performed('e1', null)] };
    const sessions = [session('2026-08-01T18:00:00Z', [performed('e1', 'good')]), inProgress];
    assert.equal(previousSessionFeelForExercise(sessions, 'e1', TS), 'good');
});

test('no history, unknown exercise and junk input are all null', () => {
    assert.equal(previousSessionFeelForExercise([], 'e1', TS), null);
    assert.equal(previousSessionFeelForExercise(null, 'e1', TS), null);
    assert.equal(previousSessionFeelForExercise([session('2026-08-01T18:00:00Z', [performed('e1', 'good')])], null, TS), null);
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
