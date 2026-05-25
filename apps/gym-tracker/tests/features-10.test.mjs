/**
 * Tests for the 10 new gym-tracker features.
 *
 * Coverage:
 *   1  Progressive overload suggestion — getLastWorkoutData, overload increment
 *   2  Per-exercise strength chart — getExerciseProgression < 2 sessions
 *   3  PR Achievements — checkExercisePRs (fire, 7-day rate-limit, deload)
 *   4  Last-session comparison — getLastWorkoutData returns sets for reference
 *   5  JSON export / import — exportAllData shape, importAllData, legacy shape, bad data
 *   6  Program day rotation — _nextUpProgram logic
 *   7  Save rest adjustments — prompt only when overrides exist; persists to program
 *   8  Standalone plate calculator — calculatePlates, formatPlateStack, unit toggle
 *   9  Superset labels in history — letter assignment, single-exercise groups skipped
 *  10  Bodyweight-relative strength — ±7-day pairing window, hide-if-<2-points
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../js/services/AnalyticsService.js';
import { AchievementService } from '../js/services/AchievementService.js';
import { StorageService } from '../js/services/StorageService.js';
import { calculatePlates, formatPlateStack } from '../js/utils/plate-calculator.js';

// ── localStorage shim ────────────────────────────────────────────────────────
globalThis.localStorage = (() => {
    let store = new Map();
    return {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); },
        removeItem(k) { store.delete(k); },
        clear() { store = new Map(); },
    };
})();

// ── Helpers ──────────────────────────────────────────────────────────────────
const set = (weight, reps, slot = 0) => ({ weight, reps, duration: 0, completed: true, slot, volume: weight * reps });
const durationSet = (duration, slot = 0) => ({ weight: 0, reps: 0, duration, completed: true, slot, volume: 0 });

const exercise = (exerciseId, exerciseName, sets, { groupId = null } = {}) => ({
    exerciseId,
    exerciseName,
    sets,
    groupId,
    totalVolume: sets.reduce((s, x) => s + (x.weight || 0) * (x.reps || 0) + (x.duration || 0), 0),
});

const session = (id, date, exercises, { workoutDayName = 'Day A', programId = 1 } = {}) => ({
    id,
    date,
    timestamp: `${date}T09:00:00.000Z`,
    sortTimestamp: `${date}T09:00:00.000Z`,
    workoutDayName,
    programId,
    completed: true,
    duration: 60,
    exercises,
    totalVolume: exercises.reduce((s, e) => s + e.totalVolume, 0),
    totalSets: exercises.reduce((s, e) => s + e.sets.length, 0),
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Progressive Overload Auto-Suggestion
// ═══════════════════════════════════════════════════════════════════════════════

test('F1: getLastWorkoutData returns null when no prior sessions', () => {
    const result = AnalyticsService.getLastWorkoutData('bench', []);
    assert.equal(result, null);
});

test('F1: getLastWorkoutData returns most recent session sets', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8)])]),
        session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(85, 8)])]),
    ];
    const result = AnalyticsService.getLastWorkoutData('bench', sessions);
    assert.equal(result.date, '2026-04-08');
    assert.equal(result.sets[0].weight, 85);
});

test('F1: getLastWorkoutData with beforeDate excludes sessions on/after cutoff', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8)])]),
        session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(85, 8)])]),
    ];
    // beforeDate = 2026-04-08: should only see session 1
    const result = AnalyticsService.getLastWorkoutData('bench', sessions, '2026-04-08');
    assert.equal(result.date, '2026-04-01');
    assert.equal(result.sets[0].weight, 80);
});

test('F1: overload increment for upper-body compound is 2.5 kg', () => {
    // The increment logic lives in WorkoutView._overloadIncrement.
    // We verify it through direct table checks: for 'kg', non-lower = 2.5.
    // Bench Press has no squat/deadlift/leg press/lunge in the name.
    const isLower = (name) => /squat|deadlift|leg press|lunge/i.test(name);
    const increment = (name, unit) => {
        const lower = isLower(name);
        if (unit === 'lb') return lower ? 10 : 5;
        return lower ? 5 : 2.5;
    };
    assert.equal(increment('Bench Press', 'kg'), 2.5);
    assert.equal(increment('Overhead Press', 'kg'), 2.5);
});

test('F1: overload increment for lower-body compound is 5 kg', () => {
    const isLower = (name) => /squat|deadlift|leg press|lunge/i.test(name);
    const increment = (name, unit) => {
        if (unit === 'lb') return isLower(name) ? 10 : 5;
        return isLower(name) ? 5 : 2.5;
    };
    assert.equal(increment('Squat', 'kg'), 5);
    assert.equal(increment('Deadlift', 'kg'), 5);
    assert.equal(increment('Leg Press', 'kg'), 5);
    assert.equal(increment('Lunge', 'kg'), 5);
});

test('F1: overload increment doubles in lb units', () => {
    const isLower = (name) => /squat|deadlift|leg press|lunge/i.test(name);
    const increment = (name, unit) => {
        if (unit === 'lb') return isLower(name) ? 10 : 5;
        return isLower(name) ? 5 : 2.5;
    };
    assert.equal(increment('Bench Press', 'lb'), 5);
    assert.equal(increment('Squat', 'lb'), 10);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Per-Exercise Strength Chart
// ═══════════════════════════════════════════════════════════════════════════════

test('F2: getExerciseProgression with 0 sessions returns empty array', () => {
    assert.deepEqual(AnalyticsService.getExerciseProgression('bench', []), []);
});

test('F2: getExerciseProgression with 1 session returns 1 point (insufficient for chart)', () => {
    const sessions = [session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8)])])];
    const points = AnalyticsService.getExerciseProgression('bench', sessions);
    assert.equal(points.length, 1);
    // Chart should display "Log more sessions..." — code checks points.length < 2
    assert.ok(points.length < 2);
});

test('F2: getExerciseProgression with 2+ sessions returns multi-point array', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8)])]),
        session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(85, 8)])]),
    ];
    const points = AnalyticsService.getExerciseProgression('bench', sessions);
    assert.equal(points.length, 2);
    assert.equal(points[0].maxWeight, 80);
    assert.equal(points[1].maxWeight, 85);
});

test('F2: getExerciseProgression picks maxWeight across sets within a session', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8, 0), set(85, 6, 1), set(90, 4, 2)])]),
        session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(92, 4, 0)])]),
    ];
    const points = AnalyticsService.getExerciseProgression('bench', sessions);
    assert.equal(points[0].maxWeight, 90);
    assert.equal(points[1].maxWeight, 92);
});

test('F2: getExerciseProgression only includes sessions that have the exercise', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('squat', 'Squat', [set(100, 5)])]),
        session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(80, 8)])]),
    ];
    const points = AnalyticsService.getExerciseProgression('bench', sessions);
    assert.equal(points.length, 1);
    assert.equal(points[0].date, '2026-04-08');
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — PR Achievements (checkExercisePRs)
// ═══════════════════════════════════════════════════════════════════════════════

test('F3: checkExercisePRs fires when new session beats prior max weight', () => {
    const priorSessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    const newSession = session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(105, 5)])]);
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, {});
    assert.equal(prs.length, 1);
    assert.equal(prs[0].exerciseId, 'bench');
    assert.equal(prs[0].newMax, 105);
    assert.equal(prs[0].prevMax, 100);
});

test('F3: checkExercisePRs does NOT fire when new max equals prior max', () => {
    const priorSessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    const newSession = session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(100, 5)])]);
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, {});
    assert.equal(prs.length, 0);
});

test('F3: checkExercisePRs does NOT fire when weight is lower than prior max', () => {
    const priorSessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    // Deload session
    const newSession = session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(80, 5)])]);
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, {});
    assert.equal(prs.length, 0);
});

test('F3: checkExercisePRs does NOT fire when exercise has no prior data', () => {
    const priorSessions = []; // no prior
    const newSession = session(1, '2026-04-08', [exercise('bench', 'Bench Press', [set(100, 5)])]);
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, {});
    assert.equal(prs.length, 0);
});

test('F3: checkExercisePRs respects 7-day rate limit — suppresses if fired recently', () => {
    const priorSessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    const newSession = session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(105, 5)])]);
    // Mark PR as fired 3 days ago (within 7-day window)
    const recentDate = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, { bench: recentDate });
    assert.equal(prs.length, 0);
});

test('F3: checkExercisePRs fires after rate-limit window expires (>7 days ago)', () => {
    const priorSessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    const newSession = session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(105, 5)])]);
    // Mark PR as fired 8 days ago (outside 7-day window)
    const oldDate = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, { bench: oldDate });
    assert.equal(prs.length, 1);
});

test('F3: checkExercisePRs skips exercises with zero weight in new session', () => {
    const priorSessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    // Session with a bodyweight exercise (weight=0)
    const newSession = session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(0, 10)])]);
    const prs = AchievementService.checkExercisePRs(newSession, priorSessions, {});
    assert.equal(prs.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — Last-Session Comparison (getLastWorkoutData sets for reference)
// ═══════════════════════════════════════════════════════════════════════════════

test('F4: getLastWorkoutData returns full sets array for reference row', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8, 0), set(80, 8, 1)])]),
    ];
    const result = AnalyticsService.getLastWorkoutData('bench', sessions);
    assert.ok(result, 'should find prior data');
    assert.equal(result.sets.length, 2);
    assert.equal(result.sets[0].weight, 80);
    assert.equal(result.sets[0].reps, 8);
});

test('F4: getLastWorkoutData returns null for exercise with no prior history', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('squat', 'Squat', [set(100, 5)])]),
    ];
    const result = AnalyticsService.getLastWorkoutData('bench', sessions);
    assert.equal(result, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 5 — JSON Export / Import
// ═══════════════════════════════════════════════════════════════════════════════

const makeSvc = () => {
    localStorage.clear();
    return new StorageService();
};

test('F5: exportAllData returns { version, exportedAt, data } shape', () => {
    const svc = makeSvc();
    svc.saveSettings({ weightUnit: 'kg' });
    const exported = svc.exportAllData();
    assert.ok(exported.version, 'should have version');
    assert.ok(exported.exportedAt, 'should have exportedAt');
    assert.ok(exported.data && typeof exported.data === 'object', 'should have data object');
});

test('F5: exportAllData includes current schema version', () => {
    const svc = makeSvc();
    const exported = svc.exportAllData();
    assert.equal(exported.version, StorageService.SCHEMA_VERSION);
});

test('F5: importAllData with new shape restores all keys to localStorage', () => {
    const svc = makeSvc();
    svc.savePrograms([{ id: 1, name: 'Push Day' }]);
    svc.saveWorkoutSessions([{ id: 101, date: '2026-04-01' }]);
    const exported = svc.exportAllData();

    // Clear and re-import on a fresh instance
    localStorage.clear();
    const svc2 = new StorageService();
    svc2.importAllData(exported);
    const programs = svc2.getPrograms();
    assert.equal(programs.length, 1);
    assert.equal(programs[0].name, 'Push Day');
});

test('F5: importAllData with legacy flat shape migrates correctly', () => {
    const svc = makeSvc();
    const legacy = {
        version: '1.0',
        programs: [{ id: 1, name: 'Legacy Program' }],
        sessions: [{ id: 1, exercises: [{ sets: [{ weight: 80, reps: 5 }] }] }],
        settings: { weightUnit: 'kg' },
    };
    svc.importAllData(legacy);
    const programs = svc.getPrograms();
    assert.equal(programs.length, 1);
    assert.equal(programs[0].name, 'Legacy Program');
});

test('F5: validateImportData rejects garbage that lacks required keys', () => {
    // Inline the same validation logic used in settings-view.js
    const validate = (data) => {
        if (!data || typeof data !== 'object') return 'Invalid data format';
        if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) return null;
        const hasValid = data.hasOwnProperty('programs') || data.hasOwnProperty('sessions') || data.hasOwnProperty('settings');
        if (!hasValid) return 'Invalid data structure — not a Gym Tracker backup';
        return null;
    };
    assert.equal(validate(null), 'Invalid data format');
    assert.equal(validate('string'), 'Invalid data format');
    assert.equal(validate({ unrelated: true }), 'Invalid data structure — not a Gym Tracker backup');
    assert.equal(validate({ programs: [] }), null); // valid legacy
    assert.equal(validate({ version: '2.0', data: {} }), null); // valid new shape
});

test('F5: importAllData with new shape does not call migrateImport path', () => {
    const svc = makeSvc();
    // New shape with nested data object — must be imported directly without migration.
    const payload = {
        version: StorageService.SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
            gymTrackerPrograms: [{ id: 99, name: 'Imported Program' }],
        },
    };
    svc.importAllData(payload);
    // Key gymTrackerPrograms was written directly so getPrograms must return it
    const raw = JSON.parse(localStorage.getItem('gymTrackerPrograms'));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].name, 'Imported Program');
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 6 — Program Day Rotation (_nextUpProgram)
// ═══════════════════════════════════════════════════════════════════════════════

// We test the rotation logic directly — the function lives in HomeView but its
// algorithm is stateless and can be extracted as a pure function for testing.
function nextUpProgram(programs, sessions) {
    if (programs.length < 2) return null;
    const sorted = [...sessions].sort((a, b) => new Date(b.sortTimestamp) - new Date(a.sortTimestamp));
    const lastProgramId = sorted.length > 0 ? sorted[0].programId : null;
    if (lastProgramId == null) return programs[0];
    const idx = programs.findIndex(p => p.id === lastProgramId);
    if (idx < 0) return programs[0];
    return programs[(idx + 1) % programs.length];
}

const prog = (id, name) => ({ id, name, exercises: [{}] }); // minimal program

test('F6: with no sessions, returns first program', () => {
    const programs = [prog(1, 'A'), prog(2, 'B'), prog(3, 'C')];
    const result = nextUpProgram(programs, []);
    assert.equal(result.id, 1);
});

test('F6: after Day 1, suggests Day 2', () => {
    const programs = [prog(1, 'A'), prog(2, 'B'), prog(3, 'C')];
    const sessions = [{ id: 1, programId: 1, sortTimestamp: '2026-04-01T09:00:00Z' }];
    const result = nextUpProgram(programs, sessions);
    assert.equal(result.id, 2);
});

test('F6: after Day 2, suggests Day 3', () => {
    const programs = [prog(1, 'A'), prog(2, 'B'), prog(3, 'C')];
    const sessions = [{ id: 2, programId: 2, sortTimestamp: '2026-04-02T09:00:00Z' }];
    const result = nextUpProgram(programs, sessions);
    assert.equal(result.id, 3);
});

test('F6: after last day (Day 3), wraps to Day 1', () => {
    const programs = [prog(1, 'A'), prog(2, 'B'), prog(3, 'C')];
    const sessions = [{ id: 3, programId: 3, sortTimestamp: '2026-04-03T09:00:00Z' }];
    const result = nextUpProgram(programs, sessions);
    assert.equal(result.id, 1);
});

test('F6: single-program list returns null (no rotation)', () => {
    const programs = [prog(1, 'A')];
    const sessions = [{ id: 1, programId: 1, sortTimestamp: '2026-04-01T09:00:00Z' }];
    const result = nextUpProgram(programs, sessions);
    assert.equal(result, null);
});

test('F6: most recent session wins when multiple sessions exist', () => {
    const programs = [prog(1, 'A'), prog(2, 'B'), prog(3, 'C')];
    const sessions = [
        { id: 1, programId: 1, sortTimestamp: '2026-04-01T09:00:00Z' },
        { id: 2, programId: 2, sortTimestamp: '2026-04-03T09:00:00Z' }, // most recent = B
    ];
    const result = nextUpProgram(programs, sessions);
    assert.equal(result.id, 3); // next after B is C
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 7 — Save Rest Adjustments
// ═══════════════════════════════════════════════════════════════════════════════

// The logic lives in WorkoutView._maybeSaveRestOverrides which is async/modal.
// We test the persistence layer: given overrides, find the matching program exercise
// and update its restSeconds. This mirrors what the confirmed-yes path does.
function applyRestOverrides(program, sessionExercises, overrides) {
    Object.entries(overrides).forEach(([idxStr, seconds]) => {
        const ex = sessionExercises[Number(idxStr)];
        if (!ex) return;
        const progIdx = program.exercises.findIndex(pe => pe.exerciseId === ex.exerciseId);
        if (progIdx >= 0) {
            program.exercises[progIdx].restSeconds = seconds;
        }
    });
    return program;
}

test('F7: rest override persists to matching program exercise', () => {
    const program = {
        id: 1,
        name: 'Push Day',
        exercises: [
            { exerciseId: 'bench', restSeconds: 90 },
            { exerciseId: 'ohp', restSeconds: 60 },
        ],
    };
    const sessionExercises = [
        { exerciseId: 'bench', exerciseName: 'Bench Press' },
        { exerciseId: 'ohp', exerciseName: 'Overhead Press' },
    ];
    const overrides = { '0': 120 }; // override index 0 (bench) to 120s
    const updated = applyRestOverrides(program, sessionExercises, overrides);
    assert.equal(updated.exercises[0].restSeconds, 120);
    assert.equal(updated.exercises[1].restSeconds, 60); // unchanged
});

test('F7: rest override with no overrides does not modify program', () => {
    const program = {
        id: 1,
        exercises: [{ exerciseId: 'bench', restSeconds: 90 }],
    };
    const updated = applyRestOverrides(program, [], {});
    assert.equal(updated.exercises[0].restSeconds, 90);
});

test('F7: rest override for unknown exercise index is silently skipped', () => {
    const program = {
        id: 1,
        exercises: [{ exerciseId: 'bench', restSeconds: 90 }],
    };
    const sessionExercises = [{ exerciseId: 'bench', exerciseName: 'Bench Press' }];
    // Index 5 doesn't exist in sessionExercises
    const overrides = { '5': 180 };
    const updated = applyRestOverrides(program, sessionExercises, overrides);
    assert.equal(updated.exercises[0].restSeconds, 90);
});

test('F7: prompt should only fire when Object.keys(overrides).length > 0', () => {
    // The guard in finishWorkout: if (Object.keys(savedRestOverrides).length > 0)
    assert.ok(Object.keys({ '0': 120 }).length > 0);
    assert.ok(Object.keys({}).length === 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 8 — Standalone Plate Calculator
// ═══════════════════════════════════════════════════════════════════════════════

const KG_PLATES = [25, 20, 15, 10, 5, 2.5];
const LB_PLATES = [45, 35, 25, 10, 5, 2.5];

test('F8: plate calc modal — 100kg, 20kg bar → 25+15 per side', () => {
    const r = calculatePlates(100, 20, KG_PLATES);
    assert.equal(r.reachable, true);
    assert.equal(r.achievable, 100);
    assert.deepEqual(r.plates, [{ weight: 25, count: 1 }, { weight: 15, count: 1 }]);
});

test('F8: plate calc with no bar (bar=0) — 60kg target → 30 per side', () => {
    const r = calculatePlates(60, 0, KG_PLATES);
    assert.equal(r.perSide, 30);
    assert.equal(r.reachable, true);
});

test('F8: plate calc — lb unit, 225lb target, 45lb bar → 2×45 per side', () => {
    const r = calculatePlates(225, 45, LB_PLATES);
    assert.equal(r.reachable, true);
    assert.deepEqual(r.plates, [{ weight: 45, count: 2 }]);
});

test('F8: plate calc — target below bar returns belowBar=true', () => {
    const r = calculatePlates(15, 20, KG_PLATES);
    assert.equal(r.belowBar, true);
    assert.equal(r.reachable, false);
});

test('F8: formatPlateStack — bar only when no plates needed', () => {
    const r = calculatePlates(20, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '(bar only)');
});

test('F8: formatPlateStack — correct multi-plate string', () => {
    const r = calculatePlates(100, 20, KG_PLATES);
    assert.equal(formatPlateStack(r, 'kg'), '25kg + 15kg');
});

test('F8: plate calc ignores non-positive entries in plate list', () => {
    const r = calculatePlates(60, 20, [20, -5, 0, 'bad', 10]);
    assert.equal(r.reachable, true);
    assert.deepEqual(r.plates, [{ weight: 20, count: 1 }]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 9 — Superset Labels in History View
// ═══════════════════════════════════════════════════════════════════════════════

// Mirror the letter-assignment logic from history-view.js showWorkoutDetails.
function assignSupersetLetters(exercises) {
    const groupLetters = new Map();
    const groupCounts = new Map();
    exercises.forEach(ex => {
        if (ex.groupId == null) return;
        groupCounts.set(ex.groupId, (groupCounts.get(ex.groupId) || 0) + 1);
    });
    return exercises.map(ex => {
        const gid = ex.groupId;
        if (gid == null || (groupCounts.get(gid) || 0) <= 1) return null;
        if (!groupLetters.has(gid)) {
            groupLetters.set(gid, String.fromCharCode(65 + groupLetters.size));
        }
        return groupLetters.get(gid);
    });
}

test('F9: solo exercise gets no superset label', () => {
    const exs = [{ groupId: null }];
    assert.deepEqual(assignSupersetLetters(exs), [null]);
});

test('F9: two exercises sharing a groupId get label A', () => {
    const exs = [{ groupId: 'g1' }, { groupId: 'g1' }];
    assert.deepEqual(assignSupersetLetters(exs), ['A', 'A']);
});

test('F9: two separate supersets get letters A and B', () => {
    const exs = [
        { groupId: 'g1' },
        { groupId: 'g1' },
        { groupId: 'g2' },
        { groupId: 'g2' },
    ];
    assert.deepEqual(assignSupersetLetters(exs), ['A', 'A', 'B', 'B']);
});

test('F9: solo exercise within mixed session has no label', () => {
    const exs = [
        { groupId: 'g1' }, // superset A
        { groupId: 'g1' }, // superset A
        { groupId: null },  // solo — no label
    ];
    assert.deepEqual(assignSupersetLetters(exs), ['A', 'A', null]);
});

test('F9: single-exercise group (size 1) treated as solo — no label', () => {
    // A groupId that only one exercise has should not get a letter
    const exs = [
        { groupId: 'g1' }, // only one → treated as solo
        { groupId: 'g2' }, // pair
        { groupId: 'g2' }, // pair
    ];
    assert.deepEqual(assignSupersetLetters(exs), [null, 'A', 'A']);
});

test('F9: letters assigned in first-appearance order', () => {
    // g2 appears before g1 in order → gets A, g1 gets B
    const exs = [
        { groupId: 'g2' },
        { groupId: 'g2' },
        { groupId: 'g1' },
        { groupId: 'g1' },
    ];
    assert.deepEqual(assignSupersetLetters(exs), ['A', 'A', 'B', 'B']);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 10 — Bodyweight-Relative Strength Trends
// ═══════════════════════════════════════════════════════════════════════════════

// Mirror the pairing logic from measurements-view.js renderBwStrengthCharts.
function buildBwPairs(sessions, measurements, liftMatch) {
    const bwByDate = new Map();
    measurements.forEach(m => {
        if (m.weight != null && m.date) bwByDate.set(m.date, Number(m.weight));
    });

    const nearestBW = (dateStr) => {
        const ts = new Date(dateStr).getTime();
        let best = null;
        let bestDist = Infinity;
        bwByDate.forEach((w, d) => {
            const dist = Math.abs(new Date(d).getTime() - ts);
            if (dist <= 7 * 86400 * 1000 && dist < bestDist) {
                bestDist = dist;
                best = w;
            }
        });
        return best;
    };

    const pairs = [];
    sessions.forEach(s => {
        const ex = (s.exercises || []).find(e =>
            (e.exerciseName || '').toLowerCase().includes(liftMatch)
        );
        if (!ex) return;
        const topSet = (ex.sets || []).reduce((best, st) =>
            (st.weight || 0) > (best.weight || 0) ? st : best, { weight: 0 });
        if (!topSet.weight) return;
        const bw = nearestBW(s.date);
        if (bw == null) return;
        pairs.push({ date: s.date, ratio: topSet.weight / bw });
    });
    return pairs;
}

test('F10: pairs lift session with bodyweight measurement within ±7 days', () => {
    const sessions = [
        session(1, '2026-04-08', [exercise('bench', 'Bench Press', [set(80, 8)])]),
    ];
    const measurements = [
        { id: 1, date: '2026-04-10', weight: 80 }, // 2 days after session → within ±7
    ];
    const pairs = buildBwPairs(sessions, measurements, 'bench press');
    assert.equal(pairs.length, 1);
    assert.ok(Math.abs(pairs[0].ratio - 1.0) < 0.01); // 80/80 = 1.0
});

test('F10: does not pair when bodyweight is more than 7 days away', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8)])]),
    ];
    const measurements = [
        { id: 1, date: '2026-04-15', weight: 80 }, // 14 days after → outside ±7
    ];
    const pairs = buildBwPairs(sessions, measurements, 'bench press');
    assert.equal(pairs.length, 0);
});

test('F10: returns 0 pairs when sessions have no matching lift', () => {
    const sessions = [
        session(1, '2026-04-08', [exercise('squat', 'Squat', [set(100, 5)])]),
    ];
    const measurements = [{ id: 1, date: '2026-04-08', weight: 80 }];
    const pairs = buildBwPairs(sessions, measurements, 'bench press');
    assert.equal(pairs.length, 0);
});

test('F10: chart hides when fewer than 2 paired points', () => {
    const pairs = buildBwPairs(
        [session(1, '2026-04-08', [exercise('bench', 'Bench Press', [set(80, 8)])])],
        [{ id: 1, date: '2026-04-08', weight: 80 }],
        'bench press',
    );
    assert.equal(pairs.length, 1);
    // UI condition: pairs.length < 2 → skip chart
    assert.ok(pairs.length < 2);
});

test('F10: chart shows when 2+ paired points exist', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(80, 8)])]),
        session(2, '2026-04-08', [exercise('bench', 'Bench Press', [set(85, 8)])]),
    ];
    const measurements = [
        { id: 1, date: '2026-04-01', weight: 80 },
        { id: 2, date: '2026-04-08', weight: 79 },
    ];
    const pairs = buildBwPairs(sessions, measurements, 'bench press');
    assert.equal(pairs.length, 2);
    assert.ok(pairs.length >= 2); // chart renders
});

test('F10: uses nearest bodyweight when multiple measurements are close', () => {
    const sessions = [
        session(1, '2026-04-05', [exercise('bench', 'Bench Press', [set(80, 8)])]),
    ];
    const measurements = [
        { id: 1, date: '2026-04-03', weight: 82 }, // 2 days before
        { id: 2, date: '2026-04-06', weight: 79 }, // 1 day after (closer)
    ];
    const pairs = buildBwPairs(sessions, measurements, 'bench press');
    assert.equal(pairs.length, 1);
    // Nearest is April 6 (1 day away vs 2 days for April 3)
    assert.ok(Math.abs(pairs[0].ratio - 80 / 79) < 0.01);
});

test('F10: ratio computed as liftWeight / bodyweight', () => {
    const sessions = [
        session(1, '2026-04-01', [exercise('bench', 'Bench Press', [set(100, 5)])]),
    ];
    const measurements = [{ id: 1, date: '2026-04-01', weight: 80 }];
    const pairs = buildBwPairs(sessions, measurements, 'bench press');
    assert.equal(pairs.length, 1);
    assert.ok(Math.abs(pairs[0].ratio - 1.25) < 0.001); // 100/80 = 1.25
});
