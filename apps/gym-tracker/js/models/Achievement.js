/**
 * Achievement Model
 * Represents an achievement/objective that can be unlocked
 */
export class Achievement {
    constructor(data = {}) {
        this.id = data.id || '';
        this.name = data.name || '';
        this.description = data.description || '';
        this.type = data.type || 'global'; // 'daily', 'weekly', 'monthly', 'global'
        this.icon = data.icon || '🏆';
        this.requirement = data.requirement || {}; // Condition to unlock
        this.unlocked = data.unlocked || false;
        this.unlockedAt = data.unlockedAt || null;
        this.progress = data.progress || 0; // Current progress towards requirement
        this.target = data.target || 100; // Target value for requirement

        // Feature 4: optional strength-PR metadata. Only present on
        // per-exercise PR achievements (type 'strength-pr'); undefined
        // otherwise so existing achievements serialize unchanged.
        this.prWeightKg = data.prWeightKg;       // canonical kilograms
        this.prUnit = data.prUnit;               // unit to display ('kg' | 'lb')
        this.prExerciseName = data.prExerciseName;
        this.prDate = data.prDate;               // YYYY-MM-DD
    }

    get progressPercentage() {
        return Math.min(100, Math.floor((this.progress / this.target) * 100));
    }

    unlock() {
        if (!this.unlocked) {
            this.unlocked = true;
            this.unlockedAt = new Date().toISOString();
        }
    }

    updateProgress(value) {
        this.progress = value;
        if (this.progress >= this.target && !this.unlocked) {
            this.unlock();
        }
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            type: this.type,
            icon: this.icon,
            requirement: this.requirement,
            unlocked: this.unlocked,
            unlockedAt: this.unlockedAt,
            progress: this.progress,
            target: this.target,
            ...(this.prWeightKg !== undefined ? { prWeightKg: this.prWeightKg } : {}),
            ...(this.prUnit !== undefined ? { prUnit: this.prUnit } : {}),
            ...(this.prExerciseName !== undefined ? { prExerciseName: this.prExerciseName } : {}),
            ...(this.prDate !== undefined ? { prDate: this.prDate } : {}),
        };
    }

    static fromJSON(json) {
        return new Achievement(json);
    }

    /**
     * Whether an achievement carries enough data to render meaningfully.
     * Strength-PR cards (Feature 4) need a positive canonical weight and a
     * date; a legacy or partially-synced record missing those would render
     * as "0 kg" / "Invalid Date", so it is treated as not renderable and
     * filtered out at load and render time. All other achievement types are
     * always renderable.
     */
    static isRenderable(achievement) {
        if (!achievement || achievement.requirement?.type !== 'strength-pr') {
            return true;
        }
        return typeof achievement.prWeightKg === 'number'
            && Number.isFinite(achievement.prWeightKg)
            && achievement.prWeightKg > 0
            && !!achievement.prDate;
    }
}
