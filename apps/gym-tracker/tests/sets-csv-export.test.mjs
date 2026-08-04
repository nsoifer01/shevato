// Item 8: per-set CSV export. The flattening rules are what the user's
// spreadsheet sees, so they are asserted on realistic session shapes.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSetsCsv, escapeCsvField, SETS_CSV_HEADER } from '../js/utils/helpers.js';

const session = (overrides = {}) => ({
    date: '2026-04-24',
    workoutDayName: 'Push',
    exercises: [],
    ...overrides,
});

test('buildSetsCsv: header row matches the documented column order', () => {
    const { csv, rowCount } = buildSetsCsv([], 'kg');
    assert.equal(csv, 'date,program,exercise,setNumber,weight,reps,duration,volume,unit');
    assert.equal(csv, SETS_CSV_HEADER.join(','));
    assert.equal(rowCount, 0);
});

test('buildSetsCsv: zero workouts yields header only, so the caller can toast instead of downloading', () => {
    assert.equal(buildSetsCsv(null, 'kg').rowCount, 0);
    assert.equal(buildSetsCsv([session()], 'kg').rowCount, 0);
});

test('buildSetsCsv: one row per COMPLETED set, incomplete sets are skipped', () => {
    const { csv, rowCount } = buildSetsCsv([session({
        exercises: [{
            exerciseName: 'Bench Press',
            sets: [
                { weight: 60, reps: 10, duration: 0, completed: true, slot: 0 },
                { weight: 70, reps: 8, duration: 0, completed: true, slot: 1 },
                { weight: 80, reps: 0, duration: 0, completed: false, slot: 2 },
            ],
        }],
    })], 'kg');

    const lines = csv.split('\r\n');
    assert.equal(rowCount, 2);
    assert.equal(lines.length, 3);
    assert.equal(lines[1], '2026-04-24,Push,Bench Press,1,60,10,,600,kg');
    assert.equal(lines[2], '2026-04-24,Push,Bench Press,2,70,8,,560,kg');
});

test('buildSetsCsv: timed sets report seconds and leave weight/reps empty', () => {
    const { csv } = buildSetsCsv([session({
        workoutDayName: 'Conditioning',
        exercises: [{
            exerciseName: 'Plank',
            sets: [{ weight: 0, reps: 0, duration: 45, completed: true, slot: 0 }],
        }],
    })], 'kg');

    assert.equal(csv.split('\r\n')[1], '2026-04-24,Conditioning,Plank,1,,,45,45,kg');
});

test('buildSetsCsv: setNumber follows the stable slot, falling back to position on legacy sets', () => {
    const { csv } = buildSetsCsv([session({
        exercises: [{
            exerciseName: 'Squat',
            sets: [
                // Legacy set without a slot: numbered by position.
                { weight: 100, reps: 5, completed: true },
                // Slot 3 survived an un-checked set above it in the UI.
                { weight: 110, reps: 3, completed: true, slot: 3 },
            ],
        }],
    })], 'kg');

    const lines = csv.split('\r\n');
    assert.match(lines[1], /,Squat,1,100,5,/);
    assert.match(lines[2], /,Squat,4,110,3,/);
});

test('buildSetsCsv: the session unit wins over the account unit', () => {
    const { csv } = buildSetsCsv([session({
        sessionUnit: 'lb',
        exercises: [{
            exerciseName: 'Deadlift',
            sets: [{ weight: 225, reps: 5, completed: true, slot: 0 }],
        }],
    })], 'kg');

    assert.ok(csv.split('\r\n')[1].endsWith(',lb'));
});

test('buildSetsCsv: fields with commas / quotes are escaped per RFC 4180', () => {
    const { csv } = buildSetsCsv([session({
        workoutDayName: 'Push, Pull',
        exercises: [{
            exerciseName: 'Farmer\'s "Heavy" Carry',
            sets: [{ weight: 40, reps: 12, completed: true, slot: 0 }],
        }],
    })], 'kg');

    assert.equal(
        csv.split('\r\n')[1],
        '2026-04-24,"Push, Pull","Farmer\'s ""Heavy"" Carry",1,40,12,,480,kg'
    );
});

test('escapeCsvField: quotes only when the field needs it', () => {
    assert.equal(escapeCsvField('Bench Press'), 'Bench Press');
    assert.equal(escapeCsvField(12), '12');
    assert.equal(escapeCsvField(''), '');
    assert.equal(escapeCsvField(null), '');
    assert.equal(escapeCsvField(undefined), '');
    assert.equal(escapeCsvField('a,b'), '"a,b"');
    assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
    assert.equal(escapeCsvField('line1\r\nline2'), '"line1\r\nline2"');
});
