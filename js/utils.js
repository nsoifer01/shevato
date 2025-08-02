// Shared utility functions for the Mario Kart Race Tracker

// Utility function for consistent decimal formatting
function formatDecimal(value) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    // Round to 1 decimal place first to handle floating point precision issues
    const rounded = Math.round(num * 10) / 10;
    return rounded % 1 === 0 ? Math.round(rounded).toString() : rounded.toFixed(1);
}

// Add any other shared utility functions here in the future