// Active-workout persistence and recovery (GT-01, the BLOCKER).
//
// Two independent failures made an in-progress workout disposable:
//
//   1. NOTHING WROTE. `workout-view.js` had six `saveActiveWorkout` call
//      sites - start, unit switch, pause, resync, feel marking, swap - and
//      the ones that matter were not among them. `commitPlannedSet`,
//      `saveSetEdit` and `deleteSet` never persisted, so the stored blob read
//      `sets: []` while the screen read "2 / 4 sets". Reloading lost the lot.
//   2. NOTHING RESTORED. Every recovery path gated on `paused === true`
//      (`paused-banner.js`, `app.updateGlobalFab`, `app.handleGlobalFabClick`,
//      `home-view`), and a workout that was interrupted rather than
//      deliberately paused is stored with `paused: false`. It was unreachable
//      forever, and the stale record lingered invisibly.
//
// This file pins BOTH halves: the source-level guarantee that every mutation
// path routes through `persistActiveWorkout`, and the recovery predicate that
// decides what may be offered. The end-to-end reload/resume journey is driven
// in `tests/browser/suites/apps.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    activeWorkoutBannerCopy,
    activeWorkoutSetCount,
    hasRecoverableWorkout,
    readableActiveWorkout,
    wasExplicitlyPaused,
} from '../js/utils/active-workout.js';
import { loadSource, extractClassMethod } from './helpers/source-extract.mjs';

const src = loadSource('js/views/workout-view.js');

// ---------------------------------------------------------------------------
// Part 1: every mutation path writes
// ---------------------------------------------------------------------------

/**
 * Mutation paths that change committed workout state. Each one must reach
 * storage; the audit's blocker was that the first three did not.
 */
const MUTATORS = [
    'commitPlannedSet',   // complete a planned set
    'saveSetEdit',        // edit a completed set
    'deleteSet',          // delete / un-mark a set
    'addPlannedRow',      // add a set row
    'removePlannedRow',   // remove a set row
    'setSessionUnit',     // switch the session's entry unit
    'setExerciseFeel',    // mark how an exercise felt
    'pickSwapExercise',   // swap an exercise for this session
    'resyncSessionWithProgram', // re-merge after editing the program
    'startWorkout',       // the session is recoverable from the moment it exists
    'resumeWorkout',      // resuming clears the paused flag; write that through
];

for (const name of MUTATORS) {
    test(`${name} persists the active workout`, () => {
        const body = extractClassMethod(src, name, 'workout-view.js');
        assert.match(
            body,
            /this\.persistActiveWorkout\(\)/,
            `${name} mutates workout state but never writes it to storage`,
        );
    });
}

test('the exercise-notes keystroke handler persists (debounced)', () => {
    // Notes are per-keystroke, so they are the ONE path allowed to coalesce.
    const wiring = extractClassMethod(src, 'wireWorkoutActions', 'workout-view.js');
    assert.match(wiring, /gt-exercise-notes-input[\s\S]*?persistActiveWorkoutSoon\(\)/);
});

test('a debounced write is always flushed before the state can be lost', () => {
    // Collapsing the notes, pausing, and the page-hide guard each pay whatever
    // the debounce still owes.
    for (const name of ['_collapseExerciseNotes', 'pauseAndSaveWorkout', 'setupPersistenceGuards']) {
        const body = extractClassMethod(src, name, 'workout-view.js');
        assert.match(body, /flushPendingPersist\(\)/, `${name} must flush`);
    }
});

test('the page-hide guard covers both tab close and app backgrounding', () => {
    const body = extractClassMethod(src, 'setupPersistenceGuards', 'workout-view.js');
    assert.match(body, /'pagehide'/);
    assert.match(body, /visibilitychange/);
});

