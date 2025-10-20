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
            target: this.target
        };
    }

    static fromJSON(json) {
        return new Achievement(json);
    }
}
