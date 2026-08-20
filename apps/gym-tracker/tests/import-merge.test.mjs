// Import semantics (GT-02).
//
// The dialog said the file "will be merged with your existing programs,
// workouts, and settings"; `importAllData` did `if (data.programs)
// this.savePrograms(data.programs)` for each store - a wholesale overwrite.
// Importing a file that contained ONLY sessions therefore deleted the user's
// program and all 17 unlocked achievements, with no undo and no backup.
//
// Merge and replace are now separate, explicitly chosen operations. These
// tests pin the merge rules (identity, collisions, and the empty-array case
// that did the damage) and that replace only touches stores the file carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IMPORT_MODES,
    mergeById,
    mergeImportedData,
    mergeSettings,
    pickAchievement,
    summarizeMerge,
} from '../js/utils/import-merge.js';
import { StorageService } from '../js/services/StorageService.js';

// ---------------------------------------------------------------------------
// The reproduction from the audit
// ---------------------------------------------------------------------------

test('merge: a sessions-only file never deletes the existing program', () => {
    // The exact shape that wiped the QA run: `programs: []` plus 10 sessions.
    const current = {
        programs: [{ id: 1, name: 'Push Day A', updatedAt: '2026-08-01T00:00:00Z' }],
        sessions: [{ id: 10, timestamp: '2026-08-01T00:00:00Z' }, { id: 11, timestamp: '2026-08-02T00:00:00Z' }],
        achievements: Array.from({ length: 17 }, (_, i) => ({ id: `a${i}`, unlocked: true })),
        customExercises: [],
        measurements: [],
        settings: { weightUnit: 'kg' },
    };
    const incoming = {
        programs: [],
        sessions: Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, timestamp: '2026-07-01T00:00:00Z' })),
    };

    const after = mergeImportedData(current, incoming);
    assert.equal(after.programs.length, 1, 'the program survives');
    assert.equal(after.programs[0].name, 'Push Day A');
    assert.equal(after.sessions.length, 12, 'both real sessions kept, ten added');
    assert.equal(after.achievements.filter(a => a.unlocked).length, 17, 'unlocks survive');
});

