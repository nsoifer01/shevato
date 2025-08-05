// Gym Tracker - Workout Management

class GymWorkout {
  constructor() {
    this.currentWorkout = null;
    this.timer = null;
    this.startTime = null;
    this.elapsedTime = 0;
    this.isAddingExercise = false;
    this.currentExerciseIndex = null;
    this.currentSetIndex = null;
    this.init();
  }

  init() {
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Start workout button
    const startBtn = document.getElementById('startWorkoutBtn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        this.startNewWorkout();
      });
    }

    // Quick log button
    const quickLogBtn = document.getElementById('quickLogBtn');
    if (quickLogBtn) {
      quickLogBtn.addEventListener('click', () => {
        this.quickLogWorkout();
      });
    }

    // Timer controls
    document.getElementById('timerStartBtn')?.addEventListener('click', () => this.startTimer());
    document.getElementById('timerPauseBtn')?.addEventListener('click', () => this.pauseTimer());
    document.getElementById('timerResetBtn')?.addEventListener('click', () => this.resetTimer());

    // Add exercise button
    const addExerciseBtn = document.getElementById('addExerciseBtn');
    if (addExerciseBtn) {
      addExerciseBtn.addEventListener('click', () => {
        this.isAddingExercise = true;
        window.gymUI.showSection('exercises');
      });
    }

    // Workout actions
    document.getElementById('completeWorkoutBtn')?.addEventListener('click', () => this.completeWorkout());
    document.getElementById('cancelWorkoutBtn')?.addEventListener('click', () => this.cancelWorkout());

    // Change template button
    document.getElementById('changeWorkoutBtn')?.addEventListener('click', () => this.showTemplateSelection());

    // Set form
    const setForm = document.getElementById('setForm');
    if (setForm) {
      setForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveSet();
      });
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.target.closest('.modal').classList.remove('active');
      });
    });

    // Close modal on outside click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.remove('active');
        }
      });
    });
  }

  startNewWorkout(templateId = null) {
    this.currentWorkout = {
      id: gymData.generateId(),
      date: new Date().toISOString(),
      exercises: [],
      duration: 0,
      templateId: templateId
    };

    if (templateId) {
      const template = gymData.getTemplate(templateId);
      if (template) {
        // Add template exercises to workout
        template.exercises.forEach(exerciseId => {
          const exercise = gymData.getExercise(exerciseId);
          if (exercise) {
            this.currentWorkout.exercises.push({
              exerciseId: exercise.id,
              sets: []
            });
          }
        });
      }
    }

    window.gymUI.showSection('workout');
    this.renderCurrentWorkout();
    this.startTimer();
  }

  quickLogWorkout() {
    // Show a simplified form for quick logging
    const quickLogHtml = `
      <div class="quick-log-form">
        <h3>Quick Log Workout</h3>
        <form id="quickLogForm">
          <div class="form-group">
            <label>Workout Type</label>
            <select id="quickLogType" required>
              <option value="">Select workout</option>
              <option value="cardio">Cardio Session</option>
              <option value="strength">Strength Training</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div class="form-group">
            <label>Duration (minutes)</label>
            <input type="number" id="quickLogDuration" min="1" required>
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea id="quickLogNotes" rows="3"></textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary">Save</button>
            <button type="button" class="btn-secondary" onclick="gymWorkout.closeQuickLog()">Cancel</button>
          </div>
        </form>
      </div>
    `;

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.id = 'quickLogModal';
    modal.innerHTML = `
      <div class="modal-content">
        ${quickLogHtml}
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('quickLogForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveQuickLog();
    });
  }

  saveQuickLog() {
    const type = document.getElementById('quickLogType').value;
    const duration = parseInt(document.getElementById('quickLogDuration').value);
    const notes = document.getElementById('quickLogNotes').value;

    const workout = {
      date: new Date().toISOString(),
      duration: duration * 60, // Convert to seconds
      exercises: [],
      notes: notes,
      type: type
    };

    gymData.addWorkout(workout);
    this.closeQuickLog();
    window.gymUI.updateDashboard();
    window.gymUI.showNotification('Workout logged successfully!', 'success');
  }

  closeQuickLog() {
    const modal = document.getElementById('quickLogModal');
    if (modal) modal.remove();
  }

  renderCurrentWorkout() {
    const container = document.getElementById('currentWorkoutExercises');
    if (!container) return;

    if (!this.currentWorkout || this.currentWorkout.exercises.length === 0) {
      container.innerHTML = '<p class="empty-state">No exercises added yet. Click "Add Exercise" to get started!</p>';
      return;
    }

    container.innerHTML = this.currentWorkout.exercises.map((exercise, index) => {
      const exerciseData = gymData.getExercise(exercise.exerciseId);
      if (!exerciseData) return '';

      return `
        <div class="exercise-item" data-exercise-index="${index}">
          <div class="exercise-header">
            <h4 class="exercise-name">${exerciseData.name}</h4>
            <div class="exercise-actions">
              <button class="btn-icon" onclick="gymWorkout.removeExercise(${index})" title="Remove">
                ❌
              </button>
            </div>
          </div>
          <div class="sets-container">
            ${exercise.sets.map((set, setIndex) => `
              <div class="set-item">
                <span class="set-number">Set ${setIndex + 1}</span>
                <span>${set.weight} ${gymData.getSettings().weightUnit} × ${set.reps} reps</span>
                <button class="btn-icon" onclick="gymWorkout.deleteSet(${index}, ${setIndex})">🗑️</button>
              </div>
            `).join('')}
            <button class="add-set-btn" onclick="gymWorkout.addSet(${index})">+ Add Set</button>
          </div>
        </div>
      `;
    }).join('');
  }

  addExerciseToWorkout(exerciseId) {
    if (!this.currentWorkout) {
      this.startNewWorkout();
    }

    this.currentWorkout.exercises.push({
      exerciseId: exerciseId,
      sets: []
    });

    this.isAddingExercise = false;
    this.renderCurrentWorkout();
    window.gymUI.showNotification('Exercise added to workout', 'success');
  }

  removeExercise(index) {
    if (confirm('Remove this exercise from the workout?')) {
      this.currentWorkout.exercises.splice(index, 1);
      this.renderCurrentWorkout();
    }
  }

  addSet(exerciseIndex) {
    this.currentExerciseIndex = exerciseIndex;
    const modal = document.getElementById('setModal');
    const form = document.getElementById('setForm');
    
    if (!modal || !form) {
      console.error('Set modal or form not found');
      return;
    }
    
    // Reset form
    form.reset();
    
    // Get last set values for convenience
    const exercise = this.currentWorkout.exercises[exerciseIndex];
    if (exercise.sets.length > 0) {
      const lastSet = exercise.sets[exercise.sets.length - 1];
      document.getElementById('setWeight').value = lastSet.weight;
      document.getElementById('setReps').value = lastSet.reps;
    }
    
    modal.classList.add('active');
    document.getElementById('setWeight').focus();
  }

  saveSet() {
    const weight = parseFloat(document.getElementById('setWeight').value) || 0;
    const reps = parseInt(document.getElementById('setReps').value) || 0;

    if (reps <= 0) {
      alert('Please enter valid reps');
      return;
    }

    const set = { weight, reps };
    this.currentWorkout.exercises[this.currentExerciseIndex].sets.push(set);
    
    this.renderCurrentWorkout();
    document.getElementById('setModal').classList.remove('active');
    
    // Check if this is a new PR
    const exercise = gymData.getExercise(this.currentWorkout.exercises[this.currentExerciseIndex].exerciseId);
    if (exercise && weight > (exercise.personalRecord || 0)) {
      this.celebrateNewPR(exercise.name, weight);
    }
  }

  deleteSet(exerciseIndex, setIndex) {
    if (confirm('Delete this set?')) {
      this.currentWorkout.exercises[exerciseIndex].sets.splice(setIndex, 1);
      this.renderCurrentWorkout();
    }
  }

  celebrateNewPR(exerciseName, weight) {
    // Create celebration effect
    const celebration = document.createElement('div');
    celebration.className = 'pr-celebration';
    celebration.innerHTML = `
      <div class="pr-content">
        <h2>🎉 NEW PERSONAL RECORD! 🎉</h2>
        <p>${exerciseName}: ${weight} ${gymData.getSettings().weightUnit}</p>
      </div>
    `;
    
    document.body.appendChild(celebration);
    
    // Create confetti effect
    for (let i = 0; i < 30; i++) {
      const confetti = document.createElement('div');
      confetti.className = 'confetti';
      confetti.style.left = Math.random() * 100 + '%';
      confetti.style.animationDelay = Math.random() * 3 + 's';
      confetti.style.backgroundColor = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#95E1D3'][Math.floor(Math.random() * 4)];
      document.body.appendChild(confetti);
      
      setTimeout(() => confetti.remove(), 3000);
    }
    
    setTimeout(() => celebration.remove(), 3000);
  }

  completeWorkout() {
    if (!this.currentWorkout) return;

    const hasExercises = this.currentWorkout.exercises.some(ex => ex.sets.length > 0);
    if (!hasExercises) {
      alert('Please add at least one exercise with sets before completing the workout.');
      return;
    }

    this.pauseTimer();
    this.currentWorkout.duration = this.elapsedTime;

    // Save workout
    gymData.addWorkout(this.currentWorkout);
    
    // Show completion message
    this.showWorkoutSummary();
    
    // Reset
    this.currentWorkout = null;
    this.resetTimer();
    
    // Update UI
    window.gymUI.updateDashboard();
    window.gymUI.showSection('dashboard');
  }

  showWorkoutSummary() {
    const totalSets = this.currentWorkout.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
    const totalVolume = this.currentWorkout.exercises.reduce((sum, ex) => {
      return sum + ex.sets.reduce((setSum, set) => setSum + (set.weight * set.reps), 0);
    }, 0);

    const summaryHtml = `
      <div class="workout-summary">
        <h2>Great Job! 💪</h2>
        <div class="summary-stats">
          <div class="summary-stat">
            <span class="stat-label">Duration</span>
            <span class="stat-value">${this.formatTime(this.elapsedTime)}</span>
          </div>
          <div class="summary-stat">
            <span class="stat-label">Exercises</span>
            <span class="stat-value">${this.currentWorkout.exercises.length}</span>
          </div>
          <div class="summary-stat">
            <span class="stat-label">Total Sets</span>
            <span class="stat-value">${totalSets}</span>
          </div>
          <div class="summary-stat">
            <span class="stat-label">Total Volume</span>
            <span class="stat-value">${totalVolume.toLocaleString()} ${gymData.getSettings().weightUnit}</span>
          </div>
        </div>
      </div>
    `;

    window.gymUI.showModal('Workout Complete!', summaryHtml);
  }

  cancelWorkout() {
    if (!this.currentWorkout) return;

    if (confirm('Cancel this workout? All progress will be lost.')) {
      this.currentWorkout = null;
      this.resetTimer();
      window.gymUI.showSection('dashboard');
    }
  }

  showTemplateSelection() {
    const templates = gymData.getAllTemplates();
    const templatesHtml = templates.map(template => `
      <div class="template-option" onclick="gymWorkout.selectTemplate('${template.id}')">
        <h4>${template.name}</h4>
        <p>${template.description}</p>
      </div>
    `).join('');

    const modalContent = `
      <div class="template-selection">
        <h3>Choose a Workout Template</h3>
        <div class="template-grid">
          ${templatesHtml}
        </div>
        <div class="template-actions">
          <button class="btn-secondary" onclick="gymWorkout.startNewWorkout()">Start Empty</button>
        </div>
      </div>
    `;

    window.gymUI.showModal('Select Template', modalContent);
  }

  selectTemplate(templateId) {
    document.querySelector('.modal').remove();
    this.startNewWorkout(templateId);
  }

  // Timer functions
  startTimer() {
    if (this.timer) return;

    if (!this.startTime) {
      this.startTime = Date.now() - this.elapsedTime * 1000;
    }

    this.timer = setInterval(() => {
      this.updateTimer();
    }, 1000);

    document.getElementById('timerStartBtn').disabled = true;
    document.getElementById('timerPauseBtn').disabled = false;
    document.getElementById('timerResetBtn').disabled = false;
  }

  pauseTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    document.getElementById('timerStartBtn').disabled = false;
    document.getElementById('timerPauseBtn').disabled = true;
  }

  resetTimer() {
    this.pauseTimer();
    this.elapsedTime = 0;
    this.startTime = null;
    this.updateTimerDisplay();

    document.getElementById('timerStartBtn').disabled = false;
    document.getElementById('timerPauseBtn').disabled = true;
    document.getElementById('timerResetBtn').disabled = true;
  }

  updateTimer() {
    this.elapsedTime = Math.floor((Date.now() - this.startTime) / 1000);
    this.updateTimerDisplay();
  }

  updateTimerDisplay() {
    const display = document.getElementById('workoutTimer');
    if (display) {
      display.textContent = this.formatTime(this.elapsedTime);
    }
  }

  formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    return [hours, minutes, secs]
      .map(val => val.toString().padStart(2, '0'))
      .join(':');
  }
}

// Workout styles
const workoutStyles = `
<style>
.add-set-btn {
  width: 100%;
  padding: 0.5rem;
  background: transparent;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-base);
  margin-top: 0.5rem;
}

