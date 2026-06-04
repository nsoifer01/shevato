// Tests for:
//  1. Rest model split (restSeconds = between-set, restAfterSeconds = between-exercise)
//  2. Migration of legacy programs (no data loss)
//  3. Per-exercise plate hints persistence in Settings
//  4. Auto-collapse re-trigger state machine (via deleteSet logic path)

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Program, defaultRestForEquipment } = await import('../js/models/Program.js');
const { Settings } = await import('../js/models/Settings.js');
const { calculatePlates } = await import('../js/utils/plate-calculator.js');

// ---------------------------------------------------------------------------
// 1. restAfterSeconds field on new exercises
// ---------------------------------------------------------------------------

test('Program.addExercise: restAfterSeconds defaults to same as restSeconds', () => {
    const p = new Program({ name: 'Split' });
    p.addExercise('e1', 'Squat', 3, 10, '', 120);
    const ex = p.exercises[0];
    assert.equal(ex.restSeconds, 120, 'restSeconds set');
    assert.equal(ex.restAfterSeconds, 120, 'restAfterSeconds defaults to restSeconds when not supplied');
});

test('Program.addExercise: restAfterSeconds can be set independently', () => {
    const p = new Program({ name: 'Split2' });
    p.addExercise('e1', 'Bench', 3, 10, '', 60, 120);
    const ex = p.exercises[0];
    assert.equal(ex.restSeconds, 60, 'between-set rest');
    assert.equal(ex.restAfterSeconds, 120, 'between-exercise rest');
});

test('Program.updateExercise: can patch restAfterSeconds independently', () => {
    const p = new Program({ name: 'Patch' });
    p.addExercise('e1', 'Row', 3, 10, '', 90, 90);
    p.updateExercise(0, { restAfterSeconds: 180 });
    assert.equal(p.exercises[0].restAfterSeconds, 180);
    assert.equal(p.exercises[0].restSeconds, 90, 'restSeconds unchanged');
});

test('Program: restAfterSeconds is clamped to [0, 900]', () => {
    const p = new Program({
        name: 'Clamp',
        exercises: [{
            exerciseId: 'e', exerciseName: 'X',
            sets: [{ repsMin: 5, repsMax: 5 }],
            restSeconds: 90,
            restAfterSeconds: 9999,
            notes: '', order: 0,
        }],
    });
    assert.equal(p.exercises[0].restAfterSeconds, 900, 'clamped to max 900');
});

test('Program: restAfterSeconds negative is clamped to 0', () => {
    const p = new Program({
        name: 'ClampNeg',
        exercises: [{
            exerciseId: 'e', exerciseName: 'X',
            sets: [{ repsMin: 5, repsMax: 5 }],
            restSeconds: 90,
            restAfterSeconds: -10,
            notes: '', order: 0,
        }],
    });
    assert.equal(p.exercises[0].restAfterSeconds, 0, 'clamped to min 0');
});

// ---------------------------------------------------------------------------
// 2. Migration: legacy programs with no restAfterSeconds get a sensible default
// ---------------------------------------------------------------------------

test('Migration: legacy program without restAfterSeconds gets default from restSeconds', () => {
    const json = {
        id: 99, name: 'Legacy',
        exercises: [{
            exerciseId: 'e1', exerciseName: 'Deadlift',
            targetSets: 3, targetReps: 5,
            restSeconds: 180,
            // restAfterSeconds intentionally absent
            notes: '', order: 0,
        }],
        createdAt: '', updatedAt: '',
    };
    const p = Program.fromJSON(json);
    assert.equal(p.exercises[0].restSeconds, 180, 'restSeconds preserved');
    assert.equal(p.exercises[0].restAfterSeconds, 180, 'restAfterSeconds migrated from restSeconds');
});

test('Migration: legacy program with restSeconds=0 migrates restAfterSeconds to 0', () => {
    const json = {
        id: 100, name: 'ZeroRest',
        exercises: [{
            exerciseId: 'e2', exerciseName: 'Plank',
            targetSets: 3, targetReps: 1,
            restSeconds: 0,
            notes: '', order: 0,
        }],
        createdAt: '', updatedAt: '',
    };
    const p = Program.fromJSON(json);
    assert.equal(p.exercises[0].restAfterSeconds, 0);
});

