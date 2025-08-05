// Enhanced Gym Tracker - Data Management
// Excludes static exercise data from storage, only saves user-specific data

class GymDataEnhanced {
  constructor() {
    this.storageKey = 'gymTrackerData';
    this.data = this.loadData();
    this.initializeDefaults();
  }

  initializeDefaults() {
    // Initialize only user-specific data
    if (!this.data.settings) {
      this.data.settings = {
        workoutDaysPerWeek: 3,
        preferredDays: [1, 3, 5], // Mon, Wed, Fri
        userName: '',
        userWeight: 0,
        weightUnit: 'lbs'
      };
    }

    if (!this.data.workouts) {
      this.data.workouts = [];
    }

    if (!this.data.trainingPlan) {
      this.data.trainingPlan = {};
    }

    // Note: We don't store exercises or achievements in user data
    // They are loaded from static sources
    
    this.saveData();
  }

  loadData() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error('Error loading data:', error);
      return {};
    }
  }

  saveData() {
    try {
      // Filter out any static data that might have been saved before
      const dataToSave = {
        settings: this.data.settings,
        workouts: this.data.workouts,
        trainingPlan: this.data.trainingPlan
      };
      
      // Save to local storage
      localStorage.setItem(this.storageKey, JSON.stringify(dataToSave));
      
      return true;
    } catch (error) {
      console.error('Error saving data:', error);
      return false;
    }
  }


  // Settings Management
  getSettings() {
    return this.data.settings;
  }

  updateSettings(settings) {
    this.data.settings = { ...this.data.settings, ...settings };
    this.saveData(); // Immediate sync
  }

  // Exercise Management - Now loads from static database
  getAllExercises() {
    // Load from static exercise database
    if (typeof exerciseDatabase !== 'undefined') {
      return Object.values(exerciseDatabase);
    }
    return [];
  }

  getExercise(id) {
    if (typeof exerciseDatabase !== 'undefined') {
      return exerciseDatabase[id];
    }
    return null;
  }

  // Note: We no longer support adding custom exercises to simplify sync
  // All exercises come from the static database

  // Workout Management
  getAllWorkouts() {
    return this.data.workouts.sort((a, b) => 
      new Date(b.date) - new Date(a.date)
    );
  }

  getWorkout(id) {
    return this.data.workouts.find(w => w.id === id);
  }

  addWorkout(workout) {
    const newWorkout = {
      id: this.generateId(),
      date: new Date().toISOString(),
      duration: 0,
      exercises: [],
      ...workout
    };
    this.data.workouts.push(newWorkout);
    this.saveData(); // Immediate sync
    this.checkAchievements();
    return newWorkout;
  }

  updateWorkout(id, updates) {
    const index = this.data.workouts.findIndex(w => w.id === id);
    if (index !== -1) {
      this.data.workouts[index] = { ...this.data.workouts[index], ...updates };
      this.saveData(); // Immediate sync
      this.updatePersonalRecords(this.data.workouts[index]);
      this.checkAchievements();
      return true;
    }
    return false;
  }

  deleteWorkout(id) {
    this.data.workouts = this.data.workouts.filter(w => w.id !== id);
    this.saveData(); // Immediate sync
  }

  // Template Management - Templates are derived from training plans
  getAllTemplates() {
    const templates = {};
    
    // Convert training plans to templates
    Object.entries(this.data.trainingPlan).forEach(([day, exercises]) => {
      templates[day.toLowerCase()] = {
        id: day.toLowerCase(),
        name: `${day} Training`,
        exercises: exercises
      };
    });
    
    return Object.values(templates);
  }

  getTemplate(id) {
    const day = Object.keys(this.data.trainingPlan).find(d => d.toLowerCase() === id);
    if (day) {
      return {
        id: day.toLowerCase(),
        name: `${day} Training`,
        exercises: this.data.trainingPlan[day]
      };
    }
    return null;
  }

  // Training Plans Management
  getTrainingPlan() {
    if (!this.data.trainingPlan) {
      this.data.trainingPlan = {};
    }
    return this.data.trainingPlan;
  }

  updateTrainingPlan(plan) {
    this.data.trainingPlan = plan;
    this.saveData(); // Immediate sync
  }

  // Convert training plan to template format for workout usage
  convertPlanDayToTemplate(dayPlan, dayName) {
    const exercises = dayPlan.map(exercise => {
      // Find matching exercise ID from the exercise library
      const exerciseObj = Object.values(exerciseDatabase || {}).find(
        ex => ex.name.toLowerCase() === exercise.exercise.toLowerCase()
      );
      
      return {
        exerciseId: exerciseObj ? exerciseObj.id : null,
        exerciseName: exercise.exercise,
        sets: exercise.sets,
        targetReps: exercise.reps
      };
    });

    return {
      name: `${dayName} Training`,
      exercises: exercises
    };
  }

  // Statistics
  getStats() {
    const workouts = this.getAllWorkouts();
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Current streak
    let currentStreak = 0;
    let lastWorkoutDate = null;
    
    for (const workout of workouts) {
      const workoutDate = new Date(workout.date);
      workoutDate.setHours(0, 0, 0, 0);
      
      if (!lastWorkoutDate) {
        lastWorkoutDate = workoutDate;
        currentStreak = 1;
      } else {
        const dayDiff = Math.floor((lastWorkoutDate - workoutDate) / (24 * 60 * 60 * 1000));
        if (dayDiff === 1) {
          currentStreak++;
          lastWorkoutDate = workoutDate;
        } else if (dayDiff > 1) {
          break;
        }
      }
    }

    // Check if streak is broken
    if (lastWorkoutDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const daysSinceLastWorkout = Math.floor((today - lastWorkoutDate) / (24 * 60 * 60 * 1000));
      if (daysSinceLastWorkout > 1) {
        currentStreak = 0;
      }
    }

    // Weekly workouts
    const weeklyWorkouts = workouts.filter(w => new Date(w.date) >= weekAgo).length;

    // Total workouts
    const totalWorkouts = workouts.length;

    // Consistency (percentage of scheduled days completed in the last month)
    const monthlyWorkouts = workouts.filter(w => new Date(w.date) >= monthAgo).length;
    const expectedWorkouts = Math.floor((30 / 7) * this.data.settings.workoutDaysPerWeek);
    const consistency = expectedWorkouts > 0 ? Math.round((monthlyWorkouts / expectedWorkouts) * 100) : 0;

    return {
      currentStreak,
      weeklyWorkouts,
      totalWorkouts,
      consistency
    };
  }

  getWorkoutsByDateRange(startDate, endDate) {
    return this.getAllWorkouts().filter(workout => {
      const workoutDate = new Date(workout.date);
      return workoutDate >= startDate && workoutDate <= endDate;
    });
  }

  getPersonalRecords() {
    const records = {};
    
    this.getAllWorkouts().forEach(workout => {
      workout.exercises.forEach(exercise => {
        const exerciseData = this.getExercise(exercise.exerciseId);
        if (!exerciseData) return;

        exercise.sets.forEach(set => {
          const weight = parseFloat(set.weight) || 0;
          if (!records[exercise.exerciseId] || weight > records[exercise.exerciseId].weight) {
            records[exercise.exerciseId] = {
              exerciseName: exerciseData.name,
              weight,
              reps: set.reps,
              date: workout.date
            };
          }
        });
      });
    });

    return Object.values(records).sort((a, b) => b.weight - a.weight);
  }

  updatePersonalRecords(workout) {
    // Personal records are calculated on-demand, not stored
    // This method is kept for compatibility
  }

  // Achievement System - Achievements are calculated, not stored
  checkAchievements() {
    // Achievements are calculated based on stats
    // This method triggers UI updates but doesn't store data
    window.dispatchEvent(new Event('achievementsUpdated'));
  }

  getAchievements() {
    const stats = this.getStats();
    const achievements = this.getDefaultAchievements();

    // Check streak achievements
    if (stats.currentStreak >= 7) achievements.week_warrior.unlocked = true;
    if (stats.currentStreak >= 30) achievements.monthly_master.unlocked = true;
    if (stats.currentStreak >= 100) achievements.century_club.unlocked = true;

    // Check workout count achievements
    if (stats.totalWorkouts >= 1) achievements.first_timer.unlocked = true;
    if (stats.totalWorkouts >= 50) achievements.half_century.unlocked = true;
    if (stats.totalWorkouts >= 100) achievements.centurion.unlocked = true;

    // Check consistency
    if (stats.consistency >= 80) achievements.consistency_king.unlocked = true;

    // Check personal records
    const prs = this.getPersonalRecords();
    if (prs.length > 0) achievements.record_breaker.unlocked = true;

    return achievements;
  }

  // Utility Functions
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  exportData() {
    const dataStr = JSON.stringify(this.data, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportName = `gym-tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportName);
    linkElement.click();
  }

  importData(jsonString) {
    try {
      const importedData = JSON.parse(jsonString);
      // Only import user-specific data
      if (importedData.workouts) {
        this.data.workouts = importedData.workouts;
        this.data.settings = importedData.settings || this.data.settings;
        this.data.trainingPlan = importedData.trainingPlan || this.data.trainingPlan;
        this.saveData(); // Immediate sync
        return true;
      }
      return false;
    } catch (error) {
      console.error('Import error:', error);
      return false;
    }
  }

  clearAllData() {
    if (confirm('Are you sure you want to delete all data? This cannot be undone.')) {
      this.data = {};
      this.initializeDefaults();
      return true;
    }
    return false;
  }

  // Default Data
  getDefaultAchievements() {
    return {
      'first_timer': {
        id: 'first_timer',
        name: 'First Timer',
        description: 'Complete your first workout',
        icon: '🎯',
        unlocked: false
      },
      'week_warrior': {
        id: 'week_warrior',
        name: 'Week Warrior',
        description: '7 day workout streak',
        icon: '🔥',
        unlocked: false
      },
      'monthly_master': {
        id: 'monthly_master',
        name: 'Monthly Master',
        description: '30 day workout streak',
        icon: '💪',
        unlocked: false
      },
      'century_club': {
        id: 'century_club',
        name: 'Century Club',
        description: '100 day workout streak',
        icon: '💯',
        unlocked: false
      },
      'half_century': {
        id: 'half_century',
        name: 'Half Century',
        description: 'Complete 50 workouts',
        icon: '5️⃣0️⃣',
        unlocked: false
      },
      'centurion': {
        id: 'centurion',
        name: 'Centurion',
        description: 'Complete 100 workouts',
        icon: '🏆',
        unlocked: false
      },
      'consistency_king': {
        id: 'consistency_king',
        name: 'Consistency King',
        description: '80% consistency for a month',
        icon: '👑',
        unlocked: false
      },
      'record_breaker': {
        id: 'record_breaker',
        name: 'Record Breaker',
        description: 'Set a personal record',
        icon: '🚀',
        unlocked: false
      }
    };
  }
}

// Create global instance
window.gymData = new GymDataEnhanced();