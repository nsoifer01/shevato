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
            const previousSets = this.getPreviousExerciseData(exercise.exerciseId);
            const unit = this.app.settings.weightUnit;

            let previousDataHTML = '<strong>Last time:</strong> ';
            if (previousSets && previousSets.length > 0) {
                previousDataHTML += previousSets.map((set, i) =>
                    `Set ${i + 1}: ${set.weight}${unit} × ${set.reps}`
                ).join(' | ');
            } else {
                previousDataHTML += 'No previous data';
            }

            // Pre-fill with first set data if available
            const firstSet = previousSets && previousSets.length > 0 ? previousSets[0] : null;

            return `
                <div class="exercise-entry" id="exercise-${index}">
                    <div class="exercise-entry-header">
                        <h3>${exercise.exerciseName}</h3>
                    </div>

                    <div class="previous-data">
                        ${previousDataHTML}
                    </div>

                    <div class="set-inputs">
                        <input type="number" placeholder="Weight" id="weight-${index}" step="0.5" min="0" ${firstSet ? `value="${firstSet.weight}"` : ''}>
                        <input type="number" placeholder="Reps" id="reps-${index}" min="1" ${firstSet ? `value="${firstSet.reps}"` : ''}>
                        <button onclick="window.gymApp.viewControllers.workout.addSet(${index})">Add Set</button>
                    </div>

                    <div class="completed-sets" id="completed-sets-${index}">
                        ${this.renderCompletedSets(exercise.sets)}
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

    renderCompletedSets(sets) {
        if (sets.length === 0) return '<p class="text-muted">No sets completed</p>';

        return sets.map((set, index) => `
            <div class="completed-set">
                <span>Set ${index + 1}: ${set.weight}kg × ${set.reps}</span>
                <span>Volume: ${set.volume}kg</span>
            </div>
        `).join('');
    }

    addSet(exerciseIndex) {
        if (!this.currentWorkoutSession) return;

        const exercise = this.currentWorkoutSession.exercises[exerciseIndex];
        const weightInput = document.getElementById(`weight-${exerciseIndex}`);
        const repsInput = document.getElementById(`reps-${exerciseIndex}`);

        const weight = parseFloat(weightInput.value);
        const reps = parseInt(repsInput.value);

        if (!weight || !reps) {
            showToast('Please enter weight and reps', 'error');
            return;
        }

        const set = new Set({ weight, reps, completed: true });
        exercise.addSet(set);

        // Keep values for next set
        weightInput.value = weight;
        repsInput.value = reps;
        weightInput.focus();

        // Re-render completed sets
        document.getElementById(`completed-sets-${exerciseIndex}`).innerHTML =
            this.renderCompletedSets(exercise.sets);

        showToast('Set added!', 'success');
    }

    updateWorkoutTimer(elapsed) {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('workout-time').textContent =
            `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    openFinishWorkoutModal() {
        if (!this.currentWorkoutSession) return;

        // Update summary
        const duration = timerService.getWorkoutElapsed();
        const minutes = Math.floor(duration / 60);

        document.getElementById('summary-duration').textContent = `${minutes} min`;
        document.getElementById('summary-volume').textContent =
            `${Math.round(this.currentWorkoutSession.totalVolume)} kg`;
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