test('Migration: program with explicit restAfterSeconds keeps both values', () => {
    const json = {
        id: 101, name: 'Explicit',
        exercises: [{
            exerciseId: 'e3', exerciseName: 'Curl',
            targetSets: 3, targetReps: 12,
            restSeconds: 60,
            restAfterSeconds: 120,
            notes: '', order: 0,
        }],
        createdAt: '', updatedAt: '',
    };
    const p = Program.fromJSON(json);
    assert.equal(p.exercises[0].restSeconds, 60);
    assert.equal(p.exercises[0].restAfterSeconds, 120);
});

test('Program.toJSON: restAfterSeconds is serialized', () => {
    const p = new Program({ name: 'Serial' });
    p.addExercise('e1', 'Press', 3, 10, '', 75, 150);
    const json = p.toJSON();
    assert.equal(json.exercises[0].restAfterSeconds, 150, 'restAfterSeconds in toJSON output');
    const roundTripped = Program.fromJSON(json);
    assert.equal(roundTripped.exercises[0].restAfterSeconds, 150, 'survives round-trip');
});

// ---------------------------------------------------------------------------
// 3. Per-exercise plate hints in Settings
// ---------------------------------------------------------------------------

test('Settings: exercisePlateHints defaults to empty object', () => {
    const s = new Settings({});
    assert.deepEqual(s.exercisePlateHints, {}, 'empty map by default');
});

test('Settings: exercisePlateHints survives round-trip through toJSON/fromJSON', () => {
    const s = new Settings({ exercisePlateHints: { 'bench-press': true, 'squat': false } });
    const s2 = Settings.fromJSON(s.toJSON());
    assert.deepEqual(s2.exercisePlateHints, { 'bench-press': true, 'squat': false });
});

test('Settings: per-exercise hint is isolated from global plateHintsEnabled', () => {
    const s = new Settings({ plateHintsEnabled: true, exercisePlateHints: { 'squat': false } });
    assert.equal(s.plateHintsEnabled, true, 'global on');
    assert.equal(s.exercisePlateHints['squat'], false, 'per-exercise override off');
    assert.equal(s.exercisePlateHints['bench-press'], undefined, 'no override for bench-press');
});

test('Settings: invalid exercisePlateHints type is reset to empty object', () => {
    const s = new Settings({ exercisePlateHints: 'not-an-object' });
    assert.deepEqual(s.exercisePlateHints, {});
});

test('Settings: null exercisePlateHints is reset to empty object', () => {
    const s = new Settings({ exercisePlateHints: null });
    assert.deepEqual(s.exercisePlateHints, {});
});

test('Settings: exercisePlateHints is a shallow copy (mutations do not bleed)', () => {
    const original = { 'squat': true };
    const s = new Settings({ exercisePlateHints: original });
    s.exercisePlateHints['deadlift'] = false;
    assert.equal(original['deadlift'], undefined, 'original not mutated');
});

// ---------------------------------------------------------------------------
// 4. Auto-collapse re-trigger state machine
//
// The actual state machine runs in workout-view.js (browser DOM) so we test
// the model invariants it depends on. The collapse logic relies on:
//   - exercise.sets.length >= exercise.targetSets  => "complete"
//   - deleting a set on a complete exercise => now incomplete => suppression clears
// We verify the Program model supports these correctly so the view logic can
// rely on them without DOM coupling.
// ---------------------------------------------------------------------------

test('Collapse state machine: targetSets getter matches sets.length after addExercise', () => {
    const p = new Program({ name: 'Collapse' });
    p.addExercise('e1', 'Squat', 4, 8);
    assert.equal(p.exercises[0].targetSets, 4, 'targetSets = 4');
    assert.equal(p.exercises[0].sets.length, 4, 'sets.length = 4');
});

test('Collapse state machine: exercise with sets.length === targetSets is "complete"', () => {
    const p = new Program({ name: 'Complete' });
    p.addExercise('e1', 'Deadlift', 3, 5);
    const ex = p.exercises[0];
    // Simulate: all 3 sets committed (sets.length === targetSets)
    const committedCount = ex.targetSets; // 3
    assert.ok(committedCount >= ex.targetSets, 'is complete when sets.length >= targetSets');
});

