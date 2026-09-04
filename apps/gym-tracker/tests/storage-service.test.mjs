// StorageService: the localStorage layer everything persists through.
//
// Why these tests matter:
//   - get() must survive un-parseable values: the sync layer can deposit
//     primitives un-stringified (a raw "custom" where our writer would have
//     stored "\"custom\""), and a throw here used to nuke the stored value
//     back to the default;
//   - set()/remove() must report quota/security errors as false instead of
//     throwing mid-workout;
//   - ids arrive as numbers (models) AND strings (dataset attributes,
//     Firestore round-trips). FINDINGS mandates sameId() for every id
//     comparison; the regression tests below pin that behavior for the four
//     methods that used === until the 2026-08-15 fix (audit defect 12).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub installed before the service is imported
// (StorageService only touches localStorage at call time, but keep the order
// obvious). `failNextSet` / `failNextRemove` simulate quota/security errors.
const store = new Map();
const faults = { set: false, remove: false };
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
        if (faults.set) { faults.set = false; throw new DOMException('QuotaExceededError'); }
        store.set(k, String(v));
    },
    removeItem: (k) => {
        if (faults.remove) { faults.remove = false; throw new DOMException('SecurityError'); }
        store.delete(k);
    },
};

const { StorageService } = await import('../js/services/StorageService.js');
const { Program } = await import('../js/models/Program.js');

function freshService() {
    store.clear();
    return new StorageService();
}

// Console noise gate: the service intentionally console.errors on write
// failures; keep test output clean for the fault-injection tests.
const quietly = (fn) => {
    const orig = console.error;
    const origWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try { return fn(); } finally { console.error = orig; console.warn = origWarn; }
};

// ---------------------------------------------------------------------------
// Generic get/set/remove contracts
// ---------------------------------------------------------------------------

test('get: missing key returns the default', () => {
    const svc = freshService();
    assert.equal(svc.get('nope', 'fallback'), 'fallback');
    assert.equal(svc.get('nope'), null, 'default default is null');
});

test('get: un-parseable value is returned as the raw string, not the default', () => {
    const svc = freshService();
    store.set('gymTrackerProgramSort', 'custom'); // sync layer wrote it raw
    assert.equal(svc.get('gymTrackerProgramSort', 'name'), 'custom',
        'raw primitive survives instead of being masked by the default');
});

test('get: valid JSON round-trips typed', () => {
    const svc = freshService();
    svc.set('k', { a: 1, b: [true, null] });
    assert.deepEqual(svc.get('k'), { a: 1, b: [true, null] });
});

test('set: quota error returns false and does not throw', () => {
    const svc = freshService();
    faults.set = true;
    assert.equal(quietly(() => svc.set('k', 1)), false);
    assert.equal(svc.set('k', 2), true, 'next write works again');
});

test('remove: storage error returns false and does not throw', () => {
    const svc = freshService();
    svc.set('k', 1);
    faults.remove = true;
    assert.equal(quietly(() => svc.remove('k')), false);
    assert.equal(svc.remove('k'), true);
});

// ---------------------------------------------------------------------------
// Program CRUD
// ---------------------------------------------------------------------------

test('program CRUD: save, read back, update in place, delete (same-typed ids)', () => {
    const svc = freshService();
    svc.saveProgram({ id: 1, name: 'Push' });
    svc.saveProgram({ id: 2, name: 'Pull' });
    assert.equal(svc.getPrograms().length, 2);
    svc.saveProgram({ id: 1, name: 'Push v2' });
    assert.equal(svc.getPrograms().length, 2, 'update did not append');
    assert.equal(svc.getProgramById(1).name, 'Push v2');
    svc.deleteProgram(2);
    assert.deepEqual(svc.getPrograms().map(p => p.id), [1]);
});

test('getProgramById tolerates string/number id mismatch (sameId)', () => {
    const svc = freshService();
    svc.saveProgram({ id: 17, name: 'Legs' });
    assert.equal(svc.getProgramById('17')?.name, 'Legs');
});

test('getPrograms end-to-end: legacy targetSets/targetReps shape migrates through the storage layer', () => {
    const svc = freshService();
    // A pre-sets[] export as it would sit in localStorage on an old install.
    store.set('gymTrackerPrograms', JSON.stringify([{
        id: 5, name: 'Old Split',
        exercises: [{
            exerciseId: 42, exerciseName: 'Row',
            targetSets: 4, targetReps: 8,
            restSeconds: 120, notes: '', order: 0,
        }],
        createdAt: '', updatedAt: '',
    }]));
    const raw = svc.getPrograms();
    const program = Program.fromJSON(raw[0]);
    assert.equal(program.exercises[0].sets.length, 4, '4 legacy targetSets expand to 4 set rows');
    program.exercises[0].sets.forEach(s => {
        assert.equal(s.repsMin, 8);
        assert.equal(s.repsMax, 8);
    });
    assert.equal(program.exercises[0].targetSets, 4, 'derived getter matches');
    assert.equal(program.exercises[0].restAfterSeconds, 120, 'restAfter migrated from restSeconds');
});

