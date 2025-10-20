/**
 * History View Controller
 */
import { app } from '../app.js';
import { formatDate, showToast, showConfirmModal } from '../utils/helpers.js';

class HistoryView {
    constructor() {
        this.app = app;
        this.init();
    }

    init() {
        this.app.viewControllers.history = this;
        this.currentSort = 'date-desc';
        this.dateFrom = null;
        this.dateTo = null;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Modal close button
        const modalCloseBtn = document.querySelector('#workout-detail-modal .modal-close');
        if (modalCloseBtn) {
            modalCloseBtn.addEventListener('click', () => {
                document.getElementById('workout-detail-modal').classList.remove('active');
            });
        }

        // Sort dropdown
        const sortSelect = document.getElementById('history-sort');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.currentSort = e.target.value;
                this.render();
            });
        }

        // Date filters
        const dateFromInput = document.getElementById('history-date-from');
        const dateToInput = document.getElementById('history-date-to');

        if (dateFromInput) {
            dateFromInput.addEventListener('change', (e) => {
                this.dateFrom = e.target.value;
                this.render();
            });
        }

        if (dateToInput) {
            dateToInput.addEventListener('change', (e) => {
                this.dateTo = e.target.value;
                this.render();
            });
        }

        // Clear filters button
        const clearBtn = document.getElementById('clear-filters-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.dateFrom = null;
                this.dateTo = null;
                if (dateFromInput) dateFromInput.value = '';
                if (dateToInput) dateToInput.value = '';
                this.render();
            });
        }
    }

    render() {
        this.renderHistoryList();
    }

    renderHistoryList() {
        const container = document.getElementById('history-list');
        let sessions = [...this.app.workoutSessions];

        // Apply date filters
        if (this.dateFrom) {
            sessions = sessions.filter(session => session.date >= this.dateFrom);
        }
        if (this.dateTo) {
            sessions = sessions.filter(session => session.date <= this.dateTo);
        }

        // Apply sorting
        sessions.sort((a, b) => {
            switch (this.currentSort) {
                case 'date-asc':
                    return new Date(a.date) - new Date(b.date);
                case 'date-desc':
                    return new Date(b.date) - new Date(a.date);
                case 'volume-desc':
                    return b.totalVolume - a.totalVolume;
                default:
                    return new Date(b.date) - new Date(a.date);
            }
        });

        if (sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-dumbbell"></i>
                    <p>No workout history yet</p>
                    <button class="btn btn-primary" data-view="workout">Start Workout</button>
                </div>
            `;
            return;
        }

        const unit = this.app.settings.weightUnit;
        container.innerHTML = sessions.map(session => {
            // Check for additional metrics
            const hasAdditionalMetrics = session.avgHeartRate || session.maxHeartRate || session.caloriesBurned;

            return `
                <div class="workout-card clickable" onclick="window.gymApp.viewControllers.history.showWorkoutDetails(${session.id})">
                    <div class="workout-card-header">
                        <div class="workout-header-info">
                            <h3>${session.workoutDayName}</h3>
                            <span class="date">${formatDate(session.date)}</span>
                        </div>
                        <button class="btn-icon delete-workout-btn" onclick="event.stopPropagation(); window.gymApp.viewControllers.history.deleteWorkout(${session.id})" title="Delete workout">
                            <i class="fas fa-trash"></i>
                        </button>
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
                        <div class="stat">
                            <i class="fas fa-chart-bar"></i>
                            ${session.totalSets} sets
                        </div>
                        ${session.duration ? `
                            <div class="stat">
                                <i class="fas fa-clock"></i>
                                ${session.duration} min
                            </div>
                        ` : ''}
                    </div>
                    ${hasAdditionalMetrics ? `
                        <div class="workout-card-additional-stats">
                            ${session.avgHeartRate ? `
                                <div class="additional-stat">
                                    <i class="fas fa-heartbeat"></i>
                                    Avg HR: ${session.avgHeartRate} bpm
                                </div>
                            ` : ''}
                            ${session.maxHeartRate ? `
                                <div class="additional-stat">
                                    <i class="fas fa-heart"></i>
                                    Max HR: ${session.maxHeartRate} bpm
                                </div>
                            ` : ''}
                            ${session.caloriesBurned ? `
                                <div class="additional-stat">
                                    <i class="fas fa-fire"></i>
                                    ${session.caloriesBurned} cal
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                    ${session.notes ? `<p class="workout-notes">${session.notes}</p>` : ''}
                </div>
            `;
        }).join('');
    }

    showWorkoutDetails(sessionId) {
        const session = this.app.workoutSessions.find(s => s.id === sessionId);
        if (!session) return;

        const unit = this.app.settings.weightUnit;
        const modal = document.getElementById('workout-detail-modal');
        const title = document.getElementById('workout-detail-title');
        const content = document.getElementById('workout-detail-content');

        title.textContent = session.workoutDayName;

        // Build the detailed content
        let html = `
            <div class="workout-detail-summary">
                <div class="detail-date">${formatDate(session.date)}</div>
                <div class="detail-stats">
                    <div class="detail-stat">
                        <span class="label">Duration</span>
                        <span class="value">${session.duration || 0} min</span>
                    </div>
                    <div class="detail-stat">
                        <span class="label">Total Volume</span>
                        <span class="value">${Math.round(session.totalVolume)}${unit}</span>
                    </div>
                    <div class="detail-stat">
                        <span class="label">Total Sets</span>
                        <span class="value">${session.totalSets}</span>
                    </div>
                    <div class="detail-stat">
                        <span class="label">Exercises</span>
                        <span class="value">${session.exercises.length}</span>
                    </div>
                </div>
            </div>

            <h3>Exercises</h3>
            <div class="workout-detail-exercises">
        `;

        session.exercises.forEach(exercise => {
            const exerciseData = this.app.getExerciseById(exercise.exerciseId);
            const exerciseName = exerciseData ? exerciseData.name : exercise.exerciseName || 'Unknown Exercise';
            const completedSets = exercise.sets ? exercise.sets.filter(s => s.completed) : [];

            if (completedSets.length > 0) {
                html += `
                    <div class="detail-exercise">
                        <h4>${exerciseName}</h4>
                        <table class="sets-table">
                            <thead>
                                <tr>
                                    <th>Set</th>
                                    <th>Weight</th>
                                    <th>Reps</th>
                                    <th>Volume</th>
                                </tr>
                            </thead>
                            <tbody>
                `;

                completedSets.forEach((set, index) => {
                    html += `
                        <tr>
                            <td>${index + 1}</td>
                            <td>${set.weight}${unit}</td>
                            <td>${set.reps}</td>
                            <td>${Math.round(set.volume)}${unit}</td>
                        </tr>
                    `;
                });

                html += `
                            </tbody>
                        </table>
                    </div>
                `;
            }
        });

        html += '</div>';

        // Add additional metrics if available
        if (session.avgHeartRate || session.maxHeartRate || session.caloriesBurned) {
            html += `
                <h3>Additional Metrics</h3>
                <div class="detail-stats">
            `;
            if (session.avgHeartRate) {
                html += `
                    <div class="detail-stat">
                        <span class="label">Avg Heart Rate</span>
                        <span class="value">${session.avgHeartRate} bpm</span>
                    </div>
                `;
            }
            if (session.maxHeartRate) {
                html += `
                    <div class="detail-stat">
                        <span class="label">Max Heart Rate</span>
                        <span class="value">${session.maxHeartRate} bpm</span>
                    </div>
                `;
            }
            if (session.caloriesBurned) {
                html += `
                    <div class="detail-stat">
                        <span class="label">Calories Burned</span>
                        <span class="value">${session.caloriesBurned} cal</span>
                    </div>
                `;
            }
            html += '</div>';
        }

        // Add notes if available
        if (session.notes) {
            html += `
                <h3>Notes</h3>
                <p class="workout-detail-notes">${session.notes}</p>
            `;
        }

        content.innerHTML = html;
        modal.classList.add('active');
    }

    async deleteWorkout(sessionId) {
        const session = this.app.workoutSessions.find(s => s.id === sessionId);
        if (!session) return;

        const message = `Are you sure you want to delete this workout?<br><br><strong>${session.workoutDayName}</strong><br>${formatDate(session.date)}<br><br>This workout included ${session.exercises.length} exercise${session.exercises.length !== 1 ? 's' : ''} and ${Math.round(session.totalVolume)}${this.app.settings.weightUnit} total volume.<br><br><strong>This action cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Delete Workout',
            message: message,
            confirmText: 'Delete Workout',
            cancelText: 'Cancel',
            isDangerous: true
        });

        if (confirmed) {
            const index = this.app.workoutSessions.findIndex(s => s.id === sessionId);
            if (index >= 0) {
                this.app.workoutSessions.splice(index, 1);
                this.app.saveWorkoutSessions();

                // Update achievements since workout data changed
                this.app.updateAchievements();

                // Re-render the list
                this.render();

                // Show confirmation
                showToast('Workout deleted', 'info');
            }
        }
    }
}

// Initialize
new HistoryView();
