/**
 * WorkoutExercise Model
 * Represents an exercise within a workout session with actual performance data
 */
import { Set } from './Set.js';

export class WorkoutExercise {
    constructor(data = {}) {
        this.exerciseId = data.exerciseId || null;
        this.exerciseName = data.exerciseName || '';
        this.sets = (data.sets || []).map(s => s instanceof Set ? s : new Set(s));
        this.targetSets = data.targetSets || 3;
        this.targetReps = data.targetReps || 10;
        this.restSeconds = Number.isFinite(data.restSeconds) ? data.restSeconds : 90;
        this.notes = data.notes || '';
        this.order = data.order || 0;
        this.completed = data.completed || false;
        // stickyValues: per-slot defaults for planned rows, populated when a
        // user unchecks a previously-completed set. Keys are slot indices,
        // values are {weight, reps, duration} — same shape as a prior-set entry.
        this.stickyValues = data.stickyValues || {};
    }

    get totalVolume() {
        return this.sets.reduce((sum, set) => sum + set.volume, 0);
    }

    get completedSets() {
        return this.sets.filter(s => s.completed).length;
    }

    addSet(setData) {
        this.sets.push(new Set(setData));
    }

    removeSet(index) {
        if (index >= 0 && index < this.sets.length) {
            this.sets.splice(index, 1);
        }
    }

    toJSON() {
        return {
            exerciseId: this.exerciseId,
            exerciseName: this.exerciseName,
            sets: this.sets.map(s => s.toJSON()),
            targetSets: this.targetSets,
            targetReps: this.targetReps,
            restSeconds: this.restSeconds,
            notes: this.notes,
            order: this.order,
            completed: this.completed,
            stickyValues: this.stickyValues,
        };
    }

    static fromJSON(json) {
        return new WorkoutExercise(json);
    }
}
