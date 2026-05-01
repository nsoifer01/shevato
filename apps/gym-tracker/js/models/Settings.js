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
    }

    toJSON() {
        return {
            weightUnit: this.weightUnit,
            theme: this.theme,
            dateFormat: this.dateFormat,
            firstDayOfWeek: this.firstDayOfWeek,
            soundAlerts: this.soundAlerts,
            vibrationAlerts: this.vibrationAlerts,
            barWeight: this.barWeight,
            plates: this.plates
        };
    }

    static fromJSON(json) {
        return new Settings(json);
    }

    static getDefault() {
        return new Settings();
    }
}
