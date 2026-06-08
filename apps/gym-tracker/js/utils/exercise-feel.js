/**
 * Pure helpers for the "how did it feel" marking (Item 7).
 */

/**
 * Whether a committed set qualifies the exercise for the feel prompt: it must
 * be a reps-based set (not a duration set) and reach the slot's max target reps.
 *
 * `slotRepsMax` is the repsMax of the matching program slot (or the exercise's
 * representative target when per-slot data is unavailable). Returns false for
 * duration sets so the feature is skipped there.
 */
export function setReachesMaxReps(set, slotRepsMax) {
    if (!set) return false;
    if (set.duration && set.duration > 0) return false;
    const reps = Number(set.reps) || 0;
    const target = Number(slotRepsMax) || 0;
    return target > 0 && reps >= target;
}

/**
 * Strict gating for the feel prompt (Item R2-4): the prompt appears ONLY when
 * every target set of the exercise is completed AND every completed set reached
 * the max of its rep range. Duration exercises never qualify.
 *
 * @param {object[]} sets       committed sets of the session exercise.
 * @param {number}   targetSets number of planned sets for the exercise.
 * @param {(set:object, arrIdx:number) => number} slotMaxOf resolves the slot's
 *        max target reps (repsMax, or the singular target when min==max) for a
 *        given committed set. Receives the set and its array index.
 * @returns {boolean}
 */
export function allSetsReachMax(sets, targetSets, slotMaxOf) {
    const target = Math.max(1, Number(targetSets) || 0);
    if (!Array.isArray(sets) || sets.length < target) return false;
    // Any duration set disqualifies the whole exercise.
    if (sets.some(s => s && s.duration && s.duration > 0)) return false;
    return sets.every((set, arrIdx) => setReachesMaxReps(set, slotMaxOf(set, arrIdx)));
}

/**
 * Item R3-4: whether the feel picker modal should appear for `exerciseIndex`.
 * It shows at most once per exercise per session: only when the exercise newly
 * satisfies the all-sets-at-max condition AND it has not already been shown.
 * `shownMap` is a plain object of exerciseIndex -> true (mutated by the caller
 * when it actually shows the modal).
 */
export function shouldShowFeelModal(shownMap, exerciseIndex, reachesMax) {
    if (!reachesMax) return false;
    return !(shownMap && shownMap[exerciseIndex]);
}

/**
 * Item R3-4: the next feel value when toggling the header icon. The cycle is
 * good <-> none (null): 'good' clears the mark, anything else marks 'good'.
 */
export function nextFeel(current) {
    return current === 'good' ? null : 'good';
}

/**
 * The most recent 'good' feel marking for `exerciseId` across completed
 * sessions, or null when there is none. Legacy 'bad' markings are ignored so
 * they never surface an icon. Sessions are ordered by their chronological key
 * (most recent first) by the caller-supplied `tsOf`.
 */
export function latestFeelForExercise(sessions, exerciseId, tsOf) {
    if (!Array.isArray(sessions) || exerciseId == null) return null;
    const ts = typeof tsOf === 'function' ? tsOf : (s) => s.sortTimestamp || s.date;
    let best = null;
    let bestTs = null;
    for (const session of sessions) {
        if (!session || session.completed === false) continue;
        const exercises = session.exercises || [];
        for (const ex of exercises) {
            if (ex.exerciseId !== exerciseId) continue;
            if (ex.feel !== 'good') continue;
            const t = new Date(ts(session)).getTime();
            if (bestTs === null || t > bestTs) {
                bestTs = t;
                best = ex.feel;
            }
        }
    }
    return best;
}
