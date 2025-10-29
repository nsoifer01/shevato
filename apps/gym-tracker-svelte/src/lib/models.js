// Data models for Gym Tracker

// Set Model - represents a single set within an exercise
export class Set {
  constructor(data = {}) {
    this.weight = data.weight || 0;
    this.reps = data.reps || 0;
    this.duration = data.duration || 0; // in seconds (for time-based exercises)
    this.completed = data.completed !== undefined ? data.completed : false;
    this.restTime = data.restTime || 0; // in seconds
    this.notes = data.notes || '';
  }

  get volume() {
    if (this.duration > 0) {
      return this.duration;
    }
    return this.weight * this.reps;
  }

  toJSON() {
    return {
      weight: this.weight,
      reps: this.reps,
      duration: this.duration,
      completed: this.completed,
      restTime: this.restTime,
      notes: this.notes
    };
  }

  static fromJSON(json) {
    return new Set(json);
  }
}

// Exercise Model - template for exercises in a program
export class Exercise {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.exerciseId = data.exerciseId || null; // Reference to exercise database
    this.name = data.name || '';
    this.targetSets = data.targetSets || 3;
    this.targetReps = data.targetReps || 10;
    this.targetWeight = data.targetWeight || 0;
    this.notes = data.notes || '';
    this.order = data.order || 0;
  }

  toJSON() {
    return {
      id: this.id,
      exerciseId: this.exerciseId,
      name: this.name,
      targetSets: this.targetSets,
      targetReps: this.targetReps,
      targetWeight: this.targetWeight,
      notes: this.notes,
      order: this.order
    };
  }

  static fromJSON(json) {
    return new Exercise(json);
  }
}

// WorkoutExercise Model - actual exercise being performed in a workout session
export class WorkoutExercise {
  constructor(data = {}) {
    this.exerciseId = data.exerciseId || null;
    this.exerciseName = data.exerciseName || '';
    this.sets = (data.sets || []).map(s => s instanceof Set ? s : new Set(s));
    this.targetSets = data.targetSets || 3;
    this.notes = data.notes || '';
    this.order = data.order || 0;
    this.completed = data.completed || false;
  }

  get totalVolume() {
    return this.sets.reduce((sum, set) => sum + set.volume, 0);
  }

  get completedSets() {
    return this.sets.filter(s => s.completed).length;
  }

  addSet(setData) {
    this.sets.push(new Set(setData));
  }

  removeSet(index) {
    if (index >= 0 && index < this.sets.length) {
      this.sets.splice(index, 1);
    }
  }

  toJSON() {
    return {
      exerciseId: this.exerciseId,
      exerciseName: this.exerciseName,
      sets: this.sets.map(s => s.toJSON()),
      targetSets: this.targetSets,
      notes: this.notes,
      order: this.order,
      completed: this.completed
    };
  }

  static fromJSON(json) {
    return new WorkoutExercise(json);
  }
}

// WorkoutDay Model
export class WorkoutDay {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.name = data.name || '';
    this.exercises = (data.exercises || []).map(e => e instanceof Exercise ? e : Exercise.fromJSON(e));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      exercises: this.exercises.map(e => e.toJSON())
    };
  }

  static fromJSON(json) {
    return new WorkoutDay(json);
  }
}

// Program Model
export class Program {
  constructor(data = {}) {
    // Handle null or undefined data
    const safeData = data || {};

    this.id = safeData.id || Date.now();
    this.name = safeData.name || '';
    this.description = safeData.description || '';
    this.exercises = safeData.exercises || []; // Array of { exerciseId, exerciseName, targetSets, order }
    this.createdAt = safeData.createdAt || new Date().toISOString();
    this.updatedAt = safeData.updatedAt || new Date().toISOString();
  }

  addExercise(exerciseId, exerciseName, targetSets = 3, notes = '') {
    const order = this.exercises.length;
    this.exercises.push({
      exerciseId,
      exerciseName,
      targetSets,
      notes,
      order
    });
    this.updatedAt = new Date().toISOString();
  }

  removeExercise(index) {
    if (index >= 0 && index < this.exercises.length) {
      this.exercises.splice(index, 1);
      // Re-order remaining exercises
      this.exercises.forEach((ex, idx) => ex.order = idx);
      this.updatedAt = new Date().toISOString();
    }
  }

  reorderExercise(fromIndex, toIndex) {
    if (fromIndex >= 0 && fromIndex < this.exercises.length &&
        toIndex >= 0 && toIndex < this.exercises.length) {
      const [movedItem] = this.exercises.splice(fromIndex, 1);
      this.exercises.splice(toIndex, 0, movedItem);
      // Re-order all exercises
      this.exercises.forEach((ex, idx) => ex.order = idx);
      this.updatedAt = new Date().toISOString();
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      exercises: this.exercises,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromJSON(json) {
    return new Program(json);
  }
}

// WorkoutSession Model
export class WorkoutSession {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.programId = data.programId || null;
    this.programName = data.programName || '';
    this.dayId = data.dayId || null;
    this.dayName = data.dayName || '';
    this.date = data.date || new Date().toISOString();
    this.exercises = (data.exercises || []).map(e => e instanceof WorkoutExercise ? e : WorkoutExercise.fromJSON(e));
    this.duration = data.duration || 0; // in minutes
    this.notes = data.notes || '';
    this.completed = data.completed || false;
    this.startTime = data.startTime || null;
    this.endTime = data.endTime || null;
  }

  get totalVolume() {
    return this.exercises.reduce((sum, ex) => sum + ex.totalVolume, 0);
  }

  get completedExercises() {
    return this.exercises.filter(ex => ex.completed).length;
  }

  toJSON() {
    return {
      id: this.id,
      programId: this.programId,
      programName: this.programName,
      dayId: this.dayId,
      dayName: this.dayName,
      date: this.date,
      exercises: this.exercises.map(e => e.toJSON()),
      duration: this.duration,
      notes: this.notes,
      completed: this.completed,
      startTime: this.startTime,
      endTime: this.endTime
    };
  }

  static fromJSON(json) {
    return new WorkoutSession(json);
  }
}

// Achievement Model
export class Achievement {
  constructor(data = {}) {
    this.id = data.id || '';
    this.name = data.name || '';
    this.description = data.description || '';
    this.icon = data.icon || '🏆';
    this.unlocked = data.unlocked || false;
    this.unlockedDate = data.unlockedDate || null;
    this.requirement = data.requirement || null;
  }

  static fromJSON(json) {
    return new Achievement(json);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      icon: this.icon,
      unlocked: this.unlocked,
      unlockedDate: this.unlockedDate,
      requirement: this.requirement
    };
  }
}

export class Settings {
  constructor() {
    this.weightUnit = 'lbs';
    this.theme = 'dark';
    this.notifications = true;
    this.restTimer = 90;
  }

  static fromJSON(json) {
    const settings = new Settings();
    Object.assign(settings, json);
    return settings;
  }

  toJSON() {
    return {
      weightUnit: this.weightUnit,
      theme: this.theme,
      notifications: this.notifications,
      restTimer: this.restTimer
    };
  }
}
