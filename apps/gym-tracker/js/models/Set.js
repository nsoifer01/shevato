/**
 * Set Model
 * Represents a single set within an exercise
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

    get volume() {
        // For duration-based exercises, use duration as volume
        if (this.duration > 0) {
            return this.duration;
        }
        // For reps-based exercises, use weight * reps
        return this.weight * this.reps;
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
