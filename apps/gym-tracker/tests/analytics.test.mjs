// Pin timezone so date-key assertions are deterministic across machines.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../js/services/AnalyticsService.js';

// Construct a session payload that satisfies the methods we exercise. We
// don't need the full WorkoutSession class — these are pure static methods
// on plain objects.
const makeSession = ({ id = 1, date, sets = [], exerciseId = 100, totalVolume }) => ({
    id,
    date,
    timestamp: `${date}T12:00:00.000Z`,
    workoutDayName: 'Test Day',
    duration: 60,
    exercises: [
        {
            exerciseId,
            exerciseName: 'Bench Press',
            sets,
            // Computed totalVolume — real model has it as a getter, but
            // these methods accept either a getter or a plain field.
            totalVolume: totalVolume ?? sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0),
        },
    ],
    totalVolume: totalVolume ?? sets.reduce((sum, s) => sum + (s.weight || 0) * (s.reps || 0), 0),
});

test('toLocalDateKey: round-trips a Date to YYYY-MM-DD', () => {
    const d = new Date(2026, 0, 5); // Jan 5 2026 local
    assert.equal(AnalyticsService.toLocalDateKey(d), '2026-01-05');
});

test('toLocalDate: parses a YYYY-MM-DD string at local midnight', () => {
    const d = AnalyticsService.toLocalDate('2026-04-24');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 3);
    assert.equal(d.getDate(), 24);
    assert.equal(d.getHours(), 0);
});

test('epley1rm: returns 0 for missing inputs', () => {
    assert.equal(AnalyticsService.epley1rm(0, 5), 0);
    assert.equal(AnalyticsService.epley1rm(100, 0), 0);
    assert.equal(AnalyticsService.epley1rm(undefined, undefined), 0);
});

test('epley1rm: matches the Epley formula', () => {
    // 100kg x 5 → 100 * (1 + 5/30) = 116.666...
    assert.ok(Math.abs(AnalyticsService.epley1rm(100, 5) - 116.6667) < 0.01);
});

test('isSetPR: returns null when no prior sets exist', () => {
    const newSet = { weight: 100, reps: 5 };
    assert.equal(AnalyticsService.isSetPR(100, newSet, []), null);
});

test('isSetPR: weighted PR fires when volume strictly beats prior max', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] })];
    const result = AnalyticsService.isSetPR(100, { weight: 100, reps: 6 }, sessions);
    assert.equal(result.kind, 'volume');
    assert.equal(result.value, 600);
    assert.equal(result.previous, 500);
    assert.equal(result.delta, 100);
});

test('isSetPR: weighted PR does not fire when volume ties the prior max', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] })];
    const result = AnalyticsService.isSetPR(100, { weight: 100, reps: 5 }, sessions);
    assert.equal(result, null);
});

test('isSetPR: duration PR fires when hold strictly beats prior best', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ duration: 60, weight: 0, reps: 0 }] })];
    const result = AnalyticsService.isSetPR(100, { weight: 0, reps: 0, duration: 90 }, sessions);
    assert.equal(result.kind, 'duration');
    assert.equal(result.value, 90);
    assert.equal(result.previous, 60);
    assert.equal(result.delta, 30);
});

test('isSetPR: heavier weight at fewer reps below volume is NOT a PR', () => {
    // Prior 100x5 = 500 volume; new 200x2 = 400 volume → not a PR.
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] })];
    const result = AnalyticsService.isSetPR(100, { weight: 200, reps: 2 }, sessions);
    assert.equal(result, null);
});

test('getCurrentStreak: zero when no sessions', () => {
    assert.equal(AnalyticsService.getCurrentStreak([]), 0);
});

test('getCurrentStreak: counts back from today through consecutive days', () => {
    const today = AnalyticsService.toLocalDateKey(new Date());
    const yesterday = AnalyticsService.toLocalDateKey(new Date(Date.now() - 24 * 3600 * 1000));
    const dayBefore = AnalyticsService.toLocalDateKey(new Date(Date.now() - 2 * 24 * 3600 * 1000));
    const sessions = [today, yesterday, dayBefore].map(date =>
        makeSession({ date, sets: [{ weight: 50, reps: 5 }] })
    );
    assert.equal(AnalyticsService.getCurrentStreak(sessions), 3);
});

test('getCurrentStreak: allows a one-day grace if no workout today', () => {
    // Streak ending yesterday with nothing today should still report >= 1.
    const yesterday = AnalyticsService.toLocalDateKey(new Date(Date.now() - 24 * 3600 * 1000));
    const sessions = [makeSession({ date: yesterday, sets: [{ weight: 50, reps: 5 }] })];
    assert.equal(AnalyticsService.getCurrentStreak(sessions), 1);
});

test('startOfIsoWeek: returns the local Monday of the containing week', () => {
    const wed = new Date(2026, 0, 7); // Wed Jan 7 2026
    const monday = AnalyticsService.startOfIsoWeek(wed);
    assert.equal(monday.getDay(), 1); // Monday
    assert.equal(monday.getDate(), 5);
    assert.equal(monday.getHours(), 0);
});

test('startOfIsoWeek: Sunday rolls back to the prior Monday', () => {
    const sun = new Date(2026, 0, 4); // Sun Jan 4 2026
    const monday = AnalyticsService.startOfIsoWeek(sun);
    assert.equal(monday.getDay(), 1);
    assert.equal(monday.getDate(), 29); // Mon Dec 29 2025
});

test('getProgressDates: first session of a workout type is the seed, not a PR', () => {
    const sessions = [
        makeSession({ id: 1, date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] }),
    ];
    const dates = AnalyticsService.getProgressDates(sessions);
    assert.equal(dates.size, 0);
});

test('getProgressDates: a strictly higher session volume beats prior max for same workoutDayName', () => {
    const sessions = [
        makeSession({ id: 1, date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] }),
        makeSession({ id: 2, date: '2026-04-08', sets: [{ weight: 100, reps: 6 }] }),
    ];
    const dates = AnalyticsService.getProgressDates(sessions);
    assert.deepEqual([...dates], ['2026-04-08']);
});

test('getProgressDates: a session with lower volume is not a PR', () => {
    const sessions = [
        makeSession({ id: 1, date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] }),
        makeSession({ id: 2, date: '2026-04-08', sets: [{ weight: 100, reps: 4 }] }),
    ];
    const dates = AnalyticsService.getProgressDates(sessions);
    assert.equal(dates.size, 0);
});

test('getExerciseProgression: returns one point per session in chronological order', () => {
    const sessions = [
        makeSession({ date: '2026-04-08', sets: [{ weight: 100, reps: 5 }] }),
        makeSession({ date: '2026-04-01', sets: [{ weight: 80, reps: 5 }] }),
    ];
    const out = AnalyticsService.getExerciseProgression(100, sessions);
    assert.equal(out.length, 2);
    assert.equal(out[0].date, '2026-04-01');
    assert.equal(out[1].date, '2026-04-08');
});

test('getExerciseProgression: limit caps to the most recent N points', () => {
    const sessions = [
        makeSession({ date: '2026-04-01', sets: [{ weight: 80, reps: 5 }] }),
        makeSession({ date: '2026-04-08', sets: [{ weight: 90, reps: 5 }] }),
        makeSession({ date: '2026-04-15', sets: [{ weight: 100, reps: 5 }] }),
    ];
    const out = AnalyticsService.getExerciseProgression(100, sessions, { limit: 2 });
    assert.deepEqual(out.map(p => p.date), ['2026-04-08', '2026-04-15']);
});
