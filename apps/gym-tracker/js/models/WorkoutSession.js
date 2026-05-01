/**
 * WorkoutSession Model
 * Represents an actual workout session (execution of a workout day)
 */
import { WorkoutExercise } from './WorkoutExercise.js';
import { getTodayDateString, generateNumericId } from '../utils/helpers.js';

export class WorkoutSession {
    constructor(data = {}) {
        this.id = data.id || generateNumericId();
        this.programId = data.programId || null;
        this.workoutDayId = data.workoutDayId || null;
        this.workoutDayName = data.workoutDayName || '';
        this.date = data.date || getTodayDateString();
        this.startTime = data.startTime || null;
        this.endTime = data.endTime || null;
        this.exercises = (data.exercises || []).map(e =>
            e instanceof WorkoutExercise ? e : new WorkoutExercise(e)
        );
        this.notes = data.notes || '';
        this.completed = data.completed || false;

        // Post-workout metrics
        this.avgHeartRate = data.avgHeartRate || null;
        this.maxHeartRate = data.maxHeartRate || null;
        this.caloriesBurned = data.caloriesBurned || null;

        // Pause/Resume state
        this.paused = data.paused || false;
        this.pausedAt = data.pausedAt || null;
        this.elapsedBeforePause = data.elapsedBeforePause || 0; // Seconds elapsed before pause

        // Metadata
        this.timestamp = data.timestamp || new Date().toISOString();
    }

    get duration() {
        if (this.startTime && this.endTime) {
            const start = new Date(this.startTime);
            const end = new Date(this.endTime);
            return Math.floor((end - start) / 1000 / 60); // in minutes
        }
        return 0;
    }

    /**
     * Canonical chronological key for sorting/comparison. Uses the most
     * precise timestamp available so two workouts on the same calendar day
     * order correctly by time-of-day, not by insertion order.
     *
     * Priority:
     *   endTime (actual completion)
     *     → startTime (session began)
     *     → timestamp (created-at)
     *     → date (last-resort midnight-local)
     */
    get sortTimestamp() {
        return this.endTime || this.startTime || this.timestamp || this.date;
    }

    get totalVolume() {
        return this.exercises.reduce((sum, ex) => sum + ex.totalVolume, 0);
    }

    get totalSets() {
        return this.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
    }

    startWorkout() {
        this.startTime = new Date().toISOString();
    }

    endWorkout() {
        this.endTime = new Date().toISOString();
        this.completed = true;
    }

    pauseWorkout(elapsedSeconds) {
        this.paused = true;
        this.pausedAt = new Date().toISOString();
        this.elapsedBeforePause = elapsedSeconds;
    }

    resumeWorkout() {
        this.paused = false;
        this.pausedAt = null;
        // elapsedBeforePause is kept to restore timer state
    }

    toJSON() {
        return {
            id: this.id,
            programId: this.programId,
            workoutDayId: this.workoutDayId,
            workoutDayName: this.workoutDayName,
            date: this.date,
            startTime: this.startTime,
            endTime: this.endTime,
            exercises: this.exercises.map(e => e.toJSON()),
            notes: this.notes,
            completed: this.completed,
            avgHeartRate: this.avgHeartRate,
            maxHeartRate: this.maxHeartRate,
            caloriesBurned: this.caloriesBurned,
            paused: this.paused,
            pausedAt: this.pausedAt,
            elapsedBeforePause: this.elapsedBeforePause,
            timestamp: this.timestamp
        };
    }

    static fromJSON(json) {
        return new WorkoutSession(json);
    }
}
