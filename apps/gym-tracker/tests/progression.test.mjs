process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestNextSet } from '../js/utils/progression.js';

const session = (date, sets) => ({
    id: date,
    date,
    timestamp: `${date}T12:00:00.000Z`,
    sortTimestamp: `${date}T12:00:00.000Z`,
    exercises: [
        {
            exerciseId: 100,
            exerciseName: 'Bench Press',
            sets,
        },
    ],
});

test('suggestNextSet: empty sessions returns none', () => {
    const r = suggestNextSet({ exerciseId: 100, sessions: [], targetReps: 5 });
    assert.equal(r.kind, 'none');
});

test('suggestNextSet: no exercise history returns none', () => {
    const r = suggestNextSet({
        exerciseId: 999,
        sessions: [session('2026-04-01', [{ weight: 100, reps: 5 }])],
        targetReps: 5,
    });
    assert.equal(r.kind, 'none');
});

test('suggestNextSet: hit all reps last time → bump weight', () => {
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [session('2026-04-01', [
            { weight: 100, reps: 5 },
            { weight: 100, reps: 5 },
            { weight: 100, reps: 5 },
        ])],
        targetReps: 5,
        bumpStep: 2.5,
        fraction: 0.05,
    });
    assert.equal(r.kind, 'suggest');
    // 100 * 1.05 = 105 → already a multiple of 2.5; expect 105
    assert.equal(r.weight, 105);
    assert.equal(r.reps, 5);
});

test('suggestNextSet: missed reps on any set → repeat same weight', () => {
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [session('2026-04-01', [
            { weight: 100, reps: 5 },
            { weight: 100, reps: 4 }, // short of target
        ])],
        targetReps: 5,
    });
    assert.equal(r.kind, 'repeat');
    assert.equal(r.weight, 100);
});

test('suggestNextSet: bump rounded to bumpStep', () => {
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [session('2026-04-01', [{ weight: 60, reps: 8 }, { weight: 60, reps: 8 }])],
        targetReps: 8,
        bumpStep: 2.5,
        fraction: 0.05,
    });
    // 60 * 1.05 = 63 → rounded to 2.5 = 62.5; ensure > lastWeight
    assert.equal(r.kind, 'suggest');
    assert.equal(r.weight, 62.5);
});

test('suggestNextSet: bumpStep enforces a minimum increment', () => {
    // Tiny weight where 1.05x wouldn't even reach the next bumpStep.
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [session('2026-04-01', [{ weight: 5, reps: 10 }])],
        targetReps: 10,
        bumpStep: 2.5,
        fraction: 0.05,
    });
    // 5 * 1.05 = 5.25 → rounded to 2.5 = 5 (same as last). Helper bumps
    // by bumpStep so we still progress.
    assert.equal(r.kind, 'suggest');
    assert.equal(r.weight, 7.5);
});

test('suggestNextSet: most-recent session wins when multiple are present', () => {
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [
            session('2026-03-01', [{ weight: 80, reps: 5 }]),
            session('2026-04-01', [{ weight: 100, reps: 5 }]),
        ],
        targetReps: 5,
    });
    // Should base off the 100kg session, not 80kg.
    assert.equal(r.kind, 'suggest');
    assert.ok(r.weight >= 100, `expected weight >= 100, got ${r.weight}`);
});

test('suggestNextSet: ignores sessions without completed reps', () => {
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [
            session('2026-04-01', [{ weight: 0, reps: 0 }]),
        ],
        targetReps: 5,
    });
    assert.equal(r.kind, 'none');
});

test('suggestNextSet: 0 targetReps returns none', () => {
    const r = suggestNextSet({
        exerciseId: 100,
        sessions: [session('2026-04-01', [{ weight: 100, reps: 5 }])],
        targetReps: 0,
    });
    assert.equal(r.kind, 'none');
});
