/**
 * Gym Tracker Main Application
 * Coordinates all views, services, and state management
 */

import { Program } from './models/Program.js';
import { WorkoutDay } from './models/WorkoutDay.js';
import { WorkoutSession } from './models/WorkoutSession.js';
import { Settings } from './models/Settings.js';
import { Achievement } from './models/Achievement.js';
import { Measurement } from './models/Measurement.js';

import { storageService } from './services/StorageService.js';
import { timerService } from './services/TimerService.js';
import { AnalyticsService } from './services/AnalyticsService.js';
import { AchievementService } from './services/AchievementService.js';

import { EXERCISE_DATABASE, loadExerciseDatabase } from '../data/exercises-db.js';
import { showToast, debugLog } from './utils/helpers.js';
import { trapModalFocus, closeModalSafely } from './utils/modal-focus.js';
import { mountSyncStatusPill } from './utils/sync-status.js';
import { emit, EVENTS } from './utils/event-bus.js';
import { sameId } from './utils/id-utils.js';

class GymTrackerApp {
    constructor() {
        this.currentView = null;
        this.currentWorkoutSession = null;
        this.programs = [];
        this.workoutSessions = [];
        this.settings = null;
        this.achievements = [];
        this.customExercises = [];
        this.measurements = [];
        this.exerciseDatabase = EXERCISE_DATABASE;

        this.viewControllers = {};
    }

    /**
     * Initialize the application
     */
    async init() {
        debugLog('🏋️ Initializing Gym Tracker App...');

        // Fetch the static exercise catalog up front. The loader is
        // memoized so any later view that calls it (or imports
        // EXERCISE_DATABASE directly) hits the same array without a
        // second network round trip.
        await loadExerciseDatabase();

        // Load data from storage
        this.loadAllData();

        // Initialize achievements if empty; otherwise merge in any new defaults
        // that were added in later releases so existing users see them.
        if (this.achievements.length === 0) {
            this.achievements = AchievementService.getDefaultAchievements();
            this.saveAchievements();
        } else {
            const existingIds = new Set(this.achievements.map(a => a.id));
            const missing = AchievementService.getDefaultAchievements()
                .filter(a => !existingIds.has(a.id));
            if (missing.length > 0) {
                this.achievements.push(...missing);
                this.saveAchievements();
            }
        }

        // Update achievement progress
        this.updateAchievements();

        // Set up event listeners
        this.setupEventListeners();
        this.wireGlobalFab();

        // Initialize view controllers
        await this.initializeViews();

        // Show initial view — honor URL hash so refresh keeps the user's page
        const validViews = new Set(['home', 'programs', 'calendar', 'workout', 'exercises', 'history', 'achievements', 'settings', 'more', 'insights', 'measurements']);
        const hashView = window.location.hash.slice(1);
        this.showView(validViews.has(hashView) ? hashView : 'home');

        // Listen for sync system ready
        this.setupSyncListeners();

        // Mount the floating sync-status pill (Synced / Saving / Offline).
        mountSyncStatusPill();

        // First-run onboarding — only when the user has absolutely no data
        // and has never dismissed the welcome. If sync later pulls data in,
        // the modal stays dismissed (flag persists).
        this.maybeShowOnboarding();

        debugLog('✅ Gym Tracker App initialized');
    }

    /**
     * Show the welcome modal to first-time users. A user is "first-time"
     * if they have no programs, no sessions, and have never dismissed
     * the modal before. Running sync listeners can't retroactively
     * trigger this — the modal is strictly day-one.
     */
    maybeShowOnboarding() {
        const seen = storageService.hasSeenOnboarding();
        const hasData = this.programs.length > 0 || this.workoutSessions.length > 0;
        if (seen || hasData) return;
        this.openOnboardingModal();
    }

