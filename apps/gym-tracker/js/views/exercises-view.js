/**
 * Exercises View Controller
 */
import { app } from '../app.js';
import {
    showToast, parseLocalDate, showConfirmModal, escapeHtml, generateNumericId,
    formatTimeOfDay, pluralize,
} from '../utils/helpers.js';
import { trapModalFocus } from '../utils/modal-focus.js';
import { DarkSelect } from '../utils/dark-select.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { makePaginatorState, paginatorInfo, paginatorDualHTML } from '../utils/paginator.js';
import { sameId } from '../utils/id-utils.js';
import { matchesQuery, normalizeSearchText, searchExercises } from '../utils/exercise-search.js';
import {
    CUSTOM_EXERCISE_NAME_MAX, EXERCISE_CATEGORIES, EXERCISE_EQUIPMENT, populateSelect,
} from '../utils/exercise-taxonomy.js';
import { isLoggedSession } from '../utils/session-metrics.js';
// The display boundary. Stored weights are canonical kilograms; every number
// this view puts on screen next to a unit label must come through here, the
// same way history-view.js does it. Interpolating a raw stored weight beside
// `settings.weightUnit` is what printed a 140 lb pulldown as "63.503 lb".
import { displayWeight, volumeIn } from '../utils/units.js';

const EXERCISE_SORT_KEY = 'gymTrackerExerciseSort';
const EXERCISE_PAGE_SIZE = 15;

class ExercisesView {
    constructor() {
        this.app = app;
        this.filteredExercises = [];
        this._detailExerciseId = null;
        this._pagination = makePaginatorState(EXERCISE_PAGE_SIZE);
        this.init();
    }

    init() {
        this.app.viewControllers.exercises = this;
        this.setupEventListeners();
        this.wireListActions();
    }

