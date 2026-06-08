/**
 * Pure, DOM-free predicates for the workout rest flow. Extracted from
 * workout-view so they can be unit-tested directly.
 */

/**
 * Decide what audio/haptic cues fire at `remaining` seconds, given the
 * configured first-warning and countdown-start thresholds. Returns
 * { warn, urgent }:
 *   warn   — true only on the single first-warning second (one early tone).
 *   urgent — true throughout the per-second countdown window.
 *
 * The first warning is suppressed when Off (0) or when it would land at or
 * inside the countdown window, so it never overlaps the per-second pips.
 */
export function restTickCues(remaining, firstWarningSeconds, countdownSeconds) {
    const countdown = countdownSeconds > 0 ? countdownSeconds : 5;
    const urgent = remaining <= countdown && remaining > 0;
    const warn = firstWarningSeconds > countdown && remaining === firstWarningSeconds;
    return { warn, urgent };
}

/**
 * True when no exercise in the session still needs more committed sets, i.e.
 * the whole workout is done. Superset-agnostic: it checks every exercise has
 * reached its target set count. Used to suppress the after-last-exercise rest
 * timer and trigger scroll-to-top.
 */
export function isWorkoutComplete(exercises) {
    if (!exercises || exercises.length === 0) return false;
    return exercises.every(ex => {
        const target = Math.max(1, ex.targetSets || 3);
        return (ex.sets?.length || 0) >= target;
    });
}
