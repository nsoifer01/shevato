// Import validation: the gate between a user-picked JSON file and the store.
//
// validateImportData is module-private in js/views/settings-view.js (the view
// class is DOM-bound), so it is extracted from source text and run directly.
//
// Why it matters: importAllData writes whatever passes validation straight
// into localStorage (`if (data.programs) this.savePrograms(data.programs)`),
// so a shape the validator waves through becomes the live store. The typed
// store checks below are the regression for the worst case (a payload whose
// "programs" key holds a string; audit defect 13, fixed 2026-08-15).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, buildFunctions } from './helpers/source-extract.mjs';

const src = loadSource('js/views/settings-view.js');
const { validateImportData } = buildFunctions(src, ['validateImportData'], {}, 'settings-view.js');

// ---------------------------------------------------------------------------
// What the validator gets right today
// ---------------------------------------------------------------------------

test('rejects null / undefined payloads', () => {
    assert.equal(validateImportData(null), 'No data provided');
    assert.equal(validateImportData(undefined), 'No data provided');
});

test('rejects non-object payloads', () => {
    assert.equal(validateImportData('a string'), 'Invalid data format');
    assert.equal(validateImportData(42), 'Invalid data format');
});

test('rejects objects with none of the known store keys', () => {
    assert.equal(validateImportData({}), 'Invalid data structure');
    assert.equal(validateImportData({ foo: 1 }), 'Invalid data structure');
    assert.equal(validateImportData([1, 2, 3]), 'Invalid data structure',
        'an array has no programs/sessions/settings keys');
});

test('accepts a real export shape (returns null = no error)', () => {
    assert.equal(validateImportData({ programs: [], sessions: [], settings: {} }), null);
    assert.equal(validateImportData({ sessions: [] }), null, 'any one known key suffices');
});

// ---------------------------------------------------------------------------
// Store-value types (regression for the 2026-08-15 audit defect 13,
// resolved: the validator used to check key presence only, so
// {"programs":"pwned"} passed and importAllData overwrote the program store
// with a string. Every present store must now carry its expected shape.)
// ---------------------------------------------------------------------------

test(
    'rejects a payload whose store keys hold non-array/non-object junk',
    () => {
        assert.notEqual(validateImportData({ programs: 'pwned' }), null,
            'a string "programs" store is rejected');
        assert.notEqual(validateImportData({ sessions: 17 }), null,
            'a numeric "sessions" store is rejected');
        assert.notEqual(validateImportData({ sessions: [], settings: [] }), null,
            'an array "settings" store is rejected');
        assert.notEqual(validateImportData({ programs: [], measurements: {} }), null,
            'a non-array "measurements" store is rejected');
        assert.equal(validateImportData({ programs: [], sessions: [], settings: {} }), null,
            'well-typed stores still pass');
    }
);

// ---------------------------------------------------------------------------
// migrateImport purity contract
// ---------------------------------------------------------------------------

// Regression for the 2026-08-15 audit defect 14 (resolved): migrateImport
// now clones its input before running the in-place migrators, so the
// docstring's pure `(data) => upgradedData` contract actually holds.
test(
    'migrateImport does not mutate the caller\'s payload',
    async () => {
        const { StorageService } = await import('../js/services/StorageService.js');
        const svc = new StorageService();
        const payload = {
            version: '1.0',
            sessions: [{ id: 1, exercises: [{ exerciseId: 5, sets: [{ weight: 60, reps: 8 }] }] }],
            settings: { weightUnit: 'kg' },
        };
        const snapshot = structuredClone(payload);
        svc.migrateImport(payload);
        assert.deepEqual(payload, snapshot, 'correct-per-docstring behavior: input untouched');
    }
);
