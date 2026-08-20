/**
 * Settings Model
 * Represents user preferences and settings.
 *
 * `weightUnit` is a DISPLAY/ENTRY preference only. Every stored weight in the
 * app is canonical kilograms (see utils/units.js), so switching kg → lb
 * converts what is shown and never rewrites what is stored.
 *
 * Plate/bar configuration is the one place where the unit is part of the
 * data rather than a view of it: a gym's rack holds physical 20 kg or 45 lb
 * plates, and those two stacks are unrelated numbers. They are therefore kept
 * as INDEPENDENT per-unit profiles, so flipping the display unit no longer
 * reinterprets a kg stack as pounds or silently destroys a customised setup
 * (GT-21).
 */
import { normalizeWeightUnit } from '../utils/units.js';

export class Settings {
    /**
     * Default kg plate stack.
     *
     * The 2026-08-10 stack included 45 kg and 35 kg plates, which are the
     * POUND sizes and do not exist in a kg-denominated gym; out of the box it
     * proposed unloadable hints such as "150 kg → 45 + 25 + 5" (GT-21). This
     * is the realistic stack. DEFAULTS_VERSION 2 rolls it onto installs that
     * never customised theirs.
     */
    static DEFAULT_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];

    /** kg stacks a user never chose, and which a default upgrade may replace. */
    static LEGACY_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];
    static SUPERSEDED_PLATES_KG = [45, 35, 25, 20, 15, 10, 5, 2.5, 1.25];

    /** Default lb plate stack and bar. */
    static DEFAULT_PLATES_LB = [45, 35, 25, 10, 5, 2.5];

    /** Default bar weight per unit. */
    static DEFAULT_BAR = { kg: 20, lb: 45 };

    /** Bumped whenever a shipped default changes; see applyDefaultUpgrades. */
    static DEFAULTS_VERSION = 2;

    /** A fresh, unconfigured equipment profile for one unit. */
    static defaultPlateProfile(unit) {
        const u = normalizeWeightUnit(unit);
        return {
            barWeight: Settings.DEFAULT_BAR[u],
            plates: (u === 'lb' ? Settings.DEFAULT_PLATES_LB : Settings.DEFAULT_PLATES_KG).slice(),
            // Per-exercise bar/base weight overrides, keyed by exercise id, in
            // THIS profile's unit. An EZ bar is ~7 kg / 15 lb, so the override
            // belongs with the rest of the unit's equipment (GT-40).
            exerciseBarWeights: {},
        };
    }

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

        // Per-unit equipment profiles. `barWeight` / `plates` /
        // `exerciseBarWeights` below are accessors onto the profile for the
        // CURRENT weightUnit, so every existing reader keeps working while
        // the two stacks stay independent.
        this.plateProfiles = Settings.normalizePlateProfiles(data);

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

    /**
     * Bar weight for the ACTIVE display unit. Assignment writes through to
     * that unit's profile, so existing `settings.barWeight = n` callers are
     * unchanged.
     */
    get barWeight() {
        return this.plateConfig().barWeight;
    }

    set barWeight(value) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) this.plateConfig().barWeight = n;
    }

    /** Available plate sizes for the ACTIVE display unit, descending. */
    get plates() {
        return this.plateConfig().plates;
    }

    set plates(value) {
        if (!Array.isArray(value)) return;
        this.plateConfig().plates = value
            .map(Number)
            .filter(n => Number.isFinite(n) && n > 0)
            .sort((a, b) => b - a);
    }

    /** Per-exercise bar/base weight overrides for the ACTIVE display unit. */
    get exerciseBarWeights() {
        return this.plateConfig().exerciseBarWeights;
    }

    /**
     * The equipment profile for `unit` (defaults to the active display unit),
     * creating it from the shipped defaults if it does not exist yet.
     */
    plateConfig(unit = this.weightUnit) {
        const u = normalizeWeightUnit(unit);
        if (!this.plateProfiles) this.plateProfiles = {};
        if (!this.plateProfiles[u]) {
            this.plateProfiles[u] = Settings.defaultPlateProfile(u);
        }
        return this.plateProfiles[u];
    }

    /**
     * Bar/base weight to use for one exercise, in `unit`: the per-exercise
     * override when the user set one, otherwise the profile's bar (GT-40).
     * `exerciseId` is stringified, so a DOM-sourced id and a stored numeric id
     * resolve to the same entry (the sameId rule, applied to a map key).
     */
    barWeightForExercise(exerciseId, unit = this.weightUnit) {
        const profile = this.plateConfig(unit);
        const override = profile.exerciseBarWeights?.[String(exerciseId)];
        return Number.isFinite(Number(override)) && Number(override) >= 0
            ? Number(override)
            : profile.barWeight;
    }

    /** Set (or, with a null/'' value, clear) one exercise's bar override. */
    setBarWeightForExercise(exerciseId, value, unit = this.weightUnit) {
        const profile = this.plateConfig(unit);
        if (!profile.exerciseBarWeights) profile.exerciseBarWeights = {};
        const key = String(exerciseId);
        const n = Number(value);
        if (value === null || value === '' || value === undefined
            || !Number.isFinite(n) || n < 0) {
            delete profile.exerciseBarWeights[key];
            return;
        }
        profile.exerciseBarWeights[key] = n;
    }

    /**
     * Build both equipment profiles from stored data, tolerating three
     * shapes: the current `plateProfiles`, the pre-2026-08-19 flat
     * `barWeight`/`plates` pair (which belonged to whatever unit the account
     * was on), and nothing at all.
     */
    static normalizePlateProfiles(data = {}) {
        const out = {
            kg: Settings.defaultPlateProfile('kg'),
            lb: Settings.defaultPlateProfile('lb'),
        };
        const stored = data.plateProfiles;
        ['kg', 'lb'].forEach((unit) => {
            const raw = stored && typeof stored === 'object' ? stored[unit] : null;
            if (!raw || typeof raw !== 'object') return;
            if (Number.isFinite(Number(raw.barWeight)) && Number(raw.barWeight) >= 0) {
                out[unit].barWeight = Number(raw.barWeight);
            }
            if (Array.isArray(raw.plates)) {
                const plates = raw.plates
                    .map(Number)
                    .filter(n => Number.isFinite(n) && n > 0)
                    .sort((a, b) => b - a);
                if (plates.length > 0) out[unit].plates = plates;
            }
            if (raw.exerciseBarWeights && typeof raw.exerciseBarWeights === 'object') {
                out[unit].exerciseBarWeights = { ...raw.exerciseBarWeights };
            }
        });

        // Legacy flat config: it was written in the account's unit at the
        // time, so it seeds THAT profile and leaves the other one at defaults.
        if (!stored) {
            const legacyUnit = normalizeWeightUnit(data.weightUnit);
            if (Number.isFinite(Number(data.barWeight)) && Number(data.barWeight) >= 0) {
                out[legacyUnit].barWeight = Number(data.barWeight);
            }
            if (Array.isArray(data.plates)) {
                const plates = data.plates
                    .map(Number)
                    .filter(n => Number.isFinite(n) && n > 0)
                    .sort((a, b) => b - a);
                if (plates.length > 0) out[legacyUnit].plates = plates;
            }
        }
        return out;
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
            plateProfiles: this.plateProfiles,
            // Mirrors of the ACTIVE profile. Kept in the payload so an export
            // read by an older build (or an older export read by this one)
            // still finds the plate config where it expects it.
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
     * Version 2 (2026-08-19): that kg stack is reverted - 45 kg and 35 kg are
     * pound sizes and produced unloadable plate hints (GT-21).
     *
     * A custom plate stack is left alone - only a stack that still matches a
     * shipped default is replaced. First-day and time-format have no such
     * tell (the old default and a deliberate choice are the same value), so
     * those move once and then never again.
     *
     * @returns {boolean} true when the caller should persist the result.
     */
    static applyDefaultUpgrades(settings) {
        if (!settings) return false;
        if (settings.defaultsVersion >= Settings.DEFAULTS_VERSION) return false;

        const from = settings.defaultsVersion || 0;

        if (from < 1) {
            if (settings.firstDayOfWeek === 0) settings.firstDayOfWeek = 1;
            if (settings.timeFormat === '12') settings.timeFormat = '24';
        }

        // v2: undo v1's kg stack wherever it is still the shipped value. The
        // kg profile is upgraded regardless of which unit the account
        // displays, because the profiles are independent now.
        const kg = settings.plateConfig ? settings.plateConfig('kg') : null;
        if (kg && Settings.sameStack(kg.plates, Settings.SUPERSEDED_PLATES_KG)) {
            kg.plates = Settings.DEFAULT_PLATES_KG.slice();
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
