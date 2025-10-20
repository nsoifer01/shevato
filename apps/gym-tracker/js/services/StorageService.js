/**
 * StorageService
 * Manages all data storage operations (localStorage + Firebase sync)
 */
export class StorageService {
    constructor() {
        this.keys = {
            PROGRAMS: 'gymTrackerPrograms',
            WORKOUT_SESSIONS: 'gymTrackerSessions',
            SETTINGS: 'gymTrackerSettings',
            ACHIEVEMENTS: 'gymTrackerAchievements',
            ACTIVE_PROGRAM: 'gymTrackerActiveProgram',
            CUSTOM_EXERCISES: 'gymTrackerCustomExercises'
        };
    }

    // Generic storage methods
    get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (error) {
            console.error(`Error reading ${key}:`, error);
            return defaultValue;
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

    // Data Management
    exportAllData() {
        return {
            programs: this.getPrograms(),
            sessions: this.getWorkoutSessions(),
            settings: this.getSettings(),
            achievements: this.getAchievements(),
            customExercises: this.getCustomExercises(),
            activeProgram: this.get(this.keys.ACTIVE_PROGRAM),
            exportDate: new Date().toISOString(),
            version: '1.0'
        };
    }

    importAllData(data) {
        try {
            if (data.programs) this.savePrograms(data.programs);
            if (data.sessions) this.saveWorkoutSessions(data.sessions);
            if (data.settings) this.saveSettings(data.settings);
            if (data.achievements) this.saveAchievements(data.achievements);
            if (data.customExercises) this.saveCustomExercises(data.customExercises);
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
