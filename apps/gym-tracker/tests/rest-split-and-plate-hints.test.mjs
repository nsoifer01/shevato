// Tests for:
//  1. Rest model split (restSeconds = between-set, restAfterSeconds = between-exercise)
//  2. Migration of legacy programs (no data loss)
//  3. Per-exercise plate hints persistence in Settings
//  4. Plate-hints precedence and equipment gating (extracted from workout-view.js)
//  5. toggleRepRange (extracted from programs-view.js)
//
// The collapse state machine, seedCollapseState and setRepValue used to have
// hand-mirrored copies here; their single homes are now
// collapse-and-unmark-rest.test.mjs and programs-view-rep-clamp.test.mjs,
// both running the REAL extracted source.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, buildMethods } from './helpers/source-extract.mjs';

const { Program } = await import('../js/models/Program.js');
const { Settings } = await import('../js/models/Settings.js');
const { calculatePlates } = await import('../js/utils/plate-calculator.js');

const workoutViewSrc = loadSource('js/views/workout-view.js');
const programsViewSrc = loadSource('js/views/programs-view.js');

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

test('Program uniform mode: restSeconds stays per-exercise regardless of restMode', () => {
    const p = new Program({ name: 'Uni', restMode: 'uniform', uniformRestSeconds: 60 });
    p.addExercise('e1', 'Press', 3, 10, '', 90, 120);
    assert.equal(p.exercises[0].restSeconds, 90, 'between-set rest preserved in uniform mode');
    assert.equal(p.restMode, 'uniform');
    assert.equal(p.uniformRestSeconds, 60, 'uniform value is for between-exercise');
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
// 4a. Plate hints precedence: global OFF overrides per-exercise ON.
//
// The rule lives as an inline expression in workout-view.js (three render
// paths). It is extracted here from every occurrence, so both a formula
// change and a divergence between the render paths fail this test.
// ---------------------------------------------------------------------------

const hintExprMatches = [...workoutViewSrc.matchAll(
    /const hintsOn\w* = (globalHints\w* && \(perExHints\w* !== undefined \? perExHints\w* : true\));/g
)];

const hintFns = hintExprMatches.map(([, expr]) => new Function(
    'g', 'p',
    `"use strict"; const globalHints = g, globalHintsOn = g, perExHints = p, perExHintsVal = p; return ${expr};`
));

test('Plate hints precedence: the rule exists on every render path', () => {
    assert.ok(hintExprMatches.length >= 3,
        `expected the hintsOn precedence expression on >= 3 render paths, found ${hintExprMatches.length}`);
    // The "global on" half always reads `plateHintsEnabled !== false` so a
    // missing setting means on-by-default.
    assert.ok([...workoutViewSrc.matchAll(/plateHintsEnabled !== false/g)].length >= 3,
        'global default-on reads plateHintsEnabled !== false');
});

for (const [i, computeHintsOn] of hintFns.entries()) {
    test(`Plate hints precedence table holds on render path ${i + 1}`, () => {
        assert.equal(computeHintsOn(true, true), true, 'global ON + per-exercise ON = on');
        assert.equal(computeHintsOn(true, false), false, 'global ON + per-exercise OFF = off');
        assert.equal(computeHintsOn(true, undefined), true, 'global ON + no pref = on (default)');
        assert.equal(computeHintsOn(false, true), false, 'global OFF beats per-exercise ON');
        assert.equal(computeHintsOn(false, undefined), false, 'global OFF + no pref = off');
    });
}

// ---------------------------------------------------------------------------
// 4b. isPlateLoaded equipment gating: the REAL set from workout-view.js
// ---------------------------------------------------------------------------

const plateSetMatch = /const PLATE_LOADED_EQUIPMENT = new globalThis\.Set\((\[[^\]]*\])\)/.exec(workoutViewSrc);

test('PLATE_LOADED_EQUIPMENT: extracted from workout-view.js', () => {
    assert.ok(plateSetMatch, 'PLATE_LOADED_EQUIPMENT declaration found');
});

const PLATE_LOADED_EQUIPMENT = new Set(JSON.parse(plateSetMatch[1].replace(/'/g, '"')));

test('isPlateLoaded: barbell, trap-bar, machine, plate and sled are plate-loaded', () => {
    for (const eq of ['barbell', 'trap-bar', 'machine', 'plate', 'sled']) {
        assert.equal(PLATE_LOADED_EQUIPMENT.has(eq), true, `${eq} is plate-loaded`);
    }
});

test('isPlateLoaded: dumbbell, cable, bodyweight and kettlebell are NOT plate-loaded', () => {
    for (const eq of ['dumbbell', 'cable', 'bodyweight', 'kettlebell']) {
        assert.equal(PLATE_LOADED_EQUIPMENT.has(eq), false, `${eq} is not plate-loaded`);
    }
});

// ---------------------------------------------------------------------------
// 4c. Bar-weight base: barbell subtracts the bar, machine does not
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

// ---------------------------------------------------------------------------
// 5. toggleRepRange: the REAL method from programs-view.js.
//
// Why it matters: collapsing an 8-10 range must keep the FIRST number (8),
// because that is the working target the user typed first; expanding a single
// target must seed a sensible small range (min+2, capped at 100), and
// re-picking the already-active mode from the segmented control is a no-op.
// ---------------------------------------------------------------------------

function makeRangeEditor(sets) {
    const document = { querySelector: () => null }; // focus move is out of scope here
    const methods = buildMethods(programsViewSrc, ['toggleRepRange'], { document }, 'programs-view.js');
    const view = Object.create(methods);
    view.currentProgram = new Program({
        name: 'Range',
        exercises: [{ exerciseId: 'e1', exerciseName: 'Bench', sets, restSeconds: 90, restAfterSeconds: 90 }],
    });
    view.renderProgramExercises = () => {};
    const row = (si = 0) => view.currentProgram.exercises[0].sets[si];
    return { view, row };
}

test('toggleRepRange: collapsing 8-10 keeps 8 (repsMin), not 10', () => {
    const { view, row } = makeRangeEditor([{ repsMin: 8, repsMax: 10 }]);
    view.toggleRepRange(0, 0);
    assert.equal(row().repsMin, 8, 'repsMin unchanged');
    assert.equal(row().repsMax, 8, 'repsMax set to repsMin (first number)');
});

test('toggleRepRange: expanding a single rep adds 2 to max', () => {
    const { view, row } = makeRangeEditor([{ repsMin: 10, repsMax: 10 }]);
    view.toggleRepRange(0, 0);
    assert.equal(row().repsMin, 10, 'repsMin unchanged on expand');
    assert.equal(row().repsMax, 12, 'repsMax = repsMin + 2');
});

test('toggleRepRange: expanding a single rep near the cap stops at 100', () => {
    const { view, row } = makeRangeEditor([{ repsMin: 99, repsMax: 99 }]);
    view.toggleRepRange(0, 0);
    assert.equal(row().repsMax, 100, 'capped at 100');
});

test('toggleRepRange: re-picking the already-active mode is a no-op', () => {
    const single = makeRangeEditor([{ repsMin: 10, repsMax: 10 }]);
    single.view.toggleRepRange(0, 0, 'single');
    assert.equal(single.row().repsMax, 10, 'Single re-picked on a single set changes nothing');

    const range = makeRangeEditor([{ repsMin: 8, repsMax: 10 }]);
    range.view.toggleRepRange(0, 0, 'range');
    assert.equal(range.row().repsMax, 10, 'Range re-picked on a range set changes nothing');
});

test('toggleRepRange: explicit mode switches when it differs from the current state', () => {
    const { view, row } = makeRangeEditor([{ repsMin: 8, repsMax: 10 }]);
    view.toggleRepRange(0, 0, 'single');
    assert.equal(row().repsMax, 8, 'range collapsed by an explicit "single" pick');
});
