import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Settings } from '../js/models/Settings.js';

test('Settings: timer marker defaults are 10 (first warning) / 5 (countdown)', () => {
    const s = Settings.getDefault();
    assert.equal(s.timerFirstWarningSeconds, 10);
    assert.equal(s.timerCountdownSeconds, 5);
});

test('Settings: legacy data without timer keys loads with the defaults', () => {
    // Simulate a previously-saved settings blob from before this feature.
    const legacy = { weightUnit: 'lb', soundAlerts: true, vibrationAlerts: false };
    const s = Settings.fromJSON(legacy);
    assert.equal(s.timerFirstWarningSeconds, 10);
    assert.equal(s.timerCountdownSeconds, 5);
});

test('Settings: timer markers round-trip through toJSON/fromJSON', () => {
    const s = new Settings({ timerFirstWarningSeconds: 20, timerCountdownSeconds: 10 });
    const json = s.toJSON();
    assert.equal(json.timerFirstWarningSeconds, 20);
    assert.equal(json.timerCountdownSeconds, 10);
    const back = Settings.fromJSON(json);
    assert.equal(back.timerFirstWarningSeconds, 20);
    assert.equal(back.timerCountdownSeconds, 10);
});

test('Settings: first warning accepts Off (0) and the old fixed options unchanged', () => {
    for (const v of [0, 10, 15, 20, 30]) {
        assert.equal(new Settings({ timerFirstWarningSeconds: v }).timerFirstWarningSeconds, v);
    }
    for (const v of [3, 5, 10]) {
        assert.equal(new Settings({ timerCountdownSeconds: v }).timerCountdownSeconds, v);
    }
});

// Item R2-1: markers are now free numeric inputs, not a fixed option list.
test('R2-1: arbitrary in-range integers are accepted (no snap to fixed options)', () => {
    assert.equal(new Settings({ timerFirstWarningSeconds: 7 }).timerFirstWarningSeconds, 7);
    assert.equal(new Settings({ timerFirstWarningSeconds: 25 }).timerFirstWarningSeconds, 25);
    assert.equal(new Settings({ timerCountdownSeconds: 4 }).timerCountdownSeconds, 4);
    assert.equal(new Settings({ timerCountdownSeconds: 8 }).timerCountdownSeconds, 8);
});

test('R2-1: invalid / empty timer values fall back to defaults', () => {
    assert.equal(new Settings({ timerFirstWarningSeconds: 'nope' }).timerFirstWarningSeconds, 10);
    assert.equal(new Settings({ timerFirstWarningSeconds: '' }).timerFirstWarningSeconds, 10);
    assert.equal(new Settings({ timerFirstWarningSeconds: -3 }).timerFirstWarningSeconds, 10);
    assert.equal(new Settings({ timerCountdownSeconds: null }).timerCountdownSeconds, 5);
    assert.equal(new Settings({ timerCountdownSeconds: 0 }).timerCountdownSeconds, 5);
    assert.equal(new Settings({ timerCountdownSeconds: -1 }).timerCountdownSeconds, 5);
});

test('R2-1: countdown start minimum is 1, first warning 0 stays off (disabled)', () => {
    assert.equal(new Settings({ timerCountdownSeconds: 1 }).timerCountdownSeconds, 1);
    assert.equal(new Settings({ timerFirstWarningSeconds: 0 }).timerFirstWarningSeconds, 0);
});

test('R2-1: values are clamped to their caps (120 / 60) and rounded to integers', () => {
    assert.equal(new Settings({ timerFirstWarningSeconds: 999 }).timerFirstWarningSeconds, 120);
    assert.equal(new Settings({ timerCountdownSeconds: 999 }).timerCountdownSeconds, 60);
    assert.equal(new Settings({ timerFirstWarningSeconds: 12.7 }).timerFirstWarningSeconds, 13);
    assert.equal(new Settings({ timerCountdownSeconds: 6.4 }).timerCountdownSeconds, 6);
});

test('R2-1: string inputs (number-field values are strings) are accepted', () => {
    assert.equal(new Settings({ timerFirstWarningSeconds: '25' }).timerFirstWarningSeconds, 25);
    assert.equal(new Settings({ timerCountdownSeconds: '8' }).timerCountdownSeconds, 8);
    assert.equal(Settings.normalizeFirstWarningSeconds('0'), 0);
    assert.equal(Settings.normalizeCountdownSeconds('1'), 1);
});

test('R2-1: legacy normalizeTimerSeconds option helper still works for explicit lists', () => {
    assert.equal(Settings.normalizeTimerSeconds('20', [0, 10, 15, 20, 30], 10), 20);
    assert.equal(Settings.normalizeTimerSeconds('0', [0, 10, 15, 20, 30], 10), 0);
    assert.equal(Settings.normalizeTimerSeconds('3', [3, 5, 10], 5), 3);
});
