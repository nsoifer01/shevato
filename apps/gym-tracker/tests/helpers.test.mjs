// Pin timezone so date assertions are deterministic across machines.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatMuscleGroup,
    parseLocalDate,
    convertWeight,
    generateId,
    generateNumericId,
} from '../js/utils/helpers.js';

test('formatMuscleGroup: returns empty string for falsy input', () => {
    assert.equal(formatMuscleGroup(''), '');
    assert.equal(formatMuscleGroup(null), '');
    assert.equal(formatMuscleGroup(undefined), '');
});

test('formatMuscleGroup: maps canonical lowercase-hyphenated keys to friendly labels', () => {
    assert.equal(formatMuscleGroup('pectorals'), 'Chest');
    assert.equal(formatMuscleGroup('upper-pectorals'), 'Upper Chest');
    assert.equal(formatMuscleGroup('front-deltoids'), 'Front Delts');
    assert.equal(formatMuscleGroup('quads'), 'Quads');
    assert.equal(formatMuscleGroup('quadriceps'), 'Quads');
});

test('formatMuscleGroup: explicit shoulders entry post-normalization', () => {
    assert.equal(formatMuscleGroup('shoulders'), 'Shoulders');
});

test('formatMuscleGroup: falls back to title-casing unknown free-text values', () => {
    assert.equal(formatMuscleGroup('custom-muscle'), 'Custom Muscle');
    assert.equal(formatMuscleGroup('weird_thing'), 'Weird Thing');
});

test('parseLocalDate: parses YYYY-MM-DD as local midnight, not UTC', () => {
    const d = parseLocalDate('2026-04-24');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 3);
    assert.equal(d.getDate(), 24);
    assert.equal(d.getHours(), 0);
});

test('parseLocalDate: passes through non-YYYY-MM-DD values to the native parser', () => {
    const iso = parseLocalDate('2026-04-24T15:30:00Z');
    assert.equal(iso.getUTCFullYear(), 2026);
    assert.equal(iso.getUTCMonth(), 3);
    assert.equal(iso.getUTCDate(), 24);
});

test('convertWeight: same unit returns original number', () => {
    assert.equal(convertWeight(100, 'kg', 'kg'), 100);
    assert.equal(convertWeight(100, 'lb', 'lb'), 100);
});

test('convertWeight: kg → lb is rounded to one decimal', () => {
    assert.equal(convertWeight(100, 'kg', 'lb'), 220.5);
    assert.equal(convertWeight(0, 'kg', 'lb'), 0);
});

test('convertWeight: lb → kg is rounded to one decimal', () => {
    assert.equal(convertWeight(220.5, 'lb', 'kg'), 100);
});

test('generateId: returns a unique string each call', () => {
    const a = generateId();
    const b = generateId();
    assert.equal(typeof a, 'string');
    assert.notEqual(a, b);
});

test('generateNumericId: returns finite numbers and never collides on rapid-fire calls', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
        const id = generateNumericId();
        assert.ok(Number.isFinite(id));
        assert.ok(id > 0);
        ids.add(id);
    }
    assert.equal(ids.size, 1000);
});
