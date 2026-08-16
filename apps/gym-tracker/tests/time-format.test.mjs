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

test('getTimeFormat: defaults to 24 when no setting present', () => {
    // Regression for TESTING-AUDIT.md defect 21 (resolved 2026-08-15): the
    // pre-boot fallback used to be '12' while Settings shipped '24', so early
    // boot flashed 12-hour then flipped. Both sides now agree on 24.
    delete globalThis.window.gymApp;
    assert.equal(getTimeFormat(), '24');
});

test('getTimeFormat: returns 24 when setting is 24', () => {
    setSetting('24');
    assert.equal(getTimeFormat(), '24');
});

test('getTimeFormat: an explicit 12 setting is respected', () => {
    setSetting('12');
    assert.equal(getTimeFormat(), '12');
});

test('getTimeFormat: any non-12 value coerces to 24', () => {
    setSetting('garbage');
    assert.equal(getTimeFormat(), '24');
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
// Default-agreement regression (was the documented DIVERGENCE, TESTING-AUDIT
// defect 21, resolved 2026-08-15): the helper's pre-boot fallback and the
// Settings model default must agree so early boot never flashes one clock
// and settles on another. Both sides are 24-hour; an explicit stored '12'
// remains a respected user choice after the one-time v1 upgrade.
// ---------------------------------------------------------------------------

test('pre-boot helper default and Settings default agree on 24-hour', async () => {
    const { Settings } = await import('../js/models/Settings.js');

    delete globalThis.window.gymApp; // the early-boot window: no app singleton yet
    assert.equal(getTimeFormat(), '24', 'helpers side: pre-boot fallback is 24-hour');

    assert.equal(Settings.getDefault().timeFormat, '24', 'model side: shipped default is 24-hour');

    const upgraded = new Settings({ timeFormat: '12', defaultsVersion: 0 });
    Settings.applyDefaultUpgrades(upgraded);
    assert.equal(upgraded.timeFormat, '24', 'model side: the one-time v1 upgrade moves a stored 12 to 24');

    // A user who re-picks 12 AFTER the upgrade keeps it (defaultsVersion is
    // already current, so the upgrade never runs again).
    const chosen = new Settings({ timeFormat: '12', defaultsVersion: Settings.DEFAULTS_VERSION });
    Settings.applyDefaultUpgrades(chosen);
    assert.equal(chosen.timeFormat, '12', 'an explicit post-upgrade 12 is preserved');
});
