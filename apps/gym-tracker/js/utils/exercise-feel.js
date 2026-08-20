/**
 * Pure helpers for the "how did it feel" marking (Item 7).
 */
import { sameId } from './id-utils.js';

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
 * Did the IMMEDIATELY PREVIOUS session that performed `exerciseId` mark it
 * 'good'? Returns 'good' or null.
 *
 * The smiley means exactly one thing: "I marked this good last time." It
 * therefore lasts for exactly one following workout and must be renewed.
 *
 * This replaced `latestFeelForExercise`, which scanned the WHOLE history and
 * returned the most recent 'good' wherever it sat. That made the icon
 * permanent: mark good once and it showed for ever, because every later
 * session without a marking was simply skipped over.
 *
 * Deliberately NOT coupled to performance. A heavier session, more reps or a
 * new PR since the marking changes nothing here - the only question is whether
 * the previous session carried an explicit 'good'. Legacy 'bad' markings read
 * as "not good", so they expire the icon exactly like an unmarked session.
 *
 * "Previous session" means the most recent completed session in which the
 * exercise was actually PERFORMED (at least one completed set). A session that
 * merely listed the exercise and logged nothing is not evidence about it, and
 * skipping an exercise should not silently expire the mark.
 *
 * Identity goes through `sameId`, because ids arrive as strings from an export
 * round trip and as numbers from the catalog.
 *
 * @param {Array} sessions completed sessions, any order
 * @param {string|number} exerciseId
 * @param {Function} tsOf chronological key for a session
 * @returns {'good'|null}
 */
export function previousSessionFeelForExercise(sessions, exerciseId, tsOf) {
    if (!Array.isArray(sessions) || exerciseId == null) return null;
    const ts = typeof tsOf === 'function' ? tsOf : (s) => s.sortTimestamp || s.date;

    let latestTs = null;
    let latestFeel = null;

    for (const session of sessions) {
        if (!session || session.completed === false) continue;
        for (const ex of (session.exercises || [])) {
            if (!ex || !sameId(ex.exerciseId, exerciseId)) continue;
            // Performed, not merely planned.
            if (!(ex.sets || []).some(set => set && set.completed)) continue;
            const t = new Date(ts(session)).getTime();
            if (!Number.isFinite(t)) continue;
            // Strictly newer wins; ties keep the first seen, which only
            // matters for two sessions sharing an identical timestamp.
            if (latestTs === null || t > latestTs) {
                latestTs = t;
                latestFeel = ex.feel === 'good' ? 'good' : null;
            }
        }
    }
    return latestFeel;
}
