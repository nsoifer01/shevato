'use strict';

// Pin timezone: weekday bucketing builds Dates from the race date parts.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto } = require('./harness');

// charts.js is mostly view code, but the aggregation helpers below are pure
// functions over raceData. Its only top-level statement is `let trendChart`,
// so the file loads without a DOM; the render functions (createTrendCharts,
// createHeatmapView, createAnalysisView) still need Chart.js and innerHTML and
// are out of reach here.
function loadCharts({ players = ['player1', 'player2'], maxPositions = 12, goodFinishThreshold = null } = {}) {
  const ctx = makeContext({
    players,
    playerCount: players.length,
  });
  ctx.window.MAX_POSITIONS = maxPositions;
  if (goodFinishThreshold !== null) {
    ctx.window.getGoodFinishThreshold = () => goodFinishThreshold;
  }
  loadInto(ctx, 'utils.js');
  loadInto(ctx, 'charts.js');
  return ctx;
}

// --- calculateWeeklyActivityData -------------------------------------------

test('weekly activity: buckets races Monday-first and scales bars to the busiest day', () => {
  const ctx = loadCharts();
  // 2026-03-02 is a Monday, 03-06 a Friday, 03-08 a Sunday.
  const rows = ctx.calculateWeeklyActivityData([
    { date: '2026-03-02' },
    { date: '2026-03-02' },
    { date: '2026-03-06' },
    { date: '2026-03-08' },
  ]);

  assert.equal(rows.map((r) => r.name).join(','), 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday');
  assert.equal(rows.map((r) => r.races).join(','), '2,0,0,0,1,0,1');
  // Sunday must land at index 6, not index 0 as getDay() would have it.
  assert.equal(rows[6].races, 1);
  assert.equal(rows[0].percentage, '50');
  assert.equal(rows[4].percentage, '25');
  assert.equal(rows[0].barHeight, 100, 'the busiest day fills the bar');
  assert.equal(rows[4].barHeight, 50);
});

test('weekly activity: an empty log is seven zero rows, not a divide-by-zero', () => {
  const ctx = loadCharts();
  const rows = ctx.calculateWeeklyActivityData([]);

  assert.equal(rows.length, 7);
  assert.equal(rows.map((r) => r.races).join(','), '0,0,0,0,0,0,0');
  assert.equal(rows[0].percentage, '0');
  assert.equal(rows[0].barHeight, 0);
});

test('weekly activity: dates are read as local calendar days, so no UTC off-by-one', () => {
  const ctx = loadCharts();
  const rows = ctx.calculateWeeklyActivityData([{ date: '2026-03-08' }]);

  assert.equal(rows[6].races, 1, 'Sunday 2026-03-08 stays on Sunday');
  assert.equal(rows[5].races, 0);
});

// --- calculateComebackAnalysis ---------------------------------------------
// A "comeback" is a recovery to one better than getGoodFinishThreshold() (the
// top-half line) immediately after a bad one, counted per player over that
// player's own chronological sequence of races. In MK8D (max 12, threshold 6)
// that line is 5, same as the app's original hardcoded constant; it scales
// for other game sizes (see the dedicated scaling test below).

test('comeback: counts a top-5 finish after a bad one, per bad finish', () => {
  const ctx = loadCharts({ goodFinishThreshold: 6 }); // MK8D: bad finish = 7th or worse
  const analysis = ctx.calculateComebackAnalysis([
    { date: '2026-03-01', player1: 13, player2: 1 },
    { date: '2026-03-02', player1: 3, player2: 2 },
    { date: '2026-03-03', player1: 14, player2: 3 },
    { date: '2026-03-04', player1: 9, player2: 4 },
  ]);

  assert.equal(analysis.player1.comebacks, 1);
  assert.equal(analysis.player1.recoveryRate, 50, 'one recovery out of two bad finishes');
  assert.equal(analysis.player2.comebacks, 0);
  assert.equal(analysis.player2.recoveryRate, 0, 'no bad finishes means a 0 rate, not a divide-by-zero');
});

test('comeback: the bad-finish threshold follows the game size', () => {
  const races = [
    { date: '2026-03-01', player1: 7, player2: 1 },
    { date: '2026-03-02', player1: 2, player2: 2 },
  ];
  // MK8D: 12 positions, good finish = top 6, so 7th counts as bad.
  const mk8d = loadCharts({ maxPositions: 12, goodFinishThreshold: 6 });
  assert.equal(mk8d.calculateComebackAnalysis(races).player1.comebacks, 1);

  // MK World: 24 positions, good finish = top 12, so 7th is not bad at all.
  const world = loadCharts({ maxPositions: 24, goodFinishThreshold: 12 });
  const worldAnalysis = world.calculateComebackAnalysis(races);
  assert.equal(worldAnalysis.player1.comebacks, 0);
  assert.equal(worldAnalysis.player1.recoveryRate, 0);
});

test('comeback: how good the recovery must be also follows the game size, not just how bad the prior finish was', () => {
  // MK8D: max 12, good-finish threshold 6, so the comeback line is 5th.
  const mk8d = loadCharts({ maxPositions: 12, goodFinishThreshold: 6 });
  assert.equal(
    mk8d.calculateComebackAnalysis([
      { date: '2026-03-01', player1: 9 }, // bad (>= 7)
      { date: '2026-03-02', player1: 5 }, // recovers to the MK8D line
    ]).player1.comebacks,
    1,
    '5th counts as a comeback in a 12-position game'
  );
  assert.equal(
    mk8d.calculateComebackAnalysis([
      { date: '2026-03-01', player1: 9 },
      { date: '2026-03-02', player1: 6 }, // one worse than the line
    ]).player1.comebacks,
    0,
    '6th misses the MK8D comeback line by one'
  );

  // MK World: max 24, good-finish threshold 12, so the comeback line scales
  // to 11th. Under the old bare "<= 5" constant, an 11th-place recovery in a
  // 24-position race (a real comeback, proportionally) would never have
  // counted.
  const world = loadCharts({ maxPositions: 24, goodFinishThreshold: 12 });
  assert.equal(
    world.calculateComebackAnalysis([
      { date: '2026-03-01', player1: 20 }, // bad (>= 13)
      { date: '2026-03-02', player1: 11 }, // recovers to the MK World-scaled line
    ]).player1.comebacks,
    1,
    '11th counts as a comeback in a 24-position game'
  );
  assert.equal(
    world.calculateComebackAnalysis([
      { date: '2026-03-01', player1: 20 },
      { date: '2026-03-02', player1: 12 }, // merely "good" (the threshold itself), not a comeback
    ]).player1.comebacks,
    0,
    '12th misses the MK World-scaled comeback line by one'
  );
});

test('comeback: races the player sat out do not break the sequence', () => {
  const ctx = loadCharts({ goodFinishThreshold: 12 });
  const analysis = ctx.calculateComebackAnalysis([
    { date: '2026-03-01', player1: 13, player2: 1 },
    { date: '2026-03-02', player1: null, player2: 2 },
    { date: '2026-03-03', player1: 2, player2: 3 },
  ]);

  // player1's own sequence is 13 then 2: still a comeback.
  assert.equal(analysis.player1.comebacks, 1);
  assert.equal(analysis.player1.recoveryRate, 100);
});

test('comeback: the log is sorted chronologically before the sequence is read', () => {
  const ctx = loadCharts({ goodFinishThreshold: 12 });
  const analysis = ctx.calculateComebackAnalysis([
    { date: '2026-03-03', timestamp: '10:00:00 EDT', player1: 2, player2: 3 },
    { date: '2026-03-01', timestamp: '10:00:00 EDT', player1: 13, player2: 1 },
  ]);

  assert.equal(analysis.player1.comebacks, 1, 'insertion order says recovery-then-crash, dates say otherwise');
});

// --- calculateBestRacingDay / calculateWorstRacingDay ------------------------

const DAY_LOG = [
  { date: '2026-03-01', player1: 1, player2: 8 },
  { date: '2026-03-01', player1: 3, player2: 10 },
  { date: '2026-03-02', player1: 5, player2: 2 },
  { date: '2026-03-02', player1: 7, player2: 4 },
  { date: '2026-03-03', player1: 1, player2: 12 },
];

test('best racing day: the lowest average across a day with at least two races', () => {
  const ctx = loadCharts();
  const best = ctx.calculateBestRacingDay(DAY_LOG);

  assert.equal(best.player1.date, '2026-03-01');
  assert.equal(best.player1.averagePosition, 2);
  assert.equal(best.player1.raceCount, 2);
  // 2026-03-03 is player1's only 1st place, but a single race never qualifies.
  assert.equal(best.player2.date, '2026-03-02');
  assert.equal(best.player2.averagePosition, 3);
});

test('worst racing day: the highest average across a day with at least two races', () => {
  const ctx = loadCharts();
  const worst = ctx.calculateWorstRacingDay(DAY_LOG);

  assert.equal(worst.player1.date, '2026-03-02');
  assert.equal(worst.player1.averagePosition, 6);
  assert.equal(worst.player2.date, '2026-03-01');
  assert.equal(worst.player2.averagePosition, 9);
});

test('best/worst racing day: no qualifying day reports null, not a placeholder score', () => {
  const ctx = loadCharts();
  const oneRacePerDay = [
    { date: '2026-03-01', player1: 1, player2: 2 },
    { date: '2026-03-02', player1: 2, player2: 1 },
  ];

  const best = ctx.calculateBestRacingDay(oneRacePerDay);
  assert.equal(best.player1.date, null);
  assert.equal(best.player1.averagePosition, null);
  assert.equal(best.player1.raceCount, 0);

  const worst = ctx.calculateWorstRacingDay(oneRacePerDay);
  assert.equal(worst.player1.date, null);
  assert.equal(worst.player1.averagePosition, null);
});

test('best/worst racing day: ties keep the earlier day', () => {
  const ctx = loadCharts();
  const tied = [
    { date: '2026-03-01', player1: 2, player2: 1 },
    { date: '2026-03-01', player1: 4, player2: 2 },
    { date: '2026-03-02', player1: 2, player2: 1 },
    { date: '2026-03-02', player1: 4, player2: 2 },
  ];

  assert.equal(ctx.calculateBestRacingDay(tied).player1.date, '2026-03-01');
  assert.equal(ctx.calculateWorstRacingDay(tied).player1.date, '2026-03-01');
});

test('best/worst racing day: races the player sat out do not count towards the day', () => {
  const ctx = loadCharts();
  const log = [
    { date: '2026-03-01', player1: 1, player2: null },
    { date: '2026-03-01', player1: 3, player2: null },
    { date: '2026-03-02', player1: 5, player2: 1 },
    { date: '2026-03-02', player1: 7, player2: 3 },
  ];

  // player2 only has one qualifying day.
  assert.equal(ctx.calculateBestRacingDay(log).player2.date, '2026-03-02');
  assert.equal(ctx.calculateBestRacingDay(log).player2.raceCount, 2);
});

// --- generatePatternAnalysis ------------------------------------------------
// Returns an HTML fragment, so the assertions target the rendered numbers.

test('patterns: reports best day, worst day, spread, close races and sweet spot', () => {
  const ctx = loadCharts();
  const html = ctx.generatePatternAnalysis([
    { date: '2026-03-01', player1: 1, player2: 2 },
    { date: '2026-03-02', player1: 8, player2: 10 },
  ]);

  assert.ok(html.startsWith('<ul>') && html.endsWith('</ul>'));
  assert.ok(html.includes('Best racing day: <strong>2026-03-01</strong> (avg position 1.5)'), html);
  assert.ok(html.includes('Worst racing day: <strong>2026-03-02</strong> (avg position 9)'), html);
  assert.ok(html.includes('Average finish spread: <strong>1.5 positions</strong>'), html);
  assert.ok(html.includes('Close races: <strong>100%</strong>'), html);
  // Positions 1, 2, 8, 10 bucketed in fours: 1-4 holds half of them.
  assert.ok(html.includes('Sweet spot frequency: <strong>50%</strong> of finishes in positions 1-4'), html);
});

test('patterns: the close-races line is dropped in single-player mode', () => {
  const ctx = loadCharts({ players: ['player1'] });
  const html = ctx.generatePatternAnalysis([
    { date: '2026-03-01', player1: 1 },
    { date: '2026-03-02', player1: 8 },
  ]);

  assert.ok(!html.includes('Close races'), html);
  // A one-player race has no spread to report either.
  assert.ok(!html.includes('Average finish spread'), html);
  assert.ok(html.includes('Best racing day: <strong>2026-03-01</strong>'), html);
});

test('patterns: a race a player sat out never enters the day average', () => {
  const ctx = loadCharts();
  const html = ctx.generatePatternAnalysis([
    { date: '2026-03-01', player1: 4, player2: null },
    { date: '2026-03-02', player1: 2, player2: 4 },
  ]);

  // 03-01 averages 4 (player1 alone), 03-02 averages 3.
  assert.ok(html.includes('Best racing day: <strong>2026-03-02</strong> (avg position 3)'), html);
  assert.ok(html.includes('Worst racing day: <strong>2026-03-01</strong> (avg position 4)'), html);
});

test('patterns: the sweet-spot buckets follow the game size', () => {
  const ctx = loadCharts({ maxPositions: 24 });
  const html = ctx.generatePatternAnalysis([
    { date: '2026-03-01', player1: 21, player2: 22 },
    { date: '2026-03-02', player1: 23, player2: 24 },
  ]);

  // Buckets run 1-4, 5-8, ... 21-24; only the last one has finishes in it.
  assert.ok(html.includes('Sweet spot frequency: <strong>100%</strong> of finishes in positions 21-24'), html);
});

test('patterns: the close-race threshold follows the game size', () => {
  // MK8D: max 12, good-finish threshold 6, close-race line at 5.
  const mk8d = loadCharts({ maxPositions: 12, goodFinishThreshold: 6 });
  const closeMk8d = mk8d.generatePatternAnalysis([
    { date: '2026-03-01', player1: 1, player2: 6 }, // spread 5: close
    { date: '2026-03-02', player1: 1, player2: 7 }, // spread 6: not close
  ]);
  assert.ok(closeMk8d.includes('Close races: <strong>50%</strong>'), closeMk8d);
  assert.ok(closeMk8d.includes('spread ≤ 5 places'), closeMk8d);

  // MK World: max 24, good-finish threshold 12, close-race line scales to 11.
  // Under the old bare "<= 5" constant, an 11-place spread in a 24-position
  // field (proportionally as tight as a 5-place spread in a 12-position one)
  // would have been misjudged "not close".
  const world = loadCharts({ maxPositions: 24, goodFinishThreshold: 12 });
  const closeWorld = world.generatePatternAnalysis([
    { date: '2026-03-01', player1: 1, player2: 12 }, // spread 11: close in MK World
    { date: '2026-03-02', player1: 1, player2: 13 }, // spread 12: not close
  ]);
  assert.ok(closeWorld.includes('Close races: <strong>50%</strong>'), closeWorld);
  assert.ok(closeWorld.includes('spread ≤ 11 places'), closeWorld);
});

// --- createHeatmapView: Chart.js CDN guard -----------------------------------
// Chart.js loads from a CDN (index.html); if cdnjs is blocked, neither
// `window.Chart` nor the bare `Chart` global (classic scripts share one
// global scope with `window`) ever exists. createTrendCharts already guards
// its `new Chart(...)` (~172); createHeatmapView's doughnut chart did not, so
// a blocked CDN threw a ReferenceError here on every render while the
// Activity tab was open - and since createHeatmapView runs unconditionally
// from updateDisplay() on every data mutation, that could abort the rest of
// updateDisplay() (including the success toast).
//
// This needs a working `document` (the pure-function tests above load
// charts.js with no DOM at all), so it gets its own small harness: element
// stubs good enough for getElementById/querySelector, a synchronous
// setTimeout (createHeatmapView defers its chart-building work), and a
// stand-in `Chart` constructor to simulate the CDN script having loaded.
function loadChartsWithDom({ players = ['player1', 'player2'], maxPositions = 12, chartAvailable = true } = {}) {
  const elements = {};
  const makeEl = () => ({
    innerHTML: '',
    style: {},
    getContext: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const el = (id) => {
    if (!elements[id]) elements[id] = makeEl();
    return elements[id];
  };
  const ctx = makeContext({
    players,
    playerCount: players.length,
    escapeHtml: (v) => String(v == null ? '' : v),
    getPlayerName: (p) => p,
    setTimeout: (fn) => { fn(); return 0; }, // run the deferred chart-building work inline
    document: {
      getElementById: el,
      querySelector: (sel) => (sel === '.activity-chart-wrapper' ? el('activity-chart-wrapper') : null),
      querySelectorAll: () => [],
      createElement: makeEl,
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  ctx.window.MAX_POSITIONS = maxPositions;
  if (chartAvailable) {
    // A classic <script> global is the same binding as window.<name>; both
    // must be set to faithfully simulate "Chart.js loaded" in the sandbox.
    const ChartStub = function ChartStub() { /* records nothing; just must not throw */ };
    ctx.Chart = ChartStub;
    ctx.window.Chart = ChartStub;
  }
  loadInto(ctx, 'utils.js');
  loadInto(ctx, 'charts.js');
  return { ctx, elements, el };
}

const ONE_RACE = [{ date: '2026-03-02', player1: 1, player2: 2 }]; // a Monday

test('activity chart: falls back to a visible message instead of throwing when Chart.js never loaded', () => {
  const { ctx, elements, el } = loadChartsWithDom({ chartAvailable: false });
  el('activity-chart-wrapper'); // pre-create so it exists even though nothing else touches it yet

  assert.doesNotThrow(() => ctx.createHeatmapView(ONE_RACE));
  assert.match(elements['activity-chart-wrapper'].innerHTML, /chart unavailable/i);
});

test('activity chart: leaves the canvas alone and builds the real chart when Chart.js is available', () => {
  const { ctx, elements, el } = loadChartsWithDom({ chartAvailable: true });
  el('activity-chart-wrapper');

  assert.doesNotThrow(() => ctx.createHeatmapView(ONE_RACE));
  assert.equal(elements['activity-chart-wrapper'].innerHTML, '', 'the guard only replaces content when Chart.js is missing');
});
