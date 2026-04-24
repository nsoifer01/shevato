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
    }

    toJSON() {
        return {
            weightUnit: this.weightUnit,
            theme: this.theme,
            dateFormat: this.dateFormat,
            firstDayOfWeek: this.firstDayOfWeek,
            soundAlerts: this.soundAlerts,
            vibrationAlerts: this.vibrationAlerts
        };
    }

    static fromJSON(json) {
        return new Settings(json);
    }

    static getDefault() {
        return new Settings();
    }
}
