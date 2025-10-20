/**
 * Gym Tracker Main Application
 * Coordinates all views, services, and state management
 */

import { Program } from './models/Program.js';
import { WorkoutDay } from './models/WorkoutDay.js';
import { WorkoutSession } from './models/WorkoutSession.js';
import { Settings } from './models/Settings.js';
import { Achievement } from './models/Achievement.js';

import { storageService } from './services/StorageService.js';
import { timerService } from './services/TimerService.js';
import { AnalyticsService } from './services/AnalyticsService.js';
import { AchievementService } from './services/AchievementService.js';

import { EXERCISE_DATABASE } from '../data/exercises-db.js';
import { showToast } from './utils/helpers.js';

class GymTrackerApp {
    constructor() {
        this.currentView = 'home';
        this.currentWorkoutSession = null;
        this.programs = [];
        this.workoutSessions = [];
        this.settings = null;
        this.achievements = [];
        this.customExercises = [];
        this.exerciseDatabase = EXERCISE_DATABASE;

        this.viewControllers = {};
    }

    /**
     * Initialize the application
     */
    async init() {
        console.log('🏋️ Initializing Gym Tracker App...');

        // Load data from storage
        this.loadAllData();

        // Initialize achievements if empty
        if (this.achievements.length === 0) {
            this.achievements = AchievementService.getDefaultAchievements();
            this.saveAchievements();
        }

        // Update achievement progress
        this.updateAchievements();

        // Set up event listeners
        this.setupEventListeners();

        // Initialize view controllers
        await this.initializeViews();

        // Show initial view
        this.showView('home');

        // Listen for sync system ready
        this.setupSyncListeners();

        console.log('✅ Gym Tracker App initialized');
    }

    /**
     * Load all data from storage
     */
    loadAllData() {
        try {
            // Load programs with safety check
            const programsData = storageService.getPrograms();
            this.programs = Array.isArray(programsData) ? programsData.map(p => Program.fromJSON(p)) : [];
            if (!Array.isArray(programsData) && programsData !== null) {
                console.warn('Programs data was not an array, resetting to empty array');
            }

            // Load workout sessions with safety check
            const sessionsData = storageService.getWorkoutSessions();
            this.workoutSessions = Array.isArray(sessionsData) ? sessionsData.map(s => WorkoutSession.fromJSON(s)) : [];
            if (!Array.isArray(sessionsData) && sessionsData !== null) {
                console.warn('Sessions data was not an array, resetting to empty array');
            }

            // Load achievements with safety check
            const achievementsData = storageService.getAchievements();
            this.achievements = Array.isArray(achievementsData) ? achievementsData.map(a => Achievement.fromJSON(a)) : [];
            if (!Array.isArray(achievementsData) && achievementsData !== null) {
                console.warn('Achievements data was not an array, resetting to empty array');
            }

            // Load custom exercises with safety check
            const customExercisesData = storageService.getCustomExercises();
            this.customExercises = Array.isArray(customExercisesData) ? customExercisesData : [];
            if (!Array.isArray(customExercisesData) && customExercisesData !== null) {
                console.warn('Custom exercises data was not an array, resetting to empty array');
            }

            // Merge default and custom exercises
            this.exerciseDatabase = [...EXERCISE_DATABASE, ...this.customExercises];

            // Load settings
            this.settings = storageService.getSettings();
        } catch (error) {
            console.error('Error loading data:', error);
            // Reset to defaults on error
            this.programs = [];
            this.workoutSessions = [];
            this.achievements = [];
            this.customExercises = [];
            this.settings = null;
        }

        // Load settings or create default
        if (!this.settings) {
            this.settings = Settings.getDefault();
            this.saveSettings();
        } else {
            this.settings = Settings.fromJSON(this.settings);
        }
    }

    /**
     * Save data to storage
     */
    savePrograms() {
        storageService.savePrograms(this.programs.map(p => p.toJSON()));
    }

    saveWorkoutSessions() {
        storageService.saveWorkoutSessions(this.workoutSessions.map(s => s.toJSON()));
    }

    saveSettings() {
        storageService.saveSettings(this.settings.toJSON());
    }

    saveAchievements() {
        storageService.saveAchievements(this.achievements.map(a => a.toJSON()));
    }

