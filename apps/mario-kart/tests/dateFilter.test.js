'use strict';

// Pin a zone WEST of UTC. Race dates are plain YYYY-MM-DD strings and the
// filters are calendar windows on the local clock; under UTC the old
// `new Date('YYYY-MM-DD')` (UTC midnight) bug could not show, which is how
// this suite used to pin it as intended behaviour.
process.env.TZ = 'America/Chicago';

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
// "Last 7 Days" is seven local calendar days: today and the six before it.
// It is not a calendar week and not a run of seven recorded dates.

test('week filter: keeps today and the six calendar days before it', () => {
  // 2026-03-15 12:00 local (17:00Z). The window is 03-09 .. 03-15 inclusive,
  // so 03-08 (seven days back) is out and 03-09 is in.
  const app = filterWith({ now: '2026-03-15T17:00:00Z', races: LOG });

  assert.equal(app.dates('week'), '2026-03-09,2026-03-15,2026-04-01');
});

test('week filter: the boundary is a calendar day, not an instant', () => {
  // The previous version of this test pinned the opposite ("the boundary
  // moves with the time of day"): the filter parsed race dates as UTC
  // midnight and compared them with now - 7*24h, so in CDT the oldest day
  // dropped out every evening after 19:00 (audit 2026-08-22, D7). Same day at
  // 00:30 local and at 20:30 local must give the same window.
  const early = filterWith({ now: '2026-03-15T05:30:00Z', races: LOG }); // 00:30 CDT
  const late = filterWith({ now: '2026-03-16T01:30:00Z', races: LOG });  // 20:30 CDT

  assert.equal(early.dates('week'), '2026-03-09,2026-03-15,2026-04-01');
  assert.equal(late.dates('week'), early.dates('week'));
});

test('week filter at 20:30 local keeps d-6 and drops d-7', () => {
  // The audit repro: races on d-0, d-1, d-5, d-6, d-7 at 20:30 CDT.
  const races = ['2026-08-22', '2026-08-21', '2026-08-17', '2026-08-16', '2026-08-15'].map((date) => ({ date }));
  const app = filterWith({ now: '2026-08-23T01:30:00Z', races }); // 2026-08-22 20:30 CDT

  assert.equal(app.dates('week'), '2026-08-22,2026-08-21,2026-08-17,2026-08-16');
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
// "Last 30 Days" is the same shape: today plus the 29 local calendar days
// before it. It is not the calendar month: on the 2nd it still reaches back
// into the previous one.

test('month filter: keeps today and the 29 calendar days before it', () => {
  const app = filterWith({ now: '2026-03-15T17:00:00Z', races: LOG });

  // Window is 02-14 .. 03-15, so 02-13 is out and 02-14 is in, at any hour.
  assert.equal(app.dates('month'), '2026-02-14,2026-03-01,2026-03-08,2026-03-09,2026-03-15,2026-04-01');
  const evening = filterWith({ now: '2026-03-16T02:30:00Z', races: LOG }); // 21:30 CDT on 03-15
  assert.equal(evening.dates('month'), app.dates('month'));
});

test('month filter: is a rolling 30-day window, not the current calendar month', () => {
  const app = filterWith({ now: '2026-03-02T17:00:00Z', races: LOG });

  // Two days into March it still shows early February (and, having no upper
  // bound, everything dated later as well).
  assert.equal(
    app.dates('month'),
    '2026-02-05,2026-02-13,2026-02-14,2026-03-01,2026-03-08,2026-03-09,2026-03-15,2026-04-01',
  );
});

test('month filter: labels itself "Last 30 Days"', () => {
  const app = filterWith({ now: '2026-03-15T17:00:00Z', races: LOG });
  app.dates('month');

  assert.equal(app.messages.at(-1), 'Filter set to: Last 30 Days');
});

// --- today / all -----------------------------------------------------------

test('today filter: matches the local calendar date exactly', () => {
  const app = filterWith({
    now: '2026-03-16T03:00:00Z', // 22:00 CDT on 03-15
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
