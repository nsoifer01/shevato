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
import { showToast, showConfirmModal, formatMuscleGroup, vibrate } from '../utils/helpers.js';
import { renderPausedBannerHTML, wirePausedBannerActions } from './paused-banner.js';

class WorkoutView {
    constructor() {
        this.app = app;
        this.currentWorkoutSession = null;
        this.navigationBlocked = false;
        this.activeRestTimerId = null;
        this.restTimerDuration = 0;
        this.init();
    }

    init() {
        this.app.viewControllers.workout = this;
        this.setupEventListeners();
        this.setupNavigationGuard();
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
    }

    setupNavigationGuard() {
        // Intercept browser back button and page unload
        window.addEventListener('beforeunload', (e) => {
            if (this.currentWorkoutSession && !this.currentWorkoutSession.completed) {
                // Check if any sets were added
                const hasAnySets = this.currentWorkoutSession.exercises.some(ex =>
                    ex.sets && ex.sets.length > 0
                );

                if (hasAnySets) {
                    // Save workout state before leaving
                    this.pauseAndSaveWorkout();
                    // Show browser's native confirmation
                    e.preventDefault();
                    e.returnValue = '';
                    return '';
                }
            }
        });

        // Intercept in-app navigation
        this.interceptNavigation();
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
                        showToast('Workout paused. You can resume later.', 'info');
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

        console.log('Workout paused and saved', this.currentWorkoutSession.toJSON());

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
        showToast('Workout paused. You can resume later.', 'info');
        this.app.showView('home');
    }

    discardWorkout() {
        timerService.stopWorkoutTimer();
        this.skipRest();
        storageService.clearActiveWorkout();
        document.getElementById('active-workout').classList.remove('active');
        document.getElementById('workout-selection').classList.add('active');
        this.currentWorkoutSession = null;
    }

    hasActiveWorkout() {
        return this.currentWorkoutSession !== null && !this.currentWorkoutSession.completed;
    }

    render() {
        this.renderProgramSelection();
    }

