// Session metrics: what counts as work (GT-04, GT-14, GT-23, GT-33).
//
// GT-04: `Set.volume` returned `duration` for a timed set, and
// `WorkoutSession.totalVolume` summed all set volumes, so a 60-second plank
// contributed "60 kg" to the finish summary, the completion burst, History,
// the session detail, the Home weekly tile, Insights ("Core 300 kg") and the
// CSV `volume` column under `unit=kg`. Seconds are not kilograms.
//
// GT-23: a session lists every PLANNED exercise, so a session where one of
// eight was skipped still rendered "EXERCISES 8" over seven exercise blocks.
//
// GT-14: "Remove logged history" could strip a session's last completed set
// and leave a `0 kg / 0 sets` husk that still counted as a workout everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Set as GymSet, setTimedSeconds, setVolume } from '../js/models/Set.js';
import { WorkoutExercise } from '../js/models/WorkoutExercise.js';
import { WorkoutSession } from '../js/models/WorkoutSession.js';
import {
    completedSetCount,
    completedSets,
    hasTimedWork,
    isLoggedSession,
    performedExerciseCount,
    sessionTimedSeconds,
    sessionVolumeKg,
} from '../js/utils/session-metrics.js';
import { pluralize, pluralLabel } from '../js/utils/helpers.js';

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

test('a reps set has weight-volume and no time', () => {
    const s = new GymSet({ weight: 60, reps: 10, completed: true });
    assert.equal(s.volume, 600);
    assert.equal(s.timedSeconds, 0);
    assert.equal(s.isTimed, false);
});

test('a timed set has time and NO weight-volume', () => {
    const s = new GymSet({ duration: 60, completed: true });
    assert.equal(s.volume, 0, 'a 60-second plank is not 60 kg');
    assert.equal(s.timedSeconds, 60);
    assert.equal(s.isTimed, true);
});

test('the plain-object helpers agree with the model', () => {
    assert.equal(setVolume({ weight: 60, reps: 10 }), 600);
    assert.equal(setVolume({ duration: 60 }), 0);
    assert.equal(setTimedSeconds({ duration: 60 }), 60);
    assert.equal(setTimedSeconds({ weight: 60, reps: 10 }), 0);
    assert.equal(setVolume(null), 0);
});

// ---------------------------------------------------------------------------
// The audit's exact session
// ---------------------------------------------------------------------------

/** 13,210 kg of reps work plus planks of 1:00, 0:45 and 0:30 (135 s). */
function auditSession() {
    return new WorkoutSession({
        id: 1,
        date: '2026-08-19',
        exercises: [
            new WorkoutExercise({
                exerciseId: 3,
                exerciseName: 'Barbell Bench Press',
                sets: [{ weight: 1321, reps: 10, completed: true, slot: 0 }],
            }),
            new WorkoutExercise({
                exerciseId: 463,
                exerciseName: 'Plank',
                sets: [
                    { duration: 60, completed: true, slot: 0 },
                    { duration: 45, completed: true, slot: 1 },
                    { duration: 30, completed: true, slot: 2 },
                ],
            }),
        ],
    });
}

test('the audit\'s session reports 13,210 kg, not 13,345', () => {
    const s = auditSession();
    assert.equal(s.totalVolume, 13210, 'the 135 plank seconds are not kilograms');
    assert.equal(s.totalTimedSeconds, 135, 'and they are reported, separately, as time');
});

test('a plank-only exercise contributes zero weight volume', () => {
    const ex = new WorkoutExercise({
        exerciseId: 463,
        sets: [{ duration: 60, completed: true }, { duration: 240, completed: true }],
    });
    assert.equal(ex.totalVolume, 0);
    assert.equal(ex.totalTimedSeconds, 300, 'the "Core 300 kg" from Insights was 300 SECONDS');
});