    /**
     * Open the onboarding welcome modal unconditionally. Used both by
     * maybeShowOnboarding (first-time guard) and the Settings "Replay
     * welcome tour" button (which must work regardless of saved data).
     */
    openOnboardingModal() {
        const modal = document.getElementById('onboarding-modal');
        if (!modal) return;

        // Move focus OUT of the modal BEFORE it goes aria-hidden, otherwise
        // the just-clicked CTA sits under aria-hidden and the browser logs
        // "Blocked aria-hidden on an element because its descendant retained
        // focus" (the R3-6 fix; closeModalSafely handles the focus shuffle).
        const close = (restoreTo) => {
            closeModalSafely(modal, restoreTo);
            storageService.markOnboardingSeen();
        };

        modal.setAttribute('aria-hidden', 'false');
        modal.classList.add('active');
        trapModalFocus(modal);

        document.getElementById('onboarding-dismiss')?.addEventListener('click', close, { once: true });
        document.getElementById('onboarding-skip')?.addEventListener('click', close, { once: true });

        const goTo = (id, view) => {
            document.getElementById(id)?.addEventListener('click', () => {
                close();
                this.showView(view);
                // The modal's body-scroll lock restores the pre-modal scroll
                // offset on a deferred microtask as it tears down, which would
                // otherwise land the destination view at that old offset
                // (showView's synchronous scroll-to-top runs BEFORE the restore).
                // Re-assert top on the next frame, after that teardown, so a CTA
                // always lands at the top of its view. Dismiss/Skip intentionally
                // keep the restore since they stay on the current view.
                requestAnimationFrame(() => window.scrollTo(0, 0));
            }, { once: true });
        };
        goTo('onboarding-go-programs', 'programs');
        goTo('onboarding-go-workout', 'workout');
        goTo('onboarding-go-calendar', 'calendar');
        goTo('onboarding-go-settings', 'settings');
    }

    /**
     * Load all data from storage.
     *
     * Each key is loaded in its own try/catch so a single corrupt blob
     * (rare but possible after a sync glitch or a partial migration)
     * doesn't wipe the user's other entities. When a key fails to parse,
     * we toast the user, keep the rest of their data intact, and reset
     * just that one slice to its empty default.
     */
    loadAllData() {
        this.programs = this._safeLoad('programs',
            () => storageService.getPrograms(),
            (data) => Array.isArray(data) ? data.map(p => Program.fromJSON(p)) : [],
            []
        );

        this.workoutSessions = this._safeLoad('workout sessions',
            () => storageService.getWorkoutSessions(),
            (data) => Array.isArray(data) ? data.map(s => WorkoutSession.fromJSON(s)) : [],
            []
        );

        this.achievements = this._safeLoad('achievements',
            () => storageService.getAchievements(),
            (data) => Array.isArray(data) ? data.map(a => Achievement.fromJSON(a)) : [],
            []
        );

        this.customExercises = this._safeLoad('custom exercises',
            () => storageService.getCustomExercises(),
            (data) => Array.isArray(data) ? data : [],
            []
        );

        this.measurements = this._safeLoad('measurements',
            () => storageService.getMeasurements(),
            (data) => Array.isArray(data) ? data.map(m => Measurement.fromJSON(m)) : [],
            []
        );

        // Merge default and custom exercises
        this.exerciseDatabase = [...EXERCISE_DATABASE, ...this.customExercises];

        // Settings is a single object, not an array — handled separately.
        const rawSettings = this._safeLoad('settings',
            () => storageService.getSettings(),
            (data) => data,
            null
        );
        if (!rawSettings) {
            this.settings = Settings.getDefault();
            this.saveSettings();
        } else {
            this.settings = Settings.fromJSON(rawSettings);
        }

        // Broadcast the post-load state. Sync arrivals re-call loadAllData
        // and the views subscribed to these events need to know that
        // their data slice has changed even though no save() was invoked
        // locally. Without this, a view rendered while workoutSessions
        // was empty (cold load + pending sync) keeps showing its empty
        // state after the sessions arrive from Firestore.
        emit(EVENTS.PROGRAMS_CHANGED, this.programs);
        emit(EVENTS.SESSIONS_CHANGED, this.workoutSessions);
        emit(EVENTS.ACHIEVEMENTS_CHANGED, this.achievements);
        emit(EVENTS.CUSTOM_EXERCISES_CHANGED, this.customExercises);
        emit(EVENTS.MEASUREMENTS_CHANGED, this.measurements);
        emit(EVENTS.SETTINGS_CHANGED, this.settings);
    }

