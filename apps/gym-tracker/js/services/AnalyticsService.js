/**
 * AnalyticsService
 * Calculates statistics, progress, and analytics from workout data
 */
export class AnalyticsService {
    /**
     * Calculate total volume for a date range
     */
    static getTotalVolume(sessions) {
        return sessions.reduce((sum, session) => sum + session.totalVolume, 0);
    }

    /**
     * Get personal records for an exercise
     */
    static getPersonalRecords(exerciseId, sessions) {
        const exerciseSessions = sessions
            .map(s => ({
                date: s.date,
                exercises: s.exercises.filter(e => e.exerciseId === exerciseId)
            }))
            .filter(s => s.exercises.length > 0);

        if (exerciseSessions.length === 0) return null;

        let maxWeight = 0;
        let maxVolume = 0;
        let maxReps = 0;
        let maxDate = null;

        exerciseSessions.forEach(session => {
            session.exercises.forEach(exercise => {
                exercise.sets.forEach(set => {
                    if (set.weight > maxWeight) {
                        maxWeight = set.weight;
                        maxDate = session.date;
                    }
                    if (set.reps > maxReps) {
                        maxReps = set.reps;
                    }
                    const volume = set.volume;
                    if (volume > maxVolume) {
                        maxVolume = volume;
                    }
                });
            });
        });

        return {
            maxWeight,
            maxReps,
            maxVolume,
            date: maxDate
        };
    }

    /**
     * Get last workout data for an exercise
     */
    static getLastWorkoutData(exerciseId, sessions, beforeDate = null) {
        let filteredSessions = sessions.filter(s =>
            s.exercises.some(e => e.exerciseId === exerciseId)
        );

        if (beforeDate) {
            filteredSessions = filteredSessions.filter(s =>
                new Date(s.date) < new Date(beforeDate)
            );
        }

        if (filteredSessions.length === 0) return null;

        // Sort by date descending
        filteredSessions.sort((a, b) => new Date(b.date) - new Date(a.date));

        const lastSession = filteredSessions[0];
        const exercise = lastSession.exercises.find(e => e.exerciseId === exerciseId);

        return {
            date: lastSession.date,
            sets: exercise.sets,
            totalVolume: exercise.totalVolume
        };
    }

    /**
     * Check if current workout shows improvement
     */
    static hasImproved(currentSets, previousSets) {
        if (!previousSets || previousSets.length === 0) return null;

        const currentVolume = currentSets.reduce((sum, set) => sum + set.volume, 0);
        const previousVolume = previousSets.reduce((sum, set) => sum + set.volume, 0);

        if (currentVolume > previousVolume) return true;
        if (currentVolume < previousVolume) return false;
        return null; // Same
    }

    /**
     * Get workout frequency stats
     */
    static getWorkoutFrequency(sessions, days = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const recentSessions = sessions.filter(s =>
            new Date(s.date) >= cutoffDate
        );

        return {
            totalWorkouts: recentSessions.length,
            averagePerWeek: (recentSessions.length / days) * 7,
            days
        };
    }

    /**
     * Get volume trends over time
     */
    static getVolumeTrends(sessions, groupBy = 'week') {
        const sorted = [...sessions].sort((a, b) => new Date(a.date) - new Date(b.date));

        const groups = new Map();

        sorted.forEach(session => {
            const date = new Date(session.date);
            let key;

            if (groupBy === 'week') {
                const weekStart = new Date(date);
                const day = date.getDay();
                const diff = day === 0 ? 6 : day - 1; // Monday as start of week
                weekStart.setDate(date.getDate() - diff);
                key = weekStart.toISOString().split('T')[0];
            } else if (groupBy === 'month') {
                key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            } else {
                key = session.date;
            }

            if (!groups.has(key)) {
                groups.set(key, { volume: 0, workouts: 0 });
            }

            const group = groups.get(key);
            group.volume += session.totalVolume;
            group.workouts += 1;
        });

        return Array.from(groups.entries()).map(([date, data]) => ({
            date,
            volume: data.volume,
            workouts: data.workouts,
            averageVolume: data.volume / data.workouts
        }));
    }

    /**
     * Get exercise frequency
     */
    static getExerciseFrequency(sessions) {
        const frequency = new Map();

        sessions.forEach(session => {
            session.exercises.forEach(exercise => {
                const count = frequency.get(exercise.exerciseId) || 0;
                frequency.set(exercise.exerciseId, count + 1);
            });
        });

        return Array.from(frequency.entries())
            .map(([exerciseId, count]) => ({ exerciseId, count }))
            .sort((a, b) => b.count - a.count);
    }

    /**
     * Get muscle group distribution
     */
    static getMuscleGroupDistribution(sessions, exerciseDatabase) {
        const distribution = new Map();

        sessions.forEach(session => {
            session.exercises.forEach(exercise => {
                const exerciseData = exerciseDatabase.find(e => e.id === exercise.exerciseId);
                if (exerciseData) {
                    const muscle = exerciseData.muscleGroup;
                    const count = distribution.get(muscle) || 0;
                    distribution.set(muscle, count + 1);
                }
            });
        });

        return Array.from(distribution.entries())
            .map(([muscle, count]) => ({ muscle, count }))
            .sort((a, b) => b.count - a.count);
    }

