/**
 * Helper Utilities
 * Common utility functions used throughout the app
 */
import { fromCanonicalWeight, KG_PER_LB } from './units.js';

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
        'shoulders': 'Shoulders',
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
            month: 'short',
            day: 'numeric'
        });
    }

    if (format === 'time') {
        return date.toLocaleTimeString('en-US', {
            ...timeFormatOptions(),
        });
    }

    return date.toLocaleDateString('en-US');
}

/**
 * Read the user's time-format preference from the live app singleton
 * (window.gymApp.settings.timeFormat). Defaults to 24-hour, matching
 * models/Settings.js (the shipped default, owner call 2026-08-10), so the
 * early boot window before settings load renders the same clock the app
 * settles on instead of flashing 12-hour first. An explicit '12' setting
 * is respected; everything else means 24.
 */
export function getTimeFormat() {
    try {
        const tf = window.gymApp?.settings?.timeFormat;
        return tf === '12' ? '12' : '24';
    } catch (_) {
        return '24';
    }
}

/**
 * Build the toLocaleTimeString options for the user's preferred clock.
 * 12-hour: "6:42 PM" / 24-hour: "18:42". Always shows minutes,
 * hides seconds.
 */
export function timeFormatOptions() {
    if (getTimeFormat() === '24') {
        return { hour: '2-digit', minute: '2-digit', hour12: false };
    }
    return { hour: 'numeric', minute: '2-digit', hour12: true };
}

/**
 * Format a Date or ISO-ish string as time-of-day in the user's chosen
 * 12/24h clock. Returns '' for unparseable input.
 */
export function formatTimeOfDay(value) {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, timeFormatOptions());
}

/**
 * "1 set" / "2 sets" - a count with its correctly inflected noun.
 *
 * The app shipped "1 sets", "1 exercises" and "9 exercises / 1 sets" on the
 * history cards and the Home recent list (GT-33) because each call site
 * hand-appended an "s". One helper, used everywhere a count is rendered.
 *
 * `plural` defaults to `singular + 's'`, which covers every noun the app
 * actually counts; pass it explicitly for anything irregular.
 */