test('persistActiveWorkout writes synchronously, not on a timer', () => {
    const body = extractClassMethod(src, 'persistActiveWorkout', 'workout-view.js');
    assert.match(body, /storageService\.saveActiveWorkout\(/);
    assert.doesNotMatch(body, /setTimeout/, 'a set commit must not be deferred');
});

test('persistActiveWorkout refuses to write a finished session', () => {
    const body = extractClassMethod(src, 'persistActiveWorkout', 'workout-view.js');
    assert.match(body, /session\.completed/);
});

test('persistActiveWorkout keeps elapsed time fresh without faking a pause', () => {
    // An interrupted workout has no pausedAt, so without this it resumed at
    // 0:00 no matter how long it had been running.
    const body = extractClassMethod(src, 'persistActiveWorkout', 'workout-view.js');
    assert.match(body, /elapsedBeforePause\s*=/);
    assert.match(body, /!session\.paused/, 'a paused session keeps the elapsed it stopped at');
});

test('finishing and discarding clear the active workout', () => {
    for (const name of ['finishWorkout', 'discardWorkout', 'endWorkout', 'discardPausedWorkout']) {
        const body = extractClassMethod(src, name, 'workout-view.js');
        assert.match(body, /clearActiveWorkout\(\)/, `${name} must clear the stored workout`);
    }
});

test('discarding also drops any pending debounced write', () => {
    // Otherwise the debounce could fire after the clear and resurrect it.
    for (const name of ['endWorkout', 'discardPausedWorkout']) {
        const body = extractClassMethod(src, name, 'workout-view.js');
        assert.match(body, /_persistTimer/, `${name} must cancel the pending write`);
    }
});

// ---------------------------------------------------------------------------
// Part 2: what may be recovered
// ---------------------------------------------------------------------------

const workout = (over = {}) => ({
    id: 123,
    workoutDayName: 'Push Day A',
    paused: false,
    completed: false,
    elapsedBeforePause: 0,
    exercises: [{ exerciseId: 3, sets: [{ weight: 60, reps: 10, completed: true, slot: 0 }] }],
    ...over,
});

test('an INTERRUPTED workout is recoverable - the whole point of the fix', () => {
    const raw = workout({ paused: false });
    assert.equal(hasRecoverableWorkout(raw), true);
    assert.notEqual(readableActiveWorkout(raw), null);
    assert.equal(wasExplicitlyPaused(raw), false);
});

test('a deliberately PAUSED workout stays recoverable, exactly as before', () => {
    const raw = workout({ paused: true, pausedAt: '2026-08-19T10:00:00Z' });
    assert.equal(hasRecoverableWorkout(raw), true);
    assert.equal(wasExplicitlyPaused(raw), true);
});

test('a COMPLETED session is never resurrected', () => {
    // finishWorkout clears the key, but a crash between "save session" and
    // "clear active" must not offer the workout the user already finished.
    assert.equal(hasRecoverableWorkout(workout({ completed: true })), false);
});

test('a corrupt or empty blob is not offered', () => {
    for (const bad of [null, undefined, 'nonsense', 42, [], {}]) {
        assert.equal(hasRecoverableWorkout(bad), false, `${JSON.stringify(bad)} is not a workout`);
    }
    assert.equal(hasRecoverableWorkout(workout({ exercises: [] })), false, 'no exercises, nothing to resume');
    assert.equal(hasRecoverableWorkout(workout({ exercises: 'oops' })), false);
    assert.equal(hasRecoverableWorkout(workout({ id: null })), false);
});

test('a workout with zero logged sets is still recoverable', () => {
    // The lifter started it and picked a program; that is worth restoring even
    // before the first set lands.
    assert.equal(hasRecoverableWorkout(workout({ exercises: [{ exerciseId: 3, sets: [] }] })), true);
});

test('the banner counts the sets that would be restored', () => {
    const raw = workout({
        exercises: [
            { sets: [{ slot: 0 }, { slot: 1 }] },
            { sets: [{ slot: 0 }] },
        ],
    });
    assert.equal(activeWorkoutSetCount(raw), 3);
    assert.equal(activeWorkoutBannerCopy(raw).sets, 3);
});

test('the banner explains an interruption but not a deliberate pause', () => {
    const paused = activeWorkoutBannerCopy(workout({ paused: true }));
    assert.equal(paused.title, 'Paused Workout');
    assert.equal(paused.note, '', 'the user chose this; no explanation needed');

    const interrupted = activeWorkoutBannerCopy(workout({ paused: false }));
    assert.equal(interrupted.title, 'Unfinished Workout');
    assert.match(interrupted.note, /interrupted/i, 'this happened TO them; say so');
});

// ---------------------------------------------------------------------------
// Part 3: no recovery path may re-introduce the `paused` gate
// ---------------------------------------------------------------------------

/** Source with comments stripped, so a docstring quoting old code cannot
 *  satisfy (or fail) an assertion about the code itself. */
const codeOnly = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('the recovery banner renders for any recoverable workout, not just paused ones', () => {
    const banner = codeOnly(loadSource('js/views/paused-banner.js'));
    assert.match(banner, /readableActiveWorkout\(/);
    assert.doesNotMatch(
        banner,
        /!\s*\w+\.paused\s*\)\s*return null/,
        'the paused-only gate must not come back',
    );
});

test('the app-level resume paths gate on recoverability, not on the paused flag', () => {
    const app = codeOnly(loadSource('js/app.js'));
    assert.match(app, /hasRecoverableWorkout\(storageService\.getActiveWorkout\(\)\)/);
    assert.doesNotMatch(app, /paused && paused\.paused/, 'the old gate is gone');
});

test('resumeWorkout validates the stored blob before restoring it', () => {
    const body = extractClassMethod(src, 'resumeWorkout', 'workout-view.js');
    assert.match(body, /readableActiveWorkout\(/);
});