    async resumeWorkout() {
        const pausedWorkout = storageService.getActiveWorkout();
        if (!pausedWorkout) {
            showToast('No paused workout found', 'error');
            return;
        }

        // Restore the workout session
        this.currentWorkoutSession = WorkoutSession.fromJSON(pausedWorkout);
        this.currentWorkoutSession.resumeWorkout();

        // Start timer with saved elapsed time
        timerService.startWorkoutTimer((elapsed) => {
            this.updateWorkoutTimer(elapsed);
        }, pausedWorkout.elapsedBeforePause);

        // Switch to active workout screen
        document.getElementById('workout-selection').classList.remove('active');
        document.getElementById('active-workout').classList.add('active');

        // Render workout
        this.renderActiveWorkout();

        showToast('Workout resumed!', 'success');
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

    renderProgramSelection() {
        const container = document.getElementById('workout-program-list');
        const programs = this.app.programs;

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
                    <button class="btn btn-primary" data-view="programs">Create Program</button>
                </div>
            `;
            container.innerHTML = html;
            return;
        }

        html += `
            <h2>Select a Program</h2>
            <p class="subtitle">Choose which program you want to do today</p>
            <div class="program-selection-grid">
                ${programs.map(program => `
                    <div class="program-card">
                        <div class="program-header">
                            <h3>${program.name}</h3>
                        </div>
                        <p>${program.description || 'No description'}</p>
                        <div class="program-stats">
                            <div class="stat">
                                <i class="fas fa-dumbbell"></i>
                                ${program.exercises.length} exercises
                            </div>
                        </div>
                        ${program.exercises.length === 0
                            ? `<p class="text-warning"><i class="fas fa-exclamation-triangle"></i> No exercises in this program</p>`
                            : `<button class="btn btn-primary btn-large" onclick="window.gymApp.viewControllers.workout.startWorkout(${program.id})">
                                <i class="fas fa-play"></i> Start Workout
                            </button>`
                        }
                    </div>
                `).join('')}
            </div>
        `;

        container.innerHTML = html;

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
                order: ex.order
            }))
        });

        this.currentWorkoutSession.startWorkout();

        // Start workout timer
        timerService.startWorkoutTimer((elapsed) => {
            this.updateWorkoutTimer(elapsed);
        });

        // Switch to active workout screen
        document.getElementById('workout-selection').classList.remove('active');
        document.getElementById('active-workout').classList.add('active');

        // Render workout
        this.renderActiveWorkout();
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

        const container = document.getElementById('workout-exercises-list');
        container.innerHTML = this.currentWorkoutSession.exercises
            .map((exercise, index) => this.renderExerciseEntry(exercise, index))
            .join('');
    }

    /**
     * Render a single exercise block: progress header, last-time reference,
     * and a list of N planned set rows where N = max(targetSets, sets.length).
     */
    renderExerciseEntry(exercise, index) {
        const exerciseData = this.app.getExerciseById(exercise.exerciseId);
        const isDuration = !!(exerciseData && exerciseData.exerciseType === 'duration');
        const previousSets = this.getPreviousExerciseData(exercise.exerciseId) || [];
        const unit = this.app.settings.weightUnit;

        const targetSets = Math.max(1, exercise.targetSets || 3);
        const completedCount = exercise.sets.length;
        const totalRows = Math.max(targetSets, completedCount);
        const isComplete = completedCount >= targetSets && targetSets > 0;

        const muscle = formatMuscleGroup(exerciseData?.muscleGroup);
        const progressLabel = `${completedCount} / ${targetSets} sets`;

        let rowsHTML = '';
        for (let i = 0; i < totalRows; i++) {
            if (i < exercise.sets.length) {
                rowsHTML += this.renderCompletedRow(exercise.sets[i], index, i, isDuration, unit);
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
                rowsHTML += this.renderPlannedRow(index, i, prior, isDuration, unit, exercise.targetReps);
            }
        }

        const lastTimeHTML = this.renderLastTimeStrip(previousSets, isDuration, unit);

        return `
            <div class="exercise-entry ${isComplete ? 'exercise-complete' : ''}"
                 id="exercise-${index}" data-exercise-type="${isDuration ? 'duration' : 'reps'}">
                <div class="exercise-entry-header">
                    <h3>
                        <span class="exercise-name-main">${exercise.exerciseName}</span>${muscle ? `
                        <span class="exercise-name-sub">(${muscle})</span>` : ''}
                    </h3>
                    <span class="exercise-progress ${isComplete ? 'is-complete' : ''}" aria-label="Sets ${progressLabel}">
                        ${isComplete ? '<i class="fas fa-check"></i>' : ''}
                        ${progressLabel}
                    </span>
                </div>

                ${lastTimeHTML}

                <ol class="set-row-list" id="set-row-list-${index}">
                    ${rowsHTML}
                </ol>

                <div class="set-row-footer">
                    ${totalRows > Math.max(1, completedCount) ? `
                        <button type="button" class="btn-remove-set"
                            onclick="window.gymApp.viewControllers.workout.removePlannedRow(${index})"
                            title="Remove last empty set"
                            aria-label="Remove last empty set row">
                            <i class="fas fa-minus"></i>
                        </button>
                    ` : ''}
                    <button type="button" class="btn-add-set btn-add-set--extra"
                        onclick="window.gymApp.viewControllers.workout.addPlannedRow(${index})"
                        aria-label="Add another set row">
                        <i class="fas fa-plus"></i> Add set
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Compact read-only reference strip: "Last time: 60×8 · 60×8 · 55×8".
     * Purely informational — per-set defaults live inside each planned row.
     */
    renderLastTimeStrip(previousSets, isDuration, unit) {
        if (!previousSets || previousSets.length === 0) {
            return '<div class="previous-sets-label">Last time: <span>No previous data</span></div>';
        }

        const chips = previousSets.map((set, i) => {
            if (isDuration) {
                const mins = Math.floor(set.duration / 60);
                const secs = set.duration % 60;
                return `<span class="prev-chip"><b>${i + 1}</b> ${mins}:${secs.toString().padStart(2, '0')}</span>`;
            }
            return `<span class="prev-chip"><b>${i + 1}</b> ${set.weight.toLocaleString()}${unit}×${set.reps}</span>`;
        }).join('');

        return `
            <div class="previous-data">
                <div class="previous-sets-label">Last time</div>
                <div class="previous-sets-row">${chips}</div>
            </div>
        `;
    }

    /**
     * A set that has not yet been logged. Shows empty (or prefilled-from-prior)
     * inputs and a pill toggle on the right — tapping the toggle commits the
     * set and starts the rest timer. The row itself is NOT tappable — users
     * deliberately flick the toggle to complete.
     */
    renderPlannedRow(exerciseIndex, slot, prior, isDuration, unit, targetReps) {
        const setLabel = `${slot + 1}`;
        const toggle = this.renderSetToggle(false,
            `window.gymApp.viewControllers.workout.commitPlannedSet(${exerciseIndex}, ${slot})`,
            'Mark set complete');

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

        const weight = prior ? prior.weight : '';
        const reps = prior ? prior.reps : (targetReps || '');
        return `
            <li class="set-row set-row-planned" data-slot="${slot}">
                <span class="set-row-num">${setLabel}</span>
                <div class="set-row-inputs">
                    <input type="number" inputmode="decimal" class="set-weight"
                        id="weight-${exerciseIndex}-${slot}" min="0" step="0.5"
                        value="${weight === '' ? '' : weight}" placeholder="Weight" aria-label="Weight">
                    <span class="set-row-x">×</span>
                    <input type="number" inputmode="numeric" class="set-reps"
                        id="reps-${exerciseIndex}-${slot}" min="1"
                        value="${reps === '' ? '' : reps}" placeholder="Reps" aria-label="Reps">
                </div>
                ${toggle}
            </li>
        `;
    }

    /**
     * Shared pill-toggle markup used for both the "not yet completed" state
     * (knob-left, muted pill) and the "completed" state (knob-right, green
     * gradient pill with a crisp check inside the knob). CSS drives the
     * visuals from `aria-pressed` so the DOM stays identical between states.
     */
    renderSetToggle(pressed, onClickExpression, ariaLabel) {
        return `
            <button type="button" class="set-toggle"
                aria-pressed="${pressed ? 'true' : 'false'}"
                aria-label="${ariaLabel}"
                onclick="${onClickExpression}">
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
            details = `${set.weight.toLocaleString()}${unit} × ${set.reps}`;
        }

        const toggle = this.renderSetToggle(true,
            `window.gymApp.viewControllers.workout.deleteSet(${exerciseIndex}, ${slot}, { silent: true })`,
            'Unmark set');

        return `
            <li class="set-row set-row-complete" data-slot="${slot}">
                <span class="set-row-num">${setLabel}</span>
                <div class="set-row-details">${details}</div>
                <div class="set-row-actions">
                    <button type="button" class="btn-set-action" title="Edit set" aria-label="Edit set"
                        onclick="window.gymApp.viewControllers.workout.editSet(${exerciseIndex}, ${slot})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button type="button" class="btn-set-action btn-set-delete" title="Delete set" aria-label="Delete set"
                        onclick="window.gymApp.viewControllers.workout.deleteSet(${exerciseIndex}, ${slot})">
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
        const floor = Math.max(1, exercise.sets.length);
        if ((exercise.targetSets || 0) <= floor) return;
        exercise.targetSets -= 1;
        this.rerenderExercise(exerciseIndex);
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

        // Find the most recent workout that has this exercise with completed sets
        for (const session of sortedSessions) {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                // Get all completed sets
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    // Return all completed sets with their weight, reps, and duration
                    return completedSets.map(set => ({
                        weight: set.weight,
                        reps: set.reps,
                        duration: set.duration
                    }));
                }
            }
        }

        return null;
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
            set = new Set({ duration: totalSeconds, weight: 0, reps: 0, completed: true });
        } else {
            const weightInput = document.getElementById(`weight-${exerciseIndex}-${slot}`);
            const repsInput = document.getElementById(`reps-${exerciseIndex}-${slot}`);
            const weight = parseFloat(weightInput?.value);
            const reps = parseInt(repsInput?.value, 10);
            if (isNaN(weight) || weight < 0 || !reps) {
                showToast('Please enter weight and reps', 'error');
                return;
            }
            set = new Set({ weight, reps, completed: true });
        }

