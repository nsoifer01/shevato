// Tests for the import-version migration path. The full StorageService
// expects a localStorage global; we exercise the static migrateImport
// path by calling through a stub instance.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageService } from '../js/services/StorageService.js';

// Minimal in-memory localStorage shim so the StorageService constructor
// runs without a browser. Only used for the migrator tests — these don't
// touch storage.
globalThis.localStorage = {
    _store: new Map(),
    getItem(key) { return this._store.has(key) ? this._store.get(key) : null; },
    setItem(key, value) { this._store.set(key, String(value)); },
    removeItem(key) { this._store.delete(key); },
    clear() { this._store.clear(); },
};

const svc = new StorageService();

test('migrateImport: passes through current-version payloads unchanged', () => {
    const data = { version: StorageService.SCHEMA_VERSION, sessions: [], settings: {} };
    const out = svc.migrateImport(data);
    assert.equal(out.version, StorageService.SCHEMA_VERSION);
});

test('migrateImport: 1.0 → 2.0 backfills set.slot positionally', () => {
    const data = {
        version: '1.0',
        sessions: [
            {
                id: 1,
                exercises: [
                    { sets: [{ weight: 50, reps: 5 }, { weight: 60, reps: 5 }] },
                    { sets: [{ duration: 30, slot: 0 }, { duration: 45 }] },
                ],
            },
        ],
        settings: { weightUnit: 'kg' },
    };
    const out = svc.migrateImport(data);
    assert.equal(out.version, StorageService.SCHEMA_VERSION);
    assert.equal(out.sessions[0].exercises[0].sets[0].slot, 0);
    assert.equal(out.sessions[0].exercises[0].sets[1].slot, 1);
    // Existing slot is preserved, missing slot is filled.
    assert.equal(out.sessions[0].exercises[1].sets[0].slot, 0);
    assert.equal(out.sessions[0].exercises[1].sets[1].slot, 1);
});

test('migrateImport: 1.0 → 2.0 fills missing soundAlerts/vibrationAlerts defaults', () => {
    const data = { version: '1.0', settings: { weightUnit: 'kg' } };
    const out = svc.migrateImport(data);
    assert.equal(out.settings.soundAlerts, true);
    assert.equal(out.settings.vibrationAlerts, true);
});

test('migrateImport: explicit false soundAlerts/vibrationAlerts is preserved', () => {
    const data = {
        version: '1.0',
        settings: { soundAlerts: false, vibrationAlerts: false },
    };
    const out = svc.migrateImport(data);
    assert.equal(out.settings.soundAlerts, false);
    assert.equal(out.settings.vibrationAlerts, false);
});

test('migrateImport: payload with no version assumed 1.0 and migrated', () => {
    const data = { sessions: [{ exercises: [{ sets: [{ weight: 1, reps: 1 }] }] }] };
    const out = svc.migrateImport(data);
    assert.equal(out.version, StorageService.SCHEMA_VERSION);
    assert.equal(out.sessions[0].exercises[0].sets[0].slot, 0);
});

test('migrateImport: future version with no migrator passes through', () => {
    const data = { version: '99.0', sessions: [], futureField: 'hi' };
    const out = svc.migrateImport(data);
    assert.equal(out.version, '99.0');
    assert.equal(out.futureField, 'hi');
});
