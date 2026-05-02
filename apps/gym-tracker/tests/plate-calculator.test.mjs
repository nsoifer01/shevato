process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePlates, formatPlateStack } from '../js/utils/plate-calculator.js';

const KG_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
const LB_PLATES = [45, 35, 25, 10, 5, 2.5];

test('calculatePlates: 100kg on a 20kg bar with full kg set is reachable', () => {
    const r = calculatePlates(100, 20, KG_PLATES);
    assert.equal(r.reachable, true);
    assert.equal(r.achievable, 100);
    assert.equal(r.perSide, 40);
    assert.deepEqual(r.plates, [
        { weight: 25, count: 1 },
        { weight: 15, count: 1 },
    ]);
});

test('calculatePlates: 60kg → bar + 20kg per side using one 20', () => {
    const r = calculatePlates(60, 20, KG_PLATES);
    assert.equal(r.reachable, true);
    assert.deepEqual(r.plates, [{ weight: 20, count: 1 }]);
});

test('calculatePlates: greedy uses multiple of the heaviest plate when needed', () => {
    // 110kg: bar 20 + 90 → 45 per side → 25 + 20
    const r = calculatePlates(110, 20, KG_PLATES);
    assert.equal(r.reachable, true);
    assert.deepEqual(r.plates, [
        { weight: 25, count: 1 },
        { weight: 20, count: 1 },
    ]);
});

test('calculatePlates: 200kg → bar + 4×25 + 10 + 5 per side', () => {
    const r = calculatePlates(200, 20, KG_PLATES);
    assert.equal(r.reachable, true);
    assert.equal(r.perSide, 90);
    assert.deepEqual(r.plates, [
        { weight: 25, count: 3 },
        { weight: 15, count: 1 },
    ]);
});

test('calculatePlates: target equals bar weight returns bar-only', () => {
    const r = calculatePlates(20, 20, KG_PLATES);
    assert.equal(r.reachable, true);
    assert.deepEqual(r.plates, []);
    assert.equal(r.achievable, 20);
});

test('calculatePlates: target below bar marks belowBar', () => {
    const r = calculatePlates(15, 20, KG_PLATES);
    assert.equal(r.reachable, false);
    assert.equal(r.belowBar, true);
    assert.equal(r.achievable, 20);
});

test('calculatePlates: unreachable target reports the diff', () => {
    // Bar 20 + 1.25 each side = 22.5; target 22 is 0.5 short of achievable.
    // Using only 2.5+ plates means closest ≤ 22 is bar (20), diff = 2.
    const r = calculatePlates(22, 20, [25, 20, 15, 10, 5, 2.5]);
    assert.equal(r.reachable, false);
    assert.equal(r.achievable, 20);
    assert.equal(r.diff, 2);
});

test('calculatePlates: handles fractional plate sets correctly with epsilon', () => {
    // 17.5 / 2.5 = 7 with floating-point noise; greedy must return count 7.
    const r = calculatePlates(55, 20, [2.5]);
    assert.equal(r.perSide, 17.5);
    assert.deepEqual(r.plates, [{ weight: 2.5, count: 7 }]);
});

test('calculatePlates: lb set works the same way', () => {
    const r = calculatePlates(225, 45, LB_PLATES);
    assert.equal(r.reachable, true);
    assert.equal(r.perSide, 90);
    assert.deepEqual(r.plates, [
        { weight: 45, count: 2 },
    ]);
});

test('calculatePlates: empty plate list with above-bar target is unreachable', () => {
    const r = calculatePlates(60, 20, []);
    assert.equal(r.reachable, false);
    assert.equal(r.achievable, 20);
    assert.equal(r.diff, 40);
});

test('calculatePlates: invalid inputs flagged', () => {
    assert.equal(calculatePlates(NaN, 20, KG_PLATES).invalid, true);
    assert.equal(calculatePlates(100, NaN, KG_PLATES).invalid, true);
    assert.equal(calculatePlates(100, -1, KG_PLATES).invalid, true);
});

test('calculatePlates: ignores non-numeric / non-positive plates in the list', () => {
    const r = calculatePlates(60, 20, [20, 'junk', null, -5, 0, 10]);
    assert.equal(r.reachable, true);
    assert.deepEqual(r.plates, [{ weight: 20, count: 1 }]);
});

test('formatPlateStack: bar-only renders without any plates', () => {
    const r = calculatePlates(20, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '(bar only)');
});

test('formatPlateStack: single plate per side', () => {
    const r = calculatePlates(60, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '20kg');
});

test('formatPlateStack: multiple plates joined with +', () => {
    const r = calculatePlates(100, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '25kg + 15kg');
});

test('formatPlateStack: count prefix when stacking', () => {
    const r = calculatePlates(200, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '3×25kg + 15kg');
});

test('formatPlateStack: shows diff when target unreachable', () => {
    const r = calculatePlates(22, 20, [25, 20, 15, 10, 5, 2.5]);
    const out = formatPlateStack(r, 'kg');
    assert.match(out, /\(bar only\).*\(−2kg\)/);
});

test('formatPlateStack: below-bar yields parenthesized note', () => {
    const r = calculatePlates(15, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '(below bar)');
});
