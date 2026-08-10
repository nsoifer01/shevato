/**
 * Settings Model
 * Represents user preferences and settings
 */
export class Settings {
    /**
     * Default plate stack for kg (owner call, 2026-08-10). Also the list the
     * one-time defaults upgrade in app.js recognises as "never customised",
     * alongside LEGACY_PLATES_KG below.
     */
    static DEFAULT_PLATES_KG = [45, 35, 25, 20, 15, 10, 5, 2.5, 1.25];

    /** The kg stack shipped before that change. */
    static LEGACY_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];

    /** Bumped whenever a shipped default changes; see applyDefaultUpgrades. */
    static DEFAULTS_VERSION = 1;

    constructor(data = {}) {
        this.weightUnit = data.weightUnit || 'kg'; // 'kg' or 'lb'
        this.theme = data.theme || 'dark'; // 'light' or 'dark'
        this.dateFormat = data.dateFormat || 'MM/DD/YYYY';
        // 0 = Sunday, 1 = Monday. Monday by default (owner call, 2026-08-10);
        // a stored 0 is a deliberate choice and must survive, so this reads
        // "is a valid day present" rather than falling back on falsiness.
        this.firstDayOfWeek = data.firstDayOfWeek === 0 || data.firstDayOfWeek === 1
            ? data.firstDayOfWeek
            : 1;
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
                : Settings.DEFAULT_PLATES_KG.slice());

        // Time-of-day display preference. '12' renders "6:42 PM";
        // '24' renders "18:42". Used everywhere the app shows a time
        // (history cards, calendar selected-day rows, workout timer
        // displays). Defaults to 24-hour (owner call, 2026-08-10).
        this.timeFormat = data.timeFormat === '12' ? '12' : '24';

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

        // Which generation of app defaults this object has been through. Every
        // install writes its settings on first boot, so a changed default is
        // invisible to existing users without this - see applyDefaultUpgrades.
        this.defaultsVersion = Number.isFinite(data.defaultsVersion) ? data.defaultsVersion : 0;
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
            defaultsVersion: this.defaultsVersion,
        };
    }

    /**
     * Roll newer app defaults onto settings that were stored under older ones,
     * exactly once per install (guarded by `defaultsVersion`).
     *
     * Version 1 (2026-08-10): Monday starts the week, times render 24-hour,
     * and the kg plate stack gains 45/35/20/15.
     *
     * A custom plate stack is left alone - only the stack that still matches a
     * shipped default is replaced. First-day and time-format have no such
     * tell (the old default and a deliberate choice are the same value), so
     * those move once and then never again.
     *
     * @returns {boolean} true when the caller should persist the result.
     */
    static applyDefaultUpgrades(settings) {
        if (!settings) return false;
        if (settings.defaultsVersion >= Settings.DEFAULTS_VERSION) return false;

        if (settings.firstDayOfWeek === 0) settings.firstDayOfWeek = 1;
        if (settings.timeFormat === '12') settings.timeFormat = '24';
        if (settings.weightUnit !== 'lb'
            && Settings.sameStack(settings.plates, Settings.LEGACY_PLATES_KG)) {
            settings.plates = Settings.DEFAULT_PLATES_KG.slice();
        }

        settings.defaultsVersion = Settings.DEFAULTS_VERSION;
        return true;
    }

    /** Order-insensitive equality for two plate stacks. */
    static sameStack(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        const sortDesc = (list) => list.slice().map(Number).sort((x, y) => y - x);
        const left = sortDesc(a), right = sortDesc(b);
        return left.every((n, i) => n === right[i]);
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