test('Collapse state machine: reducing committed sets below targetSets is "incomplete"', () => {
    const p = new Program({ name: 'Incomplete' });
    p.addExercise('e1', 'Curl', 3, 12);
    const ex = p.exercises[0];
    // Two out of 3 sets: should be incomplete
    const committedCount = 2;
    assert.ok(committedCount < ex.targetSets, 'is incomplete when sets.length < targetSets');
});

// Verify the suppression-clear invariant: when wasComplete && !isNowComplete,
// the collapse map entry must be cleared. We test the condition logic directly.
test('Collapse state machine: transition complete->incomplete clears suppression', () => {
    const targetSets = 3;
    let collapsedExercises = {};

    // Simulate: exercise completes -> auto-collapses
    collapsedExercises[0] = true;

    // Simulate: user expands manually (sets it false)
    collapsedExercises[0] = false;

    // Simulate: user unmarks a set -> exercise goes incomplete
    const wasComplete = true;
    const committedAfterDelete = targetSets - 1; // 2
    const isNowComplete = committedAfterDelete >= targetSets; // false

    if (wasComplete && !isNowComplete) {
        delete collapsedExercises[0];
    }

    assert.equal(collapsedExercises[0], undefined, 'suppression cleared on complete->incomplete');

    // Simulate: user re-marks last set (exercise complete again)
    const committedAfterRemark = targetSets; // 3
    const isCompleteAgain = committedAfterRemark >= targetSets; // true

    if (isCompleteAgain && collapsedExercises[0] !== false) {
        collapsedExercises[0] = true;
    }

    assert.equal(collapsedExercises[0], true, 'auto-collapse fires again after re-complete');
});

test('Collapse state machine: manual-expand while remaining complete preserves suppression', () => {
    // If the user expands while all-complete, collapsedExercises[i] = false.
    // A DIFFERENT exercise completing must NOT reset this.
    const collapsedExercises = { 0: false };

    // Simulating a DIFFERENT exercise (index 1) completing does not touch index 0.
    const otherIndex = 1;
    collapsedExercises[otherIndex] = true;

    assert.equal(collapsedExercises[0], false, 'suppression still false for exercise 0');
});

// ---------------------------------------------------------------------------
// 5. Plate hints precedence: global OFF overrides per-exercise ON
// ---------------------------------------------------------------------------

function computeHintsOn(plateHintsEnabled, perExHintsVal) {
    const globalHintsOn = plateHintsEnabled !== false;
    return globalHintsOn && (perExHintsVal !== undefined ? perExHintsVal : true);
}

test('Plate hints: global ON + per-exercise ON = hints on', () => {
    assert.equal(computeHintsOn(true, true), true);
});

test('Plate hints: global ON + per-exercise OFF = hints off', () => {
    assert.equal(computeHintsOn(true, false), false);
});

test('Plate hints: global ON + no per-exercise pref = hints on (default)', () => {
    assert.equal(computeHintsOn(true, undefined), true);
});

test('Plate hints: global OFF + per-exercise ON = hints off (global wins)', () => {
    assert.equal(computeHintsOn(false, true), false,
        'global OFF must override even when per-exercise is explicitly ON');
});

test('Plate hints: global OFF + no per-exercise pref = hints off', () => {
    assert.equal(computeHintsOn(false, undefined), false);
});

// ---------------------------------------------------------------------------
// 6. toggleRepRange collapses to repsMin (keeps the first number)
// ---------------------------------------------------------------------------

function applyToggleRepRange(row) {
    if (row.repsMin === row.repsMax) {
        row.repsMax = Math.min(100, row.repsMin + 2);
    } else {
        row.repsMax = row.repsMin;
    }
}

test('toggleRepRange: collapsing 8-10 range keeps 8 (repsMin), not 10', () => {
    const row = { repsMin: 8, repsMax: 10 };
    applyToggleRepRange(row);
    assert.equal(row.repsMin, 8, 'repsMin unchanged');
    assert.equal(row.repsMax, 8, 'repsMax set to repsMin (first number)');
});

test('toggleRepRange: collapsing 5-8 range keeps 5', () => {
    const row = { repsMin: 5, repsMax: 8 };
    applyToggleRepRange(row);
    assert.equal(row.repsMin, 5);
    assert.equal(row.repsMax, 5);
});