.add-set-btn:hover {
  border-color: var(--gym-primary);
  color: var(--gym-primary);
  background: rgba(255, 107, 107, 0.1);
}

.pr-celebration {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 2000;
  animation: celebrationPulse 3s ease-out;
}

.pr-content {
  background: var(--gym-primary);
  color: white;
  padding: 2rem 3rem;
  border-radius: var(--radius-lg);
  text-align: center;
  box-shadow: 0 10px 40px rgba(255, 107, 107, 0.6);
}

.pr-content h2 {
  margin: 0 0 1rem 0;
  font-size: 2rem;
}

.pr-content p {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
}

@keyframes celebrationPulse {
  0% {
    transform: translate(-50%, -50%) scale(0.8);
    opacity: 0;
  }
  50% {
    transform: translate(-50%, -50%) scale(1.1);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0;
  }
}

.workout-summary {
  text-align: center;
  padding: 1rem;
}

.summary-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
  margin-top: 2rem;
}

.summary-stat {
  text-align: center;
}

.summary-stat .stat-label {
  display: block;
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}

.summary-stat .stat-value {
  display: block;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--gym-primary);
}

.template-grid {
  display: grid;
  gap: 1rem;
  margin: 1.5rem 0;
}

.template-option {
  padding: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-base);
}

.template-option:hover {
  border-color: var(--gym-primary);
  transform: translateY(-2px);
}

.template-option h4 {
  margin: 0 0 0.5rem 0;
  color: var(--text-primary);
}

.template-option p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.template-actions {
  text-align: center;
  margin-top: 1.5rem;
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', workoutStyles);

// Create global instance
window.gymWorkout = new GymWorkout();