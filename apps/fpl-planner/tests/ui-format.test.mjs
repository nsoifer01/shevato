import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xp, signedXp, points, rank, percent, relativeTime, countdown, dateTime, shortDate,
  chipLabel, plural, formatMoney,
} from '../js/ui/format.js';

// Formatting is where engine numbers become the words a manager reads, so the
// rounding rules are asserted rather than eyeballed.

test('points are shown to one decimal, which is the honest precision', () => {
  assert.equal(xp(5.44), '5.4');
  assert.equal(xp(5.45), '5.5');
  assert.equal(xp(0), '0.0');
  assert.equal(xp(NaN), '-');
  assert.equal(xp(undefined), '-');
});

test('a gain always carries its sign so a loss can never read as a win', () => {
  assert.equal(signedXp(1.24), '+1.2');
  assert.equal(signedXp(-1.26), '-1.3');
  // Anything that rounds to zero prints unsigned. Zero is not a gain, so "+0.0"
  // overstated it, and a small negative like -0.0498 printed "-0.0", which
  // reads as a rendering fault rather than as "no meaningful difference".
  // The safety property still holds: a loss can never acquire a "+".
  assert.equal(signedXp(0), '0.0');
  assert.equal(signedXp(-0.0498), '0.0');
  assert.equal(signedXp(0.0498), '0.0');
  assert.equal(signedXp(-0.06), '-0.1');
});

test('whole points and ranks are formatted for reading', () => {
  assert.equal(points(63.7), '64');
  assert.equal(rank(261544), '261,544');
  assert.equal(rank(0), '-');
  assert.equal(rank(null), '-');
  assert.equal(percent(0.856), '86%');
});

test('money is formatted from integer tenths by the engine formatter', () => {
  assert.equal(formatMoney(155), '£15.5m');
  assert.equal(formatMoney(0), '£0.0m');
});

test('relative time reads in both directions, because a sample snapshot can be dated ahead', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  assert.equal(relativeTime('2026-08-10T11:59:40Z', now), 'just now');
  assert.equal(relativeTime('2026-08-10T11:30:00Z', now), '30 minutes ago');
  assert.equal(relativeTime('2026-08-10T09:00:00Z', now), '3 hours ago');
  assert.equal(relativeTime('2026-08-08T12:00:00Z', now), '2 days ago');
  assert.equal(relativeTime('2026-08-10T12:30:00Z', now), 'in 30 minutes');
  assert.equal(relativeTime('not a date', now), 'unknown');
});

test('the countdown flags the last six hours before a deadline as urgent', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const far = countdown('2026-08-21T17:30:00Z', now);
  assert.equal(far.text, '11d 5h');
  assert.equal(far.urgent, false);
  assert.equal(far.passed, false);

  const soon = countdown('2026-08-10T16:30:00Z', now);
  assert.equal(soon.text, '4h 30m');
  assert.equal(soon.urgent, true);

  const seconds = countdown('2026-08-10T12:02:05Z', now);
  assert.equal(seconds.text, '2m 5s');

  const gone = countdown('2026-08-10T11:00:00Z', now);
  assert.equal(gone.passed, true);
  assert.equal(gone.text, 'Deadline passed');
});

test('date formatters never render "Invalid Date" to a user', () => {
  assert.equal(dateTime('nope'), 'unknown');
  assert.equal(shortDate('nope'), '');
  assert.ok(dateTime('2026-08-21T17:30:00Z').length > 5);
});

test('chip labels are the names FPL uses, and unknown chips pass through', () => {
  assert.equal(chipLabel('3xc'), 'Triple Captain');
  assert.equal(chipLabel('bboost'), 'Bench Boost');
  assert.equal(chipLabel('freehit'), 'Free Hit');
  assert.equal(chipLabel('wildcard'), 'Wildcard');
  assert.equal(chipLabel(null), null);
  assert.equal(chipLabel('mystery'), 'mystery');
});

test('plurals', () => {
  assert.equal(plural(1, 'transfer'), 'transfer');
  assert.equal(plural(2, 'transfer'), 'transfers');
  assert.equal(plural(2, 'change', 'changes'), 'changes');
});
