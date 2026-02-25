/**
 * Common localStorage helpers with error handling
 */

/**
 * Get a value from localStorage, parsed as JSON
 * @param {string} key - Storage key
 * @param {*} defaultValue - Value to return if key doesn't exist or parsing fails
 * @returns {*} Parsed value or defaultValue
 */
export function storageGet(key, defaultValue = null) {
  try {
    const item = localStorage.getItem(key);
    return item !== null ? JSON.parse(item) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Set a value in localStorage as JSON
 * @param {string} key - Storage key
 * @param {*} value - Value to store (will be JSON.stringified)
 * @returns {boolean} Whether the operation succeeded
 */
export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a key from localStorage
 * @param {string} key - Storage key
 * @returns {boolean} Whether the operation succeeded
 */
export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
