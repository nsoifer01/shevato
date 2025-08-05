// Gym Tracker - UI Management

class GymUI {
  constructor() {
    this.currentSection = 'dashboard';
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.setupSyncListeners();
    this.updateDashboard();
  }

  setupSyncListeners() {
    // The universal sync UI handles status updates automatically
    // We just need to listen for data updates specific to gym tracker
    window.addEventListener('gymDataUpdated', () => {
      // Refresh current view
      if (this.currentSection === 'dashboard') {
        this.updateDashboard();
      }
    });

    // Update settings page sync info when Shevato sync status changes
    window.addEventListener('shevatoSyncStatusChanged', (e) => {
      const syncStatusTextEl = document.getElementById('syncStatusText');
      const deviceIdTextEl = document.getElementById('deviceIdText');
      
      if (!syncStatusTextEl || !deviceIdTextEl) return;
      
      switch (e.detail.status) {
        case 'connected':
          syncStatusTextEl.textContent = 'Connected - Waiting for sync';
          if (e.detail.userId) {
            deviceIdTextEl.textContent = e.detail.userId;
          }
          break;
        case 'synced':
          syncStatusTextEl.textContent = 'Synced ✓';
          break;
        case 'error':
          syncStatusTextEl.textContent = 'Error - Check console';
          break;
        case 'offline':
        default:
          syncStatusTextEl.textContent = 'Offline';
          deviceIdTextEl.textContent = 'Not connected';
          break;
      }
    });
  }

