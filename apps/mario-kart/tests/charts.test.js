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
// A "comeback" is a top-5 finish immediately after a bad one, counted per
// player over that player's own chronological sequence of races.

test('comeback: counts a top-5 finish after a bad one, per bad finish', () => {
  const ctx = loadCharts({ goodFinishThreshold: 12 }); // bad finish = 13th or worse
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
