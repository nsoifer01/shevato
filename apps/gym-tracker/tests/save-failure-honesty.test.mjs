/**
 * A refused write must never be reported as a saved change (audit G-4).
 *
 * `StorageService.set` has always answered a refused write (quota exhausted,
 * evicted storage, private mode) with `false`. The live workout and Finish
 * read it (see active-workout-write-failure.test.mjs and "A failed write must
 * not be reported as a saved workout" in FINDINGS). Every other store did not:
 * saving or deleting a program, saving settings, creating or deleting a custom
 * exercise, saving, editing or deleting a measurement or a goal, deleting a
 * workout, and removing an exercise's history all toasted success while
 * storage still held the old state, so the change quietly came undone on the
 * next reload. Pause was worse: it dropped the in-memory workout after its
 * write was refused, the one copy the storage banner promises is safe.
 *
 * The contract every path is held to here, the same one Finish keeps:
 *   - no success toast;
 *   - memory is put back to what storage still holds, so no screen shows a
 *     change the next reload will not have;
 *   - whatever the lifter was doing stays open (the editor, the form, the
 *     live workout), so trying again is one tap;
 *   - an error names the cause and the way out.
 *
 * Storage is the REAL StorageService over a localStorage whose setItem throws
 * QuotaExceededError, the app's save methods are the real ones from app.js,
 * and each view method is lifted from its real source
 * (tests/helpers/source-extract.mjs).
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';

const disk = new Map();
const quota = { full: false };
globalThis.sessionStorage = globalThis.sessionStorage || { getItem: () => null, setItem() {} };
globalThis.localStorage = {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => {
        if (quota.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        disk.set(k, String(v));
    },
    removeItem: (k) => { disk.delete(k); },
};
// StorageService logs every refused write; that is expected here.
console.error = () => {};

const { storageService } = await import('../js/services/StorageService.js');
const { Program } = await import('../js/models/Program.js');
const { Settings } = await import('../js/models/Settings.js');
const { Measurement } = await import('../js/models/Measurement.js');
const { WorkoutSession } = await import('../js/models/WorkoutSession.js');
const { EVENTS } = await import('../js/utils/event-bus.js');
const { sameId } = await import('../js/utils/id-utils.js');
const { escapeHtml, pluralize } = await import('../js/utils/helpers.js');
const { normalizeWeightUnit, volumeIn } = await import('../js/utils/units.js');
const { normalizeSearchText } = await import('../js/utils/exercise-search.js');
const { isLoggedSession, performedExerciseCount } = await import('../js/utils/session-metrics.js');

// ---------------------------------------------------------------------------
// The app, with storage holding exactly what memory holds, then a full disk.
// ---------------------------------------------------------------------------

const events = [];
const APP_SAVES = ['savePrograms', 'saveWorkoutSessions', 'saveSettings', 'saveAchievements',
    'saveCustomExercises', 'saveMeasurements'];
const appMethods = buildMethods(loadSource('js/app.js'),
    [...APP_SAVES, 'addMeasurement', 'deleteMeasurement', 'addCustomExercise'],
    { storageService, emit: (name) => events.push(name), EVENTS, EXERCISE_DATABASE: [] },
    'app.js');

function appWith(data = {}) {
    disk.clear();
    events.length = 0;
    quota.full = false;
    const app = Object.create(appMethods);
    app.programs = data.programs || [];
    app.workoutSessions = data.workoutSessions || [];
    app.settings = data.settings || Settings.getDefault();
    app.achievements = [];
    app.customExercises = data.customExercises || [];
    app.measurements = data.measurements || [];
    app.viewControllers = {};
    app.achievementUpdates = 0;
    app.navigations = [];
    app.getProgramById = (id) => app.programs.find(p => sameId(p.id, id));
    app.getExerciseById = (id) => app.exerciseDatabase.find(e => sameId(e.id, id));
    app.getExerciseDisplayName = (id, fallback) => fallback;
    app.updateAchievements = () => { app.achievementUpdates += 1; };
    app.showView = (view) => { app.navigations.push(view); };
    app.updateGlobalFab = () => {};
    APP_SAVES.forEach(save => app[save]());
    // After seeding: saveCustomExercises rebuilds the database from its own
    // (empty here) catalog, which would drop a test's catalog entries.
    app.exerciseDatabase = [...(data.catalog || []), ...app.customExercises];
    if (data.goals) storageService.set('gymTrackerMeasurementGoals', data.goals);
    events.length = 0;
    quota.full = true;
    return app;
}

function toastLog() {
    const toasts = [];
    return { toasts, showToast: (message, type) => { toasts.push({ message, type }); } };
}

/** No success wording, and an error that names the cause and the way out. */
function assertToldTheTruth(toasts, successWording) {
    const lie = toasts.find(t => successWording.test(t.message));
    assert.equal(lie, undefined, `a refused write was reported as done: "${lie?.message}"`);
    const error = toasts.find(t => t.type === 'error');
    assert.ok(error, `the lifter must be told it did not save (toasts: ${JSON.stringify(toasts)})`);
    assert.match(error.message, /storage is full/i, 'name the cause');
    assert.match(error.message, /free some space/i, 'and the way out');
}

