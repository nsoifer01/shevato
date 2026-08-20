/**
 * Session metrics - the shared answers to "how much work is in this session?"
 *
 * These work on BOTH `WorkoutSession` instances and the plain objects that
 * come straight out of storage / an import, so history, analytics, the
 * calendar and the exporters all count the same thing. Three questions kept
 * getting answered differently before:
 *
 *   - "how many exercises?" - the raw `exercises.length` includes rows the
 *     lifter never touched, so a session where one of eight exercises was
 *     skipped still said "8 exercises" (GT-23).
 *   - "is this a workout at all?" - removing an exercise's logged history
 *     could leave a session with zero completed sets that still counted
 *     toward the weekly tile, the streak and the calendar (GT-14).
 *   - "how much volume?" - timed sets used to add their seconds to the
 *     kilogram total (GT-04).
 */
import { setTimedSeconds, setVolume } from '../models/Set.js';

/** Every set across a session, flattened. */
function allSets(session) {
    const out = [];
    (session?.exercises || []).forEach((ex) => {
        (ex?.sets || []).forEach((set) => out.push(set));
    });
    return out;
}

/** Completed sets across a session. */
export function completedSets(session) {
    return allSets(session).filter(s => s && s.completed);
}

/** How many sets the lifter marked complete. */
export function completedSetCount(session) {
    return completedSets(session).length;
}

/**
 * Exercises with at least one completed set - what "EXERCISES 8" should
 * have been counting.
 */
export function performedExerciseCount(session) {
    return (session?.exercises || []).filter(
        ex => (ex?.sets || []).some(s => s && s.completed)).length;
}

/**
 * True when a session records real work. A session with zero completed sets
 * holds no logged information at all: `finishWorkout` refuses to save one,
 * so the only way to reach that state is removing an exercise's history out
 * from under it. Such a record is not a workout and must not be counted as
 * one on ANY surface.
 */
export function isLoggedSession(session) {
    return completedSetCount(session) > 0;
}

/** Weight-volume of a session in canonical kg·reps. Excludes timed sets. */
export function sessionVolumeKg(session) {
    return allSets(session).reduce((sum, set) => sum + setVolume(set), 0);
}

/** Total seconds held across a session's timed sets. */
export function sessionTimedSeconds(session) {
    return allSets(session).reduce((sum, set) => sum + setTimedSeconds(set), 0);
}

/** True when the session contains at least one timed set. */
export function hasTimedWork(session) {
    return sessionTimedSeconds(session) > 0;
}
