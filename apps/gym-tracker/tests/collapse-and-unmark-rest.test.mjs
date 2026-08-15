// The auto-collapse state machine and the unmark-cancels-rest rule.
//
// Why it matters: completed exercises collapse to keep the next exercise on
// screen; a user who expands a completed card to look at it must not have it
// snap shut on every re-render (the sticky-suppress false), but committing or
// re-committing a set is a deliberate action that re-arms auto-collapse (#23).
// Unmarking the set that started a rest timer cancels that rest (Bugs B+C):
// the exercise is no longer in the post-set state that justified the timer.
//
// These tests run the REAL methods lifted from workout-view.js source text
// (toggleExerciseCollapse, _recomputeExerciseDerivedState, deleteSet,
// _seedCollapseStateFromSession) against a state stub. The previous version of
// this file hand-mirrored the logic and had ALREADY drifted: its commit mirror
// still guarded on `!== false`, while the real commit path re-arms collapse
// unconditionally when the exercise completes.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, buildMethods, extractClassMethod } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');
const methods = buildMethods(
    src,
    ['toggleExerciseCollapse', '_recomputeExerciseDerivedState', 'deleteSet', '_seedCollapseStateFromSession'],
    {},
    'workout-view.js'
);

function makeExercise(committedSets, targetSets) {
    return { sets: Array.from({ length: committedSets }, (_, i) => ({ slot: i })), targetSets };
}

function makeView(exercises) {
    const view = Object.create(methods);
    view.currentWorkoutSession = { exercises };
    view.collapsedExercises = {};
    view._prevCompleteState = {};
    view._feelModalShown = {};
    view.activeRestExerciseIndex = -1;
    view.activeRestTimerId = null;
    view.skipRestCalls = 0;
    // Collaborators the extracted methods call but whose behavior is out of
    // scope here. skipRest is counted so the cancel rule is observable.
    view.rerenderExercise = () => {};
    view.rebuildSessionPrSlots = () => {};
    view._exerciseReachesMax = () => false;
    view.skipRest = function () {
        this.skipRestCalls++;
        this.activeRestTimerId = null;
    };
    return view;
}

/**
 * Drive the commit path's collapse bookkeeping. commitPlannedSet itself is
 * DOM-heavy (inputs, toasts, PR checks), but its collapse block is the same
 * rule saveSetEdit reaches through _recomputeExerciseDerivedState(i, true):
 * a deliberate set action arms auto-collapse unconditionally. The static test
 * at the bottom pins that equivalence against commitPlannedSet's source.
 */
function commitSet(view, i) {
    const exercise = view.currentWorkoutSession.exercises[i];
    exercise.sets.push({ slot: exercise.sets.length });
    return view._recomputeExerciseDerivedState(i, true);
}

/** Effective collapsed state, mirroring how renderExerciseEntry reads it. */
function isCollapsed(view, i) {
    const exercise = view.currentWorkoutSession.exercises[i];
    const targetSets = Math.max(1, exercise.targetSets || 3);
    const isComplete = exercise.sets.length >= targetSets;
    return isComplete
        ? (view.collapsedExercises[i] !== false)
        : !!view.collapsedExercises[i];
}

// ---------------------------------------------------------------------------
// 1. Basic auto-collapse on complete
// ---------------------------------------------------------------------------

test('Collapse: completing all sets auto-collapses', () => {
    const view = makeView([makeExercise(0, 3)]);
    commitSet(view, 0);
    commitSet(view, 0);
    commitSet(view, 0);
    assert.equal(isCollapsed(view, 0), true, 'exercise collapses after 3/3');
    assert.equal(view.collapsedExercises[0], true);
    assert.equal(view._prevCompleteState[0], true);
});

test('Collapse: incomplete exercise stays expanded by default', () => {
    const view = makeView([makeExercise(0, 3)]);
    commitSet(view, 0);
    commitSet(view, 0);
    assert.equal(isCollapsed(view, 0), false, '2/3 stays expanded');
});

// ---------------------------------------------------------------------------
// 2. Manual expand while complete, then unmark and remark
// ---------------------------------------------------------------------------

test('Collapse: manual expand after complete, then unmark+remark re-collapses', () => {
    const view = makeView([makeExercise(0, 2)]);
    commitSet(view, 0);
    commitSet(view, 0);
    assert.equal(isCollapsed(view, 0), true, 'auto-collapsed');

    view.toggleExerciseCollapse(0);
    assert.equal(isCollapsed(view, 0), false, 'manually expanded');
    assert.equal(view.collapsedExercises[0], false, 'sticky false set');

    view.deleteSet(0, 1);
    assert.equal(view.collapsedExercises[0], undefined, 'sticky false cleared on incomplete');
    assert.equal(view._prevCompleteState[0], false);

    commitSet(view, 0);
    assert.equal(isCollapsed(view, 0), true, 're-collapsed on re-complete');
    assert.equal(view.collapsedExercises[0], true);
});

