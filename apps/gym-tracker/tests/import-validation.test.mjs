// Import validation: the gate between a user-picked JSON file and the store.
//
// validateImportData is module-private in js/views/settings-view.js (the view
// class is DOM-bound), so it is extracted from source text and run directly.
//
// Why it matters: importAllData writes whatever passes validation straight
// into localStorage (`if (data.programs) this.savePrograms(data.programs)`),
// so a shape the validator waves through becomes the live store. The KNOWN
// DEFECT todo below pins the correct behavior for the worst case: a payload
// whose "programs" key holds a string.
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
// KNOWN DEFECT: key presence is checked, value types are not
// ---------------------------------------------------------------------------

test(
    'rejects a payload whose store keys hold non-array/non-object junk',
    {
        todo: 'KNOWN DEFECT: validateImportData (settings-view.js ~52) only '
            + 'checks hasOwnProperty, never types, so {"programs":"pwned"} '
            + 'passes validation and importAllData (StorageService.js ~319-334) '
            + 'then overwrites gymTrackerPrograms with the string "pwned" - the '
            + 'program list is destroyed until a re-import/sync repair. The '
            + 'validator should require programs/sessions/customExercises/'
            + 'measurements to be arrays and settings to be an object.',
    },
    () => {
        assert.notEqual(validateImportData({ programs: 'pwned' }), null,
            'correct behavior: a string "programs" store is rejected');
        assert.notEqual(validateImportData({ sessions: 17 }), null,
            'correct behavior: a numeric "sessions" store is rejected');
    }
);

// ---------------------------------------------------------------------------
// migrateImport purity contract
// ---------------------------------------------------------------------------

test(
    'migrateImport does not mutate the caller\'s payload',
    {
        todo: 'KNOWN DEFECT (contract drift): the migrateImport docstring '
            + '(StorageService.js ~264-271) says each migrator is "a pure '
            + 'function (data) => upgradedData", but the 1.0 migrator writes '
            + 'slots, settings flags and the version field into the caller\'s '
            + 'own objects in place. Harmless on today\'s only call path (a '
            + 'just-parsed JSON.parse result), but any future caller holding '
            + 'onto the payload gets it silently rewritten. Either clone '
            + 'inside migrateImport or fix the docstring.',
    },
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
