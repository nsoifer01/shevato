/**
 * Exercise Model
 * Represents an exercise in the database
 */
export class Exercise {
    constructor(data) {
        this.id = data.id || null;
        this.name = data.name || '';
        this.category = data.category || ''; // e.g., 'chest', 'back', 'legs'
        this.muscleGroup = data.muscleGroup || ''; // Primary muscle
        this.secondaryMuscles = data.secondaryMuscles || []; // Secondary muscles
        this.equipment = data.equipment || ''; // e.g., 'barbell', 'dumbbell', 'bodyweight'
        this.instructions = data.instructions || '';
        this.tips = data.tips || [];
        this.imageUrl = data.imageUrl || null;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            category: this.category,
            muscleGroup: this.muscleGroup,
            secondaryMuscles: this.secondaryMuscles,
            equipment: this.equipment,
            instructions: this.instructions,
            tips: this.tips,
            imageUrl: this.imageUrl
        };
    }

    static fromJSON(json) {
        return new Exercise(json);
    }
}
