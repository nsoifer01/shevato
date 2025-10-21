/**
 * Workout View Controller
 * Mobile-optimized workout execution
 */
import { app } from '../app.js';
import { WorkoutSession } from '../models/WorkoutSession.js';
import { WorkoutExercise } from '../models/WorkoutExercise.js';
import { Set } from '../models/Set.js';
import { timerService } from '../services/TimerService.js';
import { showToast, showConfirmModal } from '../utils/helpers.js';

class WorkoutView {
    constructor() {
        this.app = app;
        this.currentWorkoutSession = null;
        this.init();
    }

    init() {
        this.app.viewControllers.workout = this;
        this.setupEventListeners();
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

        // Finish workout form
        const finishForm = document.getElementById('finish-workout-form');
        if (finishForm) {
            finishForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.finishWorkout();
            });
        }
    }

    render() {
        this.renderProgramSelection();
    }

    renderProgramSelection() {
        const container = document.getElementById('workout-program-list');
        const programs = this.app.programs;

        if (programs.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-folder-open"></i>
                    <p>No programs yet. Create a program first.</p>
                    <button class="btn btn-primary" data-view="programs">Create Program</button>
                </div>
            `;
            return;
        }

        container.innerHTML = `
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

    renderActiveWorkout() {
        if (!this.currentWorkoutSession) return;

        document.getElementById('workout-title').textContent = this.currentWorkoutSession.workoutDayName;

        const container = document.getElementById('workout-exercises-list');
        container.innerHTML = this.currentWorkoutSession.exercises.map((exercise, index) => {
            const exerciseData = this.app.getExerciseById(exercise.exerciseId);
            const isDuration = exerciseData && exerciseData.exerciseType === 'duration';
            const previousSets = this.getPreviousExerciseData(exercise.exerciseId);
            const unit = this.app.settings.weightUnit;

            let previousDataHTML = '';
            if (previousSets && previousSets.length > 0) {
                if (isDuration) {
                    // Show duration for time-based exercises
                    previousDataHTML = `
                        <div class="previous-sets-label">Last time:</div>
                        <div class="previous-sets-row">
                            ${previousSets.map((set, i) => {
                                const mins = Math.floor(set.duration / 60);
                                const secs = set.duration % 60;
                                return `
                                    <div class="previous-set-badge" onclick="window.gymApp.viewControllers.workout.usePreviousDuration(${index}, ${set.duration})" title="Click to use this duration">
                                        <span class="previous-set-number">${i + 1}</span>
                                        <span class="previous-set-value">${mins}:${secs.toString().padStart(2, '0')}</span>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    `;
                } else {
                    // Show weight × reps for reps-based exercises
                    previousDataHTML = `
                        <div class="previous-sets-label">Last time:</div>
                        <div class="previous-sets-row">
                            ${previousSets.map((set, i) => `
                                <div class="previous-set-badge" onclick="window.gymApp.viewControllers.workout.usePreviousSet(${index}, ${set.weight}, ${set.reps})" title="Click to use these values">
                                    <span class="previous-set-number">${i + 1}</span>
                                    <span class="previous-set-value">${set.weight}${unit} × ${set.reps}</span>
                                </div>
                            `).join('')}
                        </div>
                    `;
                }
            } else {
                previousDataHTML = '<div class="previous-sets-label">Last time: <span>No previous data</span></div>';
            }

            // Pre-fill with first set data if available
            const firstSet = previousSets && previousSets.length > 0 ? previousSets[0] : null;

            // Render inputs based on exercise type
            let setInputsHTML = '';
            if (isDuration) {
                const defaultMins = firstSet ? Math.floor(firstSet.duration / 60) : 0;
                const defaultSecs = firstSet ? firstSet.duration % 60 : 0;
                setInputsHTML = `
                    <div class="set-inputs">
                        <div class="input-group duration-input">
                            <label class="input-label">Duration</label>
                            <div class="duration-inputs">
                                <input type="number" placeholder="Min" id="duration-min-${index}" min="0" value="${defaultMins}" class="duration-min">
                                <span class="duration-separator">:</span>
                                <input type="number" placeholder="Sec" id="duration-sec-${index}" min="0" max="59" value="${defaultSecs.toString().padStart(2, '0')}" class="duration-sec">
                            </div>
                        </div>
                        <button onclick="window.gymApp.viewControllers.workout.addSet(${index})">Add Set</button>
                    </div>
                `;
            } else {
                setInputsHTML = `
                    <div class="set-inputs">
                        <div class="input-group">
                            <label class="input-label">Weight</label>
                            <input type="number" placeholder="Weight" id="weight-${index}" step="0.5" min="0" ${firstSet ? `value="${firstSet.weight}"` : ''}>
                        </div>
                        <div class="input-group">
                            <label class="input-label">Reps</label>
                            <input type="number" placeholder="Reps" id="reps-${index}" min="1" ${firstSet ? `value="${firstSet.reps}"` : ''}>
                        </div>
                        <button onclick="window.gymApp.viewControllers.workout.addSet(${index})">Add Set</button>
                    </div>
                `;
            }

            return `
                <div class="exercise-entry" id="exercise-${index}" data-exercise-type="${isDuration ? 'duration' : 'reps'}">
                    <div class="exercise-entry-header">
                        <h3>${exercise.exerciseName}</h3>
                    </div>

                    <div class="previous-data">
                        ${previousDataHTML}
                    </div>

                    ${setInputsHTML}

                    <div class="completed-sets" id="completed-sets-${index}">
                        ${this.renderCompletedSets(exercise.sets, index)}
                    </div>
                </div>
            `;
        }).join('');
    }

    getPreviousExerciseData(exerciseId) {
        // Get all workout sessions sorted by date (most recent first)
        const sortedSessions = [...this.app.workoutSessions].sort((a, b) =>
            new Date(b.date) - new Date(a.date)
        );

        // Find the most recent workout that has this exercise with completed sets
        for (const session of sortedSessions) {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                // Get all completed sets
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    // Return all completed sets with their weight and reps
                    return completedSets.map(set => ({
                        weight: set.weight,
                        reps: set.reps
                    }));
                }
            }
        }

        return null;
    }

    renderCompletedSets(sets, exerciseIndex) {
        if (sets.length === 0) return '<p>No sets completed</p>';

        const unit = this.app.settings.weightUnit;
        return sets.map((set, setIndex) => {
            let setLabel, setDetails;
            if (set.duration > 0) {
                // Duration-based set
                const mins = Math.floor(set.duration / 60);
                const secs = set.duration % 60;
                setLabel = `Round ${setIndex + 1}:`;
                setDetails = `<span class="duration-value">${mins}:${secs.toString().padStart(2, '0')}</span> <span class="duration-label">min</span>`;
            } else {
                // Reps-based set
                setLabel = `Set ${setIndex + 1}:`;
                setDetails = `${set.weight}${unit} × ${set.reps} reps`;
            }

            return `
                <div class="completed-set">
                    <div class="set-info">
                        <span class="set-number">${setLabel}</span>
                        <span class="set-details">${setDetails}</span>
                    </div>
                    <div class="set-actions">
                        <button class="btn-set-action" onclick="window.gymApp.viewControllers.workout.editSet(${exerciseIndex}, ${setIndex})" title="Edit set">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-set-action btn-set-delete" onclick="window.gymApp.viewControllers.workout.deleteSet(${exerciseIndex}, ${setIndex})" title="Delete set">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    usePreviousSet(exerciseIndex, weight, reps) {
        if (!this.currentWorkoutSession) return;

        const weightInput = document.getElementById(`weight-${exerciseIndex}`);
        const repsInput = document.getElementById(`reps-${exerciseIndex}`);

        // Fill in the values
        weightInput.value = weight;
        repsInput.value = reps;

        // Focus the weight input for easy modification if needed
        weightInput.focus();
        weightInput.select();

        const unit = this.app.settings.weightUnit;
        showToast(`Loaded: ${weight}${unit} × ${reps} reps`, 'info');
    }

    usePreviousDuration(exerciseIndex, durationSeconds) {
        if (!this.currentWorkoutSession) return;

        const minInput = document.getElementById(`duration-min-${exerciseIndex}`);
        const secInput = document.getElementById(`duration-sec-${exerciseIndex}`);

        const minutes = Math.floor(durationSeconds / 60);
        const seconds = durationSeconds % 60;

        // Fill in the values
        minInput.value = minutes;
        secInput.value = seconds;

        // Focus the minutes input for easy modification if needed
        minInput.focus();
        minInput.select();

        showToast(`Loaded: ${minutes}:${seconds.toString().padStart(2, '0')}`, 'info');
    }

    addSet(exerciseIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const exerciseEntry = document.getElementById(`exercise-${exerciseIndex}`);
        const isDuration = exerciseEntry.getAttribute('data-exercise-type') === 'duration';

        let set;
        if (isDuration) {
            // Handle duration-based exercise
            const minInput = document.getElementById(`duration-min-${exerciseIndex}`);
            const secInput = document.getElementById(`duration-sec-${exerciseIndex}`);

            const minutes = parseInt(minInput.value) || 0;
            const seconds = parseInt(secInput.value) || 0;
            const totalSeconds = (minutes * 60) + seconds;

            if (totalSeconds === 0) {
                showToast('Please enter a duration', 'error');
                return;
            }

            set = new Set({ duration: totalSeconds, weight: 0, reps: 0, completed: true });

            // Keep values for next set
            minInput.value = minutes;
            secInput.value = seconds;
            minInput.focus();

            showToast('Set added!', 'success');
        } else {
            // Handle reps-based exercise
            const weightInput = document.getElementById(`weight-${exerciseIndex}`);
            const repsInput = document.getElementById(`reps-${exerciseIndex}`);

            const weight = parseFloat(weightInput.value);
            const reps = parseInt(repsInput.value);

            if (!weight || !reps) {
                showToast('Please enter weight and reps', 'error');
                return;
            }

            set = new Set({ weight, reps, completed: true });

            // Keep values for next set
            weightInput.value = weight;
            repsInput.value = reps;
            weightInput.focus();

            showToast('Set added!', 'success');
        }

        exercise.addSet(set);

        // Re-render completed sets
        document.getElementById(`completed-sets-${exerciseIndex}`).innerHTML =
            this.renderCompletedSets(exercise.sets, exerciseIndex);
    }

    editSet(exerciseIndex, setIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const set = exercise.sets[setIndex];

        // Show inline editing UI for this set
        const setElement = document.querySelector(`#completed-sets-${exerciseIndex} .completed-set:nth-child(${setIndex + 1})`);
        if (!setElement) return;

        const unit = this.app.settings.weightUnit;
        const isDuration = set.duration > 0;

        let editFormHTML;
        if (isDuration) {
            const mins = Math.floor(set.duration / 60);
            const secs = set.duration % 60;
            editFormHTML = `
                <div class="set-edit-form">
                    <span class="set-number">Round ${setIndex + 1}:</span>
                    <input type="number" class="set-edit-input duration-edit-min" id="edit-duration-min-${exerciseIndex}-${setIndex}" value="${mins}" min="0" placeholder="Min">
                    <span class="set-edit-x">:</span>
                    <input type="number" class="set-edit-input duration-edit-sec" id="edit-duration-sec-${exerciseIndex}-${setIndex}" value="${secs}" min="0" max="59" placeholder="Sec">
                </div>
            `;
        } else {
            editFormHTML = `
                <div class="set-edit-form">
                    <span class="set-number">Set ${setIndex + 1}:</span>
                    <input type="number" class="set-edit-input" id="edit-weight-${exerciseIndex}-${setIndex}" value="${set.weight}" step="0.5" min="0" placeholder="Weight">
                    <span class="set-edit-x">×</span>
                    <input type="number" class="set-edit-input" id="edit-reps-${exerciseIndex}-${setIndex}" value="${set.reps}" min="1" placeholder="Reps">
                </div>
            `;
        }

        setElement.innerHTML = `
            ${editFormHTML}
            <div class="set-actions">
                <button class="btn-set-action btn-set-save" onclick="window.gymApp.viewControllers.workout.saveSetEdit(${exerciseIndex}, ${setIndex})" title="Save">
                    <i class="fas fa-check"></i>
                </button>
                <button class="btn-set-action btn-set-cancel" onclick="window.gymApp.viewControllers.workout.cancelSetEdit(${exerciseIndex})" title="Cancel">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        // Focus the first input
        if (isDuration) {
            const minInput = document.getElementById(`edit-duration-min-${exerciseIndex}-${setIndex}`);
            minInput.focus();
            minInput.select();
        } else {
            const weightInput = document.getElementById(`edit-weight-${exerciseIndex}-${setIndex}`);
            weightInput.focus();
            weightInput.select();
        }
    }

    saveSetEdit(exerciseIndex, setIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const set = exercise.sets[setIndex];
        const isDuration = set.duration > 0;

        if (isDuration) {
            // Handle duration-based set
            const minInput = document.getElementById(`edit-duration-min-${exerciseIndex}-${setIndex}`);
            const secInput = document.getElementById(`edit-duration-sec-${exerciseIndex}-${setIndex}`);

            const minutes = parseInt(minInput.value) || 0;
            const seconds = parseInt(secInput.value) || 0;
            const totalSeconds = (minutes * 60) + seconds;

            if (totalSeconds === 0) {
                showToast('Please enter a valid duration', 'error');
                return;
            }

            // Update the set
            set.duration = totalSeconds;
        } else {
            // Handle reps-based set
            const weightInput = document.getElementById(`edit-weight-${exerciseIndex}-${setIndex}`);
            const repsInput = document.getElementById(`edit-reps-${exerciseIndex}-${setIndex}`);

            const weight = parseFloat(weightInput.value);
            const reps = parseInt(repsInput.value);

            if (!weight || !reps) {
                showToast('Please enter valid weight and reps', 'error');
                return;
            }

            // Update the set
            set.weight = weight;
            set.reps = reps;
        }

        // Re-render completed sets
        document.getElementById(`completed-sets-${exerciseIndex}`).innerHTML =
            this.renderCompletedSets(exercise.sets, exerciseIndex);

        showToast('Set updated!', 'success');
    }

    cancelSetEdit(exerciseIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];

        // Re-render completed sets to cancel edit
        document.getElementById(`completed-sets-${exerciseIndex}`).innerHTML =
            this.renderCompletedSets(exercise.sets, exerciseIndex);
    }

    deleteSet(exerciseIndex, setIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];

        // Remove the set
        exercise.sets.splice(setIndex, 1);

        // Re-render completed sets
        document.getElementById(`completed-sets-${exerciseIndex}`).innerHTML =
            this.renderCompletedSets(exercise.sets, exerciseIndex);

        showToast('Set deleted', 'success');
    }

    updateWorkoutTimer(elapsed) {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('workout-time').textContent =
            `${minutes}:${String(seconds).padStart(2, '0')}`;
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
            `${Math.round(this.currentWorkoutSession.totalVolume)} ${unit}`;
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

        // Update achievements
        this.app.updateAchievements();

        // Stop timer
        timerService.stopWorkoutTimer();

        // Close modal and reset
        document.getElementById('finish-workout-modal').classList.remove('active');
        document.getElementById('active-workout').classList.remove('active');
        document.getElementById('workout-selection').classList.add('active');

        this.currentWorkoutSession = null;

        showToast('Workout completed! Great job! 💪', 'success', 5000);
        this.render();
    }

    async endWorkout() {
        const confirmed = await showConfirmModal({
            title: 'End Workout',
            message: 'Are you sure you want to end this workout?<br><br><strong>Your progress will not be saved.</strong>',
            confirmText: 'End Workout',
            cancelText: 'Continue Workout',
            isDangerous: true
        });

        if (confirmed) {
            timerService.stopWorkoutTimer();
            document.getElementById('active-workout').classList.remove('active');
            document.getElementById('workout-selection').classList.add('active');
            this.currentWorkoutSession = null;
            this.render();
            showToast('Workout ended', 'info');
        }
    }
}

// Initialize
new WorkoutView();
