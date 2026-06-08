// Tests for sameId: type-insensitive id comparison.
//
// Why this matters: Program ids are generated numerically, but ids that come
// back from the DOM (dataset.programId, drag payloads) are always strings.
// getProgramById-style lookups must match a numeric id when queried by its
// string form, or "Start Workout" / Edit / Delete silently no-op on real
// programs. These tests reproduce that exact mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameId } from '../js/utils/id-utils.js';

test('sameId: numeric id matches its string form (the dataset case)', () => {
    assert.equal(sameId(1717000000000, '1717000000000'), true);
    assert.equal(sameId('1717000000000', 1717000000000), true);
});

test('sameId: string ids (imported/legacy data) match', () => {
    assert.equal(sameId('g-abc', 'g-abc'), true);
    assert.equal(sameId('g-abc', 'g-xyz'), false);
});

test('sameId: distinct numeric ids do not match', () => {
    assert.equal(sameId(1, 2), false);
});

test('getProgramById-style lookup finds a numeric id by its string form', () => {
    const programs = [
        { id: 1717000000001, name: 'Push' },
        { id: 1717000000002, name: 'Pull' },
    ];
    // The id arrives from dataset.* as a string.
    const found = programs.find(p => sameId(p.id, '1717000000002'));
    assert.equal(found?.name, 'Pull');
});

test('getProgramById-style lookup also works for imported string ids', () => {
    const programs = [{ id: 'legacy-1', name: 'Legacy' }];
    const found = programs.find(p => sameId(p.id, 'legacy-1'));
    assert.equal(found?.name, 'Legacy');
});
