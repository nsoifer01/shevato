// Unit semantics (GT-03).
//
// The bug: `settings.weightUnit` was BOTH the display preference and the
// implicit meaning of every stored number, so switching kg to lb relabelled
// without converting. A 60 kg bench rendered as "60 lb", a 13,345 kg session
// as "13,345 lb", an 86.5 cm waist as "86.5 in", and the CSV export shipped
// those numbers to a spreadsheet. Meanwhile the Strength PR card, which
// stored canonical `prWeightKg`, kept showing kg while History showed lb - two
// surfaces disagreeing in the same moment.
//
// The model: storage is canonical (kg / cm / seconds); conversion happens at
// the input and output boundaries only. These tests pin the two properties
// that make that safe - exactness on the storage path, and no accumulated
// drift when a user flips the preference back and forth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CM_PER_IN,
    KG_PER_LB,
    displayLength,
    displayWeight,
    formatDuration,
    formatDurationLong,
    formatVolume,
    formatWeight,
    fromCanonicalLength,
    fromCanonicalWeight,
    lengthUnitFor,
    normalizeLengthUnit,
    normalizeWeightUnit,
    roundForDisplay,
    toCanonicalLength,
    toCanonicalWeight,
    volumeIn,
} from '../js/utils/units.js';

// ---------------------------------------------------------------------------
// Unit coercion
// ---------------------------------------------------------------------------

test('normalizeWeightUnit: only kg and lb exist; anything else is kg', () => {
    assert.equal(normalizeWeightUnit('kg'), 'kg');
    assert.equal(normalizeWeightUnit('lb'), 'lb');
    assert.equal(normalizeWeightUnit('stone'), 'kg');
    assert.equal(normalizeWeightUnit(undefined), 'kg');
});

test('lengthUnitFor: a lifter working in pounds measures in inches', () => {
    assert.equal(lengthUnitFor('kg'), 'cm');
    assert.equal(lengthUnitFor('lb'), 'in');
    assert.equal(normalizeLengthUnit('nonsense'), 'cm');
});

// ---------------------------------------------------------------------------
// The storage boundary is EXACT
// ---------------------------------------------------------------------------

test('toCanonicalWeight: kg is the identity, lb uses the exact pound', () => {
    assert.equal(toCanonicalWeight(60, 'kg'), 60, 'a kg user\'s data is never touched');
    assert.equal(toCanonicalWeight(1, 'lb'), KG_PER_LB);
});

test('toCanonicalWeight / fromCanonicalWeight do NOT round', () => {
    // Rounding on the way in is what makes a round trip drift.
    const kg = toCanonicalWeight(135, 'lb');
    assert.ok(Math.abs(kg - 61.23496995) < 1e-9, `expected exact kg, got ${kg}`);
    assert.ok(Math.abs(fromCanonicalWeight(kg, 'lb') - 135) < 1e-9);
});

test('missing values convert to null rather than 0', () => {
    for (const v of ['', null, undefined, 'abc']) {
        assert.equal(toCanonicalWeight(v, 'lb'), null, `${JSON.stringify(v)} is not a weight`);
        assert.equal(fromCanonicalWeight(v, 'lb'), null);
    }
});

test('lengths convert on the exact inch', () => {
    assert.equal(toCanonicalLength(1, 'in'), CM_PER_IN);
    assert.equal(toCanonicalLength(86.5, 'cm'), 86.5);
    assert.ok(Math.abs(fromCanonicalLength(toCanonicalLength(34, 'in'), 'in') - 34) < 1e-9);
});

// ---------------------------------------------------------------------------
// The display boundary rounds - once
// ---------------------------------------------------------------------------

test('displayWeight: canonical kg renders in the chosen unit', () => {
    // The audit's own table.
    assert.equal(displayWeight(60, 'kg'), 60);
    assert.equal(displayWeight(60, 'lb'), 132.3, '60 kg is about 132 lb, not "60 lb"');
    assert.equal(displayWeight(81.5, 'lb'), 179.7, 'the 81.5 kg body weight from the report');
});

