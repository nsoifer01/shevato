// Tests for Program model: per-set rep ranges, rest mode, and backward compat.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal stubs so Program.js can import helpers.js without a DOM.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// We need generateNumericId from helpers — stub it out via a simple shim.
// helpers.js uses crypto.randomUUID which is available in Node 18+.
const { Program, defaultRestForEquipment } = await import('../js/models/Program.js');

// -------------------------------------------------------
// defaultRestForEquipment
// -------------------------------------------------------

test('defaultRestForEquipment: known equipment returns correct value', () => {
    assert.equal(defaultRestForEquipment('barbell'), 180);
    assert.equal(defaultRestForEquipment('bodyweight'), 60);
    assert.equal(defaultRestForEquipment('dumbbell'), 90);
});

test('defaultRestForEquipment: unknown equipment returns 90', () => {
    assert.equal(defaultRestForEquipment('unknown'), 90);
    assert.equal(defaultRestForEquipment(undefined), 90);
});

// -------------------------------------------------------
// New shape: sets[]
// -------------------------------------------------------

test('Program: fresh exercise has sets[] with correct default', () => {
    const p = new Program({ name: 'Test' });
    p.addExercise('e1', 'Squat', 3, 10);
    const ex = p.exercises[0];
    assert.ok(Array.isArray(ex.sets), 'sets is an array');
    assert.equal(ex.sets.length, 3);
    ex.sets.forEach(s => {
        assert.equal(s.repsMin, 10);
        assert.equal(s.repsMax, 10);
    });
});

test('Program: targetSets getter returns sets.length', () => {
    const p = new Program({ name: 'Test' });
    p.addExercise('e1', 'Bench', 4, 8);
    assert.equal(p.exercises[0].targetSets, 4);
});

test('Program: targetReps getter returns first set repsMax', () => {
    const p = new Program({ name: 'Test' });
    p.addExercise('e1', 'Deadlift', 2, 5);
    assert.equal(p.exercises[0].targetReps, 5);
});

test('Program: targetSets and targetReps are not enumerable (not serialized)', () => {
    const p = new Program({ name: 'Test' });
    p.addExercise('e1', 'Row', 3, 12);
    const keys = Object.keys(p.exercises[0]);
    assert.ok(!keys.includes('targetSets'), 'targetSets not in Object.keys');
    assert.ok(!keys.includes('targetReps'), 'targetReps not in Object.keys');
});

// -------------------------------------------------------
// Backward compatibility: old targetSets/targetReps shape
// -------------------------------------------------------

test('Program.fromJSON: legacy exercise with targetSets/targetReps is normalized', () => {
    const json = {
        id: 1,
        name: 'Legacy',
        exercises: [
            {
                exerciseId: 'e1',
                exerciseName: 'Press',
                targetSets: 4,
                targetReps: 6,
                restSeconds: 120,
                notes: '',
                order: 0,
            }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const p = Program.fromJSON(json);
    const ex = p.exercises[0];
    assert.ok(Array.isArray(ex.sets));
    assert.equal(ex.sets.length, 4, 'expanded from targetSets=4');
    ex.sets.forEach(s => {
        assert.equal(s.repsMin, 6);
        assert.equal(s.repsMax, 6);
    });
    assert.equal(ex.targetSets, 4);
    assert.equal(ex.targetReps, 6);
});

test('Program.fromJSON: new-shape exercise with sets[] is preserved', () => {
    const json = {
        id: 2,
        name: 'New',
        exercises: [
            {
                exerciseId: 'e2',
                exerciseName: 'Pull-up',
                sets: [
                    { repsMin: 11, repsMax: 12 },
                    { repsMin: 8,  repsMax: 10 },
                    { repsMin: 6,  repsMax: 8  },
                ],
                restSeconds: 90,
                notes: '',
                order: 0,
            }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const p = Program.fromJSON(json);
    const ex = p.exercises[0];
    assert.equal(ex.sets.length, 3);
    assert.deepEqual(ex.sets[0], { repsMin: 11, repsMax: 12 });
    assert.deepEqual(ex.sets[1], { repsMin: 8,  repsMax: 10 });
    assert.deepEqual(ex.sets[2], { repsMin: 6,  repsMax: 8  });
    assert.equal(ex.targetSets, 3);
    assert.equal(ex.targetReps, 12); // first set repsMax
});

// -------------------------------------------------------
// Validation / clamping
// -------------------------------------------------------

test('Program: repsMin is clamped to [1, 100]', () => {
    const p = Program.fromJSON({
        id: 3, name: 'Clamp', exercises: [{
            exerciseId: 'e', exerciseName: 'X',
            sets: [{ repsMin: -5, repsMax: 200 }],
            restSeconds: 90, notes: '', order: 0,
        }],
        createdAt: '', updatedAt: '',
    });
    const row = p.exercises[0].sets[0];
    assert.equal(row.repsMin, 1);
    assert.equal(row.repsMax, 100);
});

test('Program: repsMin cannot exceed repsMax after clamping', () => {
    const p = Program.fromJSON({
        id: 4, name: 'Order', exercises: [{
            exerciseId: 'e', exerciseName: 'X',
            sets: [{ repsMin: 15, repsMax: 5 }],
            restSeconds: 90, notes: '', order: 0,
        }],
        createdAt: '', updatedAt: '',
    });
    const row = p.exercises[0].sets[0];
    assert.ok(row.repsMin <= row.repsMax, 'repsMin <= repsMax after normalize');
});

// -------------------------------------------------------
// Rest mode
// -------------------------------------------------------

test('Program: default restMode is custom', () => {
    const p = new Program({ name: 'Rest' });
    assert.equal(p.restMode, 'custom');
});

test('Program: restMode uniform is round-tripped through toJSON/fromJSON', () => {
    const p = new Program({ name: 'Uniform', restMode: 'uniform', uniformRestSeconds: 120 });
    const clone = Program.fromJSON(p.toJSON());
    assert.equal(clone.restMode, 'uniform');
    assert.equal(clone.uniformRestSeconds, 120);
});

test('Program: uniformRestSeconds is clamped to [0, 900]', () => {
    const p = new Program({ name: 'ClampRest', restMode: 'uniform', uniformRestSeconds: 9999 });
    assert.equal(p.uniformRestSeconds, 900);
    const p2 = new Program({ name: 'ClampNeg', restMode: 'uniform', uniformRestSeconds: -30 });
    assert.equal(p2.uniformRestSeconds, 0);
});

test('Program: invalid restMode string falls back to custom', () => {
    const p = new Program({ name: 'Bad', restMode: 'weekly' });
    assert.equal(p.restMode, 'custom');
});

// -------------------------------------------------------
// toJSON: sets are serialized, getters are not
// -------------------------------------------------------

test('Program.toJSON: exercises include sets[] and targetSets/targetReps are not enumerable', () => {
    const p = new Program({ name: 'Serial' });
    p.addExercise('e1', 'Curl', 3, 12);
    const json = p.toJSON();
    const ex = json.exercises[0];
    assert.ok(Array.isArray(ex.sets), 'sets[] present in JSON output');
    // Getters are non-enumerable so they must not appear in JSON.stringify output.
    const serialized = JSON.stringify(ex);
    const parsed = JSON.parse(serialized);
    assert.ok(!('targetSets' in parsed), 'targetSets absent from JSON.stringify output');
    assert.ok(!('targetReps' in parsed), 'targetReps absent from JSON.stringify output');
});
