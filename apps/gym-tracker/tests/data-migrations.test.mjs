// Stored-data migrations (GT-03 units, GT-14 empty-session cleanup).
//
// This is the only code allowed to rewrite numbers a user already logged, so
// the properties that matter are: a kg account is a strict no-op, an lb
// account keeps reading exactly the numbers it read before, and running the
// migration twice changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DATA_SCHEMA_VERSION,
    LENGTH_FIELDS,
    migrateMeasurementGoals,
    migrateStoredData,
} from '../js/utils/data-migrations.js';
import { displayLength, displayWeight } from '../js/utils/units.js';

const session = (over = {}) => ({
    id: 1,
    date: '2026-08-01',
    timestamp: '2026-08-01T18:00:00.000Z',
    exercises: [{
        exerciseId: 3,
        exerciseName: 'Barbell Bench Press',
        sets: [{ weight: 135, reps: 5, completed: true, slot: 0 }],
    }],
    ...over,
});

// ---------------------------------------------------------------------------
// A kg account must not be touched at all
// ---------------------------------------------------------------------------

test('a kg account is a pure no-op on every number', () => {
    const before = {
        settings: { weightUnit: 'kg' },
        sessions: [session({ exercises: [{ sets: [{ weight: 60, reps: 10, completed: true }] }] })],
        measurements: [{ id: 9, weight: 81.5, waist: 86.5, bodyFat: 18 }],
    };
    const after = migrateStoredData(before, 0);
    assert.equal(after.sessions[0].exercises[0].sets[0].weight, 60);
    assert.equal(after.measurements[0].weight, 81.5);
    assert.equal(after.measurements[0].waist, 86.5);
    assert.equal(after.measurements[0].bodyFat, 18, 'a percentage has no unit to convert');
});

// ---------------------------------------------------------------------------
// An lb account keeps reading what it read before
// ---------------------------------------------------------------------------

test('an lb account converts once and still displays the same pounds', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'lb' },
        sessions: [session()],
        measurements: [{ id: 9, weight: 180, waist: 34 }],
    }, 0);

    const kg = after.sessions[0].exercises[0].sets[0].weight;
    assert.notEqual(kg, 135, 'the stored number moved to canonical kilograms');
    assert.equal(displayWeight(kg, 'lb'), 135, 'and the screen still says 135 lb');
    assert.equal(displayWeight(after.measurements[0].weight, 'lb'), 180);
    assert.equal(displayLength(after.measurements[0].waist, 'in'), 34);
});

test('an lb account stamps the session with the unit it was entered in', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'lb' }, sessions: [session()], measurements: [],
    }, 0);
    assert.equal(after.sessions[0].sessionUnit, 'lb');
});

test('a session that already recorded its entry unit keeps it', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'kg' },
        sessions: [session({ sessionUnit: 'lb' })],
        measurements: [],
    }, 0);
    assert.equal(after.sessions[0].sessionUnit, 'lb');
});

test('sticky planned-row values on a paused workout convert too', () => {
    // A workout paused mid-set holds the user's typed numbers in stickyValues;
    // leaving them behind would resume the session with pounds labelled kilos.
    const after = migrateStoredData({
        settings: { weightUnit: 'lb' },
        sessions: [],
        measurements: [],
        activeWorkout: {
            id: 5,
            exercises: [{ exerciseId: 3, sets: [], stickyValues: { 0: { weight: 135, reps: 5, duration: 0 } } }],
        },
    }, 0);
    const sticky = after.activeWorkout.exercises[0].stickyValues[0];
    assert.equal(displayWeight(sticky.weight, 'lb'), 135);
    assert.equal(sticky.reps, 5, 'reps are not a weight');
});

test('every circumference field is migrated, not just the ones a test remembers', () => {
    const measurement = { id: 1 };
    LENGTH_FIELDS.forEach((f) => { measurement[f] = 10; });
    const after = migrateStoredData({
        settings: { weightUnit: 'lb' }, sessions: [], measurements: [measurement],
    }, 0);
    LENGTH_FIELDS.forEach((f) => {
        assert.equal(displayLength(after.measurements[0][f], 'in'), 10, `${f} did not migrate`);
    });
});

test('measurement goals migrate with the measurements they are compared against', () => {
    const goals = migrateMeasurementGoals({
        weight: { target: 175, direction: 'decrease' },
        waist: { target: 32, direction: 'decrease' },
        bodyFat: { target: 15, direction: 'decrease' },
    }, 'lb');
    assert.equal(displayWeight(goals.weight.target, 'lb'), 175);
    assert.equal(displayLength(goals.waist.target, 'in'), 32);
    assert.equal(goals.bodyFat.target, 15, 'a percentage is left alone');
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test('running the migration twice changes nothing', () => {
    const first = migrateStoredData({
        settings: { weightUnit: 'lb' }, sessions: [session()], measurements: [{ id: 1, weight: 180 }],
    }, 0);
    assert.equal(first.changed, true);
    assert.equal(first.version, DATA_SCHEMA_VERSION);

    const second = migrateStoredData({
        settings: { weightUnit: 'lb' }, sessions: first.sessions, measurements: first.measurements,
    }, first.version);
    assert.equal(second.changed, false, 'no second pass');
    assert.deepEqual(second.sessions, first.sessions);
    assert.deepEqual(second.measurements, first.measurements);
});

test('the migration does not mutate its input', () => {
    const input = {
        settings: { weightUnit: 'lb' }, sessions: [session()], measurements: [],
    };
    migrateStoredData(input, 0);
    assert.equal(input.sessions[0].exercises[0].sets[0].weight, 135, 'caller\'s data untouched');
});

// ---------------------------------------------------------------------------
// GT-14: a session with nothing logged is not a workout
// ---------------------------------------------------------------------------

test('v2 drops sessions left with zero completed sets', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'kg' },
        sessions: [
            session({ id: 1 }),
            // What "Remove logged history" used to leave behind: 0 kg, 0 sets,
            // still counted in the weekly tile, the streak and the calendar.
            { id: 2, date: '2026-08-02', exercises: Array.from({ length: 8 }, () => ({ sets: [] })) },
        ],
        measurements: [],
    }, 1);
    assert.deepEqual(after.sessions.map(s => s.id), [1]);
});

test('v2 keeps a session that still has one completed set', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'kg' },
        sessions: [{
            id: 3,
            date: '2026-08-02',
            exercises: [
                { sets: [] },
                { sets: [{ weight: 40, reps: 10, completed: true }] },
            ],
        }],
        measurements: [],
    }, 1);
    assert.equal(after.sessions.length, 1);
});

test('v2 does not treat an UNcompleted set as logged work', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'kg' },
        sessions: [{ id: 4, date: '2026-08-02', exercises: [{ sets: [{ weight: 40, reps: 10, completed: false }] }] }],
        measurements: [],
    }, 1);
    assert.deepEqual(after.sessions, []);
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('an empty install migrates cleanly and just records the version', () => {
    const after = migrateStoredData({}, 0);
    assert.deepEqual(after.sessions, []);
    assert.deepEqual(after.measurements, []);
    assert.equal(after.version, DATA_SCHEMA_VERSION);
});

test('malformed records are passed through rather than crashing the boot', () => {
    const after = migrateStoredData({
        settings: { weightUnit: 'lb' },
        sessions: [{ id: 1, date: '2026-08-01', exercises: null }],
        measurements: [null, { id: 2, weight: null, waist: '' }],
    }, 0);
    assert.equal(Array.isArray(after.sessions), true);
    assert.equal(after.measurements[1].weight, null);
    assert.equal(after.measurements[1].waist, '');
});
