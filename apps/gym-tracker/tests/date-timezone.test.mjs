// Date/timezone behavior of the helpers every date surface leans on.
//
// The app stores workout dates as LOCAL YYYY-MM-DD keys (getTodayDateString),
// parses them back at local midnight (parseLocalDate), and filters history by
// plain string comparison on those keys. A late-evening workout in New York
// must land on the local date, not the UTC one - the classic failure is a
// 23:30 EST session recorded under "tomorrow".
//
// TZ is a process-wide, startup-time setting in node, so the non-UTC cases
// run helpers.js in a child process with TZ=America/New_York and a frozen
// clock. The DST-crossing date (US spring-forward, 2026-03-08) is used
// throughout so an implementation that does naive 86400000-ms day arithmetic
// or UTC conversion fails loudly.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPERS_URL = new URL('../js/utils/helpers.js', import.meta.url).href;
const HISTORY_VIEW = fileURLToPath(new URL('../js/views/history-view.js', import.meta.url));

/**
 * Run a snippet in a child node with the given TZ and the clock frozen at
 * `nowIso`. The snippet sees `h` (the helpers module) and returns via
 * `print(value)` (JSON on stdout).
 */
function inZone(tz, nowIso, snippet) {
    const script = `
        const RealDate = Date;
        const FIXED = new RealDate('${nowIso}').getTime();
        class FakeDate extends RealDate {
            constructor(...args) { args.length === 0 ? super(FIXED) : super(...args); }
            static now() { return FIXED; }
        }
        globalThis.Date = FakeDate;
        const h = await import('${HELPERS_URL}');
        const print = (v) => process.stdout.write(JSON.stringify(v));
        ${snippet}
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: tz, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        encoding: 'utf8',
    });
    return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// getTodayDateString: local date, not UTC date
// ---------------------------------------------------------------------------

// 2026-03-08T04:30Z is 23:30 on March 7 in New York (EST, UTC-5).
const LATE_EVENING = '2026-03-08T04:30:00Z';

test('getTodayDateString: 23:30 EST is still the local date, not tomorrow-in-UTC', () => {
    assert.equal(inZone('America/New_York', LATE_EVENING, 'print(h.getTodayDateString());'),
        '2026-03-07');
});

test('getTodayDateString: the same instant in UTC is the next day (the keys are local on purpose)', () => {
    assert.equal(inZone('UTC', LATE_EVENING, 'print(h.getTodayDateString());'),
        '2026-03-08');
});

test('getTodayDateString: always zero-padded YYYY-MM-DD', () => {
    assert.equal(inZone('America/New_York', '2026-04-05T12:00:00Z', 'print(h.getTodayDateString());'),
        '2026-04-05');
});

// ---------------------------------------------------------------------------
// formatDate / parseLocalDate: a YYYY-MM-DD key renders as ITS OWN day
// ---------------------------------------------------------------------------

test('formatDate: a stored date key renders as the same calendar day in New York', () => {
    // new Date('2026-03-08') would be UTC midnight = Mar 7, 19:00 EST, and a
    // naive implementation would render "Mar 7". parseLocalDate prevents that.
    assert.equal(
        inZone('America/New_York', LATE_EVENING, `print(h.formatDate('2026-03-08', 'short'));`),
        'Mar 8, 2026');
});

test('formatDate: long format carries the correct local weekday across DST', () => {
    // 2026-03-08 is the US spring-forward Sunday.
    assert.equal(
        inZone('America/New_York', LATE_EVENING, `print(h.formatDate('2026-03-08', 'long'));`),
        'Sunday, Mar 8, 2026');
});

// ---------------------------------------------------------------------------
// formatSessionDateTime: date key + local time-of-day
// ---------------------------------------------------------------------------

test('formatSessionDateTime: a 23:30 EST session shows its local evening time', () => {
    const out = inZone('America/New_York', LATE_EVENING, `
        print(h.formatSessionDateTime({ date: '2026-03-07', endTime: '2026-03-08T04:30:00.000Z' }));
    `);
    assert.equal(out, 'Mar 7, 2026, 11:30 PM');
});

test('formatSessionDateTime: an instant inside the DST gap renders as the post-jump time', () => {
    // 07:01Z on 2026-03-08 is 03:01 EDT; 02:xx never exists that night.
    const out = inZone('America/New_York', LATE_EVENING, `
        print(h.formatSessionDateTime({ date: '2026-03-08', endTime: '2026-03-08T07:01:00.000Z' }));
    `);
    assert.equal(out, 'Mar 8, 2026, 3:01 AM');
});

test('formatSessionDateTime: falls back to the date alone for very old sessions', () => {
    const out = inZone('America/New_York', LATE_EVENING, `
        print(h.formatSessionDateTime({ date: '2026-03-07' }));
    `);
    assert.equal(out, 'Mar 7, 2026');
});

// ---------------------------------------------------------------------------
// The history date-range filter mechanism.
//
// history-view.js (~233-238) filters with plain string comparison:
//     session.date >= this.dateFrom / session.date <= this.dateTo
// That is only correct BECAUSE both sides are local YYYY-MM-DD keys, where
// lexicographic order equals chronological order. What cannot be tested here
// without a DOM: the filter inputs themselves (browser <input type="date">
// wiring) - that lives in the app's .features/ human plan. What CAN be pinned:
// the comparison style in the source, and the key property it relies on.
// ---------------------------------------------------------------------------

test('history-view filters by lexicographic comparison on date keys (pinned mechanism)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(HISTORY_VIEW, 'utf8');
    assert.match(src, /session\.date >= this\.dateFrom/, 'from-filter is a string compare');
    assert.match(src, /session\.date <= this\.dateTo/, 'to-filter is a string compare');
});

test('lexicographic order on zero-padded YYYY-MM-DD keys equals chronological order', () => {
    // The property the string compare depends on, exercised across the
    // boundaries where naive formats break (month/year rollover, padding).
    const ordered = ['2025-09-30', '2025-10-01', '2025-12-31', '2026-01-01', '2026-01-09', '2026-01-10'];
    const shuffled = [...ordered].reverse();
    assert.deepEqual([...shuffled].sort(), ordered, 'string sort = date sort for these keys');
    // And the format getTodayDateString emits is exactly that shape.
    assert.match(inZone('America/New_York', LATE_EVENING, 'print(h.getTodayDateString());'),
        /^\d{4}-\d{2}-\d{2}$/);
});
