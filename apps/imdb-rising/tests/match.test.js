'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isRising,
  isConsistent,
  isSlowBurn,
  isBigFinale,
  isRebound,
  detectShapes,
  findMatches,
  isNonDecreasing,
} = require('../scripts/match.js');

const ep = (episode, rating, votes = 1000, tconst = `tt${episode}`) => ({
  episode, rating, votes, tconst,
});

const season = (...ratings) => ratings.map((r, i) => ep(i + 1, r));

// --- isRising / isNonDecreasing ---

test('isRising accepts strictly increasing ratings', () => {
  assert.equal(isRising(season(7.0, 7.2, 8.1)), true);
});

test('isRising accepts ties between adjacent episodes', () => {
  assert.equal(isRising(season(7.0, 7.0, 7.5)), true);
});

test('isRising rejects any single dip', () => {
  assert.equal(isRising(season(8.0, 7.9, 8.5)), false);
});

test('isRising treats empty and single-episode arrays as matching', () => {
  assert.equal(isRising([]), true);
  assert.equal(isRising(season(5.0)), true);
});

test('isNonDecreasing alias still exported', () => {
  assert.equal(isNonDecreasing, isRising);
});

// --- isConsistent ---

test('isConsistent matches a tight high-rated season', () => {
  assert.equal(isConsistent(season(8.4, 8.5, 8.3, 8.6, 8.5)), true);
});

test('isConsistent rejects when any episode dips below the floor', () => {
  assert.equal(isConsistent(season(8.4, 8.5, 7.9, 8.6)), false);
});

test('isConsistent rejects when the spread is too wide', () => {
  assert.equal(isConsistent(season(8.0, 9.5, 8.1, 8.2)), false);
});

// --- isSlowBurn ---

test('isSlowBurn matches when the second half lifts off', () => {
  assert.equal(isSlowBurn(season(7.0, 7.0, 7.0, 8.0, 8.2, 8.1)), true);
});

test('isSlowBurn rejects when the season is flat', () => {
  assert.equal(isSlowBurn(season(7.5, 7.6, 7.5, 7.6, 7.5, 7.6)), false);
});

test('isSlowBurn rejects seasons too short to halve', () => {
  assert.equal(isSlowBurn(season(7.0, 9.0, 9.0)), false);
});

// --- isBigFinale ---

test('isBigFinale matches when the finale is the peak and well above average', () => {
  assert.equal(isBigFinale(season(7.5, 7.6, 7.5, 9.5)), true);
});

test('isBigFinale rejects when the finale is not the peak', () => {
  assert.equal(isBigFinale(season(7.5, 9.4, 7.5, 9.0)), false);
});

test('isBigFinale rejects when the finale is only marginally above average', () => {
  assert.equal(isBigFinale(season(8.0, 8.1, 8.0, 8.2)), false);
});

// --- isRebound ---

test('isRebound matches dip-then-recover seasons', () => {
  assert.equal(isRebound(season(8.0, 7.4, 7.3, 7.8, 8.4)), true);
});

test('isRebound rejects monotonic-up seasons (no real dip)', () => {
  assert.equal(isRebound(season(7.0, 7.2, 7.4, 7.6, 7.8)), false);
});

test('isRebound rejects when end is not above start', () => {
  assert.equal(isRebound(season(8.5, 7.5, 7.4, 7.8, 8.4)), false);
});

// --- detectShapes ---

test('detectShapes tags a rising season with both rising and slow-burn when applicable', () => {
  const tags = detectShapes(season(7.0, 7.2, 7.4, 8.0, 8.2, 8.4));
  assert.ok(tags.includes('rising'));
  assert.ok(tags.includes('slow-burn'));
});

test('detectShapes returns empty array when nothing matches', () => {
  // Flat-ish season just below the consistent floor — matches no shape.
  assert.deepEqual(detectShapes(season(7.5, 7.6, 7.5, 7.6)), []);
});

// --- findMatches integration ---

test('findMatches tags shapes and includes one record per qualifying season', () => {
  const series = new Map([
    ['tt100', { title: 'Climber', year: 2020, type: 'tvSeries', genres: ['Drama'] }],
  ]);
  const episodes = new Map([
    ['tt100', new Map([
      [1, [ep(1, 7.0), ep(2, 7.2), ep(3, 7.4), ep(4, 7.5)]],
      [2, [ep(1, 8.5), ep(2, 8.5), ep(3, 8.6), ep(4, 8.5), ep(5, 8.6)]],
    ])],
  ]);
  const matches = findMatches(series, episodes);
  assert.equal(matches.length, 2);
  const s1 = matches.find((m) => m.season === 1);
  const s2 = matches.find((m) => m.season === 2);
  assert.ok(s1.shapes.includes('rising'));
  assert.ok(s2.shapes.includes('consistent'));
  assert.deepEqual(s1.genres, ['Drama']);
});

test('findMatches drops seasons that match no shapes', () => {
  const series = new Map([
    ['tt500', { title: 'Choppy', year: 2024, type: 'tvSeries' }],
  ]);
  const episodes = new Map([
    ['tt500', new Map([
      // Bouncy, mid-range, no rebound, no consistent floor — matches nothing.
      [1, [ep(1, 7.5), ep(2, 7.7), ep(3, 7.4), ep(4, 7.6)]],
    ])],
  ]);
  assert.equal(findMatches(series, episodes).length, 0);
});

test('findMatches sorts episodes by episode number before checking', () => {
  const series = new Map([
    ['tt200', { title: 'Shuffled', year: 2021, type: 'tvSeries' }],
  ]);
  const episodes = new Map([
    ['tt200', new Map([
      [1, [ep(3, 7.4), ep(1, 7.0), ep(4, 7.5), ep(2, 7.2)]],
    ])],
  ]);
  const matches = findMatches(series, episodes);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].episodes.map((e) => e.episode), [1, 2, 3, 4]);
});

test('findMatches drops seasons with fewer episodes than minEpisodes', () => {
  const series = new Map([
    ['tt300', { title: 'Tiny', year: 2022, type: 'tvSeries' }],
  ]);
  const episodes = new Map([
    ['tt300', new Map([
      [1, [ep(1, 7.0), ep(2, 7.5), ep(3, 8.0)]],
    ])],
  ]);
  assert.equal(findMatches(series, episodes, { minEpisodes: 4 }).length, 0);
  assert.equal(findMatches(series, episodes, { minEpisodes: 3 }).length, 1);
});

test('findMatches drops seasons whose lowest-vote episode is under minVotes', () => {
  const series = new Map([
    ['tt400', { title: 'Obscure', year: 2023, type: 'tvSeries' }],
  ]);
  const episodes = new Map([
    ['tt400', new Map([
      [1, [ep(1, 7.0, 50), ep(2, 7.2, 5000), ep(3, 7.4, 5000), ep(4, 7.5, 5000)]],
    ])],
  ]);
  assert.equal(findMatches(series, episodes, { minVotes: 100 }).length, 0);
  assert.equal(findMatches(series, episodes, { minVotes: 25 }).length, 1);
});

test('findMatches skips series missing from the metadata map', () => {
  const series = new Map();
  const episodes = new Map([
    ['ttGhost', new Map([
      [1, [ep(1, 7.0), ep(2, 7.5), ep(3, 8.0), ep(4, 8.5)]],
    ])],
  ]);
  assert.equal(findMatches(series, episodes).length, 0);
});