    saveCustomExercises() {
        storageService.saveCustomExercises(this.customExercises);
        // Re-merge exercise database
        this.exerciseDatabase = [...EXERCISE_DATABASE, ...this.customExercises];
    }

    addCustomExercise(exercise) {
        this.customExercises.push(exercise);
        this.saveCustomExercises();
    }

    /**
     * Update achievements based on current data
     */
    updateAchievements() {
        const oldAchievements = [...this.achievements];
        this.achievements = AchievementService.updateAchievementProgress(
            this.achievements,
            this.workoutSessions
        );

        // Check for newly unlocked achievements
        const newlyUnlocked = AchievementService.getNewlyUnlocked(oldAchievements, this.achievements);
        if (newlyUnlocked.length > 0) {
            this.showAchievementUnlocked(newlyUnlocked);
        }

        this.saveAchievements();
    }

    /**
     * Show achievement unlocked notification
     */
    showAchievementUnlocked(achievements) {
        achievements.forEach(achievement => {
            showToast(
                `🎉 Achievement Unlocked: ${achievement.icon} ${achievement.name}`,
                'success',
                5000
            );
        });
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        // Navigation
        document.addEventListener('click', (e) => {
            const navBtn = e.target.closest('[data-view]');
            if (navBtn) {
                e.preventDefault();
                const view = navBtn.dataset.view;
                this.showView(view);
            }
        });

        // Handle back button
        window.addEventListener('popstate', (e) => {
            if (e.state && e.state.view) {
                this.showView(e.state.view, false);
            }
        });
    }

    /**
     * Initialize view controllers
     */
    async initializeViews() {
        // View controllers will be initialized here
        // This is a placeholder for the actual view initialization
        console.log('Initializing views...');
    }

    /**
     * Show a specific view
     */
    showView(viewName, pushState = true) {
        console.log(`Showing view: ${viewName}`);

        // Hide all views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
            view.style.display = 'none';
        });

        // Show requested view
        const viewElement = document.getElementById(`${viewName}-view`);
        if (viewElement) {
            viewElement.classList.add('active');
            viewElement.style.display = 'block';
        }

        // Update navigation (both mobile nav-item and desktop nav-link)
        document.querySelectorAll('.nav-item, .nav-link').forEach(item => {
            item.classList.remove('active');
        });
        const navItems = document.querySelectorAll(`[data-view="${viewName}"]`);
        navItems.forEach(item => {
            item.classList.add('active');
        });

        this.currentView = viewName;

        // Update browser history
        if (pushState) {
            history.pushState({ view: viewName }, '', `#${viewName}`);
        }

        // Trigger view-specific initialization
        this.onViewChange(viewName);
    }

    /**
     * Handle view change
     */
    onViewChange(viewName) {
        // Call view-specific render methods
        if (this.viewControllers[viewName] && this.viewControllers[viewName].render) {
            this.viewControllers[viewName].render();
        }
    }

    /**
     * Set up sync system listeners
     */
    setupSyncListeners() {
        if (!window.syncSystemInitialized) {
            window.addEventListener('syncSystemReady', () => {
                console.log('🔄 Sync system ready, refreshing data');
                setTimeout(() => {
                    this.loadAllData();
                    this.updateAchievements();
                    if (this.currentView && this.viewControllers[this.currentView]) {
                        this.onViewChange(this.currentView);
                    }
                }, 1000);
            }, { once: true });
        }
    }

    /**
     * Export all data
     */
    exportData() {
        const data = storageService.exportAllData();
        return data;
    }

    /**
     * Import data
     */
    importData(data) {
        const success = storageService.importAllData(data);
        if (success) {
            this.loadAllData();
            this.updateAchievements();
            showToast('Data imported successfully', 'success');
        } else {
            showToast('Failed to import data', 'error');
        }
        return success;
    }

    /**
     * Clear all data
     */
    clearAllData() {
        if (confirm('Are you sure you want to delete ALL data? This cannot be undone!')) {
            storageService.clearAllData();
            this.programs = [];
            this.workoutSessions = [];
            this.achievements = AchievementService.getDefaultAchievements();
            this.customExercises = [];
            this.settings = Settings.getDefault();
            this.currentWorkoutSession = null;

            this.savePrograms();
            this.saveWorkoutSessions();
            this.saveAchievements();
            this.saveCustomExercises();
            this.saveSettings();

            showToast('All data cleared', 'info');
            this.showView('home');

            // Reload to ensure clean state
            setTimeout(() => {
                location.reload();
            }, 1000);
        }
    }

    /**
     * Get program by ID
     */
    getProgramById(id) {
        return this.programs.find(p => p.id === id);
    }

    /**
     * Get workout session by ID
     */
    getWorkoutSessionById(id) {
        return this.workoutSessions.find(s => s.id === id);
    }

    /**
     * Get exercise by ID
     */
    getExerciseById(id) {
        return this.exerciseDatabase.find(e => e.id === id);
    }

    /**
     * Get analytics
     */
    getAnalytics() {
        return {
            totalWorkouts: this.workoutSessions.length,
            totalVolume: AnalyticsService.getTotalVolume(this.workoutSessions),
            totalExercises: new Set(
                this.workoutSessions.flatMap(s => s.exercises.map(e => e.exerciseId))
            ).size,
            frequency: AnalyticsService.getWorkoutFrequency(this.workoutSessions, 30),
            volumeTrends: AnalyticsService.getVolumeTrends(this.workoutSessions, 'week')
        };
    }
}

