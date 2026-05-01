/**
 * History View Controller
 */
import { app } from '../app.js';
import { formatDate, showToast, showConfirmModal, formatSessionDateTime, escapeHtml } from '../utils/helpers.js';
import { DarkCalendar } from '../utils/dark-calendar.js';
import { DarkSelect } from '../utils/dark-select.js';

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
            modalCloseBtn.addEventListener('click', () => this.closeWorkoutDetailModal());
        }

        // Sort dropdown — wrap with DarkSelect for consistent styling
        const sortSelect = document.getElementById('history-sort');
        if (sortSelect) {
            if (!sortSelect.dataset.darkSelectInit) {
                this.sortDropdown = new DarkSelect(sortSelect);
                sortSelect.dataset.darkSelectInit = '1';
            }
            sortSelect.addEventListener('change', (e) => {
                this.currentSort = e.target.value;
                this.render();
            });
        }

        // Date filters — wrap native inputs with the dark calendar widget
        const dateFromInput = document.getElementById('history-date-from');
        const dateToInput = document.getElementById('history-date-to');

        if (dateFromInput && !dateFromInput.dataset.darkCalendarInit) {
            this.fromCalendar = new DarkCalendar(dateFromInput, { role: 'from' });
            dateFromInput.dataset.darkCalendarInit = '1';
            dateFromInput.addEventListener('change', (e) => {
                this.dateFrom = e.target.value || null;
                this.render();
            });
        }
        if (dateToInput && !dateToInput.dataset.darkCalendarInit) {
            this.toCalendar = new DarkCalendar(dateToInput, { role: 'to' });
            dateToInput.dataset.darkCalendarInit = '1';
            dateToInput.addEventListener('change', (e) => {
                this.dateTo = e.target.value || null;
                this.render();
            });
        }
        // Link the two calendars so they share range-selection state
        if (this.fromCalendar && this.toCalendar) {
            this.fromCalendar.rangePartner = this.toCalendar;
            this.toCalendar.rangePartner = this.fromCalendar;
        }

        // Clear filters button
        const clearBtn = document.getElementById('clear-filters-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.dateFrom = null;
                this.dateTo = null;
                if (this.fromCalendar) this.fromCalendar.clearDate();
                else if (dateFromInput) dateFromInput.value = '';
                if (this.toCalendar) this.toCalendar.clearDate();
                else if (dateToInput) dateToInput.value = '';
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

        // Apply sorting. Date-asc/date-desc use the full session timestamp so
        // two workouts on the same calendar day are ordered by time-of-day.
        sessions.sort((a, b) => {
            switch (this.currentSort) {
                case 'date-asc':
                    return new Date(a.sortTimestamp) - new Date(b.sortTimestamp);
                case 'date-desc':
                    return new Date(b.sortTimestamp) - new Date(a.sortTimestamp);
                case 'volume-desc':
                    return b.totalVolume - a.totalVolume;
                default:
                    return new Date(b.sortTimestamp) - new Date(a.sortTimestamp);
            }
        });

        if (sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-dumbbell"></i>
                    <p>No workout history yet</p>
                    <button type="button" class="btn btn-primary" data-home-action="start-workout">Start Workout</button>
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
                            <h3>${escapeHtml(session.workoutDayName)}</h3>
                            <span class="date">${formatSessionDateTime(session)}</span>
                        </div>
                        <button class="btn-icon delete-workout-btn" onclick="event.stopPropagation(); window.gymApp.viewControllers.history.deleteWorkout(${session.id})" title="Delete workout" aria-label="Delete workout">
                            <i class="fas fa-trash"></i>
                        </button>
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
                    ${session.notes ? `<p class="workout-notes">${escapeHtml(session.notes)}</p>` : ''}
                </div>
            `;
        }).join('');
    }

    /**
     * Close the Workout Detail modal. If the modal was opened from another
     * view (e.g. the Calendar's selected-day panel sets `this.returnToView`),
     * navigate back there so the caller returns to its original context.
     */
    closeWorkoutDetailModal() {
        document.getElementById('workout-detail-modal').classList.remove('active');
        if (this.returnToView) {
            const target = this.returnToView;
            this.returnToView = null;
            this.app.showView(target);
        }
    }

    showWorkoutDetails(sessionId) {
        const session = this.app.workoutSessions.find(s => s.id === sessionId);
        if (!session) return;

        const unit = this.app.settings.weightUnit;
        const modal = document.getElementById('workout-detail-modal');
        const title = document.getElementById('workout-detail-title');
        const content = document.getElementById('workout-detail-content');

        title.textContent = session.workoutDayName;

        // Build the Additional Metrics block up front so it can render
        // just below the summary (more prominent, no scrolling). Empty
        // when the user didn't record any — keeps the modal tight.
        let additionalMetricsHTML = '';
        if (session.avgHeartRate || session.maxHeartRate || session.caloriesBurned) {
            let metricsInner = '';
            if (session.avgHeartRate) {
                metricsInner += `
                    <div class="detail-stat">
                        <span class="label">Avg Heart Rate</span>
                        <span class="value">${session.avgHeartRate} bpm</span>
                    </div>
                `;
            }
            if (session.maxHeartRate) {
                metricsInner += `
                    <div class="detail-stat">
                        <span class="label">Max Heart Rate</span>
                        <span class="value">${session.maxHeartRate} bpm</span>
                    </div>
                `;
            }
            if (session.caloriesBurned) {
                metricsInner += `
                    <div class="detail-stat">
                        <span class="label">Calories Burned</span>
                        <span class="value">${session.caloriesBurned} cal</span>
                    </div>
                `;
            }
            additionalMetricsHTML = `
                <section class="workout-detail-metrics">
                    <h3>Additional Metrics</h3>
                    <div class="detail-stats">${metricsInner}</div>
                </section>
            `;
        }

        // Build the detailed content
        let html = `
            <div class="workout-detail-summary">
                <div class="detail-date">${formatSessionDateTime(session)}</div>
                <div class="detail-stats">
                    <div class="detail-stat">
                        <span class="label">Duration</span>
                        <span class="value">${session.duration || 0} min</span>
                    </div>
                    <div class="detail-stat">
                        <span class="label">Total Volume</span>
                        <span class="value">${Math.round(session.totalVolume).toLocaleString()}${unit}</span>
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

            ${additionalMetricsHTML}

            <h3>Exercises</h3>
            <div class="workout-detail-exercises">
        `;

        session.exercises.forEach(exercise => {
            const exerciseData = this.app.getExerciseById(exercise.exerciseId);
            const exerciseName = exerciseData ? exerciseData.name : exercise.exerciseName || 'Unknown Exercise';
            const completedSets = exercise.sets ? exercise.sets.filter(s => s.completed) : [];

            if (completedSets.length > 0) {
                const isDuration = completedSets[0].duration > 0;

                html += `
                    <div class="detail-exercise">
                        <h4>${escapeHtml(exerciseName)}</h4>
                        <table class="sets-table">
                            <thead>
                                <tr>
                                    <th>Set</th>
                `;

                if (isDuration) {
                    html += `
                                    <th>Duration</th>
                    `;
                } else {
                    html += `
                                    <th>Weight</th>
                                    <th>Reps</th>
                                    <th>Volume</th>
                    `;
                }

                html += `
                                </tr>
                            </thead>
                            <tbody>
                `;

                completedSets.forEach((set, index) => {
                    html += `<tr><td>${index + 1}</td>`;

                    if (set.duration > 0) {
                        const mins = Math.floor(set.duration / 60);
                        const secs = set.duration % 60;
                        html += `<td>${mins}:${secs.toString().padStart(2, '0')}</td>`;
                    } else {
                        html += `
                            <td>${set.weight.toLocaleString()}${unit}</td>
                            <td>${set.reps}</td>
                            <td>${Math.round(set.volume).toLocaleString()}${unit}</td>
                        `;
                    }

                    html += `</tr>`;
                });

                html += `
                            </tbody>
                        </table>
                    </div>
                `;
            }
        });

        html += '</div>';

        // Add notes if available
        if (session.notes) {
            html += `
                <h3>Notes</h3>
                <p class="workout-detail-notes">${escapeHtml(session.notes)}</p>
            `;
        }

        content.innerHTML = html;
        modal.classList.add('active');
    }

    async deleteWorkout(sessionId) {
        const session = this.app.workoutSessions.find(s => s.id === sessionId);
        if (!session) return;

        const exerciseCount = session.exercises.length;
        const exerciseLabel = exerciseCount === 1 ? 'exercise' : 'exercises';
        const message = `Are you sure you want to delete this workout?<br><br><strong>${escapeHtml(session.workoutDayName)}</strong><br>${formatSessionDateTime(session)}<br><br>This workout included ${exerciseCount} ${exerciseLabel} and ${Math.round(session.totalVolume).toLocaleString()}${this.app.settings.weightUnit} total volume.<br><br><strong>This action cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Delete Workout',
            message,
            confirmText: 'Delete Workout',
            cancelText: 'Cancel',
            isDangerous: true,
        });

        if (!confirmed) return;

        const index = this.app.workoutSessions.findIndex(s => s.id === sessionId);
        if (index < 0) return;

        this.app.workoutSessions.splice(index, 1);
        this.app.saveWorkoutSessions();
        this.app.updateAchievements();
        this.render();
        showToast('Workout deleted', 'info');
    }

    goToProgramDetails(programId) {
        // Check if program exists
        const program = this.app.getProgramById(programId);
        if (!program) {
            showToast('Program not found', 'error');
            return;
        }

        // Navigate to programs view
        this.app.showView('programs');

        // Open program edit modal after a short delay to ensure view is loaded and rendered
        setTimeout(() => {
            if (this.app.viewControllers.programs) {
                // Ensure programs list is rendered first
                this.app.viewControllers.programs.render();
                // Then open the edit modal
                this.app.viewControllers.programs.editProgram(programId);
            } else {
                showToast('Programs view not initialized', 'error');
                console.error('Programs view controller not found');
            }
        }, 250);
    }
}

// Initialize
new HistoryView();