const classes = () => {
    const removed = [];
    return { removed, classList: { add() {}, remove: (c) => removed.push(c), contains: () => false } };
};

const pushDay = () => Program.fromJSON({
    id: 1,
    name: 'Push',
    exercises: [{ exerciseId: 3, exerciseName: 'Bench Press', sets: [{ repsMin: 8, repsMax: 10 }], order: 0 }],
});

const sessionOf = (id, exercises) => ({
    id,
    date: '2026-09-10',
    workoutDayName: 'Push',
    totalVolume: 480,
    exercises,
    toJSON() { return { id: this.id, date: this.date, workoutDayName: this.workoutDayName, exercises: this.exercises }; },
});
const loggedBench = () => ({ exerciseId: 3, exerciseName: 'Bench Press', sets: [{ weight: 60, reps: 8, completed: true, slot: 0 }] });
const loggedSquat = () => ({ exerciseId: 9, exerciseName: 'Squat', sets: [{ weight: 100, reps: 5, completed: true, slot: 0 }] });

// ---------------------------------------------------------------------------
// app.js: every store reports its write, and a refused one changes nothing
// ---------------------------------------------------------------------------

test('every app.save* returns false on a refused write and announces no change', () => {
    for (const save of APP_SAVES) {
        const app = appWith();
        assert.equal(app[save](), false, `${save} must report the refused write`);
        assert.deepEqual(events, [], `${save} told listeners about a change storage never took`);
    }
});

test('every app.save* returns true and announces the change when the write lands', () => {
    for (const save of APP_SAVES) {
        const app = appWith();
        quota.full = false;
        assert.equal(app[save](), true, save);
        assert.equal(events.length, 1, `${save} emits its change event`);
    }
});

test('addMeasurement / deleteMeasurement / addCustomExercise leave memory as storage has it', () => {
    const kept = new Measurement({ id: 11, date: '2026-09-01', weight: 82, unitsCanonical: true });
    const custom = { id: 555, name: 'Cable Y Raise', category: 'shoulders', isCustom: true };
    const app = appWith({ measurements: [kept], customExercises: [custom] });

    assert.equal(app.addMeasurement(new Measurement({ id: 12, date: '2026-09-02', weight: 81, unitsCanonical: true })), false);
    assert.deepEqual(app.measurements, [kept]);

    assert.equal(app.deleteMeasurement(11), false);
    assert.deepEqual(app.measurements, [kept]);

    assert.equal(app.addCustomExercise({ id: 777, name: 'Landmine Press', isCustom: true }), false);
    assert.deepEqual(app.customExercises, [custom]);
    assert.deepEqual(app.exerciseDatabase, [custom], 'the picker must not offer an exercise that was never stored');
});

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

const programsSrc = loadSource('js/views/programs-view.js');

