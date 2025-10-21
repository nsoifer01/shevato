/**
 * Programs View Controller
 * Program builder and management
 */
import { app } from '../app.js';
import { Program } from '../models/Program.js';
import { showToast, showConfirmModal } from '../utils/helpers.js';

class ProgramsView {
    constructor() {
        this.app = app;
        this.currentProgram = null;
        this.isSaving = false;
        this.init();
    }

    init() {
        this.app.viewControllers.programs = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Create program button
        const createBtn = document.getElementById('create-program-btn');
        if (createBtn) {
            createBtn.addEventListener('click', () => this.openProgramModal());
        }

        // Modal close buttons
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('.modal').classList.remove('active');
            });
        });

        // Program form submission
        const programForm = document.getElementById('program-form');
        if (programForm) {
            programForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveProgram();
            });
        }

        // Add exercise to program button
        const addExerciseBtn = document.getElementById('add-exercise-to-program-btn');
        if (addExerciseBtn) {
            addExerciseBtn.addEventListener('click', () => this.openExercisePicker());
        }
    }

    render() {
        this.renderProgramsList();
    }

    renderProgramsList() {
        const container = document.getElementById('programs-list');
        const programs = this.app.programs;

        if (programs.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-folder-open"></i>
                    <p>No programs yet</p>
                    <button class="btn btn-primary" id="create-first-program">Create Your First Program</button>
                </div>
            `;

            document.getElementById('create-first-program')?.addEventListener('click', () => {
                this.openProgramModal();
            });
            return;
        }

        container.innerHTML = programs.map(program => `
            <div class="program-card" data-program-id="${program.id}">
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
                <div class="program-actions">
                    ${program.exercises.length > 0
                        ? `<button class="btn btn-primary" onclick="window.gymApp.viewControllers.programs.startWorkout(${program.id})">
                            <i class="fas fa-play"></i> Start
                        </button>`
                        : '<button class="btn btn-secondary" disabled title="Add exercises first">No Exercises</button>'
                    }
                    <button class="btn btn-secondary" onclick="window.gymApp.viewControllers.programs.editProgram(${program.id})">Edit</button>
                    <button class="btn btn-danger" onclick="window.gymApp.viewControllers.programs.deleteProgram(${program.id})">Delete</button>
                </div>
            </div>
        `).join('');
    }

    openProgramModal(programId = null) {
        const modal = document.getElementById('program-modal');
        const title = document.getElementById('program-modal-title');

        if (programId) {
            this.currentProgram = this.app.getProgramById(programId);
            title.textContent = 'Edit Program';
            document.getElementById('program-name').value = this.currentProgram.name;
            document.getElementById('program-description').value = this.currentProgram.description;
            this.renderProgramExercises();
        } else {
            this.currentProgram = new Program({
                name: '',
                description: '',
                exercises: []
            });
            title.textContent = 'Create Program';
            document.getElementById('program-name').value = '';
            document.getElementById('program-description').value = '';
            this.renderProgramExercises();
        }

        modal.classList.add('active');
    }

    renderProgramExercises() {
        const container = document.getElementById('program-exercises-list');
        if (!this.currentProgram || this.currentProgram.exercises.length === 0) {
            container.innerHTML = '<p>No exercises added yet</p>';
            return;
        }

        const totalExercises = this.currentProgram.exercises.length;
        container.innerHTML = this.currentProgram.exercises.map((exercise, index) => `
            <div class="exercise-day-item">
                <div class="exercise-day-header">
                    <div class="exercise-reorder-controls">
                        <button class="btn-icon btn-reorder"
                            onclick="window.gymApp.viewControllers.programs.moveExerciseUp(${index})"
                            ${index === 0 ? 'disabled' : ''}
                            title="Move up">
                            <i class="fas fa-arrow-up"></i>
                        </button>
                        <button class="btn-icon btn-reorder"
                            onclick="window.gymApp.viewControllers.programs.moveExerciseDown(${index})"
                            ${index === totalExercises - 1 ? 'disabled' : ''}
                            title="Move down">
                            <i class="fas fa-arrow-down"></i>
                        </button>
                    </div>
                    <h5>${exercise.exerciseName}</h5>
                    <button class="btn-icon" onclick="window.gymApp.viewControllers.programs.removeExerciseFromProgram(${index})" title="Remove">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="exercise-day-details">
                    <input type="number" placeholder="Sets" value="${exercise.targetSets}"
                        onchange="window.gymApp.viewControllers.programs.updateExerciseTargets(${index}, 'sets', this.value)"
                        class="small-input" min="1">
                    <span>×</span>
                    <input type="number" placeholder="Reps" value="${exercise.targetReps}"
                        onchange="window.gymApp.viewControllers.programs.updateExerciseTargets(${index}, 'reps', this.value)"
                        class="small-input" min="1">
                    <span>reps</span>
                </div>
            </div>
        `).join('');
    }

    saveProgram() {
        // Prevent duplicate submissions
        if (this.isSaving) {
            return;
        }
        this.isSaving = true;

        const name = document.getElementById('program-name').value.trim();
        const description = document.getElementById('program-description').value.trim();

        if (!name) {
            showToast('Program name is required', 'error');
            this.isSaving = false;
            return;
        }

        // Update current program
        this.currentProgram.name = name;
        this.currentProgram.description = description;

        // Check if this is a new program or edit
        const existingIndex = this.app.programs.findIndex(p => p.id === this.currentProgram.id);
        if (existingIndex >= 0) {
            // Update existing
            this.app.programs[existingIndex] = this.currentProgram;
        } else {
            // Add new
            this.app.programs.push(this.currentProgram);
        }

        this.app.savePrograms();
        showToast('Program saved successfully', 'success');
        document.getElementById('program-modal').classList.remove('active');
        this.render();

        // Reset saving flag after a short delay
        setTimeout(() => {
            this.isSaving = false;
        }, 500);
    }

    editProgram(programId) {
        this.openProgramModal(programId);
    }

    async deleteProgram(programId) {
        const program = this.app.programs.find(p => p.id === programId);
        if (!program) return;

        const message = `Are you sure you want to delete <strong>"${program.name}"</strong>?<br><br>This will permanently remove the program with ${program.exercises.length} exercise${program.exercises.length !== 1 ? 's' : ''}.<br><br><strong>This action cannot be undone.</strong>`;

        const confirmed = await showConfirmModal({
            title: 'Delete Program',
            message: message,
            confirmText: 'Delete Program',
            cancelText: 'Cancel',
            isDangerous: true
        });

        if (confirmed) {
            const index = this.app.programs.findIndex(p => p.id === programId);
            if (index >= 0) {
                this.app.programs.splice(index, 1);
                this.app.savePrograms();
                showToast('Program deleted successfully', 'info');
                this.render();
            }
        }
    }

    openExercisePicker() {
        const modal = document.getElementById('exercise-picker-modal');
        this.renderExercisePicker();
        modal.classList.add('active');

        // Set up search and filter listeners
        const searchInput = document.getElementById('exercise-search');
        const categoryFilter = document.getElementById('exercise-category-filter');
        const equipmentFilter = document.getElementById('exercise-equipment-filter');

        const filterExercises = () => {
            this.renderExercisePicker(
                searchInput.value,
                categoryFilter.value,
                equipmentFilter.value
            );
        };

        searchInput.removeEventListener('input', filterExercises);
        searchInput.addEventListener('input', filterExercises);
        categoryFilter.removeEventListener('change', filterExercises);
        categoryFilter.addEventListener('change', filterExercises);
        equipmentFilter.removeEventListener('change', filterExercises);
        equipmentFilter.addEventListener('change', filterExercises);
    }

    renderExercisePicker(searchTerm = '', category = '', equipment = '') {
        const container = document.getElementById('exercise-picker-list');

        let exercises = [...this.app.exerciseDatabase];

        // Filter by search term
        if (searchTerm) {
            const lower = searchTerm.toLowerCase();
            exercises = exercises.filter(ex =>
                ex.name.toLowerCase().includes(lower) ||
                ex.muscleGroup.toLowerCase().includes(lower)
            );
        }

        // Filter by category
        if (category) {
            exercises = exercises.filter(ex => ex.category === category);
        }

        // Filter by equipment
        if (equipment) {
            exercises = exercises.filter(ex => ex.equipment === equipment);
        }

        // Update dropdown states
        this.updatePickerDropdownStates(searchTerm, category, equipment);

        if (exercises.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No exercises found</p></div>';
            return;
        }

        container.innerHTML = exercises.map(exercise => `
            <div class="exercise-picker-card" onclick="window.gymApp.viewControllers.programs.selectExercise(${exercise.id})">
                <h4>${exercise.name}</h4>
                <div class="exercise-meta">
                    <span class="badge">${exercise.category}</span>
                    <span class="badge">${exercise.equipment}</span>
                </div>
                <p>${exercise.muscleGroup}</p>
            </div>
        `).join('');
    }

    updatePickerDropdownStates(searchTerm, currentCategory, currentEquipment) {
        const categorySelect = document.getElementById('exercise-category-filter');
        const equipmentSelect = document.getElementById('exercise-equipment-filter');

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

                    return matchesSearch && matchesThisCategory && matchesEquipment;
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

                    return matchesSearch && matchesCategory && matchesThisEquipment;
                }).length;

                option.disabled = count === 0;
            });
        }
    }

    selectExercise(exerciseId) {
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;

        // Add exercise to current program
        this.currentProgram.addExercise(
            exercise.id,
            exercise.name,
            3, // default target sets
            10, // default target reps
            ''
        );

        // Close exercise picker
        document.getElementById('exercise-picker-modal').classList.remove('active');

        // Update the exercise list display
        this.renderProgramExercises();

        showToast(`Added ${exercise.name}`, 'success');
    }

    removeExerciseFromProgram(index) {
        if (this.currentProgram) {
            this.currentProgram.removeExercise(index);
            this.renderProgramExercises();
        }
    }

    updateExerciseTargets(index, field, value) {
        if (this.currentProgram && this.currentProgram.exercises[index]) {
            if (field === 'sets') {
                this.currentProgram.exercises[index].targetSets = parseInt(value) || 3;
            } else if (field === 'reps') {
                this.currentProgram.exercises[index].targetReps = parseInt(value) || 10;
            }
        }
    }

    moveExerciseUp(index) {
        if (!this.currentProgram || index === 0) return;

        const exercises = this.currentProgram.exercises;
        // Swap with previous exercise
        [exercises[index - 1], exercises[index]] = [exercises[index], exercises[index - 1]];

        this.renderProgramExercises();
    }

    moveExerciseDown(index) {
        if (!this.currentProgram || index >= this.currentProgram.exercises.length - 1) return;

        const exercises = this.currentProgram.exercises;
        // Swap with next exercise
        [exercises[index], exercises[index + 1]] = [exercises[index + 1], exercises[index]];

        this.renderProgramExercises();
    }

    startWorkout(programId) {
        const program = this.app.getProgramById(programId);
        if (!program) {
            showToast('Program not found', 'error');
            return;
        }

        if (!program.exercises || program.exercises.length === 0) {
            showToast('This program has no exercises', 'error');
            return;
        }

        // Navigate to workout view
        this.app.showView('workout');

        // Start the workout after a short delay to ensure view is loaded
        setTimeout(() => {
            if (this.app.viewControllers.workout) {
                this.app.viewControllers.workout.startWorkout(programId);
            } else {
                showToast('Workout view not initialized', 'error');
                console.error('Workout view controller not found');
            }
        }, 100);
    }
}

// Initialize
new ProgramsView();
