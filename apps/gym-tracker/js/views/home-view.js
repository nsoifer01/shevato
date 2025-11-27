/**
 * Home View Controller
 * Dashboard and overview
 */
import { app } from '../app.js';
import { storageService } from '../services/StorageService.js';
import { formatDate, formatWeight } from '../utils/helpers.js';

class HomeView {
    constructor() {
        this.app = app;
        this.init();
    }

    init() {
        this.app.viewControllers.home = this;
    }

    render() {
        this.renderPausedWorkoutBanner();
        this.renderActiveProgram();
        this.renderRecentWorkouts();
        this.renderRecentAchievements();
    }

    renderPausedWorkoutBanner() {
        const container = document.getElementById('active-program-card');
        const pausedWorkout = storageService.getActiveWorkout();

        // Remove any existing banner first
        const existingBanner = document.querySelector('.paused-workout-banner');
        if (existingBanner) {
            existingBanner.remove();
        }

        if (!pausedWorkout || !pausedWorkout.paused) {
            return;
        }

        const pausedAt = new Date(pausedWorkout.pausedAt);
        const elapsed = pausedWorkout.elapsedBeforePause;
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;

        // Count total sets saved
        const totalSets = pausedWorkout.exercises.reduce((sum, ex) =>
            sum + (ex.sets ? ex.sets.length : 0), 0
        );

        const bannerHTML = `
            <div class="paused-workout-banner">
                <div class="paused-workout-icon">
                    <i class="fas fa-pause-circle"></i>
                </div>
                <div class="paused-workout-info">
                    <h3>Paused Workout</h3>
                    <p><strong>${pausedWorkout.workoutDayName}</strong></p>
                    <p class="paused-workout-meta">
                        <span><i class="fas fa-clock"></i> ${minutes}:${String(seconds).padStart(2, '0')} elapsed</span>
                        <span><i class="fas fa-dumbbell"></i> ${totalSets} set${totalSets !== 1 ? 's' : ''}</span>
                    </p>
                </div>
                <div class="paused-workout-actions">
                    <button class="btn btn-primary" onclick="window.gymApp.viewControllers.home.resumeWorkout()">
                        <i class="fas fa-play"></i> Resume
                    </button>
                    <button class="btn btn-outline btn-danger-outline" onclick="window.gymApp.viewControllers.home.discardPausedWorkout()">
                        <i class="fas fa-trash"></i> Discard
                    </button>
                </div>
            </div>
        `;

        // Insert banner before the container
        container.insertAdjacentHTML('beforebegin', bannerHTML);
    }

    resumeWorkout() {
        this.app.showView('workout');
        setTimeout(() => {
            if (this.app.viewControllers.workout) {
                this.app.viewControllers.workout.resumeWorkout();
            }
        }, 100);
    }

