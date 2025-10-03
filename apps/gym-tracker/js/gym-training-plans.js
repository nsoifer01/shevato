// Gym Tracker - Training Plans Manager

class TrainingPlansManager {
  constructor() {
    this.storageKey = 'gymTrainingPlan';
    this.currentPlan = this.loadPlan();
    this.exerciseCounter = 0;
    this.currentExerciseInputId = null;
    this.initializeEventListeners();
    this.initializeExercisePicker();
  }

  initializeEventListeners() {
    // Day selection
    const daySelect = document.getElementById('daySelect');
    if (daySelect) {
      daySelect.addEventListener('change', () => this.handleDaySelection());
    }

    // Add exercise button
    const addExerciseBtn = document.getElementById('addExerciseToDay');
    if (addExerciseBtn) {
      addExerciseBtn.addEventListener('click', () => this.addExerciseInput());
    }

    // Save day plan button
    const saveDayBtn = document.getElementById('saveDayPlan');
    if (saveDayBtn) {
      saveDayBtn.addEventListener('click', () => this.saveDayPlan());
    }

    // Clear day exercises button
    const clearDayBtn = document.getElementById('clearDayExercises');
    if (clearDayBtn) {
      clearDayBtn.addEventListener('click', () => this.clearDayExercises());
    }

    // Export/Import buttons
    const exportBtn = document.getElementById('exportPlanBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportPlan());
    }

    const importBtn = document.getElementById('importPlanBtn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        document.getElementById('importPlanFile').click();
      });
    }

    const importFile = document.getElementById('importPlanFile');
    if (importFile) {
      importFile.addEventListener('change', (e) => this.importPlan(e));
    }

    // Plan management buttons
    const clearBtn = document.getElementById('clearPlanBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearPlan());
    }

    const backupBtn = document.getElementById('backupPlanBtn');
    if (backupBtn) {
      backupBtn.addEventListener('click', () => this.backupPlan());
    }

    const loadSampleBtn = document.getElementById('loadSamplePlanBtn');
    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', () => this.loadSamplePlan());
    }
  }

  loadPlan() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error('Error loading training plan:', error);
      return {};
    }
  }

  savePlanToStorage() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.currentPlan));
      this.displayCurrentPlan();
      return true;
    } catch (error) {
      console.error('Error saving training plan:', error);
      return false;
    }
  }

  handleDaySelection() {
    const daySelect = document.getElementById('daySelect');
    const exerciseInputs = document.getElementById('exerciseInputs');
    const selectedDayName = document.getElementById('selectedDayName');
    const exerciseList = document.getElementById('exerciseList');
    const clearButton = document.getElementById('clearDayExercises');
    const title = document.getElementById('planBuilderTitle');

    if (daySelect.value) {
      exerciseInputs.style.display = 'block';
      selectedDayName.textContent = daySelect.value;
      
      // Update title based on whether we're editing or creating
      if (title) {
        if (this.currentPlan[daySelect.value]) {
          title.textContent = `Edit ${daySelect.value} Plan`;
        } else {
          title.textContent = 'Create Your Weekly Plan';
        }
      }
      
      // Clear existing inputs
      exerciseList.innerHTML = '';
      this.exerciseCounter = 0;

      // Load existing exercises for this day if any
      if (this.currentPlan[daySelect.value]) {
        this.currentPlan[daySelect.value].forEach((exercise, index) => {
          this.addExerciseInput(exercise);
        });
        // Show clear button when editing existing plan
        clearButton.style.display = 'inline-block';
      } else {
        // Add one empty input to start
        this.addExerciseInput();
        clearButton.style.display = 'none';
      }
    } else {
      exerciseInputs.style.display = 'none';
    }
  }

  addExerciseInput(exerciseData = null) {
    const exerciseList = document.getElementById('exerciseList');
    const exerciseId = `exercise-${this.exerciseCounter++}`;
    
    const exerciseRow = document.createElement('div');
    exerciseRow.className = 'exercise-input-row';
    exerciseRow.id = exerciseId;
    
    exerciseRow.innerHTML = `
      <div class="exercise-name-input-wrapper">
        <input type="text" placeholder="Exercise name" class="exercise-name-input" 
               value="${exerciseData ? exerciseData.exercise : ''}"
               id="exercise-name-${exerciseId}">
        <button type="button" class="exercise-select-btn" 
                onclick="trainingPlans.openExercisePicker('${exerciseId}')">📋</button>
      </div>
      <input type="number" placeholder="Sets" min="1" max="10" class="sets-input" 
             value="${exerciseData ? exerciseData.sets : ''}">
      <input type="number" placeholder="Reps" min="1" max="50" class="reps-input" 
             value="${exerciseData ? exerciseData.reps : ''}">
      <button type="button" class="remove-btn" onclick="trainingPlans.removeExerciseInput('${exerciseId}')">×</button>
    `;
    
    exerciseList.appendChild(exerciseRow);
  }

  removeExerciseInput(exerciseId) {
    const element = document.getElementById(exerciseId);
    if (element) {
      element.remove();
    }
  }

  clearDayExercises() {
    const exerciseList = document.getElementById('exerciseList');
    const daySelect = document.getElementById('daySelect');
    
    if (confirm(`Clear all exercises for ${daySelect.value}?`)) {
      exerciseList.innerHTML = '';
      this.exerciseCounter = 0;
      this.addExerciseInput(); // Add one empty input
    }
  }

  saveDayPlan() {
    const daySelect = document.getElementById('daySelect');
    const selectedDay = daySelect.value;
    
    if (!selectedDay) {
      this.showNotification('Please select a day first', 'error');
      return;
    }

    const exercises = [];
    const exerciseRows = document.querySelectorAll('.exercise-input-row');
    
    exerciseRows.forEach(row => {
      const nameInput = row.querySelector('.exercise-name-input');
      const setsInput = row.querySelector('.sets-input');
      const repsInput = row.querySelector('.reps-input');
      
      const name = nameInput.value.trim();
      const sets = setsInput.value ? parseInt(setsInput.value) : null;
      const reps = repsInput.value ? parseInt(repsInput.value) : null;
      
      if (name) {
        exercises.push({
          exercise: name,
          sets: sets,
          reps: reps
        });
      }
    });

    if (exercises.length === 0) {
      this.showNotification('Please add at least one exercise', 'error');
      return;
    }

    // Save to current plan
    this.currentPlan[selectedDay] = exercises;
    
    if (this.savePlanToStorage()) {
      this.showNotification(`${selectedDay} plan saved successfully!`, 'success');
      // Reset form
      daySelect.value = '';
      document.getElementById('exerciseInputs').style.display = 'none';
    }
  }

  displayCurrentPlan() {
    const display = document.getElementById('weeklyPlanDisplay');
    
    if (Object.keys(this.currentPlan).length === 0) {
      display.innerHTML = '<p class="empty-state">No training plan created yet. Start by selecting a day above!</p>';
      return;
    }

    let html = '';
    const daysOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    
    daysOrder.forEach(day => {
      if (this.currentPlan[day]) {
        html += `
          <div class="day-plan">
            <h4>${day} 
              <div class="day-actions">
                <button class="btn-sm btn-primary" onclick="trainingPlans.editDay('${day}')">Edit</button>
                <button class="btn-sm btn-danger" onclick="trainingPlans.deleteDay('${day}')">Delete</button>
              </div>
            </h4>
            <div class="exercises-list">
        `;
        
        this.currentPlan[day].forEach((exercise, index) => {
          const exerciseInfo = exercise.sets && exercise.reps 
            ? ` - ${exercise.sets} sets × ${exercise.reps} reps`
            : '';
          
          html += `
            <div class="exercise-item">
              <div class="exercise-details">
                <strong>${exercise.exercise}</strong>${exerciseInfo}
              </div>
              <div class="exercise-actions">
                <button class="edit-btn" onclick="trainingPlans.editExercise('${day}', ${index})">Edit</button>
                <button class="delete-btn" onclick="trainingPlans.deleteExercise('${day}', ${index})">Delete</button>
              </div>
            </div>
          `;
        });
        
        html += `
            </div>
          </div>
        `;
      }
    });
    
    display.innerHTML = html;
  }

  editDay(day) {
    // Update the title
    const title = document.getElementById('planBuilderTitle');
    if (title) {
      title.textContent = `Edit ${day} Plan`;
    }
    
    // Set the day selector to the selected day
    const daySelect = document.getElementById('daySelect');
    daySelect.value = day;
    
    // Trigger the day selection to load existing exercises
    this.handleDaySelection();
    
    // Scroll to the plan builder section
    const planBuilder = document.querySelector('.plan-builder');
    if (planBuilder) {
      planBuilder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    this.showNotification(`Editing ${day} plan`, 'info');
  }

  deleteDay(day) {
    if (confirm(`Are you sure you want to delete all exercises for ${day}?`)) {
      delete this.currentPlan[day];
      this.savePlanToStorage();
      this.showNotification(`${day} plan deleted`, 'success');
    }
  }

  deleteExercise(day, index) {
    if (this.currentPlan[day]) {
      this.currentPlan[day].splice(index, 1);
      if (this.currentPlan[day].length === 0) {
        delete this.currentPlan[day];
      }
      this.savePlanToStorage();
      this.showNotification('Exercise deleted', 'success');
    }
  }

  editExercise(day, index) {
    const exercise = this.currentPlan[day][index];
    const newName = prompt('Exercise name:', exercise.exercise);
    if (newName === null) return;
    
    const newSets = prompt('Number of sets (optional):', exercise.sets || '');
    if (newSets === null) return;
    
    const newReps = prompt('Number of reps (optional):', exercise.reps || '');
    if (newReps === null) return;
    
    if (newName) {
      this.currentPlan[day][index] = {
        exercise: newName.trim(),
        sets: newSets ? parseInt(newSets) : null,
        reps: newReps ? parseInt(newReps) : null
      };
      this.savePlanToStorage();
      this.showNotification('Exercise updated', 'success');
    }
  }

  exportPlan() {
    if (Object.keys(this.currentPlan).length === 0) {
      this.showNotification('No plan to export', 'error');
      return;
    }

    const dataStr = JSON.stringify(this.currentPlan, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportName = `training-plan-${new Date().toISOString().split('T')[0]}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportName);
    linkElement.click();
    
    this.showNotification('Plan exported successfully', 'success');
  }

  importPlan(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importedPlan = JSON.parse(e.target.result);
        
        // Validate the structure
        let isValid = true;
        for (const day in importedPlan) {
          if (!Array.isArray(importedPlan[day])) {
            isValid = false;
            break;
          }
          for (const exercise of importedPlan[day]) {
            if (!exercise.exercise || !exercise.sets || !exercise.reps) {
              isValid = false;
              break;
            }
          }
        }
        
        if (isValid) {
          this.currentPlan = importedPlan;
          this.savePlanToStorage();
          this.showNotification('Plan imported successfully', 'success');
        } else {
          this.showNotification('Invalid plan format', 'error');
        }
      } catch (error) {
        this.showNotification('Error reading file', 'error');
      }
    };
    
    reader.readAsText(file);
    event.target.value = ''; // Reset input
  }

  clearPlan() {
    if (confirm('Are you sure you want to clear your entire training plan?')) {
      this.currentPlan = {};
      this.savePlanToStorage();
      this.showNotification('Plan cleared', 'success');
    }
  }

  backupPlan() {
    this.exportPlan();
  }

  loadSamplePlan() {
    const samplePlan = {
      "Monday": [
        { "exercise": "Bench Press", "sets": null, "reps": null },
        { "exercise": "Incline Dumbbell Press", "sets": null, "reps": null },
        { "exercise": "Tricep Dips", "sets": null, "reps": null },
        { "exercise": "Overhead Press", "sets": null, "reps": null }
      ],
      "Wednesday": [
        { "exercise": "Deadlift", "sets": null, "reps": null },
        { "exercise": "Pull-ups", "sets": null, "reps": null },
        { "exercise": "Barbell Row", "sets": null, "reps": null },
        { "exercise": "Bicep Curls", "sets": null, "reps": null }
      ],
      "Friday": [
        { "exercise": "Squat", "sets": null, "reps": null },
        { "exercise": "Leg Press", "sets": null, "reps": null },
        { "exercise": "Leg Curls", "sets": null, "reps": null },
        { "exercise": "Calf Raises", "sets": null, "reps": null }
      ]
    };
    
    if (confirm('This will replace your current plan. Continue?')) {
      this.currentPlan = samplePlan;
      this.savePlanToStorage();
      this.showNotification('Sample plan loaded', 'success');
    }
  }

  showNotification(message, type = 'info') {
    // Use the existing notification system if available
    if (window.gymUI && window.gymUI.showNotification) {
      window.gymUI.showNotification(message, type);
    } else {
      // Fallback to console
      console.log(`[${type}] ${message}`);
    }
  }

  // Initialize the display when the section is shown
  show() {
    this.displayCurrentPlan();
  }

  // Exercise Picker functionality
  initializeExercisePicker() {
    const modal = document.getElementById('exercisePickerModal');
    if (!modal) return;

    // Close button
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
      });
    }

    // Click outside to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });

    // Search functionality
    const searchInput = document.getElementById('exercisePickerSearch');
    if (searchInput) {
      searchInput.addEventListener('input', () => this.filterExercises());
    }

    // Muscle group filter
    const muscleFilter = document.getElementById('exercisePickerMuscleFilter');
    if (muscleFilter) {
      muscleFilter.addEventListener('change', () => this.filterExercises());
    }
  }

  openExercisePicker(exerciseInputId) {
    this.currentExerciseInputId = exerciseInputId;
    const modal = document.getElementById('exercisePickerModal');
    
    // Load exercises
    this.loadExercisesInPicker();
    
    // Show modal
    modal.classList.add('active');
    
    // Focus search
    const searchInput = document.getElementById('exercisePickerSearch');
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
  }

  loadExercisesInPicker() {
    const exerciseList = document.getElementById('exercisePickerList');
    const exercises = window.gymData.getAllExercises();
    
    exerciseList.innerHTML = '';
    
    exercises.forEach(exercise => {
      const item = document.createElement('div');
      item.className = 'exercise-picker-item';
      item.dataset.exerciseId = exercise.id;
      item.dataset.exerciseName = exercise.name;
      item.dataset.muscleGroup = exercise.muscleGroup;
      
      item.innerHTML = `
        <h4>${exercise.name}</h4>
        <p>${exercise.muscleGroup} • ${exercise.type}</p>
      `;
      
      item.addEventListener('click', () => this.selectExercise(exercise.name));
      
      exerciseList.appendChild(item);
    });
  }

  filterExercises() {
    const searchValue = document.getElementById('exercisePickerSearch').value.toLowerCase();
    const muscleGroup = document.getElementById('exercisePickerMuscleFilter').value;
    const items = document.querySelectorAll('.exercise-picker-item');
    
    items.forEach(item => {
      const name = item.dataset.exerciseName.toLowerCase();
      const itemMuscleGroup = item.dataset.muscleGroup;
      
      const matchesSearch = name.includes(searchValue);
      const matchesMuscle = !muscleGroup || itemMuscleGroup === muscleGroup;
      
      item.style.display = matchesSearch && matchesMuscle ? 'block' : 'none';
    });
  }

  selectExercise(exerciseName) {
    if (this.currentExerciseInputId) {
      const input = document.getElementById(`exercise-name-${this.currentExerciseInputId}`);
      if (input) {
        input.value = exerciseName;
      }
    }
    
    // Close modal
    const modal = document.getElementById('exercisePickerModal');
    modal.classList.remove('active');
    
    // Clear current selection
    this.currentExerciseInputId = null;
  }
}

// Export class to global scope for initialization
window.GymTrainingPlans = TrainingPlansManager;
// Note: Actual instantiation happens in gym-init.js