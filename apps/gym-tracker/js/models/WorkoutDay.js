/**
 * WorkoutDay Model
 * Represents a day's workout template within a program
 */
export class WorkoutDay {
    constructor(data = {}) {
        this.id = data.id || Date.now() + Math.random();
        this.name = data.name || '';
        this.description = data.description || '';
        this.exercises = data.exercises || []; // Array of { exerciseId, exerciseName, targetSets, targetReps, notes, order }
        this.order = data.order || 0;
    }

    addExercise(exerciseId, exerciseName, targetSets = 3, targetReps = 10, notes = '') {
        const order = this.exercises.length;
        this.exercises.push({
            exerciseId,
            exerciseName,
            targetSets,
            targetReps,
            notes,
            order
        });
    }

    removeExercise(index) {
        if (index >= 0 && index < this.exercises.length) {
            this.exercises.splice(index, 1);
            // Re-order remaining exercises
            this.exercises.forEach((ex, idx) => ex.order = idx);
        }
    }

    reorderExercise(fromIndex, toIndex) {
        if (fromIndex >= 0 && fromIndex < this.exercises.length &&
            toIndex >= 0 && toIndex < this.exercises.length) {
            const [movedItem] = this.exercises.splice(fromIndex, 1);
            this.exercises.splice(toIndex, 0, movedItem);
            // Re-order all exercises
            this.exercises.forEach((ex, idx) => ex.order = idx);
        }
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            exercises: this.exercises,
            order: this.order
        };
    }

    static fromJSON(json) {
        return new WorkoutDay(json);
    }
}
