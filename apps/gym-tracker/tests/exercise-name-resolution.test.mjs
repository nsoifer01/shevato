// Catalog renames vs stored name snapshots.
//
// Programs and sessions store an `exerciseName` snapshot taken when the row
// was created; the catalog can rename the exercise later under the same id
// (e.g. Seated Dumbbell Press -> Dumbbell Shoulder Press, 2026-08). History
// is never rewritten - instead, every display surface resolves the name
// through the catalog by stable id, with the snapshot as fallback. These
// tests cover the pure seam of that rule: the CSV export's resolver hook.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSetsCsv } from '../js/utils/helpers.js';

const CATALOG = new Map([
    [173, 'Dumbbell Shoulder Press'],
    [514, 'Hip Thrust Machine'],
]);
const resolve = (id, fallback) => CATALOG.get(id) || fallback || 'Unknown Exercise';

const oldSession = {
    date: '2026-07-05',
    workoutDayName: 'Shoulders',
    exercises: [{
        exerciseId: 173,
        exerciseName: 'Seated Dumbbell Press', // pre-rename snapshot
        sets: [{ weight: 22.5, reps: 10, completed: true, slot: 0 }],
    }],
};

test('resolver maps a pre-rename snapshot to the current catalog name', () => {
    const { csv } = buildSetsCsv([oldSession], 'kg', resolve);
    assert.ok(csv.includes('Dumbbell Shoulder Press'),
        'renamed exercise must export under its current name');
    assert.ok(!csv.includes('Seated Dumbbell Press'),
        'the stale snapshot must not leak into the export');
});

test('resolver falls back to the snapshot for ids not in the catalog', () => {
    const custom = {
        ...oldSession,
        exercises: [{
            exerciseId: 999999999,
            exerciseName: 'My Custom Movement',
            sets: [{ weight: 10, reps: 5, completed: true, slot: 0 }],
        }],
    };
    const { csv } = buildSetsCsv([custom], 'kg', resolve);
    assert.ok(csv.includes('My Custom Movement'));
});

test('without a resolver the snapshot is exported unchanged (back-compat)', () => {
    const { csv } = buildSetsCsv([oldSession], 'kg');
    assert.ok(csv.includes('Seated Dumbbell Press'));
});

test('historical set data is untouched by name resolution', () => {
    const { csv, rowCount } = buildSetsCsv([oldSession], 'kg', resolve);
    assert.equal(rowCount, 1);
    const row = csv.split('\r\n')[1].split(',');
    assert.equal(row[0], '2026-07-05'); // date preserved
    assert.equal(row[4], '22.5');       // weight preserved
    assert.equal(row[5], '10');         // reps preserved
    assert.equal(row[7], '225');        // volume preserved
});
