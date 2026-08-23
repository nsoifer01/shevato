/**
 * Workout View Controller
 * Mobile-optimized workout execution
 */
import { app } from '../app.js';
import { WorkoutSession } from '../models/WorkoutSession.js';
import { WorkoutExercise } from '../models/WorkoutExercise.js';
import { Set } from '../models/Set.js';
import { timerService } from '../services/TimerService.js';
import { storageService } from '../services/StorageService.js';
import { showToast, showConfirmModal, formatMuscleGroup, vibrate, playSound, escapeHtml, debugLog, formatDate, pluralLabel } from '../utils/helpers.js';
import { trapModalFocus } from '../utils/modal-focus.js';
import { renderPausedBannerHTML, wirePausedBannerActions } from './paused-banner.js';
import { orderPrograms } from '../utils/program-order.js';
import { sameId } from '../utils/id-utils.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { AchievementService } from '../services/AchievementService.js';
import { calculatePlates, formatPlateStack } from '../utils/plate-calculator.js';
import { restTickCues, isWorkoutComplete } from '../utils/rest-cues.js';
import { allSetsReachMax, previousSessionFeelForExercise, nextFeel, shouldShowFeelPrompt } from '../utils/exercise-feel.js';
import { recordPrSupersede, uniquePrChainCount, recomputePrSlots } from '../utils/pr-session.js';
import { mergeSessionWithProgram } from '../utils/session-merge.js';
import { weekStrip } from '../utils/program-schedule.js';
import { readableActiveWorkout, lockedByOtherTab, LOCK_HEARTBEAT_MS } from '../utils/active-workout.js';
import {
    normalizeWarmupSettings,
    shouldShowWarmup,
    buildWarmupRamp,
} from '../utils/warmup.js';
import { track } from '../utils/analytics.js';
import {
    displayWeight, formatDuration, formatDurationLong, normalizeWeightUnit,
    roundForDisplay, toCanonicalWeight, volumeIn,
} from '../utils/units.js';
import { searchExercises } from '../utils/exercise-search.js';
import { EXERCISE_CATEGORIES, EXERCISE_EQUIPMENT, populateSelect } from '../utils/exercise-taxonomy.js';
import { DEFAULT_TARGET_SECONDS } from '../models/Program.js';

const PLATE_LOADED_EQUIPMENT = new globalThis.Set(['barbell', 'trap-bar', 'machine', 'plate', 'sled']);

// Item 6: warm-up ramp configuration, written by Settings.
const WARMUP_SETTINGS_KEY = 'gymTrackerWarmupSettings';

/**
 * Validate a weight x reps entry from the live set row (commit and edit).
 *
 * The inputs' `min` attributes are decorative: the commit is a button
 * click, not a form submit, so nothing consulted them and `!reps` let a
 * negative rep count through (stored `reps: -3`, negative volume in the
 * session detail, 2026-08-22 audit D1). `parseInt` also read `1e3` as 1 and
 * `8.7` as 8 without feedback (D12). Rules: reps is an integer >= 1, weight
 * is a finite number >= 0 (0 is legitimate for bodyweight work). Returns
 * `{ ok, weight, reps }` or `{ ok: false, field, message }` so the caller can
 * mark the offending input inline.
 */
/** Why a heavier set can show no badge: the rule is set volume, and it is explained where the badge is. */
const PR_RULE_HELP = 'PR means this set beat your best single-set volume (weight x reps) for this exercise, or your best hold for timed work. A heavier weight for fewer reps is not a PR under this rule.';

/**
 * Post-workout metrics from the finish form: optional, but when given they
 * must be whole numbers inside the ranges the inputs declare (30-250 bpm,
 * 0-5000 kcal). Returns null when fine, else { field, message }.
 */
function validatePostWorkoutMetrics({ avgHR, maxHR, calories }) {
    const check = (raw, field, label, min, max, unit) => {
        const text = String(raw ?? '').trim();
        if (text === '') return null;
        const n = Number(text);
        if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < min || n > max) {
            return { field, message: `${label} must be a whole number between ${min} and ${max} ${unit}.` };
        }
        return null;
    };
    return check(avgHR, 'avg-heart-rate', 'Average heart rate', 30, 250, 'bpm')
        || check(maxHR, 'max-heart-rate', 'Max heart rate', 30, 250, 'bpm')
        || check(calories, 'calories-burned', 'Calories burned', 0, 5000, 'kcal');
}

function parseSetEntry(weightRaw, repsRaw) {
    const weightText = String(weightRaw ?? '').trim();
    const repsText = String(repsRaw ?? '').trim();
    const weight = weightText === '' ? NaN : Number(weightText);
    const reps = repsText === '' ? NaN : Number(repsText);
    if (!Number.isFinite(weight) || weight < 0) {
        return { ok: false, field: 'weight', message: weightText === '' ? 'Enter a weight' : 'Weight must be 0 or more' };
    }
    // Digits only: "1e3" and "8.7" are typos on a rep counter, never 1000 or 8.
    if (!/^\d+$/.test(repsText) || !Number.isInteger(reps) || reps < 1) {
        return { ok: false, field: 'reps', message: repsText === '' ? 'Enter reps' : 'Reps must be a whole number of 1 or more' };
    }
    return { ok: true, weight, reps };
}

class WorkoutView {
    constructor() {
        this.app = app;
        this.currentWorkoutSession = null;
        this.navigationBlocked = false;
        this.activeRestTimerId = null;
        this.restTimerDuration = 0;
        // Exercise index whose rest timer is currently running; -1 when idle.
        this.activeRestExerciseIndex = -1;
        // Last second value for which we played the timer-low ping (guards duplicates).
        this.lastPingedRestSecond = -1;
        // Slot-keyed record of sets that hold a surviving PR badge this session
        // so the row can render a gold outline even after rerender. Item R2-10:
        // within a session only the best set per exercise keeps its entry here
        // (earlier PRs are superseded). The finish-modal PR count is derived
        // from this map via uniquePrChainCount. Plain object on purpose: this
        // module imports `Set` from models/Set.js, which shadows the built-in.
        this.sessionPrSlots = {};
        // Feature 3: per-exercise collapsed state (index → bool). Exercises
        // marked exercise-complete auto-collapse; the rest start expanded.
        this.collapsedExercises = {};
        // Tracks which exercises were complete before the last deleteSet call,
        // used to reset the manual-expand suppression when going complete->incomplete.
        this._prevCompleteState = {};
        // Timer type for the currently active rest: 'set' (between-set, chip only)
        // or 'exercise' (between-exercise, bottom bar).
        this._activeRestType = null;
        // Item R3-4: per-session bookkeeping of exercise indices for which the
        // feel modal has already been shown, so it appears at most once per
        // exercise per session.
        this._feelPromptShown = {};
        // Item 6: warm-up strip state, keyed `"<exerciseIndex>:<rampIndex>"` for
        // ticked-off ramp rows and by exercise index for the expanded strip.
        // View-only on purpose: a warm-up row is never a Set, so it can never
        // reach volume, completion or PR bookkeeping.
        this.warmupDone = {};
        this.warmupExpanded = {};
        // Item 3: exercise index the swap picker is currently acting on.
        this.swapTargetIndex = null;
        this.init();
    }

    /**
     * Item R2-10: PRs surfaced in the finish modal — the number of UNIQUE
     * exercises with a surviving PR badge (a 100 -> 110 chain counts once).
     * Derived from sessionPrSlots so supersede bookkeeping has one source.
     */
    get sessionPrCount() {
        return uniquePrChainCount(this.sessionPrSlots || {});
    }

    init() {
        this.app.viewControllers.workout = this;
        this.setupEventListeners();
        this.setupNavigationGuard();
        this.setupPersistenceGuards();
        this.wireWorkoutActions();
    }

    /**
     * Last-chance flush. `pagehide` fires on a real tab close / bfcache
     * eviction and `visibilitychange` fires when a phone locks or the user
     * switches apps - the two moments a mobile browser is most likely to
     * kill the page. Everything except the debounced notes field is already
     * written synchronously, so this only ever has that one field to save,
     * but it is the difference between losing a form cue and not.
     */
    setupPersistenceGuards() {
        if (typeof window === 'undefined') return;
        window.addEventListener('pagehide', () => this.flushPendingPersist());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flushPendingPersist();
        });
    }

    /**
     * Single delegated click listener on the workout view. Replaces the
     * inline onclick handlers used to live on every set row, planned-row
     * footer button, set-toggle pill, edit/save/cancel button, and
     * program-pick "Start Workout" button. Each element declares its
     * intent via `data-action` plus optional `data-exercise-index`,
     * `data-slot`, and `data-program-id` attributes.
     */
    wireWorkoutActions() {
        const view = document.getElementById('workout-view');
        if (!view || view.dataset.actionsWired) return;
        view.dataset.actionsWired = '1';

        // Live plate-hint updates as the user types into a barbell weight
        // input. Cheap — calculatePlates is O(plates) and the hint only
        // exists on barbell rows.
        view.addEventListener('input', (e) => {
            const t = e.target;
            // Feature 5: persist per-exercise notes on every keystroke, same
            // pattern as the stickyValues persistence (save the active workout).
            if (t instanceof HTMLTextAreaElement && t.classList.contains('gt-exercise-notes-input')) {
                const eIdx = Number(t.dataset.exerciseIndex);
                const exercise = this.currentWorkoutSession?.exercises[eIdx];
                if (exercise) {
                    exercise.notes = t.value;
                    this.persistActiveWorkoutSoon();
                    const toggle = document.querySelector(`.gt-notes-toggle[data-exercise-index="${eIdx}"]`);
                    if (toggle) toggle.classList.toggle('gt-notes-toggle--has-notes', t.value.trim() !== '');
                }
                return;
            }
            // GT-40: per-exercise bar/base weight, applied live so the plate
            // hints below it re-solve as the number is typed.
            if (t instanceof HTMLInputElement && t.classList.contains('gt-bar-config-input')) {
                this.setExerciseBarWeight(Number(t.dataset.exerciseIndex), t.value, { rerender: false });
                return;
            }
            if (!(t instanceof HTMLInputElement)) return;
            // Feature 6: a weight/reps edit on a planned row may surface (or hide)
            // the "same as last time" restore chip.
            // A manual edit to an UNFINISHED row is active-session state, not a
            // transient DOM value. Without this the number lived only in the
            // input, and committing ANY other set re-rendered the exercise and
            // rebuilt this row from the previous-session prefill - so editing
            // set 2 to 65x8 and then ticking set 1 silently restored 60x12.
            const invalidRow = t.closest('.set-row--invalid');
            if (invalidRow) {
                const host = invalidRow.closest('.exercise-entry');
                const eIdxOfRow = Number(host?.id?.replace('exercise-', ''));
                if (Number.isInteger(eIdxOfRow)) this.clearSetRowError(eIdxOfRow, Number(invalidRow.dataset.slot));
            }
            if (t.classList.contains('set-weight') || t.classList.contains('set-reps')
                || t.classList.contains('duration-min') || t.classList.contains('duration-sec')) {
                const plannedRow = t.closest('.set-row-planned');
                if (plannedRow) {
                    this.recordPlannedRowEdit(plannedRow);
                    this.maybeToggleRestoreChip(plannedRow);
                }
            }
            const target = t.dataset.plateHintTarget;
            if (!target) return;
            const [eIdx, slot] = target.split('-').map(Number);
            this.refreshPlateHint(eIdx, slot, t.value);
            // GT-32: seed the still-empty rows below with what was just typed.
            if (t.classList.contains('set-weight')) this.carryWeightDown(eIdx, slot);
        });

        view.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target || !view.contains(target)) return;
            // Don't hijack the global data-home-action handler.
            if (target.matches('[data-home-action]')) return;

            const action = target.dataset.action;
            const exerciseIndex = target.dataset.exerciseIndex !== undefined
                ? Number(target.dataset.exerciseIndex)
                : null;
            const slot = target.dataset.slot !== undefined
                ? Number(target.dataset.slot)
                : null;

            switch (action) {
                case 'start-workout':
                    e.preventDefault();
                    this.startWorkout(target.dataset.programId);
                    break;
                case 'select-week-day':
                    e.preventDefault();
                    this.selectedWeekday = Number(target.dataset.weekday);
                    this.renderProgramSelection();
                    break;
                case 'commit-planned-set':
                    e.preventDefault();
                    this.commitPlannedSet(exerciseIndex, slot);
                    break;
                case 'unmark-set':
                    e.preventDefault();
                    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
                        document.activeElement.blur();
                    }
                    this.deleteSet(exerciseIndex, slot, { silent: true });
                    break;
                case 'edit-set':
                    e.preventDefault();
                    this.editSet(exerciseIndex, slot);
                    break;
                case 'delete-set':
                    e.preventDefault();
                    this.deleteSet(exerciseIndex, slot);
                    break;
                case 'save-set-edit':
                    e.preventDefault();
                    this.saveSetEdit(exerciseIndex, slot);
                    break;
                case 'cancel-set-edit':
                    e.preventDefault();
                    this.cancelSetEdit(exerciseIndex);
                    break;
                case 'add-planned-row':
                    e.preventDefault();
                    this.addPlannedRow(exerciseIndex);
                    break;
                case 'remove-planned-row':
                    e.preventDefault();
                    this.removePlannedRow(exerciseIndex);
                    break;
                case 'toggle-exercise-collapse':
                    e.preventDefault();
                    this.toggleExerciseCollapse(exerciseIndex);
                    break;
                case 'toggle-exercise-plate-hints':
                    e.preventDefault();
                    this.toggleExercisePlateHints(exerciseIndex);
                    break;
                case 'toggle-bar-config':
                    e.preventDefault();
                    this.toggleBarConfig(exerciseIndex);
                    break;
                case 'reset-bar-weight':
                    e.preventDefault();
                    this.setExerciseBarWeight(exerciseIndex, '');
                    break;
                case 'cycle-feel':
                    e.preventDefault();
                    this.cycleExerciseFeel(exerciseIndex);
                    break;
                case 'toggle-exercise-notes':
                    e.preventDefault();
                    this.toggleExerciseNotes(exerciseIndex);
                    break;
                case 'restore-last-time':
                    e.preventDefault();
                    this.restoreLastTime(exerciseIndex, slot, target);
                    break;
                case 'step-weight':
                    e.preventDefault();
                    this.stepWeight(exerciseIndex, slot, target.dataset.stepDir === 'up' ? 1 : -1);
                    break;
                case 'step-reps':
                    e.preventDefault();
                    this.stepReps(exerciseIndex, slot, target.dataset.stepDir === 'up' ? 1 : -1);
                    break;
