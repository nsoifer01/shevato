// Gym Tracker - Main Application

class GymApp {
  constructor() {
    this.initialized = false;
    this.init();
  }

  init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initialize());
    } else {
      this.initialize();
    }
  }

  initialize() {
    if (this.initialized) return;
    
    console.log('Initializing Gym Tracker...');
    
    // Check for first time user
    const hasSeenWelcome = localStorage.getItem('gymTrackerWelcomeShown');
    
    if (!hasSeenWelcome) {
      this.showWelcome();
      localStorage.setItem('gymTrackerWelcomeShown', 'true');
    }
    
    // Set up error handling
    window.addEventListener('error', (e) => {
      console.error('Application error:', e);
    });
    
    // Auto-save on page unload
    window.addEventListener('beforeunload', () => {
      gymData.saveData();
    });
    
    // Initialize components (they're already created as global instances)
    // Just need to trigger any initial updates
    window.gymUI.updateDashboard();
    
    this.initialized = true;
    console.log('Gym Tracker initialized successfully');
  }

  showWelcome() {
    const welcomeContent = `
      <div class="welcome-content">
        <h2>Welcome to GymTracker! 💪</h2>
        <p>Your personal fitness journey starts here. Track workouts, monitor progress, and crush your goals!</p>
        
        <div class="welcome-features">
          <div class="feature">
            <span class="feature-icon">📊</span>
            <h4>Track Progress</h4>
            <p>Monitor your gains with detailed analytics and charts</p>
          </div>
          <div class="feature">
            <span class="feature-icon">🏋️</span>
            <h4>Log Workouts</h4>
            <p>Easy workout logging with exercise library</p>
          </div>
          <div class="feature">
            <span class="feature-icon">🏆</span>
            <h4>Achievements</h4>
            <p>Unlock achievements and celebrate milestones</p>
          </div>
          <div class="feature">
            <span class="feature-icon">📅</span>
            <h4>Schedule</h4>
            <p>Plan your workout week and stay consistent</p>
          </div>
        </div>
        
        <div class="welcome-actions">
          <button class="btn-primary" onclick="gymApp.startSetup()">Get Started</button>
        </div>
      </div>
    `;
    
    window.gymUI.showModal('Welcome to GymTracker', welcomeContent);
  }

  startSetup() {
    // Close welcome modal
    document.querySelector('.modal').remove();
    
    // Guide user to settings
    window.gymUI.showSection('settings');
    window.gymUI.showNotification('Set up your workout schedule to get started!', 'info');
    
    // Highlight the workout days section
    const workoutSection = document.querySelector('.settings-group');
    if (workoutSection) {
      workoutSection.classList.add('pulse-animation');
      setTimeout(() => {
        workoutSection.classList.remove('pulse-animation');
      }, 3000);
    }
  }

  // Quick access methods
  startWorkout() {
    window.gymWorkout.startNewWorkout();
  }

  viewProgress() {
    window.gymUI.showSection('progress');
  }

  viewCalendar() {
    window.gymUI.showSection('calendar');
  }

  // Demo data for testing
  generateDemoData() {
    if (!confirm('Generate demo workout data? This will add sample workouts to your history.')) {
      return;
    }

    const exercises = gymData.getAllExercises();
    const templates = gymData.getAllTemplates();
    
    // Generate 30 days of workouts
    for (let i = 0; i < 30; i++) {
      // Skip some days randomly
      if (Math.random() > 0.7) continue;
      
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(Math.floor(Math.random() * 12) + 8); // 8 AM to 8 PM
      
      const template = Object.values(templates)[Math.floor(Math.random() * Object.keys(templates).length)];
      const workout = {
        date: date.toISOString(),
        duration: Math.floor(Math.random() * 3600) + 1800, // 30-90 minutes
        templateId: template.id,
        exercises: []
      };
      
      // Add exercises from template
      template.exercises.forEach(exerciseId => {
        const exercise = exercises.find(ex => ex.id === exerciseId);
        if (!exercise) return;
        
        const workoutExercise = {
          exerciseId: exercise.id,
          sets: []
        };
        
        // Add 3-5 sets
        const setCount = Math.floor(Math.random() * 3) + 3;
        let baseWeight = Math.random() * 100 + 50;
        
        for (let s = 0; s < setCount; s++) {
          workoutExercise.sets.push({
            weight: Math.round(baseWeight + (Math.random() * 20 - 10)),
            reps: Math.floor(Math.random() * 8) + 5
          });
        }
        
        workout.exercises.push(workoutExercise);
      });
      
      gymData.addWorkout(workout);
    }
    
    window.location.reload();
  }
}

// Welcome styles
const appStyles = `
<style>
.welcome-content {
  padding: 1rem;
  max-width: 600px;
}

.welcome-features {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
  margin: 2rem 0;
}

.feature {
  text-align: center;
  padding: 1rem;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  transition: all var(--transition-base);
}

.feature:hover {
  transform: translateY(-5px);
  box-shadow: var(--shadow-md);
}

.feature-icon {
  font-size: 2.5rem;
  display: block;
  margin-bottom: 0.5rem;
}

.feature h4 {
  margin: 0.5rem 0;
  color: var(--gym-primary);
}

.feature p {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.welcome-actions {
  text-align: center;
  margin-top: 2rem;
}

@media (max-width: 480px) {
  .welcome-features {
    grid-template-columns: 1fr;
  }
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', appStyles);

// Export class to global scope for initialization
window.GymApp = GymApp;
// Note: Actual instantiation happens in gym-init.js

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + N for new workout
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    window.gymWorkout.startNewWorkout();
  }
  
  // Ctrl/Cmd + E for export
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    gymData.exportData();
  }
});