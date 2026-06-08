// Tests for Item R2-10: in-session PR supersede bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    exerciseKeyOf,
    recordPrSupersede,
    uniquePrChainCount,
    recomputePrSlots,
} from '../js/utils/pr-session.js';

const pr = (delta) => ({ kind: 'volume', delta });

// A volume-based PR predicate over history baseline + earlier same-exercise
// session sets, mirroring AnalyticsService.isSetPR's volume rule. `baseline`
// is the prior-best volume from completed sessions for the exercise.
const makeIsPr = (baseline) => (exerciseId, set, priorSessionSets) => {
    const vol = (s) => (s.weight || 0) * (s.reps || 0);
    const prevMax = priorSessionSets.reduce((m, s) => Math.max(m, vol(s)), baseline);
    const v = vol(set);
    return v > prevMax ? pr(v - prevMax) : null;
};

test('exerciseKeyOf: returns the index portion before the first colon', () => {
    assert.equal(exerciseKeyOf('0:0'), '0');
    assert.equal(exerciseKeyOf('3:11'), '3');
    assert.equal(exerciseKeyOf('lone'), 'lone');
});

test('recordPrSupersede: a higher set replaces the earlier badge for the same exercise', () => {
    const slots = {};
    recordPrSupersede(slots, '0:0', pr(100)); // Set1 100x10
    assert.deepEqual(Object.keys(slots), ['0:0']);

    recordPrSupersede(slots, '0:1', pr(200)); // Set2 100x12 supersedes
    assert.deepEqual(Object.keys(slots), ['0:1']);
    assert.equal(slots['0:0'], undefined);
    assert.equal(uniquePrChainCount(slots), 1);
});

test('recordPrSupersede: a 100 -> 110 -> 120 chain counts once and keeps only the last', () => {
    const slots = {};
    recordPrSupersede(slots, '0:0', pr(100));
    recordPrSupersede(slots, '0:1', pr(110));
    recordPrSupersede(slots, '0:2', pr(120));
    assert.deepEqual(Object.keys(slots), ['0:2']);
    assert.equal(uniquePrChainCount(slots), 1);
});

test('recordPrSupersede: different exercises keep independent badges', () => {
    const slots = {};
    recordPrSupersede(slots, '0:0', pr(100));
    recordPrSupersede(slots, '1:0', pr(50));
    assert.deepEqual(Object.keys(slots).sort(), ['0:0', '1:0']);
    assert.equal(uniquePrChainCount(slots), 2);

    // A supersede on exercise 0 must not touch exercise 1.
    recordPrSupersede(slots, '0:1', pr(200));
    assert.deepEqual(Object.keys(slots).sort(), ['0:1', '1:0']);
    assert.equal(uniquePrChainCount(slots), 2);
});

test('uniquePrChainCount: empty map is 0', () => {
    assert.equal(uniquePrChainCount({}), 0);
});

test('uniquePrChainCount: counts distinct exercises, not slots', () => {
    // Defensive: even if two slots of one exercise lingered, count is per-exercise.
    const slots = { '0:0': pr(1), '0:1': pr(2), '2:0': pr(3) };
    assert.equal(uniquePrChainCount(slots), 2);
});

// --- Item R3-7: full recompute restores superseded badges after edits. ---

test('recomputePrSlots: editing away a superseding set restores the earlier badge', () => {
    // Prior best volume 900. Set1 100x10 (1000) -> PR. Set2 100x12 (1200) ->
    // badge moves to set2, count stays 1 (single chain).
    const isPr = makeIsPr(900);
    const before = recomputePrSlots(
        [{ exerciseId: 'sq', sets: [
            { slot: 0, weight: 100, reps: 10 },
            { slot: 1, weight: 100, reps: 12 },
        ] }], isPr);
    assert.deepEqual(Object.keys(before), ['0:1']);
    assert.equal(uniquePrChainCount(before), 1);

    // Edit set2 down to 80x8 (640) -> no longer a PR. Set1's badge returns.
    const after = recomputePrSlots(
        [{ exerciseId: 'sq', sets: [
            { slot: 0, weight: 100, reps: 10 },
            { slot: 1, weight: 80, reps: 8 },
        ] }], isPr);
    assert.deepEqual(Object.keys(after), ['0:0']);
    assert.equal(uniquePrChainCount(after), 1);
});

test('recomputePrSlots: deleting the superseding set restores the earlier badge', () => {
    const isPr = makeIsPr(900);
    const after = recomputePrSlots(
        [{ exerciseId: 'sq', sets: [
            { slot: 0, weight: 100, reps: 10 },
        ] }], isPr);
    assert.deepEqual(Object.keys(after), ['0:0']);
    assert.equal(uniquePrChainCount(after), 1);
});

test('recomputePrSlots: order-based on slots, not insertion time (mid-list resequence)', () => {
    // Sets recorded out of slot order in the array; recompute must evaluate by
    // slot. Slot0=1000, slot1=900 (not PR vs slot0), slot2=1200 (PR, supersedes).
    const isPr = makeIsPr(800);
    const slots = recomputePrSlots(
        [{ exerciseId: 'bp', sets: [
            { slot: 2, weight: 100, reps: 12 },  // inserted first, but slot 2
            { slot: 0, weight: 100, reps: 10 },
            { slot: 1, weight: 90, reps: 10 },
        ] }], isPr);
    // slot0 PR vs baseline, slot1 not a PR, slot2 supersedes -> only slot2 survives.
    assert.deepEqual(Object.keys(slots), ['0:2']);
    assert.equal(uniquePrChainCount(slots), 1);
});

test('recomputePrSlots: a newly-larger mid-list edit keeps the best slot', () => {
    // slot0 1000 (PR), slot1 edited up to 100x15 (1500, supersedes). Best is slot1.
    const isPr = makeIsPr(900);
    const slots = recomputePrSlots(
        [{ exerciseId: 'dl', sets: [
            { slot: 0, weight: 100, reps: 10 },
            { slot: 1, weight: 100, reps: 15 },
        ] }], isPr);
    assert.deepEqual(Object.keys(slots), ['0:1']);
});

test('recomputePrSlots: independent exercises keep independent badges', () => {
    const isPr = makeIsPr(0);
    const slots = recomputePrSlots(
        [
            { exerciseId: 'a', sets: [{ slot: 0, weight: 50, reps: 5 }] },
            { exerciseId: 'b', sets: [{ slot: 0, weight: 60, reps: 5 }] },
        ], isPr);
    assert.deepEqual(Object.keys(slots).sort(), ['0:0', '1:0']);
    assert.equal(uniquePrChainCount(slots), 2);
});
