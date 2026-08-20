/**
 * WorkoutExercise Model
 * Represents an exercise within a workout session with actual performance data
 */
import { Set, setTimedSeconds, setVolume } from './Set.js';

export class WorkoutExercise {
    constructor(data = {}) {
        this.exerciseId = data.exerciseId || null;
        this.exerciseName = data.exerciseName || '';
        // The exercise this slot came from in the PROGRAM. Normally identical
        // to exerciseId; an in-workout swap changes exerciseId (so sets, PRs
        // and history follow the substitute) while this keeps pointing at the
        // planned row, which is what the rep-range / rest lookups join on.
        // Without it a swap silently dropped the rep-target label from the
        // header (GT-13).
        this.plannedExerciseId = data.plannedExerciseId != null
            ? data.plannedExerciseId
            : (data.exerciseId || null);
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
        // Carries the program's groupId through to the in-progress
        // session so the workout view's render + rest-timer logic can
        // tell which exercises are linked into a superset.
        this.groupId = data.groupId || null;
        // "How did it feel" marking, revealed once a committed set reaches the
        // slot's max target reps. 'good' = consider more weight next time.
        // null = no marking. Legacy 'bad' is preserved here for data integrity
        // but never produced and never rendered. Toggleable until save.
        this.feel = data.feel === 'good' || data.feel === 'bad' ? data.feel : null;
    }

    /** Weight-volume (kg·reps) across this exercise's sets. Excludes time. */
    get totalVolume() {
        return this.sets.reduce((sum, set) => sum + setVolume(set), 0);
    }

    /** Seconds of time-under-tension across this exercise's timed sets. */
    get totalTimedSeconds() {
        return this.sets.reduce((sum, set) => sum + setTimedSeconds(set), 0);
    }

    /** Sets the user actually marked complete. */
    get completedSetList() {
        return this.sets.filter(s => s.completed);
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
            plannedExerciseId: this.plannedExerciseId,
            sets: this.sets.map(s => s.toJSON()),
            targetSets: this.targetSets,
            targetReps: this.targetReps,
            restSeconds: this.restSeconds,
            notes: this.notes,
            order: this.order,
            completed: this.completed,
            stickyValues: this.stickyValues,
            feel: this.feel,
        };
    }

    static fromJSON(json) {
        return new WorkoutExercise(json);
    }
}
