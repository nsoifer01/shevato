/**
 * Unit provenance: the migration repair for the 65 lb -> 143.3 lb bug.
 *
 * Expected kilogram values here are HARD-CODED from an independent
 * calculation (lb x 0.45359237, evaluated separately), never derived by
 * calling the conversion helpers this suite is testing. A test that computes
 * its expectation with the same function as the implementation cannot catch
 * a wrong conversion - which is exactly how the original migration shipped
 * with a passing suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    migrateStoredData, reconcileUnits, classifySession, measurementProvenance,
    detectClobber, resolveMeasurementUnits, isCanonicalRecord, stampCanonical,
    CANONICAL_FLAG, DATA_SCHEMA_VERSION, CANONICAL, LEGACY, AMBIGUOUS,
    MEASUREMENT_CHOICE_IMPERIAL, MEASUREMENT_CHOICE_METRIC,
} from '../js/utils/data-migrations.js';

/**
 * Independently computed kilogram values for the round pound numbers a real
 * imperial lifter loads. Produced with an exact international pound
 * (0.45359237) OUTSIDE this module, and pinned as literals.
 */
const LB_TO_KG = {
    20: 9.0718474,
    45: 20.41165665,
    65: 29.48350405,
    95: 43.09127515,
    135: 61.23496995,
    185: 83.91458845,
    225: 102.05828325,
    315: 142.88159655,
};

/** Independently computed centimetre values for round inch measurements. */
const IN_TO_CM = { 15: 38.1, 23: 58.42, 33: 83.82, 34: 86.36, 42: 106.68 };

const session = (over = {}) => ({
    id: 1, date: '2026-08-12', workoutDayName: 'Push A',
    sessionUnit: null, completed: true,
    exercises: [{
        exerciseId: 'dumbbell-bench-press', exerciseName: 'Dumbbell Bench Press',
        sets: [{ weight: 65, reps: 10, duration: 0, completed: true, slot: 0 }],
    }],
    ...over,
});

const measurement = (over = {}) => ({
    id: 1, date: '2026-08-12', weight: 180, bodyFat: 17,
    chest: 42, waist: 34, hips: null, armLeft: 15, armRight: 15,
    thighLeft: 23, thighRight: 23, notes: '', ...over,
});

const firstWeight = (s) => s.exercises[0].sets[0].weight;

/**
 * Compare against an independently computed literal. The tolerance absorbs
 * IEEE-754 last-bit noise (20 x 0.45359237 evaluates to 9.071847400000001 in
 * doubles) while staying ~9 orders of magnitude tighter than the 2.2x class
 * of error this suite exists to catch.
 */