test('programs: a refused save keeps the editor open with the edits, and the list unchanged', () => {
    const push = pushDay();
    const app = appWith({ programs: [push] });
    const { toasts, showToast } = toastLog();
    const form = { 'program-name': { value: 'Push v2' }, 'program-description': { value: '' } };
    const methods = buildMethods(programsSrc, ['saveProgram'], {
        showToast, document: { getElementById: (id) => form[id] || null },
    }, 'programs-view.js');
    const view = Object.create(methods);
    const staged = Program.fromJSON(push.toJSON());
    let closed = 0;
    Object.assign(view, {
        app, isSaving: false, currentProgram: staged,
        showNameError() {}, showExercisesError() {}, showDuplicateNameHint() {}, render() {},
        closeProgramModal() { closed += 1; },
    });

    view.saveProgram();

    assertToldTheTruth(toasts, /saved successfully/i);
    assert.equal(closed, 0, 'the editor closed and took the unsaved edits with it');
    assert.equal(view.currentProgram, staged);
    assert.equal(staged.name, 'Push v2', 'the edits are still there to save again');
    assert.equal(view.isSaving, false, 'Save must work again straight away');
    assert.equal(app.programs[0], push, 'the list shows what storage holds');
    assert.equal(app.programs[0].name, 'Push');
});

test('programs: a refused save of a NEW program does not add it to the list', () => {
    const push = pushDay();
    const app = appWith({ programs: [push] });
    const { toasts, showToast } = toastLog();
    const form = { 'program-name': { value: 'Legs' }, 'program-description': { value: '' } };
    const methods = buildMethods(programsSrc, ['saveProgram'], {
        showToast, document: { getElementById: (id) => form[id] || null },
    }, 'programs-view.js');
    const view = Object.create(methods);
    Object.assign(view, {
        app, isSaving: false,
        currentProgram: Program.fromJSON({ id: 2, name: '', exercises: [{ exerciseId: 9, exerciseName: 'Squat', sets: [{ repsMin: 5, repsMax: 5 }] }] }),
        showNameError() {}, showExercisesError() {}, showDuplicateNameHint() {}, render() {}, closeProgramModal() {},
    });

    view.saveProgram();

    assertToldTheTruth(toasts, /saved successfully/i);
    assert.deepEqual(app.programs, [push]);
});

test('programs: a refused duplicate adds no copy', () => {
    const push = pushDay();
    const app = appWith({ programs: [push] });
    const { toasts, showToast } = toastLog();
    const view = Object.create(buildMethods(programsSrc, ['duplicateProgram'], { Program, showToast }, 'programs-view.js'));
    Object.assign(view, { app, render() {} });

    view.duplicateProgram(1);

    assertToldTheTruth(toasts, /created/i);
    assert.deepEqual(app.programs, [push]);
});

test('programs: a refused delete keeps the program', async () => {
    const push = pushDay();
    const app = appWith({ programs: [push] });
    const { toasts, showToast } = toastLog();
    const view = Object.create(buildMethods(programsSrc, ['deleteProgram'], {
        sameId, escapeHtml, showToast, showConfirmModal: async () => true,
    }, 'programs-view.js'));
    Object.assign(view, { app, render() {} });

    await view.deleteProgram(1);

    assertToldTheTruth(toasts, /deleted/i);
    assert.deepEqual(app.programs, [push]);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings: a refused save leaves the stored settings in force and the form unsaved', () => {
    const app = appWith({ settings: Settings.fromJSON({ ...Settings.getDefault().toJSON(), weightUnit: 'kg' }) });
    const { toasts, showToast } = toastLog();
    let wakeLockSynced = 0;
    app.viewControllers.workout = { syncWakeLock: () => { wakeLockSynced += 1; } };
    const view = Object.create(buildMethods(loadSource('js/views/settings-view.js'), ['saveSettings'], {
        normalizeWeightUnit, Settings, showToast,
        document: { getElementById: (id) => (id === 'weight-unit' ? { value: 'lb' } : null) },
    }, 'settings-view.js'));
    const before = { weightUnit: 'kg' };
    Object.assign(view, {
        app, savedSnapshot: before,
        activePlateUnit: () => 'lb', parsePlatesInput: () => [],
        snapshotForm: () => ({ weightUnit: 'lb' }), checkDirty() {},
    });

    view.saveSettings();

    assertToldTheTruth(toasts, /saved successfully/i);
    assert.equal(app.settings.weightUnit, 'kg', 'every screen would render pounds that the next reload drops');
    assert.equal(view.savedSnapshot, before, 'the form must stay dirty so the change can be saved again');
    assert.equal(wakeLockSynced, 0);
});

