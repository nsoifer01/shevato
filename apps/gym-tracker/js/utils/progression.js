/**
 * Progressive-overload decision helpers (Item 1) - pure.
 *
 * The workout view pre-fills a planned row from the last session. Three
 * outcomes are possible, and the lifter must be able to SEE which one applied:
 *
 *   'bump'   the last two sessions both hit every set's target reps at the
 *            same weight -> suggest last weight + increment.
 *   'repeat' the last session missed target reps on at least one set ->
 *            keep the same weight ("Missed target - repeat weight").
 *   'deload' the last TWO sessions both missed target reps at the same
 *            weight -> suggest a 5-10% cut, rounded to the equipment step.
 *   'none'   not enough history to say anything; prefill last session as-is.
 *
 * "Target reps" is resolved PER SET via the caller-supplied
 * `targetRepsForSet(set, arrayIndex)` so per-set rep ranges (program sets[])
 * are honored, with the exercise-level targetReps as the fallback.
 */

export const PROGRESSION_BUMP = 'bump';
export const PROGRESSION_REPEAT = 'repeat';
export const PROGRESSION_DELOAD = 'deload';
export const PROGRESSION_NONE = 'none';

/** Session weight for comparison purposes: the first completed set's weight. */
export function sessionWeight(sets) {
    return (sets && sets.length > 0 && sets[0].weight) || 0;
}

/**
 * True when EVERY completed set reached its own target reps. A set whose
 * resolved target is 0/absent counts as a miss: without a target there is no
 * evidence of a hit, and silently bumping the weight is the worse failure.
 */
export function setsHitTarget(sets, targetRepsForSet) {
    if (!sets || sets.length === 0) return false;
    return sets.every((set, i) => {
        const target = Number(targetRepsForSet(set, i)) || 0;
        if (target <= 0) return false;
        return (set.reps || 0) >= target;
    });
}

/**
 * Weight to drop to after two failed sessions: the largest whole `increment`
 * step that stays inside the 5-10% band. When even one step overshoots 10%
 * (light weights, coarse plates) a single step is used - it is the smallest
 * cut the equipment can actually make.
 */
export function deloadWeight(lastWeight, increment) {
    if (!(lastWeight > 0) || !(increment > 0)) return 0;
    let drop = Math.floor((lastWeight * 0.10 + 1e-9) / increment) * increment;
    if (drop < lastWeight * 0.05) drop = increment;
    const next = Math.round((lastWeight - drop) * 100) / 100;
    return next > 0 ? next : 0;
}

/**
 * Resolve the progression outcome for one exercise.
 *
 * @param {object} options
 * @param {object[]} options.lastSets completed sets of the most recent session.
 * @param {object[]|null} options.prevSets completed sets of the session before it.
 * @param {(set:object, i:number) => number} options.targetRepsForSet per-set rep target.
 * @param {number} options.increment equipment step for this exercise/unit.
 * @returns {{status:string, lastWeight:number, suggestedWeight:number, delta:number}}
 */
export function evaluateProgression({ lastSets, prevSets = null, targetRepsForSet, increment = 0 }) {
    const lastWeight = sessionWeight(lastSets);
    const none = { status: PROGRESSION_NONE, lastWeight, suggestedWeight: lastWeight, delta: 0 };
    if (!lastSets || lastSets.length === 0) return none;

    const prevUsable = prevSets && prevSets.length > 0;

    if (!setsHitTarget(lastSets, targetRepsForSet)) {
        const sameWeight = prevUsable && lastWeight > 0 && sessionWeight(prevSets) === lastWeight;
        if (sameWeight && !setsHitTarget(prevSets, targetRepsForSet)) {
            const suggested = deloadWeight(lastWeight, increment);
            if (suggested > 0 && suggested < lastWeight) {
                return {
                    status: PROGRESSION_DELOAD,
                    lastWeight,
                    suggestedWeight: suggested,
                    delta: Math.round((suggested - lastWeight) * 100) / 100,
                };
            }
        }
        return { status: PROGRESSION_REPEAT, lastWeight, suggestedWeight: lastWeight, delta: 0 };
    }

    if (prevUsable
        && increment > 0
        && lastWeight > 0
        && sessionWeight(prevSets) === lastWeight
        && setsHitTarget(prevSets, targetRepsForSet)) {
        return {
            status: PROGRESSION_BUMP,
            lastWeight,
            suggestedWeight: Math.round((lastWeight + increment) * 100) / 100,
            delta: increment,
        };
    }

    return none;
}