    /**
     * Private: load one storage slice with isolated error handling. If the
     * read or parse throws, surface a toast naming the slice so the user
     * understands which part of their data is being reset, and continue
     * loading the remaining slices.
     */
    _safeLoad(label, read, parse, fallback) {
        try {
            const raw = read();
            return parse(raw);
        } catch (error) {
            console.error(`Failed to load ${label}:`, error);
            // Lazily import-free toast — helpers.showToast is already in scope.
            try {
                showToast(`Could not load ${label} — that section reset to empty.`, 'error', 5000);
            } catch (_) { /* toast layer not ready yet on first paint */ }
            return fallback;
        }
    }

    /**
     * Save data to storage
     */
    savePrograms() {
        storageService.savePrograms(this.programs.map(p => p.toJSON()));
        emit(EVENTS.PROGRAMS_CHANGED, this.programs);
    }

    saveWorkoutSessions() {
        storageService.saveWorkoutSessions(this.workoutSessions.map(s => s.toJSON()));
        emit(EVENTS.SESSIONS_CHANGED, this.workoutSessions);
    }

    saveSettings() {
        storageService.saveSettings(this.settings.toJSON());
        emit(EVENTS.SETTINGS_CHANGED, this.settings);
    }

    saveAchievements() {
        storageService.saveAchievements(this.achievements.map(a => a.toJSON()));
        emit(EVENTS.ACHIEVEMENTS_CHANGED, this.achievements);
    }

    saveCustomExercises() {
        storageService.saveCustomExercises(this.customExercises);
        // Re-merge exercise database
        this.exerciseDatabase = [...EXERCISE_DATABASE, ...this.customExercises];
        emit(EVENTS.CUSTOM_EXERCISES_CHANGED, this.customExercises);
    }

    saveMeasurements() {
        storageService.saveMeasurements(this.measurements.map(m => m.toJSON()));
        emit(EVENTS.MEASUREMENTS_CHANGED, this.measurements);
    }

    addMeasurement(measurement) {
        this.measurements.push(measurement);
        this.saveMeasurements();
    }

    deleteMeasurement(id) {
        // Coerce both sides — entries loaded from a Firestore doc whose
        // numeric ids were stringified would otherwise never match the
        // numeric click-handler id and the entry would silently survive.
        const target = Number(id);
        this.measurements = this.measurements.filter(m => Number(m.id) !== target);
        this.saveMeasurements();
    }

    addCustomExercise(exercise) {
        this.customExercises.push(exercise);
        this.saveCustomExercises();
    }