// Create singleton instance
export const app = new GymTrackerApp();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});

// Expose app globally for debugging and views
window.gymApp = app;

// Expose debugging helper
window.debugGymTracker = {
    clearLocalStorage: () => {
        console.log('Clearing all gym tracker localStorage...');
        const keys = ['gymTrackerPrograms', 'gymTrackerSessions', 'gymTrackerSettings', 'gymTrackerAchievements', 'gymTrackerActiveProgram', 'gymTrackerCustomExercises'];
        keys.forEach(key => localStorage.removeItem(key));
        console.log('✅ Cleared. Reload the page to start fresh.');
    },
    inspectData: () => {
        console.log('Programs:', app.programs);
        console.log('Sessions:', app.workoutSessions);
        console.log('Achievements:', app.achievements);
        console.log('Custom Exercises:', app.customExercises);
        console.log('Settings:', app.settings);
    },
    fixCorruptedData: () => {
        console.log('Attempting to fix corrupted data...');
        app.programs = [];
        app.workoutSessions = [];
        // Get default achievements
        const defaultAchievements = [
            { id: 'first', name: 'First Workout', description: 'Complete your first workout', type: 'global', icon: '🌟', unlocked: false, progress: 0, target: 1 }
        ];
        app.achievements = defaultAchievements;
        app.settings = { weightUnit: 'kg', enableRestTimer: true, defaultRestTime: 90, enableNotifications: true, enableSound: true };
        app.savePrograms();
        app.saveWorkoutSessions();
        app.saveAchievements();
        app.saveSettings();
        console.log('✅ Data reset. Reload the page.');
        setTimeout(() => location.reload(), 500);
    },
    checkSync: () => {
        console.log('🔍 Checking Firebase sync status...');
        const keys = ['gymTrackerPrograms', 'gymTrackerSessions', 'gymTrackerSettings', 'gymTrackerAchievements', 'gymTrackerActiveProgram', 'gymTrackerCustomExercises'];

        if (window.syncDebug) {
            keys.forEach(key => {
                window.syncDebug.isKeySynced(key);
            });
        } else {
            console.warn('⚠️ Sync debug tools not available. Make sure you are logged in.');
        }

        console.log('\n📊 Current data in memory:');
        console.log('Programs:', app.programs.length);
        console.log('Sessions:', app.workoutSessions.length);
        console.log('Custom Exercises:', app.customExercises.length);
    },
    forceSyncAll: () => {
        console.log('🚀 Force syncing all gym tracker data...');
        const keys = ['gymTrackerPrograms', 'gymTrackerSessions', 'gymTrackerSettings', 'gymTrackerAchievements', 'gymTrackerActiveProgram', 'gymTrackerCustomExercises'];

        if (window.syncDebug) {
            keys.forEach(key => {
                window.syncDebug.forceSyncKey(key);
            });
            console.log('✅ Force sync triggered for all keys. Check other device in 5-10 seconds.');
        } else {
            console.warn('⚠️ Sync debug tools not available. Make sure you are logged in.');
        }
    }
};
