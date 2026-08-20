/**
 * Recoverable active workouts.
 *
 * `gymTrackerActiveWorkout` holds the in-progress session. Two independent
 * bugs used to make it useless as a safety net (GT-01):
 *
 *   1. Nothing wrote to it when sets were logged. The six save sites were
 *     start, session-unit switch, pause, resync, feel marking and swap.
 *     Completing, editing or deleting a set never persisted, so the stored
 *     blob showed `sets: []` while the UI showed "2 / 4 sets".
 *   2. Every restore path gated on `paused === true`. A workout that was
 *     interrupted rather than deliberately paused was stored with
 *     `paused: false` and became unreachable: no banner, no prompt, and a
 *     stale record that lingered in storage forever.
 *
 * The write side is fixed in `workout-view.js` (`persistActiveWorkout`,
 * called from every mutation). This module owns the read side: what counts
 * as a recoverable workout, and how it should be described.
 *
 * A record is recoverable when it is structurally sound, not finished, and
 * contains at least one exercise. Explicitly NOT recoverable: a completed
 * session (finish clears the key, but a crash between save and clear must
 * not resurrect it), and a corrupt or empty blob.
 */

/**
 * Validate a stored active-workout record.
 * Returns the record when it can be resumed, otherwise null.
 */
export function readableActiveWorkout(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.completed === true) return null;
    if (!Array.isArray(raw.exercises) || raw.exercises.length === 0) return null;
    if (!raw.id) return null;
    return raw;
}

/** True when there is a workout worth offering to resume. */
export function hasRecoverableWorkout(raw) {
    return readableActiveWorkout(raw) !== null;
}

/** True when the user explicitly pressed Pause (vs an interruption). */
export function wasExplicitlyPaused(raw) {
    return !!(raw && raw.paused === true);
}

/**
 * How many sets are stored on the record. Used by the banner so a user can
 * see the recovery is real before they commit to it.
 */
export function activeWorkoutSetCount(raw) {
    return (raw?.exercises || []).reduce(
        (sum, ex) => sum + ((ex?.sets || []).length), 0);
}

/**
 * Presentation for the recovery banner. Paused and interrupted workouts are
 * both recoverable but read differently: one the user chose, the other
 * happened to them, and the second needs to explain itself.
 */
export function activeWorkoutBannerCopy(raw) {
    const sets = activeWorkoutSetCount(raw);
    if (wasExplicitlyPaused(raw)) {
        return {
            title: 'Paused Workout',
            icon: 'fa-pause-circle',
            note: '',
            sets,
        };
    }
    return {
        title: 'Unfinished Workout',
        icon: 'fa-rotate-left',
        note: 'This workout was interrupted. Your logged sets were saved.',
        sets,
    };
}