    /**
     * Update achievements based on current data.
     *
     * Skip the persist step when nothing actually changed. Otherwise the
     * live-sync listener path (remote delivery → `refreshFromStorage` →
     * `updateAchievements` → unconditional `saveAchievements`) writes the
     * same achievements blob back to localStorage on every remote
     * delivery, the sync layer flushes it to Firestore, the peer browser
     * sees a "new" write, fires its own refresh, and the two browsers
     * ping-pong achievements every few seconds with no user input — each
     * round producing a fresh Firestore revision.
     */
    updateAchievements() {
        const before = JSON.stringify(this.achievements.map(a => a.toJSON()));
        this.achievements = AchievementService.updateAchievementProgress(
            this.achievements,
            this.workoutSessions
        );

        // Feature 7: lift-specific PR milestone achievements.
        // These live outside the standard Achievement model (no progress
        // counter — they're simply unlocked/not). We store their ids in a
        // Set for fast dedup, then fire a toast for each new unlock.
        const unlockedIds = new Set(
            this.achievements.filter(a => a.unlocked).map(a => a.id)
        );
        const storedMilestoneIds = new Set(this.achievements.map(a => a.id));
        const latestBW = this.measurements.length > 0
            ? [...this.measurements].sort((a, b) =>
                new Date(b.date) - new Date(a.date)
              ).find(m => m.weight != null)?.weight ?? null
            : null;
        const newMilestones = AchievementService.checkLiftMilestones(
            this.workoutSessions,
            unlockedIds,
            latestBW,
            this.settings.weightUnit,
        );
        for (const m of newMilestones) {
            showToast(`🎉 Lift milestone: ${m.icon} ${m.name}`, 'success', 5000);
            if (!storedMilestoneIds.has(m.id)) {
                const a = new Achievement({
                    id: m.id,
                    name: m.name,
                    description: m.description,
                    type: 'global',
                    icon: m.icon,
                    requirement: { type: 'lift-milestone' },
                    target: 1,
                });
                a.updateProgress(1);
                this.achievements.push(a);
            } else {
                const existing = this.achievements.find(a => a.id === m.id);
                if (existing) existing.updateProgress(1);
            }
        }

        const after = JSON.stringify(this.achievements.map(a => a.toJSON()));

        if (before === after && newMilestones.length === 0) return;

        // Newly-unlocked detection only needs to run when something moved.
        const oldAchievements = JSON.parse(before).map(j => Achievement.fromJSON(j));
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
        // Navigation - only respond to clicks on actual navigation elements
        document.addEventListener('click', (e) => {
            // Only process clicks on navigation elements
            const navBtn = e.target.closest('.nav-item[data-view], .nav-link[data-view], .btn-text[data-view], .more-item[data-view]');
            if (!navBtn) {
                // If not clicking on navigation, do nothing
                return;
            }

            e.preventDefault();
            const view = navBtn.dataset.view;
            // Tapping the nav item for the view you're already on must still
            // do something sensible rather than no-op (showView early-returns
            // on same-view). Mobile-only "Workout" tap mid-session is the case
            // that prompted this: re-assert + reveal the active workout.
            if (view === this.currentView) {
                this.reassertCurrentView(view);
            } else {
                this.showView(view);
            }
        });

        // Empty-state CTAs across views (Dashboard, History, Workout) are
        // wired via `data-home-action` so they share one source of truth.
        // "Start Workout" falls back to the Create Program flow when no
        // programs exist — dropping first-time users on a blank Workout
        // view was the original bug.
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-home-action]');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const action = btn.dataset.homeAction;
            if (action === 'create-program') {
                this.viewControllers.programs?.createProgramFromElsewhere();
            } else if (action === 'start-workout') {
                // Starting a workout is a context switch: land the user at
                // the top of the page, not wherever they had scrolled to.
                window.scrollTo(0, 0);
                if (this.programs.length === 0) {
                    showToast('Create a program first — then pick it to start a workout.', 'info', 4000);
                    this.viewControllers.programs?.createProgramFromElsewhere();
                } else {
                    this.showView('workout');
                }
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
        debugLog('Initializing views...');
    }

    /**
     * Show a specific view
     */
    showView(viewName, pushState = true) {
        debugLog(`Showing view: ${viewName}`);

        // If we're already on this view, don't do anything
        if (this.currentView === viewName) {
            debugLog(`Already on ${viewName}, skipping navigation update`);
            return;
        }

        // Item R2-9: a leaving view may guard navigation (e.g. Settings with
        // unsaved changes). The guard returns true to proceed now, or false to
        // defer: it owns re-invoking showView once the user resolves its prompt.
        const leavingCtrl = this.viewControllers[this.currentView];
        if (leavingCtrl && typeof leavingCtrl.beforeLeave === 'function') {
            const proceed = leavingCtrl.beforeLeave(viewName);
            if (proceed === false) return;
        }

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

        this.currentView = viewName;

        // Switching views is a context switch: land the user at the top of
        // the new view instead of wherever the previous view was scrolled
        // (most visible on mobile, where the bottom-nav tabs switch views).
        window.scrollTo(0, 0);

        // Update browser history
        if (pushState) {
            history.pushState({ view: viewName }, '', `#${viewName}`);
        }

        // Trigger view-specific initialization
        this.onViewChange(viewName);

        // Update navigation AFTER view renders (both mobile nav-item and desktop nav-link)
        // Use setTimeout to ensure this happens after any synchronous render code
        setTimeout(() => {
            document.querySelectorAll('.nav-item, .nav-link').forEach(item => {
                item.classList.remove('active');
            });
            const navItems = document.querySelectorAll(`.nav-item[data-view="${viewName}"], .nav-link[data-view="${viewName}"]`);
            navItems.forEach(item => {
                item.classList.add('active');
            });
        }, 0);
    }

