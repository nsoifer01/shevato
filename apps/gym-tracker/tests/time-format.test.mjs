// Pin TZ so date arithmetic is deterministic; also pin LANG so Intl
// number/time output is consistent across CI hosts.
process.env.TZ = 'UTC';
process.env.LANG = 'en_US.UTF-8';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub the global window/localStorage shape that helpers.getTimeFormat
// reads from. Each test sets timeFormat on the mock app and verifies
// formatTimeOfDay picks the right toLocaleTimeString options.
globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
    _s: new Map(),
    getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
    setItem(k, v) { this._s.set(k, String(v)); },
    removeItem(k) { this._s.delete(k); },
};

const { getTimeFormat, timeFormatOptions, formatTimeOfDay } = await import('../js/utils/helpers.js');

function setSetting(value) {
    globalThis.window.gymApp = { settings: { timeFormat: value } };
}

test('getTimeFormat: defaults to 12 when no setting present', () => {
    delete globalThis.window.gymApp;
    assert.equal(getTimeFormat(), '12');
});

test('getTimeFormat: returns 24 when setting is 24', () => {
    setSetting('24');
    assert.equal(getTimeFormat(), '24');
});

test('getTimeFormat: any non-24 value coerces to 12', () => {
    setSetting('garbage');
    assert.equal(getTimeFormat(), '12');
});

test('timeFormatOptions: 12-hour returns hour12 true', () => {
    setSetting('12');
    const o = timeFormatOptions();
    assert.equal(o.hour12, true);
    assert.equal(o.hour, 'numeric');
});

test('timeFormatOptions: 24-hour returns hour12 false', () => {
    setSetting('24');
    const o = timeFormatOptions();
    assert.equal(o.hour12, false);
    assert.equal(o.hour, '2-digit');
});

test('formatTimeOfDay: 12-hour formatting includes AM/PM marker', () => {
    setSetting('12');
    const out = formatTimeOfDay(new Date('2026-04-24T18:42:00Z'));
    assert.ok(/(?:PM|pm)/i.test(out), `expected PM in "${out}"`);
});

test('formatTimeOfDay: 24-hour formatting omits AM/PM marker', () => {
    setSetting('24');
    const out = formatTimeOfDay(new Date('2026-04-24T18:42:00Z'));
    assert.ok(!/(?:AM|PM)/i.test(out), `expected no AM/PM in "${out}"`);
    assert.ok(out.startsWith('18'), `expected 24h hour prefix in "${out}"`);
});

test('formatTimeOfDay: empty / invalid input returns empty string', () => {
    setSetting('12');
    assert.equal(formatTimeOfDay(''), '');
    assert.equal(formatTimeOfDay('not a date'), '');
});

// ---------------------------------------------------------------------------
// PRODUCT INCONSISTENCY, documented deliberately - do NOT "fix" either
// assertion to hide it:
//
//   - helpers.getTimeFormat (js/utils/helpers.js ~133) falls back to '12'
//     whenever window.gymApp.settings is not readable ("Defaults to 12-hour
//     for the very early boot window"), so anything rendered before settings
//     load uses the 12-hour clock.
//   - models/Settings.js (~72) defaults timeFormat to '24' (owner call,
//     2026-08-10), and applyDefaultUpgrades (~136) even upgrades a stored
//     '12' to '24' once.
//
// Net effect: during early boot (or any non-app caller) times render 12-hour,
// then flip to 24-hour once settings arrive. The two defaults should agree
// (presumably both '24'); until the owner picks a side, this test states both
// current behaviors side by side so the divergence cannot deepen silently.
// ---------------------------------------------------------------------------

test('DIVERGENCE: pre-boot helper default is 12-hour while Settings default is 24-hour', async () => {
    const { Settings } = await import('../js/models/Settings.js');

    delete globalThis.window.gymApp; // the early-boot window: no app singleton yet
    assert.equal(getTimeFormat(), '12', 'helpers side: pre-boot fallback is 12-hour');

    assert.equal(Settings.getDefault().timeFormat, '24', 'model side: shipped default is 24-hour');

    const upgraded = new Settings({ timeFormat: '12', defaultsVersion: 0 });
    Settings.applyDefaultUpgrades(upgraded);
    assert.equal(upgraded.timeFormat, '24', 'model side: v1 upgrade even moves stored 12 to 24');
});