// ---------------------------------------------------------------------------
// Custom exercises and exercise history
// ---------------------------------------------------------------------------

const exercisesSrc = loadSource('js/views/exercises-view.js');

test('custom exercises: a refused create keeps the form open and adds nothing', async () => {
    const existing = { id: 555, name: 'Cable Y Raise', category: 'shoulders', isCustom: true };
    const app = appWith({ customExercises: [existing] });
    const { toasts, showToast } = toastLog();
    const modal = classes();
    const form = {
        'custom-exercise-name': { value: 'Landmine Press' },
        'custom-exercise-category': { value: 'shoulders' },
        'custom-exercise-muscle': { value: 'Front Delts' },
        'custom-exercise-equipment': { value: 'barbell' },
        'custom-exercise-modal': modal,
    };
    const view = Object.create(buildMethods(exercisesSrc, ['createCustomExercise'], {
        showToast, showConfirmModal: async () => true, normalizeSearchText, escapeHtml,
        generateNumericId: () => 777,
        document: { getElementById: (id) => form[id] || null },
    }, 'exercises-view.js'));
    Object.assign(view, { app, validateCustomExerciseForm: () => true, focusFieldControl() {}, render() {} });

    await view.createCustomExercise();

    assertToldTheTruth(toasts, /created custom exercise/i);
    assert.deepEqual(modal.removed, [], 'the form closed on an exercise that does not exist');
    assert.deepEqual(app.customExercises, [existing]);
    assert.ok(!app.exerciseDatabase.some(e => e.id === 777));
});

test('custom exercises: a refused delete keeps the exercise', async () => {
    const custom = { id: 555, name: 'Cable Y Raise', category: 'shoulders', isCustom: true };
    const app = appWith({ customExercises: [custom] });
    const { toasts, showToast } = toastLog();
    const view = Object.create(buildMethods(exercisesSrc, ['deleteCustomExercise'], {
        showToast, showConfirmModal: async () => true, escapeHtml, sameId, pluralize,
    }, 'exercises-view.js'));
    Object.assign(view, { app, exerciseHasHistory: () => false, programsUsingExercise: () => [], render() {} });

    await view.deleteCustomExercise(555);

    assertToldTheTruth(toasts, /deleted/i);
    assert.deepEqual(app.customExercises, [custom]);
    assert.deepEqual(app.exerciseDatabase, [custom]);
});

test('exercise history: a refused removal leaves every session exactly as stored', async () => {
    const both = sessionOf(1, [loggedBench(), loggedSquat()]);
    const benchOnly = sessionOf(2, [loggedBench()]);
    const app = appWith({ workoutSessions: [both, benchOnly], catalog: [{ id: 3, name: 'Bench Press' }] });
    const bothExercises = both.exercises;
    const { toasts, showToast } = toastLog();
    const view = Object.create(buildMethods(exercisesSrc, ['deleteExerciseHistory'], {
        showToast, showConfirmModal: async () => true, escapeHtml, sameId, pluralize, isLoggedSession,
        document: { getElementById: () => classes() },
    }, 'exercises-view.js'));
    Object.assign(view, { app, getExerciseHistoryCount: () => 2, render() {} });

    await view.deleteExerciseHistory(3);

    assertToldTheTruth(toasts, /history removed/i);
    assert.deepEqual(app.workoutSessions, [both, benchOnly], 'the emptied session must still be there');
    assert.equal(both.exercises, bothExercises, 'and the bench entry must still be in the session that kept a squat');
    assert.equal(app.achievementUpdates, 0, 'achievements must not be recomputed over data that was never stored');
});

// ---------------------------------------------------------------------------
// Measurements and goals
// ---------------------------------------------------------------------------

