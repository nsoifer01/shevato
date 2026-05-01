/**
 * Linear progression suggestion — given an exercise's most recent
 * session and a target rep count, recommend the next-session weight.
 *
 * Rule (the "v1" my message to the user committed to):
 *   - All sets last session hit the rep target → bump weight.
 *   - Any set fell short of the rep target → repeat the same weight.
 *   - No history → no suggestion (fall through to the program target).
 *
 * Bump size: a fraction of the prior weight, rounded to the nearest
 * `bumpStep`. Default step 2.5 (kg) / 5 (lb) matches the smallest pair
 * of plates a user typically has on a barbell. Default fraction is
 * conservative (~5%) so big lifts don't feel sudden.
 */

const DEFAULT_FRACTION = 0.05;

/**
 * Suggest the next weight + rep target for an exercise.
 *
 * @param {Object} args
 * @param {number} args.exerciseId        - look up sessions for this exercise.
 * @param {Array}  args.sessions          - WorkoutSession[] from app.workoutSessions.
 * @param {number} args.targetReps        - the program's per-set rep target.
 * @param {number} [args.bumpStep=2.5]    - rounding granularity for the bump.
 * @param {number} [args.fraction=0.05]   - bump size as a fraction of last weight.
 *
 * Returns:
 *   { kind: 'suggest' | 'repeat' | 'none',
 *     weight: number | null,
 *     reps: number | null,
 *     reason: string }
 *
 * The view consumes `kind` to colorize the pill and `reason` for the
 * tooltip.
 */
export function suggestNextSet({ exerciseId, sessions, targetReps, bumpStep = 2.5, fraction = DEFAULT_FRACTION }) {
    if (!Array.isArray(sessions) || sessions.length === 0 || !exerciseId) {
        return { kind: 'none', weight: null, reps: null, reason: 'No prior data' };
    }
    if (!targetReps || targetReps < 1) {
        return { kind: 'none', weight: null, reps: null, reason: 'No target reps set' };
    }

    // Find the most recent session that has this exercise + completed sets.
    const sorted = [...sessions].sort((a, b) =>
        new Date(b.sortTimestamp || b.endTime || b.startTime || b.timestamp || b.date) -
        new Date(a.sortTimestamp || a.endTime || a.startTime || a.timestamp || a.date),
    );
    let latest = null;
    for (const s of sorted) {
        const ex = (s.exercises || []).find(e => e.exerciseId === exerciseId);
        if (!ex) continue;
        const sets = (ex.sets || []).filter(set => (set.weight || 0) > 0 && (set.reps || 0) > 0);
        if (sets.length === 0) continue;
        latest = { session: s, exercise: ex, sets };
        break;
    }

    if (!latest) {
        return { kind: 'none', weight: null, reps: null, reason: 'No completed reps yet' };
    }

    const lastWeight = latest.sets[0].weight;
    const allHitTarget = latest.sets.every(set => (set.reps || 0) >= targetReps);

    if (!allHitTarget) {
        return {
            kind: 'repeat',
            weight: lastWeight,
            reps: targetReps,
            reason: `Stay at ${lastWeight} — last session missed ${targetReps} reps on at least one set`,
        };
    }

    // Hit every rep — bump.
    const raw = lastWeight * (1 + fraction);
    const stepped = Math.round(raw / bumpStep) * bumpStep;
    const next = stepped > lastWeight ? stepped : lastWeight + bumpStep;
    return {
        kind: 'suggest',
        weight: round2(next),
        reps: targetReps,
        reason: `Hit all ${targetReps} reps last session — try +${round2(next - lastWeight)}`,
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}
