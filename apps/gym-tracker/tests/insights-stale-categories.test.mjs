process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../js/services/AnalyticsService.js';

const TODAY = new Date(2026, 3, 30); // 2026-04-30, local midnight

const session = (date, exercises) => ({
    id: date,
    date,
    timestamp: `${date}T12:00:00.000Z`,
    workoutDayName: 'Day',
    exercises: exercises.map(e => ({
        exerciseId: e.exerciseId,
        exerciseName: 'X',
        sets: e.sets,
    })),
});

const program = (exerciseIds) => ({
    id: 1,
    name: 'P',
    exercises: exerciseIds.map(id => ({ exerciseId: id, exerciseName: 'X' })),
});

const db = [
    { id: 1, category: 'chest' },
    { id: 2, category: 'back' },
    { id: 3, category: 'quads' },
];

test('getLastTrainedByCategory: keeps the most recent date per category', () => {
    const sessions = [
        session('2026-04-01', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
        session('2026-04-20', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
        session('2026-04-10', [{ exerciseId: 2, sets: [{ weight: 80, reps: 5 }] }]),
    ];
    const map = AnalyticsService.getLastTrainedByCategory(sessions, db);
    assert.equal(map.get('chest'), '2026-04-20');
    assert.equal(map.get('back'), '2026-04-10');
    assert.equal(map.has('quads'), false);
});

test('getLastTrainedByCategory: zero-volume sets do not count as trained', () => {
    const sessions = [session('2026-04-20', [
        { exerciseId: 1, sets: [{ weight: 0, reps: 0 }] },
    ])];
    const map = AnalyticsService.getLastTrainedByCategory(sessions, db);
    assert.equal(map.size, 0);
});

test('getStaleProgramCategories: lists a programmed category with no volume in the window', () => {
    const sessions = [
        session('2026-04-29', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
        session('2026-04-05', [{ exerciseId: 2, sets: [{ weight: 80, reps: 5 }] }]),
    ];
    const out = AnalyticsService.getStaleProgramCategories(
        [program([1, 2])], sessions, db, { today: TODAY },
    );
    assert.deepEqual(out, [{ category: 'back', lastDate: '2026-04-05', daysSince: 25 }]);
});

test('getStaleProgramCategories: a never-trained programmed category reports null', () => {
    const sessions = [session('2026-04-29', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }])];
    const out = AnalyticsService.getStaleProgramCategories(
        [program([1, 3])], sessions, db, { today: TODAY },
    );
    assert.deepEqual(out, [{ category: 'quads', lastDate: null, daysSince: null }]);
});

test('getStaleProgramCategories: categories absent from every program are never listed', () => {
    // 'back' has not been trained in months, but nothing programs it.
    const sessions = [
        session('2026-01-02', [{ exerciseId: 2, sets: [{ weight: 80, reps: 5 }] }]),
        session('2026-04-29', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
    ];
    const out = AnalyticsService.getStaleProgramCategories(
        [program([1])], sessions, db, { today: TODAY },
    );
    assert.deepEqual(out, []);
});

test('getStaleProgramCategories: training a category inside the window clears it', () => {
    const stale = AnalyticsService.getStaleProgramCategories(
        [program([1])],
        [session('2026-04-01', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }])],
        db, { today: TODAY },
    );
    assert.equal(stale.length, 1);

    const cleared = AnalyticsService.getStaleProgramCategories(
        [program([1])],
        [
            session('2026-04-01', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
            session('2026-04-28', [{ exerciseId: 1, sets: [{ weight: 60, reps: 1 }] }]),
        ],
        db, { today: TODAY },
    );
    assert.deepEqual(cleared, []);
});

test('getStaleProgramCategories: the window boundary day still counts as recent', () => {
    const onBoundary = AnalyticsService.getStaleProgramCategories(
        [program([1])],
        [session('2026-04-16', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }])],
        db, { today: TODAY }, // 14 days back = 2026-04-16
    );
    assert.deepEqual(onBoundary, []);

    const dayBefore = AnalyticsService.getStaleProgramCategories(
        [program([1])],
        [session('2026-04-15', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }])],
        db, { today: TODAY },
    );
    assert.deepEqual(dayBefore, [{ category: 'chest', lastDate: '2026-04-15', daysSince: 15 }]);
});

test('getStaleProgramCategories: no programs means nothing to report', () => {
    const sessions = [session('2026-01-02', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }])];
    assert.deepEqual(AnalyticsService.getStaleProgramCategories([], sessions, db, { today: TODAY }), []);
});

test('getStaleProgramCategories: never-trained sorts above longest-neglected', () => {
    const sessions = [
        session('2026-04-05', [{ exerciseId: 2, sets: [{ weight: 80, reps: 5 }] }]),
        session('2026-04-10', [{ exerciseId: 1, sets: [{ weight: 100, reps: 5 }] }]),
    ];
    const out = AnalyticsService.getStaleProgramCategories(
        [program([1, 2, 3])], sessions, db, { today: TODAY },
    );
    assert.deepEqual(out.map(r => r.category), ['quads', 'back', 'chest']);
});

test('getStaleProgramCategories: a programmed exercise missing from the catalog buckets into other', () => {
    const out = AnalyticsService.getStaleProgramCategories(
        [program([9999])], [], db, { today: TODAY },
    );
    assert.deepEqual(out, [{ category: 'other', lastDate: null, daysSince: null }]);
});
