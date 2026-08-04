// Item 7: measurement goal progress. The bar runs from the earliest logged
// value (baseline) toward the target, so direction handling and clamping are
// what keep a tile from claiming progress it has not made.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGoalProgress } from '../js/utils/helpers.js';

const decrease = (target) => ({ target, direction: 'decrease' });
const increase = (target) => ({ target, direction: 'increase' });

test('computeGoalProgress: a decrease goal fills as the value drops toward target', () => {
    // 100 kg baseline, 75 kg target, now 83 kg → 17 of 25 kg travelled.
    assert.equal(computeGoalProgress(100, 83, decrease(75)), 68);
    assert.equal(computeGoalProgress(100, 100, decrease(75)), 0);
    assert.equal(computeGoalProgress(100, 75, decrease(75)), 100);
});

test('computeGoalProgress: an increase goal fills as the value rises toward target', () => {
    // 36 cm baseline arm, 40 cm target, now 38 cm → halfway.
    assert.equal(computeGoalProgress(36, 38, increase(40)), 50);
    assert.equal(computeGoalProgress(36, 36, increase(40)), 0);
    assert.equal(computeGoalProgress(36, 40, increase(40)), 100);
});

test('computeGoalProgress: overshooting the target clamps at 100, not beyond', () => {
    assert.equal(computeGoalProgress(100, 70, decrease(75)), 100);
    assert.equal(computeGoalProgress(36, 44, increase(40)), 100);
});

test('computeGoalProgress: moving the wrong way clamps at 0 instead of going negative', () => {
    assert.equal(computeGoalProgress(100, 110, decrease(75)), 0);
    assert.equal(computeGoalProgress(36, 34, increase(40)), 0);
});

test('computeGoalProgress: a baseline already past the target reads as met or not met', () => {
    // No span to travel: the only honest answers are 100 or 0.
    assert.equal(computeGoalProgress(70, 70, decrease(75)), 100);
    assert.equal(computeGoalProgress(70, 80, decrease(75)), 0);
    assert.equal(computeGoalProgress(42, 42, increase(40)), 100);
    assert.equal(computeGoalProgress(42, 38, increase(40)), 0);
});

test('computeGoalProgress: percent is a rounded integer for the "% to goal" label', () => {
    // 1 of 3 kg travelled = 33.33%.
    assert.equal(computeGoalProgress(80, 79, decrease(77)), 33);
});

test('computeGoalProgress: missing or junk inputs return null so no bar renders', () => {
    assert.equal(computeGoalProgress(null, 80, decrease(75)), null);
    assert.equal(computeGoalProgress(undefined, 80, decrease(75)), null);
    assert.equal(computeGoalProgress(100, undefined, decrease(75)), null);
    assert.equal(computeGoalProgress(100, 80, { direction: 'decrease' }), null);
    assert.equal(computeGoalProgress(100, 80, { target: 'soon', direction: 'decrease' }), null);
});

test('computeGoalProgress: direction defaults to increase when unspecified', () => {
    assert.equal(computeGoalProgress(36, 38, { target: 40 }), 50);
});
