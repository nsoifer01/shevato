/**
 * Programs View Controller
 * Program builder and management
 */
import { app } from '../app.js';
import { Program, defaultRestForEquipment } from '../models/Program.js';
import { showToast, showConfirmModal, formatMuscleGroup, escapeHtml } from '../utils/helpers.js';
import { trapModalFocus } from '../utils/modal-focus.js';
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

        // Clear the program-name inline error as soon as the user starts
        // fixing it — no need to re-submit just to dismiss stale validation.
        const nameInput = document.getElementById('program-name');
        if (nameInput) {
            nameInput.addEventListener('input', () => {
                if (nameInput.value.trim()) this.showNameError(false);
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
        // Re-read the sort mode + saved order from storage on every render so
        // cross-device sync updates (via the storage-sync layer writing to
        // localStorage) are picked up next time this view paints.
        this.syncFromStorage();
        this.renderProgramsList();
    }

    /** Pull the latest sort/order from storage into the controller's cache,
     *  and keep the sort dropdown in sync if the mode changed remotely. */
    syncFromStorage() {
        const storedSort = storageService.getProgramSort() || 'custom';
        const storedOrder = storageService.getProgramOrder() || [];
        if (storedSort !== this.sortMode) {
            this.sortMode = storedSort;
            const sel = document.getElementById('programs-sort');
            if (sel) {
                sel.value = storedSort;
                if (this.sortDropdown) this.sortDropdown.sync();
            }
        }
        this.programOrder = storedOrder;
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

        container.innerHTML = ordered.map((program, index) => `
            <div class="program-card ${isCustom ? 'is-draggable' : ''}"
                 data-program-id="${program.id}"
                 ${isCustom ? 'draggable="true"' : ''}>
                ${isCustom ? `
                    <span class="program-card-handle" title="Drag to reorder" aria-hidden="true">
                        <i class="fas fa-grip-vertical"></i>
                    </span>
                ` : ''}
                <div class="program-header">
                    <h3>${escapeHtml(program.name)}</h3>
                </div>
                ${program.description && program.description.trim() ? `<p class="program-description">${escapeHtml(program.description)}</p>` : ''}
                <div class="program-stats">
                    <div class="stat">
                        <i class="fas fa-dumbbell"></i>
                        ${program.exercises.length} ${program.exercises.length === 1 ? 'exercise' : 'exercises'}
                    </div>
                </div>
                <div class="program-actions">
                    <button class="btn btn-secondary" data-action="edit-program" data-program-id="${program.id}">
                        <i class="fas fa-edit"></i> Edit
                    </button>
                    <button class="btn btn-danger" data-action="delete-program" data-program-id="${program.id}">
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

        this.wireProgramListActions(container);
    }

    /**
     * Single delegated click listener on the programs list container.
     * Replaces inline onclick="...editProgram(${id})" handlers with
     * data-action / data-program-id pairs so we can ship a strict CSP
     * later and avoid string-interpolating IDs into JS expressions.
     * Idempotent — guarded by a dataset flag so re-renders don't stack
     * listeners.
     */
    wireProgramListActions(container) {
        if (container.dataset.actionsWired) return;
        container.dataset.actionsWired = '1';
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || !container.contains(btn)) return;
            const id = Number(btn.dataset.programId);
            switch (btn.dataset.action) {
                case 'edit-program':
                    e.preventDefault();
                    this.editProgram(id);
                    break;
                case 'delete-program':
                    e.preventDefault();
                    this.deleteProgram(id);
                    break;
            }
        });
    }

    openProgramModal(programId = null) {
        const modal = document.getElementById('program-modal');
        const title = document.getElementById('program-modal-title');

        // Always open with a clean validation state — stale errors from a
        // prior session would be confusing before the user has done anything.
        this.showNameError(false);
        this.showExercisesError(false);

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
        trapModalFocus(modal);
    }

    renderProgramExercises() {
        const container = document.getElementById('program-exercises-list');
        const countEl = document.getElementById('program-exercises-count');
        const totalExercises = this.currentProgram ? this.currentProgram.exercises.length : 0;
        if (countEl) countEl.textContent = totalExercises > 0
            ? `${totalExercises} ${totalExercises === 1 ? 'exercise' : 'exercises'}`
            : '';

        // Adding an exercise clears the section error; removing the last one
        // doesn't auto-warn (the user sees the empty state), they'll get the
        // error on the next save attempt if it's still empty.
        if (totalExercises > 0) this.showExercisesError(false);

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

        const exercises = this.currentProgram.exercises;
        container.innerHTML = exercises.map((exercise, index) => {
            const details = this.app.getExerciseById(exercise.exerciseId);
            const muscle = formatMuscleGroup(details?.muscleGroup);
            const restLabel = formatRestLabel(exercise.restSeconds);
            // Visual cues for supersets. Group membership is computed from
            // adjacent rows: if this row shares groupId with the previous,
            // it's "linked above"; if with the next, "linked below". Used
            // only for styling (rounded corners on first / last of group,
            // squared in between).
            const prev = index > 0 ? exercises[index - 1] : null;
            const next = index < exercises.length - 1 ? exercises[index + 1] : null;
            const linkedAbove = !!(exercise.groupId && prev && prev.groupId === exercise.groupId);
            const linkedBelow = !!(exercise.groupId && next && next.groupId === exercise.groupId);
            const groupClasses = [
                exercise.groupId ? 'is-grouped' : '',
                linkedAbove ? 'is-linked-above' : '',
                linkedBelow ? 'is-linked-below' : '',
            ].filter(Boolean).join(' ');
            const linkBtnLabel = linkedAbove ? 'Unlink from previous' : 'Link with previous as superset';
            const linkBtnIcon = linkedAbove ? 'fa-link-slash' : 'fa-link';
            // First row can't link upward — there's nothing above it.
            const linkBtnHTML = index === 0 ? '' : `
                <button type="button" class="btn-icon btn-icon-link${linkedAbove ? ' is-on' : ''}"
                    data-action="${linkedAbove ? 'unlink-superset' : 'link-superset'}"
                    data-index="${index}"
                    aria-pressed="${linkedAbove ? 'true' : 'false'}"
                    aria-label="${linkBtnLabel}"
                    title="${linkBtnLabel}">
                    <i class="fas ${linkBtnIcon}" aria-hidden="true"></i>
                </button>
            `;
            return `
            <div class="program-exercise-row ${groupClasses}" draggable="true" data-exercise-index="${index}">
                ${linkedAbove ? `<span class="pex-superset-tag" aria-hidden="true">SUPERSET</span>` : ''}
                <span class="pex-drag-handle" aria-hidden="true" title="Drag to reorder">
                    <i class="fas fa-grip-vertical"></i>
                </span>
                <div class="pex-move-buttons" role="group" aria-label="Reorder exercise">
                    <button type="button" class="btn-icon btn-icon-move btn-icon-move-mini"
                        data-action="move-exercise-up"
                        data-index="${index}"
                        ${index === 0 ? 'disabled' : ''}
                        aria-label="Move ${escapeHtml(exercise.exerciseName)} up"
                        title="Move up">
                        <i class="fas fa-chevron-up"></i>
                    </button>
                    <button type="button" class="btn-icon btn-icon-move btn-icon-move-mini"
                        data-action="move-exercise-down"
                        data-index="${index}"
                        ${index === this.currentProgram.exercises.length - 1 ? 'disabled' : ''}
                        aria-label="Move ${escapeHtml(exercise.exerciseName)} down"
                        title="Move down">
                        <i class="fas fa-chevron-down"></i>
                    </button>
                </div>
                <div class="pex-position" aria-hidden="true">${index + 1}</div>
                <div class="pex-name">
                    <span class="pex-name-main">${escapeHtml(exercise.exerciseName)}</span>${muscle ? `
                    <span class="pex-name-sub">(${muscle})</span>` : ''}
                </div>
                <div class="pex-targets">
                    ${stepperHTML('sets', index, exercise.targetSets, 1, 20, 'Sets')}
                    ${stepperHTML('reps', index, exercise.targetReps, 1, 100, 'Reps')}
                    ${stepperHTML('rest', index, exercise.restSeconds, 0, 600, 'Rest', 15, restLabel)}
                </div>
                <div class="pex-row-actions">
                    ${linkBtnHTML}
                    <button class="pex-delete"
                        data-action="remove-exercise"
                        data-index="${index}"
                        title="Remove exercise" type="button" aria-label="Remove exercise">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>
            </div>
        `;}).join('');

        this.wireExerciseDragAndDrop(container);
        this.wireExerciseRowActions(container);
    }

    /**
     * Wire up delete + stepper interactions on each program-exercise row.
     * Uses data-action delegation so we don't paint inline onclicks (safer
     * + re-renderable).
     */
    wireExerciseRowActions(container) {
        container.querySelectorAll('[data-action="remove-exercise"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.index);
                this.removeExerciseFromProgram(idx);
            });
        });

        container.querySelectorAll('[data-action="move-exercise-up"]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.moveExerciseInProgram(Number(btn.dataset.index), -1);
            });
        });
        container.querySelectorAll('[data-action="move-exercise-down"]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.moveExerciseInProgram(Number(btn.dataset.index), +1);
            });
        });
        container.querySelectorAll('[data-action="link-superset"]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.toggleSupersetLink(Number(btn.dataset.index), true);
            });
        });
        container.querySelectorAll('[data-action="unlink-superset"]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.toggleSupersetLink(Number(btn.dataset.index), false);
            });
        });

        container.querySelectorAll('[data-stepper]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.index);
                const field = btn.dataset.field; // 'sets' | 'reps' | 'rest'
                const delta = Number(btn.dataset.delta);
                this.adjustExerciseTarget(idx, field, delta);
            });
        });
    }

    /**
     * Keyboard-accessible reorder for exercises inside the open Edit
     * Program modal. Equivalent to dragging the row up/down. Re-renders
     * the modal body and restores focus to the same arrow on the moved
     * row so repeated presses keep working without re-tabbing.
     */
    /**
     * Link the row at `index` into a superset with the row immediately
     * above it (link === true), or break the link upward (link === false).
     *
     * Linking rules:
     *   - The link button is hidden on row 0 (no row above).
     *   - Linking adopts the previous row's groupId. If the previous row
     *     wasn't in a group, a new groupId is created and assigned to
     *     both rows so they form a fresh 2-exercise superset.
     *   - Unlinking just clears this row's groupId. Any rows below us
     *     that share the same group keep their group intact (i.e. we
     *     split the group at this row).
     *
     * After mutating, re-renders the modal body and restores focus to
     * this row's link button so keyboard users can keep toggling.
     */
    toggleSupersetLink(index, link) {
        if (!this.currentProgram) return;
        const list = this.currentProgram.exercises;
        if (index <= 0 || index >= list.length) return;
        const cur = list[index];
        const prev = list[index - 1];

        if (link) {
            const groupId = prev.groupId || `g-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
            this.currentProgram.updateExercise(index - 1, { groupId });
            this.currentProgram.updateExercise(index, { groupId });
        } else {
            this.currentProgram.updateExercise(index, { groupId: null });
        }

        this.renderProgramExercises();
        const action = link ? 'unlink-superset' : 'link-superset';
        const btn = document.querySelector(
            `#program-exercises-list [data-action="${action}"][data-index="${index}"]`
        );
        if (btn) btn.focus();
    }

    moveExerciseInProgram(fromIndex, delta) {
        if (!this.currentProgram) return;
        const list = this.currentProgram.exercises;
        const toIndex = fromIndex + delta;
        if (fromIndex < 0 || toIndex < 0 || toIndex >= list.length) return;
        this.currentProgram.reorderExercise(fromIndex, toIndex);
        this.renderProgramExercises();
        const action = delta < 0 ? 'move-exercise-up' : 'move-exercise-down';
        const btn = document.querySelector(
            `#program-exercises-list [data-action="${action}"][data-index="${toIndex}"]`
        );
        if (btn && !btn.disabled) btn.focus();
    }

    adjustExerciseTarget(index, field, delta) {
        if (!this.currentProgram) return;
        const ex = this.currentProgram.exercises[index];
        if (!ex) return;
        const patch = {};
        if (field === 'sets') patch.targetSets = ex.targetSets + delta;
        else if (field === 'reps') patch.targetReps = ex.targetReps + delta;
        else if (field === 'rest') patch.restSeconds = ex.restSeconds + delta;
        else return;
        this.currentProgram.updateExercise(index, patch);
        this.renderProgramExercises();
    }

    wireExerciseDragAndDrop(container) {
        container.querySelectorAll('.program-exercise-row').forEach(row => {
            row.addEventListener('dragstart', (e) => this.handleExerciseDragStart(e, row));
            row.addEventListener('dragend',   ()  => this.handleExerciseDragEnd());
            row.addEventListener('dragover',  (e) => this.handleExerciseDragOver(e, row));
            row.addEventListener('dragleave', ()  => row.classList.remove('is-drop-above', 'is-drop-below'));
            row.addEventListener('drop',      (e) => this.handleExerciseDrop(e, row));
        });
    }

    handleExerciseDragStart(e, row) {
        this.draggedExerciseIndex = Number(row.dataset.exerciseIndex);
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox needs some payload for the drag to start at all
        try { e.dataTransfer.setData('text/plain', String(this.draggedExerciseIndex)); } catch {}
    }

    handleExerciseDragEnd() {
        this.draggedExerciseIndex = null;
        document.querySelectorAll('.program-exercise-row').forEach(r => {
            r.classList.remove('is-dragging', 'is-drop-above', 'is-drop-below');
        });
    }

    handleExerciseDragOver(e, row) {
        if (this.draggedExerciseIndex == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const isAbove = (e.clientY - rect.top) < rect.height / 2;
        row.classList.toggle('is-drop-above', isAbove);
        row.classList.toggle('is-drop-below', !isAbove);
    }

    handleExerciseDrop(e, row) {
        e.preventDefault();
        if (!this.currentProgram || this.draggedExerciseIndex == null) return;
        const from = this.draggedExerciseIndex;
        const targetIndex = Number(row.dataset.exerciseIndex);
        const rect = row.getBoundingClientRect();
        const isAbove = (e.clientY - rect.top) < rect.height / 2;
        let to = isAbove ? targetIndex : targetIndex + 1;
        if (from === to || from === to - 1) {
            this.handleExerciseDragEnd();
            return;
        }
        const exercises = this.currentProgram.exercises;
        const [moved] = exercises.splice(from, 1);
        if (from < to) to--;
        exercises.splice(to, 0, moved);
        this.handleExerciseDragEnd();
        this.renderProgramExercises();
    }

    saveProgram() {
        // Prevent duplicate submissions
        if (this.isSaving) {
            return;
        }
        this.isSaving = true;

        const name = document.getElementById('program-name').value.trim();
        const description = document.getElementById('program-description').value.trim();

        // Inline validation — name required, ≥1 exercise required. Show all
        // failures at once so the user doesn't fix name → click → see "now
        // add exercises" on a second round-trip.
        const nameMissing = !name;
        const noExercises = !this.currentProgram
            || !this.currentProgram.exercises
            || this.currentProgram.exercises.length === 0;

        this.showNameError(nameMissing);
        this.showExercisesError(noExercises);

        if (nameMissing || noExercises) {
            const firstInvalid = nameMissing
                ? document.getElementById('program-name')
                : document.getElementById('program-exercises-section');
            firstInvalid?.focus?.();
            firstInvalid?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
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
     * Open the Create Program modal from anywhere. Mirrors editProgram() but
     * starts a fresh program. Used by the Dashboard empty-state CTAs so the
     * user doesn't have to hunt for the Programs tab.
     */
    createProgramFromElsewhere() {
        if (this.app.currentView !== 'programs') {
            this.returnToView = this.app.currentView;
            this.app.showView('programs');
        }
        this.openProgramModal();
    }

    /**
     * Toggle the inline "name required" error on the Program Name field.
     * Drives both the label message and the red-border state on the input
     * (aria-invalid for screen readers, .is-invalid for styling).
     */
    showNameError(show) {
        const input = document.getElementById('program-name');
        const err = document.getElementById('program-name-error');
        if (!input || !err) return;
        if (show) {
            input.classList.add('is-invalid');
            input.setAttribute('aria-invalid', 'true');
            err.hidden = false;
        } else {
            input.classList.remove('is-invalid');
            input.setAttribute('aria-invalid', 'false');
            err.hidden = true;
        }
    }

    /**
     * Toggle the inline "add at least one exercise" error banner on the
     * Exercises section. Also outlines the container so the user can spot
     * the problem without reading the message first.
     */
    showExercisesError(show) {
        const section = document.getElementById('program-exercises-section');
        const err = document.getElementById('program-exercises-error');
        if (!section || !err) return;
        if (show) {
            section.classList.add('is-invalid-section');
            err.hidden = false;
        } else {
            section.classList.remove('is-invalid-section');
            err.hidden = true;
        }
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
        const message = `Are you sure you want to delete <strong>"${escapeHtml(program.name)}"</strong>? This will remove the program and its ${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''}.`;

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
        // Start each picker session with an empty selection — fresh picks,
        // not leftover state from a previous open.
        this.pickerSelection = new Map();
        this.renderExercisePicker();
        this.renderExercisePickerTray();
        modal.classList.add('active');
        trapModalFocus(modal);

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

        // One-time wire-up for tray controls (idempotent via dataset guard).
        this.wireExercisePickerTray();
    }

    wireExercisePickerTray() {
        const commitBtn = document.getElementById('exercise-picker-commit');
        const clearBtn = document.getElementById('exercise-picker-tray-clear');
        const trayList = document.getElementById('exercise-picker-tray-list');

        if (commitBtn && !commitBtn.dataset.wired) {
            commitBtn.addEventListener('click', () => this.commitExercisePickerSelection());
            commitBtn.dataset.wired = '1';
        }
        if (clearBtn && !clearBtn.dataset.wired) {
            clearBtn.addEventListener('click', () => {
                this.pickerSelection = new Map();
                this.renderExercisePicker(
                    document.getElementById('exercise-search')?.value || '',
                    document.getElementById('exercise-category-filter')?.value || '',
                    document.getElementById('exercise-equipment-filter')?.value || '',
                );
                this.renderExercisePickerTray();
            });
            clearBtn.dataset.wired = '1';
        }
        if (trayList && !trayList.dataset.wired) {
            // Event delegation: remove buttons + steppers inside the tray.
            trayList.addEventListener('click', (e) => {
                const remove = e.target.closest('[data-tray-action="remove"]');
                if (remove) {
                    const id = Number(remove.dataset.exerciseId);
                    this.pickerSelection.delete(id);
                    this.renderExercisePicker(
                        document.getElementById('exercise-search')?.value || '',
                        document.getElementById('exercise-category-filter')?.value || '',
                        document.getElementById('exercise-equipment-filter')?.value || '',
                    );
                    this.renderExercisePickerTray();
                    return;
                }
                const stepper = e.target.closest('[data-tray-stepper]');
                if (stepper) {
                    const id = Number(stepper.dataset.exerciseId);
                    const field = stepper.dataset.field;
                    const delta = Number(stepper.dataset.delta);
                    const item = this.pickerSelection.get(id);
                    if (!item) return;
                    if (field === 'sets') item.targetSets = clampTray(item.targetSets + delta, 1, 20);
                    else if (field === 'reps') item.targetReps = clampTray(item.targetReps + delta, 1, 100);
                    else if (field === 'rest') item.restSeconds = clampTray(item.restSeconds + delta, 0, 600);
                    this.renderExercisePickerTray();
                }
            });
            trayList.dataset.wired = '1';
        }
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

        const selection = this.pickerSelection || new Map();

        container.innerHTML = exercises.map(exercise => {
            const picked = selection.has(exercise.id);
            return `
                <div class="exercise-picker-card ${picked ? 'is-picked' : ''}"
                     data-exercise-id="${exercise.id}"
                     role="button" tabindex="0" aria-pressed="${picked ? 'true' : 'false'}">
                    <span class="exercise-picker-check" aria-hidden="true">
                        <i class="fas ${picked ? 'fa-check-circle' : 'fa-circle'}"></i>
                    </span>
                    <h4>${escapeHtml(exercise.name)}</h4>
                    <div class="exercise-meta">
                        <span class="badge">${escapeHtml(exercise.category)}</span>
                        <span class="badge">${escapeHtml(exercise.equipment)}</span>
                    </div>
                    <p>${escapeHtml(exercise.muscleGroup)}</p>
                </div>
            `;
        }).join('');

        // Delegate click/keyboard toggle for picker cards.
        container.querySelectorAll('.exercise-picker-card').forEach(card => {
            const id = Number(card.dataset.exerciseId);
            card.addEventListener('click', () => this.togglePickerExercise(id));
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.togglePickerExercise(id);
                }
            });
        });
    }

    togglePickerExercise(exerciseId) {
        if (!this.pickerSelection) this.pickerSelection = new Map();
        const exercise = this.app.getExerciseById(exerciseId);
        if (!exercise) return;

        if (this.pickerSelection.has(exerciseId)) {
            this.pickerSelection.delete(exerciseId);
        } else {
            this.pickerSelection.set(exerciseId, {
                id: exercise.id,
                name: exercise.name,
                targetSets: 3,
                targetReps: 10,
                restSeconds: defaultRestForEquipment(exercise.equipment),
            });
        }

        // Update just the card + tray (not whole list re-render, which kills scroll).
        const card = document.querySelector(`.exercise-picker-card[data-exercise-id="${exerciseId}"]`);
        if (card) {
            const picked = this.pickerSelection.has(exerciseId);
            card.classList.toggle('is-picked', picked);
            card.setAttribute('aria-pressed', picked ? 'true' : 'false');
            const checkIcon = card.querySelector('.exercise-picker-check i');
            if (checkIcon) {
                checkIcon.classList.toggle('fa-check-circle', picked);
                checkIcon.classList.toggle('fa-circle', !picked);
            }
        }
        this.renderExercisePickerTray();
    }

    renderExercisePickerTray() {
        const tray = document.getElementById('exercise-picker-tray');
        const list = document.getElementById('exercise-picker-tray-list');
        const count = document.getElementById('exercise-picker-tray-count');
        if (!tray || !list || !count) return;

        const items = Array.from((this.pickerSelection || new Map()).values());
        const n = items.length;

        tray.hidden = n === 0;
        count.textContent = `Added ${n}`;

        list.innerHTML = items.map((item) => `
            <li class="exercise-picker-tray-row" data-exercise-id="${item.id}">
                <div class="tray-name">${escapeHtml(item.name)}</div>
                <div class="tray-steppers">
                    ${trayStepperHTML(item.id, 'sets', item.targetSets, 'Sets')}
                    ${trayStepperHTML(item.id, 'reps', item.targetReps, 'Reps')}
                    ${trayStepperHTML(item.id, 'rest', item.restSeconds, 'Rest', 15, formatRestLabel(item.restSeconds))}
                </div>
                <button type="button" class="tray-remove"
                    data-tray-action="remove" data-exercise-id="${item.id}"
                    title="Remove from selection" aria-label="Remove from selection">
                    <i class="fas fa-xmark"></i>
                </button>
            </li>
        `).join('');
    }

    commitExercisePickerSelection() {
        const items = Array.from((this.pickerSelection || new Map()).values());
        if (items.length === 0) {
            showToast('Pick at least one exercise first', 'error');
            return;
        }
        items.forEach(item => {
            this.currentProgram.addExercise(
                item.id,
                item.name,
                item.targetSets,
                item.targetReps,
                '',
                item.restSeconds,
            );
        });

        document.getElementById('exercise-picker-modal').classList.remove('active');
        this.pickerSelection = new Map();
        this.renderExercisePickerTray();
        this.renderProgramExercises();
        showToast(`Added ${items.length} exercise${items.length === 1 ? '' : 's'}`, 'success');
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

    removeExerciseFromProgram(index) {
        if (this.currentProgram) {
            this.currentProgram.removeExercise(index);
            this.renderProgramExercises();
        }
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

/**
 * Compact +/- stepper for program-exercise target values.
 * `valueLabel` overrides the displayed label (used by rest which shows "1:30").
 */
function stepperHTML(field, index, value, min, max, label, step = 1, valueLabel = null) {
    const displayed = valueLabel ?? String(value);
    const atMin = value <= min;
    const atMax = value >= max;
    return `
        <div class="pex-stepper" data-field="${field}">
            <span class="pex-stepper-label">${label}</span>
            <span class="pex-stepper-controls">
                <button type="button" class="pex-stepper-btn"
                    data-stepper data-index="${index}" data-field="${field}" data-delta="${-step}"
                    ${atMin ? 'disabled' : ''}
                    aria-label="Decrease ${label.toLowerCase()}">
                    <i class="fas fa-minus"></i>
                </button>
                <span class="pex-stepper-value">${displayed}</span>
                <button type="button" class="pex-stepper-btn"
                    data-stepper data-index="${index}" data-field="${field}" data-delta="${step}"
                    ${atMax ? 'disabled' : ''}
                    aria-label="Increase ${label.toLowerCase()}">
                    <i class="fas fa-plus"></i>
                </button>
            </span>
        </div>
    `;
}

/**
 * Compact stepper used inside the exercise-picker tray. Differs from the
 * program-builder stepper in markup (no per-index lookup; keyed by exercise id).
 */
function trayStepperHTML(exerciseId, field, value, label, step = 1, valueLabel = null) {
    const display = valueLabel ?? String(value);
    return `
        <span class="pex-stepper" data-field="${field}">
            <span class="pex-stepper-label">${label}</span>
            <span class="pex-stepper-controls">
                <button type="button" class="pex-stepper-btn"
                    data-tray-stepper data-exercise-id="${exerciseId}" data-field="${field}" data-delta="${-step}"
                    aria-label="Decrease ${label.toLowerCase()}">
                    <i class="fas fa-minus"></i>
                </button>
                <span class="pex-stepper-value">${display}</span>
                <button type="button" class="pex-stepper-btn"
                    data-tray-stepper data-exercise-id="${exerciseId}" data-field="${field}" data-delta="${step}"
                    aria-label="Increase ${label.toLowerCase()}">
                    <i class="fas fa-plus"></i>
                </button>
            </span>
        </span>
    `;
}

function clampTray(n, min, max) {
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** "1:30", "45s", "0s" — short display optimized for the stepper pill. */
function formatRestLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`;
}

// Initialize
new ProgramsView();
