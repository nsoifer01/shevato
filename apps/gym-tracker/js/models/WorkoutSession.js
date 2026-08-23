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

        // The unit this workout was ENTERED in - the in-workout kg|lbs toggle
        // (Item 8). Stored Set weights are always canonical kilograms
        // (utils/units.js), so this is metadata about how the lifter was
        // working, never a hint about what the numbers mean. Populated at
        // session start; null on legacy sessions logged before it was
        // recorded. Survives pause/resume via JSON.
        this.sessionUnit = data.sessionUnit === 'kg' || data.sessionUnit === 'lb'
            ? data.sessionUnit
            : null;

        // Unit provenance (utils/data-migrations.js). True means "the set
        // weights in this session are canonical kilograms" and is what stops
        // any migration or repair pass from converting them a second time.
        // Preserved, never inferred: a record that arrives without it is
        // classified by the reconciler, not assumed to be canonical here.
        this.unitsCanonical = data.unitsCanonical === true;

        // Pause/Resume state
        this.paused = data.paused || false;
        this.pausedAt = data.pausedAt || null;
        this.elapsedBeforePause = data.elapsedBeforePause || 0; // Seconds elapsed before pause
        // The rest countdown running when the session was last persisted
        // ({ endsAt, exerciseIndex, restType }) so Resume restores it; null
        // when no rest is running. Live-session state only: finish clears it.
        this.restState = data.restState && typeof data.restState === 'object' ? data.restState : null;

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

    /**
     * Weight-volume for the whole session, in canonical kg·reps.
     *
     * Timed sets contribute NOTHING here (see Set.volume): seconds are not
     * kilograms, and every consumer renders this with a weight unit. Time
     * under tension is reported separately by `totalTimedSeconds`.
     */
    get totalVolume() {
        return this.exercises.reduce((sum, ex) => sum + ex.totalVolume, 0);
    }

    /** Total seconds held across every timed set in the session. */
    get totalTimedSeconds() {
        return this.exercises.reduce((sum, ex) => sum + ex.totalTimedSeconds, 0);
    }

    get totalSets() {
        return this.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
    }

    /** Sets the user marked complete - the count that means "work done". */
    get completedSetCount() {
        return this.exercises.reduce(
            (sum, ex) => sum + (ex.sets || []).filter(s => s.completed).length, 0);
    }

    /**
     * Exercises with at least one completed set. A session lists every
     * planned exercise, so the raw `exercises.length` counted ones the lifter
     * never touched (GT-23).
     */
    get performedExerciseCount() {
        return this.exercises.filter(
            ex => (ex.sets || []).some(s => s.completed)).length;
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
            sessionUnit: this.sessionUnit,
            unitsCanonical: this.unitsCanonical,
            paused: this.paused,
            pausedAt: this.pausedAt,
            elapsedBeforePause: this.elapsedBeforePause,
            restState: this.restState,
            timestamp: this.timestamp
        };
    }

    static fromJSON(json) {
        return new WorkoutSession(json);
    }
}