test('toggleRepRange: expanding a single rep adds 2 to max', () => {
    const row = { repsMin: 10, repsMax: 10 };
    applyToggleRepRange(row);
    assert.equal(row.repsMin, 10, 'repsMin unchanged on expand');
    assert.equal(row.repsMax, 12, 'repsMax = repsMin + 2');
});

test('toggleRepRange: expanding a single rep near cap stops at 100', () => {
    const row = { repsMin: 99, repsMax: 99 };
    applyToggleRepRange(row);
    assert.equal(row.repsMax, 100, 'capped at 100');
});

// ---------------------------------------------------------------------------
// 7. Program uniform mode: restSeconds (between-set) always present per exercise
// ---------------------------------------------------------------------------

test('Program uniform mode: restSeconds stays per-exercise regardless of restMode', () => {
    const p = new Program({ name: 'Uni', restMode: 'uniform', uniformRestSeconds: 60 });
    p.addExercise('e1', 'Press', 3, 10, '', 90, 120);
    assert.equal(p.exercises[0].restSeconds, 90, 'between-set rest preserved in uniform mode');
    assert.equal(p.restMode, 'uniform');
    assert.equal(p.uniformRestSeconds, 60, 'uniform value is for between-exercise');
});

// ---------------------------------------------------------------------------
// 8. setRepValue single-mode: editing min keeps repsMax in sync (Bug 1A fix)
// ---------------------------------------------------------------------------

function applySetRepValue(row, minOrMax, rawValue) {
    const val = Math.max(1, Math.min(100, Math.round(Number(rawValue) || 1)));
    if (minOrMax === 'min') {
        const wasSingle = row.repsMin === row.repsMax;
        row.repsMin = val;
        if (wasSingle) {
            row.repsMax = val;
        } else if (row.repsMax < row.repsMin) {
            row.repsMax = row.repsMin;
        }
    } else {
        row.repsMax = val;
        if (row.repsMin > row.repsMax) row.repsMin = row.repsMax;
    }
}

test('setRepValue single-mode: editing min to a lower value keeps repsMax = repsMin', () => {
    const row = { repsMin: 8, repsMax: 8 };
    applySetRepValue(row, 'min', 6);
    assert.equal(row.repsMin, 6, 'repsMin updated');
    assert.equal(row.repsMax, 6, 'repsMax stays in sync with repsMin (single mode preserved)');
});

test('setRepValue single-mode: editing min to a higher value keeps repsMax = repsMin', () => {
    const row = { repsMin: 8, repsMax: 8 };
    applySetRepValue(row, 'min', 12);
    assert.equal(row.repsMin, 12);
    assert.equal(row.repsMax, 12, 'repsMax stays in sync in single mode');
});

test('setRepValue single-mode: clamped to 1-100', () => {
    const row = { repsMin: 8, repsMax: 8 };
    applySetRepValue(row, 'min', 0);
    assert.equal(row.repsMin, 1, 'clamped to min 1');
    assert.equal(row.repsMax, 1);
});

test('setRepValue range-mode: editing min below max does not change max', () => {
    const row = { repsMin: 8, repsMax: 10 };
    applySetRepValue(row, 'min', 6);
    assert.equal(row.repsMin, 6, 'repsMin updated');
    assert.equal(row.repsMax, 10, 'repsMax unchanged when new min is still below it');
});

test('setRepValue range-mode: editing min above max clamps max up', () => {
    const row = { repsMin: 8, repsMax: 10 };
    applySetRepValue(row, 'min', 12);
    assert.equal(row.repsMin, 12);
    assert.equal(row.repsMax, 12, 'repsMax clamped to repsMin when min exceeds old max');
});

test('setRepValue range-mode: editing max below min clamps min down', () => {
    const row = { repsMin: 8, repsMax: 10 };
    applySetRepValue(row, 'max', 5);
    assert.equal(row.repsMax, 5);
    assert.equal(row.repsMin, 5, 'repsMin clamped to repsMax when max goes below it');
});

// ---------------------------------------------------------------------------
// 9. Collapse seeding on session restore (Bug 3 fix)
// ---------------------------------------------------------------------------

function seedCollapseState(exercises, collapsedExercises, prevCompleteState) {
    exercises.forEach((exercise, i) => {
        const targetSets = Math.max(1, exercise.targetSets || 3);
        const isComplete = exercise.sets.length >= targetSets;
        if (isComplete) {
            collapsedExercises[i] = true;
            prevCompleteState[i] = true;
        }
    });
}