    /**
     * Single delegated click+keyboard listener on the exercise grid.
     * Replaces inline onclick handlers that interpolated exercise.id into
     * JS strings.
     */
    wireListActions() {
        const list = document.getElementById('exercise-db-list');
        if (!list || list.dataset.actionsWired) return;
        list.dataset.actionsWired = '1';

        const dispatch = (e, fromKeyboard = false) => {
            const target = e.target.closest('[data-action]');
            if (!target || !list.contains(target)) return;
            const id = Number(target.dataset.exerciseId);
            switch (target.dataset.action) {
                case 'delete-custom-exercise':
                    e.preventDefault();
                    e.stopPropagation();
                    this.deleteCustomExercise(id);
                    break;
                case 'explain-delete-blocked':
                    e.preventDefault();
                    e.stopPropagation();
                    this.explainDeleteBlocked(id);
                    break;
                case 'show-exercise-history':
                    if (fromKeyboard && target.tagName === 'BUTTON') return;
                    e.preventDefault();
                    this.showExerciseHistory(id);
                    break;
            }
        };

        list.addEventListener('click', (e) => dispatch(e));
        list.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') dispatch(e, true);
        });
    }

    setupEventListeners() {
        const searchInput = document.getElementById('exercise-db-search');
        const categoryFilter = document.getElementById('exercise-db-category');
        const equipmentFilter = document.getElementById('exercise-db-equipment');
        const historyFilter = document.getElementById('exercise-db-history-filter');
        const sortSelect = document.getElementById('exercise-db-sort');
        const createBtn = document.getElementById('create-custom-exercise-btn');

        // Restore persisted sort choice
        if (sortSelect) {
            const saved = localStorage.getItem(EXERCISE_SORT_KEY);
            if (saved && sortSelect.querySelector(`option[value="${saved}"]`)) {
                sortSelect.value = saved;
            }
        }

        if (searchInput) {
            searchInput.addEventListener('input', () => this.filterExercises());
        }

        if (categoryFilter) {
            categoryFilter.addEventListener('change', () => this.filterExercises());
        }

        if (equipmentFilter) {
            equipmentFilter.addEventListener('change', () => this.filterExercises());
        }

        if (historyFilter) {
            historyFilter.addEventListener('change', () => this.filterExercises());
        }

        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                localStorage.setItem(EXERCISE_SORT_KEY, sortSelect.value);
                this.filterExercises();
            });
        }

        if (createBtn) {
            createBtn.addEventListener('click', () => this.openCustomExerciseModal());
        }

        const resetBtn = document.getElementById('exercise-db-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                if (categoryFilter) categoryFilter.value = '';
                if (equipmentFilter) equipmentFilter.value = '';
                if (historyFilter) historyFilter.value = 'all';
                if (sortSelect) {
                    sortSelect.value = 'name-asc';
                    localStorage.setItem(EXERCISE_SORT_KEY, 'name-asc');
                }
                this.filterExercises();
            });
        }

        // Custom exercise form. `novalidate`: the three required selects are
        // hidden behind dark-select, so the browser could never show or focus
        // its own validation UI - it just refused to submit, silently (GT-15).
        // Validation is ours now, and it is visible.
        const customForm = document.getElementById('custom-exercise-form');
        if (customForm) {
            customForm.noValidate = true;
            customForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.createCustomExercise();
            });
            // Clear a field's error as soon as the user addresses it.
            ['custom-exercise-name', 'custom-exercise-category',
                'custom-exercise-muscle', 'custom-exercise-equipment'].forEach((id) => {
                const el = document.getElementById(id);
                if (!el) return;
                const clear = () => { if (el.value) this.clearFieldError(id); };
                el.addEventListener('input', clear);
                el.addEventListener('change', clear);
            });
        }

        // GT-26: category + equipment options come from ONE definition, so
        // the create form can no longer offer 10 categories while the browse
        // filter offers 17 (custom glute / ab / cardio exercises were
        // uncreatable under their own category).
        populateSelect(categoryFilter, EXERCISE_CATEGORIES, 'All Categories');
        populateSelect(equipmentFilter, EXERCISE_EQUIPMENT, 'All Equipment');
        populateSelect(document.getElementById('custom-exercise-category'),
            EXERCISE_CATEGORIES, 'Select category...');
        populateSelect(document.getElementById('custom-exercise-equipment'),
            EXERCISE_EQUIPMENT, 'Select equipment...');

        // GT-39: a hard cap on the interactive path. Legacy/imported longer
        // names keep rendering; only new input is bounded.
        const nameInput = document.getElementById('custom-exercise-name');
        if (nameInput) nameInput.maxLength = CUSTOM_EXERCISE_NAME_MAX;

        // Custom-exercise modal — wrap the three native selects with DarkSelect
        this.customExerciseDropdowns = {};
        ['custom-exercise-category', 'custom-exercise-muscle', 'custom-exercise-equipment']
            .forEach(id => {
                const sel = document.getElementById(id);
                if (sel && !sel.dataset.darkSelectInit) {
                    this.customExerciseDropdowns[id] = new DarkSelect(sel);
                    sel.dataset.darkSelectInit = '1';
                }
            });
    }

    render() {
        // Count text is updated dynamically by filterExercises()
        this.filterExercises();
    }

    updateCountText(filteredCount, totalCount) {
        const countText = document.getElementById('exercise-count-text');
        if (!countText) return;
        const word = totalCount === 1 ? 'exercise' : 'exercises';
        if (filteredCount === totalCount) {
            countText.textContent = `${totalCount.toLocaleString()} ${word} available`;
        } else {
            countText.textContent = `Showing ${filteredCount.toLocaleString()} of ${totalCount.toLocaleString()} ${word}`;
        }
    }

    filterExercises() {
        const searchTerm = document.getElementById('exercise-db-search')?.value || '';
        const category = document.getElementById('exercise-db-category')?.value || '';
        const equipment = document.getElementById('exercise-db-equipment')?.value || '';
        const historyFilter = document.getElementById('exercise-db-history-filter')?.value || 'all';
        const sortValue = document.getElementById('exercise-db-sort')?.value || 'name-asc';

        this.filteredExercises = this.app.exerciseDatabase.filter(ex => {
            // GT-24: relevance matching, shared with both pickers.
            const matchesSearch = !searchTerm || matchesQuery(ex, searchTerm);
            const matchesCategory = !category || ex.category === category;
            const matchesEquipment = !equipment || ex.equipment === equipment;

            // Check history filter
            const hasHistory = this.exerciseHasHistory(ex.id);
            let matchesHistory = true;
            if (historyFilter === 'with-history') {
                matchesHistory = hasHistory;
            } else if (historyFilter === 'without-history') {
                matchesHistory = !hasHistory;
            }

            return matchesSearch && matchesCategory && matchesEquipment && matchesHistory;
        });

        // Apply sort — works across all filter states
        if (sortValue === 'name-desc') {
            this.filteredExercises.sort((a, b) => b.name.localeCompare(a.name));
        } else if (sortValue === 'most-logged') {
            this.filteredExercises.sort((a, b) => {
                const diff = this.getExerciseHistoryCount(b.id) - this.getExerciseHistoryCount(a.id);
                return diff !== 0 ? diff : a.name.localeCompare(b.name);
            });
        } else if (sortValue === 'most-recent') {
            this.filteredExercises.sort((a, b) => {
                const tA = this._getExerciseLastUsed(a.id);
                const tB = this._getExerciseLastUsed(b.id);
                if (tB !== tA) return tB - tA;
                return a.name.localeCompare(b.name);
            });
        } else if (searchTerm) {
            // A query has its own answer to "what should be first"; only fall
            // back to A-Z when the user has not asked for anything specific.
            this.filteredExercises = searchExercises(this.filteredExercises, searchTerm);
        } else {
            // name-asc (default)
            this.filteredExercises.sort((a, b) => a.name.localeCompare(b.name));
        }

        // Update dropdown states
        this.updateDropdownStates(searchTerm, category, equipment, historyFilter);

        // Enable/disable the reset button based on whether any filter is active
        const resetBtn = document.getElementById('exercise-db-reset');
        if (resetBtn) {
            const anyActive = Boolean(searchTerm) || Boolean(category) || Boolean(equipment)
                || historyFilter !== 'all' || sortValue !== 'name-asc';
            resetBtn.disabled = !anyActive;
        }

        // Update header count text (reflects current filtered view)
        this.updateCountText(this.filteredExercises.length, this.app.exerciseDatabase.length);

        // Any filter/sort change resets to page 1
        this._pagination.page = 1;

        this.renderExerciseList();
    }

    /**
     * Returns the epoch ms of the most recent session that logged this exercise,
     * or 0 if no history. Used by the "Recently Used" sort.
     */
    _getExerciseLastUsed(exerciseId) {
        let latest = 0;
        this.app.workoutSessions.forEach(session => {
            const ex = session.exercises.find(e => sameId(e.exerciseId, exerciseId));
            if (ex && ex.sets && ex.sets.some(s => s.completed)) {
                const ts = new Date(session.sortTimestamp).getTime();
                if (ts > latest) latest = ts;
            }
        });
        return latest;
    }

    updateDropdownStates(searchTerm, currentCategory, currentEquipment, historyFilter) {
        const categorySelect = document.getElementById('exercise-db-category');
        const equipmentSelect = document.getElementById('exercise-db-equipment');

        if (categorySelect) {
            Array.from(categorySelect.options).forEach(option => {
                if (!option.value) {
                    option.disabled = false;
                    return;
                }

                // Count exercises that would match if this category was selected
                const count = this.app.exerciseDatabase.filter(ex => {
                    const matchesSearch = !searchTerm || matchesQuery(ex, searchTerm);
                    const matchesThisCategory = ex.category === option.value;
                    const matchesEquipment = !currentEquipment || ex.equipment === currentEquipment;
                    const hasHistory = this.exerciseHasHistory(ex.id);
                    let matchesHistory = true;
                    if (historyFilter === 'with-history') matchesHistory = hasHistory;
                    else if (historyFilter === 'without-history') matchesHistory = !hasHistory;

                    return matchesSearch && matchesThisCategory && matchesEquipment && matchesHistory;
                }).length;

                option.disabled = count === 0;
            });
        }

        if (equipmentSelect) {
            Array.from(equipmentSelect.options).forEach(option => {
                if (!option.value) {
                    option.disabled = false;
                    return;
                }

                // Count exercises that would match if this equipment was selected
                const count = this.app.exerciseDatabase.filter(ex => {
                    const matchesSearch = !searchTerm || matchesQuery(ex, searchTerm);
                    const matchesCategory = !currentCategory || ex.category === currentCategory;
                    const matchesThisEquipment = ex.equipment === option.value;
                    const hasHistory = this.exerciseHasHistory(ex.id);
                    let matchesHistory = true;
                    if (historyFilter === 'with-history') matchesHistory = hasHistory;
                    else if (historyFilter === 'without-history') matchesHistory = !hasHistory;

                    return matchesSearch && matchesCategory && matchesThisEquipment && matchesHistory;
                }).length;

                option.disabled = count === 0;
            });
        }
    }

    exerciseHasHistory(exerciseId) {
        return this.app.workoutSessions.some(session =>
            session.exercises.some(ex =>
                sameId(ex.exerciseId, exerciseId) &&
                ex.sets &&
                ex.sets.length > 0 &&
                ex.sets.some(set => set.completed)
            )
        );
    }

    getExerciseHistoryCount(exerciseId) {
        let count = 0;
        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => sameId(ex.exerciseId, exerciseId));
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    count++;
                }
            }
        });
        return count;
    }

    getExerciseHistory(exerciseId) {
        const history = [];

        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => sameId(ex.exerciseId, exerciseId));
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                exercise.sets.forEach(set => {
                    if (set.completed) {
                        history.push({
                            date: session.date,
                            sortKey: session.sortTimestamp,
                            weight: set.weight,
                            reps: set.reps,
                            duration: set.duration || 0,
                            volume: set.volume
                        });
                    }
                });
            }
        });

        // Sort by full session timestamp (most recent first) so multiple
        // sessions on the same day order by time-of-day.
        return history.sort((a, b) => new Date(b.sortKey) - new Date(a.sortKey));
    }

    /**
     * Group by session (not by calendar date) so two workouts on the same day
     * remain distinct in the exercise-history table. Sorted newest-first by
     * full timestamp.
     */
    getExerciseHistoryGroupedByDate(exerciseId) {
        const groups = [];

        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => sameId(ex.exerciseId, exerciseId));
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    groups.push({
                        date: session.date,
                        sortKey: session.sortTimestamp,
                        sessionId: session.id,
                        sets: completedSets.map(set => ({
                            weight: set.weight,
                            reps: set.reps,
                            duration: set.duration || 0,
                            volume: set.volume,
                        })),
                    });
                }
            }
        });

        return groups.sort((a, b) => new Date(b.sortKey) - new Date(a.sortKey));
    }

    openCustomExerciseModal() {
        const modal = document.getElementById('custom-exercise-modal');

        // Clear form
        document.getElementById('custom-exercise-name').value = '';
        document.getElementById('custom-exercise-category').value = '';
        document.getElementById('custom-exercise-muscle').value = '';
        document.getElementById('custom-exercise-equipment').value = '';

        // Sync the DarkSelect triggers so they show placeholders, not stale labels
        if (this.customExerciseDropdowns) {
            Object.values(this.customExerciseDropdowns).forEach(d => d.sync());
        }

        // Clear any leftover error states from the previous attempt
        ['custom-exercise-name', 'custom-exercise-category',
            'custom-exercise-muscle', 'custom-exercise-equipment']
            .forEach(id => this.clearFieldError(id));

        modal.classList.add('active');
        trapModalFocus(modal);
    }

    /**
     * GT-15: visible, programmatic validation for the custom-exercise form.
     *
     * The three selects are `required` but sit behind the custom `dark-select`
     * control, so they are `display:none` to the browser. A hidden required
     * control cannot be focused, so Chrome refused to submit, logged
     * "An invalid form control with name='' is not focusable" three times,
     * and showed the user absolutely nothing - a dead button.
     *
     * Validation therefore happens here, in the app's own UI: the offending
     * field gets an `.has-error` ring, an inline message the screen reader
     * announces via aria-describedby, and focus moves to the VISIBLE
     * dark-select trigger rather than the hidden native control.
     *
     * Returns true when the form is valid.
     */
    validateCustomExerciseForm(fields) {
        const modal = document.getElementById('custom-exercise-modal');
        modal?.querySelectorAll('.has-error').forEach(el => el.classList.remove('has-error'));
        modal?.querySelectorAll('.gt-field-error').forEach(el => { el.textContent = ''; el.hidden = true; });

        const problems = [];
        if (!fields.name) problems.push(['custom-exercise-name', 'Give the exercise a name.']);
        else if (fields.name.length > CUSTOM_EXERCISE_NAME_MAX) {
            problems.push(['custom-exercise-name',
                `Keep the name to ${CUSTOM_EXERCISE_NAME_MAX} characters or fewer.`]);
        }
        if (!fields.category) problems.push(['custom-exercise-category', 'Pick a category.']);
        if (!fields.muscleGroup) problems.push(['custom-exercise-muscle', 'Pick a primary muscle group.']);
        if (!fields.equipment) problems.push(['custom-exercise-equipment', 'Pick the equipment used.']);

        if (problems.length === 0) return true;

        problems.forEach(([id, message]) => this.showFieldError(id, message));
        this.focusFieldControl(problems[0][0]);
        showToast(problems[0][1], 'error');
        return false;
    }

    /** Attach a visible + announced error message to one form control. */
    showFieldError(controlId, message) {
        const control = document.getElementById(controlId);
        const group = control?.closest('.form-group');
        if (!group) return;
        group.classList.add('has-error');

        let error = group.querySelector('.gt-field-error');
        if (!error) {
            error = document.createElement('p');
            error.className = 'gt-field-error';
            error.id = `${controlId}-error`;
            error.setAttribute('role', 'alert');
            group.appendChild(error);
        }
        error.textContent = message;
        error.hidden = false;

        // The hidden native control still owns the a11y relationship; its
        // visible proxy gets the invalid state a user can actually perceive.
        const visible = this.visibleControlFor(controlId) || control;
        visible?.setAttribute?.('aria-invalid', 'true');
        visible?.setAttribute?.('aria-describedby', error.id);
    }

    /**
     * The element a user can actually focus for a form control: the
     * dark-select trigger when one exists, otherwise the control itself.
     */
    visibleControlFor(controlId) {
        const control = document.getElementById(controlId);
        if (!control) return null;
        if (control.tagName !== 'SELECT') return control;
        const group = control.closest('.form-group');
        return group?.querySelector('.dark-select-trigger, .dark-select__trigger, button, [tabindex]')
            || control;
    }

    /** Move attention to the first invalid VISIBLE control. */
    focusFieldControl(controlId) {
        const target = this.visibleControlFor(controlId);
        if (!(target instanceof HTMLElement)) return;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    /** Clear the error state on one control (called as the user fixes it). */
    clearFieldError(controlId) {
        const control = document.getElementById(controlId);
        const group = control?.closest('.form-group');
        if (!group) return;
        group.classList.remove('has-error');
        const error = group.querySelector('.gt-field-error');
        if (error) { error.textContent = ''; error.hidden = true; }
        const visible = this.visibleControlFor(controlId) || control;
        visible?.removeAttribute?.('aria-invalid');
        visible?.removeAttribute?.('aria-describedby');
    }

    async createCustomExercise() {
        const name = document.getElementById('custom-exercise-name').value.trim();
        const category = document.getElementById('custom-exercise-category').value;
        const muscleGroup = document.getElementById('custom-exercise-muscle').value;
        const equipment = document.getElementById('custom-exercise-equipment').value;

        if (!this.validateCustomExerciseForm({ name, category, muscleGroup, equipment })) return;

        // GT-16: an exact normalized name collision splits history, PRs and
        // progression across two identities with no visible symptom, so it is
        // worth one question. Near-matches are legitimate variants and are
        // never blocked.
        const clash = this.app.exerciseDatabase.find(
            ex => normalizeSearchText(ex.name) === normalizeSearchText(name));
        if (clash) {
            const kind = clash.isCustom ? 'custom exercise' : 'exercise in the catalog';
            const confirmed = await showConfirmModal({
                title: 'Name already exists',
                message: `There is already an ${kind} called <strong>"${escapeHtml(clash.name)}"</strong>.`
                    + `<br><br>Two exercises with the same name are hard to tell apart when picking one, `
                    + `and logging against the wrong one splits your history, PRs and progression between them.`,
                warning: 'Give yours a distinct name (e.g. add your gym or the bar type) unless you really want a second entry.',
                confirmText: 'Create anyway',
                cancelText: 'Change the name',
                isDangerous: false,
            });
            if (!confirmed) {
                this.focusFieldControl('custom-exercise-name');
                return;
            }
        }

        // High-entropy numeric ID — generateNumericId combines timestamp,
        // a process counter, and a random tail so two custom exercises
        // created in the same millisecond can't collide. Stays numeric so
        // existing inline-onclick interpolations keep working.
        const id = generateNumericId();

        const newExercise = {
            id,
            name,
            category,
            muscleGroup,
            equipment,
            isCustom: true
        };

        this.app.addCustomExercise(newExercise);

        showToast(`Created custom exercise: ${name}`, 'success');
        document.getElementById('custom-exercise-modal').classList.remove('active');

        // Refresh the exercise list and count
        this.render();
    }

    renderExerciseList() {
        const container = document.getElementById('exercise-db-list');

        if (this.filteredExercises.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-search"></i>
                    <p>No exercises found</p>
                </div>
            `;
            return;
        }

        const info = paginatorInfo(this._pagination, this.filteredExercises.length);
        // Clamp page in case total shrank (e.g. after a filter change we already reset, but be safe)
        this._pagination.page = info.page;

        const pageItems = this.filteredExercises.slice(info.start, info.end);

        const cardsHTML = pageItems.map(exercise => {
            const hasHistory = this.exerciseHasHistory(exercise.id);
            const historyCount = hasHistory ? this.getExerciseHistoryCount(exercise.id) : 0;
            const cardActionAttrs = hasHistory
                ? `data-action="show-exercise-history" data-exercise-id="${exercise.id}" role="button" tabindex="0"`
                : '';
            const cursorClass = hasHistory ? 'has-history' : 'no-history';
            const canDelete = exercise.isCustom && !hasHistory;
            // GT-28: the safety rule is right, its discoverability was not.
            // A custom exercise with history simply had no delete button and
            // no explanation, so "how do I delete this?" had no answer on
            // screen. Show the control, disabled, saying exactly what to do.
            const blockedDelete = exercise.isCustom && hasHistory;

            return `
                <div class="exercise-db-card ${cursorClass}" ${cardActionAttrs}>
                    ${hasHistory ? `<span class="history-count-badge">${historyCount}</span>` : ''}
                    <div class="exercise-card-header">
                        <h3>
                            ${escapeHtml(exercise.name)}
                            ${exercise.isCustom ? '<span class="badge badge-custom">Custom</span>' : ''}
                        </h3>
                        ${canDelete ? `<button class="btn-icon delete-exercise-btn" data-action="delete-custom-exercise" data-exercise-id="${exercise.id}" title="Delete custom exercise">
                            <i class="fas fa-trash"></i>
                        </button>` : ''}
                        ${blockedDelete ? `<button class="btn-icon delete-exercise-btn delete-exercise-btn--blocked"
                            data-action="explain-delete-blocked" data-exercise-id="${exercise.id}"
                            aria-label="Why can't I delete this exercise?"
                            title="This exercise has logged history. Remove its logged history before deleting it.">
                            <i class="fas fa-trash"></i>
                        </button>` : ''}
                    </div>
                    <p class="exercise-muscle"><i class="fas fa-bullseye"></i> ${escapeHtml(exercise.muscleGroup)}</p>
                    <div class="exercise-meta">
                        <span class="badge badge-category"><i class="fas fa-layer-group"></i> ${escapeHtml(exercise.category)}</span>
                        <span class="badge badge-equipment"><i class="fas fa-dumbbell"></i> ${escapeHtml(exercise.equipment)}</span>
                    </div>
                    ${hasHistory ? `
                        <span class="btn-view-history">
                            <i class="fas fa-chart-line"></i> View history
                            <i class="fas fa-arrow-right view-history-arrow"></i>
                        </span>
                    ` : ''}
                </div>
            `;
        }).join('');

        const { top: topPager, bottom: bottomPager } = paginatorDualHTML(info, 'ex');
        container.innerHTML = topPager + cardsHTML + bottomPager;

        const goToPage = (newPage, scrollToTop) => {
            this._pagination.page = newPage;
            this.renderExerciseList();
            if (scrollToTop) container.scrollIntoView({ block: 'start' });
        };

        container.querySelectorAll('.pagination-page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pg = Number(btn.dataset.page);
                const fromBottom = btn.closest('[data-paginator="ex-b"]') !== null;
                goToPage(pg, fromBottom);
            });
        });

        container.querySelectorAll('[id^="ex-prev-"]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this._pagination.page > 1) {
                    const fromBottom = btn.id === 'ex-prev-b';
                    goToPage(this._pagination.page - 1, fromBottom);
                }
            });
        });

        container.querySelectorAll('[id^="ex-next-"]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this._pagination.page < info.pageCount) {
                    const fromBottom = btn.id === 'ex-next-b';
                    goToPage(this._pagination.page + 1, fromBottom);
                }
            });
        });
    }

    showExerciseHistory(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;

        const history = this.getExerciseHistory(exerciseId);
        const groupedHistory = this.getExerciseHistoryGroupedByDate(exerciseId);
        if (history.length === 0) return;

        this._detailExerciseId = exerciseId;

        const modal = document.getElementById('exercise-detail-modal');
        document.getElementById('exercise-detail-name').textContent = exercise.name;

        const unit = this.app.settings.weightUnit;
        const isDuration = history[0].duration > 0;

        // Find best set (used for both stats display and table highlighting)
        const bestSet = isDuration
            ? history.reduce((best, current) => current.duration > best.duration ? current : best)
            : history.reduce((best, current) => current.volume > best.volume ? current : best);

        // Friendly date helpers — "Mar 25, 2026" instead of "3/25/2026"
        const fmtDate = (dateStr) => parseLocalDate(dateStr).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
        });

        // "6:42 PM" from an ISO timestamp. Used to disambiguate two sessions
        // on the same calendar day.
        const fmtTime = (iso) => formatTimeOfDay(iso);

        // Caption that explains what makes the best set "best"
        const bestCaption = isDuration ? 'Longest duration' : 'Highest volume (weight × reps)';

        let statsHTML = '';
        if (isDuration) {
            const maxMins = Math.floor(bestSet.duration / 60);
            const maxSecs = bestSet.duration % 60;
            const avgDuration = history.reduce((sum, h) => sum + h.duration, 0) / history.length;
            const avgMins = Math.floor(avgDuration / 60);
            const avgSecs = Math.floor(avgDuration % 60);
            const totalSets = history.length;

            statsHTML = `
                ${this.statBox('Max duration', `${maxMins}:${maxSecs.toString().padStart(2, '0')}`)}
                ${this.statBox('Avg duration', `${avgMins}:${avgSecs.toString().padStart(2, '0')}`)}
                ${this.statBox('Total sets', totalSets.toLocaleString())}
                ${this.statBox('On', fmtDate(bestSet.date))}
            `;
        } else {
            statsHTML = `
                ${this.statBox('Weight', `${Number(displayWeight(bestSet.weight, unit)).toLocaleString()} ${unit}`)}
                ${this.statBox('Reps', bestSet.reps.toLocaleString())}
                ${this.statBox('Volume', `${Math.round(volumeIn(bestSet.volume, unit)).toLocaleString()} ${unit}`)}
                ${this.statBox('On', fmtDate(bestSet.date))}
            `;
        }

        // Build table with grouped sets per date
        const tableHeaderHTML = `
            <th class="col-date">Date</th>
            <th class="col-sets">Sets</th>
        `;

        const renderSetChip = (label, stateClass, title) => `
            <span class="set-badge ${stateClass || ''}"${title ? ` title="${title}"` : ''}>${label}</span>
        `;

        // Which calendar dates have more than one session? When they do, we
        // add the time-of-day to the row label so multiple same-day sessions
        // remain distinguishable at a glance.
        const sessionsPerDate = groupedHistory.reduce((acc, r) => {
            acc[r.date] = (acc[r.date] || 0) + 1;
            return acc;
        }, {});

        // groupedHistory is sorted newest-first, so the previous session for
        // each row is at the next index.
        const tableBodyHTML = groupedHistory.map((record, recordIdx) => {
            // Match the "best" session uniquely by timestamp — `date` alone
            // would flag every session on the best-performance day.
            const isBestRow = record.sortKey === bestSet.sortKey;
            const previousRecord = groupedHistory[recordIdx + 1];
            const showTime = sessionsPerDate[record.date] > 1;
            const timeLabel = showTime ? fmtTime(record.sortKey) : '';

            const setsDisplay = record.sets.map((set, idx) => {
                const prevSet = previousRecord?.sets?.[idx];
                let label = '';
                let stateClass = '';
                let title = '';

                if (isDuration) {
                    const mins = Math.floor(set.duration / 60);
                    const secs = set.duration % 60;
                    label = `Set ${idx + 1} · ${mins}:${secs.toString().padStart(2, '0')}`;

                    if (isBestRow && set.duration === bestSet.duration) {
                        stateClass = 'set-best';
                    } else if (prevSet) {
                        if (set.duration > prevSet.duration) {
                            stateClass = 'set-improved';
                            title = `Up from ${Math.floor(prevSet.duration / 60)}:${(prevSet.duration % 60).toString().padStart(2, '0')} last time`;
                        } else if (set.duration < prevSet.duration) {
                            stateClass = 'set-worse';
                            title = `Down from ${Math.floor(prevSet.duration / 60)}:${(prevSet.duration % 60).toString().padStart(2, '0')} last time`;
                        }
                    }
                } else {
                    const setVolume = set.weight * set.reps;
                    label = `Set ${idx + 1} · ${Number(displayWeight(set.weight, unit)).toLocaleString()} ${unit} × ${set.reps}`;

                    if (isBestRow && setVolume === bestSet.volume) {
                        stateClass = 'set-best';
                    } else if (prevSet) {
                        // Primary: weight. If weight equal: compare reps.
                        if (set.weight > prevSet.weight) {
                            stateClass = 'set-improved';
                            title = `Up from ${Number(displayWeight(prevSet.weight, unit)).toLocaleString()} ${unit} last time`;
                        } else if (set.weight < prevSet.weight) {
                            stateClass = 'set-worse';
                            title = `Down from ${Number(displayWeight(prevSet.weight, unit)).toLocaleString()} ${unit} last time`;
                        } else if (set.reps > prevSet.reps) {
                            stateClass = 'set-improved';
                            title = `+${set.reps - prevSet.reps} reps vs last time`;
                        } else if (set.reps < prevSet.reps) {
                            stateClass = 'set-worse';
                            title = `${set.reps - prevSet.reps} reps vs last time`;
                        }
                    }
                }
                return renderSetChip(label, stateClass, title);
            }).join('');

            return `
                <tr class="${isBestRow ? 'is-best-row' : ''}">
                    <td class="col-date">
                        <span class="history-date">${fmtDate(record.date)}${timeLabel ? ` · ${timeLabel}` : ''}</span>
                        ${isBestRow ? '<span class="best-row-badge"><i class="fas fa-star"></i> Best</span>' : ''}
                    </td>
                    <td class="col-sets sets-cell">${setsDisplay}</td>
                </tr>
            `;
        }).join('');

        document.getElementById('exercise-detail-content').innerHTML = `
            <section class="exercise-detail-section">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-star"></i> Best Set</h3>
                    <span class="exercise-detail-section-caption">${bestCaption}</span>
                </header>
                <div class="exercise-stats-summary">
                    ${statsHTML}
                </div>
            </section>

            <section class="exercise-detail-section">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-clock-rotate-left"></i> History</h3>
                    <span class="exercise-detail-section-caption">${groupedHistory.length} session${groupedHistory.length === 1 ? '' : 's'}</span>
                </header>
                <div class="exercise-history-table">
                    <table>
                        <thead>
                            <tr>${tableHeaderHTML}</tr>
                        </thead>
                        <tbody>
                            ${tableBodyHTML}
                        </tbody>
                    </table>
                </div>
            </section>
        `;

        this.renderProgressionChart(exerciseId, isDuration);

        // Delete-history footer — inject after chart, wired via delegation below
        const existingFooter = modal.querySelector('.exercise-detail-delete-footer');
        if (existingFooter) existingFooter.remove();
        const footer = document.createElement('div');
        footer.className = 'exercise-detail-delete-footer';
        footer.innerHTML = `
            <button class="btn btn-danger-outline btn-sm exercise-detail-delete-history-btn" data-exercise-id="${exerciseId}">
                <i class="fas fa-trash"></i> Remove logged history
            </button>
        `;
        modal.querySelector('.modal-body').appendChild(footer);
        footer.querySelector('.exercise-detail-delete-history-btn').addEventListener('click', () => {
            this.deleteExerciseHistory(exerciseId);
        });

        modal.classList.add('active');
        trapModalFocus(modal);
    }

    /**
     * Render the per-exercise progression chart into the #exercise-history-chart
     * placeholder. Inline SVG — no chart library, no network.
     *
     * For weighted exercises we plot top-set weight and estimated 1RM (Epley).
     * For duration exercises we plot longest set per session.
     * Feature 4: also renders a 90-day e1RM sparkline for weighted exercises.
     */
    renderProgressionChart(exerciseId, isDuration) {
        const host = document.getElementById('exercise-history-chart');
        if (!host) return;
        host.innerHTML = '';

        const points = AnalyticsService.getExerciseProgression(
            exerciseId,
            this.app.workoutSessions,
            { limit: 12 },
        );

        // Feature 4: 90-day e1RM sparkline for weighted exercises.
        if (!isDuration) {
            this._renderE1rmSparkline(host, exerciseId);
        }

        if (points.length < 2) return; // need ≥2 points to draw a trend

        const unit = this.app.settings.weightUnit;
        const fmtDate = (dateStr) => parseLocalDate(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric',
        });

        // Convert ONCE, here, so the axis ticks, the dot tooltips and the stat
        // tiles below all read the same display-unit numbers. Scaling is a
        // linear transform, so the plotted shape is identical either way.
        const toDisplay = (kg) => Number(displayWeight(kg, unit));
        const series = isDuration
            ? points.map(p => ({ x: p.date, y: p.maxDuration }))
            : points.map(p => ({ x: p.date, y: toDisplay(p.maxWeight) }));

        const e1rmSeries = isDuration
            ? null
            : points.map(p => ({ x: p.date, y: Math.round(toDisplay(p.e1rm)) }));

        const yMin = Math.min(...series.map(p => p.y), e1rmSeries ? Math.min(...e1rmSeries.map(p => p.y)) : Infinity);
        const yMax = Math.max(...series.map(p => p.y), e1rmSeries ? Math.max(...e1rmSeries.map(p => p.y)) : -Infinity);
        const yRange = Math.max(yMax - yMin, 1);
        const pad = yRange * 0.15;
        const yLo = Math.max(0, yMin - pad);
        const yHi = yMax + pad;

        const W = 520;
        const H = 160;
        const mx = 32;
        const my = 16;
        const plotW = W - mx * 2;
        const plotH = H - my * 2;

        const xAt = (i) => mx + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        const yAt = (v) => my + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

        const toPath = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');

        const fmtY = (v) => isDuration
            ? `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`
            : `${Math.round(v)} ${unit}`;

        const firstLabel = fmtDate(series[0].x);
        const lastLabel = fmtDate(series[series.length - 1].x);

        // `Shown` = already through the display boundary, in `unit`.
        const bestWeightShown = Math.max(...points.map(p => toDisplay(p.maxWeight)));
        const bestE1rmShown = Math.max(...points.map(p => toDisplay(p.e1rm)));
        const bestDuration = Math.max(...points.map(p => p.maxDuration));

        const firstY = series[0].y;
        const lastY = series[series.length - 1].y;
        const trendDelta = lastY - firstY;
        const trendPct = firstY > 0 ? Math.round((trendDelta / firstY) * 100) : 0;
        const trendClass = trendDelta > 0 ? 'is-up' : trendDelta < 0 ? 'is-down' : '';
        const trendSign = trendDelta > 0 ? '+' : '';

        const primaryLabel = isDuration ? 'Longest set' : 'Top-set weight';
        const caption = isDuration
            ? `${points.length} sessions · ${trendSign}${fmtY(trendDelta)} vs ${points.length} ago`
            : `${points.length} sessions · ${trendSign}${trendPct}% vs ${points.length} ago`;

        const statTiles = isDuration
            ? `<div class="stat-box"><span class="stat-label">Best</span><span class="stat-value">${fmtY(bestDuration)}</span></div>`
            : `<div class="stat-box"><span class="stat-label">Top weight</span><span class="stat-value">${Math.round(bestWeightShown)} ${unit}</span></div>
               <div class="stat-box"><span class="stat-label">Best e1RM</span><span class="stat-value">${Math.round(bestE1rmShown)} ${unit}</span></div>`;

        const dotsPrimary = series.map((p, i) =>
            `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3" class="progression-dot"><title>${fmtDate(p.x)}: ${fmtY(p.y)}</title></circle>`
        ).join('');

        const e1rmLine = e1rmSeries
            ? `<path d="${toPath(e1rmSeries)}" class="progression-line progression-line-e1rm"/>`
            : '';

        const xTicks = `
            <text x="${mx}" y="${H - 2}" class="progression-axis" text-anchor="start">${firstLabel}</text>
            <text x="${W - mx}" y="${H - 2}" class="progression-axis" text-anchor="end">${lastLabel}</text>
        `;
        const yTicks = `
            <text x="${mx - 6}" y="${yAt(yHi).toFixed(1) + 4}" class="progression-axis" text-anchor="end">${fmtY(yHi)}</text>
            <text x="${mx - 6}" y="${yAt(yLo).toFixed(1) + 4}" class="progression-axis" text-anchor="end">${fmtY(yLo)}</text>
        `;

        host.innerHTML += `
            <section class="exercise-detail-section exercise-progression">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-chart-line"></i> Progression</h3>
                    <span class="exercise-detail-section-caption ${trendClass}">${caption}</span>
                </header>
                <div class="exercise-stats-summary">${statTiles}</div>
                <div class="progression-chart-wrap">
                    <svg viewBox="0 0 ${W} ${H}" class="progression-chart" role="img" aria-label="${primaryLabel} over the last ${points.length} sessions">
                        <line x1="${mx}" y1="${my}" x2="${mx}" y2="${H - my}" class="progression-axis-line"/>
                        <line x1="${mx}" y1="${H - my}" x2="${W - mx}" y2="${H - my}" class="progression-axis-line"/>
                        ${e1rmLine}
                        <path d="${toPath(series)}" class="progression-line progression-line-primary"/>
                        ${dotsPrimary}
                        ${xTicks}
                        ${yTicks}
                    </svg>
                    <div class="progression-legend">
                        <span class="progression-legend-item"><span class="dot dot-primary"></span>${primaryLabel}</span>
                        ${e1rmSeries ? '<span class="progression-legend-item"><span class="dot dot-e1rm"></span>Est. 1RM</span>' : ''}
                    </div>
                </div>
            </section>
        `;
    }

    /**
     * Feature 4: 90-day e1RM sparkline rendered into the host element.
     * Uses the Epley formula: e1RM = weight × (1 + reps/30).
     * Only rendered for weighted exercises with ≥2 data points.
     */
    _renderE1rmSparkline(host, exerciseId) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        cutoff.setHours(0, 0, 0, 0);

        const points = AnalyticsService.getExerciseProgression(
            exerciseId,
            this.app.workoutSessions,
        ).filter(p => AnalyticsService.toLocalDate(p.date) >= cutoff);

        if (points.length < 2) {
            host.innerHTML += `
                <section class="exercise-detail-section">
                    <header class="exercise-detail-section-header">
                        <h3><i class="fas fa-bolt"></i> 90-day e1RM</h3>
                    </header>
                    <p class="exercise-sparkline-empty">Not enough history yet.</p>
                </section>
            `;
            return;
        }

        const unit = this.app.settings.weightUnit;
        const fmtDate = (dateStr) => AnalyticsService.toLocalDate(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric',
        });

        // e1RM is canonical kg out of AnalyticsService; convert before rounding
        // so the label, the tooltips and the caption agree with History.
        const series = points.map(p => ({
            x: p.date, y: Math.round(Number(displayWeight(p.e1rm, unit))),
        }));
        const vals = series.map(p => p.y);
        const yMin = Math.min(...vals);
        const yMax = Math.max(...vals);
        const yRange = Math.max(yMax - yMin, 1);
        const pad = yRange * 0.15;
        const yLo = Math.max(0, yMin - pad);
        const yHi = yMax + pad;

        const W = 520;
        const H = 80;
        const mx = 8;
        const my = 8;
        const plotW = W - mx * 2;
        const plotH = H - my * 2;

        const xAt = (i) => mx + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        const yAt = (v) => my + plotH - ((v - yLo) / (yHi - yLo)) * plotH;
        const pathD = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');

        const latest = series[series.length - 1];
        const earliest = series[0];

        const dots = series.map((p, i) =>
            `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="2.5" class="sparkline-dot"><title>${fmtDate(p.x)}: ${p.y} ${unit}</title></circle>`
        ).join('');

        host.innerHTML += `
            <section class="exercise-detail-section exercise-sparkline-section">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-bolt"></i> 90-day e1RM</h3>
                    <span class="exercise-detail-section-caption">${points.length} sessions · latest: ${latest.y} ${unit}</span>
                </header>
                <div class="exercise-sparkline-wrap">
                    <svg viewBox="0 0 ${W} ${H}" class="exercise-sparkline" role="img" aria-label="90-day estimated 1-rep max">
                        <path d="${pathD}" class="sparkline-line"/>
                        ${dots}
                    </svg>
                    <div class="sparkline-axis-labels">
                        <span>${fmtDate(earliest.x)}</span>
                        <span>${fmtDate(latest.x)}</span>
                    </div>
                </div>
            </section>
        `;
    }

    statBox(label, value) {
        return `
            <div class="stat-box">
                <span class="stat-label">${label}</span>
                <span class="stat-value">${value}</span>
            </div>
        `;
    }

    async deleteExerciseHistory(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;

        const sessionCount = this.getExerciseHistoryCount(exerciseId);
        // Count the sessions this would empty out, so the wording matches what
        // actually happens (GT-14).
        const wouldEmpty = (this.app.workoutSessions || []).filter((session) => {
            if (!isLoggedSession(session)) return false;
            const remaining = (session.exercises || [])
                .filter(ex => !sameId(ex.exerciseId, exerciseId));
            return !isLoggedSession({ exercises: remaining });
        }).length;

        const message = `Remove all logged history for <strong>"${escapeHtml(exercise.name)}"</strong>?<br><br>`
            + `This will erase ${pluralize(sessionCount, 'session')} worth of sets for this exercise. `
            + (wouldEmpty > 0
                ? `${pluralize(wouldEmpty, 'workout')} would be left with nothing logged at all and ${wouldEmpty === 1 ? 'is' : 'are'} removed too; other sessions are kept.<br><br>`
                : `The sessions themselves are kept; only the entries for this exercise are removed.<br><br>`)
            + `<strong>This cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Remove Exercise History',
            message,
            confirmText: 'Remove History',
            cancelText: 'Cancel',
            isDangerous: true,
        });

        if (!confirmed) return;

        // Remove this exercise's entries from every session in memory
        this.app.workoutSessions.forEach(session => {
            session.exercises = session.exercises.filter(ex => !sameId(ex.exerciseId, exerciseId));
        });

        // GT-14: a session stripped of its last completed set is no longer a
        // workout - it held 0 kg and 0 sets yet still counted toward the
        // weekly tile, the streak, the calendar marker and the monthly total.
        // Finishing a workout requires at least one completed set, so this
        // state is only ever produced right here, and pruning it at the source
        // is what keeps every counting surface honest without any of them
        // needing a special case.
        const before = this.app.workoutSessions.length;
        this.app.workoutSessions = this.app.workoutSessions.filter(isLoggedSession);
        const pruned = before - this.app.workoutSessions.length;

        this.app.saveWorkoutSessions();
        this.app.updateAchievements();

        showToast(
            pruned > 0
                ? `History removed for ${exercise.name}. ${pluralize(pruned, 'empty workout')} removed too.`
                : `History removed for ${exercise.name}`,
            'info',
            pruned > 0 ? 5000 : 3000,
        );

        // Close the detail modal and refresh the list
        const modal = document.getElementById('exercise-detail-modal');
        if (modal) modal.classList.remove('active');

        this._detailExerciseId = null;
        this.render();
    }

    /**
     * GT-28: answer "why is there no delete button?" in the app rather than
     * leaving the user to guess. Opens the exercise's own detail modal, which
     * is where the "Remove logged history" action lives, so the explanation
     * comes with the path out of it.
     */
    async explainDeleteBlocked(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;
        const sessionCount = this.getExerciseHistoryCount(exerciseId);
        const proceed = await showConfirmModal({
            title: 'Delete is locked',
            message: `<strong>"${escapeHtml(exercise.name)}"</strong> has logged history in `
                + `${pluralize(sessionCount, 'workout')}, so deleting it would orphan those sets.`
                + `<br><br>Remove its logged history first, then the delete button appears on its card.`,
            confirmText: 'Remove its history',
            cancelText: 'Not now',
            isDangerous: false,
        });
        if (proceed) this.showExerciseHistory(exerciseId);
    }

    /** Programs that still contain a row for this exercise (GT-27). */
    programsUsingExercise(exerciseId) {
        return (this.app.programs || []).filter(
            p => (p.exercises || []).some(ex => sameId(ex.exerciseId, exerciseId)));
    }

    async deleteCustomExercise(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise || !exercise.isCustom) {
            showToast('Cannot delete this exercise', 'error');
            return;
        }

        const hasHistory = this.exerciseHasHistory(exerciseId);
        if (hasHistory) {
            showToast('Remove this exercise\'s logged history before deleting it', 'error', 4500);
            return;
        }

        // GT-27: deleting an exercise a live program still references left the
        // program row behind, rendering from its stored name snapshot with its
        // muscle sub-label gone, and the user was told none of it. Say which
        // programs, and let them decide.
        const usedBy = this.programsUsingExercise(exerciseId);
        if (usedBy.length > 0) {
            const names = usedBy.map(p => `<strong>${escapeHtml(p.name)}</strong>`).join(', ');
            const proceed = await showConfirmModal({
                title: 'Still used by a program',
                message: `<strong>"${escapeHtml(exercise.name)}"</strong> is part of ${pluralize(usedBy.length, 'program')}: ${names}.`
                    + `<br><br>Deleting it leaves ${usedBy.length === 1 ? 'that program' : 'those programs'} with a row that keeps the name `
                    + `but loses its muscle group and equipment details.`,
                warning: 'Remove it from the program first if you want the plan to stay complete.',
                confirmText: 'Delete anyway',
                cancelText: 'Keep it',
                isDangerous: true,
            });
            if (!proceed) return;
        }

        const message = `Are you sure you want to delete <strong>"${escapeHtml(exercise.name)}"</strong>?<br><br>This custom exercise will be permanently removed.<br><br><strong>This action cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Delete Custom Exercise',
            message: message,
            confirmText: 'Delete Exercise',
            cancelText: 'Cancel',
            isDangerous: true
        });

        if (confirmed) {
            const index = this.app.customExercises.findIndex(ex => sameId(ex.id, exerciseId));
            if (index >= 0) {
                this.app.customExercises.splice(index, 1);
                this.app.saveCustomExercises();
                showToast('Custom exercise deleted successfully', 'info');

                // Re-render to update the list and count
                this.render();
            }
        }
    }
}

// Initialize
new ExercisesView();
