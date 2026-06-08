/**
 * Settings Model
 * Represents user preferences and settings
 */
export class Settings {
    constructor(data = {}) {
        this.weightUnit = data.weightUnit || 'kg'; // 'kg' or 'lb'
        this.theme = data.theme || 'dark'; // 'light' or 'dark'
        this.dateFormat = data.dateFormat || 'MM/DD/YYYY';
        this.firstDayOfWeek = data.firstDayOfWeek || 0; // 0 = Sunday, 1 = Monday
        // Independent sound and vibration cues for PRs + rest-timer completion.
        // Default on — most useful the first time the user logs a set, so
        // opt-out rather than opt-in.
        // `restAlerts` is the legacy combined flag; when present it seeds
        // both new fields so users who toggled it before don't lose their
        // preference.
        const legacy = data.restAlerts;
        this.soundAlerts = data.soundAlerts !== undefined
            ? data.soundAlerts
            : (legacy !== undefined ? legacy : true);
        this.vibrationAlerts = data.vibrationAlerts !== undefined
            ? data.vibrationAlerts
            : (legacy !== undefined ? legacy : true);

        // Rest-timer sound markers (Item R2-1: free numeric, not fixed options).
        //   timerFirstWarningSeconds: a single early heads-up tone fires when
        //     this many seconds remain. 0 = Off, capped at 120. Default 10.
        //   timerCountdownSeconds: per-second pips + urgent styling begin when
        //     this many seconds remain. Minimum 1, capped at 60. Default 5
        //     (the prior hard-coded value).
        // Legacy data (including the old fixed-option values) loads unchanged
        // because those values fall inside the new accepted ranges.
        this.timerFirstWarningSeconds = Settings.normalizeFirstWarningSeconds(
            data.timerFirstWarningSeconds);
        this.timerCountdownSeconds = Settings.normalizeCountdownSeconds(
            data.timerCountdownSeconds);

        // Plate calculator config. `barWeight` and `plates` are stored in
        // the user's `weightUnit`. Defaults match the most common gym
        // setup: a 20 kg / 45 lb bar plus a standard plate stack.
        this.barWeight = typeof data.barWeight === 'number'
            ? data.barWeight
            : (this.weightUnit === 'lb' ? 45 : 20);
        this.plates = Array.isArray(data.plates)
            ? data.plates.slice().sort((a, b) => b - a)
            : (this.weightUnit === 'lb'
                ? [45, 35, 25, 10, 5, 2.5]
                : [25, 20, 15, 10, 5, 2.5, 1.25]);

        // Time-of-day display preference. '12' renders "6:42 PM";
        // '24' renders "18:42". Used everywhere the app shows a time
        // (history cards, calendar selected-day rows, workout timer
        // displays). Defaults to 12-hour to match the existing format.
        this.timeFormat = data.timeFormat === '24' ? '24' : '12';

        // Whether plate-calculator hints are visible on planned set rows.
        // Defaults to true (existing behaviour) so current users are unaffected
        // until they explicitly toggle it off during a workout.
        this.plateHintsEnabled = data.plateHintsEnabled !== false;

        // Per-exercise plate-hints override. Maps exerciseId (string) -> boolean.
        // When an entry exists it overrides plateHintsEnabled for that exercise.
        // Persisted so the choice survives workout restarts.
        this.exercisePlateHints = (typeof data.exercisePlateHints === 'object' && data.exercisePlateHints !== null)
            ? { ...data.exercisePlateHints }
            : {};

        // Whether the calendar overlays each program's scheduled weekdays.
        // Defaults to true (on) so the planned split is visible out of the box;
        // legacy settings without this key load with the default.
        this.showProgramSchedule = data.showProgramSchedule !== false;
    }

    toJSON() {
        return {
            weightUnit: this.weightUnit,
            theme: this.theme,
            dateFormat: this.dateFormat,
            firstDayOfWeek: this.firstDayOfWeek,
            soundAlerts: this.soundAlerts,
            vibrationAlerts: this.vibrationAlerts,
            timerFirstWarningSeconds: this.timerFirstWarningSeconds,
            timerCountdownSeconds: this.timerCountdownSeconds,
            barWeight: this.barWeight,
            plates: this.plates,
            timeFormat: this.timeFormat,
            plateHintsEnabled: this.plateHintsEnabled,
            exercisePlateHints: this.exercisePlateHints,
            showProgramSchedule: this.showProgramSchedule,
        };
    }

    /**
     * Coerce a stored timer-marker value to one of the allowed options,
     * falling back to `fallback` for missing/invalid legacy data. Retained for
     * any callers passing an explicit option list; the free-numeric markers
     * (Item R2-1) use the range helpers below.
     */
    static normalizeTimerSeconds(value, allowed, fallback) {
        const n = Number(value);
        return allowed.includes(n) ? n : fallback;
    }

    /**
     * Item R2-1: normalize the first-warning marker to an integer in [0, 120].
     * 0 means Off. Missing/invalid input falls back to the default (10).
     */
    static normalizeFirstWarningSeconds(value) {
        if (value === undefined || value === null || value === '') return 10;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < 0) return 10;
        return Math.min(n, 120);
    }

    /**
     * Item R2-1: normalize the countdown-start marker to an integer in [1, 60].
     * Missing/invalid input falls back to the default (5).
     */
    static normalizeCountdownSeconds(value) {
        if (value === undefined || value === null || value === '') return 5;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < 1) return 5;
        return Math.min(n, 60);
    }

    static fromJSON(json) {
        return new Settings(json);
    }

    static getDefault() {
        return new Settings();
    }
}
