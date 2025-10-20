/**
 * Home View Controller
 * Dashboard and overview
 */
import { app } from '../app.js';
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
        this.renderActiveProgram();
        this.renderRecentWorkouts();
        this.renderRecentAchievements();
    }

    renderActiveProgram() {
        const container = document.getElementById('active-program-card');
        const programs = this.app.programs;

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
                    ${programs.slice(0, 3).map(program => `
                        <div class="quick-program-item" ${program.exercises.length > 0 ? `onclick="window.gymApp.viewControllers.home.startWorkoutWithProgram(${program.id})"` : ''}>
                            <div class="program-info">
                                <strong>${program.name}</strong>
                                <span class="text-muted">${program.exercises.length} exercises</span>
                            </div>
                            ${program.exercises.length > 0 ? '<i class="fas fa-play-circle"></i>' : '<i class="fas fa-edit" onclick="event.stopPropagation(); window.gymApp.viewControllers.programs.editProgram(' + program.id + ')"></i>'}
                        </div>
                    `).join('')}
                </div>
                ${programs.length > 3 ? '<button class="btn btn-secondary btn-small" data-view="workout">View All Programs</button>' : ''}
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
                        ${Math.round(session.totalVolume)}${unit}
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

    startWorkoutWithProgram(programId) {
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