        // Insert into the exact slot index so the UI mirrors the user's plan.
        // Sets beyond the current list length just append naturally.
        if (slot >= exercise.sets.length) {
            exercise.addSet(set);
        } else {
            exercise.sets.splice(slot, 0, set);
        }

        vibrate(30);
        this.rerenderExercise(exerciseIndex);
        this.startRest(exercise.restSeconds || 90);
    }

    editSet(exerciseIndex, setIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const set = exercise?.sets[setIndex];
        if (!set) return;

        const setRowEl = document.querySelector(`#set-row-list-${exerciseIndex} .set-row[data-slot="${setIndex}"]`);
        if (!setRowEl) return;

        const isDuration = set.duration > 0;

        let editFormHTML;
        if (isDuration) {
            const mins = Math.floor(set.duration / 60);
            const secs = set.duration % 60;
            editFormHTML = `
                <div class="set-row-inputs">
                    <input type="number" class="set-edit-input duration-edit-min"
                        id="edit-duration-min-${exerciseIndex}-${setIndex}" value="${mins}" min="0" placeholder="Min" aria-label="Minutes">
                    <span class="duration-separator">:</span>
                    <input type="number" class="set-edit-input duration-edit-sec"
                        id="edit-duration-sec-${exerciseIndex}-${setIndex}" value="${secs}" min="0" max="59" placeholder="Sec" aria-label="Seconds">
                </div>
            `;
        } else {
            editFormHTML = `
                <div class="set-row-inputs">
                    <input type="number" class="set-edit-input"
                        id="edit-weight-${exerciseIndex}-${setIndex}" value="${set.weight}" step="0.5" min="0" placeholder="Weight" aria-label="Weight">
                    <span class="set-row-x">×</span>
                    <input type="number" class="set-edit-input"
                        id="edit-reps-${exerciseIndex}-${setIndex}" value="${set.reps}" min="1" placeholder="Reps" aria-label="Reps">
                </div>
            `;
        }

        setRowEl.classList.remove('set-row-complete');
        setRowEl.classList.add('set-row-editing');
        setRowEl.innerHTML = `
            <span class="set-row-num">${setIndex + 1}</span>
            ${editFormHTML}
            <div class="set-row-actions">
                <button type="button" class="btn-set-action btn-set-save" title="Save" aria-label="Save set"
                    onclick="window.gymApp.viewControllers.workout.saveSetEdit(${exerciseIndex}, ${setIndex})">
                    <i class="fas fa-check"></i>
                </button>
                <button type="button" class="btn-set-action btn-set-cancel" title="Cancel" aria-label="Cancel edit"
                    onclick="window.gymApp.viewControllers.workout.cancelSetEdit(${exerciseIndex})">
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

    saveSetEdit(exerciseIndex, setIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const set = exercise.sets[setIndex];
        const isDuration = set.duration > 0;

        if (isDuration) {
            const minInput = document.getElementById(`edit-duration-min-${exerciseIndex}-${setIndex}`);
            const secInput = document.getElementById(`edit-duration-sec-${exerciseIndex}-${setIndex}`);
            const minutes = parseInt(minInput.value, 10) || 0;
            const seconds = parseInt(secInput.value, 10) || 0;
            const totalSeconds = (minutes * 60) + seconds;
            if (totalSeconds === 0) {
                showToast('Please enter a valid duration', 'error');
                return;
            }
            set.duration = totalSeconds;
        } else {
            const weightInput = document.getElementById(`edit-weight-${exerciseIndex}-${setIndex}`);
            const repsInput = document.getElementById(`edit-reps-${exerciseIndex}-${setIndex}`);
            const weight = parseFloat(weightInput.value);
            const reps = parseInt(repsInput.value, 10);
            if (isNaN(weight) || weight < 0 || !reps) {
                showToast('Please enter valid weight and reps', 'error');
                return;
            }
            set.weight = weight;
            set.reps = reps;
        }

        this.rerenderExercise(exerciseIndex);
        showToast('Set updated', 'success');
    }

    cancelSetEdit(exerciseIndex) {
        if (!this.currentWorkoutSession) return;
        this.rerenderExercise(exerciseIndex);
    }

    /**
     * Remove a committed set from an exercise. `opts.silent` suppresses the
     * "Set deleted" toast — used by the pill-toggle un-check flow, where
     * the knob animation already gives clear visual confirmation and a
     * duplicate toast would be noise.
     */
    deleteSet(exerciseIndex, setIndex, opts = {}) {
        if (!this.currentWorkoutSession) return;
        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const removed = exercise?.sets[setIndex];
        if (!exercise || !removed) return;

        exercise.sets.splice(setIndex, 1);

        // Preserve the deleted set's values so the user's typed edits don't
        // vanish when a set is unchecked. The values stick to whatever slot
        // becomes the first planned row after the deletion (the new tail).
        // This makes toggle-off → re-check flows non-destructive.
        if (!exercise.stickyValues) exercise.stickyValues = {};
        exercise.stickyValues[exercise.sets.length] = {
            weight: removed.weight,
            reps: removed.reps,
            duration: removed.duration,
        };

        this.rerenderExercise(exerciseIndex);
        if (!opts.silent) showToast('Set deleted', 'info');
    }

    updateWorkoutTimer(elapsed) {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('workout-time').textContent =
            `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    // --- Rest timer ---

    /** Start (or restart) the persistent rest bar for `seconds` seconds. */
    startRest(seconds) {
        const duration = Math.max(0, Math.floor(seconds || 0));
        if (duration === 0) return;

        if (this.activeRestTimerId != null) {
            timerService.stopRestTimer(this.activeRestTimerId);
        }

        this.restTimerDuration = duration;
        this.showRestBar(duration);

        this.activeRestTimerId = timerService.startRestTimer(
            duration,
            (remaining) => this.onRestTick(remaining),
            () => this.onRestComplete(),
        );
    }

    /** Add N seconds to the in-flight rest timer without restarting it. */
    extendRest(seconds) {
        if (this.activeRestTimerId == null) return;
        const current = timerService.getRestTimerRemaining(this.activeRestTimerId);
        const newTotal = Math.max(1, current + seconds);
        // Simplest correct approach: restart with the new remaining duration.
        timerService.stopRestTimer(this.activeRestTimerId);
        this.restTimerDuration += seconds;
        this.showRestBar(newTotal, { resetFillBase: false });
        this.activeRestTimerId = timerService.startRestTimer(
            newTotal,
            (remaining) => this.onRestTick(remaining),
            () => this.onRestComplete(),
        );
    }

    skipRest() {
        if (this.activeRestTimerId == null) return this.hideRestBar();
        timerService.stopRestTimer(this.activeRestTimerId);
        this.activeRestTimerId = null;
        this.hideRestBar();
    }

    showRestBar(total) {
        const bar = document.getElementById('rest-timer-bar');
        if (!bar) return;
        bar.hidden = false;
        bar.classList.remove('rest-timer-done');
        const valueEl = document.getElementById('rest-timer-value');
        const fill = document.getElementById('rest-timer-progress-fill');
        if (valueEl) valueEl.textContent = this.formatRest(total);
        if (fill) {
            // Reset transition so the starting frame is 100% width before shrinking.
            fill.style.transition = 'none';
            fill.style.transform = 'scaleX(1)';
            // Force reflow so the next transform transitions smoothly.
            // eslint-disable-next-line no-unused-expressions
            fill.offsetHeight;
            fill.style.transition = 'transform 1s linear';
        }
    }

    hideRestBar() {
        const bar = document.getElementById('rest-timer-bar');
        if (bar) {
            bar.hidden = true;
            bar.classList.remove('rest-timer-done');
        }
    }

    onRestTick(remaining) {
        const valueEl = document.getElementById('rest-timer-value');
        const fill = document.getElementById('rest-timer-progress-fill');
        if (valueEl) valueEl.textContent = this.formatRest(remaining);
        if (fill && this.restTimerDuration > 0) {
            const ratio = Math.max(0, Math.min(1, remaining / this.restTimerDuration));
            fill.style.transform = `scaleX(${ratio})`;
        }
    }

    onRestComplete() {
        this.activeRestTimerId = null;
        const bar = document.getElementById('rest-timer-bar');
        const valueEl = document.getElementById('rest-timer-value');
        if (bar) bar.classList.add('rest-timer-done');
        if (valueEl) valueEl.textContent = 'Done';
        vibrate([120, 60, 120]);
        // Auto-hide after a short celebration so the bar doesn't linger.
        setTimeout(() => this.hideRestBar(), 2500);
    }

    formatRest(seconds) {
        const s = Math.max(0, seconds | 0);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, '0')}`;
    }

    openFinishWorkoutModal() {
        if (!this.currentWorkoutSession) return;

        // Check if any sets were completed
        const hasCompletedSets = this.currentWorkoutSession.exercises.some(ex =>
            ex.sets && ex.sets.length > 0 && ex.sets.some(set => set.completed)
        );

        if (!hasCompletedSets) {
            showToast('Cannot finish workout - no sets completed', 'error');
            return;
        }

        // Update summary
        const duration = timerService.getWorkoutElapsed();
        const minutes = Math.floor(duration / 60);

        const unit = this.app.settings.weightUnit;

        document.getElementById('summary-duration').textContent = `${minutes} min`;
        document.getElementById('summary-volume').textContent =
            `${Math.round(this.currentWorkoutSession.totalVolume).toLocaleString()} ${unit}`;
        document.getElementById('summary-sets').textContent =
            this.currentWorkoutSession.totalSets;

        document.getElementById('finish-workout-modal').classList.add('active');
    }

    finishWorkout() {
        if (!this.currentWorkoutSession) return;

        // Check if any sets were completed
        const hasCompletedSets = this.currentWorkoutSession.exercises.some(ex =>
            ex.sets && ex.sets.length > 0 && ex.sets.some(set => set.completed)
        );

        if (!hasCompletedSets) {
            showToast('Cannot save workout - no sets completed', 'error');
            document.getElementById('finish-workout-modal').classList.remove('active');
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

        // Clear any paused workout from storage since we're finishing
        storageService.clearActiveWorkout();

        // Update achievements
        this.app.updateAchievements();

        // Stop timer + rest bar
        timerService.stopWorkoutTimer();
        this.skipRest();

        // Close modal and reset
        document.getElementById('finish-workout-modal').classList.remove('active');
        document.getElementById('active-workout').classList.remove('active');
        document.getElementById('workout-selection').classList.add('active');

        this.currentWorkoutSession = null;

        showToast('Workout completed! Great job!', 'success', 5000);
        this.render();
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
