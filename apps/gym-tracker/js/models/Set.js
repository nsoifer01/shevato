/**
 * Set Model
 * Represents a single set within an exercise
 */
export class Set {
    constructor(data = {}) {
        this.weight = data.weight || 0;
        this.reps = data.reps || 0;
        this.completed = data.completed !== undefined ? data.completed : false;
        this.restTime = data.restTime || 0; // in seconds
        this.notes = data.notes || '';
    }

    get volume() {
        return this.weight * this.reps;
    }

    toJSON() {
        return {
            weight: this.weight,
            reps: this.reps,
            completed: this.completed,
            restTime: this.restTime,
            notes: this.notes
        };
    }

    static fromJSON(json) {
        return new Set(json);
    }
}
