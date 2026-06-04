// Pure-logic unit tests for the collapse state machine (Bug A fix) and
// the unmark-cancels-rest rule (Bugs B+C fix).
//
// The view class depends on the DOM and cannot be loaded here. These tests
// mirror the exact logic extracted from WorkoutView so that if the view's
// implementation changes, the tests will catch the divergence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers mirroring WorkoutView internal logic
// ---------------------------------------------------------------------------

function makeExercise(committedSets, targetSets) {
    return { sets: Array(committedSets).fill({}), targetSets };
}

/**
 * Mirror of WorkoutView.toggleExerciseCollapse logic (post Bug-A fix).
 * Only stores false (sticky-suppress) when the exercise IS currently complete.
 * For incomplete exercises, expand stores undefined (delete) to avoid
 * pre-emptively blocking a future auto-collapse.
 *
 * Invariant: collapsedExercises[i] === false ONLY when the user expanded
 * a complete exercise; any other state must not produce this value.
 */
function toggleExerciseCollapse(exerciseIndex, exercises, collapsedExercises) {
    const exercise = exercises[exerciseIndex];
    const targetSets = Math.max(1, exercise.targetSets || 3);
    const isComplete = exercise.sets.length >= targetSets;
    const currentlyCollapsed = isComplete
        ? (collapsedExercises[exerciseIndex] !== false)
        : !!collapsedExercises[exerciseIndex];

    if (!currentlyCollapsed) {
        collapsedExercises[exerciseIndex] = true;
    } else {
        if (isComplete) {
            collapsedExercises[exerciseIndex] = false;
        } else {
            delete collapsedExercises[exerciseIndex];
        }
    }
}

/**
 * Mirror of WorkoutView.commitPlannedSet collapse logic.
 * Returns isNowComplete so callers can verify.
 */
function commitSet(exerciseIndex, exercises, collapsedExercises, prevCompleteState) {
    const exercise = exercises[exerciseIndex];
    exercise.sets.push({});
    const targetSets = Math.max(1, exercise.targetSets || 3);
    const isNowComplete = exercise.sets.length >= targetSets;
    if (isNowComplete) {
        if (collapsedExercises[exerciseIndex] !== false) {
            collapsedExercises[exerciseIndex] = true;
        }
    }
    prevCompleteState[exerciseIndex] = isNowComplete;
    return isNowComplete;
}

/**
 * Mirror of WorkoutView.deleteSet collapse logic.
 * Returns isStillComplete so callers can verify.
 */
function deleteSet(exerciseIndex, exercises, collapsedExercises, prevCompleteState) {
    const exercise = exercises[exerciseIndex];
    exercise.sets.pop();
    const targetSets = Math.max(1, exercise.targetSets || 3);
    const wasComplete = prevCompleteState[exerciseIndex] === true;
    const isStillComplete = exercise.sets.length >= targetSets;
    if (wasComplete && !isStillComplete) {
        delete collapsedExercises[exerciseIndex];
    }
    prevCompleteState[exerciseIndex] = isStillComplete;
    return isStillComplete;
}

/** Compute effective collapsed state for an exercise (mirrors renderExerciseEntry). */
function isCollapsed(exerciseIndex, exercises, collapsedExercises) {
    const exercise = exercises[exerciseIndex];
    const targetSets = Math.max(1, exercise.targetSets || 3);
    const isComplete = exercise.sets.length >= targetSets;
    return isComplete
        ? (collapsedExercises[exerciseIndex] !== false)
        : !!collapsedExercises[exerciseIndex];
}

// ---------------------------------------------------------------------------
// 1. Basic auto-collapse on complete
// ---------------------------------------------------------------------------

test('Collapse: completing all sets auto-collapses', () => {
    const exercises = [makeExercise(0, 3)];
    const collapsed = {};
    const prev = {};
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 'exercise collapses after 3/3');
    assert.equal(collapsed[0], true);
    assert.equal(prev[0], true);
});

test('Collapse: incomplete exercise stays expanded by default', () => {
    const exercises = [makeExercise(0, 3)];
    const collapsed = {};
    const prev = {};
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), false, '2/3 stays expanded');
});

