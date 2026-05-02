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

test('getVolumeByCategoryInRange: duration-only sets count toward volume', () => {
    const sessions = [session('2026-04-01', [
        { exerciseId: 3, sets: [{ duration: 60 }, { duration: 90 }] },
    ])];
    const start = AnalyticsService.toLocalDate('2026-04-01');
    const end = AnalyticsService.toLocalDate('2026-04-08');
    const out = AnalyticsService.getVolumeByCategoryInRange(sessions, db, start, end);
    assert.deepEqual(out, [{ category: 'legs', volume: 150 }]);
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
