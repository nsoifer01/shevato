/**
 * Progressive-overload decision helpers (Item 1) - pure.
 *
 * The workout view pre-fills a planned row from the last session. Four
 * outcomes are possible, and the lifter must be able to SEE which one applied:
 *
 *   'bump'   the last two sessions both reached the TOP of every set's rep
 *            range at the same weight -> suggest last weight + increment.
 *   'repeat' the last session finished BELOW the bottom of the range on at
 *            least one set -> keep the same weight ("Missed target - repeat
 *            weight").
 *   'deload' the last TWO sessions both finished below the range at the same
 *            weight -> suggest a 5-10% cut, rounded to the equipment step.
 *   'none'   everything else, including the common case of landing INSIDE the
 *            range (e.g. 7 reps of a 7-8 target). That is a good working set,
 *            not a miss: hold the weight and say nothing.
 *
 * The three-state reading is the point. Judging every set against the top of
 * the range alone made "10 of 10-12" a miss, which then deloaded a lifter off
 * a weight they were handling fine.
 *
 * The range is resolved PER SET via the caller-supplied
 * `repRangeForSet(set, arrayIndex)` so per-set rep ranges (program sets[]) are
 * honored. It may return `{min, max}` or a bare number, which reads as a fixed
 * target (min === max) - that is how exercise-level targetReps behaves.
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
 * Accept either `{min, max}` or a bare number from the caller's resolver. A
 * bare number is a fixed target, so both ends of the range are that number.
 * A range given backwards (min > max) is read at face value per end.
 */
export function normalizeRange(range) {
    if (range && typeof range === 'object') {
        return {
            min: Number(range.min) || 0,
            max: Number(range.max) || 0,
        };
    }
    const n = Number(range) || 0;
    return { min: n, max: n };
}

/** The slot a set belongs to, falling back to its position in the array. */
function slotOf(set, i) {
    return set && set.slot != null ? set.slot : i;
}

/**
 * True when EVERY set reached the TOP of its own range - the bar for adding
 * weight. A set whose resolved max is 0/absent counts as not-reached: without
 * a target there is no evidence of a hit, and silently bumping the weight is
 * the worse failure.
 */
export function setsHitTarget(sets, repRangeForSet) {
    if (!sets || sets.length === 0) return false;
    return sets.every((set, i) => {
        const { max } = normalizeRange(repRangeForSet(set, i));
        if (max <= 0) return false;
        return (set.reps || 0) >= max;
    });
}

/**
 * EVERY set that finished BELOW the bottom of its own range - the only true
 * misses. Returned per set, not collapsed to one verdict, because missing is
 * a property of a set and not of the exercise: a lifter can hit set 1's
 * target, fall short on set 2, and hit set 3's again. Each entry carries the
 * numbers behind the call so the UI can explain itself.
 *
 * A set with no resolvable minimum is NOT a miss: there is nothing to fall
 * short of, so the caller ends up at 'none' and simply holds the weight.
 *
 * @returns {Array<{slot:number, reps:number, min:number, max:number}>}
 */
export function belowRangeSets(sets, repRangeForSet) {
    if (!sets || sets.length === 0) return [];
    const out = [];
    for (let i = 0; i < sets.length; i++) {
        const { min, max } = normalizeRange(repRangeForSet(sets[i], i));
        const reps = sets[i].reps || 0;
        if (min > 0 && reps < min) out.push({ slot: slotOf(sets[i], i), reps, min, max });
    }
    return out;
}

/** Convenience predicate over {@link belowRangeSets}. */
export function setsBelowRange(sets, repRangeForSet) {
    return belowRangeSets(sets, repRangeForSet).length > 0;
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
 * @param {(set:object, i:number) => ({min:number,max:number}|number)} options.repRangeForSet
 *        per-set rep range (or a bare number for a fixed target).
 * @param {number} options.increment equipment step for this exercise/unit.
 * @returns {{status:string, lastWeight:number, suggestedWeight:number, delta:number,
 *            misses:Array<{slot:number, reps:number, min:number, max:number}>}}
 *          `misses` lists EVERY set that fell short, so the view can flag each
 *          one on its own row rather than pinning a single verdict to the
 *          exercise. Empty for bump/none.
 */
export function evaluateProgression({ lastSets, prevSets = null, repRangeForSet, increment = 0 }) {
    const lastWeight = sessionWeight(lastSets);
    const none = {
        status: PROGRESSION_NONE,
        lastWeight,
        suggestedWeight: lastWeight,
        delta: 0,
        misses: [],
    };
    if (!lastSets || lastSets.length === 0) return none;

    const prevUsable = prevSets && prevSets.length > 0;
    const misses = belowRangeSets(lastSets, repRangeForSet);

    if (misses.length > 0) {
        const sameWeight = prevUsable && lastWeight > 0 && sessionWeight(prevSets) === lastWeight;
        if (sameWeight && setsBelowRange(prevSets, repRangeForSet)) {
            const suggested = deloadWeight(lastWeight, increment);
            if (suggested > 0 && suggested < lastWeight) {
                return {
                    status: PROGRESSION_DELOAD,
                    lastWeight,
                    suggestedWeight: suggested,
                    delta: Math.round((suggested - lastWeight) * 100) / 100,
                    misses,
                };
            }
        }
        return {
            status: PROGRESSION_REPEAT,
            lastWeight,
            suggestedWeight: lastWeight,
            delta: 0,
            misses,
        };
    }

    if (prevUsable
        && increment > 0
        && lastWeight > 0
        && sessionWeight(prevSets) === lastWeight
        && setsHitTarget(lastSets, repRangeForSet)
        && setsHitTarget(prevSets, repRangeForSet)) {
        return {
            status: PROGRESSION_BUMP,
            lastWeight,
            suggestedWeight: Math.round((lastWeight + increment) * 100) / 100,
            delta: increment,
            misses: [],
        };
    }

    return none;
}