// ---------------------------------------------------------------------------
// Session CRUD (already sameId-hardened; pin it so it stays that way)
// ---------------------------------------------------------------------------

test('saveWorkoutSession updates in place across a string/number id mismatch', () => {
    const svc = freshService();
    svc.saveWorkoutSession({ id: 100, date: '2026-08-01', exercises: [] });
    // Firestore round-trip stringified the id on another device.
    svc.saveWorkoutSession({ id: '100', date: '2026-08-01', exercises: [], edited: true });
    const sessions = svc.getWorkoutSessions();
    assert.equal(sessions.length, 1, 'no duplicate session appended');
    assert.equal(sessions[0].edited, true, 'the update won');
});

test('deleteWorkoutSession and getWorkoutSessionById tolerate id-type mismatches', () => {
    const svc = freshService();
    svc.saveWorkoutSession({ id: 100, date: '2026-08-01', exercises: [] });
    assert.ok(svc.getWorkoutSessionById('100'));
    svc.deleteWorkoutSession('100');
    assert.equal(svc.getWorkoutSessions().length, 0);
});

// ---------------------------------------------------------------------------
// Measurements + custom exercises
// ---------------------------------------------------------------------------

test('measurements: save and read back', () => {
    const svc = freshService();
    svc.saveMeasurements([{ id: 1, metric: 'weight', value: 80 }]);
    assert.deepEqual(svc.getMeasurements(), [{ id: 1, metric: 'weight', value: 80 }]);
});

test('custom exercises: add appends, delete removes (same-typed id)', () => {
    const svc = freshService();
    svc.addCustomExercise({ id: 900001, name: 'Cable Y-Raise' });
    svc.addCustomExercise({ id: 900002, name: 'Sled Drag' });
    assert.equal(svc.getCustomExercises().length, 2);
    svc.deleteCustomExercise(900001);
    assert.deepEqual(svc.getCustomExercises().map(e => e.id), [900002]);
});

// ---------------------------------------------------------------------------
// The sameId regressions (formerly the four === id comparisons).
// FINDINGS ("The sameId rule") documents that strict === on ids is a bug
// pattern. Regression tests for the 2026-08-15 audit defect 12 (resolved):
// saveProgram/deleteProgram/deleteCustomExercise/getWorkoutSessionsByExercise
// used ===, so a stringified id (Firestore round-trip, dataset-sourced)
// duplicated on save, no-opped deletes, and returned empty histories. All
// four now go through sameId().
// ---------------------------------------------------------------------------

test(
    'saveProgram updates in place across a string/number id mismatch',
    () => {
        const svc = freshService();
        svc.saveProgram({ id: 7, name: 'Push' });
        svc.saveProgram({ id: '7', name: 'Push v2' });
        const programs = svc.getPrograms();
        assert.equal(programs.length, 1, 'correct behavior: still one program');
        assert.equal(programs[0].name, 'Push v2', 'correct behavior: the update won');
    }
);

test(
    'deleteProgram deletes across a string/number id mismatch',
    () => {
        const svc = freshService();
        svc.saveProgram({ id: 7, name: 'Push' });
        svc.deleteProgram('7');
        assert.equal(svc.getPrograms().length, 0, 'correct behavior: program deleted');
    }
);

test(
    'deleteCustomExercise deletes across a string/number id mismatch',
    () => {
        const svc = freshService();
        svc.addCustomExercise({ id: 900001, name: 'Cable Y-Raise' });
        svc.deleteCustomExercise('900001');
        assert.equal(svc.getCustomExercises().length, 0, 'correct behavior: exercise deleted');
    }
);

test(
    'getWorkoutSessionsByExercise finds sessions across an exerciseId type mismatch',
    () => {
        const svc = freshService();
        svc.saveWorkoutSession({ id: 1, date: '2026-08-01', exercises: [{ exerciseId: 42, sets: [] }] });
        assert.equal(svc.getWorkoutSessionsByExercise('42').length, 1,
            'correct behavior: the session is found regardless of id type');
    }
);

// ---------------------------------------------------------------------------
// Export / import / migration
// ---------------------------------------------------------------------------

test('exportAllData carries the current schema version and all stores', () => {
    const svc = freshService();
    svc.saveProgram({ id: 1, name: 'Push' });
    svc.saveWorkoutSession({ id: 9, date: '2026-08-01', exercises: [] });
    const out = svc.exportAllData();
    assert.equal(out.version, StorageService.SCHEMA_VERSION);
    assert.equal(out.programs.length, 1);
    assert.equal(out.sessions.length, 1);
    assert.ok(out.exportDate);
});

test('migrateImport upgrades a 1.0 payload: set slots + alert settings', () => {
    const svc = freshService();
    const payload = {
        version: '1.0',
        sessions: [{ id: 1, exercises: [{ exerciseId: 5, sets: [{ weight: 60, reps: 8 }, { weight: 60, reps: 8 }] }] }],
        settings: { weightUnit: 'kg' },
    };
    const out = svc.migrateImport(payload);
    assert.equal(out.version, '2.0');
    assert.deepEqual(out.sessions[0].exercises[0].sets.map(s => s.slot), [0, 1], 'positional slots added');
    assert.equal(out.settings.soundAlerts, true);
    assert.equal(out.settings.vibrationAlerts, true);
});

