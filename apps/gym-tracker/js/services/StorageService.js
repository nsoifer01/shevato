/**
 * StorageService
 * Manages all data storage operations (localStorage + Firebase sync)
 */
export class StorageService {
    constructor() {
        this.keys = {
            PROGRAMS: 'gymTrackerPrograms',
            PROGRAM_ORDER: 'gymTrackerProgramOrder',
            PROGRAM_SORT: 'gymTrackerProgramSort',
            WORKOUT_SESSIONS: 'gymTrackerSessions',
            SETTINGS: 'gymTrackerSettings',
            ACHIEVEMENTS: 'gymTrackerAchievements',
            ACTIVE_PROGRAM: 'gymTrackerActiveProgram',
            CUSTOM_EXERCISES: 'gymTrackerCustomExercises',
            ACTIVE_WORKOUT: 'gymTrackerActiveWorkout',
            ONBOARDING_SEEN: 'gymTrackerOnboardingSeen',
            MEASUREMENTS: 'gymTrackerMeasurements'
        };
    }

    // Onboarding
    hasSeenOnboarding() {
        return this.get(this.keys.ONBOARDING_SEEN) === true;
    }
    markOnboardingSeen() {
        return this.set(this.keys.ONBOARDING_SEEN, true);
    }

    // Program ordering preferences
    getProgramOrder() {
        return this.get(this.keys.PROGRAM_ORDER, []);
    }
    saveProgramOrder(orderedIds) {
        return this.set(this.keys.PROGRAM_ORDER, orderedIds);
    }
    getProgramSort() {
        return this.get(this.keys.PROGRAM_SORT, 'custom');
    }
    saveProgramSort(mode) {
        return this.set(this.keys.PROGRAM_SORT, mode);
    }

