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

// Item 11: a PR must beat both completed sessions AND earlier committed sets
// of the current session, so a repeat at the same new max isn't re-celebrated.
test('isSetPR: second set at same new max is NOT a PR (in-session dedupe)', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 90, reps: 5 }] })];
    // Set 1 at 100x5 beats history (450 -> 500) -> PR.
    const set1 = { weight: 100, reps: 5 };
    const pr1 = AnalyticsService.isSetPR(100, set1, sessions, []);
    // 100 also beats the 90 that came before it, so the record broken is the
    // WEIGHT one (GT-18: the badge must not call a volume delta kilograms).
    assert.equal(pr1.kind, 'weight');
    // Set 2 at 100x5 ties set 1's session volume -> NOT a PR.
    const pr2 = AnalyticsService.isSetPR(100, { weight: 100, reps: 5 }, sessions, [set1]);
    assert.equal(pr2, null);
    // Set 3 at 105x5 beats both -> PR again.
    const pr3 = AnalyticsService.isSetPR(100, { weight: 105, reps: 5 }, sessions, [set1, { weight: 100, reps: 5 }]);
    assert.equal(pr3.kind, 'weight');
});

test('isSetPR: equal-weight-more-reps still PRs across in-session sets', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 90, reps: 8 }] })];
    const set1 = { weight: 100, reps: 8 }; // 800 vs 720 -> PR
    assert.ok(AnalyticsService.isSetPR(100, set1, sessions, []));
    const set2 = { weight: 100, reps: 10 }; // 1000 > 800 -> PR
    assert.ok(AnalyticsService.isSetPR(100, set2, sessions, [set1]));
    const set3 = { weight: 100, reps: 10 }; // ties set2 -> not a PR
    assert.equal(AnalyticsService.isSetPR(100, set3, sessions, [set1, set2]), null);
});

test('isSetPR: empty currentSessionPriorSets matches the legacy 3-arg behavior', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 100, reps: 5 }] })];
    const a = AnalyticsService.isSetPR(100, { weight: 100, reps: 6 }, sessions);
    const b = AnalyticsService.isSetPR(100, { weight: 100, reps: 6 }, sessions, []);
    assert.deepEqual(a, b);
});

test('getCurrentStreak: zero when no sessions', () => {
    assert.equal(AnalyticsService.getCurrentStreak([]), 0);
});

// getCurrentStreak reads `new Date()` internally with no injection point, so
// these tests are real-clock by necessity. The relative day keys are computed
// with LOCAL calendar arithmetic (setDate), never Date.now() - N*86400000:
// a DST transition makes a "day" 23 or 25 hours long, and the millisecond
// shortcut then lands on the wrong local date. TZ=UTC is pinned above, but
// the keys must stay correct even if that pin ever changes.
const daysAgoKey = (n) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return AnalyticsService.toLocalDateKey(d);
};

test('getCurrentStreak: counts back from today through consecutive days', () => {
    const sessions = [daysAgoKey(0), daysAgoKey(1), daysAgoKey(2)].map(date =>
        makeSession({ date, sets: [{ weight: 50, reps: 5 }] })
    );
    assert.equal(AnalyticsService.getCurrentStreak(sessions), 3);
});

test('getCurrentStreak: allows a one-day grace if no workout today', () => {
    // Streak ending yesterday with nothing today should still report >= 1.
    const sessions = [makeSession({ date: daysAgoKey(1), sets: [{ weight: 50, reps: 5 }] })];
    assert.equal(AnalyticsService.getCurrentStreak(sessions), 1);
});

test('getCurrentStreak: a gap before yesterday ends the streak', () => {
    // today + yesterday logged, then a hole, then an older session: streak 2.
    const sessions = [daysAgoKey(0), daysAgoKey(1), daysAgoKey(3)].map(date =>
        makeSession({ date, sets: [{ weight: 50, reps: 5 }] })
    );
    assert.equal(AnalyticsService.getCurrentStreak(sessions), 2);
});

test('getCurrentStreak: a lone workout the day before yesterday is not current', () => {
    // The one-day grace covers exactly yesterday; two days back is a dead streak.
    const sessions = [makeSession({ date: daysAgoKey(2), sets: [{ weight: 50, reps: 5 }] })];
    assert.equal(AnalyticsService.getCurrentStreak(sessions), 0);
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

// ---------------------------------------------------------------------------
// GT-18: a PR badge must name the record it actually broke.
//
// The trigger is unchanged (set volume beat the prior best, the documented
// rule the audit verified). What changed is what the result SAYS: the row used
// to render the volume delta with a weight unit, so adding 5 kg to the bar
// showed "PR +50 kg" and read as "you added 50 kg".
// ---------------------------------------------------------------------------

test('isSetPR: more weight than ever reports a WEIGHT record and its weight delta', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 60, reps: 10 }] })];
    const pr = AnalyticsService.isSetPR(100, { weight: 65, reps: 10 }, sessions);
    assert.equal(pr.kind, 'weight');
    assert.equal(pr.weightDelta, 5, 'the number a lifter would recognise');
    assert.equal(pr.previousWeight, 60);
    assert.equal(pr.delta, 50, 'the volume delta is still carried, just not shown as kg');
});

test('isSetPR: more reps at the SAME weight reports a volume record', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 60, reps: 10 }] })];
    const pr = AnalyticsService.isSetPR(100, { weight: 60, reps: 12 }, sessions);
    assert.equal(pr.kind, 'volume', 'nothing new went on the bar');
    assert.equal(pr.delta, 120);
    assert.equal(pr.weightDelta, 0);
});

test('isSetPR: a timed set reports a duration record', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [{ weight: 0, reps: 0, duration: 45 }] })];
    const pr = AnalyticsService.isSetPR(100, { weight: 0, reps: 0, duration: 60 }, sessions);
    assert.equal(pr.kind, 'duration');
    assert.equal(pr.delta, 15);
});

test('isSetPR: prior sets are found through sameId, not strict equality', () => {
    // An imported session can carry string ids. With `===` its sets were
    // invisible to the baseline and a beaten record was celebrated again.
    const sessions = [{
        date: '2026-04-01',
        exercises: [{ exerciseId: '100', sets: [{ weight: 100, reps: 10 }] }],
    }];
    assert.equal(
        AnalyticsService.isSetPR(100, { weight: 80, reps: 10 }, sessions),
        null,
        'the string-id history counts as history',
    );
});

test('isSetPR: a timed prior set never seeds the weight baseline', () => {
    const sessions = [makeSession({ date: '2026-04-01', sets: [
        { weight: 0, reps: 0, duration: 300 },
        { weight: 40, reps: 10 },
    ] })];
    const pr = AnalyticsService.isSetPR(100, { weight: 50, reps: 10 }, sessions);
    assert.equal(pr.kind, 'weight');
    assert.equal(pr.previousWeight, 40, 'the 300-second hold is not a 300 kg lift');
});