  setupEventListeners() {
    // Navigation links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        const section = e.currentTarget.dataset.section;
        this.showSection(section);
      });
    });

    // Mobile navigation toggle
    const navToggle = document.getElementById('navToggle');
    if (navToggle) {
      navToggle.addEventListener('click', () => {
        const navLinks = document.querySelector('.nav-links');
        navLinks.classList.toggle('active');
      });
    }

    // Settings form
    this.setupSettingsListeners();

    // Modal close on outside click
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) {
        e.target.remove();
      }
    });
  }

  setupSettingsListeners() {
    // Days per week
    const daysPerWeek = document.getElementById('workoutDaysPerWeek');
    if (daysPerWeek) {
      daysPerWeek.addEventListener('change', () => {
        this.updateSettings();
      });
    }

    // Workout days checkboxes
    document.querySelectorAll('input[name="workoutDay"]').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        this.updateSettings();
      });
    });

    // User info
    ['userName', 'userWeight', 'weightUnit'].forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('change', () => {
          this.updateSettings();
        });
      }
    });

    // Data management buttons
    document.getElementById('exportDataBtn')?.addEventListener('click', () => {
      gymData.exportData();
      this.showNotification('Data exported successfully!', 'success');
    });

    document.getElementById('importDataBtn')?.addEventListener('click', () => {
      this.showImportDialog();
    });

    document.getElementById('clearDataBtn')?.addEventListener('click', () => {
      if (gymData.clearAllData()) {
        window.location.reload();
      }
    });

    // Show welcome button
    document.getElementById('showWelcomeBtn')?.addEventListener('click', () => {
      if (window.gymApp && window.gymApp.showWelcome) {
        window.gymApp.showWelcome();
      }
    });

    // Load current settings
    this.loadSettings();
  }

  showSection(sectionId) {
    // Hide all sections
    document.querySelectorAll('.content-section').forEach(section => {
      section.classList.remove('active');
    });

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.remove('active');
    });

    // Show selected section
    const section = document.getElementById(sectionId);
    if (section) {
      section.classList.add('active');
      this.currentSection = sectionId;

      // Update active nav link
      const activeLink = document.querySelector(`[data-section="${sectionId}"]`);
      if (activeLink) {
        activeLink.classList.add('active');
      }

      // Section-specific updates
      switch (sectionId) {
        case 'dashboard':
          this.updateDashboard();
          break;
        case 'progress':
          if (!window.gymProgress.charts.frequency) {
            window.gymProgress.initializeCharts();
          } else {
            window.gymProgress.updateAllCharts();
          }
          break;
        case 'calendar':
          window.gymCalendar.renderCalendar();
          window.gymCalendar.updateWeeklySchedule();
          break;
        case 'training-plans':
          if (window.trainingPlans) {
            window.trainingPlans.show();
          }
          break;
      }
    }

    // Close mobile nav
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.remove('active');
  }

  updateDashboard() {
    const stats = gymData.getStats();
    const settings = gymData.getSettings();

    // Update stat cards
    document.getElementById('currentStreak').textContent = `${stats.currentStreak} days`;
    document.getElementById('weeklyWorkouts').textContent = 
      `${stats.weeklyWorkouts}/${settings.workoutDaysPerWeek} workouts`;
    document.getElementById('totalWorkouts').textContent = stats.totalWorkouts;
    document.getElementById('consistency').textContent = `${stats.consistency}%`;

    // Update recent activity
    this.updateRecentActivity();
  }

  updateRecentActivity() {
    const container = document.getElementById('recentActivityList');
    if (!container) return;

    const recentWorkouts = gymData.getAllWorkouts().slice(0, 5);

    if (recentWorkouts.length === 0) {
      container.innerHTML = '<p class="empty-state">No recent workouts. Let\'s get started! 💪</p>';
      return;
    }

    container.innerHTML = recentWorkouts.map(workout => {
      const date = new Date(workout.date);
      const duration = this.formatDuration(workout.duration);
      const exerciseCount = workout.exercises.length;
      const totalVolume = workout.exercises.reduce((sum, ex) => {
        return sum + ex.sets.reduce((setSum, set) => setSum + (set.weight * set.reps), 0);
      }, 0);

      return `
        <div class="activity-item hover-lift">
          <div class="activity-icon">💪</div>
          <div class="activity-details">
            <div class="activity-title">${this.getWorkoutTitle(workout)}</div>
            <div class="activity-meta">
              ${date.toLocaleDateString()} • ${duration} • ${exerciseCount} exercises
            </div>
          </div>
          <div class="activity-stats">
            ${totalVolume.toLocaleString()} ${gymData.getSettings().weightUnit}
          </div>
        </div>
      `;
    }).join('');
  }

  getWorkoutTitle(workout) {
    if (workout.templateId) {
      const template = gymData.getTemplate(workout.templateId);
      if (template) return template.name;
    }
    
    if (workout.type) {
      return workout.type.charAt(0).toUpperCase() + workout.type.slice(1) + ' Session';
    }

    // Try to determine workout type from exercises
    const muscleGroups = {};
    workout.exercises.forEach(ex => {
      const exercise = gymData.getExercise(ex.exerciseId);
      if (exercise) {
        muscleGroups[exercise.muscleGroup] = (muscleGroups[exercise.muscleGroup] || 0) + 1;
      }
    });

    const primaryGroup = Object.entries(muscleGroups)
      .sort((a, b) => b[1] - a[1])[0];

    if (primaryGroup) {
      return primaryGroup[0].charAt(0).toUpperCase() + primaryGroup[0].slice(1) + ' Workout';
    }

    return 'Workout';
  }

  formatDuration(seconds) {
    if (!seconds) return '0m';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  loadSettings() {
    const settings = gymData.getSettings();

    // Days per week
    const daysPerWeek = document.getElementById('workoutDaysPerWeek');
    if (daysPerWeek) daysPerWeek.value = settings.workoutDaysPerWeek;

    // Preferred days
    document.querySelectorAll('input[name="workoutDay"]').forEach(checkbox => {
      checkbox.checked = settings.preferredDays.includes(parseInt(checkbox.value));
    });

    // User info
    if (settings.userName) {
      document.getElementById('userName').value = settings.userName;
    }
    if (settings.userWeight) {
      document.getElementById('userWeight').value = settings.userWeight;
    }
    document.getElementById('weightUnit').value = settings.weightUnit;
  }

  updateSettings() {
    const settings = {
      workoutDaysPerWeek: parseInt(document.getElementById('workoutDaysPerWeek').value),
      preferredDays: Array.from(document.querySelectorAll('input[name="workoutDay"]:checked'))
        .map(cb => parseInt(cb.value)),
      userName: document.getElementById('userName').value,
      userWeight: parseFloat(document.getElementById('userWeight').value) || 0,
      weightUnit: document.getElementById('weightUnit').value
    };

    gymData.updateSettings(settings);
    this.updateDashboard();
    this.showNotification('Settings saved!', 'success');
  }

  showImportDialog() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (event) => {
        const success = gymData.importData(event.target.result);
        if (success) {
          this.showNotification('Data imported successfully!', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } else {
          this.showNotification('Failed to import data. Invalid format.', 'error');
        }
      };
      
      reader.readAsText(file);
    });
    
    input.click();
  }

  showModal(title, content) {
    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>${title}</h2>
          <button class="modal-close" onclick="this.closest('.modal').remove()">&times;</button>
        </div>
        <div class="modal-body">
          ${content}
        </div>
      </div>
    `;

    document.body.appendChild(modal);
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

// Create global instance
window.gymUI = new GymUI();