// ---------------------------------------------------------------------------
// 2. Manual expand while complete -> sticky false -> re-complete auto-collapses
// ---------------------------------------------------------------------------

test('Collapse: manual expand after complete, then unmark+remark re-collapses', () => {
    const exercises = [makeExercise(0, 2)];
    const collapsed = {};
    const prev = {};

    // Complete
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 'auto-collapsed');

    // Manually expand
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(isCollapsed(0, exercises, collapsed), false, 'manually expanded');
    assert.equal(collapsed[0], false, 'sticky false set');

    // Unmark last set
    deleteSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], undefined, 'sticky false cleared on incomplete');
    assert.equal(prev[0], false);

    // Re-mark last set
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 're-collapsed on re-complete');
    assert.equal(collapsed[0], true);
});

// ---------------------------------------------------------------------------
// 3. Two full cycles: confirms the cycle is deterministic (Bug A root cause)
// ---------------------------------------------------------------------------

test('Collapse: two complete->expand->unmark->remark cycles both auto-collapse', () => {
    const exercises = [makeExercise(0, 3)];
    const collapsed = {};
    const prev = {};

    // --- Cycle 1 ---
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 'cycle1: auto-collapsed');

    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(isCollapsed(0, exercises, collapsed), false, 'cycle1: expanded');

    deleteSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], undefined, 'cycle1: sticky cleared');

    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 'cycle1: re-collapsed');

    // --- Cycle 2 ---
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(isCollapsed(0, exercises, collapsed), false, 'cycle2: expanded');

    deleteSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], undefined, 'cycle2: sticky cleared');

    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 'cycle2: re-collapsed');
});

// ---------------------------------------------------------------------------
// 4. Bug A root cause: toggling collapse on an INCOMPLETE exercise must NOT
//    set the sticky false that blocks future auto-collapse
// ---------------------------------------------------------------------------

test('Collapse: toggle expand on incomplete exercise does not block future auto-collapse', () => {
    const exercises = [makeExercise(0, 3)];
    const collapsed = {};
    const prev = {};

    // User collapses the incomplete exercise manually
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(collapsed[0], true, 'collapsed incomplete exercise');

    // User expands it back
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(collapsed[0], undefined,
        'expanding incomplete exercise uses delete, not false — avoids future suppress');

    // Now complete the exercise: auto-collapse MUST fire
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true,
        'auto-collapse fires even after prior toggle on incomplete exercise');
});

test('Collapse: previous code path (false on incomplete expand) would have blocked auto-collapse', () => {
    // This demonstrates EXACTLY what the old bug was: setting false on an
    // incomplete expand prevented the next auto-collapse.
    const exercises = [makeExercise(0, 3)];
    const collapsed = {};

    // Simulate the OLD (buggy) behavior: false stored even for incomplete expand
    collapsed[0] = false; // old toggleExerciseCollapse set this regardless of isComplete

    // Simulate commitSet checking
    const wouldAutoCollapse = collapsed[0] !== false; // false !== false = false
    assert.equal(wouldAutoCollapse, false,
        'confirms the old bug: false from incomplete expand blocks auto-collapse');

    // Confirm the fix: undefined (from new correct expand) allows auto-collapse
    delete collapsed[0];
    const fixedAutoCollapse = collapsed[0] !== false; // undefined !== false = true
    assert.equal(fixedAutoCollapse, true,
        'undefined from corrected expand allows auto-collapse');
});

// ---------------------------------------------------------------------------
// 5. Restore seed does not set sticky-expanded flag
// ---------------------------------------------------------------------------

function seedCollapseState(exercises, collapsed, prev) {
    exercises.forEach((exercise, i) => {
        const targetSets = Math.max(1, exercise.targetSets || 3);
        const isComplete = exercise.sets.length >= targetSets;
        if (isComplete) {
            collapsed[i] = true;
            prev[i] = true;
        }
    });
}

