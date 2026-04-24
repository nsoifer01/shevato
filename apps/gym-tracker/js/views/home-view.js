/**
 * Home View Controller
 * Dashboard and overview
 */
import { app } from '../app.js';
import { storageService } from '../services/StorageService.js';
import { formatDate, formatWeight, showConfirmModal, showToast, formatSessionDateTime, parseLocalDate } from '../utils/helpers.js';
import { orderPrograms } from '../utils/program-order.js';
import { renderPausedBannerHTML, wirePausedBannerActions } from './paused-banner.js';
import { AnalyticsService } from '../services/AnalyticsService.js';

class HomeView {
    constructor() {
        this.app = app;
        this.init();
    }

    init() {
        this.app.viewControllers.home = this;
        this.wireFab();
    }

    wireFab() {
        const fab = document.getElementById('home-workout-fab');
        if (!fab || fab.dataset.wired) return;
        fab.addEventListener('click', () => this.handleFabClick());
        fab.dataset.wired = '1';
    }

    render() {
        this.renderPausedWorkoutBanner();
        this.renderActiveProgram();
        this.renderWeekSummary();
        this.renderRecentWorkouts();
        this.renderRecentAchievements();
        this.renderFab();
    }

    /**
     * Render the "This Week" tile grid. Hidden entirely when the user has
     * no sessions at all (nothing to aggregate → no signal worth showing).
     */
    renderWeekSummary() {
        const section = document.getElementById('week-summary-section');
        const grid = document.getElementById('week-summary-grid');
        const caption = document.getElementById('week-summary-caption');
        if (!section || !grid) return;

        if (this.app.workoutSessions.length === 0) {
            section.hidden = true;
            return;
        }
        section.hidden = false;

        const stats = AnalyticsService.getWeekStats(this.app.workoutSessions);
        const unit = this.app.settings.weightUnit;

        const fmtDelta = (n, { positiveBetter = true, suffix = '' } = {}) => {
            if (n === 0) return '<span class="week-tile-delta">— vs last week</span>';
            const isUp = n > 0;
            const isGood = positiveBetter ? isUp : !isUp;
            const klass = isGood ? 'is-up' : 'is-down';
            const sign = isUp ? '+' : '';
            return `<span class="week-tile-delta ${klass}">${sign}${n.toLocaleString()}${suffix} vs last week</span>`;
        };

        const hours = Math.floor(stats.durationMin / 60);
        const mins = stats.durationMin % 60;
        const durationValue = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        grid.innerHTML = `
            <div class="week-tile">
                <span class="week-tile-label">Workouts</span>
                <span class="week-tile-value">${stats.workouts}</span>
                ${fmtDelta(stats.workoutsDelta)}
            </div>
            <div class="week-tile">
                <span class="week-tile-label">Volume</span>
                <span class="week-tile-value">${Math.round(stats.volume).toLocaleString()} ${unit}</span>
                ${fmtDelta(Math.round(stats.volumeDelta), { suffix: ` ${unit}` })}
            </div>
            <div class="week-tile">
                <span class="week-tile-label">Time</span>
                <span class="week-tile-value">${durationValue}</span>
                <span class="week-tile-delta">this week</span>
            </div>
            <div class="week-tile">
                <span class="week-tile-label">Streak</span>
                <span class="week-tile-value">${stats.streak} ${stats.streak === 1 ? 'day' : 'days'}</span>
                <span class="week-tile-delta">${stats.streak > 0 ? '🔥 keep it going' : 'log today to start'}</span>
            </div>
        `;

        if (caption) {
            // parseLocalDate avoids the UTC shift that `new Date("YYYY-MM-DD")`
            // introduces, so the Monday we computed is the Monday we render.
            const startDate = parseLocalDate(stats.weekStart);
            caption.textContent = `Week of ${startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
        }
    }

    /**
     * The FAB has three states:
     *   - Hidden when there are no programs yet (nothing to start).
     *   - "Resume workout" (green) when a paused session exists.
     *   - "Start workout" (primary) otherwise.
     * Clicking either state jumps to the workout view; resume re-hydrates.
     */
    renderFab() {
        const fab = document.getElementById('home-workout-fab');
        if (!fab) return;
        const hasPrograms = this.app.programs.length > 0;
        const paused = storageService.getActiveWorkout();

        if (!hasPrograms) {
            fab.hidden = true;
            return;
        }

        fab.hidden = false;
        const label = fab.querySelector('.workout-fab-label');
        const icon = fab.querySelector('i');

        if (paused && paused.paused) {
            fab.classList.add('workout-fab--resume');
            if (label) label.textContent = 'Resume workout';
            if (icon) {
                icon.classList.remove('fa-play');
                icon.classList.add('fa-play-circle');
            }
            fab.setAttribute('aria-label', 'Resume paused workout');
        } else {
            fab.classList.remove('workout-fab--resume');
            if (label) label.textContent = 'Start workout';
            if (icon) {
                icon.classList.remove('fa-play-circle');
                icon.classList.add('fa-play');
            }
            fab.setAttribute('aria-label', 'Start workout');
        }
    }

    /**
     * If paused → go to workout view and let it resume automatically.
     * If exactly one program → auto-start it.
     * Otherwise → route to the workout view's program picker.
     */
    handleFabClick() {
        const paused = storageService.getActiveWorkout();
        if (paused && paused.paused) {
            this.resumeWorkout();
            return;
        }
        if (this.app.programs.length === 1) {
            const only = this.app.programs[0];
            if (only.exercises && only.exercises.length > 0) {
                this.startWorkoutWithProgram(only.id);
                return;
            }
        }
        this.app.showView('workout');
    }

    renderPausedWorkoutBanner() {
        const container = document.getElementById('active-program-card');

        // Remove any existing banner first
        const existingBanner = document.querySelector('.paused-workout-banner');
        if (existingBanner) existingBanner.remove();

        const bannerHTML = renderPausedBannerHTML({ location: 'home', withCalendarMeta: false });
        if (!bannerHTML) return;

        container.insertAdjacentHTML('beforebegin', bannerHTML);
        const banner = document.querySelector('.paused-workout-banner');
        wirePausedBannerActions(banner, {
            onResume: () => this.resumeWorkout(),
            onDiscard: () => this.discardPausedWorkout(),
        });
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
        }
    }

    renderActiveProgram() {
        const container = document.getElementById('active-program-card');
        // Use the same sort mode + saved drag-order as the Programs page
        const sortMode = storageService.getProgramSort() || 'custom';
        const savedOrder = storageService.getProgramOrder() || [];
        const programs = orderPrograms(this.app.programs, sortMode, savedOrder);
        const pausedWorkout = storageService.getActiveWorkout();

        if (programs.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-folder-open"></i>
                    <p>No programs yet</p>
                    <button type="button" class="btn btn-primary" data-home-action="create-program">Create Program</button>
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
                                <div class="quick-program-item is-empty" onclick="window.gymApp.viewControllers.programs.editProgram(${program.id})" title="Add exercises to this program">
                                    <div class="program-info">
                                        <strong>${program.name}</strong>
                                        <span>0 exercises · Tap to add</span>
                                    </div>
                                    <i class="fas fa-edit"></i>
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
        // Full-timestamp sort so same-day sessions order by time-of-day.
        const recentSessions = [...this.app.workoutSessions]
            .sort((a, b) => new Date(b.sortTimestamp) - new Date(a.sortTimestamp))
            .slice(0, 5);

        if (recentSessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-dumbbell"></i>
                    <p>No workouts yet</p>
                    <button type="button" class="btn btn-primary" data-home-action="start-workout">Start Workout</button>
                </div>
            `;
            return;
        }

        const unit = this.app.settings.weightUnit;
        container.innerHTML = recentSessions.map(session => `
            <div class="workout-card clickable" onclick="window.gymApp.viewControllers.home.showWorkoutDetails(${session.id})">
                <div class="workout-card-header">
                    <h4>${session.workoutDayName}</h4>
                    <span class="date">${formatSessionDateTime(session)}</span>
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