    /**
     * Get progression for an exercise over time
     */
    static getExerciseProgression(exerciseId, sessions) {
        const exerciseSessions = sessions
            .filter(s => s.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        return exerciseSessions.map(session => {
            const exercise = session.exercises.find(e => e.exerciseId === exerciseId);
            const maxWeight = Math.max(...exercise.sets.map(s => s.weight), 0);
            const totalVolume = exercise.totalVolume;
            const totalReps = exercise.sets.reduce((sum, s) => sum + s.reps, 0);

            return {
                date: session.date,
                maxWeight,
                totalVolume,
                totalReps,
                sets: exercise.sets.length
            };
        });
    }

    /**
     * Calculate achievement progress
     */
    static calculateAchievementProgress(achievementId, sessions, type) {
        switch (type) {
            case 'total-workouts':
                return sessions.length;

            case 'total-volume':
                return this.getTotalVolume(sessions);

            case 'workout-streak': {
                const sorted = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
                let streak = 0;
                let currentDate = new Date();

                for (const session of sorted) {
                    const sessionDate = new Date(session.date);
                    const diffDays = Math.floor((currentDate - sessionDate) / (1000 * 60 * 60 * 24));

                    if (diffDays <= 1 + streak) {
                        streak++;
                        currentDate = sessionDate;
                    } else {
                        break;
                    }
                }
                return streak;
            }

            case 'exercises-completed': {
                const uniqueExercises = new Set();
                sessions.forEach(s => {
                    s.exercises.forEach(e => uniqueExercises.add(e.exerciseId));
                });
                return uniqueExercises.size;
            }

            default:
                return 0;
        }
    }

    /**
     * Get calendar data with workout indicators
     */
    static getCalendarData(sessions, year, month) {
        const calendarData = new Map();

        sessions.forEach(session => {
            const date = new Date(session.date);
            if (date.getFullYear() === year && date.getMonth() === month) {
                const key = session.date;
                if (!calendarData.has(key)) {
                    calendarData.set(key, {
                        workouts: 0,
                        totalVolume: 0,
                        hasGains: false
                    });
                }

                const data = calendarData.get(key);
                data.workouts += 1;
                data.totalVolume += session.totalVolume;
            }
        });

        return calendarData;
    }

    /**
     * Compute the set of date strings (YYYY-MM-DD) where the user beat their
     * previous best total session volume for the same workout type.
     *
     * Definition:
     *   - Group sessions by workoutDayName (fallback: workoutDayId).
     *   - For each session in chronological order, compare its total volume
     *     against the running max for that group.
     *   - The first session of a workout type SEEDS the baseline; it does
     *     NOT count as a PR (no previous attempt to beat).
     *   - If today's session volume > group's previous max → PR for today.
     *
     * Why session-level (not per-exercise): users compare workout-to-workout,
     * not set-to-set. "I lifted more total today than last time on this
     * workout" is the intuitive PR signal.
     */
    static getProgressDates(sessions) {
        const sorted = [...sessions].sort((a, b) => {
            const ad = new Date(a.date).getTime();
            const bd = new Date(b.date).getTime();
            if (ad !== bd) return ad - bd;
            return (a.timestamp || '').localeCompare(b.timestamp || '');
        });

        const bestVolumeByWorkout = new Map(); // groupKey -> max total volume
        const progressDates = new Set();

        sorted.forEach(session => {
            const groupKey = (session.workoutDayName && session.workoutDayName.trim())
                || (session.workoutDayId != null ? `id:${session.workoutDayId}` : '__unnamed__');

            const totalVolume = session.totalVolume
                || (session.exercises || []).reduce((sum, ex) => {
                    return sum + (ex.sets || []).reduce(
                        (s, set) => s + (set.weight || 0) * (set.reps || 0), 0
                    );
                }, 0);

            if (totalVolume <= 0) return;

            const prev = bestVolumeByWorkout.get(groupKey);
            if (prev === undefined) {
                bestVolumeByWorkout.set(groupKey, totalVolume);
                return; // first session of this workout type — seed only
            }
            if (totalVolume > prev) {
                bestVolumeByWorkout.set(groupKey, totalVolume);
                progressDates.add(session.date);
            }
        });

        return progressDates;
    }

    /**
     * Group sessions by their YYYY-MM-DD date.
     */
    static getSessionsByDate(sessions) {
        const map = new Map();
        sessions.forEach(s => {
            if (!map.has(s.date)) map.set(s.date, []);
            map.get(s.date).push(s);
        });
        return map;
    }

    /**
     * Summary stats for a given (year, month).
     */
    static getMonthSummary(sessions, year, month) {
        const monthSessions = sessions.filter(s => {
            const d = new Date(s.date);
            return d.getFullYear() === year && d.getMonth() === month;
        });
        const totalVolume = this.getTotalVolume(monthSessions);
        const totalDuration = monthSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
        const progress = this.getProgressDates(monthSessions);
        const workoutDays = new Set(monthSessions.map(s => s.date)).size;
        return {
            sessionCount: monthSessions.length,
            workoutDays,
            totalVolume,
            totalDuration, // minutes
            prDays: progress.size,
        };
    }

    /**
     * Current consecutive-day streak ending today (or yesterday — see logic).
     */
    static getCurrentStreak(sessions) {
        if (!sessions.length) return 0;
        const dates = new Set(sessions.map(s => s.date));
        let streak = 0;
        const cursor = new Date();
        // If no workout today, allow streak that ended yesterday
        const todayKey = cursor.toISOString().split('T')[0];
        if (!dates.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
        while (true) {
            const key = cursor.toISOString().split('T')[0];
            if (dates.has(key)) {
                streak++;
                cursor.setDate(cursor.getDate() - 1);
            } else {
                break;
            }
        }
        return streak;
    }
}
