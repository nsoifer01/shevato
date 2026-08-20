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

// GT-04: a timed set has seconds, not kilograms. Writing the duration into
// the `volume` column under `unit=kg` shipped "60 kg" for a one-minute plank
// straight into the user's spreadsheet, and the column sum matched the app's
// (equally wrong) all-time figure, so the error was systemic rather than
// display-only.
test('buildSetsCsv: timed sets report seconds and leave weight/reps/volume empty', () => {
    const { csv } = buildSetsCsv([session({
        workoutDayName: 'Conditioning',
        exercises: [{
            exerciseName: 'Plank',
            sets: [{ weight: 0, reps: 0, duration: 45, completed: true, slot: 0 }],
        }],
    })], 'kg');

    assert.equal(csv.split('\r\n')[1], '2026-04-24,Conditioning,Plank,1,,,45,,kg');
});

test('buildSetsCsv: the volume column sums only real weight volume', () => {
    const { csv } = buildSetsCsv([session({
        exercises: [
            { exerciseName: 'Bench', sets: [{ weight: 60, reps: 10, completed: true, slot: 0 }] },
            { exerciseName: 'Plank', sets: [{ duration: 60, completed: true, slot: 0 }] },
        ],
    })], 'kg');
    const total = csv.split('\r\n').slice(1)
        .map(line => Number(line.split(',')[7] || 0))
        .reduce((a, b) => a + b, 0);
    assert.equal(total, 600, 'the plank adds nothing to the kilogram column');
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

// GT-03: stored weights are canonical kilograms, so the export converts once
// into ONE unit and stamps it on every row. Reading each session's own
// `sessionUnit` produced a file that silently mixed units between rows, and
// exporting in the wrong mode shipped numbers that were out by 2.2x.
test('buildSetsCsv: every row carries the requested display unit', () => {
    const { csv } = buildSetsCsv([session({
        sessionUnit: 'lb',
        exercises: [{
            exerciseName: 'Deadlift',
            sets: [{ weight: 100, reps: 5, completed: true, slot: 0 }],
        }],
    })], 'kg');

    assert.ok(csv.split('\r\n')[1].endsWith(',kg'), 'the export unit, not the session unit');
});

test('buildSetsCsv: canonical kg converts into the export unit', () => {
    const { csv } = buildSetsCsv([session({
        exercises: [{
            exerciseName: 'Deadlift',
            sets: [{ weight: 100, reps: 5, completed: true, slot: 0 }],
        }],
    })], 'lb');

    const cols = csv.split('\r\n')[1].split(',');
    assert.ok(Math.abs(Number(cols[4]) - 220.46) < 0.01, `weight in lb, got ${cols[4]}`);
    assert.ok(Math.abs(Number(cols[7]) - 1102.31) < 0.02, `volume in lb, got ${cols[7]}`);
    assert.equal(cols[8], 'lb');
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