const measurementsSrc = loadSource('js/views/measurements-view.js');
const METRICS = [{ key: 'weight', kind: 'weight' }];

function measurementForm(values) {
    const modal = classes();
    const elements = { ...values, 'measurement-modal': modal, 'measurement-goal-modal': modal };
    return { modal, document: { getElementById: (id) => elements[id] || null } };
}

function measurementsView(app, names, deps) {
    const view = Object.create(buildMethods(measurementsSrc, names, {
        METRICS, METRIC_INPUT_IDS: { weight: 'm-weight' }, GOALS_KEY: 'gymTrackerMeasurementGoals',
        validateMeasurementEntry: () => null, getTodayDateString: () => '2026-09-13',
        Measurement, storageService, escapeHtml, formatDate: (d) => d,
        showConfirmModal: async () => true,
        ...deps,
    }, 'measurements-view.js'));
    Object.assign(view, {
        app, editingId: null,
        canonicalValue: (_metric, raw) => (raw === '' ? '' : Number(raw)),
        clearEntryError() {}, showEntryError() {}, render() {},
    });
    return view;
}

test('measurements: a refused new entry keeps the form open and adds nothing', () => {
    const kept = new Measurement({ id: 11, date: '2026-09-01', weight: 82, unitsCanonical: true });
    const app = appWith({ measurements: [kept] });
    const { toasts, showToast } = toastLog();
    const { modal, document } = measurementForm({ 'm-date': { value: '2026-09-12' }, 'm-notes': { value: '' }, 'm-weight': { value: '81' } });
    const view = measurementsView(app, ['_saveFromFormNow'], { showToast, document });

    assert.notEqual(view._saveFromFormNow(), true, 'a refused save must not arm the double-submit guard');

    assertToldTheTruth(toasts, /measurement saved/i);
    assert.deepEqual(modal.removed, []);
    assert.deepEqual(app.measurements, [kept]);
});

test('measurements: a refused edit keeps the stored values', () => {
    const kept = new Measurement({ id: 11, date: '2026-09-01', weight: 82, unitsCanonical: true });
    const app = appWith({ measurements: [kept] });
    const { toasts, showToast } = toastLog();
    const { modal, document } = measurementForm({ 'm-date': { value: '2026-09-01' }, 'm-notes': { value: '' }, 'm-weight': { value: '79' } });
    const view = measurementsView(app, ['_saveFromFormNow'], { showToast, document });
    view.editingId = 11;

    view._saveFromFormNow();

    assertToldTheTruth(toasts, /measurement updated/i);
    assert.deepEqual(modal.removed, []);
    assert.equal(view.editingId, 11, 'still editing the same entry');
    assert.equal(app.measurements[0], kept);
    assert.equal(app.measurements[0].weight, 82);
});

test('measurements: a refused delete keeps the entry', async () => {
    const kept = new Measurement({ id: 11, date: '2026-09-01', weight: 82, unitsCanonical: true });
    const app = appWith({ measurements: [kept] });
    const { toasts, showToast } = toastLog();
    const view = measurementsView(app, ['confirmDelete'], { showToast });

    await view.confirmDelete(11);

    assertToldTheTruth(toasts, /measurement deleted/i);
    assert.deepEqual(app.measurements, [kept]);
});

test('goals: a refused save keeps the goal dialog open for the same metric', () => {
    const app = appWith();
    const { toasts, showToast } = toastLog();
    const { modal, document } = measurementForm({ 'goal-target': { value: '75' }, 'goal-direction': { value: 'decrease' } });
    const view = measurementsView(app, ['saveGoalFromForm', 'loadGoals', 'saveGoals'], { showToast, document });
    view.goalMetricKey = 'weight';

    view.saveGoalFromForm();

    assertToldTheTruth(toasts, /goal saved/i);
    assert.deepEqual(modal.removed, []);
    assert.equal(view.goalMetricKey, 'weight');
});