test('Collapse: #23 - a deliberate re-commit re-arms collapse even while sticky-expanded', () => {
    // saveSetEdit and commitPlannedSet both treat a set action as deliberate:
    // if the exercise is complete afterwards it collapses, manual expand or not.
    const view = makeView([makeExercise(2, 2)]);
    view._prevCompleteState[0] = true;
    view.collapsedExercises[0] = false; // user expanded the complete exercise
    view._recomputeExerciseDerivedState(0, true); // deliberate action (armCollapse)
    assert.equal(view.collapsedExercises[0], true, 'deliberate action overrides the suppression');
});

test('Collapse: a passive recompute respects the manual-expand suppression', () => {
    const view = makeView([makeExercise(2, 2)]);
    view._prevCompleteState[0] = true;
    view.collapsedExercises[0] = false;
    view._recomputeExerciseDerivedState(0); // armCollapse defaults to false
    assert.equal(view.collapsedExercises[0], false, 'passive paths leave "opened to look" open');
});

// ---------------------------------------------------------------------------
// 3. Two full cycles: the cycle is deterministic (Bug A root cause)
// ---------------------------------------------------------------------------

test('Collapse: two complete->expand->unmark->remark cycles both auto-collapse', () => {
    const view = makeView([makeExercise(0, 3)]);
    for (const cycle of [1, 2]) {
        while (view.currentWorkoutSession.exercises[0].sets.length < 3) commitSet(view, 0);
        assert.equal(isCollapsed(view, 0), true, `cycle${cycle}: auto-collapsed`);

        view.toggleExerciseCollapse(0);
        assert.equal(isCollapsed(view, 0), false, `cycle${cycle}: expanded`);

        view.deleteSet(0, 2);
        assert.equal(view.collapsedExercises[0], undefined, `cycle${cycle}: sticky cleared`);

        commitSet(view, 0);
        assert.equal(isCollapsed(view, 0), true, `cycle${cycle}: re-collapsed`);
        view.deleteSet(0, 2); // reset for next cycle
        view.currentWorkoutSession.exercises[0].sets = [];
        view.collapsedExercises = {};
        view._prevCompleteState = {};
    }
});

// ---------------------------------------------------------------------------
// 4. Bug A root cause: expanding an INCOMPLETE exercise must not store the
//    sticky false that blocks a future auto-collapse
// ---------------------------------------------------------------------------

test('Collapse: toggle expand on incomplete exercise does not block future auto-collapse', () => {
    const view = makeView([makeExercise(0, 3)]);

    view.toggleExerciseCollapse(0);
    assert.equal(view.collapsedExercises[0], true, 'collapsed incomplete exercise');

    view.toggleExerciseCollapse(0);
    assert.equal(view.collapsedExercises[0], undefined,
        'expanding an incomplete exercise deletes the entry instead of storing false');

    commitSet(view, 0);
    commitSet(view, 0);
    commitSet(view, 0);
    assert.equal(isCollapsed(view, 0), true,
        'auto-collapse fires even after a prior toggle on the incomplete exercise');
});

test('Invariant: collapsedExercises[i]===false only appears when expanding a complete exercise', () => {
    const view = makeView([makeExercise(0, 2)]);

    commitSet(view, 0);
    assert.notEqual(view.collapsedExercises[0], false, 'after 1/2 sets, not false');

    commitSet(view, 0);
    assert.equal(view.collapsedExercises[0], true, 'complete: auto-collapsed');

    view.toggleExerciseCollapse(0);
    assert.equal(view.collapsedExercises[0], false, 'false only here: expanding a complete exercise');

    view.deleteSet(0, 1);
    assert.equal(view.collapsedExercises[0], undefined, 'false cleared when going incomplete');
});

// ---------------------------------------------------------------------------
// 5. Restore seed (_seedCollapseStateFromSession)
// ---------------------------------------------------------------------------

