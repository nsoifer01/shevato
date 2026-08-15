'use strict';

// Pin timezone so the timestamp-ordering assertions stay deterministic.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto } = require('./harness');

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

test('calculateStats: a race missing a player key entirely is skipped for that player', { todo: 'KNOWN DEFECT: statistics.js:61 guards with `race[player] !== null`, which lets undefined through when a slot was added after some races were recorded (roster widening). racesPlayed is inflated and averageFinish becomes NaN' }, () => {
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
  // V8 parses the US timezone abbreviations the app emits, so an out-of-order
  // log is reordered: 03-01 (player2 wins) then 03-02 (player1 wins).
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

test('calculateStats: races stamped just after midnight still sort chronologically', { todo: 'KNOWN DEFECT: addRace stamps 00:00-00:59 races on the h24 clock ("24:30:00 EDT"), which `new Date()` rejects. The comparator then returns NaN, the chronological sort silently no-ops and streaks are attributed to whoever happens to be last in insertion order' }, () => {
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
