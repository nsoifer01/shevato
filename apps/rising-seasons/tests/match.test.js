'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isRising,
  isConsistent,
  isSlowBurn,
  isBigFinale,
  isRebound,
  isFrontLoaded,
  isDeclining,
  isBadFinale,
  isRollercoaster,
  isMidPeak,
  isUShaped,
  isOutlierPeak,
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

test('isBigFinale matches when the finale beats the rest by 0.1+', () => {
  assert.equal(isBigFinale(season(7.5, 7.6, 7.5, 9.5)), true);
});

test('isBigFinale matches when the finale clears the next-best by exactly 0.1', () => {
  assert.equal(isBigFinale(season(8.0, 8.0, 8.0, 8.0, 8.5, 8.7)), true);
});

test('isBigFinale rejects when the finale ties the next-best episode', () => {
  assert.equal(isBigFinale(season(8.0, 9.0, 8.5, 9.0)), false);
});

test('isBigFinale rejects when the finale is not the peak', () => {
  assert.equal(isBigFinale(season(7.5, 9.4, 7.5, 9.0)), false);
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

// --- isFrontLoaded ---

test('isFrontLoaded matches when the first half is much better than the second', () => {
  assert.equal(isFrontLoaded(season(8.5, 8.4, 8.6, 7.5, 7.4, 7.6)), true);
});

test('isFrontLoaded rejects flat seasons', () => {
  assert.equal(isFrontLoaded(season(7.5, 7.6, 7.5, 7.6, 7.5, 7.6)), false);
});

test('isFrontLoaded rejects slow-burn shaped seasons', () => {
  assert.equal(isFrontLoaded(season(7.0, 7.0, 7.0, 8.0, 8.2, 8.1)), false);
});

// --- isDeclining ---

test('isDeclining accepts strictly decreasing ratings', () => {
  assert.equal(isDeclining(season(8.5, 8.2, 7.8, 7.4)), true);
});

test('isDeclining accepts ties between adjacent episodes when overall direction is down', () => {
  assert.equal(isDeclining(season(8.0, 8.0, 7.5, 7.5, 7.0)), true);
});

test('isDeclining rejects any single climb', () => {
  assert.equal(isDeclining(season(8.0, 7.5, 7.7, 7.0)), false);
});

test('isDeclining rejects perfectly flat seasons', () => {
  assert.equal(isDeclining(season(7.5, 7.5, 7.5)), false);
});

// --- isBadFinale ---

test('isBadFinale matches when the finale is the trough and well below average', () => {
  assert.equal(isBadFinale(season(8.5, 8.4, 8.5, 6.5)), true);
});

test('isBadFinale rejects when the finale is not the low point', () => {
  assert.equal(isBadFinale(season(8.5, 6.0, 8.4, 7.5)), false);
});

test('isBadFinale rejects when the finale is only marginally below average', () => {
  assert.equal(isBadFinale(season(8.0, 8.1, 8.0, 7.9)), false);
});

// --- isRollercoaster ---

test('isRollercoaster matches a season with many large swings', () => {
  assert.equal(isRollercoaster(season(8.5, 7.0, 8.6, 7.1, 8.7, 7.2)), true);
});

test('isRollercoaster rejects a smoothly rising season', () => {
  assert.equal(isRollercoaster(season(7.0, 7.2, 7.4, 7.6, 7.8, 8.0)), false);
});

test('isRollercoaster rejects a season whose range is too narrow', () => {
  assert.equal(isRollercoaster(season(7.5, 7.4, 7.5, 7.4, 7.5, 7.4)), false);
});

// --- isMidPeak ---

test('isMidPeak matches when the peak sits in the interior', () => {
  assert.equal(isMidPeak(season(7.0, 7.5, 8.5, 7.6, 7.0)), true);
});

test('isMidPeak rejects when the peak is the finale', () => {
  assert.equal(isMidPeak(season(7.0, 7.5, 8.0, 8.5)), false);
});

test('isMidPeak rejects when the peak is the opener', () => {
  assert.equal(isMidPeak(season(8.5, 8.0, 7.5, 7.0)), false);
});

test('isMidPeak rejects a peak in the first quarter (Last of Us S2 case)', () => {
  // Peak at ep 2 of 7 is interior but in the first quarter — visually a
  // front-loaded curve, not mid-peak.
  assert.equal(isMidPeak(season(7.2, 9.1, 6.7, 6.1, 7.1, 8.4, 6.2)), false);
});

test('isMidPeak rejects a peak in the last quarter', () => {
  // Peak at ep 6 of 7 is interior but in the last quarter.
  assert.equal(isMidPeak(season(6.2, 7.1, 6.7, 6.1, 7.0, 9.0, 7.5)), false);
});

// --- isUShaped ---

test('isUShaped accepts a clear U — opener+finale are peaks, middle dips >= 0.5', () => {
  // Opener 9.0 and finale 9.0 are tied as the season max; ep 3 dips to 8.2 (0.8 below).
  assert.equal(isUShaped(season(9.0, 8.7, 8.2, 8.6, 9.0)), true);
});

test('isUShaped rejects a rising season (interior beats opener)', () => {
  // Interior eps beat the opener — opener is not a peak.
  assert.equal(isUShaped(season(7.0, 7.2, 7.5, 7.8, 8.0, 8.4)), false);
});

test('isUShaped rejects when an interior episode beats the finale', () => {
  // ep 2 (9.2) is higher than finale (8.4) — finale is not a peak.
  assert.equal(isUShaped(season(8.5, 9.2, 7.0, 8.4)), false);
});

test('isUShaped rejects when an interior episode beats the opener', () => {
  // ep 2 (9.2) is higher than opener (8.5).
  assert.equal(isUShaped(season(8.5, 9.2, 7.0, 8.5)), false);
});

test('isUShaped accepts a 3-episode U (opener=finale=peak, middle dips)', () => {
  // BBC Sherlock-style 3-ep season — still a valid U if the middle dips.
  assert.equal(isUShaped(season(9.0, 8.3, 9.0)), true);
});

test('isUShaped rejects when the dip is shallower than 0.5', () => {
  // Opener and finale are 9.0; deepest interior dip is only 8.6 (0.4 below).
  assert.equal(isUShaped(season(9.0, 8.7, 8.6, 8.8, 9.0)), false);
});

test('isUShaped allows a dip 0.5 below only one endpoint', () => {
  // Opener 9.0, finale 8.6. Interior 8.5 and 8.4 are both strictly
  // below both endpoints. Dip of 8.4 is 0.6 below opener but only 0.2
  // below finale — the "either endpoint" rule means this qualifies.
  assert.equal(isUShaped(season(9.0, 8.5, 8.4, 8.6)), true);
});

test('isUShaped rejects when an interior episode ties an endpoint', () => {
  // Opener 9.0, finale 8.5, but ep 2 also 8.5 ties the finale → finale
  // isn't STRICTLY the peak. Black Mirror S2 (E1=E2=7.9) was the
  // motivating real-world case.
  assert.equal(isUShaped(season(9.0, 8.5, 7.8, 8.5)), false);
});

test('isUShaped rejects when an interior ties the opener', () => {
  // Two episodes both at 7.9 — opener doesn't strictly dominate.
  assert.equal(isUShaped(season(7.9, 7.9, 6.5, 9.1)), false);
});

test('isUShaped rejects very short seasons (n < 3)', () => {
  // Two episodes is too short — no interior to dip.
  assert.equal(isUShaped(season(8.5, 8.5)), false);
});

test('isUShaped rejects a flat season with no real dip', () => {
  assert.equal(isUShaped(season(8.5, 8.4, 8.5, 8.4, 8.5)), false);
});

// --- isOutlierPeak ---

test('isOutlierPeak matches when one interior episode towers ≥1.5 above avg and next-highest', () => {
  // Ep 3 at 9.5 is interior; avg of rest ≈ 7.0; next-highest is 7.5 → 9.5-7.5=2.0 ≥1.5
  assert.equal(isOutlierPeak(season(7.0, 7.5, 9.5, 7.2, 7.1)), true);
});

test('isOutlierPeak rejects when all episodes are uniformly high (no outlier)', () => {
  assert.equal(isOutlierPeak(season(8.5, 8.6, 8.7, 8.5, 8.6)), false);
});

test('isOutlierPeak rejects when spike is at the finale (big-finale, not outlier-peak)', () => {
  // Spike at last episode — not interior.
  assert.equal(isOutlierPeak(season(7.0, 7.2, 7.1, 7.0, 9.8)), false);
});

test('isOutlierPeak rejects when spike is at the opener', () => {
  assert.equal(isOutlierPeak(season(9.8, 7.0, 7.2, 7.1, 7.0)), false);
});

test('isOutlierPeak rejects seasons shorter than 4 episodes', () => {
  assert.equal(isOutlierPeak(season(7.0, 9.5, 7.0)), false);
});

test('isOutlierPeak rejects when the margin above next-highest is below 1.5', () => {
  // Ep 3 at 9.0 vs next at 7.8 → margin 1.2 < 1.5
  assert.equal(isOutlierPeak(season(7.5, 7.8, 9.0, 7.6, 7.5)), false);
});

// --- detectShapes ---

test('detectShapes tags a rising season with both rising and slow-burn when applicable', () => {
  const tags = detectShapes(season(7.0, 7.2, 7.4, 8.0, 8.2, 8.4));
  assert.ok(tags.includes('rising'));
  assert.ok(tags.includes('slow-burn'));
});

test('detectShapes returns empty array when nothing matches', () => {
  // Flat-ish season just below the consistent floor, finale not the peak — matches no shape.
  assert.deepEqual(detectShapes(season(7.5, 7.7, 7.5, 7.6)), []);
});

// --- findMatches integration ---

test('findMatches tags shapes and emits one record per season passing the floor', () => {
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

test('findMatches keeps shape-less seasons with shapes: []', () => {
  const series = new Map([
    ['tt500', { title: 'Choppy', year: 2024, type: 'tvSeries', genres: [] }],
  ]);
  const episodes = new Map([
    ['tt500', new Map([
      // Bouncy, mid-range, no rebound, no consistent floor — matches nothing.
      // Still emitted so the full IMDb catalog is searchable.
      [1, [ep(1, 7.5), ep(2, 7.7), ep(3, 7.4), ep(4, 7.6)]],
    ])],
  ]);
  const matches = findMatches(series, episodes);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].shapes, []);
});

test('findMatches emits every season passing the floor regardless of shape', () => {
  const series = new Map([
    ['tt600', { title: 'Mixed Bag', year: 2010, type: 'tvSeries', genres: ['Drama'] }],
  ]);
  const episodes = new Map([
    ['tt600', new Map([
      // Season 1 — bouncy, no shape match. Highest avg so it doubles as the
      // anchor that keeps the last season from earning saved-best-for-last.
      [1, [ep(1, 8.0), ep(2, 8.2), ep(3, 7.9), ep(4, 8.1)]],
      // Season 2 — non-decreasing.
      [2, [ep(1, 7.0), ep(2, 7.2), ep(3, 7.4), ep(4, 7.5)]],
      // Season 3 — bouncy again, no shape match. Lower avg than S1 so the
      // saved-best-for-last post-pass doesn't fire on this run.
      [3, [ep(1, 7.0), ep(2, 6.8), ep(3, 7.1), ep(4, 6.9)]],
    ])],
  ]);
  const matches = findMatches(series, episodes);
  assert.equal(matches.length, 3);
  const s1 = matches.find((m) => m.season === 1);
  const s2 = matches.find((m) => m.season === 2);
  const s3 = matches.find((m) => m.season === 3);
  assert.deepEqual(s1.shapes, []);
  assert.ok(s2.shapes.includes('rising'));
  assert.deepEqual(s3.shapes, []);
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
