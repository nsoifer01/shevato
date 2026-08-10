// Item 1: the prefilled weight on a planned row is a coaching decision the
// lifter must be able to see and override. These tests pin WHICH branch fires
// (bump / repeat / deload / none), because a silent bump after a failed
// session is the bug this feature exists to prevent.
//
// They also pin the three-state reading of a rep RANGE: under the bottom is a
// miss, the top on every set earns the bump, and in between holds the weight
// and says nothing. Judging every set against the top alone called "10 of
// 10-12" a miss and deloaded lifters off weights they were handling fine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    evaluateProgression,
    setsHitTarget,
    setsBelowRange,
    belowRangeSets,
    normalizeRange,
    deloadWeight,
    PROGRESSION_BUMP,
    PROGRESSION_REPEAT,
    PROGRESSION_DELOAD,
    PROGRESSION_NONE,
} = await import('../js/utils/progression.js');

// Every set targets the same fixed reps unless a per-slot map is supplied.
const flatTarget = (reps) => () => reps;
// Per-slot targets: sets[] rep ranges differ row by row (Item 1c).
const slotTarget = (targets) => (set, i) => targets[set.slot != null ? set.slot : i];
// A single {min, max} range shared by every set.
const flatRange = (min, max) => () => ({ min, max });

const set = (weight, reps, slot) => ({ weight, reps, slot });

// ---------------------------------------------------------------------------
// normalizeRange
// ---------------------------------------------------------------------------

test('normalizeRange: a bare number is a fixed target', () => {
    assert.deepEqual(normalizeRange(8), { min: 8, max: 8 });
});

test('normalizeRange: an object passes both ends through', () => {
    assert.deepEqual(normalizeRange({ min: 10, max: 12 }), { min: 10, max: 12 });
});

test('normalizeRange: garbage reads as no target', () => {
    assert.deepEqual(normalizeRange(null), { min: 0, max: 0 });
    assert.deepEqual(normalizeRange({}), { min: 0, max: 0 });
});

// ---------------------------------------------------------------------------
// setsHitTarget — the bar for ADDING weight: top of the range, every set
// ---------------------------------------------------------------------------

test('setsHitTarget: every set at or above target counts as a hit', () => {
    const sets = [set(100, 8, 0), set(100, 9, 1), set(100, 8, 2)];
    assert.equal(setsHitTarget(sets, flatTarget(8)), true);
});

test('setsHitTarget: one short set is not a hit', () => {
    const sets = [set(100, 8, 0), set(100, 8, 1), set(100, 7, 2)];
    assert.equal(setsHitTarget(sets, flatTarget(8)), false);
});

test('setsHitTarget: mid-range does not earn the bump', () => {
    const sets = [set(100, 12, 0), set(100, 10, 1)];
    assert.equal(setsHitTarget(sets, flatRange(10, 12)), false,
        '10 of 10-12 is a fine set, but it is not the top');
});

test('setsHitTarget: top of the range on every set does earn it', () => {
    const sets = [set(100, 12, 0), set(100, 12, 1)];
    assert.equal(setsHitTarget(sets, flatRange(10, 12)), true);
});

test('setsHitTarget: per-set rep ranges are evaluated against their OWN target', () => {
    // Set 3 is programmed for 6 reps, so 6 is a hit even though sets 1-2 want 10.
    const sets = [set(100, 10, 0), set(100, 10, 1), set(100, 6, 2)];
    assert.equal(setsHitTarget(sets, slotTarget([10, 10, 6])), true,
        'set 3 hit its own repsMax');
    assert.equal(setsHitTarget(sets, flatTarget(10)), false,
        'the exercise-level fallback would have called it short');
});

test('setsHitTarget: no target reps means no evidence of a hit', () => {
    assert.equal(setsHitTarget([set(100, 12, 0)], flatTarget(0)), false);
});

test('setsHitTarget: an empty session is not a hit', () => {
    assert.equal(setsHitTarget([], flatTarget(8)), false);
});

// ---------------------------------------------------------------------------
// belowRangeSets / setsBelowRange — the only true MISS, reported PER SET
// ---------------------------------------------------------------------------

test('belowRangeSets: in-range reps are not a miss', () => {
    // The owner's case: 7 reps of a 7-8 target is a good set, not a failure.
    const sets = [set(120, 8, 0), set(120, 7, 1)];
    assert.deepEqual(belowRangeSets(sets, flatRange(7, 8)), []);
    assert.equal(setsBelowRange(sets, flatRange(7, 8)), false);
});

test('belowRangeSets: under the bottom of the range IS a miss', () => {
    const sets = [set(120, 8, 0), set(120, 6, 1)];
    assert.deepEqual(belowRangeSets(sets, flatRange(7, 8)),
        [{ slot: 1, reps: 6, min: 7, max: 8 }]);
});

test('belowRangeSets: the owner\'s per-set example', () => {
    // Targets 12 / 10 / 8; the lifter got 12 / 9 / 8. Only set 2 fell short,
    // and the sets either side of it must stay clean.
    const sets = [set(60, 12, 0), set(60, 9, 1), set(60, 8, 2)];
    const targets = slotTarget([12, 10, 8]);
    assert.deepEqual(belowRangeSets(sets, targets),
        [{ slot: 1, reps: 9, min: 10, max: 10 }]);
});

test('belowRangeSets: EVERY short set is reported, not just the first', () => {
    // The whole point of per-set: two misses means two warnings.
    const sets = [set(120, 8, 0), set(120, 5, 1), set(120, 4, 2)];
    assert.deepEqual(belowRangeSets(sets, flatRange(7, 8)).map(m => m.slot), [1, 2]);
});