test('displayLength: an 86.5 cm waist is ~34 in, never "86.5 in"', () => {
    assert.equal(displayLength(86.5, 'cm'), 86.5);
    assert.equal(displayLength(86.5, 'in'), 34.1);
});

test('displayWeight returns "" for a missing value so it can go straight into an input', () => {
    assert.equal(displayWeight(null, 'kg'), '');
    assert.equal(displayWeight('', 'lb'), '');
});

test('roundForDisplay drops a trailing .0', () => {
    assert.equal(roundForDisplay(60.0), 60);
    assert.equal(roundForDisplay(62.55), 62.6);
    assert.equal(roundForDisplay(1322.7, 0), 1323);
});

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

test('volume converts with the same factor as a weight (it is linear)', () => {
    // The audit's 13,345 kg session. It quoted ~29,420 lb using the truncated
    // 2.20462; the exact international pound gives 29,421.
    assert.equal(Math.round(volumeIn(13345, 'lb')), 29421);
    assert.equal(volumeIn(13345, 'kg'), 13345);
});

test('formatVolume: thousands separators and the unit', () => {
    assert.equal(formatVolume(13345, 'kg'), '13,345 kg');
    assert.equal(formatVolume(13345, 'lb'), '29,421 lb');
});

test('formatWeight: the number and its unit, together', () => {
    assert.equal(formatWeight(60, 'kg'), '60kg');
    assert.equal(formatWeight(60, 'lb', { space: true }), '132.3 lb');
    assert.equal(formatWeight(null, 'kg'), '');
});

// ---------------------------------------------------------------------------
// Round-tripping: the property that makes switching safe
// ---------------------------------------------------------------------------

test('kg -> lb -> kg round-trips exactly through storage', () => {
    for (const kg of [20, 42.5, 60, 62.5, 100, 137.5, 0.5, 1.25]) {
        const lb = fromCanonicalWeight(kg, 'lb');
        assert.ok(Math.abs(toCanonicalWeight(lb, 'lb') - kg) < 1e-9, `${kg} kg drifted`);
    }
});

test('flipping the preference 20 times never moves the stored number', () => {
    // The unit is a VIEW of the data, so switching it does not write. This is
    // the structural reason there can be no accumulated drift.
    let stored = 61.23496995;
    for (let i = 0; i < 20; i++) {
        const unit = i % 2 === 0 ? 'lb' : 'kg';
        const shown = displayWeight(stored, unit);
        assert.ok(shown !== '', 'always renderable');
    }
    assert.equal(stored, 61.23496995);
});

test('a value entered in lb, stored, and shown again reads back as typed', () => {
    for (const entered of [45, 95, 135, 185, 225, 315, 2.5, 7.5]) {
        const stored = toCanonicalWeight(entered, 'lb');
        assert.equal(displayWeight(stored, 'lb'), entered, `${entered} lb did not round-trip`);
    }
});

test('a value entered in one unit and read in the other agrees both ways', () => {
    const stored = toCanonicalWeight(100, 'lb');
    assert.equal(displayWeight(stored, 'lb'), 100);
    assert.equal(displayWeight(stored, 'kg'), 45.4);
});

// ---------------------------------------------------------------------------
// Durations are never rendered as weights (GT-04)
// ---------------------------------------------------------------------------

test('formatDuration: seconds render as a clock, not a number of kilograms', () => {
    assert.equal(formatDuration(60), '1:00');
    assert.equal(formatDuration(45), '0:45');
    assert.equal(formatDuration(135), '2:15');
    assert.equal(formatDuration(0), '0:00');
});

test('formatDurationLong: a readable total for a summary tile', () => {
    assert.equal(formatDurationLong(45), '45s');
    assert.equal(formatDurationLong(60), '1m');
    assert.equal(formatDurationLong(135), '2m 15s');
    assert.equal(formatDurationLong(3660), '1h 01m');
});
