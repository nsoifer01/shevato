// Pin timezone so any timestamp-based tiebreakers are deterministic.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPrograms } from '../js/utils/program-order.js';

const make = (id, name, count = 0) => ({ id, name, exercises: Array(count).fill({}) });

test('orderPrograms: empty input returns []', () => {
    assert.deepEqual(orderPrograms([]), []);
    assert.deepEqual(orderPrograms(null), []);
    assert.deepEqual(orderPrograms(undefined), []);
});

test('orderPrograms: name-asc sorts case-insensitively', () => {
    const out = orderPrograms([make(1, 'b'), make(2, 'A'), make(3, 'c')], 'name-asc');
    assert.deepEqual(out.map(p => p.name), ['A', 'b', 'c']);
});

test('orderPrograms: name-desc reverses', () => {
    const out = orderPrograms([make(1, 'b'), make(2, 'A'), make(3, 'c')], 'name-desc');
    assert.deepEqual(out.map(p => p.name), ['c', 'b', 'A']);
});

test('orderPrograms: exercises-desc sorts by count, name as tiebreaker', () => {
    const out = orderPrograms([
        make(1, 'A', 2),
        make(2, 'B', 5),
        make(3, 'C', 5),
    ], 'exercises-desc');
    assert.deepEqual(out.map(p => p.name), ['B', 'C', 'A']);
});

test('orderPrograms: exercises-asc sorts ascending', () => {
    const out = orderPrograms([
        make(1, 'A', 5),
        make(2, 'B', 2),
        make(3, 'C', 2),
    ], 'exercises-asc');
    assert.deepEqual(out.map(p => p.name), ['B', 'C', 'A']);
});

test('orderPrograms: custom honors savedOrder, appends new programs at the end', () => {
    const out = orderPrograms([
        make(1, 'A'),
        make(2, 'B'),
        make(3, 'C'),
        make(4, 'D'),
    ], 'custom', [3, 1]);
    assert.deepEqual(out.map(p => p.id), [3, 1, 2, 4]);
});

test('orderPrograms: custom drops stale IDs from savedOrder', () => {
    const out = orderPrograms([make(1, 'A'), make(2, 'B')], 'custom', [99, 2, 1]);
    assert.deepEqual(out.map(p => p.id), [2, 1]);
});

test('orderPrograms: custom does not mutate the input array', () => {
    const programs = [make(1, 'A'), make(2, 'B')];
    const before = programs.slice();
    orderPrograms(programs, 'custom', [2]);
    assert.deepEqual(programs, before);
});

test('orderPrograms: unknown sortMode falls back to custom', () => {
    const out = orderPrograms([make(1, 'A'), make(2, 'B')], 'nonsense', [2, 1]);
    assert.deepEqual(out.map(p => p.id), [2, 1]);
});
