/**
 * Shared date utilities
 */

/**
 * Get today's date in YYYY-MM-DD format (local timezone)
 */
export function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse date string in local timezone (avoids UTC conversion issues)
 * @param {string} dateString - Date in YYYY-MM-DD or other parseable format
 * @returns {Date}
 */
export function parseLocalDate(dateString) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(dateString);
}

/**
 * Format date for display in various formats
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @param {'short'|'long'|'time'|'numeric'} format - Display format
 * @returns {string}
 */
export function formatDate(dateString, format = 'short') {
  const date = parseLocalDate(dateString);

  if (format === 'short') {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  if (format === 'long') {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  if (format === 'time') {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // 'numeric' format: M/D/YYYY (used by football-h2h and mario-kart)
  if (format === 'numeric') {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  }

  return date.toLocaleDateString('en-US');
}

/**
 * Format date as M/D/YYYY (e.g., 8/20/2025)
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string}
 */
export function formatDateForDisplay(dateStr) {
  if (!dateStr) return 'No date';
  try {
    return formatDate(dateStr, 'numeric');
  } catch {
    return dateStr;
  }
}
