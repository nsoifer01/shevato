// Tests for Feature 4: persistent per-exercise strength-PR achievements
// (AchievementService.checkExercisePRs) and the Achievement.isRenderable
// guard that keeps malformed/legacy PR records from rendering.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage shim so the StorageService singleton (imported
// transitively by AchievementService) runs without a browser.
globalThis.localStorage = {
    _store: new Map(),
    getItem(key) { return this._store.has(key) ? this._store.get(key) : null; },
    setItem(key, value) { this._store.set(key, String(value)); },
    removeItem(key) { this._store.delete(key); },
    clear() { this._store.clear(); },
};

const { AchievementService } = await import('../js/services/AchievementService.js');
const { storageService } = await import('../js/services/StorageService.js');
const { Achievement } = await import('../js/models/Achievement.js');

const reset = (weightUnit = 'kg') => {
    localStorage.clear();
    storageService.saveSettings({ weightUnit });
};

const session = (id, date, weight, opts = {}) => ({
    id,
    date,
    exercises: [{
        exerciseId: opts.exerciseId || 'incline-bb-bench',
        exerciseName: opts.exerciseName || 'Incline Barbell Bench Press',
        sets: [{ completed: true, weight, reps: 8, duration: opts.duration || 0 }],
    }],
});

test('checkExercisePRs: awards a PR with weight, unit and date when the all-time best is beaten', () => {
    reset('kg');
    const all = [
        session('s1', '2026-06-01', 60),
        session('s2', '2026-06-05', 62.5),
        session('s3', '2026-06-13', 70),
    ];
    const awarded = AchievementService.checkExercisePRs(all[2], all);
    assert.equal(awarded.length, 1);
    const json = awarded[0].toJSON();
    assert.equal(json.id, 'pr-incline-bb-bench-2026-06-13');
    assert.equal(json.requirement.type, 'strength-pr');
    assert.equal(json.prWeightKg, 70);
    assert.equal(json.prUnit, 'kg');
    assert.equal(json.prExerciseName, 'Incline Barbell Bench Press');
    assert.equal(json.prDate, '2026-06-13');
    // Persisted to storage as well.
    assert.equal((storageService.getAchievements() || []).length, 1);
});

test('checkExercisePRs: never produces a record without a positive weight or a date', () => {
    reset('kg');
    const all = [
        session('s1', '2026-06-01', 80),
        session('s2', '2026-06-05', 85),
        session('s3', '2026-06-13', 90),
    ];
    const awarded = AchievementService.checkExercisePRs(all[2], all);
    assert.equal(awarded.length, 1);
    const json = awarded[0].toJSON();
    assert.ok(typeof json.prWeightKg === 'number' && json.prWeightKg > 0, 'weight is positive');
    assert.ok(json.prDate, 'date is present');
    assert.equal(Achievement.isRenderable(awarded[0]), true);
});

test('checkExercisePRs: not awarded on the first-ever session for an exercise', () => {
    reset('kg');
    const all = [session('s1', '2026-06-13', 100)];
    assert.equal(AchievementService.checkExercisePRs(all[0], all).length, 0);
});

test('checkExercisePRs: not awarded with only one prior session (needs 2+)', () => {
    reset('kg');
    const all = [
        session('s1', '2026-06-01', 60),
        session('s2', '2026-06-13', 70),
    ];
    assert.equal(AchievementService.checkExercisePRs(all[1], all).length, 0);
});

test('checkExercisePRs: not awarded when the top set does not strictly beat the best', () => {
    reset('kg');
    const all = [
        session('s1', '2026-06-01', 70),
        session('s2', '2026-06-05', 70),
        session('s3', '2026-06-13', 70), // ties, does not beat
    ];
    assert.equal(AchievementService.checkExercisePRs(all[2], all).length, 0);
});

test('checkExercisePRs: idempotent by id on a repeated finish (no duplicate)', () => {
    reset('kg');
    const all = [
        session('s1', '2026-06-01', 60),
        session('s2', '2026-06-05', 62.5),
        session('s3', '2026-06-13', 70),
    ];
    assert.equal(AchievementService.checkExercisePRs(all[2], all).length, 1);
    assert.equal(AchievementService.checkExercisePRs(all[2], all).length, 0);
    assert.equal((storageService.getAchievements() || []).length, 1);
});

test('checkExercisePRs: duration-type sets never earn a strength PR', () => {
    reset('kg');
    const all = [
        session('s1', '2026-06-01', 0, { exerciseId: 'plank', exerciseName: 'Plank', duration: 30 }),
        session('s2', '2026-06-05', 0, { exerciseId: 'plank', exerciseName: 'Plank', duration: 45 }),
        session('s3', '2026-06-13', 0, { exerciseId: 'plank', exerciseName: 'Plank', duration: 60 }),
    ];
    assert.equal(AchievementService.checkExercisePRs(all[2], all).length, 0);
});

test('checkExercisePRs: in lb mode, stored weight is converted to canonical kg', () => {
    reset('lb');
    const all = [
        session('s1', '2026-06-01', 135),
        session('s2', '2026-06-05', 145),
        session('s3', '2026-06-13', 155),
    ];
    const awarded = AchievementService.checkExercisePRs(all[2], all);
    assert.equal(awarded.length, 1);
    const json = awarded[0].toJSON();
    assert.equal(json.prUnit, 'lb');
    // 155 lb -> ~70.31 kg; stored canonical, rounded to 2 decimals.
    assert.ok(Math.abs(json.prWeightKg - 70.31) < 0.05, `expected ~70.31 kg, got ${json.prWeightKg}`);
});

test('Achievement.isRenderable: rejects legacy strength-PR records missing weight or date', () => {
    const noWeight = new Achievement({ id: 'pr-x-2026-06-13', requirement: { type: 'strength-pr' }, prDate: '2026-06-13' });
    const zeroWeight = new Achievement({ id: 'pr-x-2026-06-13', requirement: { type: 'strength-pr' }, prWeightKg: 0, prDate: '2026-06-13' });
    const noDate = new Achievement({ id: 'pr-x-2026-06-13', requirement: { type: 'strength-pr' }, prWeightKg: 70 });
    const good = new Achievement({ id: 'pr-x-2026-06-13', requirement: { type: 'strength-pr' }, prWeightKg: 70, prDate: '2026-06-13' });
    assert.equal(Achievement.isRenderable(noWeight), false);
    assert.equal(Achievement.isRenderable(zeroWeight), false);
    assert.equal(Achievement.isRenderable(noDate), false);
    assert.equal(Achievement.isRenderable(good), true);
});

test('Achievement.isRenderable: always true for non strength-PR achievements', () => {
    const milestone = new Achievement({ id: '5-workouts', requirement: { type: 'total-workouts' }, target: 5 });
    assert.equal(Achievement.isRenderable(milestone), true);
});
