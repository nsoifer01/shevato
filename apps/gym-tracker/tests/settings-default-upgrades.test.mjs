// Settings defaults, and the one-time upgrade that carries a changed default
// onto installs that already wrote their settings.
//
//   v1 (2026-08-10): Monday starts the week, times render 24-hour, and the kg
//     plate stack gains 45/35/20/15.
//   v2 (2026-08-19, GT-21): that kg stack is reverted. 45 kg and 35 kg are the
//     POUND plate sizes and do not exist in a kg-denominated gym, so out of
//     the box the calculator proposed unloadable hints ("150 kg -> 45 + 25 +
//     5" instead of "3 x 25").
//
// Every install writes its settings on first boot, so changing a default in
// the constructor alone reaches nobody who already uses the app. These tests
// pin the upgrade that does reach them - and, just as importantly, that it
// leaves a customised plate stack alone.

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

test('a fresh install gets Monday, 24-hour, and a loadable kg stack', () => {
    const s = Settings.getDefault();
    assert.equal(s.firstDayOfWeek, 1);
    assert.equal(s.timeFormat, '24');
    assert.deepEqual(s.plates, [25, 20, 15, 10, 5, 2.5, 1.25]);
    assert.equal(s.plates.includes(45), false, '45 kg plates are not a thing');
    assert.equal(s.plates.includes(35), false, 'nor 35 kg');
});

// GT-21: the two profiles are independent physical stacks, not one stack with
// a label. Switching the display unit must not reinterpret kg numbers as lb.
test('kg and lb keep separate, independent equipment profiles', () => {
    const s = Settings.getDefault();
    assert.deepEqual(s.plateConfig('kg').plates, [25, 20, 15, 10, 5, 2.5, 1.25]);
    assert.deepEqual(s.plateConfig('lb').plates, [45, 35, 25, 10, 5, 2.5]);
    assert.equal(s.plateConfig('kg').barWeight, 20);
    assert.equal(s.plateConfig('lb').barWeight, 45);
});

test('switching the display unit swaps profiles without touching either', () => {
    const s = Settings.getDefault();
    s.plates = [25, 20, 10];          // customise kg
    s.barWeight = 15;
    s.weightUnit = 'lb';
    assert.deepEqual(s.plates, [45, 35, 25, 10, 5, 2.5], 'lb profile, untouched');
    assert.equal(s.barWeight, 45);
    s.weightUnit = 'kg';
    assert.deepEqual(s.plates, [25, 20, 10], 'the kg customisation survived');
    assert.equal(s.barWeight, 15);
});

test('a legacy flat config seeds the profile for the unit it was written in', () => {
    const s = Settings.fromJSON({ weightUnit: 'lb', barWeight: 45, plates: [45, 25, 10] });
    assert.deepEqual(s.plateConfig('lb').plates, [45, 25, 10]);
    assert.deepEqual(s.plateConfig('kg').plates, [25, 20, 15, 10, 5, 2.5, 1.25],
        'the kg profile is left at its defaults, not fed pound numbers');
});

test('profiles round-trip through toJSON', () => {
    const s = Settings.getDefault();
    s.plates = [25, 20];
    s.setBarWeightForExercise(3, 7.5);
    const back = Settings.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    assert.deepEqual(back.plateConfig('kg').plates, [25, 20]);
    assert.equal(back.barWeightForExercise(3), 7.5);
});

// GT-40: one global bar weight computed an EZ-bar curl against the olympic bar.
test('a per-exercise bar override wins, and clearing it restores the default', () => {
    const s = Settings.getDefault();
    assert.equal(s.barWeightForExercise(42), 20, 'falls back to the profile bar');
    s.setBarWeightForExercise(42, 7);
    assert.equal(s.barWeightForExercise(42), 7);
    s.setBarWeightForExercise(42, '');
    assert.equal(s.barWeightForExercise(42), 20, 'back to the default');
});

test('a bar override is looked up sameId-style, not by strict type', () => {
    const s = Settings.getDefault();
    s.setBarWeightForExercise(42, 7);
    assert.equal(s.barWeightForExercise('42'), 7, 'a DOM-sourced string id resolves');
});

test('bar overrides are per unit, like the plates they sit with', () => {
    const s = Settings.getDefault();
    s.setBarWeightForExercise(42, 7, 'kg');
    s.setBarWeightForExercise(42, 15, 'lb');
    assert.equal(s.barWeightForExercise(42, 'kg'), 7);
    assert.equal(s.barWeightForExercise(42, 'lb'), 15);
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
    assert.deepEqual(s.plates, [25, 20, 15, 10, 5, 2.5, 1.25]);
});

// GT-21: an install that took the v1 stack unchanged is moved off it; one that
// typed its own numbers is not.
test('v2 replaces the superseded 45/35 kg stack it shipped in v1', () => {
    const s = Settings.fromJSON(legacyStored({
        defaultsVersion: 1,
        plates: [45, 35, 25, 20, 15, 10, 5, 2.5, 1.25],
        firstDayOfWeek: 1,
        timeFormat: '24',
    }));
    assert.equal(Settings.applyDefaultUpgrades(s), true);
    assert.deepEqual(s.plates, [25, 20, 15, 10, 5, 2.5, 1.25]);
});

test('v2 leaves a stack the user actually chose alone', () => {
    const s = Settings.fromJSON(legacyStored({
        defaultsVersion: 1,
        plates: [45, 35, 25, 20, 15, 10, 5, 2.5],
    }));
    Settings.applyDefaultUpgrades(s);
    assert.deepEqual(s.plates, [45, 35, 25, 20, 15, 10, 5, 2.5], 'one plate short of the default');
});

test('v2 fixes the kg profile even for an account displaying pounds', () => {
    // The profiles are independent, so a lb user still has a kg stack sitting
    // behind the toggle and it should not be the broken one.
    const s = Settings.fromJSON({
        weightUnit: 'lb',
        defaultsVersion: 1,
        plateProfiles: {
            kg: { barWeight: 20, plates: [45, 35, 25, 20, 15, 10, 5, 2.5, 1.25] },
            lb: { barWeight: 45, plates: [45, 35, 25, 10, 5, 2.5] },
        },
    });
    Settings.applyDefaultUpgrades(s);
    assert.deepEqual(s.plateConfig('kg').plates, [25, 20, 15, 10, 5, 2.5, 1.25]);
    assert.deepEqual(s.plateConfig('lb').plates, [45, 35, 25, 10, 5, 2.5], 'lb untouched');
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

test('the upgrade runs exactly once per generation', () => {
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