test('sessionVolumeKg / sessionTimedSeconds work on raw stored objects too', () => {
    const raw = JSON.parse(JSON.stringify(auditSession().toJSON()));
    assert.equal(sessionVolumeKg(raw), 13210);
    assert.equal(sessionTimedSeconds(raw), 135);
    assert.equal(hasTimedWork(raw), true);
});

// ---------------------------------------------------------------------------
// GT-23: counting exercises that were actually performed
// ---------------------------------------------------------------------------

test('performedExerciseCount counts exercises with at least one completed set', () => {
    const session = {
        exercises: [
            { sets: [{ weight: 60, reps: 10, completed: true }] },
            { sets: [] },                                       // planned, never touched
            { sets: [{ weight: 40, reps: 8, completed: false }] }, // typed, never committed
            { sets: [{ duration: 60, completed: true }] },
        ],
    };
    assert.equal(session.exercises.length, 4);
    assert.equal(performedExerciseCount(session), 2, 'the header must not say 4');
});

test('the model getter agrees with the helper', () => {
    const s = new WorkoutSession({
        exercises: [
            { exerciseId: 1, sets: [{ weight: 60, reps: 10, completed: true }] },
            { exerciseId: 2, sets: [] },
        ],
    });
    assert.equal(s.performedExerciseCount, 1);
    assert.equal(performedExerciseCount(s), 1);
});

test('completedSets / completedSetCount ignore uncommitted rows', () => {
    const session = {
        exercises: [{
            sets: [
                { weight: 60, reps: 10, completed: true },
                { weight: 60, reps: 10, completed: false },
            ],
        }],
    };
    assert.equal(completedSetCount(session), 1);
    assert.equal(completedSets(session).length, 1);
});

// ---------------------------------------------------------------------------
// GT-14: what is and is not a workout
// ---------------------------------------------------------------------------

test('a session with zero completed sets is NOT a workout', () => {
    // Precisely the husk the audit found: 0 kg, 8 exercises, 0 sets, still
    // counted in the weekly tile, the streak, the calendar and the month.
    const husk = { id: 1, date: '2026-08-19', exercises: Array.from({ length: 8 }, () => ({ sets: [] })) };
    assert.equal(isLoggedSession(husk), false);
    assert.equal(sessionVolumeKg(husk), 0);
    assert.equal(performedExerciseCount(husk), 0);
});

test('one completed set anywhere is enough to be a workout', () => {
    const session = {
        exercises: [{ sets: [] }, { sets: [{ weight: 40, reps: 10, completed: true }] }],
    };
    assert.equal(isLoggedSession(session), true);
});

test('a timed-only session is a workout even though it has no volume', () => {
    const session = { exercises: [{ sets: [{ duration: 120, completed: true }] }] };
    assert.equal(isLoggedSession(session), true, 'a five-minute plank session is training');
    assert.equal(sessionVolumeKg(session), 0);
});

test('isLoggedSession survives malformed records', () => {
    assert.equal(isLoggedSession(null), false);
    assert.equal(isLoggedSession({}), false);
    assert.equal(isLoggedSession({ exercises: null }), false);
});

// ---------------------------------------------------------------------------
// GT-33: "1 sets" / "1 exercises"
// ---------------------------------------------------------------------------

test('pluralize inflects the noun with its count', () => {
    assert.equal(pluralize(1, 'set'), '1 set');
    assert.equal(pluralize(0, 'set'), '0 sets');
    assert.equal(pluralize(2, 'set'), '2 sets');
    assert.equal(pluralize(1, 'exercise'), '1 exercise');
    assert.equal(pluralize(9, 'exercise'), '9 exercises');
});

test('pluralize takes an explicit plural for irregular nouns', () => {
    assert.equal(pluralize(1, 'entry', 'entries'), '1 entry');
    assert.equal(pluralize(4, 'entry', 'entries'), '4 entries');
});

test('pluralLabel returns just the noun, for label/value layouts', () => {
    assert.equal(pluralLabel(1, 'workout'), 'workout');
    assert.equal(pluralLabel(3, 'workout'), 'workouts');
});
