/**
 * Pure helpers for in-session PR badge bookkeeping (Item R2-10).
 *
 * Within a single workout session a later set can beat an earlier PR for the
 * SAME exercise. Only the best (latest, higher) set keeps its badge; the
 * earlier badge is superseded. The finish-modal PR count counts each
 * superseded chain ONCE per exercise, not once per PR moment.
 *
 * The slot map is keyed `"<exerciseIndex>:<slot>"`; values are PR payloads.
 * `exerciseIndex` is recovered as the substring before the first ":".
 */

/** Exercise index portion of a `"<exerciseIndex>:<slot>"` key. */
export function exerciseKeyOf(slotKey) {
    const i = String(slotKey).indexOf(':');
    return i === -1 ? String(slotKey) : String(slotKey).slice(0, i);
}

/**
 * Record a brand-new PR at `slotKey` into `slots`, removing any earlier PR
 * badge for the SAME exercise (it has been superseded). Mutates and returns
 * `slots` for convenience.
 */
export function recordPrSupersede(slots, slotKey, pr) {
    const exKey = exerciseKeyOf(slotKey);
    for (const key of Object.keys(slots)) {
        if (key !== slotKey && exerciseKeyOf(key) === exKey) {
            delete slots[key];
        }
    }
    slots[slotKey] = pr;
    return slots;
}

/**
 * Number of UNIQUE superseded PR chains in `slots` — i.e. the count of
 * distinct exercises that have a surviving badge. This is the value shown in
 * the finish modal (a 100 -> 110 sequence counts as 1).
 */
export function uniquePrChainCount(slots) {
    const exercises = new Set();
    for (const key of Object.keys(slots)) exercises.add(exerciseKeyOf(key));
    return exercises.size;
}

/**
 * Recompute the entire session PR slot map FROM SCRATCH (Item R3-7).
 *
 * Derived PR state must always equal a fresh recomputation, so after ANY set
 * edit or delete the caller rebuilds the whole map rather than patching a
 * single slot. Each exercise's committed sets are evaluated in SLOT order
 * against history plus the earlier sets of the same exercise this session, so:
 *   - editing away a superseding set restores the earlier set's badge;
 *   - deleting a set restores any badge it had superseded;
 *   - a new PR created mid-list resequences correctly (slot order, not
 *     insertion order).
 *
 * @param {Array<{exerciseId:*, sets:object[]}>} exercises session exercises.
 * @param {(exerciseId:*, set:object, priorSessionSets:object[]) => (object|null)} isPr
 *        resolves a PR payload (or null) for a set given the exercise id and
 *        the earlier same-exercise sets of this session. History baseline is
 *        captured by the closure.
 * @returns {Object<string, object>} fresh `"<exerciseIndex>:<slot>"` -> PR map.
 */
export function recomputePrSlots(exercises, isPr) {
    const slots = {};
    (exercises || []).forEach((exercise, exerciseIndex) => {
        const ordered = (exercise.sets || [])
            .map((set, i) => ({ set, slot: set.slot != null ? set.slot : i }))
            .sort((a, b) => a.slot - b.slot);
        const priorSessionSets = [];
        for (const { set, slot } of ordered) {
            const pr = isPr(exercise.exerciseId, set, priorSessionSets);
            if (pr) recordPrSupersede(slots, `${exerciseIndex}:${slot}`, pr);
            priorSessionSets.push(set);
        }
    });
    return slots;
}
