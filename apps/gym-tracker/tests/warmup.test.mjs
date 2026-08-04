// Item 6: the warm-up ramp is a coaching aid, never a logged set. These tests
// pin the config contract (exact defaults for absent/partial JSON), the
// gating rules (barbell only, threshold, disabled), and the ramp math.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    WARMUP_DEFAULTS,
    normalizeWarmupSettings,
    warmupThreshold,
    shouldShowWarmup,
    buildWarmupRamp,
} = await import('../js/utils/warmup.js');

// ---------------------------------------------------------------------------
// normalizeWarmupSettings
// ---------------------------------------------------------------------------

test('normalizeWarmupSettings: absent key yields exactly the documented defaults', () => {
    const s = normalizeWarmupSettings(null);
    assert.equal(s.enabled, true);
    assert.equal(s.thresholdKg, 40);
    assert.equal(s.thresholdLb, 90);
    assert.deepEqual(s.ramp, [{ pct: 0, reps: 8 }, { pct: 50, reps: 5 }, { pct: 75, reps: 3 }]);
});

test('normalizeWarmupSettings: parses the raw localStorage string', () => {
    const s = normalizeWarmupSettings('{"thresholdKg":60}');
    assert.equal(s.thresholdKg, 60);
    assert.equal(s.thresholdLb, 90, 'untouched fields keep the default');
});

test('normalizeWarmupSettings: partial objects fall back field by field', () => {
    const s = normalizeWarmupSettings({ ramp: [{ pct: 60, reps: 4 }] });
    assert.equal(s.enabled, true);
    assert.equal(s.thresholdKg, 40);
    assert.deepEqual(s.ramp, [{ pct: 60, reps: 4 }]);
});

test('normalizeWarmupSettings: garbage JSON does not disable warm-ups', () => {
    const s = normalizeWarmupSettings('{not json');
    assert.deepEqual(s.ramp, WARMUP_DEFAULTS.ramp.map(r => ({ ...r })));
    assert.equal(s.enabled, true);
});

test('normalizeWarmupSettings: enabled:false is honored', () => {
    assert.equal(normalizeWarmupSettings({ enabled: false }).enabled, false);
});

test('normalizeWarmupSettings: invalid ramp rows are dropped, empty ramp falls back', () => {
    const s = normalizeWarmupSettings({ ramp: [{ pct: 50, reps: 5 }, { pct: 'x', reps: 3 }, { pct: 75, reps: 0 }] });
    assert.deepEqual(s.ramp, [{ pct: 50, reps: 5 }]);
    const empty = normalizeWarmupSettings({ ramp: [{ reps: 0 }] });
    assert.equal(empty.ramp.length, 3, 'nothing usable -> documented default ramp');
});

test('warmupThreshold: follows the display unit', () => {
    const s = normalizeWarmupSettings(null);
    assert.equal(warmupThreshold(s, 'kg'), 40);
    assert.equal(warmupThreshold(s, 'lb'), 90);
});

// ---------------------------------------------------------------------------
// shouldShowWarmup
// ---------------------------------------------------------------------------

const base = { settings: normalizeWarmupSettings(null), unit: 'kg', equipment: 'barbell', isDuration: false, workingWeight: 100 };

test('shouldShowWarmup: heavy barbell work qualifies', () => {
    assert.equal(shouldShowWarmup(base), true);
    assert.equal(shouldShowWarmup({ ...base, equipment: 'trap-bar' }), true);
});

test('shouldShowWarmup: non-barbell equipment never ramps', () => {
    assert.equal(shouldShowWarmup({ ...base, equipment: 'dumbbell' }), false);
    assert.equal(shouldShowWarmup({ ...base, equipment: 'machine' }), false);
});

test('shouldShowWarmup: duration exercises never ramp', () => {
    assert.equal(shouldShowWarmup({ ...base, isDuration: true }), false);
});

test('shouldShowWarmup: below the threshold there is nothing to warm up for', () => {
    assert.equal(shouldShowWarmup({ ...base, workingWeight: 39.5 }), false);
    assert.equal(shouldShowWarmup({ ...base, workingWeight: 40 }), true, 'at the threshold counts');
});

test('shouldShowWarmup: the lb threshold applies in an lb session', () => {
    assert.equal(shouldShowWarmup({ ...base, unit: 'lb', workingWeight: 85 }), false);
    assert.equal(shouldShowWarmup({ ...base, unit: 'lb', workingWeight: 95 }), true);
});

test('shouldShowWarmup: enabled:false turns the strip off entirely', () => {
    const settings = normalizeWarmupSettings({ enabled: false });
    assert.equal(shouldShowWarmup({ ...base, settings }), false);
});

test('shouldShowWarmup: an unknown working weight shows nothing', () => {
    assert.equal(shouldShowWarmup({ ...base, workingWeight: 0 }), false);
});

// ---------------------------------------------------------------------------
// buildWarmupRamp
// ---------------------------------------------------------------------------

// Stand-in for the plate calculator: 2.5kg-loadable weights on a 20kg bar.
const roundTo2p5 = (w) => Math.max(20, Math.floor(w / 2.5) * 2.5);

test('buildWarmupRamp: pct 0 is the empty bar, the rest are rounded percentages', () => {
    const rows = buildWarmupRamp({
        settings: normalizeWarmupSettings(null),
        workingWeight: 100,
        barWeight: 20,
        roundWeight: roundTo2p5,
    });
    assert.deepEqual(rows, [
        { pct: 0, reps: 8, weight: 20, isBar: true },
        { pct: 50, reps: 5, weight: 50, isBar: false },
        { pct: 75, reps: 3, weight: 75, isBar: false },
    ]);
});

test('buildWarmupRamp: rounds to what the plates can actually load', () => {
    const rows = buildWarmupRamp({
        settings: normalizeWarmupSettings(null),
        workingWeight: 61,
        barWeight: 20,
        roundWeight: roundTo2p5,
    });
    assert.deepEqual(rows.map(r => r.weight), [20, 30, 45], '50% of 61 = 30.5 -> 30');
});

test('buildWarmupRamp: ramp rows at or below the bar are dropped', () => {
    const rows = buildWarmupRamp({
        settings: normalizeWarmupSettings(null),
        workingWeight: 40,
        barWeight: 20,
        roundWeight: roundTo2p5,
    });
    assert.deepEqual(rows.map(r => r.pct), [0, 75], '50% of 40 is the bar itself');
});

test('buildWarmupRamp: no bar weight configured drops the empty-bar row', () => {
    const rows = buildWarmupRamp({
        settings: normalizeWarmupSettings(null),
        workingWeight: 100,
        barWeight: 0,
        roundWeight: (w) => w,
    });
    assert.deepEqual(rows.map(r => r.pct), [50, 75]);
});