test('goals: a refused clear keeps the goal', () => {
    const app = appWith({ goals: { weight: { target: 75, direction: 'decrease' } } });
    const { toasts, showToast } = toastLog();
    const { modal, document } = measurementForm({});
    const view = measurementsView(app, ['clearGoal', 'loadGoals', 'saveGoals'], { showToast, document });
    view.goalMetricKey = 'weight';

    view.clearGoal();

    assertToldTheTruth(toasts, /goal cleared/i);
    assert.deepEqual(modal.removed, []);
    assert.deepEqual(view.loadGoals(), { weight: { target: 75, direction: 'decrease' } });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const historySrc = loadSource('js/views/history-view.js');

test('history: a refused workout delete keeps the workout and its achievements', async () => {
    const session = sessionOf(1, [loggedBench()]);
    const app = appWith({ workoutSessions: [session] });
    const { toasts, showToast } = toastLog();
    const view = Object.create(buildMethods(historySrc, ['deleteWorkout'], {
        sameId, normalizeWeightUnit, performedExerciseCount, escapeHtml, pluralize, volumeIn,
        formatSessionDateTime: () => 'Sep 10', showConfirmModal: async () => true, showToast,
    }, 'history-view.js'));
    Object.assign(view, { app, render() {} });

    await view.deleteWorkout(1);

    assertToldTheTruth(toasts, /workout deleted/i);
    assert.deepEqual(app.workoutSessions, [session]);
    assert.equal(app.achievementUpdates, 0);
});

test('history: a refused "Save as Program" creates no program', async () => {
    const push = pushDay();
    const app = appWith({ programs: [push], workoutSessions: [sessionOf(1, [loggedBench()])] });
    const { toasts, showToast } = toastLog();
    const modal = classes();
    const view = Object.create(buildMethods(historySrc, ['saveSessionAsProgram'], {
        sameId, Program, showToast,
        window: { prompt: () => 'From history' },
        document: { getElementById: () => modal },
    }, 'history-view.js'));
    Object.assign(view, { app });

    await view.saveSessionAsProgram(1);

    assertToldTheTruth(toasts, /created/i);
    assert.deepEqual(app.programs, [push]);
    assert.deepEqual(modal.removed, [], 'the session detail stays open');
});

// ---------------------------------------------------------------------------
// Pause: the live workout is the one copy that must never be dropped
// ---------------------------------------------------------------------------

const workoutSrc = loadSource('js/views/workout-view.js');

function workoutView(app, { toasts }) {
    const calls = [];
    const elements = { 'active-workout': classes(), 'workout-selection': classes() };
    const view = Object.create(buildMethods(workoutSrc,
        ['pauseAndSaveWorkout', 'flushPendingPersist', 'manualPauseWorkout', 'editProgramFromWorkout',
            'interceptNavigation', 'showBackLeaveModal'], {
            storageService,
            timerService: { getWorkoutElapsed: () => 600, stopWorkoutTimer: () => calls.push('stopWorkoutTimer') },
            debugLog: () => {},
            showToast: (message, type) => toasts.push({ message, type }),
            trapModalFocus: () => {},
            document: { getElementById: (id) => elements[id] || null, activeElement: null },
        }, 'workout-view.js'));
    const session = new WorkoutSession({
        id: 42, programId: 1, workoutDayName: 'Push', startTime: '2026-09-13T17:00:00.000Z',
        exercises: [loggedBench()],
    });
    Object.assign(view, {
        app, currentWorkoutSession: session, _persistTimer: null,
        releaseWorkoutLock: () => calls.push('releaseWorkoutLock'),
        releaseWakeLock: () => calls.push('releaseWakeLock'),
        disarmBackGuard: () => calls.push('disarmBackGuard'),
        skipRest: () => calls.push('skipRest'),
        hasActiveWorkout: () => !!view.currentWorkoutSession,
        setWorkoutStorageFailed: (failed) => calls.push(`storageFailed:${failed}`),
    });
    return { view, session, calls, elements };
}

function assertStillLive({ view, session, calls, elements }) {
    assert.equal(view.currentWorkoutSession, session, 'the in-memory workout was dropped after a refused write');
    assert.equal(session.paused, false, 'it is still running, not half-paused');
    assert.ok(!calls.includes('releaseWorkoutLock'), 'this tab still owns it');
    assert.ok(!calls.includes('stopWorkoutTimer'), 'the clock keeps running');
    assert.ok(calls.includes('storageFailed:true'), 'the persistent storage banner is up');
    assert.deepEqual(elements['active-workout'].removed, [], 'the workout screen stays');
}

test('pause: a refused write keeps the workout live, raises the banner and says why', () => {
    const toasts = [];
    const app = appWith();
    const w = workoutView(app, { toasts });

    assert.equal(w.view.pauseAndSaveWorkout(), false);

    assertStillLive(w);
    assertToldTheTruth(toasts, /paused/i);
});

test('pause: a write that lands still pauses exactly as before', () => {
    const toasts = [];
    const app = appWith();
    quota.full = false;
    const w = workoutView(app, { toasts });

    assert.notEqual(w.view.pauseAndSaveWorkout(), false);

    assert.equal(w.view.currentWorkoutSession, null);
    assert.equal(w.session.paused, true);
    assert.ok(w.calls.includes('releaseWorkoutLock'));
    assert.deepEqual(w.elements['active-workout'].removed, ['active']);
});

test('pause button: a refused write does not leave for Home', () => {
    const toasts = [];
    const app = appWith();
    const w = workoutView(app, { toasts });

    w.view.manualPauseWorkout();

    assertStillLive(w);
    assert.deepEqual(app.navigations, []);
});

test('"Edit program": a refused pause does not open the editor over a live workout', () => {
    const toasts = [];
    const app = appWith();
    app.viewControllers.programs = { openProgramModal() {} };
    const w = workoutView(app, { toasts });

    w.view.editProgramFromWorkout();

    assertStillLive(w);
    assert.deepEqual(app.navigations, []);
    assert.notEqual(app.viewControllers.programs.enteredFromWorkout, true);
});

test('leaving the workout screen with "Pause": a refused pause stays on the workout', async () => {
    const toasts = [];
    const app = appWith();
    app.currentView = 'workout';
    const w = workoutView(app, { toasts });
    w.view.showLeaveWorkoutModal = async () => 'pause';

    w.view.interceptNavigation();
    await app.showView('home');

    assertStillLive(w);
    assert.deepEqual(app.navigations, [], 'navigation went ahead without the workout');
});

test('back button, "Pause and leave": a refused pause stays on the workout with the back trap armed', () => {
    const toasts = [];
    const app = appWith();
    const w = workoutView(app, { toasts });
    const handlers = {};
    const button = (name) => ({ addEventListener: (_type, fn) => { handlers[name] = fn; }, removeEventListener() {} });
    w.elements['leave-workout-modal'] = { ...classes(), contains: () => false };
    w.elements['leave-workout-stay'] = button('stay');
    w.elements['leave-workout-pause-leave'] = button('leave');

    w.view.showBackLeaveModal();
    handlers.leave();

    assertStillLive(w);
    assert.ok(!w.calls.includes('disarmBackGuard'), 'the next Back must still land on the leave dialog');
    assert.deepEqual(app.navigations, []);
});

test('settings: "Save" in the unsaved-changes dialog stays on Settings when the write is refused', () => {
    const app = appWith();
    const handlers = {};
    const button = (name) => ({ addEventListener: (_type, fn) => { handlers[name] = fn; } });
    const elements = {
        'unsaved-settings-modal': { dataset: {} },
        'unsaved-settings-close': button('close'),
        'unsaved-settings-save': button('save'),
        'unsaved-settings-discard': button('discard'),
    };
    const view = Object.create(buildMethods(loadSource('js/views/settings-view.js'), ['setupEventListeners'], {
        closeModalSafely: () => {},
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
    }, 'settings-view.js'));
    // saveSettings itself is held to the contract above; this is about the
    // dialog acting on its answer.
    Object.assign(view, { app, pendingLeaveView: 'history', saveSettings: () => false });

    view.setupEventListeners();
    handlers.save();

    assert.deepEqual(app.navigations, [], 'leaving after a refused save throws the unsaved choices away');
});
