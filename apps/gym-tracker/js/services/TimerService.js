/**
 * TimerService
 * Manages rest timers and workout duration tracking
 */
export class TimerService {
    constructor() {
        this.restTimers = new Map();
        this.workoutTimer = null;
        this.callbacks = new Map();
    }

    // Rest Timer
    startRestTimer(duration, onTick, onComplete) {
        const timerId = Date.now();
        let remaining = duration;

        const interval = setInterval(() => {
            remaining--;

            if (onTick) {
                onTick(remaining);
            }

            if (remaining <= 0) {
                this.stopRestTimer(timerId);
                if (onComplete) {
                    onComplete();
                }
            }
        }, 1000);

        this.restTimers.set(timerId, {
            interval,
            startTime: Date.now(),
            duration,
            remaining
        });

        return timerId;
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
    startWorkoutTimer(onTick) {
        if (this.workoutTimer) {
            this.stopWorkoutTimer();
        }

        const startTime = Date.now();
        let elapsed = 0;

        const interval = setInterval(() => {
            elapsed = Math.floor((Date.now() - startTime) / 1000);
            if (onTick) {
                onTick(elapsed);
            }
        }, 1000);

        this.workoutTimer = {
            interval,
            startTime,
            elapsed
        };

        return startTime;
    }

    stopWorkoutTimer() {
        if (this.workoutTimer) {
            clearInterval(this.workoutTimer.interval);
            const finalElapsed = this.workoutTimer.elapsed;
            this.workoutTimer = null;
            return finalElapsed;
        }
        return 0;
    }

    getWorkoutElapsed() {
        if (this.workoutTimer) {
            return Math.floor((Date.now() - this.workoutTimer.startTime) / 1000);
        }
        return 0;
    }

    isWorkoutTimerRunning() {
        return this.workoutTimer !== null;
    }

    // Format time helpers
    static formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
        return `${minutes}:${String(secs).padStart(2, '0')}`;
    }

    static formatTimeShort(seconds) {
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