export function pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${Math.abs(Number(count)) === 1 ? singular : plural}`;
}

/** The noun alone, correctly inflected - for "Sets: 1 set" style layouts. */
export function pluralLabel(count, singular, plural = `${singular}s`) {
    return Math.abs(Number(count)) === 1 ? singular : plural;
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
    const time = formatTimeOfDay(timeSrc);
    return time ? `${datePart}, ${time}` : datePart;
}

/**
 * Convert a weight between units, rounded to one decimal FOR DISPLAY.
 *
 * Kept for display-only call sites. Anything that stores the result must use
 * `utils/units.js` `toCanonicalWeight` / `fromCanonicalWeight` instead:
 * rounding on the way into storage is what makes a kg → lb → kg round trip
 * drift (135 lb would come back as 134.9).
 */
export function convertWeight(weight, fromUnit, toUnit) {
    if (fromUnit === toUnit) return weight;

    if (fromUnit === 'kg' && toUnit === 'lb') {
        return Math.round((weight / KG_PER_LB) * 10) / 10;
    }

    if (fromUnit === 'lb' && toUnit === 'kg') {
        return Math.round((weight * KG_PER_LB) * 10) / 10;
    }

    return weight;
}

/**
 * Escape HTML to prevent XSS
 */
// Escape for HTML, INCLUDING both quote characters.
//
// The `div.textContent -> div.innerHTML` trick escapes &, < and > and leaves
// " and ' alone, because a text node does not need them escaped. That is only
// safe while every interpolation lands in element CONTENT. It does not here:
// several views interpolate escaped values into `title=`, `value=` and
// `data-*` attributes, and today those values happen to be internal strings,
// which is one refactor away from not being true, so a value carrying a double quote closes
// the attribute and the rest of the string becomes markup of the author's
// choosing. Escape all five, like the shared assets/js/escape-html.js.
export function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/**
 * Verbose logging gate. Routine init/navigation logs inside the app
 * are noisy in production; gate them behind `localStorage.gymTrackerDebug`
 * (set to "true") or a `window.GYM_DEBUG = true` flag the user can set
 * from the console. Errors and warnings stay un-gated.
 */
export function debugLog(...args) {
    let on = false;
    try { on = localStorage.getItem('gymTrackerDebug') === 'true'; } catch (_) { /* private mode */ }
    if (!on && typeof window !== 'undefined' && window.GYM_DEBUG === true) on = true;
    if (on) console.log(...args);
}

/**
 * Generate a unique string ID. Prefers `crypto.randomUUID()` when
 * available (all supported gym-tracker browsers since 2022) so two
 * devices creating an entity in the same millisecond can't collide.
 * Falls back to a timestamp + random base36 suffix for very old
 * browsers and non-secure contexts (file://).
 */
export function generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return Date.now() + Math.random().toString(36).slice(2, 11);
}

/**
 * Generate a unique NUMERIC ID. Models that get interpolated into inline
 * onclick handlers (`onclick="...(${program.id})"`) need numeric IDs —
 * a UUID-style string would break the JS expression at runtime. This
 * helper combines a millisecond timestamp, a per-process counter, and
 * a small per-call random component so two IDs created in the same
 * millisecond on the same device still differ. Once the inline-onclick
 * patterns are replaced with event delegation, the models can switch
 * to `generateId()` and emit UUIDs.
 */
let _idCounter = 0;
export function generateNumericId() {
    _idCounter = (_idCounter + 1) & 0xfff; // 12 bits → 4096 slots / ms
    // Stay inside JS Number's safe-integer range (2^53) so the bottom
    // digits don't round off.
    //   - 41 bits for the ms timestamp (~year 2065 worst case)
    //   - 12 bits for the per-ms entropy (counter)
    // = 53 bits total. Two IDs created in the same ms only collide if
    // both land in the same counter slot — by then the counter has
    // already cycled 4095 times, so for any realistic single-page rate
    // this is collision-free.
    return Date.now() * 0x1000 + _idCounter;
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
 * Download a text file (CSV export). Mirrors downloadJSON: a Blob object
 * URL, so the download works fully offline with no network round-trip.
 */
export function downloadText(text, filename, mimeType = 'text/plain') {
    const blob = new Blob([text], { type: mimeType });
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
 * Escape a single CSV field per RFC 4180: quote it when it contains a
 * comma, a double quote, CR or LF, and double up any embedded quotes.
 * null / undefined become an empty field.
 */
export function escapeCsvField(value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/** Column order of the per-set CSV export. */
export const SETS_CSV_HEADER = [
    'date', 'program', 'exercise', 'setNumber',
    'weight', 'reps', 'duration', 'volume', 'unit',
];

/**
 * Flatten every COMPLETED set across all sessions into a per-set CSV.
 *
 * One row per completed set. Timed sets (duration > 0) report seconds in
 * `duration` and leave weight, reps AND volume empty - a hold has no
 * weight-volume, and the old behaviour of writing the seconds into `volume`
 * under `unit=kg` shipped "60 kg" for a one-minute plank straight into the
 * user's spreadsheet (GT-04). Rep sets report weight + reps and leave
 * duration empty.
 *
 * Weights are stored canonically in kilograms and converted once here into
 * `displayUnit`, which is stamped on every row - so the file is internally
 * consistent instead of mixing units per session (GT-03).
 *
 * Returns { csv, rowCount } so callers can tell "nothing logged yet" from
 * "header plus rows" without re-walking the data.
 *
 * `resolveName(exerciseId, fallback)` (optional) maps the stored
 * exerciseName snapshot to the exercise's current catalog name, so a
 * renamed exercise exports under ONE name instead of splitting rows
 * between the old and new spellings. Defaults to the snapshot as-is.
 */
export function buildSetsCsv(sessions, displayUnit = 'kg', resolveName = (id, fallback) => fallback) {
    const unit = displayUnit === 'lb' ? 'lb' : 'kg';
    const lines = [SETS_CSV_HEADER.join(',')];
    const show = (kg) => {
        const converted = fromCanonicalWeight(kg, unit);
        return converted === null ? '' : Math.round(converted * 100) / 100;
    };

    (sessions || []).forEach((session) => {
        (session.exercises || []).forEach((exercise) => {
            (exercise.sets || []).forEach((set, index) => {
                if (!set.completed) return;
                const duration = Number(set.duration) || 0;
                const weight = Number(set.weight) || 0;
                const reps = Number(set.reps) || 0;
                const timed = duration > 0;
                // Prefer the stable user-facing slot; legacy sets without one
                // fall back to array position, same as the render layer.
                const setNumber = set.slot != null ? Number(set.slot) + 1 : index + 1;
                lines.push([
                    session.date,
                    session.workoutDayName,
                    resolveName(exercise.exerciseId, exercise.exerciseName),
                    setNumber,
                    timed ? '' : show(weight),
                    timed ? '' : reps,
                    timed ? duration : '',
                    timed ? '' : show(weight * reps),
                    unit,
                ].map(escapeCsvField).join(','));
            });
        });
    });

    return { csv: lines.join('\r\n'), rowCount: lines.length - 1 };
}

/**
 * Progress toward a measurement goal as an integer percent, clamped 0-100.
 *
 * `baseline` is the earliest logged value for the metric, `current` the
 * latest. A 'decrease' goal fills as the value drops toward the target; an
 * 'increase' goal fills as it rises. When the baseline already sits at or
 * past the target there is no span to travel, so the result is simply 100
 * (target met) or 0. Returns null when any input is not a finite number.
 */
export function computeGoalProgress(baseline, current, goal) {
    // Number(null) is 0, so blanks are rejected before coercion.
    const toNumber = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const from = toNumber(baseline);
    const now = toNumber(current);
    const target = toNumber(goal?.target);
    if (!Number.isFinite(from) || !Number.isFinite(now) || !Number.isFinite(target)) return null;

    const decrease = goal.direction === 'decrease';
    const span = decrease ? from - target : target - from;
    const moved = decrease ? from - now : now - from;
    if (span <= 0) {
        return (decrease ? now <= target : now >= target) ? 100 : 0;
    }
    return Math.max(0, Math.min(100, Math.round((moved / span) * 100)));
}

/**
 * Distance from the bottom of the viewport the first toast sits at. The CSS
 * adds the bottom-nav height on top via a calc(), so this is the gap ABOVE
 * whatever chrome the current breakpoint has.
 */
const TOAST_BASE_OFFSET = 12;

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

    // Toasts stack UPWARD from the bottom of the viewport.
    //
    // They used to be pinned to the top, which put "Program saved
    // successfully" squarely over the Programs SORT row - the control the
    // user reaches for next (GT-37). The bottom of the screen holds only the
    // nav (which the offset clears) and, during rest, the timer dial (which
    // CSS lifts them above), so nothing a user is about to press lives there.
    const existing = Array.from(document.querySelectorAll('.toast.show'));
    let offset = TOAST_BASE_OFFSET;
    existing.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const fromBottom = window.innerHeight - rect.top;
        offset = Math.max(offset, fromBottom + 10);
    });
    toast.style.bottom = `${offset}px`;

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

        // Show modal with focus trap (Tab cycles inside, Esc cancels,
        // focus restores on close).
        modal.classList.add('active');
        // Lazy import to avoid a hard dependency cycle in helpers.js.
        import('./modal-focus.js').then(({ trapModalFocus }) => trapModalFocus(modal))
            .catch(() => { /* trap is best-effort */ });

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
            modal.removeEventListener('keydown', escHandler);
        };

        // Esc cancels (mirrors the focus-trap's Esc → close behavior, but
        // here we resolve false rather than just removing the active class
        // so the awaiting Promise is settled).
        const escHandler = (e) => { if (e.key === 'Escape') handleCancel(); };
        modal.addEventListener('keydown', escHandler);

        // Add event listeners
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
    });
}

/**
 * Vibrate device (if supported). Defensive against non-browser contexts
 * where `navigator` is undefined (Node tests, Workers without DOM, etc.)
 * so importing this module never throws at load.
 */
export function vibrate(duration = 50) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(duration);
    }
}

/**
 * Play a short beep using Web Audio. No assets, no network, and safely
 * no-ops in browsers that don't expose AudioContext (older iOS WebView).
 *
 * Sound types:
 *   'rest-done' → two quick ascending tones (800 → 1200 Hz)
 *   'pr'        → a single bright chime (1400 Hz)
 *   other       → a single 800 Hz blip
 *
 * Autoplay policy: browsers block AudioContext until a user gesture,
 * but the Start-Workout tap already satisfies that by the time any of
 * this would fire. Users who have never tapped anything get silence.
 */
let _audioCtx = null;

/**
 * Return a usable AudioContext, recreating it if the cached one was closed.
 * On iOS/Android the context can transition to `closed` or `interrupted`
 * (phone call, screen lock, audio focus loss). A `closed` context can never
 * play again, so it must be discarded and replaced; an `interrupted` /
 * `suspended` one only needs `resume()`. Returns null when Web Audio is
 * unavailable (older iOS WebView).
 */
function getAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (_audioCtx && _audioCtx.state === 'closed') {
        _audioCtx = null;
    }
    if (!_audioCtx) {
        _audioCtx = new Ctx();
    }
    return _audioCtx;
}

/**
 * Emit the tones for `soundType` on `ctx`, scheduling everything relative to
 * the context's current time. Split out so it can run either immediately or
 * after an async `resume()` resolves.
 */
function emitTones(ctx, soundType) {
    const now = ctx.currentTime;
    const play = (freq, startAt, dur = 0.15, vol = 0.18) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        // Short attack/decay envelope so it doesn't click.
        gain.gain.setValueAtTime(0, now + startAt);
        gain.gain.linearRampToValueAtTime(vol, now + startAt + 0.01);
        gain.gain.linearRampToValueAtTime(0, now + startAt + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + startAt);
        osc.stop(now + startAt + dur + 0.02);
    };

    if (soundType === 'rest-done') {
        play(800, 0);
        play(1200, 0.18);
    } else if (soundType === 'pr') {
        play(1400, 0, 0.22, 0.22);
        play(1800, 0.12, 0.18, 0.18);
    } else if (soundType === 'timer-warn') {
        // First-warning cue: a single mid sine tone, clearly distinct from
        // the per-second square pip used for the final countdown.
        play(1046, 0, 0.28, 0.2);
    } else if (soundType === 'timer-low') {
        // Brief square pip at 880 Hz (matches Arena timerLow).
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filt = ctx.createBiquadFilter();
        osc.type = 'square';
        osc.frequency.value = 880;
        filt.type = 'lowpass';
        filt.frequency.value = 2200;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.07, now + 0.005);
        gain.gain.linearRampToValueAtTime(0, now + 0.07);
        osc.connect(filt).connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.09);
    } else {
        play(800, 0);
    }
}

export function playSound(soundType = 'success') {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        // resume() is async; a suspended/interrupted context that isn't awaited
        // swallows the first scheduled tone. Schedule after it resolves so the
        // first sound following a suspension still plays. currentTime advances
        // once resumed, so emitTones reads it fresh inside the callback.
        if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
            const resumed = ctx.resume();
            if (resumed && typeof resumed.then === 'function') {
                resumed.then(() => emitTones(ctx, soundType)).catch(() => {});
                return;
            }
        }
        emitTones(ctx, soundType);
    } catch {
        // Intentionally swallow — audio is a nice-to-have, never critical.
    }
}

/**
 * Proactively recover the audio context when the tab/app returns to the
 * foreground. Mobile browsers suspend or interrupt the context while
 * backgrounded; resuming on `visibilitychange` means the next timer/PR
 * sound during a workout isn't lost. Safe to call when Web Audio is
 * unavailable (no-ops).
 */
export function resumeAudioContext() {
    try {
        // Only RESUME an already-created context — never create one here.
        // getAudioContext() lazily news up a context, and this runs from the
        // visibilitychange listener (no user gesture), which makes Chrome log
        // "The AudioContext was not allowed to start...". The context is
        // created on the first real sound during a workout (a user gesture).
        const ctx = _audioCtx;
        if (ctx && ctx.state !== 'closed' && ctx.state !== 'running' && typeof ctx.resume === 'function') {
            ctx.resume().catch(() => {});
        }
    } catch {
        // no-op
    }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') resumeAudioContext();
    });
}
