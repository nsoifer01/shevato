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
        // Array of normalized program-exercise objects (see normalizeExercise).
        this.exercises = (data.exercises || []).map(normalizeExercise);
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || new Date().toISOString();

        // Rest timer mode: 'uniform' uses a single restSeconds for all
        // gaps; 'custom' uses per-exercise restSeconds values (legacy default).
        this.restMode = data.restMode === 'uniform' ? 'uniform' : 'custom';
        // Active only when restMode === 'uniform'.
        this.uniformRestSeconds = clampInt(data.uniformRestSeconds, 0, 900, 90);
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
            restMode: this.restMode,
            uniformRestSeconds: this.uniformRestSeconds,
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
 *
 * New shape: `sets` is an array of `{ repsMin, repsMax }` where
 * repsMin === repsMax means a single-rep-target (no range).
 *
 * Backward compat: old entries carry `targetSets`/`targetReps` but no `sets`.
 * We expand them here so downstream code always sees `sets[]`.
 *
 * Getters `targetSets` and `targetReps` are provided on every exercise so
 * callers that haven't been updated (workout-view, analytics) keep working
 * without modification.
 */
function normalizeExercise(ex) {
    // Build the canonical sets[] array.
    let sets;
    if (Array.isArray(ex.sets) && ex.sets.length > 0) {
        // Already in new format — clamp each row.
        sets = ex.sets.map(s => normalizeSetRow(s));
    } else {
        // Legacy or freshly constructed: expand targetSets x targetReps.
        const count = clampInt(ex.targetSets, 1, 20, 3);
        const reps  = clampInt(ex.targetReps,  1, 100, 10);
        sets = Array.from({ length: count }, () => ({ repsMin: reps, repsMax: reps }));
    }

    const normalized = {
        exerciseId: ex.exerciseId,
        exerciseName: ex.exerciseName,
        sets,
        restSeconds: clampInt(ex.restSeconds, 0, 900, 90),
        notes: ex.notes || '',
        order: Number.isFinite(ex.order) ? ex.order : 0,
        // Superset grouping — see original note in previous version.
        groupId: ex.groupId || null,
    };

    // Compatibility getters so workout-view.js and analytics read these
    // fields without modification.
    Object.defineProperty(normalized, 'targetSets', {
        get() { return this.sets.length; },
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(normalized, 'targetReps', {
        get() {
            if (!this.sets.length) return 0;
            // Return the max of the first set's range as the representative value.
            return this.sets[0].repsMax;
        },
        enumerable: false,
        configurable: true,
    });

    return normalized;
}

function normalizeSetRow(s) {
    const repsMin = clampInt(s.repsMin, 1, 100, 10);
    const repsMax = clampInt(s.repsMax, 1, 100, repsMin);
    return { repsMin, repsMax: Math.max(repsMin, repsMax) };
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}
