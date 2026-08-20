/**
 * AnalyticsService
 * Calculates statistics, progress, and analytics from workout data.
 *
 * Dates in session data are persisted as local YYYY-MM-DD strings (that's
 * what the user sees on their calendar). Parsing those strings with the
 * naked `new Date("YYYY-MM-DD")` constructor treats them as UTC midnight,
 * which is *before* local midnight for any user west of UTC. That shifts
 * workouts into the wrong day/week/month on the dashboard, calendar,
 * streaks, etc. Use `toLocalDate()` / `toLocalDateKey()` below instead.
 */
import { sameId } from '../utils/id-utils.js';
import { setTimedSeconds, setVolume } from '../models/Set.js';
import { startOfWeek, weekKey } from '../utils/week.js';

export class AnalyticsService {
    /**
     * Parse a local YYYY-MM-DD (or full timestamp) into a Date anchored
     * to local midnight. Falls back to the native constructor for any
     * non-matching input so full ISO timestamps still parse correctly.
     */
    static toLocalDate(dateStr) {
        if (typeof dateStr !== 'string') return new Date(dateStr);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
        if (!m) return new Date(dateStr);
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }

    /**
     * Format a Date as local YYYY-MM-DD. Matches the storage format the
     * rest of the app uses; avoids the UTC shift of `toISOString()`.
     */
    static toLocalDateKey(date) {
        const d = date instanceof Date ? date : new Date(date);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

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
                exercises: s.exercises.filter(e => sameId(e.exerciseId, exerciseId))
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
                    const volume = setVolume(set);
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
            s.exercises.some(e => sameId(e.exerciseId, exerciseId))
        );

        if (beforeDate) {
            const cutoff = this.toLocalDate(beforeDate);
            filteredSessions = filteredSessions.filter(s =>
                this.toLocalDate(s.date) < cutoff
            );
        }

        if (filteredSessions.length === 0) return null;

        // Sort by date descending
        filteredSessions.sort((a, b) => this.toLocalDate(b.date) - this.toLocalDate(a.date));

        const lastSession = filteredSessions[0];
        const exercise = lastSession.exercises.find(e => sameId(e.exerciseId, exerciseId));

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

        const currentVolume = currentSets.reduce((sum, set) => sum + setVolume(set), 0);
        const previousVolume = previousSets.reduce((sum, set) => sum + setVolume(set), 0);

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
        cutoffDate.setHours(0, 0, 0, 0);