test('Restore seed: complete exercises get collapsed=true, incomplete are untouched', () => {
    const view = makeView([makeExercise(3, 3), makeExercise(1, 3)]);
    view._seedCollapseStateFromSession();
    assert.equal(view.collapsedExercises[0], true, 'complete exercise seeded collapsed');
    assert.equal(view._prevCompleteState[0], true, 'prevCompleteState seeded');
    assert.equal(view.collapsedExercises[1], undefined, 'incomplete exercise not touched');
    assert.equal(view._prevCompleteState[1], undefined);
});

test('Restore seed: never stores the sticky false that would block auto-collapse', () => {
    const view = makeView([makeExercise(3, 3), makeExercise(1, 3)]);
    view._seedCollapseStateFromSession();
    assert.notEqual(view.collapsedExercises[0], false);
    assert.notEqual(view.collapsedExercises[1], false);
});

test('Restore seed: extra sets beyond targetSets count as complete', () => {
    const view = makeView([makeExercise(4, 3)]);
    view._seedCollapseStateFromSession();
    assert.equal(view.collapsedExercises[0], true, '4 sets >= 3 target is complete');
});

test('Restore seed: a seeded exercise supports expand->unmark->remark-re-collapse', () => {
    const view = makeView([makeExercise(3, 3)]);
    view._seedCollapseStateFromSession();

    view.toggleExerciseCollapse(0);
    assert.equal(view.collapsedExercises[0], false, 'sticky false set (exercise is complete)');

    view.deleteSet(0, 2);
    assert.equal(view.collapsedExercises[0], undefined, 'sticky cleared after going incomplete');

    commitSet(view, 0);
    assert.equal(isCollapsed(view, 0), true, 're-collapsed after remark');
});

// ---------------------------------------------------------------------------
// 6. Unmark cancels rest (Bugs B+C), via the REAL deleteSet
// ---------------------------------------------------------------------------

test('Unmark-cancels-rest: deleting a set cancels rest running for the same exercise', () => {
    const view = makeView([makeExercise(2, 3)]);
    view.activeRestExerciseIndex = 0;
    view.activeRestTimerId = 42;
    view.deleteSet(0, 1);
    assert.equal(view.skipRestCalls, 1, 'skipRest fired');
});

test('Unmark-cancels-rest: rest for a DIFFERENT exercise keeps running', () => {
    const view = makeView([makeExercise(2, 3), makeExercise(1, 3)]);
    view.activeRestExerciseIndex = 0;
    view.activeRestTimerId = 42;
    view.deleteSet(1, 0);
    assert.equal(view.skipRestCalls, 0, 'rest for exercise 0 untouched by exercise 1 unmark');
});

test('Unmark-cancels-rest: no active timer means nothing to cancel', () => {
    const view = makeView([makeExercise(2, 3)]);
    view.activeRestExerciseIndex = 0;
    view.activeRestTimerId = null;
    view.deleteSet(0, 1);
    assert.equal(view.skipRestCalls, 0);
});

// ---------------------------------------------------------------------------
// 7. deleteSet side contracts the state machine depends on
// ---------------------------------------------------------------------------

test('deleteSet: removes by stable slot and preserves sticky values for the row', () => {
    const view = makeView([{ sets: [{ slot: 0, weight: 60, reps: 8 }, { slot: 1, weight: 80, reps: 5 }], targetSets: 2 }]);
    view._prevCompleteState[0] = true;
    view.deleteSet(0, 1);
    const exercise = view.currentWorkoutSession.exercises[0];
    assert.equal(exercise.sets.length, 1);
    assert.equal(exercise.sets[0].slot, 0, 'the other slot survives');
    assert.deepEqual(
        { weight: exercise.stickyValues[1].weight, reps: exercise.stickyValues[1].reps },
        { weight: 80, reps: 5 },
        'deleted values are kept so re-checking the row repopulates them'
    );
});

// ---------------------------------------------------------------------------
// 8. Pin the commit path's collapse rule in commitPlannedSet's own source, so
//    the commitSet() driver above cannot drift from the real commit behavior.
// ---------------------------------------------------------------------------

test('commitPlannedSet source arms auto-collapse unconditionally when complete (#23)', () => {
    const body = extractClassMethod(src, 'commitPlannedSet', 'workout-view.js');
    const armIdx = body.indexOf('this.collapsedExercises[exerciseIndex] = true;');
    assert.notEqual(armIdx, -1, 'commit path sets collapsed=true');
    assert.ok(!body.includes("collapsedExercises[exerciseIndex] !== false"),
        'commit path must NOT guard on the sticky false (a commit is a deliberate action)');
    assert.ok(body.includes('this._prevCompleteState[exerciseIndex] = isNowComplete;'),
        'commit path records complete state for deleteSet\'s re-trigger logic');
});
