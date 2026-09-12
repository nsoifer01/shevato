'use strict';

// Pin timezone so the timestamp-ordering assertions stay deterministic.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, evalIn } = require('./harness');

function loadStats(players, races) {
  const ctx = makeContext({
    players,
    races,
    getFilteredRaces: () => races,
  });
  // statistics.js calls formatDecimal from utils.js, so load that first.
  loadInto(ctx, 'utils.js');
  loadInto(ctx, 'statistics.js');
  return ctx;
}

// --- roster widening: a race that predates a player --------------------------
// The roster unions the entry-form width with the race log, so `players` can
// grow to include a slot that older races never carried. Those races have the
// key ABSENT (undefined), not null, which is a different shape from the
// "sat this one out" case (explicit null) the guards were written for.

test('calculateStats: an explicit null is skipped for that player', () => {
  const races = [
    { date: '2026-03-01', player1: 1, player2: 2, player3: null },
    { date: '2026-03-02', player1: 2, player2: 1, player3: 3 },
  ];
  const stats = loadStats(['player1', 'player2', 'player3'], races).calculateStats(races);

  assert.equal(stats.racesPlayed.player3, 1);
  assert.equal(stats.averageFinish.player3, '3');
});

test('calculateStats: a race missing a player key entirely is skipped for that player', () => {
  const races = [
    // Recorded before player3 existed: the key is absent, not null.
    { date: '2026-03-01', player1: 1, player2: 2 },
    { date: '2026-03-02', player1: 2, player2: 1, player3: 3 },
  ];
  const stats = loadStats(['player1', 'player2', 'player3'], races).calculateStats(races);

  assert.equal(stats.racesPlayed.player3, 1, 'only the race player3 actually raced counts');
  assert.equal(stats.averageFinish.player3, '3');
});

test('calculateStats: totals for the players who were present stay correct either way', () => {
  const races = [
    { date: '2026-03-01', player1: 1, player2: 2 },
    { date: '2026-03-02', player1: 2, player2: 1, player3: 3 },
  ];
  const stats = loadStats(['player1', 'player2', 'player3'], races).calculateStats(races);

  assert.equal(stats.racesPlayed.player1, 2);
  assert.equal(stats.averageFinish.player1, '1.5');
  // Comparisons against undefined are false, so H2H is unaffected by the
  // missing key: player3 only has a head-to-head from the race it was in.
  assert.equal(stats.h2h.player1.player3, 1);
  assert.equal(stats.h2h.player3.player1, 0);
});

// --- chronological ordering -------------------------------------------------
// Streaks are computed after sorting by `new Date(date + ' ' + timestamp)`.
// Insertion order and chronological order diverge whenever a race is entered
// for an earlier date, or an existing race's date is edited.

// The last race chronologically owns the active streak, so h2hCurrentStreaks
// is the cheapest observable for "did the sort actually happen".
const OUT_OF_ORDER = (timeA, timeB) => ([
  { date: '2026-03-02', timestamp: timeA, player1: 1, player2: 2 },
  { date: '2026-03-01', timestamp: timeB, player1: 3, player2: 1 },
]);

test('calculateStats: legacy "HH:MM:SS EDT" timestamps sort chronologically', () => {
  // The shared parser reads the wall-clock part and ignores the timezone
  // abbreviation, so an out-of-order log is reordered: 03-01 (player2 wins)
  // then 03-02 (player1 wins).
  const races = OUT_OF_ORDER('10:30:00 EDT', '10:15:00 EDT');
  const stats = loadStats(['player1', 'player2'], races).calculateStats(races);

  assert.equal(stats.h2hCurrentStreaks.player1.player2, 1, 'player1 won the chronologically last race');
  assert.equal(stats.h2hCurrentStreaks.player2.player1, 0);
  assert.equal(stats.h2hLongestStreakDates.player1.player2, '2026-03-02');
});

test('calculateStats: a race with no timestamp at all still sorts by date', () => {
  const races = [
    { date: '2026-03-02', player1: 1, player2: 2 },
    { date: '2026-03-01', player1: 3, player2: 1 },
  ];
  const stats = loadStats(['player1', 'player2'], races).calculateStats(races);

  assert.equal(stats.h2hCurrentStreaks.player1.player2, 1);
  assert.equal(stats.h2hCurrentStreaks.player2.player1, 0);
});

