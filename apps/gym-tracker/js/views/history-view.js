/**
 * History View Controller
 */
import { app } from '../app.js';
import { formatDate, showToast, showConfirmModal, formatSessionDateTime, escapeHtml, pluralize } from '../utils/helpers.js';
import { displayWeight, formatDurationLong, normalizeWeightUnit, volumeIn } from '../utils/units.js';
import { performedExerciseCount, sessionTimedSeconds } from '../utils/session-metrics.js';
import { trapModalFocus } from '../utils/modal-focus.js';
import { DarkCalendar } from '../utils/dark-calendar.js';
import { DarkSelect } from '../utils/dark-select.js';
import { Program } from '../models/Program.js';
import { sameId } from '../utils/id-utils.js';
import { makePaginatorState, paginatorInfo, paginatorDualHTML } from '../utils/paginator.js';

const HISTORY_PAGE_SIZE = 15;

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
        // Item 5: '' = All Programs. Deliberately not persisted, so a reload
        // starts from the unfiltered list.
        this.programFilter = '';
        this._pagination = makePaginatorState(HISTORY_PAGE_SIZE);
        this.setupEventListeners();
        this.wireListActions();
    }

    /**
     * Single delegated click+keyboard listener on the history list. Replaces
     * the inline onclick handlers that interpolated session.id into JS
     * strings. Cards declare behavior via `data-action` + `data-session-id`.
     */
    wireListActions() {
        const list = document.getElementById('history-list');
        if (!list || list.dataset.actionsWired) return;
        list.dataset.actionsWired = '1';

        const dispatch = (e, fromKeyboard = false) => {
            const target = e.target.closest('[data-action]');
            if (!target || !list.contains(target)) return;
            // Keep the raw string: lookups go through sameId(), so numeric,
            // stringified-numeric (Firestore round-trip), and string ids from
            // imports all resolve. Number() here made non-numeric session ids
            // silently unclickable (NaN matched nothing).
            const id = target.dataset.sessionId;
            switch (target.dataset.action) {
                case 'delete-session':
                    e.preventDefault();
                    e.stopPropagation();
                    this.deleteWorkout(id);
                    break;
                case 'show-session':
                    if (fromKeyboard && target.tagName === 'BUTTON') return;
                    e.preventDefault();
                    this.showWorkoutDetails(id);
                    break;
            }
        };

        list.addEventListener('click', (e) => dispatch(e));
        list.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') dispatch(e, true);
        });
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
                this._pagination.page = 1;
                this.render();
            });
        }

        // Program filter (Item 5). The options themselves are rebuilt on every
        // render (see syncProgramFilter); this listener lives on the native
        // select, which DarkSelect writes back to, so it survives the rebuild.
        const programSelect = document.getElementById('history-program');
        if (programSelect) {
            programSelect.addEventListener('change', (e) => {
                this.programFilter = e.target.value;
                this._pagination.page = 1;
                this.renderHistoryList();
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
                this._pagination.page = 1;
                this._updateClearButtonState();
                this.render();
            });
        }
        if (dateToInput && !dateToInput.dataset.darkCalendarInit) {
            this.toCalendar = new DarkCalendar(dateToInput, { role: 'to' });
            dateToInput.dataset.darkCalendarInit = '1';
            dateToInput.addEventListener('change', (e) => {
                this.dateTo = e.target.value || null;
                this._pagination.page = 1;
                this._updateClearButtonState();
                this.render();
            });
        }
        // Link the two calendars so they share range-selection state
        if (this.fromCalendar && this.toCalendar) {
            this.fromCalendar.rangePartner = this.toCalendar;
            this.toCalendar.rangePartner = this.fromCalendar;
        }

        // Clear filters button — disabled while no date filter is set so
        // the user doesn't get a clickable affordance for a no-op.
        const clearBtn = document.getElementById('clear-filters-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (clearBtn.disabled) return;
                this.dateFrom = null;
                this.dateTo = null;
                if (this.fromCalendar) this.fromCalendar.clearDate();
                else if (dateFromInput) dateFromInput.value = '';
                if (this.toCalendar) this.toCalendar.clearDate();
                else if (dateToInput) dateToInput.value = '';
                this._pagination.page = 1;
                this._updateClearButtonState();
                this.render();
            });
        }

        this._updateClearButtonState();
    }

    /**
     * Reflect the live date-filter state on the Clear button. Disabled
     * when neither dateFrom nor dateTo is set, since the click would be
     * a no-op. `aria-disabled` mirrors `disabled` for assistive tech.
     */
    _updateClearButtonState() {
        const clearBtn = document.getElementById('clear-filters-btn');
        if (!clearBtn) return;
        const hasFilter = !!(this.dateFrom || this.dateTo);
        clearBtn.disabled = !hasFilter;
        clearBtn.setAttribute('aria-disabled', String(!hasFilter));
    }

    render() {
        this.syncProgramFilter();
        this.renderHistoryList();
    }

    /**
     * Item 5: keep the Program dropdown in step with the saved programs.
     * DarkSelect snapshots its options at construction, so the wrapper is
     * torn down and rebuilt whenever a program is added, renamed or deleted.
     * A filter pointing at a program that no longer exists falls back to
     * All Programs rather than showing an empty list forever.
     */
    syncProgramFilter() {
        const select = document.getElementById('history-program');
        if (!select) return;

        const programs = this.app.programs || [];
        if (this.programFilter && !programs.some(p => sameId(p.id, this.programFilter))) {
            this.programFilter = '';
        }

        const signature = programs.map(p => `${p.id}:${p.name}`).join('|');
        if (this.programDropdown && signature === this._programFilterSignature) {
            select.value = this.programFilter;
            this.programDropdown.sync();
            return;
        }
        this._programFilterSignature = signature;

        select.innerHTML = ['<option value="">All Programs</option>']
            .concat(programs.map(p =>
                `<option value="${escapeHtml(String(p.id))}">${escapeHtml(p.name)}</option>`))
            .join('');
        select.value = this.programFilter;

        if (this.programDropdown) {
            this.programDropdown.close();
            const wrapper = this.programDropdown.wrapper;
            wrapper.parentNode.insertBefore(select, wrapper);
            wrapper.remove();
        }
        this.programDropdown = new DarkSelect(select);
        select.dataset.darkSelectInit = '1';
    }

    renderHistoryList() {
        const container = document.getElementById('history-list');
        let sessions = [...this.app.workoutSessions];

        // Program filter (Item 5). Sessions started from a program record its
        // id, so that's the identity we match on. Sessions predating programId
        // (or imported without one) fall back to the workout name they were
        // saved under, which is the program name at the time.
        if (this.programFilter) {
            const program = this.app.getProgramById(this.programFilter);
            const programName = program ? program.name : null;
            sessions = sessions.filter(session => (
                session.programId != null
                    ? sameId(session.programId, this.programFilter)
                    : (programName !== null && session.workoutDayName === programName)
            ));
        }

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

        const info = paginatorInfo(this._pagination, sessions.length);
        this._pagination.page = info.page;

        const pageSessions = sessions.slice(info.start, info.end);
        const unit = normalizeWeightUnit(this.app.settings.weightUnit);

        const cardsHTML = pageSessions.map(session => {
            const hasAdditionalMetrics = session.avgHeartRate || session.maxHeartRate || session.caloriesBurned;

            return `
                <div class="workout-card clickable" data-action="show-session" data-session-id="${session.id}" role="button" tabindex="0">
                    <div class="workout-card-header">
                        <div class="workout-header-info">
                            <h3>${escapeHtml(session.workoutDayName)}</h3>
                            <span class="date">${formatSessionDateTime(session)}</span>
                        </div>
                        <button class="btn-icon delete-workout-btn" data-action="delete-session" data-session-id="${session.id}" title="Delete workout" aria-label="Delete workout">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                    <div class="workout-card-stats">
                        <div class="stat">
                            <i class="fas fa-weight"></i>
                            ${Math.round(volumeIn(session.totalVolume, unit)).toLocaleString()}${unit}
                        </div>
                        <div class="stat">
                            <i class="fas fa-list"></i>
                            ${pluralize(performedExerciseCount(session), 'exercise')}
                        </div>
                        <div class="stat">
                            <i class="fas fa-chart-bar"></i>
                            ${pluralize(session.totalSets, 'set')}
                        </div>
                        ${sessionTimedSeconds(session) > 0 ? `
                            <div class="stat">
                                <i class="fas fa-stopwatch"></i>
                                ${formatDurationLong(sessionTimedSeconds(session))} held
                            </div>
                        ` : ''}
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

        const { top: topPager, bottom: bottomPager } = paginatorDualHTML(info, 'hist');
        container.innerHTML = topPager + cardsHTML + bottomPager;

        const goToPage = (newPage, scrollToTop) => {
            this._pagination.page = newPage;
            this.renderHistoryList();
            if (scrollToTop) container.scrollIntoView({ block: 'start' });
        };

        container.querySelectorAll('.pagination-page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pg = Number(btn.dataset.page);
                const fromBottom = btn.closest('[data-paginator="hist-b"]') !== null;
                goToPage(pg, fromBottom);
            });
        });

        container.querySelectorAll('[id^="hist-prev-"]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this._pagination.page > 1) {
                    const fromBottom = btn.id === 'hist-prev-b';
                    goToPage(this._pagination.page - 1, fromBottom);
                }
            });
        });

        container.querySelectorAll('[id^="hist-next-"]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this._pagination.page < info.pageCount) {
                    const fromBottom = btn.id === 'hist-next-b';
                    goToPage(this._pagination.page + 1, fromBottom);
                }
            });
        });
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
        const session = this.app.workoutSessions.find(s => sameId(s.id, sessionId));
        if (!session) return;

        const unit = normalizeWeightUnit(this.app.settings.weightUnit);
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
                        <span class="value">${Math.round(volumeIn(session.totalVolume, unit)).toLocaleString()}${unit}</span>
                    </div>
                    <div class="detail-stat">
                        <span class="label">Total Sets</span>
                        <span class="value">${session.totalSets}</span>
                    </div>
                    <div class="detail-stat">
                        <span class="label">Exercises</span>
                        <span class="value">${performedExerciseCount(session)}</span>
                    </div>
                    ${sessionTimedSeconds(session) > 0 ? `
                    <div class="detail-stat">
                        <span class="label">Time Held</span>
                        <span class="value">${formatDurationLong(sessionTimedSeconds(session))}</span>
                    </div>` : ''}
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
                            <td>${Number(displayWeight(set.weight, unit)).toLocaleString()}${unit}</td>
                            <td>${set.reps}</td>
                            <td>${Math.round(volumeIn(set.volume, unit)).toLocaleString()}${unit}</td>
                        `;
                    }

                    html += `</tr>`;
                });

                html += `
                            </tbody>
                        </table>
                `;

                // Feature 2: per-exercise strength trend chart (reps-type only).
                if (!isDuration) {
                    html += this.buildExerciseTrendChart(exercise.exerciseId, unit);
                }

                // Feature 5 (display half): read-only per-exercise notes.
                if (exercise.notes && exercise.notes.trim()) {
                    html += `
                        <div class="gt-detail-exercise-notes">
                            <span class="gt-detail-exercise-notes-label">Notes</span>
                            <p class="gt-detail-exercise-notes-text">${escapeHtml(exercise.notes)}</p>
                        </div>
                    `;
                }

                html += `
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

        // Feature 10a: "Save as Program" button appended to the modal footer.
        // Injected each time so sessionId is always current.
        const existingBtn = modal.querySelector('.save-as-program-btn');
        if (existingBtn) existingBtn.remove();
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-secondary save-as-program-btn';
        saveBtn.innerHTML = '<i class="fas fa-bookmark"></i> Save as Program';
        saveBtn.addEventListener('click', () => this.saveSessionAsProgram(session.id));
        modal.querySelector('.modal-body').appendChild(saveBtn);

        modal.classList.add('active');
        trapModalFocus(modal);
    }

    /**
     * Feature 2: inline-SVG strength trend for a reps-type exercise.
     *
     * Collects every workout session that contains this exercise (matched by
     * exerciseId), reduces each to its TOP committed set weight, orders them
     * oldest-first by sortTimestamp, and plots the last 12 as a line chart.
     * The current session is included so the open detail sits on the line.
     *
     * Renders nothing for fewer than 3 data points (no empty-state clutter).
     * Returns an HTML string (possibly empty).
     */
    buildExerciseTrendChart(exerciseId, unit) {
        if (exerciseId == null) return '';

        const topWeightFor = (ex) => {
            const committed = (ex.sets || []).filter(s => s.completed && !(s.duration > 0));
            if (committed.length === 0) return null;
            return committed.reduce((max, s) => Math.max(max, s.weight || 0), 0);
        };

        const points = this.app.workoutSessions
            .map(session => {
                const ex = (session.exercises || []).find(e => sameId(e.exerciseId, exerciseId));
                if (!ex) return null;
                const weight = topWeightFor(ex);
                if (weight == null) return null;
                // Canonical kg -> the display unit, so the axis labels and the
                // shape both mean what the rest of the screen means (GT-03).
                return { ts: session.sortTimestamp, weight: Number(displayWeight(weight, unit)) };
            })
            .filter(Boolean)
            .sort((a, b) => new Date(a.ts) - new Date(b.ts))
            .slice(-12);

        if (points.length < 3) return '';

        const weights = points.map(p => p.weight);
        const min = Math.min(...weights);
        const max = Math.max(...weights);
        // Y-axis floor sits BELOW the minimum plotted weight so a cluster of
        // similar weights still spreads across the chart instead of flattening
        // to the bottom. Use a slice of the spread, with a small absolute
        // fallback when every weight is identical.
        const spread = max - min;
        const floor = Math.max(0, min - (spread > 0 ? spread * 0.15 : Math.max(1, min * 0.05)));
        const range = Math.max(1e-9, max - floor);

        const W = 240;
        const H = 80;
        const pad = 6;
        const stepX = (W - pad * 2) / (points.length - 1);
        const coords = points.map((p, i) => {
            const x = pad + i * stepX;
            const y = pad + (1 - (p.weight - floor) / range) * (H - pad * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });

        const dots = coords.map(c => {
            const [x, y] = c.split(',');
            return `<circle cx="${x}" cy="${y}" r="2.2" fill="#3a6df0" />`;
        }).join('');

        return `
            <div class="gt-exercise-trend">
                <span class="gt-exercise-trend-label">Exercise trend</span>
                <svg class="exercise-trend-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Top set weight across last ${points.length} sessions, in ${unit}">
                    <polyline points="${coords.join(' ')}" fill="none" stroke="#3a6df0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    ${dots}
                </svg>
                <span class="gt-exercise-trend-range">${min.toLocaleString()}${unit} to ${max.toLocaleString()}${unit}</span>
            </div>
        `;
    }

    async saveSessionAsProgram(sessionId) {
        const session = this.app.workoutSessions.find(s => sameId(s.id, sessionId));
        if (!session) return;

        const rawName = window.prompt('Program name:', session.workoutDayName || 'My Program');
        if (rawName === null) return;
        const name = rawName.trim();
        if (!name) {
            showToast('Program name cannot be empty', 'error');
            return;
        }

        const program = new Program({ name, description: '' });
        session.exercises.forEach(ex => {
            const completedSets = (ex.sets || []).filter(s => s.completed);
            if (completedSets.length === 0) return;
            const reps = Math.round(completedSets.reduce((s, set) => s + (set.reps || 0), 0) / completedSets.length);
            // Resolve through the catalog so a program built from an old
            // session carries the exercise's current name, not a pre-rename
            // snapshot.
            program.addExercise(ex.exerciseId,
                this.app.getExerciseDisplayName(ex.exerciseId, ex.exerciseName),
                completedSets.length, reps || 10);
        });

        if (program.exercises.length === 0) {
            showToast('No completed exercises to save', 'error');
            return;
        }

        this.app.programs.push(program);
        this.app.savePrograms();
        showToast(`Program "${name}" created`, 'success');
        document.getElementById('workout-detail-modal').classList.remove('active');
    }

    async deleteWorkout(sessionId) {
        const session = this.app.workoutSessions.find(s => sameId(s.id, sessionId));
        if (!session) return;

        const unit = normalizeWeightUnit(this.app.settings.weightUnit);
        const exerciseCount = performedExerciseCount(session);
        const message = `Are you sure you want to delete this workout?<br><br><strong>${escapeHtml(session.workoutDayName)}</strong><br>${formatSessionDateTime(session)}<br><br>This workout included ${pluralize(exerciseCount, 'exercise')} and ${Math.round(volumeIn(session.totalVolume, unit)).toLocaleString()}${unit} total volume.<br><br><strong>This action cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Delete Workout',
            message,
            confirmText: 'Delete Workout',
            cancelText: 'Cancel',
            isDangerous: true,
        });

        if (!confirmed) return;

        const index = this.app.workoutSessions.findIndex(s => sameId(s.id, sessionId));
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