function closeTo(actual, expected, msg) {
    assert.ok(Math.abs(actual - expected) < 1e-9,
        `${msg}: expected ~${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
test('legacy lb profile: every round pound value converts to its exact kg', () => {
    for (const [lb, kg] of Object.entries(LB_TO_KG)) {
        const out = migrateStoredData({
            sessions: [session({ exercises: [{ exerciseId: 'x', sets: [{ weight: Number(lb), reps: 5, completed: true }] }] })],
            settings: { weightUnit: 'lb' },
        }, 0);
        const stored0 = firstWeight(out.sessions[0]);
        closeTo(stored0, kg, `${lb} lb should store as ${kg} kg`);
        // The property that matters at the display boundary: the number the
        // lifter typed comes back exactly.
        assert.equal(Number((stored0 / 0.45359237).toFixed(6)), Number(lb),
            `${lb} lb did not round-trip`);
    }
});

test('THE bug: 65 lb stays 65 lb, it does not become 143.3 lb', () => {
    const out = migrateStoredData({ sessions: [session()], settings: { weightUnit: 'lb' } }, 0);
    const stored = firstWeight(out.sessions[0]);
    closeTo(stored, 29.48350405, '65 lb canonical');
    // Rendered back in pounds by the display boundary: exactly 65, not 143.3.
    assert.equal(Number((stored / 0.45359237).toFixed(6)), 65);
});

test('legacy kg profile is a pure no-op: 65 kg stays 65', () => {
    const out = migrateStoredData({ sessions: [session()], settings: { weightUnit: 'kg' } }, 0);
    assert.equal(firstWeight(out.sessions[0]), 65);
    // ...and reads as 143.3 lb only when the DISPLAY unit is pounds, which is
    // correct: this lifter really did press 65 kilograms.
    assert.equal(Number((65 / 0.45359237).toFixed(1)), 143.3);
});

// ---------------------------------------------------------------------------
test('the damaged install is detected and repaired', () => {
    // What a clobbered profile looks like: version says migrated, records say
    // otherwise (no sessionUnit, which v1 always writes).
    const damaged = { sessions: [session()], settings: { weightUnit: 'lb' } };
    assert.equal(detectClobber(damaged.sessions, 2), true);

    const out = migrateStoredData(damaged, 2);
    closeTo(firstWeight(out.sessions[0]), LB_TO_KG[65], 'damaged install repaired');
    assert.equal(out.sessions[0][CANONICAL_FLAG], true);
});

test('a correctly migrated record is never converted a second time', () => {
    const healthy = {
        sessions: [session({
            sessionUnit: 'lb',
            exercises: [{ exerciseId: 'x', sets: [{ weight: LB_TO_KG[65], reps: 10, completed: true }] }],
        })],
        settings: { weightUnit: 'lb' },
    };
    const out = migrateStoredData(healthy, 2);
    closeTo(firstWeight(out.sessions[0]), LB_TO_KG[65], 'must not double-convert');
    assert.equal(out.sessions[0][CANONICAL_FLAG], true);
});

test('a stamped record is immune even when everything else says legacy', () => {
    const stamped = stampCanonical(session({ sessionUnit: null }));
    assert.equal(classifySession(stamped, { dataVersion: 0 }), CANONICAL);
    assert.equal(classifySession(stamped, { dataVersion: 2, clobbered: true }), CANONICAL);
    const out = reconcileUnits({ sessions: [stamped] }, { accountUnit: 'lb', dataVersion: 0 });
    assert.equal(firstWeight(out.sessions[0]), 65, 'stamped record untouched');
});

test('idempotent: repeated runs change nothing after the first', () => {
    let snap = { sessions: [session()], measurements: [], settings: { weightUnit: 'lb' } };
    const first = migrateStoredData(snap, 0);
    const after = firstWeight(first.sessions[0]);
    closeTo(after, LB_TO_KG[65], 'first run');

    let carried = { sessions: first.sessions, measurements: first.measurements, settings: snap.settings };
    for (let i = 0; i < 5; i++) {
        const again = migrateStoredData(carried, first.version);
        assert.equal(firstWeight(again.sessions[0]), after, `run ${i + 2} drifted`);
        assert.equal(again.report.sessionsRepaired, 0);
        carried = { sessions: again.sessions, measurements: again.measurements, settings: snap.settings };
    }
});

test('switching display unit never retriggers a conversion', () => {
    const first = migrateStoredData({ sessions: [session()], settings: { weightUnit: 'lb' } }, 0);
    const kg = firstWeight(first.sessions[0]);
    // The user flips the app to kilograms; the stored numbers must not move.
    for (const unit of ['kg', 'lb', 'kg', 'lb']) {
        const out = reconcileUnits({ sessions: first.sessions },
            { accountUnit: unit, dataVersion: first.version });
        assert.equal(firstWeight(out.sessions[0]), kg, `unit ${unit} moved the data`);
        assert.equal(out.report.changed, false);
    }
});

// ---------------------------------------------------------------------------
test('classifySession: the four states', () => {
    // never migrated -> legacy, even with an in-workout toggle recorded
    assert.equal(classifySession(session({ sessionUnit: null }), { dataVersion: 0 }), LEGACY);
    assert.equal(classifySession(session({ sessionUnit: 'kg' }), { dataVersion: 0 }), LEGACY);
    // migrated install, no sessionUnit -> v1 never saw it -> legacy
    assert.equal(classifySession(session({ sessionUnit: null }), { dataVersion: 2, clobbered: true }), LEGACY);
    // migrated install, intact -> canonical
    assert.equal(classifySession(session({ sessionUnit: 'lb' }), { dataVersion: 2, clobbered: false }), CANONICAL);
    // damaged install + a sessionUnit -> genuinely unprovable
    assert.equal(classifySession(session({ sessionUnit: 'lb' }), { dataVersion: 2, clobbered: true }), AMBIGUOUS);
});

test('ambiguous sessions are reported and left untouched, never guessed', () => {
    const out = reconcileUnits({
        sessions: [session({ sessionUnit: null }), session({ id: 2, sessionUnit: 'lb' })],
    }, { accountUnit: 'lb', dataVersion: 2 });
    assert.equal(out.report.clobberDetected, true);
    assert.equal(out.report.sessionsRepaired, 1);
    assert.equal(out.report.sessionsAmbiguous, 1);
    closeTo(firstWeight(out.sessions[0]), LB_TO_KG[65], 'provable one repaired');
    assert.equal(firstWeight(out.sessions[1]), 65, 'unprovable one untouched');
});

// ---------------------------------------------------------------------------
test('measurements: an ordinary legacy lb profile converts without asking', () => {
    const out = migrateStoredData({
        sessions: [], measurements: [measurement()],
        goals: { weight: { target: 175 }, waist: { target: 32 } },
        settings: { weightUnit: 'lb' },
    }, 0);
    const m = out.measurements[0];
    closeTo(m.weight, 81.6466266, '180 lb body weight');   // computed independently
    closeTo(m.waist, IN_TO_CM[34], '34 in waist');
    closeTo(m.chest, IN_TO_CM[42], '42 in chest');
    closeTo(m.armLeft, IN_TO_CM[15], '15 in arm');
    assert.equal(m[CANONICAL_FLAG], true);
    assert.equal(out.report.measurementsNeedingConfirmation, 0);
});

test('measurements: a kg profile is canonical either way, never asked about', () => {
    assert.equal(measurementProvenance({ dataVersion: 2, accountUnit: 'kg', clobbered: true }), CANONICAL);
    const out = reconcileUnits({ sessions: [session()], measurements: [measurement({ weight: 84, waist: 86 })] },
        { accountUnit: 'kg', dataVersion: 2 });
    assert.equal(out.measurements[0].weight, 84, 'kg measurements never move');
    assert.equal(out.report.measurementsNeedingConfirmation, 0);
});

test('measurements: the damaged lb profile is ASKED, not guessed', () => {
    const out = reconcileUnits({
        sessions: [session({ sessionUnit: null })],
        measurements: [measurement()],
    }, { accountUnit: 'lb', dataVersion: 2 });
    assert.equal(out.report.measurementsNeedingConfirmation, 1);
    // Nothing was rewritten while the question is open.
    assert.equal(out.measurements[0].weight, 180);
    assert.equal(out.measurements[0].waist, 34);
    assert.equal(isCanonicalRecord(out.measurements[0]), false);
});

test('measurements: the answer is applied exactly once and then stamped', () => {
    const imperial = resolveMeasurementUnits([measurement()], { weight: { target: 175 } }, MEASUREMENT_CHOICE_IMPERIAL);
    closeTo(imperial.measurements[0].weight, 81.6466266, 'confirmed imperial weight');
    closeTo(imperial.measurements[0].waist, IN_TO_CM[34], 'confirmed imperial waist');
    assert.equal(imperial.converted, true);
    // Applying it again is a no-op because the record is now stamped.
    const twice = resolveMeasurementUnits(imperial.measurements, imperial.goals, MEASUREMENT_CHOICE_IMPERIAL);
    closeTo(twice.measurements[0].weight, 81.6466266, 'double conversion');

    const metric = resolveMeasurementUnits([measurement({ weight: 84, waist: 86 })], null, MEASUREMENT_CHOICE_METRIC);
    assert.equal(metric.measurements[0].weight, 84, 'metric answer keeps the numbers');
    assert.equal(metric.measurements[0][CANONICAL_FLAG], true);
    assert.equal(metric.converted, false);
});

test('answered profiles are never asked again', () => {
    const out = reconcileUnits({
        sessions: [session({ sessionUnit: null })], measurements: [measurement()],
    }, { accountUnit: 'lb', dataVersion: 2, measurementsResolved: true });
    assert.equal(out.report.measurementsNeedingConfirmation, 0);
});

// ---------------------------------------------------------------------------
test('stale records arriving from another device are repaired, canonical ones are not', () => {
    // A repaired profile, then an old device pushes an un-migrated session in.
    const repaired = stampCanonical(session({ sessionUnit: 'lb',
        exercises: [{ exerciseId: 'x', sets: [{ weight: LB_TO_KG[135], reps: 5, completed: true }] }] }));
    const stale = session({ id: 99, sessionUnit: null,
        exercises: [{ exerciseId: 'x', sets: [{ weight: 135, reps: 5, completed: true }] }] });

    const out = reconcileUnits({ sessions: [repaired, stale] },
        { accountUnit: 'lb', dataVersion: DATA_SCHEMA_VERSION });
    closeTo(firstWeight(out.sessions[0]), LB_TO_KG[135], 'canonical record untouched');
    closeTo(firstWeight(out.sessions[1]), LB_TO_KG[135], 'stale record repaired');
    assert.equal(out.report.sessionsRepaired, 1);
});

test('a healthy profile scans clean, repeatedly', () => {
    const healthy = {
        sessions: [stampCanonical(session({ sessionUnit: 'lb' }))],
        measurements: [stampCanonical(measurement())],
    };
    for (let i = 0; i < 3; i++) {
        const out = reconcileUnits(healthy, { accountUnit: 'lb', dataVersion: DATA_SCHEMA_VERSION });
        assert.equal(out.report.changed, false, `scan ${i + 1} mutated a healthy profile`);
        assert.equal(out.report.sessionsRepaired, 0);
        assert.equal(out.report.measurementsNeedingConfirmation, 0);
    }
});

test('the active workout is repaired with the same rules', () => {
    const out = reconcileUnits({ sessions: [], activeWorkout: session({ sessionUnit: null }) },
        { accountUnit: 'lb', dataVersion: 2 });
    closeTo(firstWeight(out.activeWorkout), LB_TO_KG[65], 'active workout repaired');
    assert.equal(out.report.activeWorkoutRepaired, true);
});