test('migrateImport passes an unknown future version through with data intact', () => {
    const svc = freshService();
    const out = quietly(() => svc.migrateImport({ version: '99.0', programs: [{ id: 1 }] }));
    assert.equal(out.version, '99.0');
    assert.deepEqual(out.programs, [{ id: 1 }], 'no data loss on unknown versions');
});

test('importAllData writes every present store and round-trips', () => {
    const svc = freshService();
    const result = svc.importAllData({
        version: '2.0',
        programs: [{ id: 1, name: 'Push' }],
        sessions: [{ id: 9, date: '2026-08-01', exercises: [] }],
        settings: { weightUnit: 'lb' },
        customExercises: [{ id: 900001, name: 'Y-Raise' }],
        measurements: [{ id: 3, metric: 'waist', value: 82 }],
    });
    assert.equal(result.ok, true);
    assert.equal(svc.getPrograms()[0].name, 'Push');
    assert.equal(svc.getWorkoutSessions()[0].id, 9);
    assert.equal(svc.getSettings().weightUnit, 'lb');
    assert.equal(svc.getCustomExercises()[0].name, 'Y-Raise');
    assert.equal(svc.getMeasurements()[0].value, 82);
});

test('clearAllData removes every known key', () => {
    const svc = freshService();
    svc.saveProgram({ id: 1, name: 'Push' });
    svc.saveSettings({ weightUnit: 'kg' });
    svc.markOnboardingSeen();
    svc.clearAllData();
    assert.equal(store.size, 0, 'nothing left behind');
});

// ---------------------------------------------------------------------------
// A write that did not land must never be reported as a successful import.
// ---------------------------------------------------------------------------

test('importAllData reports ok:false when a store write fails', () => {
    // `set()` has always returned false on a quota error, and writeStores
    // threw every one of those booleans away, so an import that stored
    // nothing still resolved { ok: true } and the UI toasted "Imported: N
    // workouts". The user believed their backup had been restored.
    const svc = freshService();
    svc.saveWorkoutSessions([{ id: 1, date: '2026-09-01', exercises: [] }]);

    faults.set = true;   // the very next setItem throws (programs, written first)
    const res = svc.importAllData({
        version: '2.0',
        programs: [{ id: 10, name: 'Imported', exercises: [] }],
        sessions: [{ id: 2, date: '2026-09-02', exercises: [] }],
    });

    assert.equal(res.ok, false, 'a failed store write must not report success');
    assert.equal(res.storageFull, true, 'and must say why');
});

test('importAllData still reports ok:true when every write lands', () => {
    // The control: a guard that always failed would pass the test above.
    const svc = freshService();
    const res = svc.importAllData({
        version: '2.0',
        programs: [{ id: 10, name: 'Imported', exercises: [] }],
        sessions: [{ id: 2, date: '2026-09-02', exercises: [] }],
    });
    assert.equal(res.ok, true);
    assert.ok(!res.storageFull);
    assert.equal(svc.getWorkoutSessions().length, 1);
});

// ---------------------------------------------------------------------------
// A program whose `exercises` is not a usable array must not blank the store.
// ---------------------------------------------------------------------------

for (const [label, exercises] of [
    ['an object', { a: 1 }],
    ['a string', 'junk'],
    ['an array holding null', [null]],
]) {
    test(`a program whose exercises is ${label} survives import and construction`, () => {
        // Program's constructor does (data.exercises || []).map(normalizeExercise),
        // so any of these THREW while app.js was loading the programs store.
        // app.js wraps the whole store in _safeLoad, so one bad record made
        // every program disappear behind "Could not load programs, so that
        // section reset to empty" and the next save persisted that empty list.
        const svc = freshService();
        const res = svc.importAllData({
            version: '2.0',
            programs: [{ id: 10, name: 'Hostile', exercises }],
        });

        assert.equal(res.ok, true);
        assert.ok(res.repairs.length > 0, 'the repair must be reported to the user');

        const stored = svc.getPrograms();
        assert.equal(stored.length, 1, 'the program is kept, not dropped');
        assert.doesNotThrow(() => new Program(stored[0]),
            'the stored record must be constructible, or the whole store is lost on load');
        assert.ok(Array.isArray(new Program(stored[0]).exercises));
    });
}

test('a valid program keeps every exercise through import', () => {
    // The control for the three above: the sanitiser must not empty a good list.
    const svc = freshService();
    const res = svc.importAllData({
        version: '2.0',
        programs: [{ id: 11, name: 'Good', exercises: [{ exerciseId: 1, sets: [] }, { exerciseId: 2, sets: [] }] }],
    });
    assert.equal(res.ok, true);
    assert.equal(new Program(svc.getPrograms()[0]).exercises.length, 2);
});
