import { writable, derived } from 'svelte/store';
import { Program, WorkoutSession, Achievement, Settings } from '../lib/models.js';
import { EXERCISE_DATABASE } from '../lib/exercises-db.js';

// Create writable stores
export const programs = writable([]);
export const workoutSessions = writable([]);
export const achievements = writable([]);
export const settings = writable(new Settings());
export const customExercises = writable([]);
export const currentWorkout = writable(null);
export const currentView = writable('home');

// Exercise database (combined default + custom)
export const exercises = derived(
  customExercises,
  $customExercises => [...EXERCISE_DATABASE, ...$customExercises]
);

// Derived store for active program
export const activeProgram = derived(
  programs,
  $programs => $programs.find(p => p.isActive) || null
);

// Derived store for recent workouts
export const recentWorkouts = derived(
  workoutSessions,
  $sessions => {
    return $sessions
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);
  }
);

// Derived store for workout stats
export const workoutStats = derived(
  workoutSessions,
  $sessions => {
    const completed = $sessions.filter(s => s.completed);
    const totalWorkouts = completed.length;
    const totalDuration = completed.reduce((sum, s) => sum + s.duration, 0);
    const currentStreak = calculateStreak(completed);

    return {
      totalWorkouts,
      totalDuration,
      currentStreak,
      avgDuration: totalWorkouts > 0 ? Math.round(totalDuration / totalWorkouts) : 0
    };
  }
);

// Helper function to calculate workout streak
function calculateStreak(sessions) {
  if (sessions.length === 0) return 0;

  const sortedSessions = sessions
    .map(s => new Date(s.date).toDateString())
    .sort((a, b) => new Date(b) - new Date(a));

  let streak = 0;
  let currentDate = new Date();

  for (const sessionDate of sortedSessions) {
    const date = new Date(sessionDate);
    const daysDiff = Math.floor((currentDate - date) / (1000 * 60 * 60 * 24));

    if (daysDiff <= streak) {
      streak++;
      currentDate = date;
    } else {
      break;
    }
  }

  return streak;
}

// Storage functions
const STORAGE_KEYS = {
  programs: 'gym-tracker-programs',
  sessions: 'gym-tracker-sessions',
  achievements: 'gym-tracker-achievements',
  settings: 'gym-tracker-settings'
};

// Load data from localStorage
export function loadFromStorage() {
  try {
    const programsData = JSON.parse(localStorage.getItem(STORAGE_KEYS.programs) || '[]');
    programs.set(programsData.map(p => Program.fromJSON(p)));

    const sessionsData = JSON.parse(localStorage.getItem(STORAGE_KEYS.sessions) || '[]');
    workoutSessions.set(sessionsData.map(s => WorkoutSession.fromJSON(s)));

    const achievementsData = JSON.parse(localStorage.getItem(STORAGE_KEYS.achievements) || '[]');
    achievements.set(achievementsData.map(a => Achievement.fromJSON(a)));

    const settingsData = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || 'null');
    if (settingsData) {
      settings.set(Settings.fromJSON(settingsData));
    }
  } catch (error) {
    console.error('Error loading from storage:', error);
  }
}

// Save data to localStorage
export function saveToStorage() {
  let currentPrograms, currentSessions, currentAchievements, currentSettings;

  programs.subscribe(value => currentPrograms = value)();
  workoutSessions.subscribe(value => currentSessions = value)();
  achievements.subscribe(value => currentAchievements = value)();
  settings.subscribe(value => currentSettings = value)();

  try {
    localStorage.setItem(STORAGE_KEYS.programs, JSON.stringify(currentPrograms.map(p => p.toJSON())));
    localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(currentSessions.map(s => s.toJSON())));
    localStorage.setItem(STORAGE_KEYS.achievements, JSON.stringify(currentAchievements.map(a => a.toJSON())));
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(currentSettings.toJSON()));
  } catch (error) {
    console.error('Error saving to storage:', error);
  }
}

// Auto-save on changes
programs.subscribe(() => saveToStorage());
workoutSessions.subscribe(() => saveToStorage());
achievements.subscribe(() => saveToStorage());
settings.subscribe(() => saveToStorage());

// Initialize data on load
loadFromStorage();