    async discardPausedWorkout() {
        const { showConfirmModal } = await import('../utils/helpers.js');
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
            const { showToast } = await import('../utils/helpers.js');
            showToast('Paused workout discarded', 'info');
        }
    }

    renderActiveProgram() {
        const container = document.getElementById('active-program-card');
        const programs = this.app.programs;
        const pausedWorkout = storageService.getActiveWorkout();

        if (programs.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-folder-open"></i>
                    <p>No programs yet</p>
                    <button class="btn btn-primary" data-view="programs">Create Program</button>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="program-summary">
                <h3>Your Programs</h3>
                <div class="quick-programs">
                    ${programs.map(program => {
                        const isPaused = pausedWorkout && pausedWorkout.paused && pausedWorkout.programId === program.id;
                        const hasExercises = program.exercises.length > 0;

                        if (isPaused) {
                            return `
                                <div class="quick-program-item paused" onclick="window.gymApp.viewControllers.home.resumeWorkout()">
                                    <div class="program-info">
                                        <strong>${program.name}</strong>
                                        <span class="paused-label"><i class="fas fa-pause"></i> Paused</span>
                                    </div>
                                    <i class="fas fa-play-circle"></i>
                                </div>
                            `;
                        } else if (hasExercises) {
                            return `
                                <div class="quick-program-item" onclick="window.gymApp.viewControllers.home.startWorkoutWithProgram(${program.id})">
                                    <div class="program-info">
                                        <strong>${program.name}</strong>
                                        <span>${program.exercises.length} exercises</span>
                                    </div>
                                    <i class="fas fa-play-circle"></i>
                                </div>
                            `;
                        } else {
                            return `
                                <div class="quick-program-item">
                                    <div class="program-info">
                                        <strong>${program.name}</strong>
                                        <span>${program.exercises.length} exercises</span>
                                    </div>
                                    <i class="fas fa-edit" onclick="event.stopPropagation(); window.gymApp.viewControllers.programs.editProgram(${program.id})"></i>
                                </div>
                            `;
                        }
                    }).join('')}
                </div>
            </div>
        `;
    }

    renderRecentWorkouts() {
        const container = document.getElementById('recent-workouts');
        const recentSessions = [...this.app.workoutSessions]
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5);

        if (recentSessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-dumbbell"></i>
                    <p>No workouts yet</p>
                    <button class="btn btn-primary" data-view="workout">Start Workout</button>
                </div>
            `;
            return;
        }

        const unit = this.app.settings.weightUnit;
        container.innerHTML = recentSessions.map(session => `
            <div class="workout-card clickable" onclick="window.gymApp.viewControllers.home.showWorkoutDetails(${session.id})">
                <div class="workout-card-header">
                    <h4>${session.workoutDayName}</h4>
                    <span class="date">${formatDate(session.date)}</span>
                </div>
                <div class="workout-card-stats">
                    <div class="stat">
                        <i class="fas fa-weight"></i>
                        ${Math.round(session.totalVolume).toLocaleString()}${unit}
                    </div>
                    <div class="stat">
                        <i class="fas fa-list"></i>
                        ${session.exercises.length} exercises
                    </div>
                    ${session.duration ? `
                        <div class="stat">
                            <i class="fas fa-clock"></i>
                            ${session.duration} min
                        </div>
                    ` : ''}
                </div>
            </div>
        `).join('');
    }

    showWorkoutDetails(sessionId) {
        // Navigate to history view and show the workout details
        this.app.showView('history');
        // Small delay to ensure view is rendered
        setTimeout(() => {
            if (this.app.viewControllers.history) {
                this.app.viewControllers.history.showWorkoutDetails(sessionId);
            }
        }, 100);
    }

    renderRecentAchievements() {
        const container = document.getElementById('recent-achievements');
        const unlockedAchievements = this.app.achievements
            .filter(a => a.unlocked)
            .sort((a, b) => new Date(b.unlockedAt) - new Date(a.unlockedAt))
            .slice(0, 3);

        if (unlockedAchievements.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-trophy"></i>
                    <p>No achievements unlocked yet</p>
                </div>
            `;
            return;
        }

        container.innerHTML = unlockedAchievements.map(achievement => `
            <div class="achievement-card unlocked">
                <div class="achievement-icon">${achievement.icon}</div>
                <div class="achievement-info">
                    <h3>${achievement.name}</h3>
                    <p>${achievement.description}</p>
                    <small>Unlocked ${formatDate(achievement.unlockedAt)}</small>
                </div>
            </div>
        `).join('');
    }

    async startWorkoutWithProgram(programId) {
        const pausedWorkout = storageService.getActiveWorkout();

        // Check if there's a paused workout
        if (pausedWorkout && pausedWorkout.paused) {
            const { showConfirmModal } = await import('../utils/helpers.js');
            const confirmed = await showConfirmModal({
                title: 'Workout In Progress',
                message: `You have a paused workout "<strong>${pausedWorkout.workoutDayName}</strong>" with saved progress.<br><br>Starting a new workout will <strong>discard</strong> your paused workout.<br><br>Do you want to continue?`,
                confirmText: 'Start New Workout',
                cancelText: 'Cancel',
                isDangerous: true
            });

            if (!confirmed) {
                return;
            }

            // Clear the paused workout
            storageService.clearActiveWorkout();
        }

        // Navigate to workout view and start the workout
        this.app.showView('workout');
        // Small delay to ensure view is rendered
        setTimeout(() => {
            if (this.app.viewControllers.workout) {
                this.app.viewControllers.workout.startWorkout(programId);
            }
        }, 100);
    }
}

// Initialize
new HomeView();
