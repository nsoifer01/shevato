/**
 * Achievements View Controller
 * Renders achievements as a grouped progression system rather than a flat list.
 */
import { app } from '../app.js';
import { Achievement } from '../models/Achievement.js';
import { AchievementService } from '../services/AchievementService.js';
import { DarkSelect } from '../utils/dark-select.js';
import { escapeHtml, formatDate } from '../utils/helpers.js';
import { displayWeight, normalizeWeightUnit, volumeIn } from '../utils/units.js';

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
    'weekly-distinct-days':{ name: 'Weekly Consistency', icon: '🌈', desc: 'Days trained in a single week' },
    'monthly-workouts':   { name: 'Monthly Goals',      icon: '🗓️', desc: 'Workouts in a single month' },
    // GT-29: without an entry here the group heading fell back to the raw
    // requirement slug and rendered "<h2>lift-milestone</h2>" with an empty
    // description paragraph, sitting among properly titled groups.
    'lift-milestone':     { name: 'Lift Milestones',    icon: '🏅', desc: 'Landmark loads on the big lifts' },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

/** "lift-milestone" -> "Lift Milestone". Last-resort title for a new type. */
function humanizeCategoryKey(key) {
    return String(key || 'other')
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

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
        return normalizeWeightUnit(this.app.settings?.weightUnit);
    }

    /**
     * Render an achievement description in the user's unit.
     *
     * Volume milestones are DEFINED in kilograms ("Lift 1,000kg total
     * volume"), so switching to pounds has to convert the number as well as
     * the suffix. Swapping only the suffix - which is what this used to do -
     * is the same relabel-without-converting mistake as GT-03, three orders
     * of magnitude out on the bigger tiers.
     */
    localizeUnit(text) {
        if (!text) return text;
        const unit = this.weightUnit;
        if (unit === 'kg') return text;
        return String(text).replace(/([\d,.]+)\s*kg\b/g, (_match, number) => {
            const kg = Number(String(number).replace(/,/g, ''));
            if (!Number.isFinite(kg)) return `${number} ${unit}`;
            return `${Math.round(volumeIn(kg, unit)).toLocaleString()}${unit}`;
        });
    }

    /** Feature 4: per-exercise strength-PR achievements, newest first. */
    get prAchievements() {
        return (this.app.achievements || [])
            .filter(a => a.requirement?.type === 'strength-pr')
            // Defense-in-depth: a legacy or partially-synced PR record missing
            // its weight/date would render as "0 kg" / "Invalid Date". Skip it.
            .filter(a => Achievement.isRenderable(a))
            .sort((a, b) => String(b.prDate || '').localeCompare(String(a.prDate || '')));
    }

    /**
     * Render the distinct "Strength PRs" section above the standard
     * volume/streak categories. Each row shows exercise name, weight + unit,
     * and date. Weights are stored canonical kg and convert to the user's
     * current display unit. Returns the section HTML ('' when none exist).
     */
    renderPRSection() {
        const prs = this.prAchievements;
        if (prs.length === 0) return '';
        // The CURRENT display unit, not `prUnit` (the unit the lifter happened
        // to be reading when the PR was set). Keying off the stored unit is why
        // a PR card still said "65 kg" while History next to it said lb (GT-03);
        // prWeightKg is canonical, so it converts like everything else.
        const unit = this.weightUnit;
        const rows = prs.map(a => {
            const weightLabel = `${Number(displayWeight(a.prWeightKg || 0, unit)).toLocaleString()} ${unit}`;
            // Prefer the exercise's CURRENT catalog name (stable id lives in
            // requirement.exerciseId); the stored snapshot covers exercises
            // that no longer resolve (e.g. deleted custom exercises).
            const name = this.app.getExerciseDisplayName(
                a.requirement?.exerciseId, a.prExerciseName || a.name);
            return `
                <div class="strength-pr-card">
                    <span class="strength-pr-medal" aria-hidden="true">${escapeHtml(a.icon || '🏅')}</span>
                    <div class="strength-pr-info">
                        <h3 class="strength-pr-name">${escapeHtml(name)}</h3>
                        <span class="strength-pr-meta">
                            <span class="strength-pr-weight">${escapeHtml(weightLabel)}</span>
                            <span class="strength-pr-date">${escapeHtml(formatDate(a.prDate))}</span>
                        </span>
                    </div>
                </div>
            `;
        }).join('');
        return `
            <section class="strength-pr-section">
                <header class="strength-pr-header">
                    <span class="strength-pr-header-icon" aria-hidden="true">🏅</span>
                    <div>
                        <h2>Strength PRs</h2>
                        <p>Personal records: your heaviest set yet on an exercise</p>
                    </div>
                    <span class="strength-pr-count">${prs.length}</span>
                </header>
                <div class="strength-pr-list">${rows}</div>
            </section>
        `;
    }

    render() {
        const container = document.getElementById('achievements-list');
        if (!container) return;

        // Strength PRs live outside the standard category groups; render them
        // in their own visually distinct section and keep them out of the
        // category/filter machinery below.
        const all = this.app.achievements.filter(a => a.requirement?.type !== 'strength-pr');
        const prSectionHtml = this.renderPRSection();
        const sessions = this.app.workoutSessions || [];

        // Header counts always reflect the full set
        const fullSet = this.app.achievements;
        document.getElementById('unlocked-count').textContent = fullSet.filter(a => a.unlocked).length;
        document.getElementById('total-achievements').textContent = fullSet.length;

        // Apply status filter
        const filtered = all.filter(a => this.matchesFilter(a));
        if (filtered.length === 0) {
            container.innerHTML = prSectionHtml + `
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
            container.innerHTML = prSectionHtml + `
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
            container.innerHTML = prSectionHtml + `
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

        container.innerHTML = prSectionHtml + ordered.map(([type, items]) => {
            // A slug is never shown to a user: an unknown requirement type
            // gets a readable fallback title rather than its raw key (GT-29).
            const meta = CATEGORY_META[type] || { name: humanizeCategoryKey(type), icon: '🏆', desc: 'Other goals' };
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
                            ${meta.desc ? `<p>${meta.desc}</p>` : ''}
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
        // Volume progress and targets are canonical kg; convert them so the
        // bar, the numbers and the description all agree.
        const formatProgress = (n) => isVolume
            ? `${Math.round(volumeIn(n, unit)).toLocaleString()} ${unit}`
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
