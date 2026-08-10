// Settings defaults generation 1 (owner call, 2026-08-10): Monday starts the
// week, times render 24-hour, and the kg plate stack gains 45/35/20/15.
//
// Every install writes its settings on first boot, so changing a default in
// the constructor alone reaches nobody who already uses the app. These tests
// pin the one-time upgrade that does reach them - and, just as importantly,
// that it runs ONCE and leaves a customised plate stack alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Settings } from '../js/models/Settings.js';

/** Settings as an install on the pre-2026-08-10 defaults would have stored them. */
const legacyStored = (overrides = {}) => ({
    weightUnit: 'kg',
    firstDayOfWeek: 0,
    timeFormat: '12',
    plates: [25, 20, 15, 10, 5, 2.5, 1.25],
    ...overrides,
});

// ---------------------------------------------------------------------------
// The new defaults themselves
// ---------------------------------------------------------------------------

test('a fresh install gets Monday, 24-hour, and the full kg stack', () => {
    const s = Settings.getDefault();
    assert.equal(s.firstDayOfWeek, 1);
    assert.equal(s.timeFormat, '24');
    assert.deepEqual(s.plates, [45, 35, 25, 20, 15, 10, 5, 2.5, 1.25]);
});

test('the lb plate stack is untouched', () => {
    assert.deepEqual(new Settings({ weightUnit: 'lb' }).plates, [45, 35, 25, 10, 5, 2.5]);
});

test('an explicit 12-hour choice round-trips', () => {
    assert.equal(new Settings({ timeFormat: '12' }).timeFormat, '12');
});

// ---------------------------------------------------------------------------
// applyDefaultUpgrades
// ---------------------------------------------------------------------------

test('upgrades a legacy install to the new defaults', () => {
    const s = Settings.fromJSON(legacyStored());
    assert.equal(Settings.applyDefaultUpgrades(s), true, 'caller is told to save');
    assert.equal(s.firstDayOfWeek, 1);
    assert.equal(s.timeFormat, '24');
    assert.deepEqual(s.plates, [45, 35, 25, 20, 15, 10, 5, 2.5, 1.25]);
});

test('a customised plate stack is never replaced', () => {
    const s = Settings.fromJSON(legacyStored({ plates: [20, 10, 5] }));
    Settings.applyDefaultUpgrades(s);
    assert.deepEqual(s.plates, [20, 10, 5]);
    assert.equal(s.firstDayOfWeek, 1, 'the other defaults still moved');
});

test('a customised lb stack is never replaced', () => {
    const s = Settings.fromJSON(legacyStored({ weightUnit: 'lb', plates: [45, 25, 10] }));
    Settings.applyDefaultUpgrades(s);
    assert.deepEqual(s.plates, [45, 25, 10]);
});

test('the upgrade runs exactly once', () => {
    const s = Settings.fromJSON(legacyStored());
    assert.equal(Settings.applyDefaultUpgrades(s), true);

    // The lifter deliberately goes back to Sunday and 12-hour afterwards.
    s.firstDayOfWeek = 0;
    s.timeFormat = '12';
    assert.equal(Settings.applyDefaultUpgrades(s), false, 'no second pass');
    assert.equal(s.firstDayOfWeek, 0, 'and the choice stands');
    assert.equal(s.timeFormat, '12');
});

test('the version stamp survives a JSON round-trip', () => {
    const s = Settings.fromJSON(legacyStored());
    Settings.applyDefaultUpgrades(s);
    const back = Settings.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    assert.equal(back.defaultsVersion, Settings.DEFAULTS_VERSION);
    assert.equal(Settings.applyDefaultUpgrades(back), false);
});

test('a fresh install is already current and needs no upgrade', () => {
    const s = Settings.getDefault();
    s.defaultsVersion = Settings.DEFAULTS_VERSION;
    assert.equal(Settings.applyDefaultUpgrades(s), false);
});

// ---------------------------------------------------------------------------
// sameStack
// ---------------------------------------------------------------------------

test('sameStack ignores ordering', () => {
    assert.equal(Settings.sameStack([2.5, 25, 10], [25, 10, 2.5]), true);
});

test('sameStack rejects different lengths and contents', () => {
    assert.equal(Settings.sameStack([25, 10], [25, 10, 5]), false);
    assert.equal(Settings.sameStack([25, 10, 5], [25, 10, 2.5]), false);
    assert.equal(Settings.sameStack(null, [25]), false);
});
