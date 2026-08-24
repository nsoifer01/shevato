// Field-level import sanitiser (2026-08-22 audit D8).
//
// validateImportData pins store TYPES only; these tests pin the per-field
// rules that keep a tampered or hand-edited file from becoming live data,
// and that a legitimate legacy export passes through untouched.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImportData, normalizeDateKey, validId } from '../js/utils/import-sanitize.js';

const legacyExport = () => ({
    version: '1.0',
    programs: [{ id: 1717000000001, name: 'Push Pull Legs', exercises: [], createdAt: '2026-05-01T18:30:00.000Z' }],
    sessions: [{
        id: 1717000000003, programId: 1717000000001, workoutDayName: 'Push A', date: '2026-08-12',
        startTime: '2026-08-12T18:30:00.000Z',
        exercises: [{ exerciseId: 'dumbbell-bench-press', sets: [{ weight: 65, reps: 10, completed: true }] }],
        completed: true,
    }],
    settings: { weightUnit: 'lb', theme: 'dark', firstDayOfWeek: 1, barWeight: 45, timeFormat: '24' },
    customExercises: [{ id: 1717000000009, name: 'Gym X Hack Squat', category: 'legs', muscleGroup: 'Quads', equipment: 'machine', isCustom: true }],
    measurements: [{ id: 1717000000010, date: '2026-08-01', weight: 180, createdAt: '2026-08-01T10:00:00.000Z' }],
    activeProgram: 1717000000001,
});

test('a legitimate legacy export passes through byte-identical with no repairs', () => {
    const input = legacyExport();
    const { data, repairs } = sanitizeImportData(input);
    assert.deepEqual(repairs, []);
    assert.deepEqual(data, legacyExport(), 'nothing was rewritten');
    assert.notEqual(data, input, 'the caller keeps its own copy');
});

test('enum settings outside their vocabulary are dropped, not stored', () => {
    const { data, repairs } = sanitizeImportData({
        settings: { weightUnit: 'stone', timeFormat: 13, firstDayOfWeek: 9, plateProfiles: 'junk', restTimerDefault: -5, soundAlerts: 'yes', theme: 'dark' },
    });
    assert.deepEqual(data.settings, { theme: 'dark' });
    assert.ok(repairs.length >= 6, `every dropped key is disclosed: ${repairs.join(' | ')}`);
    assert.ok(repairs.some((r) => r.includes('weightUnit')));
});

test('session dates are normalised and undated sessions are skipped', () => {
    const { data, repairs } = sanitizeImportData({
        sessions: [
            { id: 1, date: '2026-08-22T10:00:00.000Z', exercises: [] },
            { id: 2, date: 'not-a-date', startTime: '2026-08-20T18:00:00.000Z', exercises: [] },
            { id: 3, date: 'not-a-date', exercises: [] },
        ],
    });
    assert.equal(data.sessions.length, 2);
    assert.equal(data.sessions[0].date, '2026-08-22');
    assert.equal(data.sessions[1].date, '2026-08-20', 'falls back to startTime');
    assert.ok(repairs.some((r) => r.includes('no readable date')));
});

test('set numbers are finite, non-negative and physically bounded', () => {
    const { data, repairs } = sanitizeImportData({
        sessions: [{ id: 1, date: '2026-08-22', exercises: [{ sets: [
            { weight: 'NaN', reps: 1e308, duration: -3 },
            { weight: -5, reps: 8.6, duration: Infinity },
            { weight: 60, reps: 8 },
        ] }] }],
    });
    const sets = data.sessions[0].exercises[0].sets;
    assert.deepEqual(sets[0], { weight: 0, reps: 1000, duration: 0 }, 'NaN -> 0, 1e308 capped, negative -> 0');
    assert.deepEqual(sets[1], { weight: 0, reps: 9, duration: 0 });
    assert.deepEqual(sets[2], { weight: 60, reps: 8 }, 'fields the set never carried are not invented');
    assert.ok(repairs.some((r) => r.includes('2 set(s)')));
});

test('ids: missing and prototype-key ids are replaced, valid ones kept', () => {
    assert.equal(validId('__proto__'), false);
    assert.equal(validId('constructor'), false);
    assert.equal(validId(''), false);
    assert.equal(validId('abc-1'), true);
    assert.equal(validId(42), true);
    const { data, repairs } = sanitizeImportData({
        customExercises: [{ id: '__proto__', name: 'Evil' }, { name: 'No id' }, { id: 7, name: 'Fine' }, { id: 8 }],
        programs: [{ id: 'constructor', name: 'P' }],
    });
    assert.ok(data.customExercises.every((e) => validId(e.id)));
    assert.equal(data.customExercises[2].id, 7, 'a valid id survives');
    assert.equal(data.customExercises.length, 3, 'the nameless custom exercise is skipped');
    assert.ok(validId(data.programs[0].id) && data.programs[0].id !== 'constructor');
    assert.ok(repairs.some((r) => r.includes('custom exercise')));
    assert.equal(Object.prototype.polluted, undefined);
});

test('normalizeDateKey: YYYY-MM-DD kept, impossible calendar dates rejected, timestamps converted', () => {
    assert.equal(normalizeDateKey('2026-08-22'), '2026-08-22');
    assert.equal(normalizeDateKey('2026-02-29'), null);
    assert.equal(normalizeDateKey('2024-02-29'), '2024-02-29');
    assert.equal(normalizeDateKey('2026-08-22T23:30:00.000Z'), '2026-08-22', 'UTC process: same day');
    assert.equal(normalizeDateKey(''), null);
    assert.equal(normalizeDateKey(12345), null);
});

test('StorageService.importAllData runs the sanitiser before writing (merge and replace)', async () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    const { StorageService } = await import('../js/services/StorageService.js');
    const svc = new StorageService();
    for (const mode of ['merge', 'replace']) {
        store.clear();
        const result = svc.importAllData({ settings: { weightUnit: 'stone', theme: 'dark' }, sessions: [{ id: 1, date: 'nope', exercises: [] }] }, { mode });
        assert.equal(result.ok, true);
        assert.ok(result.repairs.length >= 2, `${mode}: repairs disclosed`);
        assert.equal(JSON.parse(store.get('gymTrackerSettings')).weightUnit, undefined, `${mode}: stone never reaches storage`);
        assert.deepEqual(JSON.parse(store.get('gymTrackerSessions')), [], `${mode}: the undated session never reaches storage`);
    }
});
