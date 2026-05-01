/**
 * Exercises View Controller
 */
import { app } from '../app.js';
import { showToast, parseLocalDate, showConfirmModal, escapeHtml, generateNumericId } from '../utils/helpers.js';
import { DarkSelect } from '../utils/dark-select.js';
import { AnalyticsService } from '../services/AnalyticsService.js';

class ExercisesView {
    constructor() {
        this.app = app;
        this.filteredExercises = [];
        this.init();
    }

    init() {
        this.app.viewControllers.exercises = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        const searchInput = document.getElementById('exercise-db-search');
        const categoryFilter = document.getElementById('exercise-db-category');
        const equipmentFilter = document.getElementById('exercise-db-equipment');
        const historyFilter = document.getElementById('exercise-db-history-filter');
        const historySort = document.getElementById('exercise-db-history-sort');
        const createBtn = document.getElementById('create-custom-exercise-btn');

        if (searchInput) {
            searchInput.addEventListener('input', () => this.filterExercises());
        }

        if (categoryFilter) {
            categoryFilter.addEventListener('change', () => this.filterExercises());
        }

        if (equipmentFilter) {
            equipmentFilter.addEventListener('change', () => this.filterExercises());
        }

        if (historyFilter) {
            historyFilter.addEventListener('change', () => {
                // Show/hide sort dropdown based on history filter
                if (historySort) {
                    historySort.style.display = historyFilter.value === 'with-history' ? '' : 'none';
                    // Reset to default sort when hiding
                    if (historyFilter.value !== 'with-history') {
                        historySort.value = 'name';
                    }
                }
                this.filterExercises();
            });
        }

        if (historySort) {
            historySort.addEventListener('change', () => this.filterExercises());
        }

        if (createBtn) {
            createBtn.addEventListener('click', () => this.openCustomExerciseModal());
        }

        const resetBtn = document.getElementById('exercise-db-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                if (categoryFilter) categoryFilter.value = '';
                if (equipmentFilter) equipmentFilter.value = '';
                if (historyFilter) historyFilter.value = 'all';
                if (historySort) {
                    historySort.value = 'name';
                    historySort.style.display = 'none';
                }
                this.filterExercises();
            });
        }

        // Custom exercise form
        const customForm = document.getElementById('custom-exercise-form');
        if (customForm) {
            customForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.createCustomExercise();
            });
        }

        // Custom-exercise modal — wrap the three native selects with DarkSelect
        this.customExerciseDropdowns = {};
        ['custom-exercise-category', 'custom-exercise-muscle', 'custom-exercise-equipment']
            .forEach(id => {
                const sel = document.getElementById(id);
                if (sel && !sel.dataset.darkSelectInit) {
                    this.customExerciseDropdowns[id] = new DarkSelect(sel);
                    sel.dataset.darkSelectInit = '1';
                }
            });
    }

    render() {
        // Count text is updated dynamically by filterExercises()
        this.filterExercises();
    }

    updateCountText(filteredCount, totalCount) {
        const countText = document.getElementById('exercise-count-text');
        if (!countText) return;
        const word = totalCount === 1 ? 'exercise' : 'exercises';
        if (filteredCount === totalCount) {
            countText.textContent = `${totalCount.toLocaleString()} ${word} available`;
        } else {
            countText.textContent = `Showing ${filteredCount.toLocaleString()} of ${totalCount.toLocaleString()} ${word}`;
        }
    }

    filterExercises() {
        const searchTerm = document.getElementById('exercise-db-search')?.value.toLowerCase() || '';
        const category = document.getElementById('exercise-db-category')?.value || '';
        const equipment = document.getElementById('exercise-db-equipment')?.value || '';
        const historyFilter = document.getElementById('exercise-db-history-filter')?.value || 'all';
        const historySort = document.getElementById('exercise-db-history-sort')?.value || 'name';

        this.filteredExercises = this.app.exerciseDatabase.filter(ex => {
            const matchesSearch = ex.name.toLowerCase().includes(searchTerm) ||
                ex.muscleGroup.toLowerCase().includes(searchTerm);
            const matchesCategory = !category || ex.category === category;
            const matchesEquipment = !equipment || ex.equipment === equipment;

            // Check history filter
            const hasHistory = this.exerciseHasHistory(ex.id);
            let matchesHistory = true;
            if (historyFilter === 'with-history') {
                matchesHistory = hasHistory;
            } else if (historyFilter === 'without-history') {
                matchesHistory = !hasHistory;
            }

            return matchesSearch && matchesCategory && matchesEquipment && matchesHistory;
        });

        // Apply sorting when showing exercises with history
        if (historyFilter === 'with-history') {
            if (historySort === 'most-history') {
                this.filteredExercises.sort((a, b) => {
                    const countDiff = this.getExerciseHistoryCount(b.id) - this.getExerciseHistoryCount(a.id);
                    // Secondary sort by name if counts are equal
                    return countDiff !== 0 ? countDiff : a.name.localeCompare(b.name);
                });
            } else if (historySort === 'least-history') {
                this.filteredExercises.sort((a, b) => {
                    const countDiff = this.getExerciseHistoryCount(a.id) - this.getExerciseHistoryCount(b.id);
                    // Secondary sort by name if counts are equal
                    return countDiff !== 0 ? countDiff : a.name.localeCompare(b.name);
                });
            } else {
                // Default: sort by name
                this.filteredExercises.sort((a, b) => a.name.localeCompare(b.name));
            }
        }

        // Update dropdown states
        this.updateDropdownStates(searchTerm, category, equipment, historyFilter);

        // Enable/disable the reset button based on whether any filter is active
        const resetBtn = document.getElementById('exercise-db-reset');
        if (resetBtn) {
            const anyActive = Boolean(searchTerm) || Boolean(category) || Boolean(equipment)
                || historyFilter !== 'all' || historySort !== 'name';
            resetBtn.disabled = !anyActive;
        }

        // Update header count text (reflects current filtered view)
        this.updateCountText(this.filteredExercises.length, this.app.exerciseDatabase.length);

        this.renderExerciseList();
    }

    updateDropdownStates(searchTerm, currentCategory, currentEquipment, historyFilter) {
        const categorySelect = document.getElementById('exercise-db-category');
        const equipmentSelect = document.getElementById('exercise-db-equipment');

        if (categorySelect) {
            Array.from(categorySelect.options).forEach(option => {
                if (!option.value) {
                    option.disabled = false;
                    return;
                }

                // Count exercises that would match if this category was selected
                const count = this.app.exerciseDatabase.filter(ex => {
                    const matchesSearch = !searchTerm || ex.name.toLowerCase().includes(searchTerm) || ex.muscleGroup.toLowerCase().includes(searchTerm);
                    const matchesThisCategory = ex.category === option.value;
                    const matchesEquipment = !currentEquipment || ex.equipment === currentEquipment;
                    const hasHistory = this.exerciseHasHistory(ex.id);
                    let matchesHistory = true;
                    if (historyFilter === 'with-history') matchesHistory = hasHistory;
                    else if (historyFilter === 'without-history') matchesHistory = !hasHistory;

                    return matchesSearch && matchesThisCategory && matchesEquipment && matchesHistory;
                }).length;

                option.disabled = count === 0;
            });
        }

        if (equipmentSelect) {
            Array.from(equipmentSelect.options).forEach(option => {
                if (!option.value) {
                    option.disabled = false;
                    return;
                }

                // Count exercises that would match if this equipment was selected
                const count = this.app.exerciseDatabase.filter(ex => {
                    const matchesSearch = !searchTerm || ex.name.toLowerCase().includes(searchTerm) || ex.muscleGroup.toLowerCase().includes(searchTerm);
                    const matchesCategory = !currentCategory || ex.category === currentCategory;
                    const matchesThisEquipment = ex.equipment === option.value;
                    const hasHistory = this.exerciseHasHistory(ex.id);
                    let matchesHistory = true;
                    if (historyFilter === 'with-history') matchesHistory = hasHistory;
                    else if (historyFilter === 'without-history') matchesHistory = !hasHistory;

                    return matchesSearch && matchesCategory && matchesThisEquipment && matchesHistory;
                }).length;

                option.disabled = count === 0;
            });
        }
    }

    exerciseHasHistory(exerciseId) {
        return this.app.workoutSessions.some(session =>
            session.exercises.some(ex =>
                ex.exerciseId === exerciseId &&
                ex.sets &&
                ex.sets.length > 0 &&
                ex.sets.some(set => set.completed)
            )
        );
    }

    getExerciseHistoryCount(exerciseId) {
        let count = 0;
        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    count++;
                }
            }
        });
        return count;
    }

    getExerciseHistory(exerciseId) {
        const history = [];

        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                exercise.sets.forEach(set => {
                    if (set.completed) {
                        history.push({
                            date: session.date,
                            sortKey: session.sortTimestamp,
                            weight: set.weight,
                            reps: set.reps,
                            duration: set.duration || 0,
                            volume: set.volume
                        });
                    }
                });
            }
        });

        // Sort by full session timestamp (most recent first) so multiple
        // sessions on the same day order by time-of-day.
        return history.sort((a, b) => new Date(b.sortKey) - new Date(a.sortKey));
    }

    /**
     * Group by session (not by calendar date) so two workouts on the same day
     * remain distinct in the exercise-history table. Sorted newest-first by
     * full timestamp.
     */
    getExerciseHistoryGroupedByDate(exerciseId) {
        const groups = [];

        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                const completedSets = exercise.sets.filter(set => set.completed);
                if (completedSets.length > 0) {
                    groups.push({
                        date: session.date,
                        sortKey: session.sortTimestamp,
                        sessionId: session.id,
                        sets: completedSets.map(set => ({
                            weight: set.weight,
                            reps: set.reps,
                            duration: set.duration || 0,
                            volume: set.volume,
                        })),
                    });
                }
            }
        });

        return groups.sort((a, b) => new Date(b.sortKey) - new Date(a.sortKey));
    }

    openCustomExerciseModal() {
        const modal = document.getElementById('custom-exercise-modal');

        // Clear form
        document.getElementById('custom-exercise-name').value = '';
        document.getElementById('custom-exercise-category').value = '';
        document.getElementById('custom-exercise-muscle').value = '';
        document.getElementById('custom-exercise-equipment').value = '';

        // Sync the DarkSelect triggers so they show placeholders, not stale labels
        if (this.customExerciseDropdowns) {
            Object.values(this.customExerciseDropdowns).forEach(d => d.sync());
        }

        // Clear any leftover error states from the previous attempt
        modal.querySelectorAll('.has-error').forEach(el => el.classList.remove('has-error'));

        modal.classList.add('active');
    }

    createCustomExercise() {
        const name = document.getElementById('custom-exercise-name').value.trim();
        const category = document.getElementById('custom-exercise-category').value;
        const muscleGroup = document.getElementById('custom-exercise-muscle').value;
        const equipment = document.getElementById('custom-exercise-equipment').value;

        if (!name || !category || !muscleGroup || !equipment) {
            showToast('Please fill in all required fields', 'error');
            return;
        }

        // High-entropy numeric ID — generateNumericId combines timestamp,
        // a process counter, and a random tail so two custom exercises
        // created in the same millisecond can't collide. Stays numeric so
        // existing inline-onclick interpolations keep working.
        const id = generateNumericId();

        const newExercise = {
            id,
            name,
            category,
            muscleGroup,
            equipment,
            isCustom: true
        };

        this.app.addCustomExercise(newExercise);

        showToast(`Created custom exercise: ${name}`, 'success');
        document.getElementById('custom-exercise-modal').classList.remove('active');

        // Refresh the exercise list and count
        this.render();
    }

    renderExerciseList() {
        const container = document.getElementById('exercise-db-list');

        if (this.filteredExercises.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-search"></i>
                    <p>No exercises found</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.filteredExercises.map(exercise => {
            const hasHistory = this.exerciseHasHistory(exercise.id);
            const historyCount = hasHistory ? this.getExerciseHistoryCount(exercise.id) : 0;
            const clickHandler = hasHistory
                ? `onclick="window.gymApp.viewControllers.exercises.showExerciseHistory(${exercise.id})"`
                : '';
            const cursorClass = hasHistory ? 'has-history' : 'no-history';
            const canDelete = exercise.isCustom && !hasHistory;

            return `
                <div class="exercise-db-card ${cursorClass}" ${clickHandler}>
                    ${hasHistory ? `<span class="history-count-badge">${historyCount}</span>` : ''}
                    <div class="exercise-card-header">
                        <h3>
                            ${escapeHtml(exercise.name)}
                            ${exercise.isCustom ? '<span class="badge badge-custom">Custom</span>' : ''}
                        </h3>
                        ${canDelete ? `<button class="btn-icon delete-exercise-btn" onclick="event.stopPropagation(); window.gymApp.viewControllers.exercises.deleteCustomExercise(${exercise.id})" title="Delete custom exercise">
                            <i class="fas fa-trash"></i>
                        </button>` : ''}
                    </div>
                    <p class="exercise-muscle"><i class="fas fa-bullseye"></i> ${escapeHtml(exercise.muscleGroup)}</p>
                    <div class="exercise-meta">
                        <span class="badge badge-category"><i class="fas fa-layer-group"></i> ${escapeHtml(exercise.category)}</span>
                        <span class="badge badge-equipment"><i class="fas fa-dumbbell"></i> ${escapeHtml(exercise.equipment)}</span>
                    </div>
                    ${hasHistory ? `
                        <span class="btn-view-history">
                            <i class="fas fa-chart-line"></i> View history
                            <i class="fas fa-arrow-right view-history-arrow"></i>
                        </span>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    showExerciseHistory(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;

        const history = this.getExerciseHistory(exerciseId);
        const groupedHistory = this.getExerciseHistoryGroupedByDate(exerciseId);
        if (history.length === 0) return;

        const modal = document.getElementById('exercise-detail-modal');
        document.getElementById('exercise-detail-name').textContent = exercise.name;

        const unit = this.app.settings.weightUnit;
        const isDuration = history[0].duration > 0;

        // Find best set (used for both stats display and table highlighting)
        const bestSet = isDuration
            ? history.reduce((best, current) => current.duration > best.duration ? current : best)
            : history.reduce((best, current) => current.volume > best.volume ? current : best);

        // Friendly date helpers — "Mar 25, 2026" instead of "3/25/2026"
        const fmtDate = (dateStr) => parseLocalDate(dateStr).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
        });

        // "6:42 PM" from an ISO timestamp. Used to disambiguate two sessions
        // on the same calendar day.
        const fmtTime = (iso) => {
            if (!iso) return '';
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return '';
            return d.toLocaleTimeString(undefined, {
                hour: 'numeric', minute: '2-digit', hour12: true,
            });
        };

        // Caption that explains what makes the best set "best"
        const bestCaption = isDuration ? 'Longest duration' : 'Highest volume (weight × reps)';

        let statsHTML = '';
        if (isDuration) {
            const maxMins = Math.floor(bestSet.duration / 60);
            const maxSecs = bestSet.duration % 60;
            const avgDuration = history.reduce((sum, h) => sum + h.duration, 0) / history.length;
            const avgMins = Math.floor(avgDuration / 60);
            const avgSecs = Math.floor(avgDuration % 60);
            const totalSets = history.length;

            statsHTML = `
                ${this.statBox('Max duration', `${maxMins}:${maxSecs.toString().padStart(2, '0')}`)}
                ${this.statBox('Avg duration', `${avgMins}:${avgSecs.toString().padStart(2, '0')}`)}
                ${this.statBox('Total sets', totalSets.toLocaleString())}
                ${this.statBox('On', fmtDate(bestSet.date))}
            `;
        } else {
            statsHTML = `
                ${this.statBox('Weight', `${bestSet.weight.toLocaleString()} ${unit}`)}
                ${this.statBox('Reps', bestSet.reps.toLocaleString())}
                ${this.statBox('Volume', `${Math.round(bestSet.volume).toLocaleString()} ${unit}`)}
                ${this.statBox('On', fmtDate(bestSet.date))}
            `;
        }

        // Build table with grouped sets per date
        const tableHeaderHTML = `
            <th class="col-date">Date</th>
            <th class="col-sets">Sets</th>
        `;

        const renderSetChip = (label, stateClass, title) => `
            <span class="set-badge ${stateClass || ''}"${title ? ` title="${title}"` : ''}>${label}</span>
        `;

        // Which calendar dates have more than one session? When they do, we
        // add the time-of-day to the row label so multiple same-day sessions
        // remain distinguishable at a glance.
        const sessionsPerDate = groupedHistory.reduce((acc, r) => {
            acc[r.date] = (acc[r.date] || 0) + 1;
            return acc;
        }, {});

        // groupedHistory is sorted newest-first, so the previous session for
        // each row is at the next index.
        const tableBodyHTML = groupedHistory.map((record, recordIdx) => {
            // Match the "best" session uniquely by timestamp — `date` alone
            // would flag every session on the best-performance day.
            const isBestRow = record.sortKey === bestSet.sortKey;
            const previousRecord = groupedHistory[recordIdx + 1];
            const showTime = sessionsPerDate[record.date] > 1;
            const timeLabel = showTime ? fmtTime(record.sortKey) : '';

            const setsDisplay = record.sets.map((set, idx) => {
                const prevSet = previousRecord?.sets?.[idx];
                let label = '';
                let stateClass = '';
                let title = '';

                if (isDuration) {
                    const mins = Math.floor(set.duration / 60);
                    const secs = set.duration % 60;
                    label = `Set ${idx + 1} · ${mins}:${secs.toString().padStart(2, '0')}`;

                    if (isBestRow && set.duration === bestSet.duration) {
                        stateClass = 'set-best';
                    } else if (prevSet) {
                        if (set.duration > prevSet.duration) {
                            stateClass = 'set-improved';
                            title = `Up from ${Math.floor(prevSet.duration / 60)}:${(prevSet.duration % 60).toString().padStart(2, '0')} last time`;
                        } else if (set.duration < prevSet.duration) {
                            stateClass = 'set-worse';
                            title = `Down from ${Math.floor(prevSet.duration / 60)}:${(prevSet.duration % 60).toString().padStart(2, '0')} last time`;
                        }
                    }
                } else {
                    const setVolume = set.weight * set.reps;
                    label = `Set ${idx + 1} · ${set.weight.toLocaleString()} ${unit} × ${set.reps}`;

                    if (isBestRow && setVolume === bestSet.volume) {
                        stateClass = 'set-best';
                    } else if (prevSet) {
                        // Primary: weight. If weight equal: compare reps.
                        if (set.weight > prevSet.weight) {
                            stateClass = 'set-improved';
                            title = `Up from ${prevSet.weight.toLocaleString()} ${unit} last time`;
                        } else if (set.weight < prevSet.weight) {
                            stateClass = 'set-worse';
                            title = `Down from ${prevSet.weight.toLocaleString()} ${unit} last time`;
                        } else if (set.reps > prevSet.reps) {
                            stateClass = 'set-improved';
                            title = `+${set.reps - prevSet.reps} reps vs last time`;
                        } else if (set.reps < prevSet.reps) {
                            stateClass = 'set-worse';
                            title = `${set.reps - prevSet.reps} reps vs last time`;
                        }
                    }
                }
                return renderSetChip(label, stateClass, title);
            }).join('');

            return `
                <tr class="${isBestRow ? 'is-best-row' : ''}">
                    <td class="col-date">
                        <span class="history-date">${fmtDate(record.date)}${timeLabel ? ` · ${timeLabel}` : ''}</span>
                        ${isBestRow ? '<span class="best-row-badge"><i class="fas fa-star"></i> Best</span>' : ''}
                    </td>
                    <td class="col-sets sets-cell">${setsDisplay}</td>
                </tr>
            `;
        }).join('');

        document.getElementById('exercise-detail-content').innerHTML = `
            <section class="exercise-detail-section">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-star"></i> Best Set</h3>
                    <span class="exercise-detail-section-caption">${bestCaption}</span>
                </header>
                <div class="exercise-stats-summary">
                    ${statsHTML}
                </div>
            </section>

            <section class="exercise-detail-section">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-clock-rotate-left"></i> History</h3>
                    <span class="exercise-detail-section-caption">${groupedHistory.length} session${groupedHistory.length === 1 ? '' : 's'}</span>
                </header>
                <div class="exercise-history-table">
                    <table>
                        <thead>
                            <tr>${tableHeaderHTML}</tr>
                        </thead>
                        <tbody>
                            ${tableBodyHTML}
                        </tbody>
                    </table>
                </div>
            </section>
        `;

        this.renderProgressionChart(exerciseId, isDuration);

        modal.classList.add('active');
    }

    /**
     * Render the per-exercise progression chart into the #exercise-history-chart
     * placeholder. Inline SVG — no chart library, no network.
     *
     * For weighted exercises we plot top-set weight and estimated 1RM (Epley).
     * For duration exercises we plot longest set per session.
     */
    renderProgressionChart(exerciseId, isDuration) {
        const host = document.getElementById('exercise-history-chart');
        if (!host) return;
        host.innerHTML = '';

        const points = AnalyticsService.getExerciseProgression(
            exerciseId,
            this.app.workoutSessions,
            { limit: 12 },
        );
        if (points.length < 2) return; // need ≥2 points to draw a trend

        const unit = this.app.settings.weightUnit;
        const fmtDate = (dateStr) => parseLocalDate(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric',
        });

        const series = isDuration
            ? points.map(p => ({ x: p.date, y: p.maxDuration }))
            : points.map(p => ({ x: p.date, y: p.maxWeight }));

        const e1rmSeries = isDuration
            ? null
            : points.map(p => ({ x: p.date, y: Math.round(p.e1rm) }));

        const yMin = Math.min(...series.map(p => p.y), e1rmSeries ? Math.min(...e1rmSeries.map(p => p.y)) : Infinity);
        const yMax = Math.max(...series.map(p => p.y), e1rmSeries ? Math.max(...e1rmSeries.map(p => p.y)) : -Infinity);
        const yRange = Math.max(yMax - yMin, 1);
        const pad = yRange * 0.15;
        const yLo = Math.max(0, yMin - pad);
        const yHi = yMax + pad;

        const W = 520;
        const H = 160;
        const mx = 32;
        const my = 16;
        const plotW = W - mx * 2;
        const plotH = H - my * 2;

        const xAt = (i) => mx + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        const yAt = (v) => my + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

        const toPath = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');

        const fmtY = (v) => isDuration
            ? `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`
            : `${Math.round(v)} ${unit}`;

        const firstLabel = fmtDate(series[0].x);
        const lastLabel = fmtDate(series[series.length - 1].x);

        const bestWeight = Math.max(...points.map(p => p.maxWeight));
        const bestE1rm = Math.max(...points.map(p => p.e1rm));
        const bestDuration = Math.max(...points.map(p => p.maxDuration));

        const firstY = series[0].y;
        const lastY = series[series.length - 1].y;
        const trendDelta = lastY - firstY;
        const trendPct = firstY > 0 ? Math.round((trendDelta / firstY) * 100) : 0;
        const trendClass = trendDelta > 0 ? 'is-up' : trendDelta < 0 ? 'is-down' : '';
        const trendSign = trendDelta > 0 ? '+' : '';

        const primaryLabel = isDuration ? 'Longest set' : 'Top-set weight';
        const caption = isDuration
            ? `${points.length} sessions · ${trendSign}${fmtY(trendDelta)} vs ${points.length} ago`
            : `${points.length} sessions · ${trendSign}${trendPct}% vs ${points.length} ago`;

        const statTiles = isDuration
            ? `<div class="stat-box"><span class="stat-label">Best</span><span class="stat-value">${fmtY(bestDuration)}</span></div>`
            : `<div class="stat-box"><span class="stat-label">Top weight</span><span class="stat-value">${Math.round(bestWeight)} ${unit}</span></div>
               <div class="stat-box"><span class="stat-label">Best e1RM</span><span class="stat-value">${Math.round(bestE1rm)} ${unit}</span></div>`;

        const dotsPrimary = series.map((p, i) =>
            `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3" class="progression-dot"><title>${fmtDate(p.x)}: ${fmtY(p.y)}</title></circle>`
        ).join('');

        const e1rmLine = e1rmSeries
            ? `<path d="${toPath(e1rmSeries)}" class="progression-line progression-line-e1rm"/>`
            : '';

        const xTicks = `
            <text x="${mx}" y="${H - 2}" class="progression-axis" text-anchor="start">${firstLabel}</text>
            <text x="${W - mx}" y="${H - 2}" class="progression-axis" text-anchor="end">${lastLabel}</text>
        `;
        const yTicks = `
            <text x="${mx - 6}" y="${yAt(yHi).toFixed(1) + 4}" class="progression-axis" text-anchor="end">${fmtY(yHi)}</text>
            <text x="${mx - 6}" y="${yAt(yLo).toFixed(1) + 4}" class="progression-axis" text-anchor="end">${fmtY(yLo)}</text>
        `;

        host.innerHTML = `
            <section class="exercise-detail-section exercise-progression">
                <header class="exercise-detail-section-header">
                    <h3><i class="fas fa-chart-line"></i> Progression</h3>
                    <span class="exercise-detail-section-caption ${trendClass}">${caption}</span>
                </header>
                <div class="exercise-stats-summary">${statTiles}</div>
                <div class="progression-chart-wrap">
                    <svg viewBox="0 0 ${W} ${H}" class="progression-chart" role="img" aria-label="${primaryLabel} over the last ${points.length} sessions">
                        <line x1="${mx}" y1="${my}" x2="${mx}" y2="${H - my}" class="progression-axis-line"/>
                        <line x1="${mx}" y1="${H - my}" x2="${W - mx}" y2="${H - my}" class="progression-axis-line"/>
                        ${e1rmLine}
                        <path d="${toPath(series)}" class="progression-line progression-line-primary"/>
                        ${dotsPrimary}
                        ${xTicks}
                        ${yTicks}
                    </svg>
                    <div class="progression-legend">
                        <span class="progression-legend-item"><span class="dot dot-primary"></span>${primaryLabel}</span>
                        ${e1rmSeries ? '<span class="progression-legend-item"><span class="dot dot-e1rm"></span>Est. 1RM</span>' : ''}
                    </div>
                </div>
            </section>
        `;
    }

    statBox(label, value) {
        return `
            <div class="stat-box">
                <span class="stat-label">${label}</span>
                <span class="stat-value">${value}</span>
            </div>
        `;
    }

    async deleteCustomExercise(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise || !exercise.isCustom) {
            showToast('Cannot delete this exercise', 'error');
            return;
        }

        const hasHistory = this.exerciseHasHistory(exerciseId);
        if (hasHistory) {
            showToast('Cannot delete exercise with workout history', 'error');
            return;
        }

        const message = `Are you sure you want to delete <strong>"${escapeHtml(exercise.name)}"</strong>?<br><br>This custom exercise will be permanently removed.<br><br><strong>This action cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Delete Custom Exercise',
            message: message,
            confirmText: 'Delete Exercise',
            cancelText: 'Cancel',
            isDangerous: true
        });

        if (confirmed) {
            const index = this.app.customExercises.findIndex(ex => ex.id === exerciseId);
            if (index >= 0) {
                this.app.customExercises.splice(index, 1);
                this.app.saveCustomExercises();
                showToast('Custom exercise deleted successfully', 'info');

                // Re-render to update the list and count
                this.render();
            }
        }
    }
}

// Initialize
new ExercisesView();