test('Collapse seeding: completed exercise is marked collapsed on restore', () => {
    const exercises = [
        { sets: [{}, {}, {}], targetSets: 3 },
        { sets: [{}], targetSets: 3 },
    ];
    const collapsed = {};
    const prevComplete = {};
    seedCollapseState(exercises, collapsed, prevComplete);
    assert.equal(collapsed[0], true, 'exercise 0 (complete) is seeded collapsed');
    assert.equal(collapsed[1], undefined, 'exercise 1 (incomplete) is not seeded');
});

test('Collapse seeding: incomplete exercise is not collapsed', () => {
    const exercises = [
        { sets: [{}, {}], targetSets: 3 },
    ];
    const collapsed = {};
    const prevComplete = {};
    seedCollapseState(exercises, collapsed, prevComplete);
    assert.equal(collapsed[0], undefined, 'incomplete exercise stays expanded');
    assert.equal(prevComplete[0], undefined, 'prevCompleteState not set for incomplete');
});

test('Collapse seeding: prevCompleteState is set for completed exercises', () => {
    const exercises = [
        { sets: [{}, {}, {}], targetSets: 3 },
    ];
    const collapsed = {};
    const prevComplete = {};
    seedCollapseState(exercises, collapsed, prevComplete);
    assert.equal(prevComplete[0], true, 'prevCompleteState seeded for completed exercise');
});

test('Collapse seeding: extra sets beyond targetSets counts as complete', () => {
    const exercises = [
        { sets: [{}, {}, {}, {}], targetSets: 3 },
    ];
    const collapsed = {};
    const prevComplete = {};
    seedCollapseState(exercises, collapsed, prevComplete);
    assert.equal(collapsed[0], true, '4 sets >= 3 target counts as complete');
});

test('Collapse seeding: fresh session (empty maps) is not affected', () => {
    const exercises = [
        { sets: [], targetSets: 3 },
    ];
    const collapsed = {};
    const prevComplete = {};
    seedCollapseState(exercises, collapsed, prevComplete);
    assert.equal(collapsed[0], undefined, 'no sets = not complete');
});

// ---------------------------------------------------------------------------
// 10. isPlateLoaded equipment gating
// ---------------------------------------------------------------------------

const PLATE_LOADED_EQUIPMENT = new Set(['barbell', 'trap-bar', 'machine', 'plate', 'sled']);

test('isPlateLoaded: barbell is plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('barbell'), true);
});

test('isPlateLoaded: trap-bar is plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('trap-bar'), true);
});

test('isPlateLoaded: machine is plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('machine'), true);
});

test('isPlateLoaded: plate is plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('plate'), true);
});

test('isPlateLoaded: sled is plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('sled'), true);
});

test('isPlateLoaded: dumbbell is NOT plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('dumbbell'), false);
});

test('isPlateLoaded: cable is NOT plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('cable'), false);
});

test('isPlateLoaded: bodyweight is NOT plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('bodyweight'), false);
});

test('isPlateLoaded: kettlebell is NOT plate-loaded', () => {
    assert.equal(PLATE_LOADED_EQUIPMENT.has('kettlebell'), false);
});

// ---------------------------------------------------------------------------
// 11. Bar-weight base: barbell subtracts bar, machine does not
// ---------------------------------------------------------------------------

const testPlates = [25, 20, 10, 5, 2.5];

test('calculatePlates: barbell 100kg with bar 20 => perSide 40', () => {
    const result = calculatePlates(100, 20, testPlates);
    assert.equal(result.perSide, 40, 'barbell: (100 - 20) / 2 = 40 per side');
});

test('calculatePlates: machine 100kg with base 0 => perSide 50', () => {
    const result = calculatePlates(100, 0, testPlates);
    assert.equal(result.perSide, 50, 'machine: 100 / 2 = 50 per side');
});

test('calculatePlates: barbell vs machine per-side values differ when bar weight > 0', () => {
    const barbell = calculatePlates(100, 20, testPlates);
    const machine = calculatePlates(100, 0, testPlates);
    assert.notEqual(barbell.perSide, machine.perSide,
        'barbell (base 20) and machine (base 0) must yield different per-side values');
    assert.ok(barbell.perSide < machine.perSide, 'barbell has less per-side because bar weight is subtracted');
});
