/**
 * A quick workout: walk into a gym, log what you actually did, no program.
 *
 * `startWorkout` refuses without a saved program and the workout screen's
 * empty state only offered "Create Program", so logging an unplanned session
 * meant authoring a throwaway program that then lived in the Programs list
 * forever. The fix must not trade that for a worse problem: a quick workout
 * creates NO program, and its `programId` stays null.
 *
 * Null is the interesting part. `sameId` stringifies both sides, so
 * `sameId(null, null)` is `"null" === "null"` - TRUE. Every programId
 * comparison in the app is therefore a live trap for a session that has none,
 * and `_lastSessionForProgram(null)` walked straight into it: the finish
 * summary would have compared a quick workout's volume against the last
 * UNRELATED session that also had no program. That is the main regression
 * risk and it is pinned below.
 *
 * The session's lack of a program is recorded EXPLICITLY (`isQuickWorkout`)
 * rather than inferred from a null, because "no program by design" and "a
 * session saved before programId existed" are different facts and the history
 * filter has to tell them apart.
 *
 * View logic is lifted from the real source (tests/helpers/source-extract.mjs).
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunctions, buildMethods, extractClassMethod, loadSource } from './helpers/source-extract.mjs';
import { WorkoutSession } from '../js/models/WorkoutSession.js';
import { WorkoutExercise } from '../js/models/WorkoutExercise.js';
import { readableActiveWorkout } from '../js/utils/active-workout.js';
import { sameId } from '../js/utils/id-utils.js';
import { normalizeWeightUnit } from '../js/utils/units.js';
import { AnalyticsService } from '../js/services/AnalyticsService.js';

// In-memory localStorage shim: AchievementService reaches the StorageService
// singleton for the display unit. Installed before the import below.
globalThis.localStorage = {
    _store: new Map(),
    getItem(key) { return this._store.has(key) ? this._store.get(key) : null; },
    setItem(key, value) { this._store.set(key, String(value)); },
    removeItem(key) { this._store.delete(key); },
    clear() { this._store.clear(); },
};
const { AchievementService } = await import('../js/services/AchievementService.js');

const src = loadSource('js/views/workout-view.js');
const historySrc = loadSource('js/views/history-view.js');

const CATALOG = [
    { id: 7, name: 'Barbell Bench Press', category: 'chest', equipment: 'barbell', muscleGroup: 'chest' },
    { id: 12, name: 'Lat Pulldown', category: 'back', equipment: 'cable', muscleGroup: 'back' },
];

/** A DOM stub: every element answers classList/hidden/textContent harmlessly. */
function makeDocument() {
    const seen = {};
    const doc = {
        seen,
        getElementById(id) {
            if (!seen[id]) {
                seen[id] = {
                    id,
                    hidden: false,
                    textContent: '',
                    value: '',
                    dataset: {},
                    classList: { add() {}, remove() {}, toggle() {} },
                    addEventListener() {},
                    querySelector: () => null,
                };
            }
            return seen[id];
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
    };
    return doc;
}

function makeStorage() {
    const calls = { activeSaves: 0, programSaves: 0, claims: 0 };
    return {
        calls,
        saveActiveWorkout() { calls.activeSaves += 1; return true; },
        savePrograms() { calls.programSaves += 1; return true; },
        claimActiveWorkoutLock() { calls.claims += 1; },
        releaseActiveWorkoutLock() {},
        getActiveWorkoutLock: () => null,
        tabId: 'tab-1',
    };
}

function makeView({ sessions = [], programs = [] } = {}) {
    const storageService = makeStorage();
    const document = makeDocument();
    const timerService = { startWorkoutTimer() {}, getWorkoutElapsed: () => 0 };
    const toasts = [];
    const methods = buildMethods(src, [
        'startQuickWorkout',
        'addSessionExercise',
        '_lastSessionForProgram',
    ], {
        WorkoutSession,
        WorkoutExercise,
        normalizeWeightUnit,
        sameId,
        timerService,
        storageService,
        document,
        showToast: (msg, type) => toasts.push({ msg, type }),
    }, 'workout-view.js');

    const view = Object.create(methods);
    view.app = {
        settings: { weightUnit: 'kg' },
        programs,
        workoutSessions: sessions,
        exerciseDatabase: CATALOG,
        getExerciseDisplayName: (id, fallback) =>
            CATALOG.find((e) => sameId(e.id, id))?.name || fallback,
        updateGlobalFab() {},
    };
    view.toasts = toasts;
    view.storage = storageService;
    view.doc = document;
    view.rendered = 0;
    // Everything below is DOM chrome this suite does not exercise.
    view._otherTabOwnsWorkout = () => false;
    view.resetFinishWorkoutForm = () => {};
    view.setWorkoutStorageFailed = () => {};
    view.claimWorkoutLock = () => { storageService.claimActiveWorkoutLock(); };
    view.persistActiveWorkout = () => { storageService.saveActiveWorkout(); };
    view.renderActiveWorkout = () => { view.rendered += 1; };
    view.updateWorkoutTimer = () => {};
    view.armBackGuard = () => {};
    view.acquireWakeLock = () => {};
    view.openAddExercisePicker = () => { view.pickerOpened = (view.pickerOpened || 0) + 1; };
    view.scrollToCurrentExercise = () => {};
    return view;
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

test('a quick workout starts with no program and no exercises', () => {
    const view = makeView();
    view.startQuickWorkout();
    const session = view.currentWorkoutSession;
    assert.ok(session, 'no session was created');
    assert.equal(session.programId, null, 'a quick workout must not point at a program');
    assert.deepEqual(session.exercises, [], 'it starts empty; exercises are added as you go');
    assert.equal(session.isQuickWorkout, true,
        '"no program by design" must be recorded, not inferred from a null');
    assert.ok(session.startTime, 'the clock must be running');
});

test('starting one creates NO program', () => {
    const programs = [];
    const view = makeView({ programs });
    view.startQuickWorkout();
    assert.deepEqual(programs, [], 'nothing may appear in the Programs list');
    assert.equal(view.storage.calls.programSaves, 0, 'the programs store must not be written');
});

test('the session is canonical-kg stamped and records the entry unit, like any other', () => {
    const view = makeView();
    view.app.settings.weightUnit = 'lb';
    view.startQuickWorkout();
    assert.equal(view.currentWorkoutSession.unitsCanonical, true);
    assert.equal(view.currentWorkoutSession.sessionUnit, 'lb');
});

test('it is recoverable from the moment it exists', () => {
    const view = makeView();
    view.startQuickWorkout();
    assert.ok(view.storage.calls.activeSaves >= 1, 'the live workout must be persisted at once');
    assert.equal(view.storage.calls.claims, 1, 'the tab lock must be claimed');
});

test('another tab owning the workout blocks a quick start', () => {
    const view = makeView();
    view._otherTabOwnsWorkout = () => true;
    view.startQuickWorkout();
    assert.equal(view.currentWorkoutSession ?? null, null);
    assert.equal(view.toasts.length, 1, 'the user must be told where the workout is');
});

// ---------------------------------------------------------------------------
// Adding exercises as you go
// ---------------------------------------------------------------------------

test('adding an exercise appends a normal WorkoutExercise and creates no program', () => {
    const programs = [];
    const view = makeView({ programs });
    view.startQuickWorkout();
    view.addSessionExercise(7);

    const [ex] = view.currentWorkoutSession.exercises;
    assert.ok(ex instanceof WorkoutExercise, 'the set-row machinery only understands WorkoutExercise');
    assert.equal(ex.exerciseId, 7);
    assert.equal(ex.plannedExerciseId, 7);
    assert.equal(ex.exerciseName, 'Barbell Bench Press');
    assert.equal(ex.groupId, null, 'a quick exercise is never part of a superset');
    assert.ok(ex.targetSets >= 1 && ex.restSeconds > 0, 'it must carry usable set/rest defaults');
    assert.deepEqual(programs, [], 'adding an exercise must not create a program either');
});

test('a string exercise id from the picker still resolves (the sameId rule)', () => {
    const view = makeView();
    view.startQuickWorkout();
    view.addSessionExercise('12');
    assert.equal(view.currentWorkoutSession.exercises.length, 1);
    assert.equal(view.currentWorkoutSession.exercises[0].exerciseName, 'Lat Pulldown');
});

test('an unknown exercise id adds nothing', () => {
    const view = makeView();
    view.startQuickWorkout();
    view.addSessionExercise(9999);
    assert.equal(view.currentWorkoutSession.exercises.length, 0);
});

test('each added exercise is persisted and gets an increasing order', () => {
    const view = makeView();
    view.startQuickWorkout();
    const before = view.storage.calls.activeSaves;
    view.addSessionExercise(7);
    view.addSessionExercise(12);
    assert.equal(view.storage.calls.activeSaves, before + 2);
    assert.deepEqual(view.currentWorkoutSession.exercises.map((e) => e.order), [0, 1]);
});

// ---------------------------------------------------------------------------
// The null-programId trap
// ---------------------------------------------------------------------------

test('sameId(null, null) is true - which is why the guard below has to exist', () => {
    assert.equal(sameId(null, null), true);
});

test('_lastSessionForProgram(null) finds nothing', () => {
    const view = makeView({
        sessions: [
            { id: 1, programId: null, completed: true, totalVolume: 5000, sortTimestamp: '2026-09-01T10:00:00.000Z' },
            { id: 2, programId: null, completed: true, totalVolume: 9000, sortTimestamp: '2026-09-02T10:00:00.000Z' },
        ],
    });
    assert.equal(view._lastSessionForProgram(null), null,
        'without the guard a quick workout is compared against an unrelated one, "null" === "null"');
    assert.equal(view._lastSessionForProgram(undefined), null);
});

test('_lastSessionForProgram still works for a real program', () => {
    const view = makeView({
        sessions: [
            { id: 1, programId: 3, completed: true, totalVolume: 5000, sortTimestamp: '2026-09-01T10:00:00.000Z' },
            { id: 2, programId: 3, completed: true, totalVolume: 9000, sortTimestamp: '2026-09-02T10:00:00.000Z' },
        ],
    });
    assert.equal(view._lastSessionForProgram(3)?.id, 2, 'programmed workouts must be unchanged');
});

// ---------------------------------------------------------------------------
// Recovery, history, analytics, PRs
// ---------------------------------------------------------------------------

test('an empty quick workout is still recoverable', () => {
    const blob = new WorkoutSession({
        programId: null, isQuickWorkout: true, workoutDayName: 'Quick Workout', exercises: [],
    }).toJSON();
    assert.ok(readableActiveWorkout(blob),
        'the app promises an unfinished workout is ALWAYS recoverable');
});

test('an empty NON-quick blob is still rejected as corrupt', () => {
    const blob = new WorkoutSession({ programId: 3, exercises: [] }).toJSON();
    assert.equal(readableActiveWorkout(blob), null,
        'the empty-exercises rejection exists to refuse junk and must stay');
});

test('isQuickWorkout survives the pause/resume JSON round trip', () => {
    const restored = WorkoutSession.fromJSON(
        new WorkoutSession({ isQuickWorkout: true, exercises: [] }).toJSON());
    assert.equal(restored.isQuickWorkout, true);
    assert.equal(restored.programId, null);
});

test('a programmed session is never marked quick', () => {
    assert.equal(new WorkoutSession({ programId: 3 }).isQuickWorkout, false);
});

const matchesProgram = buildFunctions(
    historySrc, ['sessionMatchesProgram'], { sameId }, 'history-view.js').sessionMatchesProgram;

test('the history program filter never claims a quick workout', () => {
    const quick = { programId: null, isQuickWorkout: true, workoutDayName: 'Quick Workout' };
    assert.equal(matchesProgram(quick, 3, 'Quick Workout'), false,
        'a program literally named "Quick Workout" must not swallow quick sessions');
    assert.equal(matchesProgram(quick, 3, 'Push Day'), false);
});

test('the legacy name fallback still works for sessions saved before programId existed', () => {
    const legacy = { programId: null, workoutDayName: 'Push Day' };
    assert.equal(matchesProgram(legacy, 3, 'Push Day'), true);
    assert.equal(matchesProgram(legacy, 3, 'Pull Day'), false);
});

test('a programmed session still matches by id', () => {
    assert.equal(matchesProgram({ programId: 3 }, '3', 'Push Day'), true);
    assert.equal(matchesProgram({ programId: 4 }, '3', 'Push Day'), false);
});

/** A finished quick session: two real sets of exercise 7. */
function finishedQuickSession(id, date, weight) {
    return new WorkoutSession({
        id,
        programId: null,
        isQuickWorkout: true,
        workoutDayName: 'Quick Workout',
        date,
        startTime: `${date}T10:00:00.000Z`,
        endTime: `${date}T11:00:00.000Z`,
        completed: true,
        unitsCanonical: true,
        exercises: [{
            exerciseId: 7,
            exerciseName: 'Barbell Bench Press',
            sets: [
                { weight, reps: 8, completed: true },
                { weight, reps: 8, completed: true },
            ],
        }],
    });
}

test('a quick session counts toward volume and week stats', () => {
    const quick = finishedQuickSession(1, '2026-09-08', 60);
    assert.equal(AnalyticsService.getTotalVolume([quick]), 960);
    const stats = AnalyticsService.getWeekStats([quick], 1);
    assert.ok(stats.workouts >= 1, 'a quick workout is a workout');
});

test('a quick session counts toward personal records', () => {
    const pr = AnalyticsService.getPersonalRecords(7, [finishedQuickSession(1, '2026-09-08', 100)]);
    assert.equal(pr.maxWeight, 100, 'PRs are keyed by exercise, not by program');
});

test('a quick session earns a Strength PR like any other', () => {
    const history = [
        finishedQuickSession(1, '2026-09-01', 60),
        finishedQuickSession(2, '2026-09-04', 62.5),
    ];
    const best = finishedQuickSession(3, '2026-09-08', 80);
    const awards = AchievementService.checkExercisePRs(best, [...history, best]);
    assert.equal(awards.length, 1, 'a PR set in a quick workout is still a PR');
    assert.equal(awards[0].prExerciseName, 'Barbell Bench Press');
});

test('a quick session drives achievement progress', () => {
    const quick = finishedQuickSession(1, '2026-09-08', 60);
    const total = AchievementService.getDefaultAchievements()
        .find((a) => a.id === 'first-workout');
    const progress = AchievementService.calculateProgress(total, [quick], { firstDayOfWeek: 1 });
    assert.ok(progress >= 1, 'achievements read sessions, and a quick session is one');
    const volume = AchievementService.getDefaultAchievements()
        .find((a) => a.requirement?.type === 'total-volume');
    assert.ok(
        AchievementService.calculateProgress(volume, [quick], { firstDayOfWeek: 1 }) > 0,
        'a quick workout\'s volume counts toward lifetime volume badges');
});

test('prefill is keyed by EXERCISE, so a quick workout inherits programmed history', () => {
    // The previous session was a normal programmed one; the quick workout that
    // follows must still start from it, because prefill joins on exerciseId.
    const programmed = finishedQuickSession(1, '2026-09-01', 72.5);
    programmed.programId = 3;
    programmed.isQuickWorkout = false;

    const prefill = buildMethods(src, ['getPreviousExerciseData'], { sameId }, 'workout-view.js');
    const view = Object.create(prefill);
    view.app = { workoutSessions: [programmed] };
    assert.deepEqual(view.getPreviousExerciseData(7).map((s) => s.weight), [72.5, 72.5]);
});

// ---------------------------------------------------------------------------
// Wiring: the routes in, and the program-only affordances kept out
// ---------------------------------------------------------------------------

test('the workout screen offers a quick workout when there are no programs', () => {
    const body = extractClassMethod(src, 'renderProgramSelection', 'workout-view.js');
    assert.ok(body.includes('start-quick-workout'),
        'the cold-start empty state still dead-ends at "Create Program"');
});

test('the delegated click handler routes both quick-workout actions', () => {
    const body = extractClassMethod(src, 'wireWorkoutActions', 'workout-view.js');
    assert.ok(body.includes("case 'start-quick-workout'"), 'the start route is not wired');
    assert.ok(body.includes("case 'add-session-exercise'"), 'the add-exercise route is not wired');
});

test('"Edit program" refuses a workout that has no program', () => {
    const body = extractClassMethod(src, 'editProgramFromWorkout', 'workout-view.js');
    assert.match(body, /programId\s*==\s*null/,
        'editProgramFromWorkout would open the program editor for a null id');
});

test('the Add exercise control is quick-workout only', () => {
    const body = extractClassMethod(src, 'renderAddExerciseFooter', 'workout-view.js');
    assert.match(body, /isQuickWorkout/,
        'a programmed workout must render exactly what it rendered before');
});
