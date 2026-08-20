process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../js/services/AnalyticsService.js';

const session = (date, exercises) => ({
    id: date,
    date,
    timestamp: `${date}T12:00:00.000Z`,
    workoutDayName: 'Day',
    duration: 30,
    exercises: exercises.map(e => ({
        exerciseId: e.exerciseId,
        exerciseName: 'X',
        sets: e.sets,
        totalVolume: e.sets.reduce((s, st) => s + (st.weight || 0) * (st.reps || 0) + (st.duration || 0), 0),
    })),
    totalVolume: exercises
        .flatMap(e => e.sets)
        .reduce((s, st) => s + (st.weight || 0) * (st.reps || 0) + (st.duration || 0), 0),
});

const db = [
    { id: 1, category: 'chest' },
    { id: 2, category: 'back' },
    { id: 3, category: 'legs' }, // no display label entry — falls back to title-cased
];

test('getVolumeByCategoryInRange: sums by category, sorted desc', () => {
    const sessions = [
        session('2026-04-01', [
            { exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }, // chest 500
            { exerciseId: 2, sets: [{ weight: 80, reps: 6 }] },  // back 480
        ]),
        session('2026-04-02', [
            { exerciseId: 1, sets: [{ weight: 100, reps: 6 }] }, // chest 600
        ]),
    ];
    const start = AnalyticsService.toLocalDate('2026-04-01');
    const end = AnalyticsService.toLocalDate('2026-04-08');
    const out = AnalyticsService.getVolumeByCategoryInRange(sessions, db, start, end);
    assert.deepEqual(out, [
        { category: 'chest', volume: 1100 },
        { category: 'back', volume: 480 },
    ]);
});

test('getVolumeByCategoryInRange: filters by date window (end is exclusive)', () => {
    const sessions = [
        session('2026-04-01', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
        session('2026-04-08', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
    ];
    const start = AnalyticsService.toLocalDate('2026-04-01');
    const end = AnalyticsService.toLocalDate('2026-04-08'); // excludes the 8th
    const out = AnalyticsService.getVolumeByCategoryInRange(sessions, db, start, end);
    assert.deepEqual(out, [{ category: 'chest', volume: 500 }]);
});

test('getVolumeByCategoryInRange: unknown exerciseId buckets into other', () => {
    const sessions = [session('2026-04-01', [
        { exerciseId: 9999, sets: [{ weight: 50, reps: 5 }] },
    ])];
    const start = AnalyticsService.toLocalDate('2026-04-01');
    const end = AnalyticsService.toLocalDate('2026-04-08');
    const out = AnalyticsService.getVolumeByCategoryInRange(sessions, db, start, end);
    assert.deepEqual(out, [{ category: 'other', volume: 250 }]);
});

// GT-04: seconds are not kilograms. A 60-second plank used to add "60" to
// the kilogram volume of its muscle group, which is how Insights came to
// report "Core 300 kg" for five minutes of planks.
test('getVolumeByCategoryInRange: duration-only sets contribute NO weight volume', () => {
    const sessions = [session('2026-04-01', [
        { exerciseId: 3, sets: [{ duration: 60 }, { duration: 90 }] },
    ])];
    const start = AnalyticsService.toLocalDate('2026-04-01');
    const end = AnalyticsService.toLocalDate('2026-04-08');
    const out = AnalyticsService.getVolumeByCategoryInRange(sessions, db, start, end);
    assert.deepEqual(out, [], 'a category with only holds has no weight volume to chart');
});

test('getVolumeByCategoryInRange: a mixed session reports only its weight volume', () => {
    const sessions = [session('2026-04-01', [
        { exerciseId: 1, sets: [{ weight: 100, reps: 5 }] },   // 500
        { exerciseId: 3, sets: [{ duration: 300 }] },          // 5 minutes held
    ])];
    const start = AnalyticsService.toLocalDate('2026-04-01');
    const end = AnalyticsService.toLocalDate('2026-04-08');
    const out = AnalyticsService.getVolumeByCategoryInRange(sessions, db, start, end);
    const legs = out.find(o => o.category === 'legs');
    assert.equal(legs, undefined, 'the plank category is not inflated by its seconds');
    assert.equal(out.reduce((n, o) => n + o.volume, 0), 500);
});

test('getLastTrainedByCategory: a hold still counts as having trained the muscle', () => {
    // Volume and "did you train this?" are different questions: a plank is
    // real core work even though it carries no load.
    const sessions = [session('2026-04-01', [
        { exerciseId: 3, sets: [{ duration: 60 }] },
    ])];
    const out = AnalyticsService.getLastTrainedByCategory(sessions, db);
    assert.equal(out.get('legs'), '2026-04-01');
});

test('getDailyVolumeMap: keys by date, sums sessions on the same day', () => {
    const sessions = [
        session('2026-04-01', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
        session('2026-04-01', [{ exerciseId: 1, sets: [{ weight: 100, reps: 3 }] }]),
        session('2026-04-02', [{ exerciseId: 1, sets: [{ weight: 100, reps: 4 }] }]),
    ];
    const map = AnalyticsService.getDailyVolumeMap(sessions);
    assert.equal(map.get('2026-04-01'), 800); // 500 + 300
    assert.equal(map.get('2026-04-02'), 400);
});

test('getDailyVolumeMap: returns empty map for empty input', () => {
    const map = AnalyticsService.getDailyVolumeMap([]);
    assert.equal(map.size, 0);
});

/**
 * Regression: a category trained ONLY with timed work must not be reported as
 * "not trained recently".
 *
 * The GT-04 fix made volume weight-only, and the staleness check was derived
 * from volume, so core (planks) was permanently listed as neglected while the
 * same row said "7 days since last trained". Staleness is about training, not
 * tonnage.
 */
test('timed-only training keeps a category off the stale list', () => {
    const db = [
        { id: 463, name: 'Plank', category: 'core' },
        { id: 3, name: 'Barbell Bench Press', category: 'chest' },
    ];
    const programs = [{ exercises: [{ exerciseId: 463 }, { exerciseId: 3 }] }];
    const today = new Date('2026-08-19T12:00:00');
    const sessions = [{
        date: '2026-08-12',
        exercises: [
            // Planks only: real core work, zero weight volume.
            { exerciseId: 463, sets: [{ weight: 0, reps: 0, duration: 90, completed: true }] },
            { exerciseId: 3, sets: [{ weight: 100, reps: 5, duration: 0, completed: true }] },
        ],
    }];

    const stale = AnalyticsService.getStaleProgramCategories(programs, sessions, db, { days: 14, today });
    assert.equal(stale.find(x => x.category === 'core'), undefined,
        'core was trained 7 days ago with planks and must not be stale');
    assert.equal(stale.find(x => x.category === 'chest'), undefined);

    // Outside the window it SHOULD be reported, with an honest day count.
    const later = new Date('2026-09-15T12:00:00');
    const staleLater = AnalyticsService.getStaleProgramCategories(programs, sessions, db, { days: 14, today: later });
    const core = staleLater.find(x => x.category === 'core');
    assert.ok(core, 'core is stale a month later');
    assert.equal(core.daysSince, 34);
});