    /**
     * Re-assert the view the user is already on (tapping its own nav item).
     * showView early-returns on same-view, so a visible nav tap would
     * otherwise be a no-op. For 'workout' mid-session, reveal the active
     * workout and jump to the current exercise (first incomplete); with no
     * active workout, scroll the picker to the top. Other views just scroll
     * to the top.
     */
    reassertCurrentView(viewName) {
        if (viewName === 'workout') {
            const workout = this.viewControllers.workout;
            if (workout?.hasActiveWorkout()) {
                // render() reveals the active-workout screen via the
                // hasActiveWorkout gate; jump to the current exercise (the
                // first incomplete one) — where the user is actually lifting.
                // The back-to-top arrow stays the plain scroll-to-top.
                workout.render();
                workout.scrollToCurrentExercise();
                return;
            }
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /**
     * Handle view change
     */
    onViewChange(viewName) {
        // Call view-specific render methods
        if (this.viewControllers[viewName] && this.viewControllers[viewName].render) {
            this.viewControllers[viewName].render();
        }
        // Keep the global floating workout button in sync on every view.
        this.updateGlobalFab();
    }

    /**
     * Wire the app-level floating workout button once. It lives at
     * app-container level (not inside the dashboard view) so it persists
     * across all views on desktop. Mobile keeps it hidden via CSS.
     */
    wireGlobalFab() {
        const fab = document.getElementById('home-workout-fab');
        if (!fab || fab.dataset.wired) return;
        fab.addEventListener('click', () => this.handleGlobalFabClick());
        fab.dataset.wired = '1';
        this.updateGlobalFab();
    }

    /**
     * Show/hide + label the global FAB based on current state:
     *   - Hidden when there are no programs (nothing to start).
     *   - Hidden on the active-workout screen (the user is already there).
     *   - "Resume workout" (green) when a paused session exists.
     *   - "Start workout" otherwise.
     */
    updateGlobalFab() {
        const fab = document.getElementById('home-workout-fab');
        if (!fab) return;

        const hasPrograms = this.programs.length > 0;
        const paused = storageService.getActiveWorkout();
        const onActiveWorkout = this.currentView === 'workout'
            && document.getElementById('active-workout')?.classList.contains('active');

        if (!hasPrograms || onActiveWorkout) {
            fab.hidden = true;
            return;
        }

        fab.hidden = false;
        const label = fab.querySelector('.workout-fab-label');
        const icon = fab.querySelector('i');

        if (paused && paused.paused) {
            fab.classList.add('workout-fab--resume');
            if (label) label.textContent = 'Resume workout';
            if (icon) {
                icon.classList.remove('fa-play');
                icon.classList.add('fa-play-circle');
            }
            fab.setAttribute('aria-label', 'Resume paused workout');
        } else {
            fab.classList.remove('workout-fab--resume');
            if (label) label.textContent = 'Start workout';
            if (icon) {
                icon.classList.remove('fa-play-circle');
                icon.classList.add('fa-play');
            }
            fab.setAttribute('aria-label', 'Start workout');
        }
    }

    /**
     * Start or resume a workout from anywhere:
     *   - Paused → resume the saved session.
     *   - Exactly one program with exercises → auto-start it.
     *   - Otherwise → route to the workout view's program picker.
     */
    handleGlobalFabClick() {
        window.scrollTo(0, 0);
        const workoutCtrl = this.viewControllers.workout;
        const paused = storageService.getActiveWorkout();

        if (paused && paused.paused) {
            this.showView('workout');
            setTimeout(() => workoutCtrl?.resumeWorkout(), 100);
            return;
        }

        if (this.programs.length === 1) {
            const only = this.programs[0];
            if (only.exercises && only.exercises.length > 0) {
                this.showView('workout');
                setTimeout(() => workoutCtrl?.startWorkout(only.id), 100);
                return;
            }
        }

        this.showView('workout');
    }

    /**
     * Set up sync system listeners.
     *
     * Two channels:
     *   1. `syncSystemReady` — fires once after Firebase auth + initial
     *      merge. Pulls data into memory for the first time.
     *   2. `localStorageSync` — fires every time the storage-sync layer
     *      writes a remote update into localStorage (i.e., another
     *      device pushed a change). Without this, post-boot remote
     *      updates only became visible after a manual page refresh.
     *
     * The remote-change handler is debounced because the initial
     * post-sign-in burst applies all ~9 gym-tracker keys back-to-back
     * and we only want to rebuild in-memory state and re-render once.
     */
    setupSyncListeners() {
        if (!window.syncSystemInitialized) {
            window.addEventListener('syncSystemReady', () => {
                debugLog('🔄 Sync system ready, refreshing data');
                setTimeout(() => {
                    this.refreshFromStorage();
                }, 1000);
            }, { once: true });
        }

        // Live remote-update channel. The 750 ms debounce coalesces the
        // ~9-key burst that the storage layer emits when another device
        // pushes changes, and gives the user time to finish a hover/click
        // interaction before the active view re-renders. Earlier versions
        // used 250 ms which was tight enough that any background listener
        // chatter could rebuild DOM mid-hover and visibly flicker.
        let remoteRefreshTimer = null;
        window.addEventListener('localStorageSync', (e) => {
            const key = e.detail?.key;
            if (typeof key !== 'string' || !key.startsWith('gymTracker')) return;
            if (e.detail?.source !== 'remote') return;

            clearTimeout(remoteRefreshTimer);
            remoteRefreshTimer = setTimeout(() => {
                debugLog('🔄 Remote sync update — refreshing data');
                this.refreshFromStorage();
            }, 750);
        });
    }

    /**
     * Reload all data from storage and re-render the active view.
     * Shared by the initial-sync handler and the live remote-update
     * handler so both paths stay in lockstep.
     */
    refreshFromStorage() {
        this.loadAllData();
        this.updateAchievements();
        if (this.currentView && this.viewControllers[this.currentView]) {
            this.onViewChange(this.currentView);
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
     * Clear all data. Caller is responsible for confirming with the user first.
     */
    clearAllData() {
        storageService.clearAllData();
        this.programs = [];
        this.workoutSessions = [];
        this.achievements = AchievementService.getDefaultAchievements();
        this.customExercises = [];
        this.measurements = [];
        this.settings = Settings.getDefault();
        this.currentWorkoutSession = null;

        this.savePrograms();
        this.saveWorkoutSessions();
        this.saveAchievements();
        this.saveCustomExercises();
        this.saveMeasurements();
        this.saveSettings();

        showToast('All data cleared', 'info');
        this.showView('home');

        // Reload to ensure clean state
        setTimeout(() => {
            location.reload();
        }, 1000);
    }

    /**
     * Get program by ID
     */
    getProgramById(id) {
        return this.programs.find(p => sameId(p.id, id));
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
        const keys = ['gymTrackerPrograms', 'gymTrackerProgramOrder', 'gymTrackerProgramSort', 'gymTrackerSessions', 'gymTrackerSettings', 'gymTrackerAchievements', 'gymTrackerActiveProgram', 'gymTrackerCustomExercises'];
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
        app.settings = { weightUnit: 'kg', showPostWorkoutMetrics: true };
        app.savePrograms();
        app.saveWorkoutSessions();
        app.saveAchievements();
        app.saveSettings();
        console.log('✅ Data reset. Reload the page.');
        setTimeout(() => location.reload(), 500);
    },
    checkSync: () => {
        console.log('🔍 Checking Firebase sync status...');
        const keys = ['gymTrackerPrograms', 'gymTrackerProgramOrder', 'gymTrackerProgramSort', 'gymTrackerSessions', 'gymTrackerSettings', 'gymTrackerAchievements', 'gymTrackerActiveProgram', 'gymTrackerCustomExercises'];

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
        const keys = ['gymTrackerPrograms', 'gymTrackerProgramOrder', 'gymTrackerProgramSort', 'gymTrackerSessions', 'gymTrackerSettings', 'gymTrackerAchievements', 'gymTrackerActiveProgram', 'gymTrackerCustomExercises'];

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
