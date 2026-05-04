/**
 * Validation Utilities
 * Form and data validation functions
 */

/**
 * Validate program name
 */
export function validateProgramName(name) {
    if (!name || name.trim().length === 0) {
        return 'Program name is required';
    }
    if (name.length > 50) {
        return 'Program name must be less than 50 characters';
    }
    return null;
}

/**
 * Validate workout day name
 */
export function validateWorkoutDayName(name) {
    if (!name || name.trim().length === 0) {
        return 'Workout day name is required';
    }
    if (name.length > 50) {
        return 'Workout day name must be less than 50 characters';
    }
    return null;
}

/**
 * Validate exercise selection
 */
export function validateExerciseSelection(exerciseId) {
    if (!exerciseId) {
        return 'Please select an exercise';
    }
    return null;
}

/**
 * Validate sets count
 */
export function validateSets(sets) {
    if (!sets || sets < 1) {
        return 'Sets must be at least 1';
    }
    if (sets > 20) {
        return 'Sets must be 20 or less';
    }
    return null;
}

/**
 * Validate reps count
 */
export function validateReps(reps) {
    if (!reps || reps < 1) {
        return 'Reps must be at least 1';
    }
    if (reps > 100) {
        return 'Reps must be 100 or less';
    }
    return null;
}

/**
 * Validate weight
 */
export function validateWeight(weight) {
    if (weight === null || weight === undefined) {
        return 'Weight is required';
    }
    if (weight < 0) {
        return 'Weight cannot be negative';
    }
    if (weight > 1000) {
        return 'Weight must be 1000 or less';
    }
    return null;
}

/**
 * Validate JSON import data
 */
export function validateImportData(data) {
    if (!data) {
        return 'No data provided';
    }

    if (typeof data !== 'object') {
        return 'Invalid data format';
    }

    // Check for required structure
    const hasValidStructure =
        data.hasOwnProperty('programs') ||
        data.hasOwnProperty('sessions') ||
        data.hasOwnProperty('settings');

    if (!hasValidStructure) {
        return 'Invalid data structure';
    }

    return null;
}
