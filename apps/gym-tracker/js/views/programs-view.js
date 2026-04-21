/**
 * Programs View Controller
 * Program builder and management
 */
import { app } from '../app.js';
import { Program } from '../models/Program.js';
import { showToast, showConfirmModal } from '../utils/helpers.js';
import { storageService } from '../services/StorageService.js';
import { DarkSelect } from '../utils/dark-select.js';
import { orderPrograms } from '../utils/program-order.js';

class ProgramsView {
    constructor() {
        this.app = app;
        this.currentProgram = null;
        this.isSaving = false;
        this.sortMode = storageService.getProgramSort() || 'custom';
        this.programOrder = storageService.getProgramOrder() || [];
        this.dragState = null;
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

        // Modal close buttons. The program modal gets a special handler so we
        // can return the user to whichever view they came from (e.g. Dashboard).
        document.querySelectorAll('.modal-close').forEach(btn => {
            const modal = btn.closest('.modal');
            if (!modal) return;
            if (modal.id === 'program-modal') {
                btn.addEventListener('click', () => this.closeProgramModal());
            } else {
                btn.addEventListener('click', () => modal.classList.remove('active'));
            }
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

        // Sort dropdown — wrap with DarkSelect for the dark theme
        const sortSelect = document.getElementById('programs-sort');
        if (sortSelect) {
            sortSelect.value = this.sortMode;
            if (!sortSelect.dataset.darkSelectInit) {
                this.sortDropdown = new DarkSelect(sortSelect);
                sortSelect.dataset.darkSelectInit = '1';
            }
            sortSelect.addEventListener('change', (e) => {
                this.sortMode = e.target.value;
                storageService.saveProgramSort(this.sortMode);
                this.renderProgramsList();
            });
        }
    }

    render() {
        this.renderProgramsList();
    }

    // --- Sorting / ordering ---

    /** Return program ids in custom-order, syncing the saved order with the
     *  current program list (append new ids, prune deleted ones). */
    getCustomOrderedIds() {
        const currentIds = this.app.programs.map(p => p.id);
        const seen = new Set();
        const ordered = [];
        for (const id of this.programOrder) {
            if (currentIds.includes(id) && !seen.has(id)) {
                ordered.push(id);
                seen.add(id);
            }
        }
        // Append any program ids not yet in the saved order (newly created)
        for (const id of currentIds) {
            if (!seen.has(id)) {
                ordered.push(id);
                seen.add(id);
            }
        }
        if (ordered.length !== this.programOrder.length
            || ordered.some((id, i) => id !== this.programOrder[i])) {
            this.programOrder = ordered;
            storageService.saveProgramOrder(ordered);
        }
        return ordered;
    }

    getDisplayedPrograms() {
        // For 'custom', reconcile + persist the saved order first
        if (this.sortMode === 'custom') this.getCustomOrderedIds();
        return orderPrograms(this.app.programs, this.sortMode, this.programOrder);
    }

    // --- Drag & drop ---

    handleDragStart(e, programId) {
        // Drag always switches to custom mode (otherwise reorder wouldn't stick)
        if (this.sortMode !== 'custom') {
            this.sortMode = 'custom';
            storageService.saveProgramSort('custom');
            const sel = document.getElementById('programs-sort');
            if (sel) sel.value = 'custom';
            if (this.sortDropdown) this.sortDropdown.sync();
        }
        this.dragState = { fromId: programId };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(programId));
        e.currentTarget.classList.add('is-dragging');
    }

    handleDragEnd(e) {
        e.currentTarget.classList.remove('is-dragging');
        document.querySelectorAll('.program-card.is-drop-target')
            .forEach(c => c.classList.remove('is-drop-target'));
        this.dragState = null;
    }

    handleDragOver(e, programId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (this.dragState && programId === this.dragState.fromId) return;
        document.querySelectorAll('.program-card.is-drop-target')
            .forEach(c => c.classList.remove('is-drop-target'));
        e.currentTarget.classList.add('is-drop-target');
    }

    handleDragLeave(e) {
        e.currentTarget.classList.remove('is-drop-target');
    }

    handleDrop(e, targetId) {
        e.preventDefault();
        const fromIdRaw = e.dataTransfer.getData('text/plain');
        const fromId = Number(fromIdRaw);
        if (!fromId || fromId === targetId) return;

        const order = this.getCustomOrderedIds();
        const fromIdx = order.indexOf(fromId);
        const toIdx = order.indexOf(targetId);
        if (fromIdx < 0 || toIdx < 0) return;

        const [moved] = order.splice(fromIdx, 1);
        order.splice(toIdx, 0, moved);

        this.programOrder = order;
        storageService.saveProgramOrder(order);
        this.renderProgramsList();
    }

    renderProgramsList() {
        const container = document.getElementById('programs-list');
        const toolbar = document.getElementById('programs-toolbar');
        const programs = this.app.programs;

        // Hide toolbar if no programs to sort
        if (toolbar) toolbar.style.display = programs.length === 0 ? 'none' : '';

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

        const isCustom = this.sortMode === 'custom';
        const ordered = this.getDisplayedPrograms();

        container.classList.toggle('is-custom-order', isCustom);

        container.innerHTML = ordered.map(program => `
            <div class="program-card ${isCustom ? 'is-draggable' : ''}"
                 data-program-id="${program.id}"
                 ${isCustom ? 'draggable="true"' : ''}>
                ${isCustom ? `
                    <span class="program-card-handle" title="Drag to reorder" aria-hidden="true">
                        <i class="fas fa-grip-vertical"></i>
                    </span>
                ` : ''}
                <div class="program-header">
                    <h3>${program.name}</h3>
                </div>
                <p>${program.description || 'No description'}</p>
                <div class="program-stats">
                    <div class="stat">
                        <i class="fas fa-dumbbell"></i>
                        ${program.exercises.length} ${program.exercises.length === 1 ? 'exercise' : 'exercises'}
                    </div>
                </div>
                <div class="program-actions">
                    <button class="btn btn-secondary" onclick="window.gymApp.viewControllers.programs.editProgram(${program.id})">
                        <i class="fas fa-edit"></i> Edit
                    </button>
                    <button class="btn btn-danger" onclick="window.gymApp.viewControllers.programs.deleteProgram(${program.id})">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                </div>
            </div>
        `).join('');

        // Wire up drag-and-drop on every card so a drag from any sort mode flips to custom
        container.querySelectorAll('.program-card').forEach(card => {
            const id = Number(card.dataset.programId);
            // Make every card a valid drop target & drag source
            card.draggable = true;
            card.addEventListener('dragstart', (e) => this.handleDragStart(e, id));
            card.addEventListener('dragend',   (e) => this.handleDragEnd(e));
            card.addEventListener('dragover',  (e) => this.handleDragOver(e, id));
            card.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            card.addEventListener('drop',      (e) => this.handleDrop(e, id));
        });
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
        const countEl = document.getElementById('program-exercises-count');
        const totalExercises = this.currentProgram ? this.currentProgram.exercises.length : 0;
        if (countEl) countEl.textContent = totalExercises > 0
            ? `${totalExercises} ${totalExercises === 1 ? 'exercise' : 'exercises'}`
            : '';

        if (!this.currentProgram || totalExercises === 0) {
            container.innerHTML = `
                <div class="program-exercises-empty">
                    <i class="fas fa-dumbbell"></i>
                    <p>No exercises added yet</p>
                    <small>Use “Add Exercise” below to start building your program.</small>
                </div>
            `;
            return;
        }

        container.innerHTML = this.currentProgram.exercises.map((exercise, index) => `
            <div class="program-exercise-row">
                <div class="pex-reorder" aria-label="Reorder">
                    <button class="pex-reorder-btn"
                        onclick="window.gymApp.viewControllers.programs.moveExerciseUp(${index})"
                        ${index === 0 ? 'disabled' : ''}
                        title="Move up" type="button">
                        <i class="fas fa-chevron-up"></i>
                    </button>
                    <button class="pex-reorder-btn"
                        onclick="window.gymApp.viewControllers.programs.moveExerciseDown(${index})"
                        ${index === totalExercises - 1 ? 'disabled' : ''}
                        title="Move down" type="button">
                        <i class="fas fa-chevron-down"></i>
                    </button>
                </div>
                <div class="pex-position" aria-hidden="true">${index + 1}</div>
                <div class="pex-name">${exercise.exerciseName}</div>
                <button class="pex-delete"
                    onclick="window.gymApp.viewControllers.programs.removeExerciseFromProgram(${index})"
                    title="Remove exercise" type="button">
                    <i class="fas fa-xmark"></i>
                </button>
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
        this.render();
        this.closeProgramModal();

        // Reset saving flag after a short delay
        setTimeout(() => {
            this.isSaving = false;
        }, 500);
    }

    editProgram(programId) {
        // The program modal lives inside #programs-view, which is `display: none`
        // when another view is active. If the user triggered this from elsewhere
        // (e.g. the Dashboard's empty-program row), switch to the Programs view
        // first so the modal can actually render — and remember where they came
        // from so we can return them on close.
        if (this.app.currentView !== 'programs') {
            this.returnToView = this.app.currentView;
            this.app.showView('programs');
        }
        this.openProgramModal(programId);
    }

    /**
     * Close the Edit/Create program modal and, if the user opened it from
     * another view, take them back there. Used by every close path —
     * Cancel button, X button, and after a successful save.
     */
    closeProgramModal() {
        document.getElementById('program-modal').classList.remove('active');
        if (this.returnToView) {
            const target = this.returnToView;
            this.returnToView = null;
            this.app.showView(target);
        }
    }

    async deleteProgram(programId) {
        const program = this.app.programs.find(p => p.id === programId);
        if (!program) return;

        const exerciseCount = program.exercises.length;
        const message = `Are you sure you want to delete <strong>"${program.name}"</strong>? This will remove the program and its ${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''}.`;

        const confirmed = await showConfirmModal({
            title: 'Delete Program',
            message: message,
            warning: 'This action cannot be undone.',
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
