/**
 * Validation Utilities
 * Form and data validation functions
 */

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
