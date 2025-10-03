// Gym Tracker - Data Management

class GymData {
  constructor() {
    this.storageKey = 'gymTrackerData';
    this.data = this.loadData();
    this.initializeDefaults();
    this.registerWithShevatoSync();
  }

  initializeDefaults() {
    if (!this.data.settings) {
      this.data.settings = {
        workoutDaysPerWeek: 3,
        preferredDays: [1, 3, 5], // Mon, Wed, Fri
        userName: '',
        userWeight: 0,
        weightUnit: 'lbs'
      };
    }

    if (!this.data.exercises) {
      this.data.exercises = this.getDefaultExercises();
    } else {
      // Merge new exercises from database with existing ones
      const defaultExercises = this.getDefaultExercises();
      for (const exerciseId in defaultExercises) {
        if (!this.data.exercises[exerciseId]) {
          this.data.exercises[exerciseId] = defaultExercises[exerciseId];
        }
      }
    }

    if (!this.data.workouts) {
      this.data.workouts = [];
    }

    if (!this.data.templates) {
      this.data.templates = this.getDefaultTemplates();
    }

    if (!this.data.achievements) {
      this.data.achievements = this.getDefaultAchievements();
    }

    if (!this.data.trainingPlan) {
      this.data.trainingPlan = {};
    }

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
      // Save using the universal sync system
      if (window.shevatoSync) {
        window.shevatoSync.saveAppData('gym-tracker', this.data);
      } else {
        // Fallback to local storage only
        localStorage.setItem(this.storageKey, JSON.stringify(this.data));
      }
      
      return true;
    } catch (error) {
      console.error('Error saving data:', error);
      return false;
    }
  }

  // Register with Shevato Sync
  registerWithShevatoSync() {
    if (window.shevatoSync) {
      window.shevatoSync.registerApp('gym-tracker', {
        collection: 'gym-tracker',
        storageKey: this.storageKey,
        onUpdate: (remoteData) => {
          console.log('Gym Tracker: Received sync update');
          this.data = remoteData;
          
          // Notify UI of data change
          window.dispatchEvent(new Event('gymDataUpdated'));
        }
      });
    } else {
      console.log('Gym Tracker: ShevatoSync not available, running in offline mode');
    }
  }

  // Settings Management
  getSettings() {
    return this.data.settings;
  }

  updateSettings(settings) {
    this.data.settings = { ...this.data.settings, ...settings };
    this.saveData();
  }

  // Exercise Management
  getAllExercises() {
    return Object.values(this.data.exercises);
  }

  getExercise(id) {
    return this.data.exercises[id];
  }

  addExercise(exercise) {
    const id = this.generateId();
    const newExercise = {
      id,
      ...exercise,
      created: new Date().toISOString(),
      personalRecord: 0
    };
    this.data.exercises[id] = newExercise;
    this.saveData();
    return newExercise;
  }

  updateExercise(id, updates) {
    if (this.data.exercises[id]) {
      this.data.exercises[id] = { ...this.data.exercises[id], ...updates };
      this.saveData();
      return true;
    }
    return false;
  }

  deleteExercise(id) {
    delete this.data.exercises[id];
    this.saveData();
  }

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
    this.saveData();
    this.checkAchievements();
    return newWorkout;
  }

  updateWorkout(id, updates) {
    const index = this.data.workouts.findIndex(w => w.id === id);
    if (index !== -1) {
      this.data.workouts[index] = { ...this.data.workouts[index], ...updates };
      this.saveData();
      this.updatePersonalRecords(this.data.workouts[index]);
      this.checkAchievements();
      return true;
    }
    return false;
  }

  deleteWorkout(id) {
    this.data.workouts = this.data.workouts.filter(w => w.id !== id);
    this.saveData();
  }

  // Template Management
  getAllTemplates() {
    return Object.values(this.data.templates);
  }

  getTemplate(id) {
    return this.data.templates[id];
  }

  addTemplate(template) {
    const id = this.generateId();
    const newTemplate = {
      id,
      ...template,
      created: new Date().toISOString()
    };
    this.data.templates[id] = newTemplate;
    this.saveData();
    return newTemplate;
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
    this.saveData();
  }

  // Convert training plan to template format for workout usage
  convertPlanDayToTemplate(dayPlan, dayName) {
    const exercises = dayPlan.map(exercise => {
      // Find matching exercise ID from the exercise library
      const exerciseObj = Object.values(this.data.exercises).find(
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
    workout.exercises.forEach(exercise => {
      const maxWeight = Math.max(...exercise.sets.map(s => parseFloat(s.weight) || 0));
      if (maxWeight > 0 && this.data.exercises[exercise.exerciseId]) {
        const currentPR = this.data.exercises[exercise.exerciseId].personalRecord || 0;
        if (maxWeight > currentPR) {
          this.data.exercises[exercise.exerciseId].personalRecord = maxWeight;
        }
      }
    });
    this.saveData();
  }

  // Achievement System
  checkAchievements() {
    const stats = this.getStats();
    const achievements = this.data.achievements;

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

    this.saveData();
  }

  getAchievements() {
    return this.data.achievements;
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
      // Validate the data structure
      if (importedData.exercises && importedData.workouts) {
        this.data = importedData;
        this.saveData();
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
      localStorage.removeItem(this.storageKey);
      this.data = {};
      this.initializeDefaults();
      return true;
    }
    return false;
  }

  // Default Data
  getDefaultExercises() {
    // Use the comprehensive exercise database if available
    if (typeof exerciseDatabase !== 'undefined') {
      return exerciseDatabase;
    }
    
    // Fallback to basic exercises if database not loaded
    const exercises = {
      'bench_press': {
        id: 'bench_press',
        name: 'Bench Press',
        muscleGroup: 'chest',
        type: 'strength',
        personalRecord: 0
      },
      'squat': {
        id: 'squat',
        name: 'Squat',
        muscleGroup: 'legs',
        type: 'strength',
        personalRecord: 0
      },
      'deadlift': {
        id: 'deadlift',
        name: 'Deadlift',
        muscleGroup: 'back',
        type: 'strength',
        personalRecord: 0
      },
      'overhead_press': {
        id: 'overhead_press',
        name: 'Overhead Press',
        muscleGroup: 'shoulders',
        type: 'strength',
        personalRecord: 0
      },
      'barbell_row': {
        id: 'barbell_row',
        name: 'Barbell Row',
        muscleGroup: 'back',
        type: 'strength',
        personalRecord: 0
      },
      'pull_up': {
        id: 'pull_up',
        name: 'Pull Up',
        muscleGroup: 'back',
        type: 'strength',
        personalRecord: 0
      },
      'dip': {
        id: 'dip',
        name: 'Dip',
        muscleGroup: 'chest',
        type: 'strength',
        personalRecord: 0
      },
      'bicep_curl': {
        id: 'bicep_curl',
        name: 'Bicep Curl',
        muscleGroup: 'arms',
        type: 'strength',
        personalRecord: 0
      },
      'tricep_extension': {
        id: 'tricep_extension',
        name: 'Tricep Extension',
        muscleGroup: 'arms',
        type: 'strength',
        personalRecord: 0
      },
      'leg_press': {
        id: 'leg_press',
        name: 'Leg Press',
        muscleGroup: 'legs',
        type: 'strength',
        personalRecord: 0
      },
      'calf_raise': {
        id: 'calf_raise',
        name: 'Calf Raise',
        muscleGroup: 'legs',
        type: 'strength',
        personalRecord: 0
      },
      'plank': {
        id: 'plank',
        name: 'Plank',
        muscleGroup: 'core',
        type: 'strength',
        personalRecord: 0
      },
      'running': {
        id: 'running',
        name: 'Running',
        muscleGroup: 'cardio',
        type: 'cardio',
        personalRecord: 0
      },
      'cycling': {
        id: 'cycling',
        name: 'Cycling',
        muscleGroup: 'cardio',
        type: 'cardio',
        personalRecord: 0
      }
    };

    return exercises;
  }

  getDefaultTemplates() {
    return {
      'push_day': {
        id: 'push_day',
        name: 'Push Day',
        description: 'Chest, Shoulders, Triceps',
        exercises: ['barbell_bench_press', 'barbell_overhead_press', 'chest_dips', 'overhead_tricep_extension', 'lateral_raises', 'cable_tricep_pushdown']
      },
      'pull_day': {
        id: 'pull_day',
        name: 'Pull Day',
        description: 'Back, Biceps',
        exercises: ['deadlift', 'barbell_row', 'pull_ups', 'barbell_curl', 'cable_row', 'hammer_curl']
      },
      'leg_day': {
        id: 'leg_day',
        name: 'Leg Day',
        description: 'Quads, Hamstrings, Glutes, Calves',
        exercises: ['back_squat', 'leg_press', 'romanian_deadlift', 'leg_curl', 'calf_raises', 'walking_lunges']
      },
      'full_body': {
        id: 'full_body',
        name: 'Full Body',
        description: 'Complete workout',
        exercises: ['back_squat', 'barbell_bench_press', 'barbell_row', 'barbell_overhead_press', 'plank']
      }
    };
  }

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
      },
      'early_bird': {
        id: 'early_bird',
        name: 'Early Bird',
        description: '10 morning workouts',
        icon: '🌅',
        unlocked: false
      },
      'night_owl': {
        id: 'night_owl',
        name: 'Night Owl',
        description: '10 evening workouts',
        icon: '🦉',
        unlocked: false
      }
    };
  }
}

// Global instance will be created by gym-init.js
// window.gymData = new GymData();