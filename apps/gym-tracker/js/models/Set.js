/**
 * Set Model
 * Represents a single set within an exercise.
 *
 * `weight` is CANONICAL KILOGRAMS (see utils/units.js). `duration` is
 * seconds, for time-based exercises.
 *
 * Weight-volume and time are separate physical quantities and are never
 * added together. `volume` used to return `duration` for a timed set, so a
 * 60-second plank contributed "60 kg" to the session total, the weekly
 * volume tile, the Insights muscle-group chart and the CSV export (GT-04).
 * A timed set now reports 0 weight-volume and its seconds through
 * `timedSeconds`.
 */
export class Set {
    constructor(data = {}) {
        this.weight = data.weight || 0;
        this.reps = data.reps || 0;
        this.duration = data.duration || 0; // in seconds (for time-based exercises)
        this.completed = data.completed !== undefined ? data.completed : false;
        this.restTime = data.restTime || 0; // in seconds
        this.notes = data.notes || '';
        // Stable user-facing slot index (0-based) within its exercise. The
        // renderer addresses rows by slot so un-toggling a middle set doesn't
        // visually renumber the others. May be null on legacy sessions — the
        // render layer falls back to array position when slot is unset.
        this.slot = data.slot != null ? data.slot : null;
    }

    /** True for a time-based set (a hold/carry), which carries no load. */
    get isTimed() {
        return (this.duration || 0) > 0;
    }

    /**
     * Weight-volume in kg·reps. ZERO for a timed set: seconds are not
     * kilograms, and every consumer of this renders it with a weight unit.
     */
    get volume() {
        if (this.isTimed) return 0;
        return (this.weight || 0) * (this.reps || 0);
    }

    /** Seconds of time-under-tension contributed by this set (0 if untimed). */
    get timedSeconds() {
        return this.isTimed ? this.duration : 0;
    }

    toJSON() {
        return {
            weight: this.weight,
            reps: this.reps,
            duration: this.duration,
            completed: this.completed,
            restTime: this.restTime,
            notes: this.notes,
            slot: this.slot
        };
    }

    static fromJSON(json) {
        return new Set(json);
    }
}

/**
 * Weight-volume of a raw (plain-object) set, for the many code paths that
 * read stored JSON rather than model instances. Same rule as `Set.volume`.
 */
export function setVolume(set) {
    if (!set) return 0;
    if ((set.duration || 0) > 0) return 0;
    return (set.weight || 0) * (set.reps || 0);
}

/** Time-under-tension of a raw (plain-object) set, in seconds. */
export function setTimedSeconds(set) {
    if (!set) return 0;
    return (set.duration || 0) > 0 ? set.duration : 0;
}
