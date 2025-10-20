/**
 * Helper Utilities
 * Common utility functions used throughout the app
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
 * Parse date string in local timezone (avoids UTC conversion)
 */
export function parseLocalDate(dateString) {
    // If dateString is just YYYY-MM-DD, parse it as local time
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        const [year, month, day] = dateString.split('-').map(Number);
        return new Date(year, month - 1, day);
    }
    // Otherwise use standard Date parsing
    return new Date(dateString);
}

/**
 * Format date for display
 */
export function formatDate(dateString, format = 'short') {
    const date = parseLocalDate(dateString);

    if (format === 'short') {
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    }

    if (format === 'long') {
        return date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    if (format === 'time') {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    return date.toLocaleDateString('en-US');
}

/**
 * Format weight with unit
 */
export function formatWeight(weight, unit = 'kg') {
    return `${weight}${unit}`;
}

/**
 * Convert weight between units
 */
export function convertWeight(weight, fromUnit, toUnit) {
    if (fromUnit === toUnit) return weight;

    if (fromUnit === 'kg' && toUnit === 'lb') {
        return Math.round(weight * 2.20462 * 10) / 10;
    }

    if (fromUnit === 'lb' && toUnit === 'kg') {
        return Math.round(weight * 0.453592 * 10) / 10;
    }

    return weight;
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Debounce function
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Generate unique ID
 */
export function generateId() {
    return Date.now() + Math.random().toString(36).substr(2, 9);
}

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

/**
 * Check if date is today
 */
export function isToday(dateString) {
    return dateString === getTodayString();
}

/**
 * Get week start date (Monday)
 */
export function getWeekStart(date = new Date()) {
    const d = new Date(date);
    const day = d.getDay();
    // Convert Sunday (0) to 7, then calculate days back to Monday
    const diff = day === 0 ? 6 : day - 1;
    const weekStart = new Date(d.setDate(d.getDate() - diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart;
}

/**
 * Get month start date
 */
export function getMonthStart(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Format duration in seconds to readable string
 */
export function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
}

/**
 * Download JSON file
 */
export function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Show toast notification
 */
export function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    document.body.appendChild(toast);

    // Stack toasts vertically by calculating offset based on existing toasts
    const existingToasts = document.querySelectorAll('.toast.show');
    let offset = 80; // Initial top position
    existingToasts.forEach(existingToast => {
        const rect = existingToast.getBoundingClientRect();
        offset = Math.max(offset, rect.bottom + 10);
    });
    toast.style.top = `${offset}px`;

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) {
                document.body.removeChild(toast);
            }
        }, 300);
    }, duration);
}

/**
 * Confirm dialog (browser default)
 */
export function confirmDialog(message) {
    return confirm(message);
}

/**
 * Custom styled confirmation modal
 */
export function showConfirmModal(options = {}) {
    const {
        title = 'Confirm Action',
        message = 'Are you sure?',
        confirmText = 'Delete',
        cancelText = 'Cancel',
        isDangerous = true
    } = options;

    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const confirmBtn = document.getElementById('confirm-modal-confirm');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        // Set content
        titleEl.textContent = title;
        messageEl.innerHTML = message.replace(/\n/g, '<br>');
        confirmBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;

        // Update button style
        confirmBtn.className = isDangerous ? 'btn btn-danger' : 'btn btn-primary';

        // Show modal
        modal.classList.add('active');

        // Handle confirm
        const handleConfirm = () => {
            cleanup();
            resolve(true);
        };

        // Handle cancel
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        // Cleanup function
        const cleanup = () => {
            modal.classList.remove('active');
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
        };

        // Add event listeners
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
    });
}

/**
 * Sort array by key
 */
export function sortBy(array, key, order = 'asc') {
    return [...array].sort((a, b) => {
        const aVal = typeof a[key] === 'string' ? a[key].toLowerCase() : a[key];
        const bVal = typeof b[key] === 'string' ? b[key].toLowerCase() : b[key];

        if (order === 'asc') {
            return aVal > bVal ? 1 : -1;
        } else {
            return aVal < bVal ? 1 : -1;
        }
    });
}

/**
 * Group array by key
 */
export function groupBy(array, key) {
    return array.reduce((groups, item) => {
        const group = item[key];
        if (!groups[group]) {
            groups[group] = [];
        }
        groups[group].push(item);
        return groups;
    }, {});
}

/**
 * Calculate percentage
 */
export function percentage(value, total) {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
}

/**
 * Clamp value between min and max
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Check if device is mobile
 */
export function isMobile() {
    return window.innerWidth < 768;
}

/**
 * Vibrate device (if supported)
 */
export function vibrate(duration = 50) {
    if ('vibrate' in navigator) {
        navigator.vibrate(duration);
    }
}

/**
 * Play sound (if enabled in settings)
 */
export function playSound(soundType = 'success') {
    // Placeholder for sound functionality
    // Can be implemented with audio files if needed
    console.log(`Playing sound: ${soundType}`);
}
