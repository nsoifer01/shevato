/**
 * Pure, DOM-free session/program reconciliation. Used when the user edits a
 * program mid-workout (Item 3 + 4) and returns: the paused session must pick
 * up the program's edits without clobbering already-committed work.
 *
 * Merge rules (spec Item 4):
 *   - exercises with committed sets keep their committed data untouched;
 *   - target sets/reps/rest updates apply to exercises WITHOUT committed sets;
 *   - exercises added to the program are appended to the session;
 *   - exercises removed from the program are dropped from the session ONLY if
 *     they have zero committed sets.
 *
 * Inputs are plain JSON-ish objects (the shapes produced by
 * WorkoutExercise.toJSON and a normalized program exercise). The function is
 * non-mutating: it returns a fresh array of session-exercise plain objects.
 * The caller rehydrates them into WorkoutExercise instances.
 *
 * `makeSessionExercise(progEx)` builds a brand-new session exercise object
 * from a program exercise (injected so this module stays free of model imports).
 */
export function mergeSessionWithProgram(sessionExercises, programExercises, makeSessionExercise) {
    const sessionList = Array.isArray(sessionExercises) ? sessionExercises : [];
    const programList = Array.isArray(programExercises) ? programExercises : [];

    const hasCommitted = (ex) => Array.isArray(ex.sets) && ex.sets.length > 0;

    // Index the program's exercises by id. A program can legitimately list the
    // same exercise twice; we match positionally within that id bucket so two
    // entries of the same movement stay distinct.
    const progBuckets = new Map();
    for (const p of programList) {
        const arr = progBuckets.get(p.exerciseId) || [];
        arr.push(p);
        progBuckets.set(p.exerciseId, arr);
    }
    const progCursor = new Map();

    const result = [];
    const consumedProg = new Set();

    for (const sx of sessionList) {
        const bucket = progBuckets.get(sx.exerciseId) || [];
        const cursor = progCursor.get(sx.exerciseId) || 0;
        const match = bucket[cursor] || null;
        if (match) {
            progCursor.set(sx.exerciseId, cursor + 1);
            consumedProg.add(match);
        }

        if (hasCommitted(sx)) {
            // Keep the committed exercise verbatim. Even if removed from the
            // program, it survives because it holds logged sets.
            result.push(sx);
            continue;
        }

        if (!match) {
            // No committed sets and no longer in the program -> drop it.
            continue;
        }

        // No committed sets: adopt the program's current targets/rest while
        // preserving session-only fields the user may have set (feel, notes).
        result.push({
            ...sx,
            exerciseName: match.exerciseName,
            targetSets: match.targetSets,
            targetReps: match.targetReps,
            restSeconds: match.restSeconds,
            restAfterSeconds: match.restAfterSeconds,
            groupId: match.groupId || null,
        });
    }

    // Append program exercises that weren't matched to any session exercise.
    for (const p of programList) {
        if (consumedProg.has(p)) continue;
        result.push(makeSessionExercise(p));
    }

    return result;
}
