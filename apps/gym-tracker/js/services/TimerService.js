/**
 * TimerService
 * Manages rest timers and workout duration tracking
 */
export class TimerService {
    constructor() {
        this.restTimers = new Map();
        this.workoutTimer = null;
        this.callbacks = new Map();
        // Monotonic handle source. Date.now() was used before, so two timers
        // started in the same millisecond collided in the Map and the first
        // interval leaked unclearable.
        this.nextTimerId = 1;
    }

    // Rest Timer
    //
    // Driven by wall-clock deltas (Date.now() - startTime), not by a
    // decrement counter. setInterval is throttled by mobile browsers and
    // backgrounded tabs, which used to cause the rest timer to drift —
    // committing a set, locking the phone for 30s, and unlocking would
    // show "55s remaining" instead of the true ~25s. Each tick now reads
    // the true elapsed time and recomputes `remaining` from `endTime`.
    startRestTimer(duration, onTick, onComplete) {
        const timerId = this.nextTimerId++;
        const startTime = Date.now();
        let endTime = startTime + duration * 1000;

        const tick = () => {
            const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
            const entry = this.restTimers.get(timerId);
            if (entry) entry.remaining = remaining;

            if (onTick) onTick(remaining);

            if (remaining <= 0) {
                this.stopRestTimer(timerId);
                if (onComplete) onComplete();
            }
        };

        const interval = setInterval(tick, 250);

        this.restTimers.set(timerId, {
            interval,
            startTime,
            endTime,
            duration,
            remaining: duration,
            // Mutator used by extendRest so callers don't need to know the
            // internal endTime field.
            extend: (extraSeconds) => {
                endTime += extraSeconds * 1000;
                const entry = this.restTimers.get(timerId);
                if (entry) entry.endTime = endTime;
                tick();
            }
        });

        return timerId;
    }

    /**
     * Add seconds to an in-flight rest timer (e.g. user taps "+30s").
     * No-op if the timer has already elapsed.
     */
    extendRestTimer(timerId, extraSeconds) {
        const timer = this.restTimers.get(timerId);
        if (timer && typeof timer.extend === 'function') {
            timer.extend(extraSeconds);
            return true;
        }
        return false;
    }

    stopRestTimer(timerId) {
        const timer = this.restTimers.get(timerId);
        if (timer) {
            clearInterval(timer.interval);
            this.restTimers.delete(timerId);
            return true;
        }
        return false;
    }

    stopAllRestTimers() {
        this.restTimers.forEach((timer, id) => {
            this.stopRestTimer(id);
        });
    }

    getRestTimerRemaining(timerId) {
        const timer = this.restTimers.get(timerId);
        return timer ? timer.remaining : 0;
    }

    // Workout Timer
    startWorkoutTimer(onTick, initialElapsed = 0) {
        if (this.workoutTimer) {
            this.stopWorkoutTimer();
        }

        // Adjust startTime to account for any previously elapsed time
        const startTime = Date.now() - (initialElapsed * 1000);
        let elapsed = initialElapsed;

        // A backwards clock change (NTP correction, manual edit) makes
        // Date.now() - startTime shrink or go negative; the display used to
        // read "-1:-52". Elapsed time never runs backwards: it holds at the
        // last value seen until the wall clock catches up again.
        const interval = setInterval(() => {
            elapsed = this._clampedElapsed();
            if (onTick) {
                onTick(elapsed);
            }
        }, 1000);

        this.workoutTimer = {
            interval,
            startTime,
            elapsed
        };

        // Immediately call onTick to show correct time
        if (onTick && initialElapsed > 0) {
            onTick(initialElapsed);
        }

        return startTime;
    }

    stopWorkoutTimer() {
        if (this.workoutTimer) {
            clearInterval(this.workoutTimer.interval);
            // Recompute from the wall clock: the object's `elapsed` field was
            // only a creation-time snapshot, so returning it handed callers
            // the INITIAL elapsed value, not the elapsed time at stop.
            const finalElapsed = this._clampedElapsed();
            this.workoutTimer = null;
            return finalElapsed;
        }
        return 0;
    }

    getWorkoutElapsed() {
        if (this.workoutTimer) {
            return this._clampedElapsed();
        }
        return 0;
    }

    /** Wall-clock elapsed, never below the last value already reported. */
    _clampedElapsed() {
        const t = this.workoutTimer;
        if (!t) return 0;
        const raw = Math.floor((Date.now() - t.startTime) / 1000);
        t.elapsed = Math.max(t.elapsed || 0, Number.isFinite(raw) ? raw : 0);
        return t.elapsed;
    }

    isWorkoutTimerRunning() {
        return this.workoutTimer !== null;
    }

    // Format time helpers
    static formatTime(seconds) {
        seconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
        return `${minutes}:${String(secs).padStart(2, '0')}`;
    }

    static formatTimeShort(seconds) {
        seconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}:${String(secs).padStart(2, '0')}`;
    }

    // Cleanup
    cleanup() {
        this.stopAllRestTimers();
        this.stopWorkoutTimer();
    }
}

// Singleton instance
export const timerService = new TimerService();
