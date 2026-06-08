import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restTickCues, isWorkoutComplete } from '../js/utils/rest-cues.js';

// --- restTickCues (Item 2) -------------------------------------------------

test('restTickCues: with 10/5, warning fires only at 10s', () => {
    // Above the warning second: nothing.
    assert.deepEqual(restTickCues(12, 10, 5), { warn: false, urgent: false });
    // Exactly the warning second: warn, not yet urgent.
    assert.deepEqual(restTickCues(10, 10, 5), { warn: true, urgent: false });
    // Between warning and countdown: nothing.
    assert.deepEqual(restTickCues(7, 10, 5), { warn: false, urgent: false });
});

test('restTickCues: with 10/5, urgent (pips) begins at 5s and warn stays off', () => {
    assert.deepEqual(restTickCues(5, 10, 5), { warn: false, urgent: true });
    assert.deepEqual(restTickCues(1, 10, 5), { warn: false, urgent: true });
    // Zero is not urgent (rest is over).
    assert.deepEqual(restTickCues(0, 10, 5), { warn: false, urgent: false });
});

test('restTickCues: countdown start of 10 makes pips begin at 10s', () => {
    assert.equal(restTickCues(10, 10, 10).urgent, true);
    assert.equal(restTickCues(11, 10, 10).urgent, false);
});

test('restTickCues: first warning Off (0) never warns', () => {
    for (let r = 1; r <= 30; r++) {
        assert.equal(restTickCues(r, 0, 5).warn, false, `r=${r}`);
    }
});

test('restTickCues: warning at or inside the countdown window is suppressed', () => {
    // First warning 5 with countdown 5 -> warning would overlap pips, so off.
    assert.equal(restTickCues(5, 5, 5).warn, false);
    // First warning 3 with countdown 5 -> warning <= countdown, off.
    assert.equal(restTickCues(3, 3, 5).warn, false);
});

// --- isWorkoutComplete (Item 12) -------------------------------------------

const ex = (targetSets, count) => ({ targetSets, sets: Array.from({ length: count }) });

test('isWorkoutComplete: false until the last exercise has all its sets', () => {
    assert.equal(isWorkoutComplete([ex(3, 3), ex(3, 2)]), false);
    assert.equal(isWorkoutComplete([ex(3, 3), ex(3, 3)]), true);
});

test('isWorkoutComplete: empty session is not complete', () => {
    assert.equal(isWorkoutComplete([]), false);
});

test('isWorkoutComplete: superset arrangement completes only when both groups full', () => {
    // Two supersetted exercises (3 sets each) interleaved with a solo lift.
    const a = { groupId: 'g1', targetSets: 3, sets: Array.from({ length: 3 }) };
    const b = { groupId: 'g1', targetSets: 3, sets: Array.from({ length: 2 }) };
    const solo = ex(4, 4);
    assert.equal(isWorkoutComplete([a, b, solo]), false);
    b.sets = Array.from({ length: 3 });
    assert.equal(isWorkoutComplete([a, b, solo]), true);
});

test('isWorkoutComplete: defaults targetSets to 3 when missing', () => {
    assert.equal(isWorkoutComplete([{ sets: Array.from({ length: 3 }) }]), true);
    assert.equal(isWorkoutComplete([{ sets: Array.from({ length: 2 }) }]), false);
});