        const recentSessions = sessions.filter(s =>
            this.toLocalDate(s.date) >= cutoffDate
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
    static getVolumeTrends(sessions, groupBy = 'week', firstDayOfWeek = 1) {
        const sorted = [...sessions].sort((a, b) => this.toLocalDate(a.date) - this.toLocalDate(b.date));

        const groups = new Map();

        sorted.forEach(session => {
            const date = this.toLocalDate(session.date);
            let key;

            if (groupBy === 'week') {
                const weekStart = startOfWeek(date, firstDayOfWeek);
                key = this.toLocalDateKey(weekStart);
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
     * Sum lifted volume per muscle category (chest, back, …) for sessions
     * inside `[startDate, endDate)` (both YYYY-MM-DD strings or Date).
     * Volume is the same `weight × reps` (or `duration` for time-based)
     * exposed by Set.volume / WorkoutExercise.totalVolume.
     *
     * `exerciseDatabase` is the merged default + custom catalog. We look
     * up `category` rather than the more granular `muscleGroup` because
     * the dashboard wants a small, stable axis (chest, back, legs, …)
     * rather than 30+ sub-muscles. Exercises whose category is unknown
     * (e.g. legacy custom entries with a free-text muscle) bucket into
     * 'other' so they aren't silently dropped.
     */
    static getVolumeByCategoryInRange(sessions, exerciseDatabase, startDate, endDate) {
        const start = startDate instanceof Date ? startDate : this.toLocalDate(startDate);
        const end = endDate instanceof Date ? endDate : this.toLocalDate(endDate);
        const byId = new Map((exerciseDatabase || []).map(e => [e.id, e]));
        const totals = new Map();
        sessions.forEach(s => {
            const d = this.toLocalDate(s.date);
            if (d < start || d >= end) return;
            (s.exercises || []).forEach(ex => {
                const data = byId.get(ex.exerciseId);
                const category = (data && data.category) || 'other';
                // Weight-volume ONLY. Adding `set.duration` here is what
                // produced "Core 300 kg" out of five minutes of planks
                // (GT-04); time under tension is reported separately.
                const vol = (ex.sets || []).reduce((sum, set) => sum + setVolume(set), 0);
                if (vol <= 0) return;
                totals.set(category, (totals.get(category) || 0) + vol);
            });
        });
        return Array.from(totals.entries())
            .map(([category, volume]) => ({ category, volume }))
            .sort((a, b) => b.volume - a.volume);
    }

    /**
     * Total daily volume across all sessions, keyed by YYYY-MM-DD. Used
     * by the calendar heatmap so an O(sessions) sweep can light up the
     * full year in one render. Sessions with the same date sum together.
     */
    static getDailyVolumeMap(sessions) {
        const out = new Map();
        sessions.forEach(s => {
            const key = s.date;
            if (!key) return;
            const vol = (s.totalVolume != null)
                ? s.totalVolume
                : (s.exercises || []).reduce((sum, ex) => sum + (ex.sets || []).reduce(
                    (k, set) => k + setVolume(set), 0), 0);
            out.set(key, (out.get(key) || 0) + vol);
        });
        return out;
    }

    /**
     * Item 4: latest date (local YYYY-MM-DD) on which each muscle category
     * logged any volume. Categories that were never trained are absent from
     * the map. Category lookup matches getVolumeByCategoryInRange, so an
     * exercise missing from the catalog buckets into 'other'.
     */
    static getLastTrainedByCategory(sessions, exerciseDatabase) {
        const byId = new Map((exerciseDatabase || []).map(e => [e.id, e]));
        const out = new Map();
        (sessions || []).forEach(s => {
            if (!s.date) return;
            (s.exercises || []).forEach(ex => {
                const data = byId.get(ex.exerciseId);
                const category = (data && data.category) || 'other';
                // "Was this trained?" is a yes/no, so time counts here even
                // though it never counts as volume: a plank IS core work.
                const worked = (ex.sets || []).some(
                    set => setVolume(set) > 0 || setTimedSeconds(set) > 0);
                if (!worked) return;
                const prev = out.get(category);
                if (!prev || s.date > prev) out.set(category, s.date);
            });
        });
        return out;
    }

    /**
     * Item 4: muscle categories the user has PROGRAMMED but has not trained
     * inside the trailing `days` window. Saved programs are the statement of
     * intent, so a category that appears in no program is never reported.
     *
     * Returns [{ category, lastDate, daysSince }] where a never-trained
     * category carries `lastDate: null` / `daysSince: null`. Sorted
     * never-trained first, then longest-neglected first, then by name.
     */
    static getStaleProgramCategories(programs, sessions, exerciseDatabase, { days = 14, today = new Date() } = {}) {
        const byId = new Map((exerciseDatabase || []).map(e => [e.id, e]));
        const programmed = new Set();
        (programs || []).forEach(p => {
            (p.exercises || []).forEach(ex => {
                const data = byId.get(ex.exerciseId);
                programmed.add((data && data.category) || 'other');
            });
        });
        if (programmed.size === 0) return [];

        const end = new Date(today);
        end.setHours(0, 0, 0, 0);
        const windowStart = new Date(end);
        windowStart.setDate(windowStart.getDate() - days);
        const endExclusive = new Date(end);
        endExclusive.setDate(endExclusive.getDate() + 1); // inclusive of today

        const recent = new Set(
            this.getVolumeByCategoryInRange(sessions || [], exerciseDatabase, windowStart, endExclusive)
                .map(t => t.category),
        );
        const lastTrained = this.getLastTrainedByCategory(sessions || [], exerciseDatabase);

        const out = [];
        programmed.forEach(category => {
            if (recent.has(category)) return;
            const lastDate = lastTrained.get(category) || null;
            const daysSince = lastDate
                ? Math.round((end - this.toLocalDate(lastDate)) / 86400000)
                : null;
            out.push({ category, lastDate, daysSince });
        });

        return out.sort((a, b) => {
            const av = a.daysSince == null ? Infinity : a.daysSince;
            const bv = b.daysSince == null ? Infinity : b.daysSince;
            if (av !== bv) return bv - av;
            return a.category.localeCompare(b.category);
        });
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
     * Get progression for an exercise over time.
     *
     * `limit` — if provided, returns only the N most-recent sessions
     * (still in chronological order). Used by the exercise-detail chart
     * to keep the visual bounded on users with long histories.
     */
    static getExerciseProgression(exerciseId, sessions, { limit } = {}) {
        const exerciseSessions = sessions
            .filter(s => s.exercises.some(e => sameId(e.exerciseId, exerciseId)))
            .sort((a, b) => this.toLocalDate(a.date) - this.toLocalDate(b.date));

        const points = exerciseSessions.map(session => {
            const exercise = session.exercises.find(e => sameId(e.exerciseId, exerciseId));
            const sets = exercise.sets || [];
            const maxWeight = Math.max(...sets.map(s => s.weight || 0), 0);
            const maxDuration = Math.max(...sets.map(s => s.duration || 0), 0);
            const totalVolume = exercise.totalVolume || 0;
            const totalReps = sets.reduce((sum, s) => sum + (s.reps || 0), 0);
            // Estimated 1-rep max via Epley: w * (1 + r/30) across all sets, take peak.
            const e1rm = sets.reduce((best, s) => {
                if (!s.weight || !s.reps) return best;
                const est = s.weight * (1 + s.reps / 30);
                return est > best ? est : best;
            }, 0);

            return {
                date: session.date,
                maxWeight,
                maxDuration,
                totalVolume,
                totalReps,
                e1rm,
                sets: sets.length,
            };
        });

        if (limit && points.length > limit) {
            return points.slice(points.length - limit);
        }
        return points;
    }

    /**
     * Epley estimated 1-rep max. Returned as a number of the same unit as
     * the input weight (kg or lb).
     */
    static epley1rm(weight, reps) {
        if (!weight || !reps) return 0;
        return weight * (1 + reps / 30);
    }

    /**
     * Decide whether a just-logged set qualifies as a personal record.
     *
     * PR rule (single, simple):
     *   Weighted exercises → set volume = weight × reps, new > prior best.
     *   Duration exercises → new hold > prior longest.
     *
     * Notably this means heavier weight at fewer reps is NOT a PR unless
     * the total (weight × reps) still beats the prior best. This matches
     * the intuitive "I moved more total load in one set" signal.
     *
     * Returns null (not a PR) or:
     *   { kind: 'volume' | 'duration',
     *     value: number, previous: number, delta: number }
     *
     * A set is only a PR if there is at least one prior set for the
     * exercise — the first session seeds the baseline and never counts.
     *
     * `currentSessionPriorSets` are the earlier committed sets of the
     * in-progress session for the same exercise. Including them prevents a
     * second set at the same new max from re-triggering the PR already earned
     * by the first set this session.
     */
    static isSetPR(exerciseId, newSet, sessions, currentSessionPriorSets = []) {
        if (!newSet) return null;
        const priorSets = [];
        sessions.forEach(s => {
            s.exercises.forEach(ex => {
                // sameId, not ===: an imported session can carry string ids,
                // which would make its sets invisible to the PR baseline and
                // hand out a PR the lifter had already beaten (GT-18).
                if (sameId(ex.exerciseId, exerciseId)) {
                    (ex.sets || []).forEach(set => priorSets.push(set));
                }
            });
        });
        (currentSessionPriorSets || []).forEach(set => priorSets.push(set));
        if (priorSets.length === 0) return null;

        const isDuration = (newSet.duration || 0) > 0 && (newSet.weight || 0) === 0;

        if (isDuration) {
            const prevMax = priorSets.reduce((m, s) => Math.max(m, s.duration || 0), 0);
            if ((newSet.duration || 0) > prevMax) {
                return {
                    kind: 'duration',
                    value: newSet.duration,
                    previous: prevMax,
                    delta: newSet.duration - prevMax,
                };
            }
            return null;
        }

        const prevMaxVolume = priorSets.reduce(
            (m, s) => Math.max(m, (s.weight || 0) * (s.reps || 0)), 0
        );
        const newVolume = (newSet.weight || 0) * (newSet.reps || 0);
        if (newVolume <= prevMaxVolume) return null;

        // WHAT was broken, so the badge can say it honestly. The trigger is
        // unchanged (set volume, the documented rule the audit verified);
        // this only records whether the lifter ALSO put more on the bar, so
        // "PR +5 kg" can be shown where it is true and "+50 kg·reps"
        // everywhere else. Rendering the volume delta as bare kilograms read
        // as "you added 50 kg to the bar" (GT-18).
        const prevMaxWeight = priorSets.reduce(
            (m, s) => Math.max(m, ((s.duration || 0) > 0 ? 0 : (s.weight || 0))), 0
        );
        const newWeight = newSet.weight || 0;
        const isWeightPr = newWeight > prevMaxWeight;

        return {
            kind: isWeightPr ? 'weight' : 'volume',
            value: newVolume,
            previous: prevMaxVolume,
            delta: newVolume - prevMaxVolume,
            weight: newWeight,
            previousWeight: prevMaxWeight,
            weightDelta: newWeight - prevMaxWeight,
        };
    }

    /**
     * Feature 9: bodyweight exercise name list. Exercises whose names
     * include any of these keywords and whose logged weight is 0 get the
     * lifter's bodyweight substituted for volume math.
     */
    static BODYWEIGHT_EXERCISE_KEYWORDS = [
        'push-up', 'push up', 'pushup',
        'pull-up', 'pull up', 'pullup',
        'chin-up', 'chin up', 'chinup',
        'dip', 'body row', 'inverted row',
        'hanging knee raise', 'knee raise',
    ];

    /**
     * Feature 9: return true if an exercise name matches the bodyweight heuristic.
     */
    static isBodyweightExercise(exerciseName) {
        const lower = (exerciseName || '').toLowerCase();
        return this.BODYWEIGHT_EXERCISE_KEYWORDS.some(kw => lower.includes(kw));
    }

    /**
     * Feature 9: compute effective volume for a set, substituting bodyweight
     * when the set weight is 0 and the exercise is a bodyweight exercise.
     * Does NOT mutate the stored set.
     */
    static effectiveSetVolume(set, exerciseName, bodyweight) {
        // A hold has no weight-volume; its seconds belong to the time
        // metric, never to a kilogram total (GT-04).
        if (set.duration > 0) return 0;
        const w = (set.weight === 0 || set.weight == null)
            && bodyweight != null
            && this.isBodyweightExercise(exerciseName)
            ? bodyweight
            : (set.weight || 0);
        return w * (set.reps || 0);
    }

    /**
     * Feature 9: total session volume with bodyweight substitution for
     * zero-weight bodyweight exercises. `exerciseDb` provides category/name
     * lookups; `bodyweight` is the latest measurement weight (may be null).
     */
    static getEffectiveSessionVolume(session, bodyweight) {
        return (session.exercises || []).reduce((sum, ex) => {
            const name = ex.exerciseName || '';
            return sum + (ex.sets || []).reduce(
                (s, set) => s + this.effectiveSetVolume(set, name, bodyweight), 0
            );
        }, 0);
    }

    /**
     * Weekly summary stats for the Home dashboard.
     *
     * Returns totals for the week containing today plus deltas vs the prior
     * week. The window honours the configured first day of the week
     * (`firstDayOfWeek`, 0 = Sunday, 1 = Monday) - it used to be hard-coded
     * to ISO Monday, so a Sunday-first user's Sunday session silently fell
     * out of "this week" while their Calendar counted it (GT-10). Passing 1
     * reproduces the previous behaviour exactly.
     *
     * "Volume" sums weight × reps in canonical kilograms; timed sets
     * contribute to nothing here (see Set.volume).
     */
    static getWeekStats(sessions, firstDayOfWeek = 1) {
        const now = new Date();
        const thisMonday = startOfWeek(now, firstDayOfWeek);
        const lastMonday = new Date(thisMonday);
        lastMonday.setDate(thisMonday.getDate() - 7);
        const nextMonday = new Date(thisMonday);
        nextMonday.setDate(thisMonday.getDate() + 7);

        const within = (s, start, end) => {
            const d = this.toLocalDate(s.date);
            return d >= start && d < end;
        };

        const agg = (slice) => {
            const workouts = slice.length;
            const volume = slice.reduce((sum, s) => sum + (s.totalVolume || 0), 0);
            const durationMin = slice.reduce((sum, s) => sum + (s.duration || 0), 0);
            return { workouts, volume, durationMin };
        };

        const thisWeek = sessions.filter(s => within(s, thisMonday, nextMonday));
        const lastWeek = sessions.filter(s => within(s, lastMonday, thisMonday));

        const cur = agg(thisWeek);
        const prev = agg(lastWeek);

        return {
            workouts: cur.workouts,
            volume: cur.volume,
            durationMin: cur.durationMin,
            streak: this.getCurrentStreak(sessions),
            workoutsDelta: cur.workouts - prev.workouts,
            volumeDelta: cur.volume - prev.volume,
            weekStart: this.toLocalDateKey(thisMonday),
        };
    }

    /**
     * Local midnight on the first day of the week containing `date`.
     *
     * Delegates to `utils/week.js`, the single week-boundary definition
     * shared with the Calendar, the workout week strip, the program-editor
     * day chips and the weekly achievements. `startOfIsoWeek` is retained as
     * the Monday-pinned alias its callers already used.
     */
    static startOfWeek(date, firstDayOfWeek = 1) {
        return startOfWeek(date, firstDayOfWeek);
    }

    /** Monday 00:00 of the week containing `date` (ISO week). */
    static startOfIsoWeek(date) {
        return startOfWeek(date, 1);
    }

    /** Stable key for the week containing `date`, honouring the preference. */
    static weekKeyFor(date, firstDayOfWeek = 1) {
        return weekKey(date, firstDayOfWeek);
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
                // Reuse the canonical streak logic — avoids a second
                // slightly-different implementation drifting out of sync
                // (and inheriting the same UTC-midnight bugs this file is
                // fixing).
                return this.getCurrentStreak(sessions);
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
            const date = this.toLocalDate(session.date);
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
            const ad = this.toLocalDate(a.date).getTime();
            const bd = this.toLocalDate(b.date).getTime();
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
            const d = this.toLocalDate(s.date);
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
        // Walk backwards from today in LOCAL time. Using toISOString() here
        // would give UTC dates, which misattribute late-evening sessions
        // (stored by local date) and skip them from the streak.
        const cursor = new Date();
        cursor.setHours(0, 0, 0, 0);
        // If no workout today, allow streak that ended yesterday
        if (!dates.has(this.toLocalDateKey(cursor))) {
            cursor.setDate(cursor.getDate() - 1);
        }
        while (true) {
            if (dates.has(this.toLocalDateKey(cursor))) {
                streak++;
                cursor.setDate(cursor.getDate() - 1);
            } else {
                break;
            }
        }
        return streak;
    }
}