// Legacy logs can still carry h24 midnight stamps ("24:30:00 EDT") written by
// the old formatter. raceDateTimeValue maps hour 24 to 00, so these races sort
// instead of NaN-ing the comparator into a silent no-op.
test('calculateStats: races stamped just after midnight still sort chronologically', () => {
  const races = OUT_OF_ORDER('24:30:00 EDT', '24:15:00 EDT');
  const stats = loadStats(['player1', 'player2'], races).calculateStats(races);

  assert.equal(stats.h2hCurrentStreaks.player1.player2, 1, 'player1 won on 2026-03-02, the later date');
  assert.equal(stats.h2hCurrentStreaks.player2.player1, 0);
});

test('calculateStats: bestStreak counts consecutive podiums in chronological order', () => {
  const races = [
    { date: '2026-03-03', timestamp: '10:00:00 EDT', player1: 2, player2: 1 },
    { date: '2026-03-01', timestamp: '10:00:00 EDT', player1: 1, player2: 2 },
    { date: '2026-03-02', timestamp: '10:00:00 EDT', player1: 8, player2: 1 },
  ];
  const stats = loadStats(['player1', 'player2'], races).calculateStats(races);

  // Chronologically player1 goes 1 (podium), 8 (break), 2 (podium): best of 1.
  assert.equal(stats.bestStreak.player1, 1);
  assert.equal(stats.bestStreak.player2, 3);
});

// --- calculateCourseStats / getCourseRankings / generateCourseStatsView -----
// Every race already carries `courseId`/`course` (dataManager.js addRace),
// but until now nothing aggregated it. These cover the per-course stats
// view: exclusion of course-less races, per-course/per-player aggregation,
// and - the behaviour the feature exists to guarantee - that a course raced
// only once or twice can never be ranked "best" or "worst".

test('calculateCourseStats: a race with no course recorded is excluded, not bucketed as "undefined"', () => {
  const races = [
    { date: '2026-03-01', player1: 1, player2: 2 }, // no course field at all
    { date: '2026-03-02', player1: 1, player2: 2, course: '' }, // blank after a repair
    { date: '2026-03-03', player1: 1, player2: 2, course: '   ' }, // whitespace only
    { date: '2026-03-04', player1: 1, player2: 2, course: 'Rainbow Road' },
  ];
  const courseStats = loadStats(['player1', 'player2'], races).calculateCourseStats(races);

  assert.equal(courseStats.length, 1, 'only the one real course produces a row');
  assert.equal(courseStats[0].name, 'Rainbow Road');
  assert.equal(courseStats[0].totalRaces, 1);
});

test('calculateCourseStats: aggregates races/average/wins/podiums per course and per player', () => {
  const races = [
    { date: '2026-03-01', course: 'Rainbow Road', player1: 1, player2: 4 },
    { date: '2026-03-02', course: 'Rainbow Road', player1: 2, player2: 3 },
    { date: '2026-03-03', course: 'Rainbow Road', player1: 3, player2: 1 },
  ];
  const [course] = loadStats(['player1', 'player2'], races).calculateCourseStats(races);

  assert.equal(course.totalRaces, 3);
  // player1: 1,2,3 -> avg 2, one win, three podiums (all top 3).
  assert.equal(course.perPlayer.player1.average, '2');
  assert.equal(course.perPlayer.player1.races, 3);
  // player2: 4,3,1 -> avg 2.7, one win, two podiums (4th does not count).
  assert.equal(course.perPlayer.player2.average, '2.7');
  assert.equal(course.wins, 2, 'one win each, combined across both players');
  assert.equal(course.podiums, 5, 'three from player1 plus two from player2');
  // Combined average across every recorded finish on this course: (1+4+2+3+3+1)/6.
  assert.equal(course.averageFinish, '2.3');
});

test('calculateCourseStats: a player who sat out a race on a course does not get a "-1" average', () => {
  const races = [
    { date: '2026-03-01', course: 'Rainbow Road', player1: 1, player2: null },
    { date: '2026-03-02', course: 'Rainbow Road', player1: 2, player2: 3 },
  ];
  const [course] = loadStats(['player1', 'player2'], races).calculateCourseStats(races);

  assert.equal(course.perPlayer.player2.races, 1);
  assert.equal(course.perPlayer.player2.average, '3');
});

