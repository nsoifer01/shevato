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
 * Validate date
 */
export function validateDate(dateString) {
    if (!dateString) {
        return 'Date is required';
    }
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
        return 'Invalid date format';
    }
    return null;
}

/**
 * Validate heart rate
 */
export function validateHeartRate(hr) {
    if (hr === null || hr === undefined || hr === '') {
        return null; // Optional field
    }
    if (hr < 30 || hr > 250) {
        return 'Heart rate must be between 30 and 250';
    }
    return null;
}

/**
 * Validate calories
 */
export function validateCalories(calories) {
    if (calories === null || calories === undefined || calories === '') {
        return null; // Optional field
    }
    if (calories < 0 || calories > 5000) {
        return 'Calories must be between 0 and 5000';
    }
    return null;
}

/**
 * Validate rest time
 */
export function validateRestTime(seconds) {
    if (seconds === null || seconds === undefined) {
        return null; // Optional
    }
    if (seconds < 0 || seconds > 600) {
        return 'Rest time must be between 0 and 600 seconds';
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
