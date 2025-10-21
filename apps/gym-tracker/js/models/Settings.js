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
    }

    toJSON() {
        return {
            weightUnit: this.weightUnit,
            theme: this.theme,
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
