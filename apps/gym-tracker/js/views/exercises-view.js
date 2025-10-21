/**
 * Exercises View Controller
 */
import { app } from '../app.js';
import { showToast, parseLocalDate, showConfirmModal } from '../utils/helpers.js';

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
            historyFilter.addEventListener('change', () => this.filterExercises());
        }

        if (createBtn) {
            createBtn.addEventListener('click', () => this.openCustomExerciseModal());
        }

        // Custom exercise form
        const customForm = document.getElementById('custom-exercise-form');
        if (customForm) {
            customForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.createCustomExercise();
            });
        }
    }

    render() {
        // Update exercise count
        const totalExercises = this.app.exerciseDatabase.length;
        const countText = document.getElementById('exercise-count-text');
        if (countText) {
            countText.textContent = `Browse ${totalExercises} exercise${totalExercises !== 1 ? 's' : ''}`;
        }

        this.filterExercises();
    }

    filterExercises() {
        const searchTerm = document.getElementById('exercise-db-search')?.value.toLowerCase() || '';
        const category = document.getElementById('exercise-db-category')?.value || '';
        const equipment = document.getElementById('exercise-db-equipment')?.value || '';
        const historyFilter = document.getElementById('exercise-db-history-filter')?.value || 'all';

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

        // Update dropdown states
        this.updateDropdownStates(searchTerm, category, equipment, historyFilter);

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

    getExerciseHistory(exerciseId) {
        const history = [];

        this.app.workoutSessions.forEach(session => {
            const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
            if (exercise && exercise.sets && exercise.sets.length > 0) {
                exercise.sets.forEach(set => {
                    if (set.completed) {
                        history.push({
                            date: session.date,
                            weight: set.weight,
                            reps: set.reps,
                            duration: set.duration || 0,
                            volume: set.volume
                        });
                    }
                });
            }
        });

        // Sort by date (most recent first) using local date parsing
        return history.sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date));
    }

    openCustomExerciseModal() {
        const modal = document.getElementById('custom-exercise-modal');

        // Clear form
        document.getElementById('custom-exercise-name').value = '';
        document.getElementById('custom-exercise-category').value = '';
        document.getElementById('custom-exercise-muscle').value = '';
        document.getElementById('custom-exercise-equipment').value = '';

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

        // Generate unique ID (using timestamp + random)
        const id = Date.now() + Math.floor(Math.random() * 1000) + 10000;

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
            const clickHandler = hasHistory
                ? `onclick="window.gymApp.viewControllers.exercises.showExerciseHistory(${exercise.id})"`
                : '';
            const cursorClass = hasHistory ? 'has-history' : 'no-history';
            const canDelete = exercise.isCustom && !hasHistory;

            return `
                <div class="exercise-db-card ${cursorClass}" ${clickHandler}>
                    <div class="exercise-card-header">
                        <h3>
                            ${exercise.name}
                            ${exercise.isCustom ? '<span class="badge badge-custom">Custom</span>' : ''}
                            ${hasHistory ? '<i class="fas fa-chart-line history-icon"></i>' : ''}
                        </h3>
                        ${canDelete ? `<button class="btn-icon delete-exercise-btn" onclick="event.stopPropagation(); window.gymApp.viewControllers.exercises.deleteCustomExercise(${exercise.id})" title="Delete custom exercise">
                            <i class="fas fa-trash"></i>
                        </button>` : ''}
                    </div>
                    <div class="exercise-meta">
                        <span class="badge">${exercise.category}</span>
                        <span class="badge">${exercise.equipment}</span>
                    </div>
                    <p>${exercise.muscleGroup}</p>
                    ${hasHistory ? '<p class="history-hint"><i class="fas fa-info-circle"></i> Click to view history</p>' : ''}
                </div>
            `;
        }).join('');
    }

    showExerciseHistory(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;

        const history = this.getExerciseHistory(exerciseId);
        if (history.length === 0) return;

        const modal = document.getElementById('exercise-detail-modal');
        document.getElementById('exercise-detail-name').textContent = exercise.name;

        const unit = this.app.settings.weightUnit;
        const isDuration = history[0].duration > 0;

        let statsHTML = '';
        if (isDuration) {
            // Calculate stats for duration-based exercise
            const maxDuration = Math.max(...history.map(h => h.duration));
            const maxMins = Math.floor(maxDuration / 60);
            const maxSecs = maxDuration % 60;
            const avgDuration = history.reduce((sum, h) => sum + h.duration, 0) / history.length;
            const avgMins = Math.floor(avgDuration / 60);
            const avgSecs = Math.floor(avgDuration % 60);
            const totalSets = history.length;

            statsHTML = `
                <div class="stat-box">
                    <span class="stat-label">Max Duration</span>
                    <span class="stat-value">${maxMins}:${maxSecs.toString().padStart(2, '0')}</span>
                </div>
                <div class="stat-box">
                    <span class="stat-label">Avg Duration</span>
                    <span class="stat-value">${avgMins}:${avgSecs.toString().padStart(2, '0')}</span>
                </div>
                <div class="stat-box">
                    <span class="stat-label">Total Sets</span>
                    <span class="stat-value">${totalSets}</span>
                </div>
            `;
        } else {
            // Calculate stats for reps-based exercise
            const maxWeight = Math.max(...history.map(h => h.weight));
            const maxReps = Math.max(...history.map(h => h.reps));
            const maxVolume = Math.max(...history.map(h => h.volume));
            const bestWorkout = history.reduce((best, current) =>
                current.volume > best.volume ? current : best
            );
            const bestWorkoutDate = parseLocalDate(bestWorkout.date).toLocaleDateString();

            statsHTML = `
                <div class="stat-box">
                    <span class="stat-label">Max Weight</span>
                    <span class="stat-value">${maxWeight}${unit}</span>
                </div>
                <div class="stat-box">
                    <span class="stat-label">Max Reps</span>
                    <span class="stat-value">${maxReps}</span>
                </div>
                <div class="stat-box">
                    <span class="stat-label">Max Volume</span>
                    <span class="stat-value">${Math.round(maxVolume)}${unit}</span>
                </div>
                <div class="stat-box">
                    <span class="stat-label">Date</span>
                    <span class="stat-value">${bestWorkoutDate}</span>
                </div>
            `;
        }

        let tableHeaderHTML = '';
        if (isDuration) {
            tableHeaderHTML = `
                <th>Date</th>
                <th>Duration</th>
            `;
        } else {
            tableHeaderHTML = `
                <th>Date</th>
                <th>Weight</th>
                <th>Reps</th>
                <th>Volume</th>
            `;
        }

        let tableBodyHTML = history.map(record => {
            if (record.duration > 0) {
                const mins = Math.floor(record.duration / 60);
                const secs = record.duration % 60;
                return `
                    <tr>
                        <td>${parseLocalDate(record.date).toLocaleDateString()}</td>
                        <td>${mins}:${secs.toString().padStart(2, '0')}</td>
                    </tr>
                `;
            } else {
                return `
                    <tr>
                        <td>${parseLocalDate(record.date).toLocaleDateString()}</td>
                        <td>${record.weight}${unit}</td>
                        <td>${record.reps}</td>
                        <td>${Math.round(record.volume)}${unit}</td>
                    </tr>
                `;
            }
        }).join('');

        document.getElementById('exercise-detail-content').innerHTML = `
            <h3>Best Set</h3>
            <div class="exercise-stats-summary">
                ${statsHTML}
            </div>

            <h3>History</h3>
            <div class="exercise-history-table">
                <table>
                    <thead>
                        <tr>
                            ${tableHeaderHTML}
                        </tr>
                    </thead>
                    <tbody>
                        ${tableBodyHTML}
                    </tbody>
                </table>
            </div>
        `;

        modal.classList.add('active');
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

        const message = `Are you sure you want to delete <strong>"${exercise.name}"</strong>?<br><br>This custom exercise will be permanently removed.<br><br><strong>This action cannot be undone.</strong>`;

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
