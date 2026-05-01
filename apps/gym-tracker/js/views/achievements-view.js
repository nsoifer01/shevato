/**
 * Achievements View Controller
 * Renders achievements as a grouped progression system rather than a flat list.
 */
import { app } from '../app.js';
import { AchievementService } from '../services/AchievementService.js';
import { DarkSelect } from '../utils/dark-select.js';
import { escapeHtml } from '../utils/helpers.js';

const VOLUME_TYPES = new Set(['total-volume', 'daily-volume']);

const CATEGORY_META = {
    'total-workouts':     { name: 'Total Workouts',     icon: '🏋️', desc: 'Lifetime workout count milestones' },
    'workout-streak':     { name: 'Workout Streaks',    icon: '🔥', desc: 'Consecutive days of training' },
    'total-volume':       { name: 'Volume Lifted',      icon: '⚖️', desc: 'Total weight moved across all workouts' },
    'total-sets':         { name: 'Total Sets',         icon: '📊', desc: 'Lifetime sets completed' },
    'total-reps':         { name: 'Total Reps',         icon: '🔁', desc: 'Lifetime reps completed' },
    'exercises-completed':{ name: 'Exercise Variety',   icon: '🎯', desc: 'Distinct exercises tried' },
    'workout-today':      { name: 'Daily Activity',     icon: '⭐', desc: "Show up and train" },
    'daily-volume':       { name: 'Single-Workout Volume', icon: '💪', desc: 'Volume hit in a single workout' },
    'weekly-workouts':    { name: 'Weekly Goals',       icon: '📅', desc: 'Workouts in a single week' },
    'monthly-workouts':   { name: 'Monthly Goals',      icon: '🗓️', desc: 'Workouts in a single month' },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

class AchievementsView {
    constructor() {
        this.app = app;
        this.statusFilter = 'all';
        this.sortMode = 'category';
        // Set of category keys currently expanded (collapsed by default)
        this.expandedCategories = new Set();
        this.init();
    }

    init() {
        this.app.viewControllers.achievements = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        const filter = document.getElementById('achievement-filter');
        const sort = document.getElementById('achievement-sort');
        if (filter) {
            if (!filter.dataset.darkSelectInit) {
                this.filterDropdown = new DarkSelect(filter);
                filter.dataset.darkSelectInit = '1';
            }
            filter.addEventListener('change', (e) => {
                this.statusFilter = e.target.value;
                this.render();
            });
        }
        if (sort) {
            if (!sort.dataset.darkSelectInit) {
                this.sortDropdown = new DarkSelect(sort);
                sort.dataset.darkSelectInit = '1';
            }
            sort.addEventListener('change', (e) => {
                this.sortMode = e.target.value;
                this.render();
            });
        }

        // Expand/Collapse all helpers (event delegation)
        document.addEventListener('click', (e) => {
            const expandAll = e.target.closest('#achievement-expand-all');
            const collapseAll = e.target.closest('#achievement-collapse-all');
            const header = e.target.closest('.achievement-category-header');
            if (expandAll) {
                this.toggleAll(true);
            } else if (collapseAll) {
                this.toggleAll(false);
            } else if (header && header.dataset.categoryKey) {
                this.toggleCategory(header.dataset.categoryKey);
            }
        });
    }

    toggleCategory(key) {
        if (this.expandedCategories.has(key)) this.expandedCategories.delete(key);
        else this.expandedCategories.add(key);
        this.render();
    }

    toggleAll(expand) {
        if (!expand) {
            this.expandedCategories.clear();
        } else {
            // Expand every category currently visible after filtering
            const all = this.app.achievements.filter(a => this.matchesFilter(a));
            all.forEach(a => this.expandedCategories.add(a.requirement?.type || 'other'));
        }
        this.render();
    }

    /** Current weight unit from settings (defaults to 'kg'). */
    get weightUnit() {
        return this.app.settings?.weightUnit || 'kg';
    }

    /**
     * Replace any 'kg' literal in achievement text with the user's chosen unit.
     * Note: descriptions look like "Lift 1,000kg total volume" — there's no
     * space between the digits and "kg", so a leading \b (word boundary)
     * doesn't fire. Match `kg` followed only by a trailing boundary.
     */
    localizeUnit(text) {
        if (!text) return text;
        const unit = this.weightUnit;
        if (unit === 'kg') return text;
        return text.replace(/kg\b/g, unit);
    }

    render() {
        const container = document.getElementById('achievements-list');
        if (!container) return;

        const all = this.app.achievements;
        const sessions = this.app.workoutSessions || [];

        // Header counts always reflect the full set
        document.getElementById('unlocked-count').textContent = all.filter(a => a.unlocked).length;
        document.getElementById('total-achievements').textContent = all.length;

        // Apply status filter
        const filtered = all.filter(a => this.matchesFilter(a));
        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-trophy"></i>
                    <p>No achievements match this filter.</p>
                </div>
            `;
            this.updateBulkToggleState([]);
            return;
        }

        // For non-category sorts, render as a single flat list
        if (this.sortMode === 'closest') {
            const sorted = [...filtered].sort((a, b) => {
                if (a.unlocked !== b.unlocked) return a.unlocked ? 1 : -1;
                return (b.progressPercentage || 0) - (a.progressPercentage || 0);
            });
            container.innerHTML = `
                <div class="achievement-chain">
                    ${sorted.map(a => this.renderCard(a, sessions)).join('')}
                </div>
            `;
            this.updateBulkToggleState([]);
            return;
        }
        if (this.sortMode === 'recent') {
            const sorted = [...filtered].sort((a, b) => {
                const ad = a.unlockedAt ? new Date(a.unlockedAt).getTime() : 0;
                const bd = b.unlockedAt ? new Date(b.unlockedAt).getTime() : 0;
                return bd - ad;
            });
            container.innerHTML = `
                <div class="achievement-chain">
                    ${sorted.map(a => this.renderCard(a, sessions)).join('')}
                </div>
            `;
            this.updateBulkToggleState([]);
            return;
        }

        // Default: group by category, sort within each by target ascending
        const groups = new Map();
        filtered.forEach(a => {
            const key = a.requirement?.type || 'other';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(a);
        });
        groups.forEach(list => list.sort((a, b) => (a.target || 0) - (b.target || 0)));

        const ordered = [...groups.entries()].sort(([a], [b]) => {
            const ai = CATEGORY_ORDER.indexOf(a);
            const bi = CATEGORY_ORDER.indexOf(b);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        container.innerHTML = ordered.map(([type, items]) => {
            const meta = CATEGORY_META[type] || { name: type, icon: '🏆', desc: '' };
            const done = items.filter(a => a.unlocked).length;
            const isExpanded = this.expandedCategories.has(type);
            return `
                <section class="achievement-category ${isExpanded ? 'is-expanded' : ''}">
                    <button type="button"
                            class="achievement-category-header"
                            data-category-key="${type}"
                            aria-expanded="${isExpanded}"
                            aria-controls="achievement-chain-${type}">
                        <span class="achievement-category-icon">${meta.icon}</span>
                        <div class="achievement-category-text">
                            <h2>${meta.name}</h2>
                            <p>${meta.desc}</p>
                        </div>
                        <span class="achievement-category-count">
                            <strong>${done}</strong> / ${items.length}
                        </span>
                        <span class="achievement-category-chevron" aria-hidden="true">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </button>
                    <div class="achievement-chain"
                         id="achievement-chain-${type}"
                         ${isExpanded ? '' : 'hidden'}>
                        ${items.map(a => this.renderCard(a, sessions)).join('')}
                    </div>
                </section>
            `;
        }).join('');

        // Update Expand all / Collapse all enabled state based on visible categories
        this.updateBulkToggleState(ordered.map(([type]) => type));
    }

    /** Disable Expand all when every category is open; disable Collapse all when none is open. */
    updateBulkToggleState(visibleKeys) {
        const expandBtn = document.getElementById('achievement-expand-all');
        const collapseBtn = document.getElementById('achievement-collapse-all');
        if (!expandBtn || !collapseBtn) return;
        if (!visibleKeys || visibleKeys.length === 0) {
            // No categories rendered (e.g. flat sort or empty filter) — both off
            expandBtn.disabled = true;
            collapseBtn.disabled = true;
            return;
        }
        const openCount = visibleKeys.filter(k => this.expandedCategories.has(k)).length;
        expandBtn.disabled = openCount === visibleKeys.length;   // all open already
        collapseBtn.disabled = openCount === 0;                  // none open already
    }

    matchesFilter(a) {
        if (this.statusFilter === 'completed') return a.unlocked;
        if (this.statusFilter === 'in-progress') return !a.unlocked && a.progress > 0;
        if (this.statusFilter === 'not-started') return !a.unlocked && a.progress === 0;
        return true;
    }

    renderCard(a, sessions) {
        const stateClass = a.unlocked
            ? 'unlocked'
            : a.progress > 0 ? 'in-progress' : 'locked';

        const recurring = AchievementService.isRecurring(a);
        const reps = recurring ? AchievementService.getRepetitionCount(a, sessions) : 0;
        const isVolume = VOLUME_TYPES.has(a.requirement?.type);
        const unit = this.weightUnit;

        const formatNum = (n) => Number(n || 0).toLocaleString();
        const formatProgress = (n) => isVolume
            ? `${formatNum(n)} ${unit}`
            : formatNum(n);

        // Localize description text (replaces literal 'kg' with the user's unit)
        const description = isVolume ? this.localizeUnit(a.description) : a.description;

        let statusHtml;
        if (a.unlocked) {
            statusHtml = `
                <small class="achievement-status unlocked-label">
                    <i class="fas fa-check-circle"></i> Unlocked${recurring && reps > 1 ? ` · Completed ${reps}×` : ''}
                </small>
            `;
        } else {
            statusHtml = `
                <div class="achievement-progress-track">
                    <div class="achievement-progress-bar" style="width: ${a.progressPercentage}%"></div>
                </div>
                <small class="achievement-status">
                    ${formatProgress(a.progress)} / ${formatProgress(a.target)}${recurring && reps > 0 ? ` · Completed ${reps}× before` : ''}
                </small>
            `;
        }

        return `
            <div class="achievement-card ${stateClass}">
                <div class="achievement-icon">${escapeHtml(a.icon)}</div>
                <div class="achievement-info">
                    <div class="achievement-title-row">
                        <h3>${escapeHtml(a.name)}</h3>
                        ${a.unlocked
                            ? '<span class="achievement-checkmark" aria-label="Unlocked"><i class="fas fa-check"></i></span>'
                            : ''}
                    </div>
                    <p>${escapeHtml(description)}</p>
                    ${statusHtml}
                </div>
            </div>
        `;
    }
}

// Initialize
new AchievementsView();