    // Generic storage methods
    get(key, defaultValue = null) {
        const item = localStorage.getItem(key);
        if (item === null || item === undefined) return defaultValue;
        try {
            return JSON.parse(item);
        } catch {
            // The sync layer can deposit primitive values un-stringified
            // (e.g. writes a string "custom" where our writer would have
            // written "\"custom\""). Treat un-parseable values as raw strings
            // instead of throwing + falling back to the default.
            return item;
        }
    }

    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error(`Error writing ${key}:`, error);
            return false;
        }
    }

    remove(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.error(`Error removing ${key}:`, error);
            return false;
        }
    }

    // Programs
    getPrograms() {
        return this.get(this.keys.PROGRAMS, []);
    }

    savePrograms(programs) {
        return this.set(this.keys.PROGRAMS, programs);
    }

    getProgramById(id) {
        const programs = this.getPrograms();
        return programs.find(p => p.id === id);
    }

    saveProgram(program) {
        const programs = this.getPrograms();
        const index = programs.findIndex(p => p.id === program.id);

        if (index >= 0) {
            programs[index] = program;
        } else {
            programs.push(program);
        }

        return this.savePrograms(programs);
    }

    deleteProgram(id) {
        const programs = this.getPrograms();
        const filtered = programs.filter(p => p.id !== id);
        return this.savePrograms(filtered);
    }

    getActiveProgram() {
        const activeProgramId = this.get(this.keys.ACTIVE_PROGRAM);
        if (activeProgramId) {
            return this.getProgramById(activeProgramId);
        }
        return null;
    }

    setActiveProgram(programId) {
        return this.set(this.keys.ACTIVE_PROGRAM, programId);
    }

    // Workout Sessions
    getWorkoutSessions() {
        return this.get(this.keys.WORKOUT_SESSIONS, []);
    }

    saveWorkoutSessions(sessions) {
        return this.set(this.keys.WORKOUT_SESSIONS, sessions);
    }

    getWorkoutSessionById(id) {
        const sessions = this.getWorkoutSessions();
        return sessions.find(s => s.id === id);
    }

    saveWorkoutSession(session) {
        const sessions = this.getWorkoutSessions();
        const index = sessions.findIndex(s => s.id === session.id);

        if (index >= 0) {
            sessions[index] = session;
        } else {
            sessions.push(session);
        }

        return this.saveWorkoutSessions(sessions);
    }

    deleteWorkoutSession(id) {
        const sessions = this.getWorkoutSessions();
        const filtered = sessions.filter(s => s.id !== id);
        return this.saveWorkoutSessions(filtered);
    }

    getWorkoutSessionsByDateRange(startDate, endDate) {
        const sessions = this.getWorkoutSessions();
        return sessions.filter(s => {
            const sessionDate = new Date(s.date);
            return sessionDate >= new Date(startDate) && sessionDate <= new Date(endDate);
        });
    }

    getWorkoutSessionsByExercise(exerciseId) {
        const sessions = this.getWorkoutSessions();
        return sessions.filter(s =>
            s.exercises.some(e => e.exerciseId === exerciseId)
        );
    }

    // Settings
    getSettings() {
        return this.get(this.keys.SETTINGS, null);
    }

    saveSettings(settings) {
        return this.set(this.keys.SETTINGS, settings);
    }

    // Achievements
    getAchievements() {
        return this.get(this.keys.ACHIEVEMENTS, []);
    }

    saveAchievements(achievements) {
        return this.set(this.keys.ACHIEVEMENTS, achievements);
    }

    // Measurements
    getMeasurements() {
        return this.get(this.keys.MEASUREMENTS, []);
    }

    saveMeasurements(measurements) {
        return this.set(this.keys.MEASUREMENTS, measurements);
    }

    // Custom Exercises
    getCustomExercises() {
        return this.get(this.keys.CUSTOM_EXERCISES, []);
    }

    saveCustomExercises(exercises) {
        return this.set(this.keys.CUSTOM_EXERCISES, exercises);
    }

    addCustomExercise(exercise) {
        const exercises = this.getCustomExercises();
        exercises.push(exercise);
        return this.saveCustomExercises(exercises);
    }

    deleteCustomExercise(id) {
        const exercises = this.getCustomExercises();
        const filtered = exercises.filter(e => e.id !== id);
        return this.saveCustomExercises(filtered);
    }

    // Active Workout (in-progress workout that can be resumed)
    getActiveWorkout() {
        return this.get(this.keys.ACTIVE_WORKOUT, null);
    }

    saveActiveWorkout(workoutData) {
        return this.set(this.keys.ACTIVE_WORKOUT, workoutData);
    }

    clearActiveWorkout() {
        return this.remove(this.keys.ACTIVE_WORKOUT);
    }

    hasActiveWorkout() {
        return this.getActiveWorkout() !== null;
    }

    // Current schema version. Bump whenever a model gains/changes a field
    // that older exports won't have. Migrations run by `migrateImport()`
    // upgrade older payloads in place; current version always returned by
    // `exportAllData()`.
    static get SCHEMA_VERSION() { return '2.0'; }

    // Data Management
    exportAllData() {
        return {
            programs: this.getPrograms(),
            sessions: this.getWorkoutSessions(),
            settings: this.getSettings(),
            achievements: this.getAchievements(),
            customExercises: this.getCustomExercises(),
            measurements: this.getMeasurements(),
            activeProgram: this.get(this.keys.ACTIVE_PROGRAM),
            exportDate: new Date().toISOString(),
            version: StorageService.SCHEMA_VERSION
        };
    }

    /**
     * Run schema migrations on an imported payload, in order, until the
     * payload's `version` field matches the current SCHEMA_VERSION. Each
     * migrator is a pure function `(data) => upgradedData` and bumps the
     * version field. Unknown / future versions are passed through with
     * a warning so importing a newer export from a more recent build
     * doesn't lose user data — at worst it ignores fields it can't read.
     */
    migrateImport(data) {
        if (!data || typeof data !== 'object') return data;
        let cur = data.version || '1.0';

        // Migrators registry. Keys are the FROM version; each function
        // upgrades to the next version and updates the version field.
        const migrators = {
            '1.0': (d) => {
                // 1.0 → 2.0: add stable `slot` to every set (positional
                // fallback) and add `soundAlerts`/`vibrationAlerts` to
                // settings if missing. Both fields were added quietly in
                // earlier releases without bumping the export version.
                if (Array.isArray(d.sessions)) {
                    d.sessions.forEach(s => {
                        (s.exercises || []).forEach(ex => {
                            (ex.sets || []).forEach((set, i) => {
                                if (set.slot == null) set.slot = i;
                            });
                        });
                    });
                }
                if (d.settings && typeof d.settings === 'object') {
                    if (d.settings.soundAlerts === undefined) d.settings.soundAlerts = true;
                    if (d.settings.vibrationAlerts === undefined) d.settings.vibrationAlerts = true;
                }
                d.version = '2.0';
                return d;
            },
        };

        let safety = 0;
        while (cur !== StorageService.SCHEMA_VERSION) {
            if (safety++ > 10) {
                console.warn(`Aborting migration loop at version ${cur}`);
                break;
            }
            const migrate = migrators[cur];
            if (!migrate) {
                console.warn(`No migrator for version ${cur}; importing as-is.`);
                break;
            }
            data = migrate(data);
            cur = data.version || cur;
        }
        return data;
    }

    importAllData(data) {
        try {
            data = this.migrateImport(data);
            if (data.programs) this.savePrograms(data.programs);
            if (data.sessions) this.saveWorkoutSessions(data.sessions);
            if (data.settings) this.saveSettings(data.settings);
            if (data.achievements) this.saveAchievements(data.achievements);
            if (data.customExercises) this.saveCustomExercises(data.customExercises);
            if (Array.isArray(data.measurements)) this.saveMeasurements(data.measurements);
            if (data.activeProgram) this.set(this.keys.ACTIVE_PROGRAM, data.activeProgram);
            return true;
        } catch (error) {
            console.error('Error importing data:', error);
            return false;
        }
    }

    clearAllData() {
        Object.values(this.keys).forEach(key => {
            this.remove(key);
        });
        return true;
    }

    // Backup/Restore
    createBackup() {
        const backup = this.exportAllData();
        backup.backupDate = new Date().toISOString();
        return backup;
    }

    restoreBackup(backup) {
        return this.importAllData(backup);
    }
}

// Singleton instance
export const storageService = new StorageService();
