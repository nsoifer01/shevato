/**
 * Program Model
 * Represents a workout program with exercises
 */
import { generateNumericId } from '../utils/helpers.js';

export class Program {
    constructor(data = {}) {
        this.id = data.id || generateNumericId();
        this.name = data.name || '';
        this.description = data.description || '';
        // Array of { exerciseId, exerciseName, targetSets, targetReps, restSeconds, notes, order }
        this.exercises = (data.exercises || []).map(normalizeExercise);
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || new Date().toISOString();
    }

    addExercise(exerciseId, exerciseName, targetSets = 3, targetReps = 10, notes = '', restSeconds = null) {
        const order = this.exercises.length;
        this.exercises.push(normalizeExercise({
            exerciseId,
            exerciseName,
            targetSets,
            targetReps,
            restSeconds,
            notes,
            order,
        }));
        this.updatedAt = new Date().toISOString();
    }

    updateExercise(index, patch = {}) {
        if (index < 0 || index >= this.exercises.length) return;
        this.exercises[index] = normalizeExercise({
            ...this.exercises[index],
            ...patch,
        });
        this.updatedAt = new Date().toISOString();
    }

    removeExercise(index) {
        if (index >= 0 && index < this.exercises.length) {
            this.exercises.splice(index, 1);
            // Re-order remaining exercises
            this.exercises.forEach((ex, idx) => ex.order = idx);
            this.updatedAt = new Date().toISOString();
        }
    }

    reorderExercise(fromIndex, toIndex) {
        if (fromIndex >= 0 && fromIndex < this.exercises.length &&
            toIndex >= 0 && toIndex < this.exercises.length) {
            const [movedItem] = this.exercises.splice(fromIndex, 1);
            this.exercises.splice(toIndex, 0, movedItem);
            // Re-order all exercises
            this.exercises.forEach((ex, idx) => ex.order = idx);
            this.updatedAt = new Date().toISOString();
        }
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            exercises: this.exercises,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        };
    }

    static fromJSON(json) {
        return new Program(json);
    }
}

/**
 * Default rest (seconds) by equipment type. Heavy compound movements need
 * more rest; accessory/bodyweight work needs less. Callers pass `null` to
 * let us choose the default for the exercise's equipment.
 */
const REST_DEFAULTS_BY_EQUIPMENT = {
    barbell: 180,
    'trap-bar': 180,
    dumbbell: 90,
    kettlebell: 90,
    cable: 75,
    machine: 75,
    'resistance-band': 60,
    bodyweight: 60,
    plate: 90,
    'medicine-ball': 60,
    'battle-ropes': 60,
    'ab-wheel': 60,
    sled: 120,
    tire: 120,
    gripper: 45,
    towel: 60,
    various: 90,
};

export function defaultRestForEquipment(equipment) {
    return REST_DEFAULTS_BY_EQUIPMENT[equipment] ?? 90;
}

/**
 * Coerce a raw exercise entry into the canonical program-exercise shape.
 * Guarantees every row has targetSets/targetReps/restSeconds so the UI
 * can render steppers without null-checks on older saved data.
 */
function normalizeExercise(ex) {
    return {
        exerciseId: ex.exerciseId,
        exerciseName: ex.exerciseName,
        targetSets: clampInt(ex.targetSets, 1, 20, 3),
        targetReps: clampInt(ex.targetReps, 1, 100, 10),
        restSeconds: clampInt(ex.restSeconds, 0, 900, 90),
        notes: ex.notes || '',
        order: Number.isFinite(ex.order) ? ex.order : 0,
        // Superset grouping. Exercises sharing the same string `groupId`
        // are performed back-to-back with no inter-exercise rest. null /
        // undefined → solo exercise. Stored as a string so future fields
        // (label, color) can hang off a separate group registry without
        // colliding with positional indices.
        groupId: ex.groupId || null,
    };
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}