test('merge: an empty imported array is "nothing to add", never "delete everything"', () => {
    const current = { programs: [{ id: 1 }], sessions: [{ id: 2 }], measurements: [{ id: 3 }] };
    const after = mergeImportedData(current, { programs: [], sessions: [], measurements: [] });
    assert.equal(after.programs.length, 1);
    assert.equal(after.sessions.length, 1);
    assert.equal(after.measurements.length, 1);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('merge: identity is sameId, so "123" and 123 are ONE record', () => {
    const after = mergeImportedData(
        { programs: [{ id: 123, name: 'Mine', updatedAt: '2026-08-01T00:00:00Z' }] },
        { programs: [{ id: '123', name: 'Theirs', updatedAt: '2026-08-02T00:00:00Z' }] },
    );
    assert.equal(after.programs.length, 1, 'not two copies of the same program');
    assert.equal(after.programs[0].name, 'Theirs', 'the newer one won');
});

test('mergeById: a record with no id at all can only be an addition', () => {
    const out = mergeById([{ id: 1 }], [{ name: 'no id' }], (a) => a);
    assert.equal(out.length, 2);
});

test('mergeById: existing records keep their position; new ones append', () => {
    const out = mergeById(
        [{ id: 1 }, { id: 2 }],
        [{ id: 2, tag: 'updated' }, { id: 3 }],
        (_existing, incoming) => incoming,
    );
    assert.deepEqual(out.map(r => r.id), [1, 2, 3]);
    assert.equal(out[1].tag, 'updated');
});

// ---------------------------------------------------------------------------
// Collision rules - deterministic, never arbitrary
// ---------------------------------------------------------------------------

test('merge: the newer program wins on updatedAt, either direction', () => {
    const newer = { id: 1, name: 'New', updatedAt: '2026-08-05T00:00:00Z' };
    const older = { id: 1, name: 'Old', updatedAt: '2026-08-01T00:00:00Z' };
    assert.equal(mergeImportedData({ programs: [older] }, { programs: [newer] }).programs[0].name, 'New');
    assert.equal(mergeImportedData({ programs: [newer] }, { programs: [older] }).programs[0].name, 'New');
});

test('merge: with no timestamps at all, the imported record wins deterministically', () => {
    const after = mergeImportedData({ programs: [{ id: 1, name: 'Mine' }] }, { programs: [{ id: 1, name: 'Theirs' }] });
    assert.equal(after.programs[0].name, 'Theirs');
});

test('merge: sessions collide on timestamp', () => {
    const after = mergeImportedData(
        { sessions: [{ id: 7, timestamp: '2026-08-09T00:00:00Z', note: 'mine' }] },
        { sessions: [{ id: 7, timestamp: '2026-08-01T00:00:00Z', note: 'theirs' }] },
    );
    assert.equal(after.sessions[0].note, 'mine', 'the newer record stands');
});

test('an unlock is a fact: an import can add one but never take one away', () => {
    assert.equal(pickAchievement({ id: 'a', unlocked: true }, { id: 'a', unlocked: false }).unlocked, true);
    assert.equal(pickAchievement({ id: 'a', unlocked: false }, { id: 'a', unlocked: true }).unlocked, true);
});

test('two locked achievements resolve on the higher progress', () => {
    const out = pickAchievement({ id: 'a', unlocked: false, progress: 8 }, { id: 'a', unlocked: false, progress: 3 });
    assert.equal(out.progress, 8);
});

test('settings merge key by key: absent keys keep their current value', () => {
    const out = mergeSettings(
        { weightUnit: 'kg', timerCountdownSeconds: 7, plateProfiles: { kg: { plates: [25] } } },
        { weightUnit: 'lb' },
    );
    assert.equal(out.weightUnit, 'lb', 'the file wins where it speaks');
    assert.equal(out.timerCountdownSeconds, 7, 'and is silent elsewhere');
    assert.deepEqual(out.plateProfiles.kg.plates, [25]);
});

test('settings merge ignores junk instead of replacing the object with it', () => {
    const current = { weightUnit: 'kg' };
    assert.deepEqual(mergeSettings(current, null), current);
    assert.deepEqual(mergeSettings(current, ['nope']), current);
});

test('merge: the active-program pointer only survives if that program does', () => {
    const gone = mergeImportedData({ programs: [], activeProgram: 99 }, { programs: [{ id: 1 }] });
    assert.equal(gone.activeProgram, null);
    const kept = mergeImportedData({ programs: [{ id: 5 }], activeProgram: 5 }, { programs: [{ id: 6 }] });
    assert.equal(kept.activeProgram, 5);
});

test('summarizeMerge reports what actually arrived', () => {
    const before = { programs: [], sessions: [], customExercises: [], measurements: [] };
    const after = { programs: [{}], sessions: [{}, {}], customExercises: [], measurements: [] };
    assert.equal(summarizeMerge(before, after), 'Imported: 1 program and 2 workouts');
    assert.match(summarizeMerge(before, before), /nothing new/);
});

// ---------------------------------------------------------------------------
// Through StorageService, both modes
// ---------------------------------------------------------------------------

function freshService() {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    return new StorageService();
}

test('importAllData defaults to MERGE - the operation the dialog always promised', () => {
    const svc = freshService();
    svc.savePrograms([{ id: 1, name: 'Push Day A' }]);
    svc.saveAchievements([{ id: 'x', unlocked: true }]);

    const result = svc.importAllData({ version: '2.0', sessions: [{ id: 9, date: '2026-08-01', exercises: [] }] });
    assert.equal(result.ok, true);
    assert.equal(result.mode, IMPORT_MODES.MERGE);
    assert.equal(svc.getPrograms().length, 1, 'the program is still there');
    assert.equal(svc.getAchievements()[0].unlocked, true);
    assert.equal(svc.getWorkoutSessions().length, 1);
});

test('importAllData in REPLACE mode does replace - that is what it is for', () => {
    const svc = freshService();
    svc.savePrograms([{ id: 1, name: 'Push Day A' }]);
    svc.saveWorkoutSessions([{ id: 8 }, { id: 9 }]);

    const result = svc.importAllData(
        { version: '2.0', programs: [{ id: 2, name: 'Restored' }], sessions: [] },
        { mode: IMPORT_MODES.REPLACE },
    );
    assert.equal(result.mode, IMPORT_MODES.REPLACE);
    assert.deepEqual(svc.getPrograms().map(p => p.name), ['Restored']);
    assert.deepEqual(svc.getWorkoutSessions(), [], 'an explicit empty array in replace mode does clear');
});

test('REPLACE still only touches stores the file actually carries', () => {
    // A "programs only" backup must not erase a history it says nothing about.
    const svc = freshService();
    svc.saveWorkoutSessions([{ id: 8 }]);
    svc.importAllData({ version: '2.0', programs: [{ id: 2 }] }, { mode: IMPORT_MODES.REPLACE });
    assert.equal(svc.getWorkoutSessions().length, 1);
});

test('importAllData reports before/after so the caller can say what changed', () => {
    const svc = freshService();
    svc.savePrograms([{ id: 1 }]);
    const result = svc.importAllData({ version: '2.0', programs: [{ id: 2 }] });
    assert.equal(result.before.programs.length, 1);
    assert.equal(result.after.programs.length, 2);
});

test('a malformed payload fails safely and leaves the stores alone', () => {
    const svc = freshService();
    svc.savePrograms([{ id: 1, name: 'Push Day A' }]);
    const result = svc.importAllData(null);
    assert.equal(result.ok, false);
    assert.equal(svc.getPrograms()[0].name, 'Push Day A');
});
