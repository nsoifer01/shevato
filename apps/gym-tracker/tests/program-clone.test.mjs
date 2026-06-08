// R3-3: Program.clone stages editor edits so Cancel/X discard them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Program } from '../js/models/Program.js';

function sample() {
    return new Program({
        name: 'Push Day',
        description: 'chest + shoulders',
        scheduleDays: [1, 4],
        restMode: 'uniform',
        uniformRestSeconds: 120,
        exercises: [
            { exerciseId: 'bench', exerciseName: 'Bench', targetSets: 3, targetReps: 8 },
            { exerciseId: 'ohp', exerciseName: 'OHP', targetSets: 3, targetReps: 10 },
        ],
    });
}

test('clone keeps the same id', () => {
    const p = sample();
    assert.equal(Program.clone(p).id, p.id);
});

test('clone is a deep, independent copy', () => {
    const original = sample();
    const staged = Program.clone(original);

    // Mutate every field the editor can touch.
    staged.name = 'Edited';
    staged.scheduleDays = [2, 3, 5];
    staged.uniformRestSeconds = 30;
    staged.addExercise('row', 'Row', 4, 12);
    staged.updateExercise(0, { exerciseName: 'Incline Bench' });

    // Original is untouched (Cancel path).
    assert.equal(original.name, 'Push Day');
    assert.deepEqual(original.scheduleDays, [1, 4]);
    assert.equal(original.uniformRestSeconds, 120);
    assert.equal(original.exercises.length, 2);
    assert.equal(original.exercises[0].exerciseName, 'Bench');
    assert.equal(staged.exercises[0].exerciseName, 'Incline Bench');
});

test('committing the clone back by id reflects all edits (Save path)', () => {
    const stored = [sample()];
    const staged = Program.clone(stored[0]);
    staged.name = 'Committed';
    staged.addExercise('row', 'Row', 4, 12);

    const idx = stored.findIndex(p => p.id === staged.id);
    stored[idx] = staged;

    assert.equal(stored[0].name, 'Committed');
    assert.equal(stored[0].exercises.length, 3);
});
