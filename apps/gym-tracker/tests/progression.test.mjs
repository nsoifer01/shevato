// Item 1: the prefilled weight on a planned row is a coaching decision the
// lifter must be able to see and override. These tests pin WHICH branch fires
// (bump / repeat / deload / none), because a silent bump after a failed
// session is the bug this feature exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    evaluateProgression,
    setsHitTarget,
    deloadWeight,
    PROGRESSION_BUMP,
    PROGRESSION_REPEAT,
    PROGRESSION_DELOAD,
    PROGRESSION_NONE,
} = await import('../js/utils/progression.js');

// Every set targets the same reps unless a per-slot map is supplied.
const flatTarget = (reps) => () => reps;
// Per-slot targets: sets[] rep ranges differ row by row (Item 1c).
const slotTarget = (targets) => (set, i) => targets[set.slot != null ? set.slot : i];

const set = (weight, reps, slot) => ({ weight, reps, slot });

// ---------------------------------------------------------------------------
// setsHitTarget
// ---------------------------------------------------------------------------

test('setsHitTarget: every set at or above target counts as a hit', () => {
    const sets = [set(100, 8, 0), set(100, 9, 1), set(100, 8, 2)];
    assert.equal(setsHitTarget(sets, flatTarget(8)), true);
});

test('setsHitTarget: one short set is a miss', () => {
    const sets = [set(100, 8, 0), set(100, 8, 1), set(100, 7, 2)];
    assert.equal(setsHitTarget(sets, flatTarget(8)), false);
});

test('setsHitTarget: per-set rep ranges are evaluated against their OWN target', () => {
    // Set 3 is programmed for 6 reps, so 6 is a hit even though sets 1-2 want 10.
    const sets = [set(100, 10, 0), set(100, 10, 1), set(100, 6, 2)];
    assert.equal(setsHitTarget(sets, slotTarget([10, 10, 6])), true,
        'set 3 hit its own repsMax');
    assert.equal(setsHitTarget(sets, flatTarget(10)), false,
        'the exercise-level fallback would have called it a miss');
});

test('setsHitTarget: no target reps means no evidence of a hit', () => {
    assert.equal(setsHitTarget([set(100, 12, 0)], flatTarget(0)), false);
});

test('setsHitTarget: an empty session is not a hit', () => {
    assert.equal(setsHitTarget([], flatTarget(8)), false);
});

// ---------------------------------------------------------------------------
// deloadWeight
// ---------------------------------------------------------------------------

test('deloadWeight: takes the largest equipment step inside the 5-10% band', () => {
    assert.equal(deloadWeight(100, 2.5), 90, '10% is reachable exactly');
    assert.equal(deloadWeight(225, 5), 205, '20lb off 225 is 8.9%, 25 would be 11%');
});

test('deloadWeight: falls back to a single step when 10% is under one increment', () => {
    // 10% of 20kg is 2kg, smaller than the 2.5kg step the plates can make.
    assert.equal(deloadWeight(20, 2.5), 17.5);
});

test('deloadWeight: never returns a non-positive weight', () => {
    assert.equal(deloadWeight(2.5, 2.5), 0);
    assert.equal(deloadWeight(0, 2.5), 0);
});

// ---------------------------------------------------------------------------
// evaluateProgression
// ---------------------------------------------------------------------------

test('evaluateProgression: two clean sessions at the same weight suggest a bump', () => {
    const last = [set(100, 8, 0), set(100, 8, 1)];
    const prev = [set(100, 8, 0), set(100, 8, 1)];
    const out = evaluateProgression({
        lastSets: last, prevSets: prev, targetRepsForSet: flatTarget(8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_BUMP);
    assert.equal(out.suggestedWeight, 102.5);
    assert.equal(out.lastWeight, 100, 'the literal last weight is preserved for "use last weight"');
});

test('evaluateProgression: a weight jump between the two sessions blocks the bump', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 8, 0)],
        prevSets: [set(95, 8, 0)],
        targetRepsForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
    assert.equal(out.suggestedWeight, 100, 'prefill stays at the last weight');
});

test('evaluateProgression: only one session of history never bumps', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 8, 0)], prevSets: null, targetRepsForSet: flatTarget(8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
});

test('evaluateProgression: a missed set last session repeats the weight', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 8, 0), set(100, 6, 1)],
        prevSets: [set(100, 8, 0), set(100, 8, 1)],
        targetRepsForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_REPEAT);
    assert.equal(out.suggestedWeight, 100, 'no bump after a miss');
    assert.equal(out.delta, 0);
});

test('evaluateProgression: two missed sessions at the same weight suggest a deload', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 6, 0)],
        prevSets: [set(100, 7, 0)],
        targetRepsForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_DELOAD);
    assert.equal(out.suggestedWeight, 90);
    assert.ok(out.delta < 0, 'the badge renders a negative delta');
});

test('evaluateProgression: two misses at DIFFERENT weights only repeat', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 6, 0)],
        prevSets: [set(95, 6, 0)],
        targetRepsForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_REPEAT);
});

test('evaluateProgression: per-set rep ranges decide bump vs repeat', () => {
    // Programmed 10/10/6. A 6-rep third set IS the target, so this is a bump,
    // not a miss.
    const sets = () => [set(60, 10, 0), set(60, 10, 1), set(60, 6, 2)];
    const out = evaluateProgression({
        lastSets: sets(), prevSets: sets(), targetRepsForSet: slotTarget([10, 10, 6]), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_BUMP);
    assert.equal(out.suggestedWeight, 62.5);
});

test('evaluateProgression: no history at all is a no-op', () => {
    const out = evaluateProgression({
        lastSets: [], prevSets: null, targetRepsForSet: flatTarget(8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
    assert.equal(out.suggestedWeight, 0);
});