case 'toggle-warmup':
                    e.preventDefault();
                    this.toggleWarmup(exerciseIndex);
                    break;
                case 'toggle-warmup-set':
                    e.preventDefault();
                    this.toggleWarmupSet(exerciseIndex, Number(target.dataset.warmupIndex));
                    break;
                case 'swap-exercise':
                    e.preventDefault();
                    this.openSwapPicker(exerciseIndex);
                    break;
                case 'pick-swap-exercise':
                    e.preventDefault();
                    this.pickSwapExercise(target.dataset.exerciseId);
                    break;
            }
        });
    }

    setupEventListeners() {
        // End workout button
        const endBtn = document.getElementById('end-workout-btn');
        if (endBtn) {
            endBtn.addEventListener('click', () => this.endWorkout());
        }

        // Finish workout button
        const finishBtn = document.getElementById('finish-workout-btn');
        if (finishBtn) {
            finishBtn.addEventListener('click', () => this.openFinishWorkoutModal());
        }

        // Pause workout button
        const pauseBtn = document.getElementById('pause-workout-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => this.manualPauseWorkout());
        }

        // Finish workout form
        const finishForm = document.getElementById('finish-workout-form');
        if (finishForm) {
            finishForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.finishWorkout();
            });
        }

        // Rest timer bar controls
        const restSkipBtn = document.getElementById('rest-skip-btn');
        if (restSkipBtn) restSkipBtn.addEventListener('click', () => this.skipRest());
        const restAddBtn = document.getElementById('rest-add-btn');
        if (restAddBtn) restAddBtn.addEventListener('click', () => this.extendRest(30));

        // Plate-hints toggle
        const plateToggleBtn = document.getElementById('plate-hints-toggle-btn');
        if (plateToggleBtn) plateToggleBtn.addEventListener('click', () => this.togglePlateHints());

        // Edit-program button (Item 3): instant pause + open the program editor.
        const editProgramBtn = document.getElementById('edit-program-btn');
        if (editProgramBtn) editProgramBtn.addEventListener('click', () => this.editProgramFromWorkout());

        // Session unit toggle (Item 8): kg | lbs for this workout only.
        document.querySelectorAll('#workout-unit-toggle .workout-unit-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setSessionUnit(btn.dataset.unit));
        });

        // Header overflow ("...") menu: edit program / plate hints / discard.
        this.setupOverflowMenu();
    }

    /**
     * Accessible "..." popover for the low-priority + destructive header
     * actions. The menu items keep their original IDs and handlers (wired
     * elsewhere); this only manages open/close + closes the menu after a
     * menu item fires. Opens on click, closes on outside-click / Escape.
     */
    setupOverflowMenu() {
        const btn = document.getElementById('workout-overflow-btn');
        const menu = document.getElementById('workout-overflow-menu');
        if (!btn || !menu) return;

        const close = () => {
            if (menu.hidden) return;
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onOutside, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const open = () => {
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            document.addEventListener('click', onOutside, true);
            document.addEventListener('keydown', onKey, true);
            const first = menu.querySelector('.gt-overflow-item');
            if (first) first.focus();
        };
        const onOutside = (e) => {
            if (!menu.contains(e.target) && e.target !== btn) close();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { close(); btn.focus(); }
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.hidden ? open() : close();
        });
        // Close after any menu item is activated (the item's own handler runs
        // first; this just dismisses the popover).
        menu.querySelectorAll('.gt-overflow-item').forEach(item => {
            item.addEventListener('click', () => close());
        });
    }

    /**
     * The unit weights are DISPLAYED/ENTERED in for this session - the
     * in-workout kg|lbs toggle, falling back to the account preference.
     * Stored weights are canonical kilograms regardless (utils/units.js).
     */
    sessionUnit() {
        return normalizeWeightUnit(
            this.currentWorkoutSession?.sessionUnit || this.app.settings.weightUnit);
    }

    /** Canonical kg → the session display unit, rounded for an input/label. */
    toSessionWeight(weight) {
        if (weight === '' || weight === null || weight === undefined) return weight;
        return displayWeight(weight, this.sessionUnit());
    }

    /** A session-unit input value → canonical kg (exact, never rounded). */
    toStoredWeight(weight) {
        return toCanonicalWeight(weight, this.sessionUnit()) ?? 0;
    }

    /** The plate/bar equipment profile for the unit this session is using. */
    sessionPlateConfig() {
        const settings = this.app.settings;
        return typeof settings?.plateConfig === 'function'
            ? settings.plateConfig(this.sessionUnit())
            : { barWeight: 20, plates: [], exerciseBarWeights: {} };
    }

    /**
     * Bar/base weight for one exercise in the session unit: the per-exercise
     * override if the lifter set one (an EZ bar is not an olympic bar),
     * else the profile default (GT-40).
     */
    sessionBarWeight(exerciseId) {
        const settings = this.app.settings;
        if (typeof settings?.barWeightForExercise === 'function') {
            return Number(settings.barWeightForExercise(exerciseId, this.sessionUnit())) || 0;
        }
        return Number(this.sessionPlateConfig().barWeight) || 0;
    }

    /**
     * Switch the per-session display/entry unit (Item 8). Reads any in-progress
     * planned-row weight inputs and re-displays them in the new unit so the user
     * doesn't lose what they typed, then re-renders + persists.
     */
    setSessionUnit(unit) {
        if (!this.currentWorkoutSession) return;
        if (unit !== 'kg' && unit !== 'lb') return;
        if (this.sessionUnit() === unit) return;

        // Read the planned-row weight inputs (still in the OLD session unit)
        // and carry their CANONICAL values onto stickyValues, so the
        // re-render repopulates them converted into the new unit rather than
        // relabelled. Committed sets need no work at all: they were already
        // stored in kilograms.
        const oldUnit = this.sessionUnit();
        this.currentWorkoutSession.exercises.forEach((exercise, eIdx) => {
            const list = document.querySelectorAll(`#exercise-${eIdx} .set-row-planned`);
            list.forEach(row => {
                const slot = Number(row.dataset.slot);
                const input = row.querySelector('.set-weight');
                if (!input || input.value === '') return;
                const canonical = toCanonicalWeight(input.value, oldUnit);
                if (canonical === null) return;
                if (!exercise.stickyValues) exercise.stickyValues = {};
                const reps = row.querySelector('.set-reps');
                exercise.stickyValues[slot] = {
                    weight: canonical,
                    reps: reps && reps.value !== '' ? Number(reps.value) : (exercise.stickyValues[slot]?.reps ?? ''),
                    duration: exercise.stickyValues[slot]?.duration ?? 0,
                };
            });
        });

        // Always store the unit explicitly: it is a record of how the lifter
        // was working, not a diff against a preference that may change later.
        this.currentWorkoutSession.sessionUnit = unit;
        this.persistActiveWorkout();
        this.syncSessionUnitToggle();
        this.renderActiveWorkout();
    }

    /**
     * Capture a planned row's current inputs into the active session.
     *
     * `stickyValues[slot]` is already the app's "this slot's value belongs to
     * the session, not to the prefill" store - `unmarkSet` and `setSessionUnit`
     * both write it, and `renderExerciseEntry` prefers it over the previous
     * workout. It simply was never written while the lifter was TYPING, so an
     * edit to an unfinished row existed only in the DOM and any re-render
     * (completing another set, un-completing one, adding a set, the feel
     * prompt appearing) reconstructed the row from defaults.
     *
     * Weight is stored CANONICAL, matching every other writer of this store,
     * so a mid-workout unit switch converts it rather than relabelling it.
     * An emptied field is recorded as '' on purpose: clearing a row is an edit
     * too, and must not silently repopulate from last time.
     *
     * Debounced through persistActiveWorkoutSoon (the notes path does the
     * same), so a resume after an unexpected reload restores what was typed.
     */
    recordPlannedRowEdit(row) {
        if (!row || !this.currentWorkoutSession) return;
        const slot = Number(row.dataset.slot);
        if (!Number.isFinite(slot)) return;

        const host = row.closest('.exercise-entry');
        const exerciseIndex = Number(String(host?.id || '').split('-')[1]);
        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        if (!exercise) return;

        if (!exercise.stickyValues) exercise.stickyValues = {};
        const prev = exercise.stickyValues[slot] || {};

        const weightInput = row.querySelector('.set-weight');
        const repsInput = row.querySelector('.set-reps');
        const minInput = row.querySelector('.duration-min');
        const secInput = row.querySelector('.duration-sec');

        let weight = prev.weight !== undefined ? prev.weight : '';
        if (weightInput) {
            weight = weightInput.value === ''
                ? ''
                : (this.toStoredWeight(weightInput.value) ?? '');
        }

        let reps = prev.reps !== undefined ? prev.reps : '';
        if (repsInput) {
            reps = repsInput.value === '' ? '' : Number(repsInput.value);
        }

        let duration = prev.duration !== undefined ? prev.duration : 0;
        if (minInput || secInput) {
            const mins = parseInt(minInput?.value, 10) || 0;
            const secs = parseInt(secInput?.value, 10) || 0;
            duration = (mins * 60) + secs;
        }

        exercise.stickyValues[slot] = { weight, reps, duration };
        this.persistActiveWorkoutSoon();
    }

    /** Reflect the active session unit in the header toggle button states. */
    syncSessionUnitToggle() {
        const unit = this.sessionUnit();
        document.querySelectorAll('#workout-unit-toggle .workout-unit-btn').forEach(btn => {
            const on = btn.dataset.unit === unit;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    setupNavigationGuard() {
        // Refresh / tab close: arm the native confirmation whenever a workout
        // is active, regardless of whether any sets are committed yet (Item 5).
        // The native dialog is the only "are you sure" UI browsers allow here.
        window.addEventListener('beforeunload', (e) => {
            if (this.hasActiveWorkout()) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        });

        // Browser BACK trap (Item 5): a sentinel history entry is pushed when
        // the workout screen opens. On popstate while a workout is active we
        // immediately re-push the sentinel and show the in-app leave modal.
        window.addEventListener('popstate', () => {
            if (!this.hasActiveWorkout() || !this._backSentinelArmed) return;
            // Re-push so the user stays on the workout screen until they choose.
            this._pushBackSentinel();
            this.showBackLeaveModal();
        });

        // Intercept in-app navigation
        this.interceptNavigation();
    }

    /** Push a history sentinel so the next browser BACK lands on popstate
     *  while keeping the user on the workout screen. Idempotent-ish: callers
     *  guard with _backSentinelArmed. */
    _pushBackSentinel() {
        try {
            history.pushState({ gtWorkoutSentinel: true }, '', window.location.href);
        } catch { /* history unavailable (tests / sandbox) */ }
    }

    /** Arm the back-navigation trap when the active-workout screen opens. */
    armBackGuard() {
        if (this._backSentinelArmed) return;
        this._backSentinelArmed = true;
        this._pushBackSentinel();
    }

    /** Disarm the trap on finish/discard/pause so back navigates normally. */
    disarmBackGuard() {
        this._backSentinelArmed = false;
    }

    /**
     * In-app "Leave workout?" modal for the back-navigation trap. "Stay" keeps
     * the workout untouched; "Pause and leave" pauses+saves then navigates home.
     */
    showBackLeaveModal() {
        const modal = document.getElementById('leave-workout-modal');
        if (!modal) return;
        if (modal.classList.contains('active')) return;

        const stayBtn = document.getElementById('leave-workout-stay');
        const leaveBtn = document.getElementById('leave-workout-pause-leave');

        const cleanup = () => {
            // R3-6: drop focus off the clicked button before hiding so no
            // focused descendant sits inside a closing/aria-hidden dialog.
            if (modal.contains(document.activeElement)) document.activeElement.blur();
            modal.classList.remove('active');
            stayBtn.removeEventListener('click', onStay);
            leaveBtn.removeEventListener('click', onLeave);
        };
        const onStay = () => { cleanup(); };
        const onLeave = () => {
            cleanup();
            this.disarmBackGuard();
            this.pauseAndSaveWorkout();
            this.app.showView('home');
        };

        stayBtn.addEventListener('click', onStay);
        leaveBtn.addEventListener('click', onLeave);
        modal.classList.add('active');
        trapModalFocus(modal);
    }

    interceptNavigation() {
        // Store original showView
        const originalShowView = this.app.showView.bind(this.app);

        // Override showView to check for active workout
        this.app.showView = async (viewName, pushState = true) => {
            // If there's an active workout and trying to navigate away from workout view
            if (this.currentWorkoutSession &&
                !this.currentWorkoutSession.completed &&
                this.app.currentView === 'workout' &&
                viewName !== 'workout') {

                // Count total sets added across all exercises
                let totalSets = 0;
                for (const ex of this.currentWorkoutSession.exercises) {
                    if (ex.sets && Array.isArray(ex.sets)) {
                        totalSets += ex.sets.length;
                    }
                }

                if (totalSets > 0) {
                    const result = await this.showLeaveWorkoutModal();

                    if (result === 'cancel') {
                        // User wants to stay
                        return;
                    } else if (result === 'pause') {
                        // Pause and save, then navigate
                        this.pauseAndSaveWorkout();
                    } else if (result === 'discard') {
                        // Discard workout
                        this.discardWorkout();
                    }
                } else {
                    // No sets added, just discard silently
                    this.discardWorkout();
                }
            }

            // Proceed with navigation
            originalShowView(viewName, pushState);
        };
    }

    async showLeaveWorkoutModal() {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirm-modal');
            const titleEl = document.getElementById('confirm-modal-title');
            const messageEl = document.getElementById('confirm-modal-message');
            const confirmBtn = document.getElementById('confirm-modal-confirm');
            const cancelBtn = document.getElementById('confirm-modal-cancel');

            // Set content
            titleEl.textContent = 'Workout In Progress';
            messageEl.innerHTML = `
                You have an active workout. What would you like to do?
                <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px;">
                    <button id="leave-workout-pause" class="btn btn-primary" style="width: 100%;">
                        <i class="fas fa-pause"></i> Pause & Save Progress
                    </button>
                    <button id="leave-workout-discard" class="btn btn-danger" style="width: 100%;">
                        <i class="fas fa-trash"></i> Discard Workout
                    </button>
                </div>
            `;

            // Hide default buttons, we're using custom ones
            confirmBtn.style.display = 'none';
            cancelBtn.textContent = 'Continue Workout';

            // Show modal
            modal.classList.add('active');
            trapModalFocus(modal);

            const cleanup = () => {
                modal.classList.remove('active');
                confirmBtn.style.display = '';
                pauseBtn.removeEventListener('click', handlePause);
                discardBtn.removeEventListener('click', handleDiscard);
                cancelBtn.removeEventListener('click', handleCancel);
            };

            const pauseBtn = document.getElementById('leave-workout-pause');
            const discardBtn = document.getElementById('leave-workout-discard');

            const handlePause = () => {
                cleanup();
                resolve('pause');
            };

            const handleDiscard = () => {
                cleanup();
                resolve('discard');
            };

            const handleCancel = () => {
                cleanup();
                resolve('cancel');
            };

            pauseBtn.addEventListener('click', handlePause);
            discardBtn.addEventListener('click', handleDiscard);
            cancelBtn.addEventListener('click', handleCancel);
        });
    }

    /**
     * GT-01: the ONE way in-progress workout state reaches storage.
     *
     * Before this there were six scattered `saveActiveWorkout` calls (start,
     * unit switch, pause, resync, feel, swap) and the ones that mattered
     * most - completing, editing and deleting a set - were not among them.
     * The stored blob said `sets: []` while the screen said "2 / 4 sets", so
     * a reload, a tab eviction or a crash destroyed the whole workout.
     *
     * Every mutation now routes through here, and it writes SYNCHRONOUSLY:
     * a set commit is exactly the moment an unexpected tab kill must not
     * cost anything, and one localStorage write of a few KB is far cheaper
     * than the render that follows it. `elapsedBeforePause` is refreshed on
     * every write (without touching `paused`), so an interrupted workout
     * resumes with its real elapsed time rather than 0:00.
     *
     * The debounced variant below exists only for per-keystroke text.
     */
    persistActiveWorkout() {
        const session = this.currentWorkoutSession;
        if (!session || session.completed) return;
        // A tab that lost ownership (another tab resumed after this one went
        // quiet) must not write its stale copy over the owner's (D2).
        if (this._otherTabOwnsWorkout()) return;
        try {
            if (!session.paused) {
                const elapsed = timerService.getWorkoutElapsed();
                if (Number.isFinite(elapsed) && elapsed >= 0) {
                    session.elapsedBeforePause = elapsed;
                }
            }
            storageService.saveActiveWorkout(session.toJSON());
            // The rest countdown is active state too: Resume restores it.
            if (!session.paused) storageService.claimActiveWorkoutLock();
        } catch (error) {
            console.error('Could not save the in-progress workout:', error);
        }
    }

    /**
     * Tab ownership of the live workout (D2). `claimWorkoutLock` marks this
     * tab as the driver and keeps the lock fresh on a heartbeat; a second tab
     * sees a fresh lock it does not hold and is told the workout is running
     * elsewhere instead of being offered Resume. Pause and finish release it.
     */
    _otherTabOwnsWorkout() {
        return lockedByOtherTab(storageService.getActiveWorkoutLock(), storageService.tabId);
    }

    claimWorkoutLock() {
        storageService.claimActiveWorkoutLock();
        if (this._lockHeartbeat) clearInterval(this._lockHeartbeat);
        this._lockHeartbeat = setInterval(() => {
            if (!this.hasActiveWorkout() || this.currentWorkoutSession.paused) return this.releaseWorkoutLock();
            if (this._otherTabOwnsWorkout()) {
                // Ownership moved while this tab was asleep: stop driving.
                this.releaseWorkoutLock(false);
                this.handleWorkoutTakenOver();
                return;
            }
            storageService.claimActiveWorkoutLock();
        }, LOCK_HEARTBEAT_MS);
    }

    releaseWorkoutLock(clearKey = true) {
        if (this._lockHeartbeat) { clearInterval(this._lockHeartbeat); this._lockHeartbeat = null; }
        if (clearKey) storageService.releaseActiveWorkoutLock();
    }

    /** Another tab took over the workout this tab was showing. */
    handleWorkoutTakenOver() {
        if (this._takenOver) return;
        this._takenOver = true;
        timerService.stopWorkoutTimer();
        this.skipRest();
        this.disarmBackGuard();
        this.currentWorkoutSession = null;
        this.resetFinishWorkoutForm();
        showToast('This workout is now being logged in another tab. This tab stopped to avoid overwriting it.', 'info', 8000);
        if (this.app.currentView === 'workout') this.render();
        this.app.updateGlobalFab();
        this._takenOver = false;
    }


    /**
     * Coalesce the writes behind a high-frequency text field (exercise
     * notes). A trailing flush is guaranteed by `flushPendingPersist`, which
     * every lifecycle exit calls, so the last keystroke is never the one
     * that gets lost.
     */
    persistActiveWorkoutSoon(delay = 400) {
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this.persistActiveWorkout();
        }, delay);
    }

    /** Write any pending debounced state immediately. */
    flushPendingPersist() {
        if (!this._persistTimer) return;
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
        this.persistActiveWorkout();
    }

    pauseAndSaveWorkout() {
        if (!this.currentWorkoutSession || this.currentWorkoutSession.completed) {
            return;
        }

        // Get current elapsed time
        const elapsed = timerService.getWorkoutElapsed();

        // Mark workout as paused
        this.flushPendingPersist();
        this.currentWorkoutSession.pauseWorkout(elapsed);

        // Save to storage
        storageService.saveActiveWorkout(this.currentWorkoutSession.toJSON());
        // A paused workout is meant to be picked up anywhere, so release
        // this tab's claim on it.
        this.releaseWorkoutLock();

        // Stop the timer
        timerService.stopWorkoutTimer();

        debugLog('Workout paused and saved', this.currentWorkoutSession.toJSON());

        this.disarmBackGuard();

        // Reset UI state so the paused banner shows when returning
        document.getElementById('active-workout').classList.remove('active');
        document.getElementById('workout-selection').classList.add('active');
        this.currentWorkoutSession = null;
    }

    manualPauseWorkout() {
        if (!this.currentWorkoutSession || this.currentWorkoutSession.completed) {
            return;
        }

        // Check if any sets were added
        const hasAnySets = this.currentWorkoutSession.exercises.some(ex =>
            ex.sets && ex.sets.length > 0
        );

        if (!hasAnySets) {
            showToast('Add at least one set before pausing', 'error');
            return;
        }

        this.pauseAndSaveWorkout();
        this.app.showView('home');
    }

    /**
     * Item 3: pause the workout (no confirmation) and jump straight into the
     * program editor for the program this workout was started from. Records
     * that the editor was entered from workout mode so the editor shows a
     * "Return to workout" button (Item 4).
     */
    editProgramFromWorkout() {
        if (!this.hasActiveWorkout()) return;
        const programId = this.currentWorkoutSession.programId;

        // Pause + save silently (same effect as the pause flow, no dialog).
        this.skipRest();
        this.pauseAndSaveWorkout();

        const programsCtrl = this.app.viewControllers.programs;
        if (programsCtrl) programsCtrl.enteredFromWorkout = true;

        this.app.showView('programs');
        // Open the modal once the programs view is rendered.
        setTimeout(() => {
            programsCtrl?.openProgramModal(programId);
        }, 100);
    }

    discardWorkout() {
        timerService.stopWorkoutTimer();
        this.skipRest();
        this.disarmBackGuard();
        this.flushPendingPersist();
        storageService.clearActiveWorkout();
        this.releaseWorkoutLock();
        this.resetFinishWorkoutForm();
        document.getElementById('active-workout').classList.remove('active');
        document.getElementById('workout-selection').classList.add('active');
        this.currentWorkoutSession = null;
    }

    hasActiveWorkout() {
        return this.currentWorkoutSession !== null && !this.currentWorkoutSession.completed;
    }

    render() {
        // If a workout is live in memory, returning to the workout view must
        // land on the active session, not the program picker. Otherwise show
        // the picker as usual (paused/persisted workouts surface their resume
        // banner from renderProgramSelection).
        if (this.hasActiveWorkout()) {
            document.getElementById('workout-selection').classList.remove('active');
            document.getElementById('active-workout').classList.add('active');
            this.renderActiveWorkout();
        } else {
            document.getElementById('active-workout').classList.remove('active');
            document.getElementById('workout-selection').classList.add('active');
            this.renderProgramSelection();
        }
    }

    async resumeWorkout(opts = {}) {
        // Any RECOVERABLE workout resumes, not just an explicitly paused one
        // (GT-01). readableActiveWorkout also rejects a finished or corrupt
        // blob, so a crash between "save session" and "clear active" can
        // never resurrect a completed workout.
        const pausedWorkout = readableActiveWorkout(storageService.getActiveWorkout());
        if (!pausedWorkout) {
            showToast('No unfinished workout to resume', 'error');
            return;
        }
        if (this._otherTabOwnsWorkout()) {
            showToast('This workout is being logged in another tab. Finish or pause it there first.', 'error', 6000);
            return;
        }

        // Restore the workout session
        this.currentWorkoutSession = WorkoutSession.fromJSON(pausedWorkout);
        this.currentWorkoutSession.resumeWorkout();
        this.claimWorkoutLock();
        // The rest countdown that was running when the tab died (stored by
        // startRest, cleared by skipRest/onRestComplete), so the lifter gets
        // the remaining seconds back instead of losing the timer.
        const restState = pausedWorkout.restState && typeof pausedWorkout.restState === 'object'
            ? pausedWorkout.restState : null;

        // Item 4: re-sync the session plan with an edited program when the user
        // returned from the in-workout program editor.
        if (opts.resyncProgramId != null) {
            this.resyncSessionWithProgram(opts.resyncProgramId);
        }

        // Reset per-session state, then seed collapse for completed exercises.
        // Item R2-10: rebuild PR badges from the persisted committed sets so the
        // superseded state survives pause/resume (only the best set per exercise
        // keeps its badge).
        this.sessionPrSlots = {};
        this.rebuildSessionPrSlots();
        this.collapsedExercises = {};
        this._prevCompleteState = {};
        this._activeRestType = null;
        this._feelPromptShown = {};
        this.warmupDone = {};
        this.warmupExpanded = {};
        // Item R3-4: don't re-pop the feel modal on resume for exercises that
        // already satisfy the all-sets-at-max condition. The modal only fires on
        // the commit transition; mark satisfied exercises as already shown.
        this._seedFeelPromptShownFromSession();
        this._seedCollapseStateFromSession();

        // Start timer with saved elapsed time
        timerService.startWorkoutTimer((elapsed) => {
            this.updateWorkoutTimer(elapsed);
        }, pausedWorkout.elapsedBeforePause);

        // Switch to active workout screen
        document.getElementById('workout-selection').classList.remove('active');
        document.getElementById('active-workout').classList.add('active');

        // Render workout
        this.renderActiveWorkout();
        this.armBackGuard();
        this.app.updateGlobalFab();
        // Resuming clears the paused flag; write that through so a second
        // interruption is still recognised as an interrupted (not paused) run.
        this.persistActiveWorkout();
        if (restState && Number.isFinite(restState.endsAt)) {
            const remaining = Math.ceil((restState.endsAt - Date.now()) / 1000);
            if (remaining > 0) {
                this.startRest(remaining, Number.isInteger(restState.exerciseIndex) ? restState.exerciseIndex : -1,
                    restState.restType === 'set' ? 'set' : 'exercise');
            }
        }
    }

    /**
     * Item 4: reconcile the live (paused) session with the edited program.
     * Delegates to the pure mergeSessionWithProgram helper, then rehydrates
     * the merged plain objects into WorkoutExercise instances and persists.
     */
    resyncSessionWithProgram(programId) {
        const program = this.app.getProgramById(programId);
        if (!program || !this.currentWorkoutSession) return;

        const sessionJson = this.currentWorkoutSession.exercises.map(e => e.toJSON());
        const merged = mergeSessionWithProgram(
            sessionJson,
            program.exercises,
            (progEx) => ({
                exerciseId: progEx.exerciseId,
                // Resolve through the catalog so a renamed exercise enters the
                // session under its current name (program rows carry an old
                // snapshot).
                exerciseName: this.app.getExerciseDisplayName(progEx.exerciseId, progEx.exerciseName),
                sets: [],
                targetSets: progEx.targetSets,
                targetReps: progEx.targetReps,
                restSeconds: progEx.restSeconds,
                restAfterSeconds: progEx.restAfterSeconds,
                groupId: progEx.groupId || null,
            }),
        );
        this.currentWorkoutSession.exercises = merged.map(e => WorkoutExercise.fromJSON(e));
        this.persistActiveWorkout();
    }

    /**
     * Seed collapsedExercises and _prevCompleteState from the restored session.
     * Called on resume so completed exercises start collapsed without requiring
     * any new sets to be committed.
     */
    _seedCollapseStateFromSession() {
        const exercises = this.currentWorkoutSession?.exercises;
        if (!exercises) return;
        exercises.forEach((exercise, i) => {
            const targetSets = Math.max(1, exercise.targetSets || 3);
            const isComplete = exercise.sets.length >= targetSets;
            if (isComplete) {
                this.collapsedExercises[i] = true;
                this._prevCompleteState[i] = true;
            }
        });
    }

    async discardPausedWorkout() {
        const confirmed = await showConfirmModal({
            title: 'Discard Unfinished Workout',
            message: 'Are you sure you want to discard this workout?<br><br><strong>All progress will be lost.</strong>',
            confirmText: 'Discard',
            cancelText: 'Keep',
            isDangerous: true
        });

        if (confirmed) {
            if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
            storageService.clearActiveWorkout();
            this.releaseWorkoutLock();
            this.resetFinishWorkoutForm();
            this.render();
            showToast('Unfinished workout discarded', 'info');
            this.app.showView('home');
        }
    }

    /**
     * Item R2-6: a calendar-like week strip at the top of the workout selection
     * screen. Shown only when the program-schedule toggle is on and at least one
     * program is scheduled. Seven day cells ordered per the firstDayOfWeek
     * preference, today highlighted, each listing the scheduled program name(s).
     * Today's scheduled entry is emphasized; tapping a program entry starts that
     * workout immediately (Item R3-1). Returns '' when nothing should render.
     */
    _renderWeekStripHTML(programs) {
        const showSchedule = this.app.settings?.showProgramSchedule !== false;
        if (!showSchedule || !programs || programs.length === 0) return '';
        const anyScheduled = programs.some(p => Array.isArray(p.scheduleDays) && p.scheduleDays.length > 0);
        if (!anyScheduled) return '';

        const firstDay = this.app.settings?.firstDayOfWeek === 1 ? 1 : 0;
        const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const fullLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const cells = weekStrip(programs, firstDay);
        const todayWeekday = cells.find(c => c.isToday)?.weekday ?? new Date().getDay();
        // Default the selection to today so "today's workout" shows immediately.
        if (this.selectedWeekday == null) this.selectedWeekday = todayWeekday;
        const selected = cells.find(c => c.weekday === this.selectedWeekday)
            || cells.find(c => c.isToday) || cells[0];

        // Compact day pills: label + a dot only when that day has a workout.
        // Tapping a pill selects the day (it does not start a workout); the
        // selected day's full workout details appear in the panel below.
        const pills = cells.map(cell => {
            const classes = ['week-day-pill'];
            if (cell.isToday) classes.push('is-today');
            if (cell.weekday === selected.weekday) classes.push('is-selected');
            if (cell.programs.length > 0) classes.push('has-workout');
            const aria = `${fullLabels[cell.weekday]}${cell.isToday ? ', today' : ''}, ${cell.programs.length ? cell.programs.length + ' workout' + (cell.programs.length > 1 ? 's' : '') : 'no workout'}`;
            return `
                <button type="button" class="${classes.join(' ')}"
                    data-action="select-week-day" data-weekday="${cell.weekday}"
                    aria-pressed="${cell.weekday === selected.weekday ? 'true' : 'false'}"
                    aria-label="${aria}">
                    <span class="week-day-pill-label">${labels[cell.weekday]}</span>
                    <span class="week-day-pill-dot" aria-hidden="true"></span>
                </button>`;
        }).join('');

        const isSelToday = selected.weekday === todayWeekday;
        const dayTitle = isSelToday ? `Today, ${fullLabels[selected.weekday]}` : fullLabels[selected.weekday];
        let detail;
        if (selected.programs.length === 0) {
            detail = `
                <p class="week-detail-day">${dayTitle}</p>
                <p class="week-detail-empty">No workout scheduled. Pick any program below.</p>`;
        } else {
            const items = selected.programs.map(p => `
                <div class="week-detail-item">
                    <span class="week-detail-name">${escapeHtml(p.name)}</span>
                    <button type="button" class="btn btn-primary week-detail-start" data-action="start-workout" data-program-id="${p.id}" title="Start ${escapeHtml(p.name)}">
                        <i class="fas fa-play" aria-hidden="true"></i> Start
                    </button>
                </div>`).join('');
            detail = `
                <p class="week-detail-day">${dayTitle}</p>
                <div class="week-detail-list">${items}</div>`;
        }

        return `
            <section class="week-strip" aria-label="Weekly workout schedule">
                <div class="week-strip-pills" role="group" aria-label="Days of the week">${pills}</div>
                <div class="week-strip-detail">${detail}</div>
            </section>`;
    }

    renderProgramSelection() {
        const container = document.getElementById('workout-program-list');
        // Same ordering source-of-truth as Home + Programs: the user's chosen
        // sort mode + saved custom order are read from storage on every render,
        // so a reorder on the Programs screen reflects here without any extra
        // plumbing. `orderPrograms` is the single place that applies sorting.
        const sortMode = storageService.getProgramSort() || 'custom';
        const savedOrder = storageService.getProgramOrder() || [];
        const programs = orderPrograms(this.app.programs, sortMode, savedOrder);

        // Start fresh - don't double-add the banner
        let html = '';

        // Add paused workout banner if exists
        const bannerHTML = renderPausedBannerHTML({ location: 'workout', withCalendarMeta: true });
        if (bannerHTML) html += bannerHTML;

        if (programs.length === 0) {
            html += `
                <div class="empty-state">
                    <i class="fas fa-folder-open"></i>
                    <p>No programs yet. Create a program first.</p>
                    <button type="button" class="btn btn-primary" data-home-action="create-program">Create Program</button>
                </div>
            `;
            container.innerHTML = html;
            return;
        }

        html += this._renderWeekStripHTML(programs);

        // Connect the selected day (set by the week strip) to the cards below:
        // the program(s) scheduled on the selected day get a highlight + chip.
        const selWeekday = this.selectedWeekday;
        const todayWeekday = new Date().getDay();
        const fullDayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        html += `
            <h2>Select a Program</h2>
            <p class="subtitle">Choose which program you want to do today</p>
            <div class="program-selection-grid">
                ${programs.map(program => {
                    const lastSession = this._lastSessionForProgram(program.id);
                    const lastDoneHTML = this._renderLastDoneInfo(lastSession);
                    const scheduledSel = selWeekday != null
                        && Array.isArray(program.scheduleDays)
                        && program.scheduleDays.includes(selWeekday);
                    const chipText = selWeekday === todayWeekday ? 'Today' : fullDayLabels[selWeekday];
                    return `
                    <div class="program-card${scheduledSel ? ' program-card--scheduled' : ''}" data-program-card="${program.id}">
                        <div class="program-header">
                            <h3>${escapeHtml(program.name)}</h3>
                            ${scheduledSel ? `<span class="program-sched-chip"><i class="fas fa-calendar-check" aria-hidden="true"></i> ${escapeHtml(chipText)}</span>` : ''}
                        </div>
                        ${program.description && program.description.trim() ? `<p>${escapeHtml(program.description)}</p>` : ''}
                        <div class="program-stats">
                            <div class="stat">
                                <i class="fas fa-dumbbell"></i>
                                ${program.exercises.length} exercises
                            </div>
                        </div>
                        ${lastDoneHTML}
                        ${program.exercises.length === 0
                            ? `<p class="text-warning"><i class="fas fa-exclamation-triangle"></i> No exercises in this program</p>`
                            : `<button class="btn btn-primary btn-large" data-action="start-workout" data-program-id="${program.id}">
                                <i class="fas fa-play"></i> Start Workout
                            </button>`
                        }
                    </div>
                    `;
                }).join('')}
            </div>
        `;

        container.innerHTML = html;

        // Item R3-1: week-strip program entries use data-action="start-workout",
        // wired by the delegated click handler in wireWorkoutActions.

        const banner = container.querySelector('.paused-workout-banner');
        if (banner) {
            wirePausedBannerActions(banner, {
                onResume: () => this.resumeWorkout(),
                onDiscard: () => this.discardPausedWorkout(),
            });
        }
    }

    startWorkout(programId) {
        const program = this.app.getProgramById(programId);
        if (!program) return;
        if (this._otherTabOwnsWorkout()) {
            showToast('A workout is being logged in another tab. Finish or pause it there first.', 'error', 6000);
            return;
        }

        if (!program.exercises || program.exercises.length === 0) {
            showToast('This program has no exercises', 'error');
            return;
        }

        // Create new workout session
        this.currentWorkoutSession = new WorkoutSession({
            programId: program.id,
            workoutDayId: null,
            workoutDayName: program.name,
            // Record the unit the lifter is entering in. Storage stays
            // canonical kg either way; this is metadata, and the in-workout
            // toggle rewrites it.
            sessionUnit: normalizeWeightUnit(this.app.settings.weightUnit),
            // Everything this session records is written through
            // toCanonicalWeight(), so it is canonical kg from the first set.
            // Stamping it here is what makes every later migration and the
            // Settings re-check a guaranteed no-op for it.
            unitsCanonical: true,
            exercises: program.exercises.map(ex => new WorkoutExercise({
                exerciseId: ex.exerciseId,
                plannedExerciseId: ex.exerciseId,
                // Snapshot the exercise's CURRENT catalog name into the new
                // session: program rows can carry a pre-rename snapshot.
                exerciseName: this.app.getExerciseDisplayName(ex.exerciseId, ex.exerciseName),
                targetSets: ex.targetSets,
                targetReps: ex.targetReps,
                restSeconds: ex.restSeconds,
                order: ex.order,
                // Carry the program's superset link through to the live
                // session so renderExerciseList can wrap consecutive
                // grouped exercises in a single .superset-block card and
                // shouldStartRestForSet can suppress mid-round rest.
                groupId: ex.groupId,
            }))
        });

        this.currentWorkoutSession.startWorkout();

        // GT-07: a NEW workout gets a clean finish form. Reopening the finish
        // dialog for the SAME session keeps whatever the user typed.
        this.resetFinishWorkoutForm();

        // Reset per-session state.
        this.sessionPrSlots = {};
        this.collapsedExercises = {};
        this._prevCompleteState = {};
        this._activeRestType = null;
        this._feelPromptShown = {};
        this.warmupDone = {};
        this.warmupExpanded = {};

        // Start workout timer
        timerService.startWorkoutTimer((elapsed) => {
            this.updateWorkoutTimer(elapsed);
        });

        // The session is recoverable from the moment it exists, not from the
        // first set (GT-01).
        this.claimWorkoutLock();
        this.persistActiveWorkout();

        // Switch to active workout screen
        document.getElementById('workout-selection').classList.remove('active');
        document.getElementById('active-workout').classList.add('active');

        // Render workout
        this.renderActiveWorkout();
        this.armBackGuard();
        this.app.updateGlobalFab();
    }

    adjustWorkoutTitleSize() {
        const titleEl = document.getElementById('workout-title');
        if (!titleEl) return;

        const text = titleEl.textContent;
        const length = text.length;

        // Adjust font size based on text length
        let fontSize;
        if (length <= 12) {
            fontSize = '1.25rem';
        } else if (length <= 18) {
            fontSize = '1.1rem';
        } else if (length <= 24) {
            fontSize = '1rem';
        } else if (length <= 30) {
            fontSize = '0.9rem';
        } else {
            fontSize = '0.8rem';
        }

        titleEl.style.fontSize = fontSize;
    }

    renderActiveWorkout() {
        if (!this.currentWorkoutSession) return;

        document.getElementById('workout-title').textContent = this.currentWorkoutSession.workoutDayName;
        this.adjustWorkoutTitleSize();
        this.syncPlateHintsButton();
        this.syncSessionUnitToggle();

        const container = document.getElementById('workout-exercises-list');

        // When restMode is 'uniform', show between-exercise rest in the sticky header.
        const program = this.app.getProgramById(this.currentWorkoutSession.programId);
        const restBetweenEl = document.getElementById('workout-rest-between');
        const restBetweenValueEl = document.getElementById('workout-rest-between-value');
        if (restBetweenEl && restBetweenValueEl) {
            if (program?.restMode === 'uniform') {
                const secs = program.uniformRestSeconds ?? 90;
                restBetweenValueEl.textContent = this.formatRest(secs);
                restBetweenEl.hidden = false;
            } else {
                restBetweenEl.hidden = true;
                restBetweenValueEl.textContent = '';
            }
        }

        container.innerHTML = this.renderExerciseList(this.currentWorkoutSession.exercises);
        this.currentWorkoutSession.exercises.forEach((_ex, i) => this.dedupePlateHints(i));
    }

    /**
     * Render the exercise stream, wrapping any consecutive run of exercises
     * that share a `groupId` in a single `.superset-block` card. Solo
     * exercises render with no wrapping element so existing CSS for
     * `.exercise-entry` keeps working unchanged.
     */
    renderExerciseList(exercises) {
        let html = '';
        let i = 0;
        while (i < exercises.length) {
            const ex = exercises[i];
            if (!ex.groupId) {
                html += this.renderExerciseEntry(ex, i);
                i += 1;
                continue;
            }
            // Walk forward while the run shares the same groupId.
            const groupId = ex.groupId;
            const start = i;
            while (i < exercises.length && exercises[i].groupId === groupId) i += 1;
            const groupItems = exercises.slice(start, i);
            // A "group" of one isn't really a superset — render solo.
            if (groupItems.length < 2) {
                html += this.renderExerciseEntry(ex, start);
                continue;
            }
            html += `
                <div class="superset-block" role="group" aria-label="Superset of ${groupItems.length} exercises">
                    <div class="superset-block-header">
                        <i class="fas fa-link" aria-hidden="true"></i>
                        <span>Superset · ${groupItems.length} exercises</span>
                    </div>
                    ${groupItems.map((g, k) => this.renderExerciseEntry(g, start + k)).join('')}
                </div>
            `;
        }
        return html;
    }

    /**
     * Render a single exercise block: progress header, and a list of N planned
     * set rows where N = max(targetSets, sets.length).
     */
    renderExerciseEntry(exercise, index) {
        const exerciseData = this.app.getExerciseById(exercise.exerciseId);
        const isDuration = !!(exerciseData && exerciseData.exerciseType === 'duration');
        const previousSets = this.getPreviousExerciseData(exercise.exerciseId) || [];
        // Item 8: display + entry use the per-session unit; canonical storage
        // stays in the account unit.
        const unit = this.sessionUnit();

        // Task 6: rep-range labels from the program exercise's sets[].
        // Resolved through the PLANNED id so a swapped-in substitute keeps the
        // slot's guidance (GT-13). Falls back gracefully for old
        // sessions/programs that lack sets[].
        const program = this.app.getProgramById(this.currentWorkoutSession?.programId);
        const progEx = this.programRowFor(exercise);
        const progSets = (progEx?.sets && progEx.sets.length > 0) ? progEx.sets : null;
        // Plate calculator only meaningful for plate-loaded exercises.
        const equipment = exerciseData?.equipment || '';
        const isPlateLoaded = PLATE_LOADED_EQUIPMENT.has(equipment);
        const usesBarWeight = equipment === 'barbell' || equipment === 'trap-bar';

        // Build a slot → Set lookup so rendering is driven by each set's
        // stable `slot` rather than its position in the dense array. This
        // keeps Set 1 visually Set 1 even after un-toggling another row.
        const setsBySlot = new Map();
        exercise.sets.forEach((set, arrIdx) => {
            const slot = set.slot != null ? set.slot : arrIdx;
            setsBySlot.set(slot, set);
        });
        const maxCommittedSlot = setsBySlot.size === 0
            ? -1
            : Math.max(...setsBySlot.keys());

        const targetSets = Math.max(1, exercise.targetSets || 3);
        const completedCount = exercise.sets.length;
        const totalRows = Math.max(targetSets, maxCommittedSlot + 1);
        const isComplete = completedCount >= targetSets && targetSets > 0;

        const muscle = formatMuscleGroup(exerciseData?.muscleGroup);
        const progressLabel = `${completedCount} / ${targetSets} sets`;

        // Feature 3: collapsed state. Completed exercises start collapsed by
        // default; in-progress (or manually toggled) ones stay expanded.
        const isCollapsed = isComplete
            ? (this.collapsedExercises[index] !== false)  // default collapsed when complete
            : !!this.collapsedExercises[index];           // default expanded when in-progress

        // Task 6: determine if all programmed sets share the same target.
        // When they do, show once at exercise level instead of repeating per row.
        //
        // GT-12: a timed exercise is planned in SECONDS, not reps. It used to
        // borrow the rep machinery and advertise "10 reps" as a plank target,
        // which means nothing; it now shows "Target 1:00".
        let allSameRepRange = false;
        let sharedRepLabel = '';
        if (isDuration) {
            const seconds = progSets
                ? progSets.map((_row, i) => this.plannedSecondsFor(progSets, i))
                : [DEFAULT_TARGET_SECONDS];
            allSameRepRange = seconds.every(v => v === seconds[0]);
            if (allSameRepRange) sharedRepLabel = `Target ${formatDuration(seconds[0])}`;
        } else if (progSets && progSets.length > 0) {
            const first = progSets[0];
            allSameRepRange = progSets.every(s => s.repsMin === first.repsMin && s.repsMax === first.repsMax);
            if (allSameRepRange) {
                sharedRepLabel = this.formatRepRange(first.repsMin, first.repsMax);
            }
        }

        // Item 6: the ramp is sized off the weight the FIRST working set is
        // pre-filled with, in the session display unit.
        const firstPrior = (exercise.stickyValues && exercise.stickyValues[0])
            || previousSets[0]
            || previousSets[previousSets.length - 1]
            || null;
        const workingWeight = (firstPrior && firstPrior.weight !== '' && firstPrior.weight != null)
            ? this.toSessionWeight(firstPrior.weight)
            : 0;
        const warmupHTML = this.renderWarmupStrip(index, {
            equipment, isDuration, unit, workingWeight, exerciseId: exercise.exerciseId,
        });

        let rowsHTML = '';
        for (let i = 0; i < totalRows; i++) {
            const committed = setsBySlot.get(i);
            if (committed) {
                rowsHTML += this.renderCompletedRow(committed, index, i, isDuration, unit);
            } else {
                // Default priority for a planned row:
                //   1. sticky — values the user already typed/committed for this
                //      slot in this session (survives toggle-off without loss).
                //   2. prior[i] — matching-index set from the last workout.
                //   3. prior[last] — global fallback to the most recent set.
                const sticky = exercise.stickyValues && exercise.stickyValues[i];
                const prior = sticky
                    || previousSets[i]
                    || previousSets[previousSets.length - 1]
                    || null;
                // Per-slot rep range: only when sets differ and slot is within
                // the programmed count. Extra added-set rows show nothing.
                const slotProgSet = (!allSameRepRange && progSets && i < progSets.length)
                    ? progSets[i] : null;
                const slotRepLabel = isDuration
                    ? (allSameRepRange ? null : `Target ${formatDuration(this.plannedSecondsFor(progSets, i))}`)
                    : (slotProgSet ? this.formatRepRange(slotProgSet.repsMin, slotProgSet.repsMax) : null);
                // Prefill each row with its own set's top-of-range target, not set 1's.
                const slotTargetReps = (progSets && i < progSets.length)
                    ? progSets[i].repsMax : exercise.targetReps;
                // GT-12: with no previous session to copy, a timed row
                // pre-fills from the PLANNED hold instead of 0:00.
                const slotTargetSeconds = isDuration
                    ? this.plannedSecondsFor(progSets, i) : 0;
                rowsHTML += this.renderPlannedRow(index, i, prior, isDuration, unit, slotTargetReps, isPlateLoaded, usesBarWeight, slotRepLabel, slotTargetSeconds);
            }
        }

        // Column captions over the two input fields. Once per exercise rather
        // than per row, so "which side is weight" is answered without adding a
        // label to every set. The trailing span is a hidden .set-toggle: it
        // inherits the toggle's exact box (which narrows on small screens), so
        // the captions stay locked over their columns at every width.
        // Duration exercises use a Min:Sec row instead, and an exercise with
        // every set logged has no fields left to caption.
        const hasPlannedRow = setsBySlot.size < totalRows;
        const headsHTML = (!isDuration && hasPlannedRow) ? `
            <li class="set-heads" aria-hidden="true">
                <span class="set-row-num"></span>
                <div class="set-row-inputs">
                    <span class="set-col-head">Weight (${unit})</span>
                    <span class="set-col-head">Reps</span>
                </div>
                <span class="set-toggle set-toggle--ghost"></span>
            </li>
        ` : '';

        // Item R3-4: the chosen feel for THIS session (set via the modal) shows
        // on the exercise header and toggles good -> none on tap. The inline
        // prompt row is gone; the picker is the modal (see commitPlannedSet).
        const sessionFeelHTML = !isDuration ? this.renderFeelToggleIcon(index, exercise.feel) : '';

        // Item 7: the smiley means "I marked this good LAST time", nothing more.
        // It lasts exactly one following workout and expires unless renewed, so
        // this asks only about the immediately previous session that performed
        // the exercise - never the most recent 'good' anywhere in history.
        // Only when there is no session feel chosen yet so the two icons don't stack.
        const lastFeel = (!isDuration && exercise.feel !== 'good')
            ? previousSessionFeelForExercise(this.app.workoutSessions, exercise.exerciseId, s => s.sortTimestamp)
            : null;
        const lastFeelHTML = lastFeel ? this.renderFeelHistoryIcon(lastFeel) : '';

        // Item R2-3: the between-set rest is shown as a single in-place chip.
        // Idle, it renders the duration as a static GRAY number; when a set is
        // completed the same element becomes the live colored countdown, then
        // reverts to gray. No "Between sets"/"After exercise" pills.
        const betweenSetActive = progEx?.restSeconds ?? exercise.restSeconds ?? 90;
        const isRestingHere = this.activeRestExerciseIndex === index && this._activeRestType === 'set';
        const restChipHTML = `
            <div class="rest-countdown-chip${isRestingHere ? '' : ' rest-countdown-chip--idle'}"
                 data-rest-idle="${betweenSetActive}" aria-live="off"
                 title="Rest between sets"><i class="fas fa-clock" aria-hidden="true"></i> ${this.formatRest(betweenSetActive)}</div>
        `;

        // Per-exercise plate-hints toggle.
        // Global OFF overrides everything: hints hidden for ALL exercises.
        // Global ON: per-exercise preference applies (defaults to ON).
        const globalHints = this.app.settings?.plateHintsEnabled !== false;
        const perExHints = this.app.settings?.exercisePlateHints?.[exercise.exerciseId];
        const hintsOnForExercise = globalHints && (perExHints !== undefined ? perExHints : true);
        // Per-exercise toggle is only meaningful when global hints are ON.
        // GT-40: one global bar weight computed a Barbell Curl against the
        // 20 kg olympic bar; real EZ / curl bars are 7-10 kg, and trap and
        // specialty bars differ again. Bar-based exercises get a chip showing
        // the bar they are actually computed against, and tapping it opens an
        // inline override. Exercises with no bar/base-weight concept (cables,
        // machines, dumbbells) never see it.
        const barWeight = usesBarWeight ? this.sessionBarWeight(exercise.exerciseId) : 0;
        const hasBarOverride = usesBarWeight
            && this.app.settings?.plateConfig
            && this.app.settings.plateConfig(unit).exerciseBarWeights?.[String(exercise.exerciseId)] !== undefined;
        const barChipHTML = (usesBarWeight && globalHints && hintsOnForExercise) ? `
            <button type="button" class="gt-iconbtn gt-bar-chip${hasBarOverride ? ' gt-bar-chip--custom' : ''}"
                data-action="toggle-bar-config"
                data-exercise-index="${index}"
                aria-expanded="false"
                aria-label="Bar weight for this exercise: ${barWeight}${unit}. Tap to change."
                title="Bar weight: ${barWeight}${unit}">
                <span class="gt-bar-chip-text">${barWeight}${unit}</span>
            </button>
        ` : '';

        const plateToggleHTML = (isPlateLoaded && globalHints) ? `
            <button type="button" class="gt-iconbtn btn-icon-plates--per-ex${hintsOnForExercise ? '' : ' btn-icon-plates--off'}"
                data-action="toggle-exercise-plate-hints"
                data-exercise-index="${index}"
                aria-pressed="${hintsOnForExercise ? 'true' : 'false'}"
                aria-label="${hintsOnForExercise ? 'Hide' : 'Show'} plate hints for this exercise"
                title="${hintsOnForExercise ? 'Hide' : 'Show'} plate hints">
                <i class="fas fa-dumbbell" aria-hidden="true"></i>
            </button>
        ` : '';

        return `
            <div class="exercise-entry ${isComplete ? 'exercise-complete' : ''} ${isCollapsed ? 'exercise-collapsed' : ''}"
                 id="exercise-${index}" data-exercise-type="${isDuration ? 'duration' : 'reps'}">
                <div class="exercise-entry-header">
                    <div class="exercise-title-block exercise-title-collapse"
                         data-action="toggle-exercise-collapse"
                         data-exercise-index="${index}"
                         title="${isCollapsed ? 'Expand' : 'Collapse'} exercise">
                        <h3>
                            <span class="exercise-name-main">${escapeHtml(this.app.getExerciseDisplayName(exercise.exerciseId, exercise.exerciseName))}</span>${sessionFeelHTML}${lastFeelHTML}
                        </h3>
                        <div class="exercise-subtitle">
                            <span class="exercise-progress ${isComplete ? 'is-complete' : ''}" aria-label="Sets ${progressLabel}">
                                ${isComplete ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}${progressLabel}
                            </span>${muscle ? `
                            <span class="exercise-name-sub">${escapeHtml(muscle)}</span>` : ''}${allSameRepRange ? `
                            <span class="exercise-rep-target" aria-label="Target: ${sharedRepLabel}">${sharedRepLabel}</span>` : ''}
                            ${restChipHTML}
                        </div>
                    </div>
                    <div class="exercise-header-controls">
                        <button type="button" class="gt-iconbtn gt-swap-toggle"
                            data-action="swap-exercise"
                            data-exercise-index="${index}"
                            aria-label="Swap this exercise for another"
                            title="Swap exercise (this workout only)">
                            <i class="fas fa-right-left" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="gt-iconbtn gt-notes-toggle${exercise.notes ? ' gt-notes-toggle--has-notes' : ''}"
                            data-action="toggle-exercise-notes"
                            data-exercise-index="${index}"
                            aria-expanded="false"
                            aria-label="Notes for this exercise"
                            title="Notes for this exercise">
                            <i class="fas fa-pen" aria-hidden="true"></i>
                        </button>
                        ${barChipHTML}
                        ${plateToggleHTML}
                        <button type="button" class="gt-iconbtn exercise-collapse-toggle"
                            data-action="toggle-exercise-collapse"
                            data-exercise-index="${index}"
                            aria-expanded="${isCollapsed ? 'false' : 'true'}"
                            aria-label="${isCollapsed ? 'Expand' : 'Collapse'} exercise">
                            <i class="fas fa-chevron-${isCollapsed ? 'down' : 'up'}" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>

                <div class="exercise-body">
                    <div class="gt-bar-config" id="bar-config-${index}" hidden>
                        <label class="gt-bar-config-label" for="bar-weight-${index}">Bar weight (${unit})</label>
                        <input type="number" class="gt-bar-config-input" id="bar-weight-${index}"
                            data-exercise-index="${index}" min="0" step="0.5"
                            value="${barWeight}" inputmode="decimal">
                        <button type="button" class="gt-bar-config-reset"
                            data-action="reset-bar-weight" data-exercise-index="${index}">
                            Use default
                        </button>
                    </div>

                    <div class="gt-exercise-notes" id="exercise-notes-${index}" hidden>
                        <textarea class="gt-exercise-notes-input" data-exercise-index="${index}"
                            placeholder="Notes for this exercise (form cues, how it felt, etc.)"
                            aria-label="Exercise notes">${escapeHtml(exercise.notes || '')}</textarea>
                    </div>

                    ${warmupHTML}

                    <ol class="set-row-list" id="set-row-list-${index}">
                        ${headsHTML}
                        ${rowsHTML}
                    </ol>

                    <div class="set-row-footer">
                        ${totalRows > Math.max(1, completedCount) ? `
                            <button type="button" class="btn-remove-set"
                                data-action="remove-planned-row"
                                data-exercise-index="${index}"
                                title="Remove last empty set"
                                aria-label="Remove last empty set row">
                                <i class="fas fa-minus"></i>
                            </button>
                        ` : ''}
                        <button type="button" class="btn-add-set btn-add-set--extra"
                            data-action="add-planned-row"
                            data-exercise-index="${index}"
                            aria-label="Add another set row">
                            <i class="fas fa-plus"></i> Add set
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * A set that has not yet been logged. Shows empty (or prefilled-from-prior)
     * inputs and a pill toggle on the right — tapping the toggle commits the
     * set and starts the rest timer. The row itself is NOT tappable — users
     * deliberately flick the toggle to complete.
     */
    renderPlannedRow(exerciseIndex, slot, prior, isDuration, unit, targetReps, isPlateLoaded = false, usesBarWeight = false, repLabel = null, targetSeconds = 0) {
        const setLabel = `${slot + 1}`;
        const toggle = this.renderSetToggle(false, 'commit-planned-set', exerciseIndex, slot, 'Mark set complete');

        if (isDuration) {
            // Previous session first (the audit confirmed that prefill works),
            // then the programmed target, then empty (GT-12).
            const seeded = (prior && prior.duration > 0) ? prior.duration : (targetSeconds || 0);
            const mins = Math.floor(seeded / 60);
            const secs = seeded % 60;
            return `
                <li class="set-row set-row-planned" data-slot="${slot}">
                    <span class="set-row-num">${setLabel}</span>
                    <div class="set-row-inputs">
                        <input type="number" inputmode="numeric" class="duration-min"
                            id="duration-min-${exerciseIndex}-${slot}" min="0"
                            value="${mins}" placeholder="Min" aria-label="Minutes">
                        <span class="duration-separator">:</span>
                        <input type="number" inputmode="numeric" class="duration-sec"
                            id="duration-sec-${exerciseIndex}-${slot}" min="0" max="59"
                            value="${secs.toString().padStart(2, '0')}" placeholder="Sec" aria-label="Seconds">
                    </div>
                    ${toggle}
                    ${repLabel ? `
                    <div class="set-row-meta">
                        <span class="set-rep-target" aria-label="Target: ${escapeHtml(repLabel)}">${escapeHtml(repLabel)}</span>
                    </div>` : ''}
                </li>
            `;
        }

        // Prior weights are canonical kilograms; convert into the session
        // display unit for prefill (Item 8). One decimal via convertWeight.
        const weight = prior && prior.weight !== '' && prior.weight != null
            ? this.toSessionWeight(prior.weight)
            : '';
        const reps = prior ? prior.reps : (targetReps || '');
        // Per-exercise plate hints: global OFF overrides everything; also off
        // while the session unit differs from the account unit (Item 8).
        const sessionExercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        const exerciseId = sessionExercise?.exerciseId;
        const globalHintsOn = this.app.settings?.plateHintsEnabled !== false;
        const perExHintsVal = exerciseId !== undefined
            ? this.app.settings?.exercisePlateHints?.[exerciseId]
            : undefined;
        const hintsOn = globalHintsOn && (perExHintsVal !== undefined ? perExHintsVal : true);
        const plateHintHTML = (isPlateLoaded && hintsOn)
            ? this.renderPlateHint(weight, unit, usesBarWeight, exerciseId) : '';

        // Feature 6: prior pre-filled values stored on the row so an input that
        // drifts from them can surface a "same as last time" restore chip. Only
        // present when prior data exists; the chip itself is created on input
        // (see maybeToggleRestoreChip), not at render.
        const restoreData = (prior && weight !== '' && reps !== '' && reps != null)
            ? `data-prior-weight="${weight}" data-prior-reps="${reps}"`
            : '';

        // Item 1: explain the prefill whenever it is not simply "what you lifted
        const step = this._stepIncrement(
            this.currentWorkoutSession?.exercises[exerciseIndex]?.exerciseId,
            unit,
        );

        return `
            <li class="set-row set-row-planned" data-slot="${slot}" ${restoreData}>
                <span class="set-row-num">${setLabel}</span>
                <div class="set-row-inputs">
                    <div class="gt-stepper-group">
                        ${this.renderStepper('step-weight', 'down', exerciseIndex, slot, `Decrease weight by ${step}${unit}`)}
                        <input type="number" inputmode="decimal" class="set-weight"
                            id="weight-${exerciseIndex}-${slot}" min="0" step="0.5"
                            value="${weight === '' ? '' : weight}" placeholder="Weight" aria-label="Weight"
                            data-plate-hint-target="${exerciseIndex}-${slot}">
                        ${this.renderStepper('step-weight', 'up', exerciseIndex, slot, `Increase weight by ${step}${unit}`)}
                    </div>
                    <span class="set-row-x">×</span>
                    <div class="gt-stepper-group">
                        ${this.renderStepper('step-reps', 'down', exerciseIndex, slot, 'One rep fewer')}
                        <input type="number" inputmode="numeric" class="set-reps"
                            id="reps-${exerciseIndex}-${slot}" min="1"
                            value="${reps === '' ? '' : reps}" placeholder="Reps" aria-label="Reps">
                        ${this.renderStepper('step-reps', 'up', exerciseIndex, slot, 'One more rep')}
                    </div>
                </div>
                ${toggle}
                ${(repLabel || plateHintHTML) ? `
                <div class="set-row-meta">
                    ${repLabel ? `<span class="set-rep-target" aria-label="Target: ${repLabel}">${repLabel}</span>` : ''}
                    ${plateHintHTML ? `<div class="plate-hint" id="plate-hint-${exerciseIndex}-${slot}">${plateHintHTML}</div>` : ''}
                </div>` : ''}
                <div class="set-row-notes"></div>
            </li>
        `;
    }

    /**
     * Item 2: one-tap -/+ button flanking a planned-row input. `type="button"`
     * plus the delegated handler means the input never takes focus, so tapping
     * a stepper does not raise the mobile keyboard.
     */
    renderStepper(action, dir, exerciseIndex, slot, ariaLabel) {
        return `
            <button type="button" class="gt-stepper gt-stepper--${dir === 'up' ? 'plus' : 'minus'}"
                data-action="${action}"
                data-step-dir="${dir}"
                data-exercise-index="${exerciseIndex}"
                data-slot="${slot}"
                aria-label="${ariaLabel}" title="${ariaLabel}">
                <i class="fas fa-${dir === 'up' ? 'plus' : 'minus'}" aria-hidden="true"></i>
            </button>
        `;
    }

    /**
     * Item 2: nudge the weight input by the exercise's overload increment.
     * Floors at 0 and re-uses the row's own 'input' event path so the plate
     * hint and the restore chip stay in sync.
     */
    stepWeight(exerciseIndex, slot, dir) {
        const input = document.getElementById(`weight-${exerciseIndex}-${slot}`);
        if (!input) return;
        const exerciseId = this.currentWorkoutSession?.exercises[exerciseIndex]?.exerciseId;
        const step = this._stepIncrement(exerciseId, this.sessionUnit());
        const current = input.value === '' ? 0 : Number(input.value);
        const next = Math.max(0, Math.round((current + dir * step) * 100) / 100);
        this._setPlannedInputValue(input, next);
    }

    /** Item 2: nudge the reps input by one, floored at 0. */
    stepReps(exerciseIndex, slot, dir) {
        const input = document.getElementById(`reps-${exerciseIndex}-${slot}`);
        if (!input) return;
        const current = input.value === '' ? 0 : Number(input.value);
        this._setPlannedInputValue(input, Math.max(0, Math.round(current) + dir));
    }

    /**
     * Write a stepper/restore value into a planned input WITHOUT focusing it
     * (no mobile keyboard), then fire the same bubbling 'input' event a
     * keystroke would so the delegated listener refreshes the plate hint and
     * the restore chip.
     */
    _setPlannedInputValue(input, value) {
        input.value = String(value);
        if (this.app.settings?.vibrationAlerts !== false) vibrate(10);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * GT-32: carry a first-set weight down the exercise.
     *
     * On an exercise with no previous session there is nothing to pre-fill
     * from, so every planned row started empty and a 27-set first workout
     * meant typing the same number 27 times. Typing set 1's weight now seeds
     * the rows below it.
     *
     * Strictly additive: it only ever writes into rows that are still EMPTY,
     * so a deliberately different back-off set, an already-typed row and a
     * prefilled row are all untouched. Once a row has a value, the lifter
     * owns it.
     */
    carryWeightDown(exerciseIndex, fromSlot) {
        const host = document.getElementById(`exercise-${exerciseIndex}`);
        const source = document.getElementById(`weight-${exerciseIndex}-${fromSlot}`);
        if (!host || !source || source.value === '') return;

        host.querySelectorAll('.set-row-planned').forEach((plannedRow) => {
            const slot = Number(plannedRow.dataset.slot);
            if (!Number.isFinite(slot) || slot <= fromSlot) return;
            const weightInput = plannedRow.querySelector('.set-weight');
            if (!weightInput || weightInput.value !== '') return;
            weightInput.value = source.value;
            this.refreshPlateHint(exerciseIndex, slot, weightInput.value);
            this.maybeToggleRestoreChip(plannedRow);
        });
        this.dedupePlateHints(exerciseIndex);
    }

    /**
     * Feature 6: show/hide the "same as last time" restore chip on a planned
     * row based on whether the current weight/reps differ from the prior
     * pre-filled values stored on the row.
     */
    maybeToggleRestoreChip(row) {
        if (!row) return;
        const existing = row.querySelector('.gt-restore-chip');
        // No prior data on this row -> never show.
        if (row.dataset.priorWeight === undefined || row.dataset.priorReps === undefined) {
            if (existing) existing.remove();
            return;
        }
        const priorWeight = Number(row.dataset.priorWeight);
        const priorReps = Number(row.dataset.priorReps);
        const weightInput = row.querySelector('.set-weight');
        const repsInput = row.querySelector('.set-reps');
        const curWeight = weightInput && weightInput.value !== '' ? Number(weightInput.value) : null;
        const curReps = repsInput && repsInput.value !== '' ? Number(repsInput.value) : null;
        const diverged = (curWeight !== null && curWeight !== priorWeight)
            || (curReps !== null && curReps !== priorReps);

        if (!diverged) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;

        const slot = Number(row.dataset.slot);
        const exerciseIndex = Number(weightInput?.id.split('-')[1]);
        const unit = this.sessionUnit();
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'gt-note gt-note--info gt-restore-chip';
        chip.dataset.action = 'restore-last-time';
        chip.dataset.exerciseIndex = String(exerciseIndex);
        chip.dataset.slot = String(slot);
        chip.title = "Restore last session's weight and reps";
        chip.setAttribute('aria-label', `Previous: ${priorWeight}${unit} by ${priorReps} reps. Tap to restore.`);
        // Compact, muted helper line: a history icon + "Previous: 130lb × 8".
        // Reads as secondary metadata beneath the inputs while staying tappable.
        chip.innerHTML = `<i class="fas fa-clock-rotate-left" aria-hidden="true"></i><span class="gt-restore-chip-text">Previous: ${priorWeight}${unit} × ${priorReps}</span>`;
        // Into the row's notes strip beneath the inputs.
        (row.querySelector('.set-row-notes') || row).appendChild(chip);
    }

    /**
     * Feature 6: restore BOTH the weight and reps inputs to the prior pre-filled
     * values stored on the row, then remove the restore chip.
     */
    restoreLastTime(exerciseIndex, slot, chip) {
        const row = chip.closest('.set-row-planned');
        if (!row) { chip.remove(); return; }
        const weightInput = document.getElementById(`weight-${exerciseIndex}-${slot}`);
        const repsInput = document.getElementById(`reps-${exerciseIndex}-${slot}`);
        if (weightInput && row.dataset.priorWeight !== undefined) {
            weightInput.value = row.dataset.priorWeight;
            this.refreshPlateHint(exerciseIndex, slot, weightInput.value);
        }
        if (repsInput && row.dataset.priorReps !== undefined) {
            repsInput.value = row.dataset.priorReps;
        }
        chip.remove();
    }

    /**
     * Item R3-4: the chosen-feel icon shown on the exercise header for THIS
     * session. Rendered ONLY when feel === 'good' (green smiley). Tapping it
     * toggles good -> none (removes the mark); see cycleExerciseFeel. Returns ''
     * for any other value, so the history icon (if any) shows instead.
     */
    renderFeelToggleIcon(exerciseIndex, feel) {
        if (feel !== 'good') return '';
        const label = 'Felt good. Tap to remove.';
        return `
            <button type="button" class="feel-toggle feel-toggle-good"
                data-action="cycle-feel" data-exercise-index="${exerciseIndex}"
                aria-label="${label}" title="${label}">
                <i class="fas fa-face-smile" aria-hidden="true"></i>
            </button>
        `;
    }

    /**
     * Item 7: the last-feel icon shown next to the exercise name. Rendered ONLY
     * when feel === 'good' (green smiley); returns '' otherwise, so legacy
     * sessions marked 'bad' show no icon.
     */
    renderFeelHistoryIcon(feel) {
        if (feel !== 'good') return '';
        const label = 'Last time this felt good (you marked it for more weight)';
        return `<span class="feel-history feel-history-good" role="img" aria-label="${label}" title="${label}"><i class="fas fa-face-smile" aria-hidden="true"></i></span>`;
    }

    /**
     * Item R3-4: set the feel marking on a session exercise to an explicit value
     * (or null). Persisted to the active session so it survives pause/resume.
     */
    setExerciseFeel(exerciseIndex, feel) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return;
        exercise.feel = feel === 'good' ? 'good' : null;
        if (this.app.settings?.vibrationAlerts !== false) vibrate(20);
        this.persistActiveWorkout();
        this.rerenderExercise(exerciseIndex);
    }

    /**
     * Item R3-4: toggle the header feel icon good -> none. Preserves the
     * round-1 "change before saving" affordance without an inline prompt row.
     */
    cycleExerciseFeel(exerciseIndex) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return;
        this.setExerciseFeel(exerciseIndex, nextFeel(exercise.feel));
    }

    /**
     * Item R3-4: whether the exercise newly satisfies the all-sets-at-max
     * condition (every target set completed at the max of its rep range).
     * Duration exercises never qualify. Shared by the render path and the
     * commit/resume feel-prompt triggers.
     */
    _exerciseReachesMax(exercise) {
        if (!exercise) return false;
        const exerciseData = this.app.getExerciseById(exercise.exerciseId);
        if (exerciseData && exerciseData.exerciseType === 'duration') return false;
        const progEx = this.programRowFor(exercise);
        const progSets = (progEx?.sets && progEx.sets.length > 0) ? progEx.sets : null;
        const targetSets = Math.max(1, exercise.targetSets || 3);
        return allSetsReachMax(
            exercise.sets,
            targetSets,
            (set, arrIdx) => {
                const slot = set.slot != null ? set.slot : arrIdx;
                return (progSets && slot < progSets.length)
                    ? progSets[slot].repsMax
                    : exercise.targetReps;
            },
        );
    }

    /**
     * Item R3-4: on resume, mark exercises that already satisfy the
     * all-sets-at-max condition as "modal already shown" so the picker does not
     * re-pop for them (it only fires on the commit transition).
     */
    _seedFeelPromptShownFromSession() {
        const exercises = this.currentWorkoutSession?.exercises || [];
        exercises.forEach((exercise, i) => {
            if (this._exerciseReachesMax(exercise)) this._feelPromptShown[i] = true;
        });
    }

    /**
     * Item R3-4: show the feel picker modal for `exerciseIndex` the FIRST time
     * the exercise satisfies the all-sets-at-max condition this session. The
     * modal's green "Felt good" smiley is the only choice: picking it records the
     * feel, closes the modal and collapses the exercise. "Not yet" (and the X)
     * closes without recording (the exercise still auto-collapses because it is
     * complete).
     */
    maybeShowFeelPrompt(exerciseIndex) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return;
        const reaches = this._exerciseReachesMax(exercise);
        if (!shouldShowFeelPrompt(this._feelPromptShown, exerciseIndex, reaches)) return;

        this._feelPromptShown[exerciseIndex] = true;
        this.showFeelPrompt(exerciseIndex);
    }

    /**
     * GT-22: offer the feel marking WITHOUT interrupting the workout.
     *
     * The feature is right and the audit confirmed it works; the problem was
     * the delivery. Reps pre-fill at the TOP of the target range, so simply
     * tapping through a normal session satisfies "every set reached max" on
     * most exercises - it fired after 4 of 8 exercises in one run - and each
     * time it threw a full-screen blocking modal in front of a lifter trying
     * to move to the next machine. A celebration that fires every time is a
     * tap tax.
     *
     * It is now an inline, dismissable prompt attached to the exercise card:
     * same choice, same one-per-exercise-per-session rule, same persistence,
     * but nothing to dismiss before carrying on. Timed exercises are still
     * excluded upstream by `_exerciseReachesMax`.
     */
    showFeelPrompt(exerciseIndex) {
        const host = document.getElementById(`exercise-${exerciseIndex}`);
        if (!host) return;
        // Never stack two prompts on one card.
        host.querySelector('.gt-feel-prompt')?.remove();

        const prompt = document.createElement('div');
        prompt.className = 'gt-feel-prompt';
        prompt.setAttribute('role', 'status');
        // One compact line. The old version explained itself in a sentence and
        // sat in its own green-tinted panel INSIDE an already-green completed
        // card - 109px tall on a phone, for an optional one-tap answer. The
        // question is short enough to be its own explanation, and the dismiss
        // is a worded control rather than a bare X.
        prompt.innerHTML = `
            <span class="gt-feel-prompt-label">
                <i class="fas fa-face-smile" aria-hidden="true"></i> Felt good?
            </span>
            <span class="gt-feel-prompt-actions">
                <button type="button" class="gt-feel-prompt-yes"
                    aria-label="Yes, that felt good - consider more weight next time">Yes</button>
                <button type="button" class="gt-feel-prompt-dismiss"
                    aria-label="Not now, dismiss this question">Not now</button>
            </span>
        `;

        // Directly under the header, OUTSIDE `.exercise-body`: a completed
        // exercise auto-collapses and hides its body, which would have made
        // the prompt invisible exactly when it fires.
        const body = host.querySelector('.exercise-body');
        if (body) host.insertBefore(prompt, body);
        else host.appendChild(prompt);

        const remove = () => { if (prompt.isConnected) prompt.remove(); };
        prompt.querySelector('.gt-feel-prompt-yes')?.addEventListener('click', () => {
            remove();
            this.setExerciseFeel(exerciseIndex, 'good');
        });
        prompt.querySelector('.gt-feel-prompt-dismiss')?.addEventListener('click', remove);
        // Self-clears if ignored, so it can never accumulate down the screen.
        setTimeout(remove, 12000);
    }

    /**
     * GT-13: the PROGRAM row a session exercise came from.
     *
     * Joining on `exercise.exerciseId` broke the moment a lifter swapped an
     * exercise: the substitute's id is not in the program, the lookup
     * returned undefined, and the header silently lost its rep-target label
     * (and its per-slot rep ranges and rest values with it) while the plan
     * data underneath was perfectly intact. `plannedExerciseId` keeps
     * pointing at the planned slot, so the guidance survives the swap.
     *
     * sameId, not ===: program rows and session rows can disagree on whether
     * an id is a number or a string after an import round trip.
     */
    programRowFor(exercise) {
        if (!exercise) return null;
        const program = this.app.getProgramById(this.currentWorkoutSession?.programId);
        if (!program) return null;
        const plannedId = exercise.plannedExerciseId != null
            ? exercise.plannedExerciseId
            : exercise.exerciseId;
        return program.exercises.find(e => sameId(e.exerciseId, plannedId))
            || program.exercises.find(e => sameId(e.exerciseId, exercise.exerciseId))
            || null;
    }

    /** True when the catalog marks this exercise as duration-based. */
    isDurationExercise(exerciseId) {
        return this.app.getExerciseById(exerciseId)?.exerciseType === 'duration';
    }

    /**
     * GT-12: the planned hold for one slot of a timed exercise, in seconds.
     * Legacy program rows carry only the meaningless repsMin/repsMax pair, so
     * they fall back to the shipped default rather than advertising "10 reps"
     * as a plank target.
     */
    plannedSecondsFor(progSets, slot) {
        const row = progSets && slot < progSets.length ? progSets[slot] : null;
        const seconds = Number(row?.targetSeconds);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TARGET_SECONDS;
    }

    /** Format a rep range for display: "8 reps" or "8-10 reps". */
    formatRepRange(repsMin, repsMax) {
        if (repsMin === repsMax) return `${repsMin} reps`;
        return `${repsMin}-${repsMax} reps`;
    }

    /**
     * Compute the per-side plate breakdown text for a given weight using
     * the user's plate-calculator settings. Returns '' (suppress) when
     * either the weight is empty or the user hasn't configured plates.
     */
    renderPlateHint(weight, unit, usesBarWeight = true, exerciseId = undefined) {
        // Plate config is per UNIT (a rack holds 20 kg plates or 45 lb ones,
        // never both), and the bar can be overridden per exercise so an EZ-bar
        // curl is not computed against the olympic bar (GT-40).
        const profile = this.sessionPlateConfig();
        const bar = usesBarWeight ? Number(this.sessionBarWeight(exerciseId)) : 0;
        const plates = Array.isArray(profile?.plates) ? profile.plates : [];
        if (usesBarWeight && !Number.isFinite(bar)) return '';
        if (plates.length === 0) return '';
        // The "Plates per side:" wording is wrapped in .plate-hint-label-text
        // so the mobile media query can hide it; the dumbbell icon alone
        // carries the meaning on small screens.
        if (weight === '' || weight === null || weight === undefined) {
            return `<span class="plate-hint-label"><i class="fas fa-dumbbell" aria-hidden="true"></i><span class="plate-hint-label-text"> Plates per side: </span><em>—</em></span>`;
        }
        const result = calculatePlates(Number(weight), bar, plates);
        const text = formatPlateStack(result, unit);
        return `<span class="plate-hint-label"><i class="fas fa-dumbbell" aria-hidden="true"></i><span class="plate-hint-label-text"> Plates per side: </span><em>${escapeHtml(text)}</em></span>`;
    }

    /**
     * Live-update the plate hint underneath a planned weight input as the
     * user types. Wired in `wireWorkoutActions`.
     */
    refreshPlateHint(exerciseIndex, slot, weight) {
        const hintEl = document.getElementById(`plate-hint-${exerciseIndex}-${slot}`);
        if (!hintEl) return;
        // The session's own unit, with its own plate profile - hints stay
        // correct even when the workout is entered in the non-default unit
        // (they used to be suppressed entirely in that case).
        const unit = this.sessionUnit();
        const sessionExercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        const exerciseId = sessionExercise?.exerciseId;
        const globalHintsOn = this.app.settings?.plateHintsEnabled !== false;
        const perExHintsVal = exerciseId !== undefined
            ? this.app.settings?.exercisePlateHints?.[exerciseId]
            : undefined;
        const hintsOn = globalHintsOn && (perExHintsVal !== undefined ? perExHintsVal : true);
        if (!hintsOn) return;
        const exerciseData = exerciseId !== undefined ? this.app.getExerciseById(exerciseId) : null;
        const equipment = exerciseData?.equipment || '';
        const usesBarWeight = equipment === 'barbell' || equipment === 'trap-bar';
        const html = this.renderPlateHint(weight, unit, usesBarWeight, exerciseId);
        if (html) hintEl.innerHTML = html;
        this.dedupePlateHints(exerciseIndex);
    }

    /**
     * Polish pass: an identical "Plates per side" breakdown repeated under
     * every set is pure vertical cost - three sets at the same weight said the
     * same thing three times. Hide a hint that matches the row above it and
     * show it again the moment that row's weight diverges. The element always
     * exists (refreshPlateHint needs a target); only its visibility changes,
     * so no information is lost - the first row of every distinct load keeps
     * its breakdown.
     */
    dedupePlateHints(exerciseIndex) {
        const list = document.getElementById(`set-row-list-${exerciseIndex}`);
        if (!list) return;
        let previous = null;
        list.querySelectorAll(':scope > li').forEach(row => {
            const hint = row.querySelector('.plate-hint');
            if (!hint) {
                // A logged set breaks the run: the next planned row is no
                // longer visually adjacent, so it earns its own breakdown.
                previous = null;
                return;
            }
            // An empty weight has nothing to break down; renderPlateHint
            // returns a bare em dash, which reads as debris under the field.
            const weightInput = row.querySelector('input.set-weight');
            const blank = !weightInput || weightInput.value === '';
            hint.classList.toggle('plate-hint--empty', blank);

            const text = hint.textContent.trim();
            const isDup = !blank && previous !== null && text === previous;
            hint.classList.toggle('plate-hint--dup', isDup);
            previous = blank ? null : text;
        });
    }

    /**
     * Mark one freshly-committed row so the completion pulse plays for it and
     * nothing else. The class is removed when the animation ends, so a later
     * re-render of the same exercise renders the row in its calm resting
     * state rather than replaying the celebration.
     */
    flashJustLoggedRow(exerciseIndex, slot) {
        const list = document.getElementById(`set-row-list-${exerciseIndex}`);
        const row = list?.querySelector(`.set-row-complete[data-slot="${slot}"]`);
        if (!row) return;
        row.classList.add('set-row--just-logged');
        row.addEventListener(
            'animationend',
            () => row.classList.remove('set-row--just-logged'),
            { once: true },
        );
    }

    /**
     * Item 6: warm-up configuration, read fresh so a change in Settings applies
     * on the next render without a reload. Missing/partial JSON falls back to
     * the documented defaults.
     */
    _warmupSettings() {
        return normalizeWarmupSettings(storageService.get(WARMUP_SETTINGS_KEY));
    }

    /**
     * Snap a session-unit target to a weight the user's plates can actually
     * make, using the equipment profile for THAT unit. Without a plate
     * config, fall back to the nearest 0.5.
     */
    _loadableWeight(sessionWeight, exerciseId = undefined) {
        const profile = this.sessionPlateConfig();
        const bar = Number(this.sessionBarWeight(exerciseId));
        const plates = Array.isArray(profile?.plates) ? profile.plates : [];
        if (!Number.isFinite(bar) || plates.length === 0) {
            return Math.round(Number(sessionWeight) * 2) / 2;
        }
        // The profile is already in the session unit, so the whole
        // calculation stays there - no conversion round trip to lose
        // precision in.
        return calculatePlates(Number(sessionWeight), bar, plates).achievable;
    }

    /**
     * Item 6: the collapsed warm-up ramp shown above set 1 for heavy barbell
     * work. Warm-up rows are display-only: ticking one never creates a Set, so
     * they cannot touch exercise completion, volume or PR checks.
     */
    renderWarmupStrip(exerciseIndex, { equipment, isDuration, unit, workingWeight, exerciseId }) {
        const settings = this._warmupSettings();
        if (!shouldShowWarmup({ settings, unit, equipment, isDuration, workingWeight })) return '';

        const barWeight = Number(this.sessionBarWeight(exerciseId)) || 0;
        const ramp = buildWarmupRamp({
            settings,
            workingWeight,
            barWeight,
            roundWeight: (w) => this._loadableWeight(w, exerciseId),
        });
        if (ramp.length === 0) return '';

        const expanded = !!this.warmupExpanded[exerciseIndex];
        const doneCount = ramp.reduce(
            (n, _row, i) => n + (this.warmupDone[`${exerciseIndex}:${i}`] ? 1 : 0), 0,
        );

        const rowsHTML = ramp.map((row, i) => {
            const done = !!this.warmupDone[`${exerciseIndex}:${i}`];
            const label = row.isBar ? 'Bar' : `${row.pct}%`;
            // buildWarmupRamp is fed a display-unit workingWeight (and a
            // display-unit bar), so every ramp load is already in `unit`.
            const loadShown = row.weight;
            return `
                <li class="gt-warmup-row${done ? ' gt-warmup-row--done' : ''}">
                    <span class="gt-warmup-pct">${label}</span>
                    <span class="gt-warmup-load">${loadShown}${unit} × ${row.reps}</span>
                    <button type="button" class="gt-warmup-done"
                        data-action="toggle-warmup-set"
                        data-exercise-index="${exerciseIndex}" data-warmup-index="${i}"
                        aria-pressed="${done ? 'true' : 'false'}"
                        aria-label="${done ? 'Undo' : 'Mark'} warm-up set ${label} done">
                        <i class="fas fa-check" aria-hidden="true"></i><span>Done</span>
                    </button>
                </li>
            `;
        }).join('');

        return `
            <div class="gt-warmup${expanded ? ' gt-warmup--open' : ''}" id="warmup-${exerciseIndex}">
                <button type="button" class="gt-warmup-toggle"
                    data-action="toggle-warmup" data-exercise-index="${exerciseIndex}"
                    aria-expanded="${expanded ? 'true' : 'false'}"
                    aria-controls="warmup-list-${exerciseIndex}">
                    <i class="fas fa-fire-flame-curved" aria-hidden="true"></i>
                    <span class="gt-warmup-title">Warm-up</span>
                    <span class="gt-warmup-count" id="warmup-count-${exerciseIndex}">${doneCount}/${ramp.length}</span>
                    <i class="fas fa-chevron-${expanded ? 'up' : 'down'} gt-warmup-chevron" aria-hidden="true"></i>
                </button>
                <ol class="gt-warmup-list" id="warmup-list-${exerciseIndex}"${expanded ? '' : ' hidden'}>
                    ${rowsHTML}
                </ol>
            </div>
        `;
    }

    /** Item 6: expand/collapse the warm-up ramp for one exercise. */
    toggleWarmup(exerciseIndex) {
        const open = !this.warmupExpanded[exerciseIndex];
        this.warmupExpanded[exerciseIndex] = open;
        const strip = document.getElementById(`warmup-${exerciseIndex}`);
        const list = document.getElementById(`warmup-list-${exerciseIndex}`);
        if (!strip || !list) return;
        strip.classList.toggle('gt-warmup--open', open);
        list.hidden = !open;
        const toggle = strip.querySelector('.gt-warmup-toggle');
        toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
        const chevron = strip.querySelector('.gt-warmup-chevron');
        chevron?.classList.toggle('fa-chevron-up', open);
        chevron?.classList.toggle('fa-chevron-down', !open);
    }

    /**
     * Item 6: tick a warm-up ramp row off. State lives on the view only - no
     * Set is created, so nothing here reaches the session's totals.
     */
    toggleWarmupSet(exerciseIndex, rampIndex) {
        const key = `${exerciseIndex}:${rampIndex}`;
        const done = !this.warmupDone[key];
        this.warmupDone[key] = done;
        if (this.app.settings?.vibrationAlerts !== false) vibrate(15);

        const strip = document.getElementById(`warmup-${exerciseIndex}`);
        if (!strip) return;
        const btn = strip.querySelector(`.gt-warmup-done[data-warmup-index="${rampIndex}"]`);
        btn?.setAttribute('aria-pressed', done ? 'true' : 'false');
        btn?.closest('.gt-warmup-row')?.classList.toggle('gt-warmup-row--done', done);

        const rows = strip.querySelectorAll('.gt-warmup-row');
        const doneCount = strip.querySelectorAll('.gt-warmup-row--done').length;
        const count = document.getElementById(`warmup-count-${exerciseIndex}`);
        if (count) count.textContent = `${doneCount}/${rows.length}`;
    }

    /**
     * Shared pill-toggle markup used for both the "not yet completed" state
     * (knob-left, muted pill) and the "completed" state (knob-right, green
     * gradient pill with a crisp check inside the knob). CSS drives the
     * visuals from `aria-pressed` so the DOM stays identical between states.
     */
    renderSetToggle(pressed, action, exerciseIndex, slot, ariaLabel) {
        return `
            <button type="button" class="set-toggle"
                aria-pressed="${pressed ? 'true' : 'false'}"
                aria-label="${ariaLabel}"
                data-action="${action}"
                data-exercise-index="${exerciseIndex}"
                data-slot="${slot}">
                <span class="set-toggle-knob" aria-hidden="true">
                    <i class="fas fa-check"></i>
                </span>
            </button>
        `;
    }

    /**
     * A committed set — shown locked with edit/delete controls and a filled check.
     */
    renderCompletedRow(set, exerciseIndex, slot, isDuration, unit) {
        const setLabel = `${slot + 1}`;
        let details;
        if (set.duration > 0) {
            const mins = Math.floor(set.duration / 60);
            const secs = set.duration % 60;
            details = `<span class="duration-value">${mins}:${secs.toString().padStart(2, '0')}</span>`;
        } else {
            // set.weight is canonical kilograms; display in the session unit.
            const shown = Number(this.toSessionWeight(set.weight));
            details = `${shown.toLocaleString()}${unit} × ${set.reps}`;
        }

        const toggle = this.renderSetToggle(true, 'unmark-set', exerciseIndex, slot, 'Unmark set');

        const pr = this.sessionPrSlots?.[`${exerciseIndex}:${slot}`];
        const prBadge = pr
            ? `<span class="pr-badge" tabindex="0" title="${escapeHtml(PR_RULE_HELP)}" aria-label="${escapeHtml(this.prDeltaAriaLabel(pr, unit))}. ${escapeHtml(PR_RULE_HELP)}"><i class="fas fa-trophy" aria-hidden="true"></i> PR ${escapeHtml(this.formatPrDelta(pr, unit))}</span>`
            : '';
        return `
            <li class="set-row set-row-complete${pr ? ' set-row--pr' : ''}" data-slot="${slot}">
                <span class="set-row-num">${setLabel}</span>
                <div class="set-row-details">${details}${prBadge}</div>
                <div class="set-row-actions">
                    <button type="button" class="btn-set-action" title="Edit set" aria-label="Edit set"
                        data-action="edit-set" data-exercise-index="${exerciseIndex}" data-slot="${slot}">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button type="button" class="btn-set-action btn-set-delete" title="Delete set" aria-label="Delete set"
                        data-action="delete-set" data-exercise-index="${exerciseIndex}" data-slot="${slot}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
                ${toggle}
            </li>
        `;
    }

    /**
     * Add an extra planned row beyond the program's target. Useful when a user
     * wants to do a drop set or extra backoff set. The new row pulls defaults
     * from the matching prior-session set (if any) or the last completed set.
     */
    addPlannedRow(exerciseIndex) {
        if (!this.currentWorkoutSession) return;
        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        if (!exercise) return;
        exercise.targetSets = Math.max(exercise.targetSets || 0, exercise.sets.length) + 1;
        this.persistActiveWorkout();
        this.rerenderExercise(exerciseIndex);
    }

    /**
     * Remove the last planned (uncommitted) set row for this exercise. Committed
     * sets are never touched — users delete those via the row's trash button.
     * Floors at max(1, sets.length) so we never drop below what's logged and
     * never leave the exercise with zero visible slots.
     */
    removePlannedRow(exerciseIndex) {
        if (!this.currentWorkoutSession) return;
        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        if (!exercise) return;
        // Floor on the highest committed slot + 1 (or 1 if nothing committed),
        // not on array length — a committed set in slot 4 with slot 0–3 still
        // empty should still prevent shrinking below 5 visible rows.
        const maxSlot = exercise.sets.reduce((m, s, i) => {
            const slot = s.slot != null ? s.slot : i;
            return slot > m ? slot : m;
        }, -1);
        const floor = Math.max(1, maxSlot + 1);
        if ((exercise.targetSets || 0) <= floor) return;
        exercise.targetSets -= 1;
        this.persistActiveWorkout();
        this.rerenderExercise(exerciseIndex);
    }

    /** Feature 3: toggle collapse state for a single exercise block. */
    toggleExerciseCollapse(exerciseIndex) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return;
        const targetSets = Math.max(1, exercise.targetSets || 3);
        const isComplete = exercise.sets.length >= targetSets && targetSets > 0;
        // Compute the current effective collapsed state (mirrors renderExerciseEntry).
        const currentlyCollapsed = isComplete
            ? (this.collapsedExercises[exerciseIndex] !== false)
            : !!this.collapsedExercises[exerciseIndex];
        if (!currentlyCollapsed) {
            // Collapsing: always store true.
            this.collapsedExercises[exerciseIndex] = true;
        } else {
            // Expanding: only set the sticky-suppress false when the exercise IS
            // complete (meaning the user opened it after an auto-collapse). When the
            // exercise is INCOMPLETE, false and undefined are equivalent for rendering
            // purposes, but a stored false would incorrectly suppress the NEXT
            // auto-collapse. Use delete (undefined) for incomplete exercises so the
            // suppress flag is not set prematurely.
            // Invariant: collapsedExercises[i] === false means "user explicitly
            // expanded a complete exercise; do NOT auto-collapse on the next re-complete."
            // It must only be set while the exercise is currently complete.
            if (isComplete) {
                this.collapsedExercises[exerciseIndex] = false;
            } else {
                delete this.collapsedExercises[exerciseIndex];
            }
        }
        this.rerenderExercise(exerciseIndex);
    }

    /**
     * Feature 5: expand/collapse the per-exercise notes textarea WITHOUT
     * re-rendering the exercise, so typed-but-unsaved keystrokes are never
     * lost (the value is also persisted on every input). Expanding focuses the
     * textarea and arms a one-shot outside-tap listener that collapses it.
     */
    toggleExerciseNotes(exerciseIndex) {
        const region = document.getElementById(`exercise-notes-${exerciseIndex}`);
        const btn = document.querySelector(`.gt-notes-toggle[data-exercise-index="${exerciseIndex}"]`);
        if (!region) return;
        const willOpen = region.hidden;
        region.hidden = !willOpen;
        if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (btn) btn.classList.toggle('gt-notes-toggle--open', willOpen);

        if (willOpen) {
            const textarea = region.querySelector('.gt-exercise-notes-input');
            // preventScroll: focusing must not jump/scroll the page (avoids the
            // flicker); the only effect of tapping the pencil is the note opening.
            if (textarea) textarea.focus({ preventScroll: true });
            // Tap outside the open notes region (and not the toggle) collapses it.
            const onOutside = (e) => {
                if (region.contains(e.target) || (btn && btn.contains(e.target))) return;
                this._collapseExerciseNotes(exerciseIndex);
                document.removeEventListener('pointerdown', onOutside, true);
            };
            this._notesOutsideHandlers = this._notesOutsideHandlers || {};
            this._notesOutsideHandlers[exerciseIndex] = onOutside;
            document.addEventListener('pointerdown', onOutside, true);
        } else {
            this._removeNotesOutsideHandler(exerciseIndex);
        }
    }

    /** Feature 5: collapse the notes region for an exercise (text preserved). */
    _collapseExerciseNotes(exerciseIndex) {
        // Whatever the debounce still owes storage, pay it now.
        this.flushPendingPersist();
        const region = document.getElementById(`exercise-notes-${exerciseIndex}`);
        const btn = document.querySelector(`.gt-notes-toggle[data-exercise-index="${exerciseIndex}"]`);
        if (region) region.hidden = true;
        if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            btn.classList.remove('gt-notes-toggle--open');
        }
        this._removeNotesOutsideHandler(exerciseIndex);
    }

    _removeNotesOutsideHandler(exerciseIndex) {
        const handler = this._notesOutsideHandlers?.[exerciseIndex];
        if (handler) {
            document.removeEventListener('pointerdown', handler, true);
            delete this._notesOutsideHandlers[exerciseIndex];
        }
    }

    /**
     * GT-40: show/hide the per-exercise bar-weight editor. Same pattern as the
     * notes region - an inline panel toggled in place, never a re-render, so
     * a half-typed number is not thrown away.
     */
    toggleBarConfig(exerciseIndex) {
        const region = document.getElementById(`bar-config-${exerciseIndex}`);
        const btn = document.querySelector(`.gt-bar-chip[data-exercise-index="${exerciseIndex}"]`);
        if (!region) return;
        const willOpen = region.hidden;
        region.hidden = !willOpen;
        btn?.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) region.querySelector('.gt-bar-config-input')?.focus({ preventScroll: true });
    }

    /**
     * Set (or, with an empty value, clear) the bar/base weight override for
     * one exercise, in the SESSION's unit - the same unit its plate profile
     * is in, so nothing is converted. Persisted to settings, keyed by stable
     * exercise id, so it applies to every future workout too.
     */
    setExerciseBarWeight(exerciseIndex, value, { rerender = true } = {}) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        const settings = this.app.settings;
        if (!exercise || typeof settings?.setBarWeightForExercise !== 'function') return;

        settings.setBarWeightForExercise(exercise.exerciseId, value, this.sessionUnit());
        this.app.saveSettings();

        if (rerender) {
            this.rerenderExercise(exerciseIndex);
            return;
        }
        // Live path: re-solve the visible plate hints without rebuilding the
        // card (which would blur the input mid-keystroke).
        document.querySelectorAll(`#exercise-${exerciseIndex} .set-row-planned`).forEach((row) => {
            const slot = Number(row.dataset.slot);
            const input = row.querySelector('.set-weight');
            if (input) this.refreshPlateHint(exerciseIndex, slot, input.value);
        });
        const chip = document.querySelector(`.gt-bar-chip[data-exercise-index="${exerciseIndex}"] .gt-bar-chip-text`);
        if (chip) {
            chip.textContent = `${this.sessionBarWeight(exercise.exerciseId)}${this.sessionUnit()}`;
        }
    }

    /** Toggle per-exercise plate hints for the exercise at `exerciseIndex`.
     *  Only reachable when global hints are ON (button is hidden otherwise). */
    toggleExercisePlateHints(exerciseIndex) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return;
        const exerciseId = exercise.exerciseId;
        const perExHintsVal = this.app.settings?.exercisePlateHints?.[exerciseId];
        const currentHints = perExHintsVal !== undefined ? perExHintsVal : true;
        if (!this.app.settings.exercisePlateHints) this.app.settings.exercisePlateHints = {};
        this.app.settings.exercisePlateHints[exerciseId] = !currentHints;
        this.app.saveSettings();
        this.rerenderExercise(exerciseIndex);
    }

    /**
     * Toggle plate-calculator hints on/off for the current session.
     * The new state is persisted immediately so it becomes the default for
     * future workouts (saved on toggle, not just on finish).
     */
    togglePlateHints() {
        this.app.settings.plateHintsEnabled = !this.app.settings.plateHintsEnabled;
        this.app.saveSettings();
        this.syncPlateHintsButton();
        this.renderActiveWorkout();
    }

    /** Keep the plate-hints toggle button in sync with the current setting. */
    syncPlateHintsButton() {
        const btn = document.getElementById('plate-hints-toggle-btn');
        if (!btn) return;
        const enabled = this.app.settings.plateHintsEnabled !== false;
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        btn.classList.toggle('btn-icon-plates--off', !enabled);
        const state = btn.querySelector('.gt-overflow-state');
        if (state) state.textContent = enabled ? 'On' : 'Off';
    }

    /** Re-render just the given exercise block without touching the others. */
    rerenderExercise(exerciseIndex) {
        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const host = document.getElementById(`exercise-${exerciseIndex}`);
        if (!exercise || !host) {
            this.renderActiveWorkout();
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.innerHTML = this.renderExerciseEntry(exercise, exerciseIndex);
        const fresh = wrapper.firstElementChild;
        if (fresh && host.parentNode) host.parentNode.replaceChild(fresh, host);
        this.dedupePlateHints(exerciseIndex);
    }

    /**
     * Item 3: open the in-workout exercise picker for one slot of the CURRENT
     * session. Pre-filtered to the original exercise's category, which is where
     * a like-for-like substitute (busy rack, tweaked shoulder) will be.
     */
    openSwapPicker(exerciseIndex) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        const modal = document.getElementById('swap-exercise-modal');
        if (!exercise || !modal) return;

        this.swapTargetIndex = exerciseIndex;
        const current = this.app.getExerciseById(exercise.exerciseId);

        const currentEl = document.getElementById('swap-exercise-current');
        if (currentEl) currentEl.textContent = this.app.getExerciseDisplayName(exercise.exerciseId, exercise.exerciseName);

        const search = document.getElementById('swap-exercise-search');
        const category = document.getElementById('swap-exercise-category-filter');
        const equipment = document.getElementById('swap-exercise-equipment-filter');
        // GT-26: same taxonomy as every other exercise surface, so a category
        // can never exist in the database and be missing from this filter.
        populateSelect(category, EXERCISE_CATEGORIES, 'All Categories');
        populateSelect(equipment, EXERCISE_EQUIPMENT, 'All Equipment');

        if (search) search.value = '';
        if (category) category.value = current?.category || '';
        if (equipment) equipment.value = '';

        if (!modal.dataset.wired) {
            const rerender = () => this.renderSwapPicker();
            search?.addEventListener('input', rerender);
            category?.addEventListener('change', rerender);
            equipment?.addEventListener('change', rerender);
            modal.dataset.wired = '1';
        }

        this.renderSwapPicker();
        modal.classList.add('active');
        trapModalFocus(modal);
    }

    /** Item 3: render the swap picker list from the current search/filters. */
    renderSwapPicker() {
        const container = document.getElementById('swap-exercise-list');
        if (!container) return;
        const searchTerm = document.getElementById('swap-exercise-search')?.value || '';
        const category = document.getElementById('swap-exercise-category-filter')?.value || '';
        const equipment = document.getElementById('swap-exercise-equipment-filter')?.value || '';
        const currentId = this.currentWorkoutSession?.exercises[this.swapTargetIndex]?.exerciseId;

        // Same relevance rules as the Exercise Database and the program
        // picker (GT-24), so "pull up" finds Pull-Ups here too.
        const pool = this.app.exerciseDatabase.filter(ex => {
            if (sameId(ex.id, currentId)) return false;
            if (category && ex.category !== category) return false;
            if (equipment && ex.equipment !== equipment) return false;
            return true;
        });
        const exercises = searchTerm
            ? searchExercises(pool, searchTerm)
            : pool.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));

        if (exercises.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No exercises found</p></div>';
            return;
        }

        container.innerHTML = exercises.map(exercise => `
            <div class="exercise-picker-card" role="button" tabindex="0"
                 data-action="pick-swap-exercise" data-exercise-id="${escapeHtml(String(exercise.id))}">
                <h4>${escapeHtml(exercise.name)}${exercise.isCustom ? ' <span class="badge badge-custom">Custom</span>' : ''}</h4>
                <div class="exercise-meta">
                    <span class="badge">${escapeHtml(exercise.category)}</span>
                    <span class="badge">${escapeHtml(exercise.equipment)}</span>
                </div>
                <p>${escapeHtml(exercise.muscleGroup)}</p>
            </div>
        `).join('');
    }

    /**
     * Item 3: replace the exercise in THIS session only. The saved Program is
     * never touched - the swap lives on currentWorkoutSession.exercises[i], so
     * history shows the substitute and its sets count toward the substitute's
     * own PRs (the session PR map is recomputed against the new exercise id).
     */
    async pickSwapExercise(exerciseId) {
        const index = this.swapTargetIndex;
        const exercise = this.currentWorkoutSession?.exercises[index];
        const replacement = this.app.exerciseDatabase.find(e => sameId(e.id, exerciseId));
        if (!exercise || !replacement) return;

        const loggedSets = exercise.sets.length;
        if (loggedSets > 0) {
            const confirmed = await showConfirmModal({
                title: 'Swap exercise?',
                message: `${loggedSets} logged set${loggedSets === 1 ? '' : 's'} will move under ${replacement.name}.`,
                warning: 'Your saved program is not changed - this swap applies to this workout only.',
                confirmText: 'Swap',
                isDangerous: false,
            });
            if (!confirmed) return;
        }

        // plannedExerciseId is deliberately NOT touched: the substitute owns
        // the sets, the history and the PRs, but the PLAN row it stands in for
        // still owns the rep target, the rep ranges and the rest values.
        exercise.exerciseId = replacement.id;
        exercise.exerciseName = replacement.name;
        // Sticky values are the OLD exercise's numbers; they would prefill the
        // substitute with weights that never belonged to it.
        exercise.stickyValues = {};
        // Same for the warm-up ramp: it was sized off the old lift.
        this.warmupExpanded[index] = false;
        Object.keys(this.warmupDone)
            .filter(key => key.startsWith(`${index}:`))
            .forEach(key => delete this.warmupDone[key]);

        document.getElementById('swap-exercise-modal')?.classList.remove('active');
        this.swapTargetIndex = null;

        // PR badges were resolved against the old exercise's history.
        this.rebuildSessionPrSlots();
        this.persistActiveWorkout();
        this.renderActiveWorkout();
        showToast(`Swapped to ${replacement.name}`, 'success');
    }

    getPreviousExerciseData(exerciseId) {
        // Sort by full timestamp (not just calendar date) so that two workouts
        // on the same day order by time-of-day — a 6 PM session supersedes a
        // 9 AM session when computing "Last Time" for the same exercise.
        const sortedSessions = [...this.app.workoutSessions].sort((a, b) =>
            new Date(b.sortTimestamp) - new Date(a.sortTimestamp)
        );

        // Collect the two most recent sessions that have this exercise with completed sets
        const recentSessions = [];
        for (const session of sortedSessions) {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    recentSessions.push({ session, exercise, completedSets });
                    if (recentSessions.length === 2) break;
                }
            }
        }

        if (recentSessions.length === 0) return null;

        const { session: lastSession, exercise: lastExercise, completedSets: lastSets } = recentSessions[0];
        const prev = recentSessions[1] || null;

        // The prefill is the lifter's OWN last session, set for set. The app
        // does not decide what they should lift: an automatic next-weight
        // recommendation used to sit here, and besides being unwanted it added
        // a display-unit increment to a canonical-kg weight, so a 60 lb bench
        // came back as 71 lb ("+11lb suggested" = 5 read as 5 kg).
        const sets = lastSets.map(set => ({
            weight: set.weight,
            reps: set.reps,
            duration: set.duration,
            originalWeight: set.weight,
        }));

        return sets;
    }


    /**
     * Return the progressive-overload increment for an exercise.
     * Lower-body compound movements get a larger step.
     */
    /**
     * How much one tap of the +/- stepper moves the weight input.
     *
     * Purely a manual convenience: it is applied to the DISPLAY-unit value in
     * the input, in that same unit, so 5 means 5 lb on an lb account. The
     * removed auto-progression passed this same number into canonical-kg
     * arithmetic, which is how 60 lb became 71 lb.
     */
    _stepIncrement(exerciseId, unit) {
        const exerciseData = this.app.getExerciseById(exerciseId);
        const name = (exerciseData?.name || '').toLowerCase();
        const isLower = /squat|deadlift|leg press|lunge/.test(name);
        if (unit === 'lb') return isLower ? 10 : 5;
        return isLower ? 5 : 2.5;
    }

    /**
     * Commit a planned set row: read inputs, push a new Set into the exercise,
     * then start the rest timer and re-render only this exercise.
     *
     * The rest timer is THE feature that makes a gym tracker useful mid-workout.
     * The equipment-based default lives on the program entry; if a user hasn't
     * customized it, we fall back to 90s.
     */
    commitPlannedSet(exerciseIndex, slot) {
        if (!this.currentWorkoutSession) return;

        // Dismiss the mobile keyboard so the rest bar doesn't get covered.
        if (document.activeElement instanceof HTMLElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        if (!exercise) return;
        const host = document.getElementById(`exercise-${exerciseIndex}`);
        const isDuration = host?.getAttribute('data-exercise-type') === 'duration';

        let set;
        if (isDuration) {
            const minInput = document.getElementById(`duration-min-${exerciseIndex}-${slot}`);
            const secInput = document.getElementById(`duration-sec-${exerciseIndex}-${slot}`);
            const minutes = parseInt(minInput?.value, 10) || 0;
            const seconds = parseInt(secInput?.value, 10) || 0;
            const totalSeconds = (minutes * 60) + seconds;
            if (totalSeconds === 0) {
                showToast('Please enter a duration', 'error');
                return;
            }
            set = new Set({ duration: totalSeconds, weight: 0, reps: 0, completed: true, slot });
        } else {
            const weightInput = document.getElementById(`weight-${exerciseIndex}-${slot}`);
            const repsInput = document.getElementById(`reps-${exerciseIndex}-${slot}`);
            const parsed = parseSetEntry(weightInput?.value, repsInput?.value);
            if (!parsed.ok) {
                this.showSetRowError(exerciseIndex, slot, parsed, { weightInput, repsInput });
                return;
            }
            this.clearSetRowError(exerciseIndex, slot);
            // The input is in the session unit; storage is canonical kg.
            const weight = this.toStoredWeight(parsed.weight);
            set = new Set({ weight, reps: parsed.reps, completed: true, slot });
        }

        // Append to the dense array — visual position is driven by `set.slot`,
        // not by array index, so order-of-insertion doesn't matter.
        exercise.sets.push(set);

        // Item R2-8: a logged set dismisses the finish-modal "no sets" message.
        const finishMsg = document.getElementById('finish-inline-message');
        if (finishMsg) finishMsg.hidden = true;

        if (this.app.settings?.vibrationAlerts !== false) vibrate(30);

        // PR check — compare the just-logged set against all prior sets of
        // this exercise: completed sessions PLUS earlier committed sets of the
        // current session, so a repeat at the same new max isn't re-celebrated.
        const priorSessionSets = exercise.sets.filter(s => s !== set);
        const pr = AnalyticsService.isSetPR(exercise.exerciseId, set, this.app.workoutSessions, priorSessionSets);
        if (pr) {
            // Item R2-10: record the PR and supersede any earlier badge for the
            // same exercise this session — only the best set keeps the badge.
            // The toast still fires (live celebration). rerenderExercise below
            // is per-exercise, so an earlier set in the SAME exercise drops its
            // badge on this rerender; cross-exercise badges are untouched.
            recordPrSupersede(this.sessionPrSlots, `${exerciseIndex}:${slot}`, pr);
            this.announcePR(pr);
        }

        // Auto-collapse when all planned sets are done. Keep the in-progress
        // exercises expanded by not touching their collapsedExercises entry.
        const targetSets = Math.max(1, exercise.targetSets || 3);
        const isNowComplete = exercise.sets.length >= targetSets;
        if (isNowComplete) {
            // #23: committing a set is a deliberate action, so re-arm auto-collapse
            // even if the user had manually expanded a previously-complete exercise
            // (collapsedExercises[i] === false). The manual-expand suppression is
            // only meant to survive passive re-renders, not a fresh set commit.
            this.collapsedExercises[exerciseIndex] = true;
        }
        // Track complete state for deleteSet's re-trigger logic.
        this._prevCompleteState[exerciseIndex] = isNowComplete;

        // GT-01: a logged set is the highest-value state in the app. Persist
        // before rendering, so even a crash inside the render keeps the set.
        this.persistActiveWorkout();

        this.rerenderExercise(exerciseIndex);
        // The green "just logged" pulse belongs to THIS row only. It used to
        // live on .set-row-complete itself, which meant every already-logged
        // row in the exercise flashed again on every re-render.
        this.flashJustLoggedRow(exerciseIndex, slot);

        // Item R3-4: if this commit just made the exercise satisfy the
        // all-sets-at-max condition, show the feel picker modal (once per
        // exercise per session). Picking collapses the exercise.
        this.maybeShowFeelPrompt(exerciseIndex);

        // Final set of the LAST exercise -> workout complete: no rest of any
        // kind, and jump to the top where the Finish button lives.
        if (isWorkoutComplete(this.currentWorkoutSession?.exercises || [])) {
            this.skipRest();
            this.scrollWorkoutToTop();
            return;
        }

        // Determine rest type: last set of exercise -> between-exercise (bottom bar);
        // any earlier set -> between-set (inline chip only).
        // Superset rule: rest fires only when the round is done.
        if (this.shouldStartRestForSet(exerciseIndex, exercise)) {
            const program = this.app.getProgramById(this.currentWorkoutSession?.programId);
            const isUniform = program?.restMode === 'uniform';
            const progEx = this.programRowFor(exercise);

            if (isNowComplete) {
                // Between-exercise rest -> bottom bar (program-derived; not adjustable mid-workout)
                const betweenExSecs = isUniform
                    ? (program.uniformRestSeconds ?? 90)
                    : (progEx?.restAfterSeconds ?? exercise.restAfterSeconds ?? 90);
                this.startRest(betweenExSecs, exerciseIndex, 'exercise');
            } else {
                // Between-set rest -> inline chip only
                const betweenSetSecs = progEx?.restSeconds ?? exercise.restSeconds ?? 90;
                this.startRest(betweenSetSecs, exerciseIndex, 'set');
            }
        } else {
            this.skipRest();
        }
    }

    /**
     * Return true when a rest timer should fire after the just-committed
     * set on the given exercise. Always true for solo exercises. For an
     * exercise inside a superset, only true if every other exercise in
     * the same group already has at least as many committed sets — i.e.
     * the round is complete.
     */
    shouldStartRestForSet(exerciseIndex, exercise) {
        if (!exercise.groupId) return true;
        const list = this.currentWorkoutSession?.exercises || [];
        const me = exercise.sets.length;
        for (let i = 0; i < list.length; i++) {
            if (i === exerciseIndex) continue;
            const other = list[i];
            if (!other || other.groupId !== exercise.groupId) continue;
            if ((other.sets?.length || 0) < me) return false;
        }
        return true;
    }

    /** Smooth-scroll the page to the top (workout header / Finish button). */
    scrollWorkoutToTop() {
        if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
        try {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch {
            window.scrollTo(0, 0);
        }
    }

    /** Index of the first incomplete exercise, or -1 if every one is complete. */
    firstIncompleteExerciseIndex() {
        const exercises = this.currentWorkoutSession?.exercises;
        if (!exercises) return -1;
        for (let i = 0; i < exercises.length; i++) {
            const targetSets = Math.max(1, exercises[i].targetSets || 3);
            if ((exercises[i].sets?.length || 0) < targetSets) return i;
        }
        return -1;
    }

    /**
     * Jump to the exercise the user is actually lifting: the first incomplete
     * one (lowest index whose sets < target). Lands the block's top just below
     * the sticky workout header. If the exercise is collapsed, expand it first.
     * If every exercise is complete, fall back to the top (Finish + timer).
     */
    scrollToCurrentExercise() {
        if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
        const index = this.firstIncompleteExerciseIndex();
        if (index < 0) {
            this.scrollWorkoutToTop();
            return;
        }

        // Be safe: an incomplete exercise is normally expanded, but if a stored
        // collapse flag is suppressing its sets, clear it and rerender so the
        // target block is fully visible before we measure and scroll.
        if (this.collapsedExercises[index]) {
            delete this.collapsedExercises[index];
            this.rerenderExercise(index);
        }

        const el = document.getElementById(`exercise-${index}`);
        if (!el) return;

        // The page (window) is the scroll container; the workout header is
        // position: sticky, so its on-screen bottom edge is the floor the
        // target must clear. Use that bottom plus a small gap as the offset.
        const header = document.querySelector('#active-workout .workout-header');
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        const gap = 8;
        const target = el.getBoundingClientRect().top + window.scrollY - headerBottom - gap;
        const top = Math.max(0, target);
        try {
            window.scrollTo({ top, behavior: 'smooth' });
        } catch {
            window.scrollTo(0, top);
        }
    }

    /**
     * Show a celebratory toast for the given PR + play the chime cue.
     * Respects the user's restAlerts preference for audio (always vibrates
     * and always shows the toast — the toast is the actual info).
     */
    announcePR(pr) {
        const unit = this.sessionUnit();
        const label = `🏆 New PR  ${this.formatPrDelta(pr, unit)}`;
        showToast(label, 'success', 4000);
        if (this.app.settings?.vibrationAlerts !== false) vibrate([40, 60, 120]);
        if (this.app.settings?.soundAlerts !== false) playSound('pr');
    }

    /**
     * Format the "+40 lb" / "+0:12" improvement string shown in the toast
     * and the inline PR badge on the completed set row.
     */
    formatPrDelta(pr, unit) {
        if (pr.kind === 'duration') {
            // A longer hold: the delta is seconds and reads as time.
            return `+${formatDuration(pr.delta)}`;
        }
        if (pr.kind === 'weight') {
            // More on the bar than ever before - the delta really is a weight.
            return `+${displayWeight(pr.weightDelta, unit)}${unit}`;
        }
        // Otherwise the record broken is SET VOLUME (weight x reps), and its
        // delta is kg-reps. Rendering it as "+50 kg" read as "you added 50 kg
        // to the bar" when the lifter had added five (GT-18).
        return `+${roundForDisplay(volumeIn(pr.delta, unit), 0)} ${unit}\u00b7reps`;
    }

    /** Spoken form of the PR badge, so the label and the a11y name agree. */
    prDeltaAriaLabel(pr, unit) {
        if (pr.kind === 'duration') return `Personal record, ${formatDuration(pr.delta)} longer`;
        if (pr.kind === 'weight') {
            return `Personal record, ${displayWeight(pr.weightDelta, unit)} ${unit} heavier`;
        }
        return `Personal record, ${roundForDisplay(volumeIn(pr.delta, unit), 0)} ${unit} times reps more set volume`;
    }

    /**
     * Integration 4: format a persisted PR achievement's weight for its toast.
     * prWeightKg is canonical kg; show it in the user's current display unit.
     */
    _formatPrAchievementWeight(pr) {
        const unit = normalizeWeightUnit(this.app.settings.weightUnit);
        return `${displayWeight(pr.prWeightKg, unit)}${unit}`;
    }

    /**
     * Find a committed set in the exercise by its stable slot. Legacy sets
     * (no `slot` field yet) fall back to their array index so sessions
     * saved before this change still behave correctly.
     */
    findSetBySlot(exercise, slot) {
        if (!exercise || !exercise.sets) return null;
        return exercise.sets.find((s, i) => (s.slot != null ? s.slot : i) === slot) || null;
    }

    editSet(exerciseIndex, slot) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const set = this.findSetBySlot(exercise, slot);
        if (!set) return;

        const setRowEl = document.querySelector(`#set-row-list-${exerciseIndex} .set-row[data-slot="${slot}"]`);
        if (!setRowEl) return;

        const isDuration = set.duration > 0;

        let editFormHTML;
        if (isDuration) {
            const mins = Math.floor(set.duration / 60);
            const secs = set.duration % 60;
            editFormHTML = `
                <div class="set-row-inputs">
                    <input type="number" class="set-edit-input duration-edit-min"
                        id="edit-duration-min-${exerciseIndex}-${slot}" value="${mins}" min="0" placeholder="Min" aria-label="Minutes">
                    <span class="duration-separator">:</span>
                    <input type="number" class="set-edit-input duration-edit-sec"
                        id="edit-duration-sec-${exerciseIndex}-${slot}" value="${secs}" min="0" max="59" placeholder="Sec" aria-label="Seconds">
                </div>
            `;
        } else {
            const editWeight = this.toSessionWeight(set.weight);
            editFormHTML = `
                <div class="set-row-inputs">
                    <input type="number" class="set-edit-input"
                        id="edit-weight-${exerciseIndex}-${slot}" value="${editWeight}" step="0.5" min="0" placeholder="Weight" aria-label="Weight">
                    <span class="set-row-x">×</span>
                    <input type="number" class="set-edit-input"
                        id="edit-reps-${exerciseIndex}-${slot}" value="${set.reps}" min="1" placeholder="Reps" aria-label="Reps">
                </div>
            `;
        }

        setRowEl.classList.remove('set-row-complete');
        setRowEl.classList.add('set-row-editing');
        setRowEl.innerHTML = `
            <span class="set-row-num">${slot + 1}</span>
            ${editFormHTML}
            <div class="set-row-actions">
                <button type="button" class="btn-set-action btn-set-save" title="Save" aria-label="Save set"
                    data-action="save-set-edit" data-exercise-index="${exerciseIndex}" data-slot="${slot}">
                    <i class="fas fa-check"></i>
                </button>
                <button type="button" class="btn-set-action btn-set-cancel" title="Cancel" aria-label="Cancel edit"
                    data-action="cancel-set-edit" data-exercise-index="${exerciseIndex}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        // Focus the first input
        const firstInput = setRowEl.querySelector('input');
        if (firstInput) {
            firstInput.focus();
            firstInput.select();
        }
    }

    /**
     * Item R2-4 / #18: after a set is edited or deleted, the per-exercise derived
     * state (auto-collapse, _prevCompleteState, _feelPromptShown) must equal a
     * fresh evaluation — the commit path keeps these in sync, the edit/delete
     * paths historically did not. Mirrors commitPlannedSet's bookkeeping:
     *   - re-evaluate complete/collapse (respecting the user-explicit-expand
     *     invariant collapsedExercises[i] === false, and clearing that
     *     suppression on a complete->incomplete transition so auto-collapse can
     *     fire again);
     *   - clear _feelPromptShown when the exercise no longer reaches max, so
     *     bringing it back to max re-shows the modal (left as-is if it still
     *     reaches max, since the modal already fired).
     * Returns the freshly computed `isNowComplete` so callers can decide whether
     * to (re)trigger the feel modal.
     *
     * `armCollapse` (#23): set true for a DELIBERATE set action (committing a set,
     * saving a set edit). On such actions a now-complete exercise auto-collapses
     * even if the user had manually expanded it (collapsedExercises[i] === false).
     * Passive re-renders / deletes pass false so "opened just to look" stays open.
     */
    _recomputeExerciseDerivedState(exerciseIndex, armCollapse = false) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return false;

        const targetSets = Math.max(1, exercise.targetSets || 3);
        const isNowComplete = exercise.sets.length >= targetSets;
        const wasComplete = this._prevCompleteState[exerciseIndex] === true;

        if (isNowComplete) {
            if (armCollapse || this.collapsedExercises[exerciseIndex] !== false) {
                this.collapsedExercises[exerciseIndex] = true;
            }
        } else if (wasComplete) {
            // complete -> incomplete: clear the manual-expand suppression so the
            // next time it completes, auto-collapse fires again.
            delete this.collapsedExercises[exerciseIndex];
        }
        this._prevCompleteState[exerciseIndex] = isNowComplete;

        if (!this._exerciseReachesMax(exercise)) {
            this._feelPromptShown[exerciseIndex] = false;
        }

        return isNowComplete;
    }

    /**
     * Inline validation state on a set row (commit and edit share it): the
     * row gets `set-row--invalid`, the offending input `aria-invalid` and a
     * live-region message under the inputs. A toast was the previous
     * feedback and it said nothing about WHICH field was wrong.
     */
    showSetRowError(exerciseIndex, slot, parsed, { weightInput, repsInput } = {}) {
        const row = document.querySelector(`#exercise-${exerciseIndex} .set-row[data-slot="${slot}"]`);
        const bad = parsed.field === 'weight' ? weightInput : repsInput;
        const good = parsed.field === 'weight' ? repsInput : weightInput;
        if (bad) bad.setAttribute('aria-invalid', 'true');
        if (good) good.removeAttribute('aria-invalid');
        if (row) {
            row.classList.add('set-row--invalid');
            let msg = row.querySelector('.set-row-error');
            if (!msg) {
                msg = document.createElement('div');
                msg.className = 'set-row-error';
                msg.setAttribute('role', 'alert');
                msg.id = `set-row-error-${exerciseIndex}-${slot}`;
                row.appendChild(msg);
            }
            msg.textContent = parsed.message;
            if (bad) bad.setAttribute('aria-describedby', msg.id);
        }
        if (bad && typeof bad.focus === 'function') bad.focus();
        if (this.app.settings?.vibrationAlerts !== false) vibrate(15);
    }

    clearSetRowError(exerciseIndex, slot) {
        const row = document.querySelector(`#exercise-${exerciseIndex} .set-row[data-slot="${slot}"]`);
        if (!row) return;
        row.classList.remove('set-row--invalid');
        row.querySelectorAll('[aria-invalid]').forEach((el) => {
            el.removeAttribute('aria-invalid');
            el.removeAttribute('aria-describedby');
        });
        const msg = row.querySelector('.set-row-error');
        if (msg) msg.remove();
    }

    saveSetEdit(exerciseIndex, slot) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const set = this.findSetBySlot(exercise, slot);
        if (!set) return;
        const isDuration = set.duration > 0;

        if (isDuration) {
            const minInput = document.getElementById(`edit-duration-min-${exerciseIndex}-${slot}`);
            const secInput = document.getElementById(`edit-duration-sec-${exerciseIndex}-${slot}`);
            const minutes = parseInt(minInput.value, 10) || 0;
            const seconds = parseInt(secInput.value, 10) || 0;
            const totalSeconds = (minutes * 60) + seconds;
            if (totalSeconds === 0) {
                showToast('Please enter a valid duration', 'error');
                return;
            }
            set.duration = totalSeconds;
        } else {
            const weightInput = document.getElementById(`edit-weight-${exerciseIndex}-${slot}`);
            const repsInput = document.getElementById(`edit-reps-${exerciseIndex}-${slot}`);
            const parsed = parseSetEntry(weightInput?.value, repsInput?.value);
            if (!parsed.ok) {
                this.showSetRowError(exerciseIndex, slot, parsed, { weightInput, repsInput });
                return;
            }
            this.clearSetRowError(exerciseIndex, slot);
            // Input is in the session unit; storage is canonical kg.
            set.weight = this.toStoredWeight(parsed.weight);
            set.reps = parsed.reps;
        }

        // Item R3-7: derived PR state must equal a fresh recomputation after
        // any edit. Recompute the whole session PR map from scratch (so editing
        // away a superseding set restores an earlier set's badge), then announce
        // only when THIS slot newly became a PR.
        const prKey = `${exerciseIndex}:${slot}`;
        const hadPr = !!(this.sessionPrSlots && this.sessionPrSlots[prKey]);
        this.rebuildSessionPrSlots();
        const pr = this.sessionPrSlots[prKey];
        if (pr && !hadPr) this.announcePR(pr);

        // #18: keep the per-exercise derived state (collapse / complete /
        // feel-prompt) consistent with the edited reps, then mirror the commit
        // path by (re)showing the feel modal if the edit newly satisfies the
        // all-sets-at-max condition. maybeShowFeelPrompt self-guards via
        // shouldShowFeelPrompt, so it won't double-show or fire when incomplete.
        // #23: a save IS a deliberate set action, so re-arm auto-collapse on a
        // still-complete exercise even if the user had manually expanded it.
        this._recomputeExerciseDerivedState(exerciseIndex, true);

        this.persistActiveWorkout();
        this.rerenderExercise(exerciseIndex);

        this.maybeShowFeelPrompt(exerciseIndex);
    }

    /**
     * Item R2-10 / R3-7: recompute sessionPrSlots from the current session's
     * committed sets, from scratch. Each exercise's sets are evaluated in slot
     * order against completed sessions plus earlier sets of the same exercise,
     * so a later higher set supersedes earlier badges and only the best set per
     * exercise survives. Called on resume and after EVERY set edit/delete so the
     * derived PR state always equals a fresh recomputation.
     */
    rebuildSessionPrSlots() {
        const exercises = this.currentWorkoutSession?.exercises || [];
        this.sessionPrSlots = recomputePrSlots(
            exercises,
            (exerciseId, set, priorSessionSets) =>
                AnalyticsService.isSetPR(exerciseId, set, this.app.workoutSessions, priorSessionSets),
        );
    }

    cancelSetEdit(exerciseIndex) {
        if (!this.currentWorkoutSession) return;
        this.rerenderExercise(exerciseIndex);
    }

    /**
     * Remove a committed set from an exercise. The visible row + knob animation
     * already confirm the action, so no toast fires (Item R2-8). `opts` is kept
     * for caller compatibility (pill-toggle un-check passes { silent: true }).
     */
    deleteSet(exerciseIndex, slot, opts = {}) {
        if (!this.currentWorkoutSession) return;
        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        if (!exercise) return;

        // Find by stable slot (not by array index). Legacy sets without a
        // `slot` field fall back to their array position so old sessions
        // loaded mid-workout still un-toggle correctly.
        const arrIdx = exercise.sets.findIndex((s, i) => {
            const key = s.slot != null ? s.slot : i;
            return key === slot;
        });
        if (arrIdx < 0) return;
        const removed = exercise.sets[arrIdx];

        exercise.sets.splice(arrIdx, 1);

        // Preserve the deleted values on the same slot so the planned row
        // repopulates with what the user just typed — toggle-off → re-check
        // must be non-destructive.
        if (!exercise.stickyValues) exercise.stickyValues = {};
        exercise.stickyValues[slot] = {
            weight: removed.weight,
            reps: removed.reps,
            duration: removed.duration,
        };

        // Item R3-7: recompute the whole session PR map from scratch after the
        // delete. Removing a set that had SUPERSEDED an earlier PR must restore
        // the earlier set's badge, so patching a single slot is not enough.
        this.rebuildSessionPrSlots();

        // #18: keep collapse / complete / feel-prompt derived state consistent
        // with the post-delete sets. This clears the manual-expand suppression on
        // a complete->incomplete transition (so auto-collapse re-fires later) and
        // resets _feelPromptShown when the exercise no longer reaches max (so
        // re-reaching max re-shows the modal).
        this._recomputeExerciseDerivedState(exerciseIndex);

        // Bugs B+C: unmarking a set cancels any active rest timer that was
        // started for this exercise (between-set chip or between-exercise bottom
        // bar). An unmark means the exercise is no longer in the post-set state
        // that triggered the timer, so the rest is no longer meaningful.
        if (this.activeRestExerciseIndex === exerciseIndex && this.activeRestTimerId != null) {
            this.skipRest();
        }

        this.persistActiveWorkout();
        this.rerenderExercise(exerciseIndex);
    }

    updateWorkoutTimer(elapsed) {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('workout-time').textContent =
            `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    // --- Rest timer ---

    /**
     * Start (or restart) the rest timer for `seconds` seconds.
     * `restType` controls where the countdown appears:
     *   'set'      — between-set: inline chip next to rest adjuster only; bar hidden.
     *   'exercise' — between-exercise: bottom bar only; no chip.
     */
    startRest(seconds, exerciseIndex = -1, restType = 'exercise') {
        const duration = Math.max(0, Math.floor(seconds || 0));
        if (duration === 0) return;

        if (this.activeRestTimerId != null) {
            timerService.stopRestTimer(this.activeRestTimerId);
            this.clearRestChip();
        }

        this.restTimerDuration = duration;
        this.activeRestExerciseIndex = exerciseIndex;
        this.lastPingedRestSecond = -1;
        this._activeRestType = restType;

        // The floating dial is the single rest display for BOTH rest types,
        // color-coded by type (green between sets, blue between exercises).
        this.showRestBar(duration, restType);

        this.activeRestTimerId = timerService.startRestTimer(
            duration,
            (remaining) => this.onRestTick(remaining),
            () => this.onRestComplete(),
        );
        this.recordRestState({ endsAt: Date.now() + duration * 1000, exerciseIndex, restType });
        this.keepAddSetClearOfDial(exerciseIndex);
    }

    /**
     * Remember the running countdown on the session (survives a reload and
     * comes back through resumeWorkout). Null clears it.
     */
    recordRestState(state) {
        if (!this.currentWorkoutSession) return;
        this.currentWorkoutSession.restState = state;
        this.persistActiveWorkout();
    }

    /**
     * On a phone the fixed rest dial sits over the bottom of the viewport,
     * which at the natural scroll position after committing set 1 is exactly
     * where the current exercise's "Add set" row lands (2026-08-22 audit
     * D11). The dial's artwork must not move (see FINDINGS), so scroll the
     * row above it instead.
     */
    keepAddSetClearOfDial(exerciseIndex) {
        if (exerciseIndex < 0) return;
        const bar = document.getElementById('rest-timer-bar');
        const footer = document.querySelector(`#exercise-${exerciseIndex} .set-row-footer`);
        if (!bar || !footer || typeof bar.getBoundingClientRect !== 'function') return;
        requestAnimationFrame(() => {
            const dial = bar.getBoundingClientRect();
            const row = footer.getBoundingClientRect();
            if (dial.height === 0 || row.bottom <= dial.top) return;
            // Only when the row is otherwise on screen: a far-away row is a
            // scroll the lifter chose.
            if (row.top >= window.innerHeight) return;
            window.scrollBy({ top: row.bottom - dial.top + 8, behavior: 'smooth' });
        });
    }

    /** Add N seconds to the in-flight rest timer without restarting it. */
    extendRest(seconds) {
        if (this.activeRestTimerId == null) return;
        // The wall-clock-based timer can be extended in place; we just bump
        // the total used as the progress-bar denominator so the fill ratio
        // stays sensible.
        this.restTimerDuration += seconds;
        timerService.extendRestTimer(this.activeRestTimerId, seconds);
        const rs = this.currentWorkoutSession?.restState;
        if (rs && Number.isFinite(rs.endsAt)) this.recordRestState({ ...rs, endsAt: rs.endsAt + seconds * 1000 });
    }

    skipRest() {
        if (this.activeRestTimerId == null) return this.hideRestBar();
        timerService.stopRestTimer(this.activeRestTimerId);
        this.activeRestTimerId = null;
        this._activeRestType = null;
        this.clearRestChip();
        this.hideRestBar();
        if (this.currentWorkoutSession?.restState) this.recordRestState(null);
    }

    showRestBar(total, restType = 'exercise') {
        const bar = document.getElementById('rest-timer-bar');
        if (!bar) return;
        bar.hidden = false;
        // Hide the sitewide back-to-top arrow while the dial owns the bottom.
        document.body.classList.add('gt-rest-bar-visible');
        bar.classList.remove('rest-timer-done', 'rest-timer-urgent', 'rest-timer--set', 'rest-timer--exercise');
        // Color code: green between sets, blue between exercises.
        bar.classList.add(restType === 'set' ? 'rest-timer--set' : 'rest-timer--exercise');
        const captionEl = document.getElementById('rest-timer-caption');
        if (captionEl) captionEl.textContent = restType === 'set' ? 'Next set in' : 'Next exercise in';
        const valueEl = document.getElementById('rest-timer-value');
        const fill = document.getElementById('rest-timer-progress-fill');
        if (valueEl) valueEl.textContent = this.formatRest(total);
        if (fill) {
            // Circular progress ring: full at start (offset 0), drains to empty
            // (offset = circumference) as the countdown runs.
            const len = (typeof fill.getTotalLength === 'function' ? fill.getTotalLength() : 0) || (2 * Math.PI * 24);
            this._restRingLen = len;
            fill.style.transition = 'none';
            fill.style.strokeDasharray = String(len);
            fill.style.strokeDashoffset = '0';
            // Force reflow so the next offset change transitions smoothly.
            // eslint-disable-next-line no-unused-expressions
            fill.getBoundingClientRect();
            fill.style.transition = 'stroke-dashoffset 1s linear';
        }
    }

    hideRestBar() {
        const bar = document.getElementById('rest-timer-bar');
        if (bar) {
            bar.hidden = true;
            bar.classList.remove('rest-timer-done', 'rest-timer-urgent', 'rest-timer--set', 'rest-timer--exercise');
        }
        document.body.classList.remove('gt-rest-bar-visible');
        this.activeRestExerciseIndex = -1;
        this.lastPingedRestSecond = -1;
    }

    /**
     * Item R2-3: switch the persistent in-card chip into the live countdown
     * state (colored, ticking). The chip element always exists; we never
     * create or remove it, only toggle its state classes and text.
     */
    showRestChip(exerciseIndex, remaining) {
        if (exerciseIndex < 0) return;
        const chip = document.querySelector(`#exercise-${exerciseIndex} .rest-countdown-chip`);
        if (!chip) return;
        const countdown = this.app.settings?.timerCountdownSeconds ?? 5;
        const urgent = remaining <= countdown && remaining > 0;
        chip.className = 'rest-countdown-chip' + (urgent ? ' rest-countdown-chip--urgent' : '');
        chip.innerHTML = `<i class="fas fa-clock" aria-hidden="true"></i> ${this.formatRest(remaining)}`;
    }

    /**
     * Item R2-3: revert the in-card chip to its idle gray state showing the
     * static between-set rest duration. The chip is never removed.
     */
    clearRestChip() {
        const idx = this.activeRestExerciseIndex;
        if (idx < 0) return;
        const chip = document.querySelector(`#exercise-${idx} .rest-countdown-chip`);
        if (!chip) return;
        const idle = parseInt(chip.dataset.restIdle, 10) || 0;
        chip.className = 'rest-countdown-chip rest-countdown-chip--idle';
        chip.innerHTML = `<i class="fas fa-clock" aria-hidden="true"></i> ${this.formatRest(idle)}`;
    }

    onRestTick(remaining) {
        // The floating dial is the live display for both rest types.
        const valueEl = document.getElementById('rest-timer-value');
        const fill = document.getElementById('rest-timer-progress-fill');
        if (valueEl) valueEl.textContent = this.formatRest(remaining);
        if (fill && this.restTimerDuration > 0) {
            const ratio = Math.max(0, Math.min(1, remaining / this.restTimerDuration));
            const len = this._restRingLen || (2 * Math.PI * 82);
            fill.style.strokeDashoffset = String(len * (1 - ratio));
        }

        const firstWarning = this.app.settings?.timerFirstWarningSeconds ?? 10;
        const countdown = this.app.settings?.timerCountdownSeconds ?? 5;
        const { warn, urgent } = restTickCues(remaining, firstWarning, countdown);

        // Single early heads-up tone (distinct from the per-second pip).
        if (warn && remaining !== this.lastPingedRestSecond) {
            this.lastPingedRestSecond = remaining;
            if (this.app.settings?.soundAlerts !== false) playSound('timer-warn');
            if (this.app.settings?.vibrationAlerts !== false && typeof navigator.vibrate === 'function') {
                navigator.vibrate(60);
            }
        }

        // Final-countdown urgent state — per-second pip + urgent styling.
        const bar = document.getElementById('rest-timer-bar');
        if (urgent) {
            if (bar) bar.classList.add('rest-timer-urgent');
            // One ping per second — guard with lastPingedRestSecond.
            if (remaining !== this.lastPingedRestSecond) {
                this.lastPingedRestSecond = remaining;
                if (this.app.settings?.soundAlerts !== false) playSound('timer-low');
                if (this.app.settings?.vibrationAlerts !== false && typeof navigator.vibrate === 'function') {
                    navigator.vibrate(40);
                }
            }
        } else {
            if (bar) bar.classList.remove('rest-timer-urgent');
        }
    }

    onRestComplete() {
        this.activeRestTimerId = null;
        this._activeRestType = null;
        if (this.currentWorkoutSession?.restState) this.recordRestState(null);

        // Both rest types use the floating dial: flip to the done state, then
        // auto-hide. Also revert the in-card chip to its idle static state.
        const bar = document.getElementById('rest-timer-bar');
        const valueEl = document.getElementById('rest-timer-value');
        if (bar) {
            bar.classList.add('rest-timer-done');
            bar.classList.remove('rest-timer-urgent');
        }
        if (valueEl) valueEl.textContent = 'Done';
        this.clearRestChip();
        setTimeout(() => this.hideRestBar(), 2500);

        // Audio and haptic cues — each opt-outable independently in Settings.
        if (this.app.settings?.vibrationAlerts !== false) vibrate([120, 60, 120]);
        if (this.app.settings?.soundAlerts !== false) playSound('rest-done');
    }

    formatRest(seconds) {
        const s = Math.max(0, seconds | 0);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, '0')}`;
    }

    /**
     * GT-07: clear every session-specific control in the finish dialog.
     *
     * The dialog is a persistent bit of DOM, so whatever the last workout
     * left in it was still sitting there for the next one - a second session
     * of the day was saved with the first one's notes and heart rate, which
     * the lifter never typed. Called when a NEW session starts (and on
     * finish/discard), never when the SAME session's dialog is reopened
     * after a temporary close, so stepping out of the dialog to add one more
     * set does not wipe what was already typed.
     */
    resetFinishWorkoutForm() {
        ['workout-notes', 'avg-heart-rate', 'max-heart-rate', 'calories-burned']
            .forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        const msg = document.getElementById('finish-inline-message');
        if (msg) msg.hidden = true;
        this._finishFormSessionId = null;
    }

    openFinishWorkoutModal() {
        if (!this.currentWorkoutSession) return;

        // Belt and braces for the leak: if the dialog is still holding a
        // DIFFERENT session's values (a workout started before this build,
        // or any path that skipped the reset), clear them now.
        if (this._finishFormSessionId !== undefined
            && this._finishFormSessionId !== null
            && !sameId(this._finishFormSessionId, this.currentWorkoutSession.id)) {
            this.resetFinishWorkoutForm();
        }
        this._finishFormSessionId = this.currentWorkoutSession.id;

        const finishModal = document.getElementById('finish-workout-modal');

        // Check if any sets were completed
        const hasCompletedSets = this.currentWorkoutSession.exercises.some(ex =>
            ex.sets && ex.sets.length > 0 && ex.sets.some(set => set.completed)
        );

        // Item R2-8: no floating toast. With zero sets, open the modal and show
        // an inline message instead; it dismisses as soon as the user logs a set.
        const msg = document.getElementById('finish-inline-message');
        if (!hasCompletedSets) {
            if (msg) msg.hidden = false;
            finishModal.classList.add('active');
            trapModalFocus(finishModal);
            return;
        }
        if (msg) msg.hidden = true;

        // Update summary
        const duration = timerService.getWorkoutElapsed();
        const minutes = Math.floor(duration / 60);

        const unit = normalizeWeightUnit(this.app.settings.weightUnit);

        const durationText = `${minutes} min`;
        document.getElementById('summary-duration').textContent = durationText;
        const heroEl = document.getElementById('summary-duration-hero');
        if (heroEl) heroEl.textContent = durationText;

        const titleEl = document.getElementById('finish-workout-title');
        if (titleEl) titleEl.textContent = this.currentWorkoutSession.workoutDayName || 'Finish Workout';

        // Weight-volume only, converted from canonical kg into the display
        // unit. Seconds held are a separate metric and get their own tile
        // (GT-04) instead of being added in as kilograms.
        const totalVolume = this.currentWorkoutSession.totalVolume;
        document.getElementById('summary-volume').textContent =
            `${Math.round(volumeIn(totalVolume, unit)).toLocaleString()} ${unit}`;
        document.getElementById('summary-sets').textContent =
            this.currentWorkoutSession.totalSets;

        const timed = this.currentWorkoutSession.totalTimedSeconds;
        const timeStat = document.getElementById('summary-time-under-tension-stat');
        const timeValue = document.getElementById('summary-time-under-tension');
        if (timeStat && timeValue) {
            timeStat.hidden = timed <= 0;
            timeValue.textContent = formatDurationLong(timed);
        }

        // Feature 7: volume delta vs the previous session of the SAME program.
        // First session for a program shows raw totals only (no delta).
        const deltaEl = document.getElementById('summary-volume-delta');
        if (deltaEl) {
            const prev = this._lastSessionForProgram(this.currentWorkoutSession.programId);
            const prevVolume = prev ? prev.totalVolume : 0;
            if (prev && prevVolume > 0) {
                const pct = Math.round(((totalVolume - prevVolume) / prevVolume) * 100);
                const sign = pct >= 0 ? '+' : '';
                deltaEl.textContent = `(${sign}${pct}% vs last time)`;
                deltaEl.classList.toggle('gt-volume-delta--down', pct < 0);
                deltaEl.classList.toggle('gt-volume-delta--up', pct >= 0);
                deltaEl.hidden = false;
            } else {
                deltaEl.hidden = true;
            }
        }

        const prsStat = document.getElementById('summary-prs-stat');
        const prsValue = document.getElementById('summary-prs');
        if (prsStat && prsValue) {
            prsStat.hidden = this.sessionPrCount === 0;
            prsValue.textContent = `${this.sessionPrCount}`;
        }

        finishModal.classList.add('active');
        trapModalFocus(finishModal);
    }

    finishWorkout() {
        if (!this.currentWorkoutSession) return;

        // Check if any sets were completed
        const hasCompletedSets = this.currentWorkoutSession.exercises.some(ex =>
            ex.sets && ex.sets.length > 0 && ex.sets.some(set => set.completed)
        );

        if (!hasCompletedSets) {
            const msg = document.getElementById('finish-inline-message');
            if (msg) msg.hidden = false;
            return;
        }

        // Get post-workout metrics
        const avgHR = document.getElementById('avg-heart-rate').value;
        const maxHR = document.getElementById('max-heart-rate').value;
        const calories = document.getElementById('calories-burned').value;
        const notes = document.getElementById('workout-notes').value;

        // The form is novalidate so the feedback is inline copy like every
        // other form here, not the browser bubble.
        const metricsProblem = validatePostWorkoutMetrics({ avgHR, maxHR, calories });
        const metricsMsg = document.getElementById('finish-metrics-message');
        ['avg-heart-rate', 'max-heart-rate', 'calories-burned'].forEach((id) => document.getElementById(id)?.removeAttribute('aria-invalid'));
        if (metricsProblem) {
            if (metricsMsg) {
                metricsMsg.hidden = false;
                const text = document.getElementById('finish-metrics-message-text');
                if (text) text.textContent = metricsProblem.message;
            }
            const bad = document.getElementById(metricsProblem.field);
            if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
            return;
        }
        if (metricsMsg) metricsMsg.hidden = true;

        // Stale-tab guard (D2): if this session's id is already in storage
        // another tab finished it; a second save would overwrite that copy
        // with this tab's older one. Read before write, by id.
        const alreadySaved = storageService.getWorkoutSessions()
            .some((s) => s && s.completed && sameId(s.id, this.currentWorkoutSession.id));
        if (alreadySaved || this._otherTabOwnsWorkout()) {
            showToast(alreadySaved
                ? 'This workout was already finished in another tab, so this copy was not saved again.'
                : 'This workout is being logged in another tab. Finish it there.', 'error', 8000);
            if (alreadySaved) this.handleWorkoutTakenOver();
            const modalEl = document.getElementById('finish-workout-modal');
            if (modalEl) modalEl.classList.remove('active');
            if (alreadySaved) {
                document.getElementById('active-workout').classList.remove('active');
                document.getElementById('workout-selection').classList.add('active');
            }
            return;
        }

        // End the workout
        this.currentWorkoutSession.endWorkout();
        this.currentWorkoutSession.restState = null;

        if (avgHR) this.currentWorkoutSession.avgHeartRate = parseInt(avgHR);
        if (maxHR) this.currentWorkoutSession.maxHeartRate = parseInt(maxHR);
        if (calories) this.currentWorkoutSession.caloriesBurned = parseInt(calories);
        if (notes) this.currentWorkoutSession.notes = notes;

        // Save workout session
        this.app.workoutSessions.push(this.currentWorkoutSession);
        this.app.saveWorkoutSessions();

        // The app's single most meaningful completion. Counts and duration
        // only: no exercise names, no notes, no heart-rate or calorie figures,
        // which are health data and have no place in analytics.
        track('trackAction', 'workout_completed', {
            exercise_count: this.currentWorkoutSession.exercises.length,
            set_count: this.currentWorkoutSession.exercises.reduce(
                (n, ex) => n + ((ex.sets || []).filter((s) => s.completed).length), 0
            ),
            duration_minutes: this.currentWorkoutSession.duration || 0,
        });

        // Integration 4: persistent per-exercise PR achievements. Fires only for
        // exercises that beat their all-time best with 2+ prior sessions; the
        // service persists + is idempotent by id and returns the new awards.
        const newPRs = AchievementService.checkExercisePRs(this.currentWorkoutSession, this.app.workoutSessions);
        if (newPRs.length > 0) {
            this.app.achievements.push(...newPRs);
            newPRs.forEach((pr) => {
                showToast(`New PR: ${pr.prExerciseName} ${this._formatPrAchievementWeight(pr)}`, 'success', 4000);
            });
        }

        // Clear any paused workout from storage since we're finishing
        storageService.clearActiveWorkout();
        this.releaseWorkoutLock();

        // Update achievements
        this.app.updateAchievements();

        // Stop timer + rest bar
        timerService.stopWorkoutTimer();
        this.skipRest();
        this.disarmBackGuard();

        // Close modal and reset (R3-6: blur before hide so the confirm button
        // doesn't retain focus inside the closing dialog).
        const finishModalEl = document.getElementById('finish-workout-modal');
        if (finishModalEl.contains(document.activeElement)) document.activeElement.blur();
        finishModalEl.classList.remove('active');
        document.getElementById('active-workout').classList.remove('active');
        document.getElementById('workout-selection').classList.add('active');

        const completedSession = this.currentWorkoutSession;
        this.currentWorkoutSession = null;
        this.resetFinishWorkoutForm();

        this.showCompletionBurst(completedSession);
        this.render();
        this.app.updateGlobalFab();
    }

    /**
     * Feature 2: full-screen burst card shown after saving a workout.
     * Auto-dismisses after 4 s or on tap. Falls back silently when the
     * container element isn't in the DOM.
     */
    showCompletionBurst(session) {
        const unit = normalizeWeightUnit(this.app.settings.weightUnit);
        const duration = session.duration || 0;
        const volume = Math.round(volumeIn(session.totalVolume, unit)).toLocaleString();
        // GT-23: exercises actually performed, not every row on the plan.
        const exerciseCount = session.performedExerciseCount;
        const timedSeconds = session.totalTimedSeconds;
        const prCount = this.sessionPrCount;

        const overlay = document.createElement('div');
        overlay.className = 'completion-burst';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Workout complete');
        overlay.innerHTML = `
            <div class="completion-burst-card">
                <div class="completion-burst-icon">💪</div>
                <h2 class="completion-burst-title">Workout Complete!</h2>
                <div class="completion-burst-stats">
                    <div class="completion-burst-stat">
                        <span class="completion-burst-value">${duration}</span>
                        <span class="completion-burst-label">min</span>
                    </div>
                    <div class="completion-burst-stat">
                        <span class="completion-burst-value">${volume}</span>
                        <span class="completion-burst-label">${unit} volume</span>
                    </div>
                    <div class="completion-burst-stat">
                        <span class="completion-burst-value">${exerciseCount}</span>
                        <span class="completion-burst-label">${pluralLabel(exerciseCount, 'exercise')}</span>
                    </div>
                    ${timedSeconds > 0 ? `
                    <div class="completion-burst-stat">
                        <span class="completion-burst-value">${formatDurationLong(timedSeconds)}</span>
                        <span class="completion-burst-label">held</span>
                    </div>` : ''}
                    ${prCount > 0 ? `
                    <div class="completion-burst-stat completion-burst-stat--pr">
                        <span class="completion-burst-value">🏆 ${prCount}</span>
                        <span class="completion-burst-label">PR${prCount === 1 ? '' : 's'}</span>
                    </div>` : ''}
                </div>
                <p class="completion-burst-dismiss">Tap anywhere to close</p>
            </div>
        `;

        document.body.appendChild(overlay);

        const dismiss = () => {
            overlay.classList.add('completion-burst--out');
            setTimeout(() => overlay.remove(), 300);
        };

        overlay.addEventListener('click', dismiss);
        const timerId = setTimeout(dismiss, 4000);
        overlay.addEventListener('click', () => clearTimeout(timerId), { once: true });
    }

    /**
     * Return the most recently completed session for a given programId,
     * or null if the program has never been completed.
     */
    _lastSessionForProgram(programId) {
        const sessions = (this.app.workoutSessions || [])
            .filter(s => sameId(s.programId, programId) && s.completed)
            .sort((a, b) => new Date(b.sortTimestamp) - new Date(a.sortTimestamp));
        return sessions[0] || null;
    }

    /**
     * Build the HTML chip row for the last-done info on a program card.
     * Returns an empty string when no session exists.
     */
    _renderLastDoneInfo(session) {
        if (!session) {
            return `<div class="program-last-done program-last-done--never">
                <i class="fas fa-calendar-xmark" aria-hidden="true"></i>
                Not done yet
            </div>`;
        }

        const relativeLabel = this._relativeDate(session.sortTimestamp || session.date);
        const absDate = this._absoluteDate(session.sortTimestamp || session.date);

        const chips = [];
        const duration = session.duration;
        if (duration > 0) {
            chips.push(`<span class="psc-chip"><i class="fas fa-clock" aria-hidden="true"></i>${duration} min</span>`);
        }
        const unit = normalizeWeightUnit(this.app.settings.weightUnit);
        const volume = session.totalVolume;
        if (volume > 0) {
            chips.push(`<span class="psc-chip"><i class="fas fa-weight-hanging" aria-hidden="true"></i>${Math.round(volumeIn(volume, unit)).toLocaleString()} ${unit}</span>`);
        }
        if (session.caloriesBurned) {
            chips.push(`<span class="psc-chip"><i class="fas fa-fire" aria-hidden="true"></i>${session.caloriesBurned} kcal</span>`);
        }
        if (session.avgHeartRate) {
            chips.push(`<span class="psc-chip"><i class="fas fa-heart-pulse" aria-hidden="true"></i>${session.avgHeartRate} bpm</span>`);
        }

        const chipsHTML = chips.length > 0
            ? `<div class="psc-chips">${chips.join('')}</div>`
            : '';

        return `<div class="program-last-done" title="${escapeHtml(absDate)}">
            <i class="fas fa-calendar-check" aria-hidden="true"></i>
            <span class="psc-relative">${escapeHtml(relativeLabel)}</span>
            ${chipsHTML}
        </div>`;
    }

    /** Returns a human-friendly relative date label, e.g. "Today", "2 days ago". */
    _relativeDate(isoOrDate) {
        if (!isoOrDate) return '';
        const then = new Date(isoOrDate);
        const now = new Date();
        // Compare calendar days in local time.
        const thenDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
        const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffDays = Math.round((nowDay - thenDay) / 86400000);
        if (diffDays === 0) return 'Last done: Today';
        if (diffDays === 1) return 'Last done: Yesterday';
        if (diffDays < 7) return `Last done: ${diffDays} days ago`;
        if (diffDays < 14) return 'Last done: 1 week ago';
        const diffWeeks = Math.floor(diffDays / 7);
        if (diffDays < 60) return `Last done: ${diffWeeks} weeks ago`;
        const diffMonths = Math.floor(diffDays / 30);
        return `Last done: ${diffMonths} months ago`;
    }

    /** Returns a short absolute date string for the tooltip. */
    _absoluteDate(isoOrDate) {
        if (!isoOrDate) return '';
        const d = new Date(isoOrDate);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    async endWorkout() {
        const confirmed = await showConfirmModal({
            title: 'Discard Workout',
            message: 'Are you sure you want to discard this workout?<br><br><strong>Your progress will not be saved.</strong>',
            confirmText: 'Discard Workout',
            cancelText: 'Continue Workout',
            isDangerous: true
        });

        if (confirmed) {
            timerService.stopWorkoutTimer();
            this.skipRest();
            this.disarmBackGuard();
            if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
            storageService.clearActiveWorkout();
            this.resetFinishWorkoutForm();
            document.getElementById('active-workout').classList.remove('active');
            document.getElementById('workout-selection').classList.add('active');
            this.currentWorkoutSession = null;
            this.render();
            showToast('Workout discarded', 'info');
            this.app.showView('home');
        }
    }
}

// Initialize
new WorkoutView();
