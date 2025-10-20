/**
 * Settings Model
 * Represents user preferences and settings
 */
export class Settings {
    constructor(data = {}) {
        this.weightUnit = data.weightUnit || 'kg'; // 'kg' or 'lb'
        this.theme = data.theme || 'dark'; // 'light' or 'dark'
        this.defaultRestTime = data.defaultRestTime || 90; // in seconds
        this.enableRestTimer = data.enableRestTimer !== undefined ? data.enableRestTimer : true;
        this.enableNotifications = data.enableNotifications !== undefined ? data.enableNotifications : true;
        this.enableSound = data.enableSound !== undefined ? data.enableSound : true;
        this.dateFormat = data.dateFormat || 'MM/DD/YYYY';
        this.firstDayOfWeek = data.firstDayOfWeek || 0; // 0 = Sunday, 1 = Monday
    }

    toJSON() {
        return {
            weightUnit: this.weightUnit,
            theme: this.theme,
            defaultRestTime: this.defaultRestTime,
            enableRestTimer: this.enableRestTimer,
            enableNotifications: this.enableNotifications,
            enableSound: this.enableSound,
            dateFormat: this.dateFormat,
            firstDayOfWeek: this.firstDayOfWeek
        };
    }

    static fromJSON(json) {
        return new Settings(json);
    }

    static getDefault() {
        return new Settings();
    }
}