test('calculateCourseStats: groups by courseId when present, falls back to the course name otherwise', () => {
  const races = [
    { date: '2026-03-01', courseId: 'rainbow-road', course: 'Rainbow Road', player1: 1 },
    { date: '2026-03-02', courseId: 'rainbow-road', course: 'Rainbow Road', player1: 2 },
    { date: '2026-03-03', course: 'Moo Moo Meadows', player1: 1 }, // legacy row, no id
    { date: '2026-03-04', course: 'Moo Moo Meadows', player1: 3 },
  ];
  const courseStats = loadStats(['player1'], races).calculateCourseStats(races);

  assert.equal(courseStats.length, 2);
  const rainbow = courseStats.find((c) => c.name === 'Rainbow Road');
  const moo = courseStats.find((c) => c.name === 'Moo Moo Meadows');
  assert.equal(rainbow.totalRaces, 2);
  assert.equal(rainbow.id, 'rainbow-road');
  assert.equal(moo.totalRaces, 2, 'grouped by name when no id was ever recorded');
  assert.equal(moo.id, null);
});

test('getCourseRankings: a course raced once never tops the best-courses list', () => {
  const races = [
    // Raced once, a perfect 1st - would dominate "best" on a naive average.
    { date: '2026-03-01', course: 'Lucky Track', player1: 1 },
    // Raced three times (the minimum), a modest but real average.
    { date: '2026-03-02', course: 'Steady Track', player1: 4 },
    { date: '2026-03-03', course: 'Steady Track', player1: 5 },
    { date: '2026-03-04', course: 'Steady Track', player1: 3 },
  ];
  const ctx = loadStats(['player1'], races);
  const minRaces = evalIn(ctx, 'MIN_COURSE_RACES_FOR_RANKING');
  assert.equal(minRaces, 3, 'the rule this test pins: 3 races minimum before a course is ranked');

  const courseStats = ctx.calculateCourseStats(races);
  const lucky = courseStats.find((c) => c.name === 'Lucky Track');
  assert.equal(lucky.qualifiesForRanking, false, 'one race is not enough to be ranked');

  const { best, worst } = ctx.getCourseRankings(courseStats);
  assert.ok(!best.some((c) => c.name === 'Lucky Track'), 'a single perfect race must not top the best-courses list');
  assert.ok(!worst.some((c) => c.name === 'Lucky Track'));
  assert.equal(best.length, 1);
  assert.equal(best[0].name, 'Steady Track');
});

test('getCourseRankings: sorts best ascending and worst descending by average finish, and respects the limit', () => {
  const races = [
    { date: '2026-03-01', course: 'A', player1: 1 }, { date: '2026-03-02', course: 'A', player1: 1 }, { date: '2026-03-03', course: 'A', player1: 1 },
    { date: '2026-03-01', course: 'B', player1: 5 }, { date: '2026-03-02', course: 'B', player1: 5 }, { date: '2026-03-03', course: 'B', player1: 5 },
    { date: '2026-03-01', course: 'C', player1: 3 }, { date: '2026-03-02', course: 'C', player1: 3 }, { date: '2026-03-03', course: 'C', player1: 3 },
  ];
  const ctx = loadStats(['player1'], races);
  const courseStats = ctx.calculateCourseStats(races);

  const { best, worst } = ctx.getCourseRankings(courseStats, 2);
  assert.equal(best.length, 2);
  // Values built inside the vm come from the vm's own Array intrinsic, so
  // assert.deepEqual against a host array trips the cross-realm prototype
  // check (tests/harness.js); compare joined strings instead.
  assert.equal(best.map((c) => c.name).join(','), 'A,C', 'ascending average, capped at the limit');
  assert.equal(worst.map((c) => c.name).join(','), 'B,C', 'descending average, capped at the limit');
});

test('generateCourseStatsView: escapes course and player names, and labels under-sampled courses', () => {
  const races = [
    { date: '2026-03-01', course: '<img src=x onerror=alert(1)>', player1: 1, player2: 2 },
  ];
  const ctx = loadStats(['player1', 'player2'], races);
  ctx.escapeHtml = (v) => String(v == null ? '' : v).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  ctx.getPlayerName = (p) => p;

  const courseStats = ctx.calculateCourseStats(races);
  const html = ctx.generateCourseStatsView(courseStats);

  assert.ok(!html.includes('<img src=x'), 'the hostile course name is not injected raw');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the escaped course name is shown instead');
  assert.ok(html.includes('not enough races yet'), 'a course under the minimum sample is labelled, not silently ranked');
  assert.ok(html.includes('1 races') || html.includes('>1<'), html);
});
