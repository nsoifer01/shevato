'use strict';

// Pin timezone: the filters mix a local "now" with UTC-parsed race dates.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, freezeDate } = require('./harness');

// getFilteredRaces reads the global `races` and a module-local
// `currentDateFilter`, so the log goes in through the sandbox and the filter
// through the public setter. `now` is frozen because week/month are windows
// measured from the current instant.
function filterWith({ now, races }) {
  const messages = [];
  const ctx = makeContext({
    Date: freezeDate(now),
    races,
    currentView: 'stats',
    showMessage: (msg) => messages.push(msg),
  });
  loadInto(ctx, 'dateFilter.js');
  return {
    messages,
    dates: (filter) => {
      ctx.setDateFilter(filter);
      return ctx.getFilteredRaces().map((r) => r.date).join(',');
    },
  };
}

const LOG = [
  { date: '2026-02-05' },
  { date: '2026-02-13' },
  { date: '2026-02-14' },
  { date: '2026-03-01' },
  { date: '2026-03-08' },
  { date: '2026-03-09' },
  { date: '2026-03-15' },
  { date: '2026-04-01' },
];

// --- week ------------------------------------------------------------------
// "Last 7 Days" is a rolling window, not a calendar week and not a run of
// seven dates: the cutoff is the instant exactly 7 * 24h before now, compared
// against each race date parsed as UTC midnight.

test('week filter: keeps races newer than the instant 7 * 24h ago', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: LOG });

  // Cutoff is 2026-03-08T12:00Z. 03-08 midnight falls before it, so a race
  // dated exactly seven days ago is already out of the window.
  assert.equal(app.dates('week'), '2026-03-09,2026-03-15,2026-04-01');
});

test('week filter: the boundary date moves with the time of day', () => {
  // Same log, same calendar day, midnight instead of midday: the cutoff is now
  // 2026-03-08T00:00Z, so the race dated exactly seven days back is back in.
  const app = filterWith({ now: '2026-03-15T00:00:00Z', races: LOG });

  assert.equal(app.dates('week'), '2026-03-08,2026-03-09,2026-03-15,2026-04-01');
});

test('week filter: has no upper bound, so future-dated races are always included', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: [{ date: '2030-01-01' }] });

  assert.equal(app.dates('week'), '2030-01-01');
});

test('week filter: labels itself "Last 7 Days"', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: LOG });
  app.dates('week');

  assert.equal(app.messages.at(-1), 'Filter set to: Last 7 Days');
});

// --- month -----------------------------------------------------------------
// "Last 30 Days" is the same rolling shape with a 30 * 24h cutoff. It is not
// the calendar month: on the 2nd it still reaches back into the previous one.

test('month filter: keeps races newer than the instant 30 * 24h ago', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: LOG });

  // Cutoff is 2026-02-13T12:00Z, so 02-13 is out and 02-14 is in.
  assert.equal(app.dates('month'), '2026-02-14,2026-03-01,2026-03-08,2026-03-09,2026-03-15,2026-04-01');
});

test('month filter: is a rolling 30-day window, not the current calendar month', () => {
  const app = filterWith({ now: '2026-03-02T12:00:00Z', races: LOG });

  // Two days into March it still shows early February (and, having no upper
  // bound, everything dated later as well).
  assert.equal(
    app.dates('month'),
    '2026-02-05,2026-02-13,2026-02-14,2026-03-01,2026-03-08,2026-03-09,2026-03-15,2026-04-01',
  );
});

test('month filter: labels itself "Last 30 Days"', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: LOG });
  app.dates('month');

  assert.equal(app.messages.at(-1), 'Filter set to: Last 30 Days');
});

// --- today / all -----------------------------------------------------------

test('today filter: matches the local calendar date exactly', () => {
  const app = filterWith({
    now: '2026-03-15T12:00:00Z',
    races: [{ date: '2026-03-14' }, { date: '2026-03-15' }, { date: '2026-03-16' }],
  });

  assert.equal(app.dates('today'), '2026-03-15');
});

test('all filter: returns the whole log, future dates included', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: LOG });

  assert.equal(app.dates('all'), LOG.map((r) => r.date).join(','));
});

test('switching back to all after a window filter restores the full log', () => {
  const app = filterWith({ now: '2026-03-15T12:00:00Z', races: LOG });

  app.dates('week');
  assert.equal(app.dates('all'), LOG.map((r) => r.date).join(','));
});
