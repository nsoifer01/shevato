/**
 * Helper Utilities
 * Common utility functions used throughout the app
 */

/**
 * Convert a raw muscleGroup string from the exercise database into a
 * friendly display label. The database uses two styles — lowercase-hyphenated
 * (e.g. "upper-pectorals") and already-title-cased (e.g. "Upper Chest") —
 * plus a few technical anatomical names we want to translate for humans.
 * Returns '' for missing/empty input.
 */
export function formatMuscleGroup(raw) {
    if (!raw) return '';
    const key = String(raw).trim().toLowerCase();
    const FRIENDLY = {
        // Chest
        'pectorals': 'Chest',
        'upper-pectorals': 'Upper Chest',
        'lower-pectorals': 'Lower Chest',
        'inner-pectorals': 'Inner Chest',
        'outer-pectorals': 'Outer Chest',
        // Back
        'lats': 'Lats',
        'outer-lats': 'Outer Lats',
        'lower-lats': 'Lower Lats',
        'upper-back': 'Upper Back',
        'mid-back': 'Mid Back',
        'lower-back': 'Lower Back',
        // Shoulders
        'front-deltoids': 'Front Delts',
        'rear-deltoids': 'Rear Delts',
        'side-deltoids': 'Side Delts',
        'rotator-cuff': 'Rotator Cuff',
        // Arms
        'biceps': 'Biceps',
        'triceps': 'Triceps',
        'brachialis': 'Brachialis',
        'forearms': 'Forearms',
        // Legs
        'quads': 'Quads',
        'quadriceps': 'Quads',
        'hamstrings': 'Hamstrings',
        'glutes': 'Glutes',
        'calves': 'Calves',
        'adductors': 'Adductors',
        'hip-adductors': 'Adductors',
        'abductors': 'Abductors',
        'hip-flexors': 'Hip Flexors',
        'tibialis': 'Tibialis',
        // Core / trunk / traps / neck
        'core': 'Core',
        'abs': 'Abs',
        'obliques': 'Obliques',
        'traps': 'Traps',
        'neck': 'Neck',
        'full-body': 'Full Body',
        'legs': 'Legs',
    };
    if (FRIENDLY[key]) return FRIENDLY[key];
    // Fallback: if already title-cased with spaces, return as-is; otherwise
    // convert "foo-bar" / "foo_bar" to "Foo Bar".
    return String(raw)
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

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
 * Format a workout session's date + time-of-day for display.
 * Returns e.g. "Apr 20, 2026 • 6:42 PM". Falls back to just the date when
 * no precise timestamp is available (very old data).
 */
export function formatSessionDateTime(session) {
    if (!session) return '';
    const datePart = formatDate(session.date);
    // Prefer endTime; fall back through startTime then timestamp.
    const timeSrc = session.endTime || session.startTime || session.timestamp;
    if (!timeSrc) return datePart;
    const d = new Date(timeSrc);
    if (Number.isNaN(d.getTime())) return datePart;
    const time = d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
    return `${datePart} • ${time}`;
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
 * Show toast notification.
 *
 * Accepts either `showToast(message, type, duration)` or
 * `showToast(message, type, duration, { action: { label, onClick } })`.
 * When `action` is provided, the toast renders an inline button. Clicking
 * the button invokes `onClick` and dismisses the toast.
 */
export function showToast(message, type = 'info', duration = 3000, opts = {}) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;
    toast.appendChild(msg);

    let dismiss;

    if (opts.action && opts.action.label) {
        toast.classList.add('toast-has-action');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-action';
        btn.textContent = opts.action.label;
        btn.addEventListener('click', () => {
            try {
                if (typeof opts.action.onClick === 'function') opts.action.onClick();
            } finally {
                dismiss && dismiss();
            }
        });
        toast.appendChild(btn);
    }

    document.body.appendChild(toast);

    // Stack toasts vertically by calculating offset based on existing toasts
    const existingToasts = document.querySelectorAll('.toast.show');
    let offset = 80; // Initial top position
    existingToasts.forEach(existingToast => {
        const rect = existingToast.getBoundingClientRect();
        offset = Math.max(offset, rect.bottom + 10);
    });
    toast.style.top = `${offset}px`;

    setTimeout(() => { toast.classList.add('show'); }, 10);

    let removed = false;
    dismiss = () => {
        if (removed) return;
        removed = true;
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    };

    setTimeout(dismiss, duration);

    return { dismiss };
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
        warning = '',
        confirmText = 'Delete',
        cancelText = 'Cancel',
        isDangerous = true
    } = options;

    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const modalContent = modal.querySelector('.modal-content');
        const iconEl = document.getElementById('confirm-modal-icon');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const warningEl = document.getElementById('confirm-modal-warning');
        const warningTextEl = document.getElementById('confirm-modal-warning-text');
        const confirmBtn = document.getElementById('confirm-modal-confirm');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        // Set content
        titleEl.textContent = title;
        messageEl.innerHTML = message.replace(/\n/g, '<br>');
        confirmBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;

        // Warning strip
        if (warning) {
            warningTextEl.textContent = warning;
            warningEl.hidden = false;
        } else {
            warningEl.hidden = true;
        }

        // Danger vs non-danger styling
        if (isDangerous) {
            modalContent.classList.add('confirm-modal-danger');
            iconEl.hidden = false;
            confirmBtn.className = 'btn btn-danger';
        } else {
            modalContent.classList.remove('confirm-modal-danger');
            iconEl.hidden = true;
            confirmBtn.className = 'btn btn-primary';
        }

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
