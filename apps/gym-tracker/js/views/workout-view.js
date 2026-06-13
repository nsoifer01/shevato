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
import { showToast, showConfirmModal, formatMuscleGroup, vibrate, playSound, escapeHtml, debugLog, convertWeight } from '../utils/helpers.js';
import { trapModalFocus } from '../utils/modal-focus.js';
import { renderPausedBannerHTML, wirePausedBannerActions } from './paused-banner.js';
import { orderPrograms } from '../utils/program-order.js';
import { sameId } from '../utils/id-utils.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { AchievementService } from '../services/AchievementService.js';
import { calculatePlates, formatPlateStack } from '../utils/plate-calculator.js';
import { restTickCues, isWorkoutComplete } from '../utils/rest-cues.js';
import { allSetsReachMax, latestFeelForExercise, nextFeel, shouldShowFeelModal } from '../utils/exercise-feel.js';
import { recordPrSupersede, uniquePrChainCount, recomputePrSlots } from '../utils/pr-session.js';
import { mergeSessionWithProgram } from '../utils/session-merge.js';
import { weekStrip } from '../utils/program-schedule.js';

const PLATE_LOADED_EQUIPMENT = new globalThis.Set(['barbell', 'trap-bar', 'machine', 'plate', 'sled']);

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
        this._feelModalShown = {};
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
        this.wireWorkoutActions();
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
                    storageService.saveActiveWorkout(this.currentWorkoutSession.toJSON());
                    const toggle = document.querySelector(`.gt-notes-toggle[data-exercise-index="${eIdx}"]`);
                    if (toggle) toggle.classList.toggle('gt-notes-toggle--has-notes', t.value.trim() !== '');
                }
                return;
            }
            if (!(t instanceof HTMLInputElement)) return;
            // Feature 6: a weight/reps edit on a planned row may surface (or hide)
            // the "same as last time" restore chip.
            if (t.classList.contains('set-weight') || t.classList.contains('set-reps')) {
                this.maybeToggleRestoreChip(t.closest('.set-row-planned'));
            }
            const target = t.dataset.plateHintTarget;
            if (!target) return;
            const [eIdx, slot] = target.split('-').map(Number);
            this.refreshPlateHint(eIdx, slot, t.value);
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

    /** The unit weights are DISPLAYED/ENTERED in for this session. */
    sessionUnit() {
        return this.currentWorkoutSession?.sessionUnit || this.app.settings.weightUnit;
    }

    /** True when the session display unit differs from the account unit. */
    unitsDiffer() {
        return this.sessionUnit() !== this.app.settings.weightUnit;
    }

    /** Convert a canonical (account-unit) weight into the session display unit. */
    toSessionWeight(weight) {
        if (weight === '' || weight === null || weight === undefined) return weight;
        return convertWeight(Number(weight), this.app.settings.weightUnit, this.sessionUnit());
    }

    /** Convert a session-unit input value back to the canonical account unit. */
    toAccountWeight(weight) {
        return convertWeight(Number(weight), this.sessionUnit(), this.app.settings.weightUnit);
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

        const account = this.app.settings.weightUnit;
        // Read current planned-row weight inputs (in the OLD session unit) and
        // carry their canonical values onto stickyValues so the re-render
        // repopulates them converted into the new unit.
        const oldUnit = this.sessionUnit();
        this.currentWorkoutSession.exercises.forEach((exercise, eIdx) => {
            const list = document.querySelectorAll(`#exercise-${eIdx} .set-row-planned`);
            list.forEach(row => {
                const slot = Number(row.dataset.slot);
                const input = row.querySelector('.set-weight');
                if (!input || input.value === '') return;
                const canonical = convertWeight(Number(input.value), oldUnit, account);
                if (!exercise.stickyValues) exercise.stickyValues = {};
                const reps = row.querySelector('.set-reps');
                exercise.stickyValues[slot] = {
                    weight: canonical,
                    reps: reps && reps.value !== '' ? Number(reps.value) : (exercise.stickyValues[slot]?.reps ?? ''),
                    duration: exercise.stickyValues[slot]?.duration ?? 0,
                };
            });
        });

        this.currentWorkoutSession.sessionUnit = unit === account ? null : unit;
        storageService.saveActiveWorkout(this.currentWorkoutSession.toJSON());
        this.syncSessionUnitToggle();
        this.renderActiveWorkout();
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

    pauseAndSaveWorkout() {
        if (!this.currentWorkoutSession || this.currentWorkoutSession.completed) {
            return;
        }

        // Get current elapsed time
        const elapsed = timerService.getWorkoutElapsed();

        // Mark workout as paused
        this.currentWorkoutSession.pauseWorkout(elapsed);

        // Save to storage
        storageService.saveActiveWorkout(this.currentWorkoutSession.toJSON());

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
        storageService.clearActiveWorkout();
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
        const pausedWorkout = storageService.getActiveWorkout();
        if (!pausedWorkout) {
            showToast('No paused workout found', 'error');
            return;
        }

        // Restore the workout session
        this.currentWorkoutSession = WorkoutSession.fromJSON(pausedWorkout);
        this.currentWorkoutSession.resumeWorkout();

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
        this._feelModalShown = {};
        // Item R3-4: don't re-pop the feel modal on resume for exercises that
        // already satisfy the all-sets-at-max condition. The modal only fires on
        // the commit transition; mark satisfied exercises as already shown.
        this._seedFeelModalShownFromSession();
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
                exerciseName: progEx.exerciseName,
                sets: [],
                targetSets: progEx.targetSets,
                targetReps: progEx.targetReps,
                restSeconds: progEx.restSeconds,
                restAfterSeconds: progEx.restAfterSeconds,
                groupId: progEx.groupId || null,
            }),
        );
        this.currentWorkoutSession.exercises = merged.map(e => WorkoutExercise.fromJSON(e));
        storageService.saveActiveWorkout(this.currentWorkoutSession.toJSON());
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
            title: 'Discard Paused Workout',
            message: 'Are you sure you want to discard this paused workout?<br><br><strong>All progress will be lost.</strong>',
            confirmText: 'Discard',
            cancelText: 'Keep',
            isDangerous: true
        });

        if (confirmed) {
            storageService.clearActiveWorkout();
            this.render();
            showToast('Paused workout discarded', 'info');
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

        if (!program.exercises || program.exercises.length === 0) {
            showToast('This program has no exercises', 'error');
            return;
        }

        // Create new workout session
        this.currentWorkoutSession = new WorkoutSession({
            programId: program.id,
            workoutDayId: null,
            workoutDayName: program.name,
            exercises: program.exercises.map(ex => new WorkoutExercise({
                exerciseId: ex.exerciseId,
                exerciseName: ex.exerciseName,
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

        // Reset per-session state.
        this.sessionPrSlots = {};
        this.collapsedExercises = {};
        this._prevCompleteState = {};
        this._activeRestType = null;
        this._feelModalShown = {};

        // Start workout timer
        timerService.startWorkoutTimer((elapsed) => {
            this.updateWorkoutTimer(elapsed);
        });

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
        // Fall back gracefully for old sessions/programs that lack sets[].
        const program = this.app.getProgramById(this.currentWorkoutSession?.programId);
        const progEx = program?.exercises.find(e => e.exerciseId === exercise.exerciseId);
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

        // Task 6: determine if all programmed sets share the same rep target.
        // When they do, show once at exercise level instead of repeating per row.
        let allSameRepRange = false;
        let sharedRepLabel = '';
        if (progSets && progSets.length > 0) {
            const first = progSets[0];
            allSameRepRange = progSets.every(s => s.repsMin === first.repsMin && s.repsMax === first.repsMax);
            if (allSameRepRange) {
                sharedRepLabel = this.formatRepRange(first.repsMin, first.repsMax);
            }
        }

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
                const slotRepLabel = slotProgSet
                    ? this.formatRepRange(slotProgSet.repsMin, slotProgSet.repsMax) : null;
                // Prefill each row with its own set's top-of-range target, not set 1's.
                const slotTargetReps = (progSets && i < progSets.length)
                    ? progSets[i].repsMax : exercise.targetReps;
                rowsHTML += this.renderPlannedRow(index, i, prior, isDuration, unit, slotTargetReps, isPlateLoaded, usesBarWeight, slotRepLabel);
            }
        }

        // Item R3-4: the chosen feel for THIS session (set via the modal) shows
        // on the exercise header and toggles good -> none on tap. The inline
        // prompt row is gone; the picker is the modal (see commitPlannedSet).
        const sessionFeelHTML = !isDuration ? this.renderFeelToggleIcon(index, exercise.feel) : '';

        // Item 7: last feel marking for this exercise across prior sessions,
        // shown next to the name to inform progression (history, unchanged). Only
        // when there is no session feel chosen yet so the two icons don't stack.
        const lastFeel = (!isDuration && exercise.feel !== 'good')
            ? latestFeelForExercise(this.app.workoutSessions, exercise.exerciseId, s => s.sortTimestamp)
            : null;
        const lastFeelHTML = lastFeel ? this.renderFeelHistoryIcon(lastFeel) : '';

        // Item R2-3: the between-set rest is shown as a single in-place chip.
        // Idle, it renders the duration as a static GRAY number; when a set is
        // completed the same element becomes the live colored countdown, then
        // reverts to gray. No "Between sets"/"After exercise" pills.
        const progEx2 = program?.exercises.find(e => e.exerciseId === exercise.exerciseId);
        const betweenSetActive = progEx2?.restSeconds ?? exercise.restSeconds ?? 90;
        const isRestingHere = this.activeRestExerciseIndex === index && this._activeRestType === 'set';
        const restChipHTML = `
            <div class="rest-countdown-chip${isRestingHere ? '' : ' rest-countdown-chip--idle'}"
                 data-rest-idle="${betweenSetActive}" aria-live="off"
                 title="Rest between sets"><i class="fas fa-clock" aria-hidden="true"></i> ${this.formatRest(betweenSetActive)}</div>
        `;

        // Per-exercise plate-hints toggle.
        // Global OFF overrides everything: hints hidden for ALL exercises.
        // Global ON: per-exercise preference applies (defaults to ON).
        // Item 8: plate config is in account units, so hide the toggle and
        // hints entirely while the session unit differs from the account unit.
        const globalHints = this.app.settings?.plateHintsEnabled !== false && !this.unitsDiffer();
        const perExHints = this.app.settings?.exercisePlateHints?.[exercise.exerciseId];
        const hintsOnForExercise = globalHints && (perExHints !== undefined ? perExHints : true);
        // Per-exercise toggle is only meaningful when global hints are ON.
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
                    <div class="exercise-title-block">
                        <h3>
                            <span class="exercise-name-main">${escapeHtml(exercise.exerciseName)}</span>${sessionFeelHTML}${lastFeelHTML}
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
                        <button type="button" class="gt-iconbtn gt-notes-toggle${exercise.notes ? ' gt-notes-toggle--has-notes' : ''}"
                            data-action="toggle-exercise-notes"
                            data-exercise-index="${index}"
                            aria-expanded="false"
                            aria-label="Notes for this exercise"
                            title="Notes for this exercise">
                            <i class="fas fa-pen" aria-hidden="true"></i>
                        </button>
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
                    <div class="gt-exercise-notes" id="exercise-notes-${index}" hidden>
                        <textarea class="gt-exercise-notes-input" data-exercise-index="${index}"
                            placeholder="Notes for this exercise (form cues, how it felt, etc.)"
                            aria-label="Exercise notes">${escapeHtml(exercise.notes || '')}</textarea>
                    </div>

                    <ol class="set-row-list" id="set-row-list-${index}">
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
    renderPlannedRow(exerciseIndex, slot, prior, isDuration, unit, targetReps, isPlateLoaded = false, usesBarWeight = false, repLabel = null) {
        const setLabel = `${slot + 1}`;
        const toggle = this.renderSetToggle(false, 'commit-planned-set', exerciseIndex, slot, 'Mark set complete');

        if (isDuration) {
            const mins = prior ? Math.floor(prior.duration / 60) : 0;
            const secs = prior ? prior.duration % 60 : 0;
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
                </li>
            `;
        }

        // Prior weights are canonical (account-unit); convert into the session
        // display unit for prefill (Item 8). One decimal via convertWeight.
        const weight = prior && prior.weight !== '' && prior.weight != null
            ? this.toSessionWeight(prior.weight)
            : '';
        const reps = prior ? prior.reps : (targetReps || '');
        // Per-exercise plate hints: global OFF overrides everything; also off
        // while the session unit differs from the account unit (Item 8).
        const sessionExercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        const exerciseId = sessionExercise?.exerciseId;
        const globalHintsOn = this.app.settings?.plateHintsEnabled !== false && !this.unitsDiffer();
        const perExHintsVal = exerciseId !== undefined
            ? this.app.settings?.exercisePlateHints?.[exerciseId]
            : undefined;
        const hintsOn = globalHintsOn && (perExHintsVal !== undefined ? perExHintsVal : true);
        const plateHintHTML = (isPlateLoaded && hintsOn) ? this.renderPlateHint(weight, unit, usesBarWeight) : '';

        // Feature 6: prior pre-filled values stored on the row so an input that
        // drifts from them can surface a "same as last time" restore chip. Only
        // present when prior data exists; the chip itself is created on input
        // (see maybeToggleRestoreChip), not at render.
        const restoreData = (prior && weight !== '' && reps !== '' && reps != null)
            ? `data-prior-weight="${weight}" data-prior-reps="${reps}"`
            : '';

        return `
            <li class="set-row set-row-planned" data-slot="${slot}" ${restoreData}>
                <span class="set-row-num">${setLabel}</span>
                <div class="set-row-inputs">
                    <input type="number" inputmode="decimal" class="set-weight"
                        id="weight-${exerciseIndex}-${slot}" min="0" step="0.5"
                        value="${weight === '' ? '' : weight}" placeholder="Weight" aria-label="Weight"
                        data-plate-hint-target="${exerciseIndex}-${slot}">
                    <span class="set-row-x">×</span>
                    <input type="number" inputmode="numeric" class="set-reps"
                        id="reps-${exerciseIndex}-${slot}" min="1"
                        value="${reps === '' ? '' : reps}" placeholder="Reps" aria-label="Reps">
                    ${repLabel ? `<span class="set-rep-target" aria-label="Target: ${repLabel}">${repLabel}</span>` : ''}
                </div>
                ${toggle}
                ${plateHintHTML ? `<div class="plate-hint" id="plate-hint-${exerciseIndex}-${slot}">${plateHintHTML}</div>` : ''}
            </li>
        `;
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
        chip.className = 'gt-restore-chip';
        chip.dataset.action = 'restore-last-time';
        chip.dataset.exerciseIndex = String(exerciseIndex);
        chip.dataset.slot = String(slot);
        chip.title = "Restore last session's weight and reps";
        chip.textContent = `last time: ${priorWeight}${unit} x ${priorReps}`;
        // Append after the toggle (own full-width line beneath the inputs), the
        // same placement the Feature 1 bump chip uses.
        row.appendChild(chip);
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
        storageService.saveActiveWorkout(this.currentWorkoutSession.toJSON());
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
     * commit/resume feel-modal triggers.
     */
    _exerciseReachesMax(exercise) {
        if (!exercise) return false;
        const exerciseData = this.app.getExerciseById(exercise.exerciseId);
        if (exerciseData && exerciseData.exerciseType === 'duration') return false;
        const program = this.app.getProgramById(this.currentWorkoutSession?.programId);
        const progEx = program?.exercises.find(e => e.exerciseId === exercise.exerciseId);
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
    _seedFeelModalShownFromSession() {
        const exercises = this.currentWorkoutSession?.exercises || [];
        exercises.forEach((exercise, i) => {
            if (this._exerciseReachesMax(exercise)) this._feelModalShown[i] = true;
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
    maybeShowFeelModal(exerciseIndex) {
        const exercise = this.currentWorkoutSession?.exercises[exerciseIndex];
        if (!exercise) return;
        const reaches = this._exerciseReachesMax(exercise);
        if (!shouldShowFeelModal(this._feelModalShown, exerciseIndex, reaches)) return;
        const modal = document.getElementById('feel-intro-modal');
        if (!modal) return;

        this._feelModalShown[exerciseIndex] = true;

        modal.classList.add('active');
        trapModalFocus(modal);

        const close = () => {
            // R3-6: blur the clicked choice before hiding (no focused descendant
            // under a closing dialog).
            if (modal.contains(document.activeElement)) document.activeElement.blur();
            modal.classList.remove('active');
            goodBtn?.removeEventListener('click', onGood);
            skipX?.removeEventListener('click', close);
            skipBtn?.removeEventListener('click', close);
        };
        const onGood = () => {
            this.setExerciseFeel(exerciseIndex, 'good');
            close();
        };

        const goodBtn = document.getElementById('feel-modal-good');
        const skipX = document.getElementById('feel-modal-skip');
        const skipBtn = document.getElementById('feel-modal-skip-btn');
        goodBtn?.addEventListener('click', onGood);
        skipX?.addEventListener('click', close);
        skipBtn?.addEventListener('click', close);
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
    renderPlateHint(weight, unit, usesBarWeight = true) {
        const settings = this.app.settings;
        const bar = usesBarWeight ? Number(settings?.barWeight) : 0;
        const plates = Array.isArray(settings?.plates) ? settings.plates : [];
        if (usesBarWeight && !Number.isFinite(Number(settings?.barWeight))) return '';
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
        if (this.unitsDiffer()) return;
        const unit = this.app.settings.weightUnit;
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
        const html = this.renderPlateHint(weight, unit, usesBarWeight);
        if (html) hintEl.innerHTML = html;
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
            // set.weight is canonical (account unit); display in session unit.
            const shown = this.toSessionWeight(set.weight);
            details = `${shown.toLocaleString()}${unit} × ${set.reps}`;
        }

        const toggle = this.renderSetToggle(true, 'unmark-set', exerciseIndex, slot, 'Unmark set');

        const pr = this.sessionPrSlots?.[`${exerciseIndex}:${slot}`];
        const prBadge = pr
            ? `<span class="pr-badge" aria-label="Personal record, ${this.formatPrDelta(pr, unit)}"><i class="fas fa-trophy" aria-hidden="true"></i> PR ${this.formatPrDelta(pr, unit)}</span>`
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

        const { exercise: lastExercise, completedSets: lastSets } = recentSessions[0];

        // Feature 6+8: detect progressive overload opportunity.
        // If the lifter hit all target reps at a given weight in BOTH of the
        // last two sessions, suggest (and auto-apply) an increment.
        let suggestIncrement = false;
        let increment = 0;
        let previousWeight = 0;

        if (recentSessions.length === 2) {
            const { completedSets: prevSets } = recentSessions[1];
            const targetReps = lastExercise.targetReps || 0;

            // "All target reps" = every completed set hit at least targetReps.
            const allHit = (sets) =>
                sets.length > 0 &&
                sets.every(s => (s.reps || 0) >= targetReps && targetReps > 0);

            if (allHit(lastSets) && allHit(prevSets)) {
                const lastWeight = lastSets[0]?.weight || 0;
                const prevWeight = prevSets[0]?.weight || 0;
                // Only suggest if both sessions used the same weight (no jump
                // already happened between them).
                if (lastWeight > 0 && lastWeight === prevWeight) {
                    suggestIncrement = true;
                    previousWeight = lastWeight;
                    const unit = this.app.settings.weightUnit;
                    increment = this._overloadIncrement(exerciseId, unit);
                }
            }
        }

        const sets = lastSets.map(set => ({
            weight: suggestIncrement ? previousWeight + increment : set.weight,
            reps: set.reps,
            duration: set.duration,
            // Pass original weight so the chip can show "auto-bumped from Xkg"
            originalWeight: set.weight,
        }));

        sets.suggestIncrement = suggestIncrement;
        sets.increment = increment;
        sets.previousWeight = previousWeight;

        return sets;
    }

    /**
     * Return the progressive-overload increment for an exercise.
     * Lower-body compound movements get a larger step.
     */
    _overloadIncrement(exerciseId, unit) {
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
            const entered = parseFloat(weightInput?.value);
            const reps = parseInt(repsInput?.value, 10);
            if (isNaN(entered) || entered < 0 || !reps) {
                showToast('Please enter weight and reps', 'error');
                return;
            }
            // The input is in the session unit; store canonical (account unit).
            const weight = this.toAccountWeight(entered);
            set = new Set({ weight, reps, completed: true, slot });
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

        this.rerenderExercise(exerciseIndex);

        // Item R3-4: if this commit just made the exercise satisfy the
        // all-sets-at-max condition, show the feel picker modal (once per
        // exercise per session). Picking collapses the exercise.
        this.maybeShowFeelModal(exerciseIndex);

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
            const progEx = program?.exercises.find(e => e.exerciseId === exercise.exerciseId);

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
            const mins = Math.floor(pr.delta / 60);
            const secs = pr.delta % 60;
            return `+${mins}:${String(secs).padStart(2, '0')}`;
        }
        // pr.delta is in the account unit; convert to the display unit (Item 8).
        const delta = convertWeight(pr.delta, this.app.settings.weightUnit, unit);
        return `+${Math.round(delta)} ${unit}`;
    }

    /**
     * Integration 4: format a persisted PR achievement's weight for its toast.
     * prWeightKg is canonical kg; show it in the user's current display unit.
     */
    _formatPrAchievementWeight(pr) {
        const unit = this.app.settings.weightUnit;
        const shown = convertWeight(pr.prWeightKg, 'kg', unit);
        return `${Math.round(shown * 10) / 10}${unit}`;
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
     * state (auto-collapse, _prevCompleteState, _feelModalShown) must equal a
     * fresh evaluation — the commit path keeps these in sync, the edit/delete
     * paths historically did not. Mirrors commitPlannedSet's bookkeeping:
     *   - re-evaluate complete/collapse (respecting the user-explicit-expand
     *     invariant collapsedExercises[i] === false, and clearing that
     *     suppression on a complete->incomplete transition so auto-collapse can
     *     fire again);
     *   - clear _feelModalShown when the exercise no longer reaches max, so
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
            this._feelModalShown[exerciseIndex] = false;
        }

        return isNowComplete;
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
            const entered = parseFloat(weightInput.value);
            const reps = parseInt(repsInput.value, 10);
            if (isNaN(entered) || entered < 0 || !reps) {
                showToast('Please enter valid weight and reps', 'error');
                return;
            }
            // Input is in the session unit; store canonical (account unit).
            set.weight = this.toAccountWeight(entered);
            set.reps = reps;
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
        // feel-modal) consistent with the edited reps, then mirror the commit
        // path by (re)showing the feel modal if the edit newly satisfies the
        // all-sets-at-max condition. maybeShowFeelModal self-guards via
        // shouldShowFeelModal, so it won't double-show or fire when incomplete.
        // #23: a save IS a deliberate set action, so re-arm auto-collapse on a
        // still-complete exercise even if the user had manually expanded it.
        this._recomputeExerciseDerivedState(exerciseIndex, true);

        this.rerenderExercise(exerciseIndex);

        this.maybeShowFeelModal(exerciseIndex);
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

        // #18: keep collapse / complete / feel-modal derived state consistent
        // with the post-delete sets. This clears the manual-expand suppression on
        // a complete->incomplete transition (so auto-collapse re-fires later) and
        // resets _feelModalShown when the exercise no longer reaches max (so
        // re-reaching max re-shows the modal).
        this._recomputeExerciseDerivedState(exerciseIndex);

        // Bugs B+C: unmarking a set cancels any active rest timer that was
        // started for this exercise (between-set chip or between-exercise bottom
        // bar). An unmark means the exercise is no longer in the post-set state
        // that triggered the timer, so the rest is no longer meaningful.
        if (this.activeRestExerciseIndex === exerciseIndex && this.activeRestTimerId != null) {
            this.skipRest();
        }

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
    }

    /** Add N seconds to the in-flight rest timer without restarting it. */
    extendRest(seconds) {
        if (this.activeRestTimerId == null) return;
        // The wall-clock-based timer can be extended in place; we just bump
        // the total used as the progress-bar denominator so the fill ratio
        // stays sensible.
        this.restTimerDuration += seconds;
        timerService.extendRestTimer(this.activeRestTimerId, seconds);
    }

    skipRest() {
        if (this.activeRestTimerId == null) return this.hideRestBar();
        timerService.stopRestTimer(this.activeRestTimerId);
        this.activeRestTimerId = null;
        this._activeRestType = null;
        this.clearRestChip();
        this.hideRestBar();
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

    openFinishWorkoutModal() {
        if (!this.currentWorkoutSession) return;

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

        const unit = this.app.settings.weightUnit;

        const durationText = `${minutes} min`;
        document.getElementById('summary-duration').textContent = durationText;
        const heroEl = document.getElementById('summary-duration-hero');
        if (heroEl) heroEl.textContent = durationText;

        const titleEl = document.getElementById('finish-workout-title');
        if (titleEl) titleEl.textContent = this.currentWorkoutSession.workoutDayName || 'Finish Workout';

        const totalVolume = this.currentWorkoutSession.totalVolume;
        document.getElementById('summary-volume').textContent =
            `${Math.round(totalVolume).toLocaleString()} ${unit}`;
        document.getElementById('summary-sets').textContent =
            this.currentWorkoutSession.totalSets;

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

        // End the workout
        this.currentWorkoutSession.endWorkout();

        // Get post-workout metrics
        const avgHR = document.getElementById('avg-heart-rate').value;
        const maxHR = document.getElementById('max-heart-rate').value;
        const calories = document.getElementById('calories-burned').value;
        const notes = document.getElementById('workout-notes').value;

        if (avgHR) this.currentWorkoutSession.avgHeartRate = parseInt(avgHR);
        if (maxHR) this.currentWorkoutSession.maxHeartRate = parseInt(maxHR);
        if (calories) this.currentWorkoutSession.caloriesBurned = parseInt(calories);
        if (notes) this.currentWorkoutSession.notes = notes;

        // Save workout session
        this.app.workoutSessions.push(this.currentWorkoutSession);
        this.app.saveWorkoutSessions();

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
        const unit = this.app.settings.weightUnit;
        const duration = session.duration || 0;
        const volume = Math.round(session.totalVolume).toLocaleString();
        const exerciseCount = session.exercises.length;
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
                        <span class="completion-burst-label">exercises</span>
                    </div>
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
        const unit = this.app.settings.weightUnit;
        const volume = session.totalVolume;
        if (volume > 0) {
            chips.push(`<span class="psc-chip"><i class="fas fa-weight-hanging" aria-hidden="true"></i>${Math.round(volume).toLocaleString()} ${unit}</span>`);
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
            storageService.clearActiveWorkout();
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