test('belowRangeSets: reports the SLOT, not the array index', () => {
    // Sets 1 and 2 were logged elsewhere; this array starts at slot 2.
    const sets = [set(120, 8, 2), set(120, 4, 3)];
    assert.deepEqual(belowRangeSets(sets, flatRange(7, 8)).map(m => m.slot), [3],
        'the warning must land on the row the lifter actually missed');
});

test('belowRangeSets: a fixed target is its own floor', () => {
    assert.deepEqual(belowRangeSets([set(100, 7, 0)], flatTarget(8)).map(m => m.slot), [0]);
    assert.deepEqual(belowRangeSets([set(100, 8, 0)], flatTarget(8)), []);
});

test('belowRangeSets: no resolvable minimum is not a miss', () => {
    assert.deepEqual(belowRangeSets([set(100, 1, 0)], flatTarget(0)), [],
        'nothing to fall short of, so hold the weight rather than accuse');
});

test('belowRangeSets: an empty session has no misses', () => {
    assert.deepEqual(belowRangeSets([], flatRange(7, 8)), []);
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
        lastSets: last, prevSets: prev, repRangeForSet: flatTarget(8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_BUMP);
    assert.equal(out.suggestedWeight, 102.5);
    assert.equal(out.lastWeight, 100, 'the literal last weight is preserved for "use last weight"');
    assert.deepEqual(out.misses, []);
});

test('evaluateProgression: a weight jump between the two sessions blocks the bump', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 8, 0)],
        prevSets: [set(95, 8, 0)],
        repRangeForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
    assert.equal(out.suggestedWeight, 100, 'prefill stays at the last weight');
});

test('evaluateProgression: only one session of history never bumps', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 8, 0)], prevSets: null, repRangeForSet: flatTarget(8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
});

test('evaluateProgression: a set under the range repeats the weight', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 8, 0), set(100, 6, 1)],
        prevSets: [set(100, 8, 0), set(100, 8, 1)],
        repRangeForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_REPEAT);
    assert.equal(out.suggestedWeight, 100, 'no bump after a miss');
    assert.equal(out.delta, 0);
    assert.deepEqual(out.misses.map(m => m.slot), [1],
        'the warning belongs on set 2, the one that fell short');
});

test('evaluateProgression: two sessions under the range at the same weight deload', () => {
    const out = evaluateProgression({
        lastSets: [set(100, 6, 0)],
        prevSets: [set(100, 7, 0)],
        repRangeForSet: flatTarget(8),
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
        repRangeForSet: flatTarget(8),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_REPEAT);
});

test('evaluateProgression: per-set rep ranges decide bump vs repeat', () => {
    // Programmed 10/10/6. A 6-rep third set IS the target, so this is a bump,
    // not a miss.
    const sets = () => [set(60, 10, 0), set(60, 10, 1), set(60, 6, 2)];
    const out = evaluateProgression({
        lastSets: sets(), prevSets: sets(), repRangeForSet: slotTarget([10, 10, 6]), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_BUMP);
    assert.equal(out.suggestedWeight, 62.5);
});

test('evaluateProgression: no history at all is a no-op', () => {
    const out = evaluateProgression({
        lastSets: [], prevSets: null, repRangeForSet: flatTarget(8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
    assert.equal(out.suggestedWeight, 0);
});

// --- The owner's two reported cases (2026-08-10) ---------------------------

test('evaluateProgression: in-range work holds the weight and says nothing', () => {
    // Lat pulldown, 7-8 target, finished at 7. Previously this rendered
    // "Missed target - repeat weight" under set 1.
    const sets = () => [set(160, 8, 0), set(160, 7, 1)];
    const out = evaluateProgression({
        lastSets: sets(), prevSets: sets(), repRangeForSet: flatRange(7, 8), increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE, 'in range is not a miss');
    assert.equal(out.suggestedWeight, 160, 'hold the weight');
    assert.deepEqual(out.misses, [], 'and accuse no set');
});

test('evaluateProgression: mid-range twice holds instead of deloading', () => {
    // Triceps extension, 10-12 target, 72.5kg both sessions: (12, 10) then
    // (10, 10). Previously this deloaded to 67.5kg.
    const out = evaluateProgression({
        lastSets: [set(72.5, 12, 0), set(72.5, 10, 1)],
        prevSets: [set(72.5, 10, 0), set(72.5, 10, 1)],
        repRangeForSet: flatRange(10, 12),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_NONE);
    assert.equal(out.suggestedWeight, 72.5, 'no cut off a weight being handled fine');
});

test('evaluateProgression: a repeat reports every short set for its own warning', () => {
    // Targets 12 / 10 / 8, lifter got 12 / 9 / 6: sets 2 and 3 each earn a
    // warning, set 1 earns none.
    const out = evaluateProgression({
        lastSets: [set(60, 12, 0), set(60, 9, 1), set(60, 6, 2)],
        prevSets: [set(60, 12, 0), set(60, 10, 1), set(60, 8, 2)],
        repRangeForSet: slotTarget([12, 10, 8]),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_REPEAT);
    assert.deepEqual(out.misses.map(m => m.slot), [1, 2]);
    assert.deepEqual(out.misses[0], { slot: 1, reps: 9, min: 10, max: 10 },
        'each miss carries its numbers so the warning can explain itself');
});

test('evaluateProgression: genuinely falling under the range still deloads', () => {
    // Same 10-12 target, but 8 and 9 reps are below the floor twice over.
    const out = evaluateProgression({
        lastSets: [set(72.5, 8, 0), set(72.5, 8, 1)],
        prevSets: [set(72.5, 9, 0), set(72.5, 9, 1)],
        repRangeForSet: flatRange(10, 12),
        increment: 2.5,
    });
    assert.equal(out.status, PROGRESSION_DELOAD);
    assert.equal(out.suggestedWeight, 67.5);
});