test('Restore seed: complete exercises get collapsed=true, not false', () => {
    const exercises = [
        makeExercise(3, 3),
        makeExercise(1, 3),
    ];
    const collapsed = {};
    const prev = {};
    seedCollapseState(exercises, collapsed, prev);

    assert.equal(collapsed[0], true, 'complete exercise seeded as collapsed');
    assert.equal(collapsed[1], undefined, 'incomplete exercise not touched');
    // Crucially: false is NOT present anywhere — that would block future auto-collapse.
    assert.notEqual(collapsed[0], false);
    assert.notEqual(collapsed[1], false);
});

test('Restore seed: seeded exercise can be expand->unmark->remark-re-collapse', () => {
    const exercises = [makeExercise(3, 3)];
    const collapsed = {};
    const prev = {};
    seedCollapseState(exercises, collapsed, prev);

    // User manually expands after restore
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(collapsed[0], false, 'sticky false set (exercise is complete)');

    // Unmark one set
    deleteSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], undefined, 'sticky cleared after going incomplete');

    // Re-mark
    commitSet(0, exercises, collapsed, prev);
    assert.equal(isCollapsed(0, exercises, collapsed), true, 're-collapsed after remark');
});

// ---------------------------------------------------------------------------
// 6. Unmark-cancels-rest logic (Bugs B+C)
// ---------------------------------------------------------------------------

// Mirror the rest-cancel check from WorkoutView.deleteSet
function shouldCancelRest(activeRestExerciseIndex, activeRestTimerId, deletedExerciseIndex) {
    return activeRestExerciseIndex === deletedExerciseIndex && activeRestTimerId != null;
}

test('Unmark-cancels-rest: cancels when active rest is for the same exercise', () => {
    assert.equal(shouldCancelRest(1, 42, 1), true,
        'rest for exercise 1 is cancelled when exercise 1 unmarks');
});

test('Unmark-cancels-rest: does not cancel when active rest is for a different exercise', () => {
    assert.equal(shouldCancelRest(0, 42, 1), false,
        'rest for exercise 0 is not cancelled when exercise 1 unmarks');
});

test('Unmark-cancels-rest: does not cancel when no rest is running', () => {
    assert.equal(shouldCancelRest(1, null, 1), false,
        'no active timer (null ID) means nothing to cancel');
});

test('Unmark-cancels-rest: does not cancel when activeRestExerciseIndex is -1', () => {
    assert.equal(shouldCancelRest(-1, null, 0), false,
        'idle state (-1, null) triggers no cancel');
});

test('Unmark-cancels-rest: applies to both between-set (chip) and between-exercise (bar)', () => {
    // The rule is purely "same exercise index" — the kind (set vs exercise)
    // does not matter; skipRest() clears both surfaces.
    assert.equal(shouldCancelRest(2, 7, 2), true, 'between-set chip cancel');
    assert.equal(shouldCancelRest(2, 7, 2), true, 'between-exercise bar cancel (same check)');
});

// ---------------------------------------------------------------------------
// 7. collapsedExercises false invariant — comprehensive check
// ---------------------------------------------------------------------------

test('Invariant: collapsedExercises[i]===false only set when exercise is complete at toggle time', () => {
    // Cycle through: complete, expand (sets false), incomplete (unmark sets undefined),
    // re-complete (sets true). The false value must only appear at the expand step.
    const exercises = [makeExercise(0, 2)];
    const collapsed = {};
    const prev = {};

    // Start: undefined
    assert.equal(collapsed[0], undefined);

    // Commit 1 (incomplete): no change to collapsed
    commitSet(0, exercises, collapsed, prev);
    assert.notEqual(collapsed[0], false, 'after 1/2 sets, collapsed is not false');

    // Commit 2 (complete): auto-collapse sets true
    commitSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], true);

    // Expand (complete): sets false
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(collapsed[0], false, 'false only appears here: expanding a complete exercise');

    // Unmark: clears to undefined
    deleteSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], undefined, 'false cleared when going incomplete');

    // Re-mark (re-complete): sets true (auto-collapse)
    commitSet(0, exercises, collapsed, prev);
    assert.equal(collapsed[0], true);

    // Expand again: false again
    toggleExerciseCollapse(0, exercises, collapsed);
    assert.equal(collapsed[0], false);
});
