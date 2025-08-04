// Gym Tracker - Exercise Management

class GymExercises {
  constructor() {
    this.currentFilter = {
      search: '',
      muscleGroup: ''
    };
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.renderExerciseGrid();
  }

  setupEventListeners() {
    // Exercise search
    const searchInput = document.getElementById('exerciseSearch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.currentFilter.search = e.target.value.toLowerCase();
        this.renderExerciseGrid();
      });
    }

    // Muscle group filter
    const muscleFilter = document.getElementById('muscleGroupFilter');
    if (muscleFilter) {
      muscleFilter.addEventListener('change', (e) => {
        this.currentFilter.muscleGroup = e.target.value;
        this.renderExerciseGrid();
      });
    }

    // Create exercise button
    const createBtn = document.getElementById('createExerciseBtn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        this.showExerciseModal();
      });
    }

    // Exercise form
    const exerciseForm = document.getElementById('exerciseForm');
    if (exerciseForm) {
      exerciseForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleExerciseSubmit();
      });
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        this.closeModal();
      });
    });
  }

  renderExerciseGrid() {
    const grid = document.getElementById('exerciseGrid');
    if (!grid) return;

    const exercises = this.getFilteredExercises();

    if (exercises.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <p>No exercises found. Create your first exercise!</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = exercises.map(exercise => this.createExerciseCard(exercise)).join('');

    // Add click handlers
    grid.querySelectorAll('.exercise-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.exercise-actions')) {
          this.selectExercise(card.dataset.exerciseId);
        }
      });
    });
  }

  createExerciseCard(exercise) {
    const stats = this.getExerciseStats(exercise.id);
    
    return `
      <div class="exercise-card hover-lift" data-exercise-id="${exercise.id}">
        <div class="exercise-card-header">
          <div>
            <h3 class="exercise-card-title">${exercise.name}</h3>
            <span class="muscle-badge">${exercise.muscleGroup}</span>
          </div>
          <div class="exercise-actions">
            <button class="btn-icon" onclick="gymExercises.editExercise('${exercise.id}')" title="Edit">
              ✏️
            </button>
            <button class="btn-icon" onclick="gymExercises.deleteExercise('${exercise.id}')" title="Delete">
              🗑️
            </button>
          </div>
        </div>
        <div class="exercise-stats">
          <div class="exercise-stat">
            <span class="exercise-stat-label">Times Used</span>
            <span class="exercise-stat-value">${stats.timesUsed}</span>
          </div>
          <div class="exercise-stat">
            <span class="exercise-stat-label">Personal Record</span>
            <span class="exercise-stat-value">${exercise.personalRecord || 0} ${gymData.getSettings().weightUnit}</span>
          </div>
          <div class="exercise-stat">
            <span class="exercise-stat-label">Last Used</span>
            <span class="exercise-stat-value">${stats.lastUsed || 'Never'}</span>
          </div>
        </div>
      </div>
    `;
  }

  getFilteredExercises() {
    let exercises = gymData.getAllExercises();

    // Apply search filter
    if (this.currentFilter.search) {
      exercises = exercises.filter(ex => 
        ex.name.toLowerCase().includes(this.currentFilter.search)
      );
    }

    // Apply muscle group filter
    if (this.currentFilter.muscleGroup) {
      exercises = exercises.filter(ex => 
        ex.muscleGroup === this.currentFilter.muscleGroup
      );
    }

    return exercises;
  }

  getExerciseStats(exerciseId) {
    const workouts = gymData.getAllWorkouts();
    let timesUsed = 0;
    let lastUsed = null;

    workouts.forEach(workout => {
      const hasExercise = workout.exercises.some(ex => ex.exerciseId === exerciseId);
      if (hasExercise) {
        timesUsed++;
        if (!lastUsed || new Date(workout.date) > new Date(lastUsed)) {
          lastUsed = workout.date;
        }
      }
    });

    return {
      timesUsed,
      lastUsed: lastUsed ? this.formatDateRelative(lastUsed) : null
    };
  }

  formatDateRelative(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return date.toLocaleDateString();
  }

  showExerciseModal(exerciseId = null) {
    const modal = document.getElementById('exerciseModal');
    const title = document.getElementById('exerciseModalTitle');
    const form = document.getElementById('exerciseForm');

    if (exerciseId) {
      const exercise = gymData.getExercise(exerciseId);
      if (exercise) {
        title.textContent = 'Edit Exercise';
        form.exerciseName.value = exercise.name;
        form.exerciseMuscleGroup.value = exercise.muscleGroup;
        form.exerciseType.value = exercise.type;
        form.dataset.exerciseId = exerciseId;
      }
    } else {
      title.textContent = 'Create Exercise';
      form.reset();
      delete form.dataset.exerciseId;
    }

    modal.classList.add('active');
  }

  closeModal() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.classList.remove('active');
    });
  }

  handleExerciseSubmit() {
    const form = document.getElementById('exerciseForm');
    const exerciseData = {
      name: form.exerciseName.value.trim(),
      muscleGroup: form.exerciseMuscleGroup.value,
      type: form.exerciseType.value
    };

    if (!exerciseData.name) {
      alert('Please enter an exercise name');
      return;
    }

    if (form.dataset.exerciseId) {
      // Update existing exercise
      gymData.updateExercise(form.dataset.exerciseId, exerciseData);
      this.showNotification('Exercise updated successfully!', 'success');
    } else {
      // Create new exercise
      gymData.addExercise(exerciseData);
      this.showNotification('Exercise created successfully!', 'success');
    }

    this.closeModal();
    this.renderExerciseGrid();
  }

  editExercise(exerciseId) {
    this.showExerciseModal(exerciseId);
  }

  deleteExercise(exerciseId) {
    const exercise = gymData.getExercise(exerciseId);
    if (!exercise) return;

    if (confirm(`Delete "${exercise.name}"? This cannot be undone.`)) {
      gymData.deleteExercise(exerciseId);
      this.renderExerciseGrid();
      this.showNotification('Exercise deleted', 'info');
    }
  }

  selectExercise(exerciseId) {
    // This method can be used when adding exercises to a workout
    if (window.gymWorkout && window.gymWorkout.isAddingExercise) {
      window.gymWorkout.addExerciseToWorkout(exerciseId);
      window.gymUI.showSection('workout');
    }
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type} notification-slide`;
    notification.innerHTML = `
      <div class="notification-content">
        <span>${message}</span>
        <button class="notification-close" onclick="this.parentElement.parentElement.remove()">×</button>
      </div>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }
}

// Exercise Card Styles
const exerciseStyles = `
<style>
.btn-icon {
  background: none;
  border: none;
  font-size: 1.2rem;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: var(--radius-sm);
  transition: all var(--transition-base);
}

.btn-icon:hover {
  background: var(--bg-secondary);
}

.notification {
  position: fixed;
  top: 5rem;
  right: 1rem;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 1rem 1.5rem;
  box-shadow: var(--shadow-lg);
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 1rem;
  border-left: 4px solid;
}

.notification-success {
  border-left-color: var(--gym-success);
}

.notification-info {
  border-left-color: var(--gym-secondary);
}

.notification-error {
  border-left-color: var(--gym-danger);
}

.notification-content {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.notification-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.fade-out {
  opacity: 0;
  transform: translateX(100%);
  transition: all 0.3s ease-out;
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', exerciseStyles);

// Create global instance
window.gymExercises = new GymExercises();