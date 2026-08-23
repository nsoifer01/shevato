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
  detectShapes,
  findMatches,
  tagInProgress,
  tagSavedBestForLast,
  tagShapeDrift,
  shapeConfidence,
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

// The chip promises a show that kept climbing and isDeclining has always
// required a real drop (first > last). A flat curve is neither, so it must not
// count as rising: 299 all-equal seasons (Anne Boleyn 5.6 5.6 5.6) and 55
// two-season shows with identical averages used to qualify on ties alone.
test('isRising rejects a perfectly flat season, mirroring isDeclining', () => {
  assert.equal(isRising(season(5.6, 5.6, 5.6)), false);
  assert.equal(isDeclining(season(5.6, 5.6, 5.6)), false);
});

test('isRising rejects sequences with no room to climb', () => {
  assert.equal(isRising([]), false);
  assert.equal(isRising(season(5.0)), false);
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

// deriveShowShapes runs these same detectors over 2-dp SEASON AVERAGES, where
// rounding the margin to 1 dp turned every 0.05 lead into a pass and made the
// show-level threshold half of what the chip promises. Reacher's season
// averages are the real case: 8.30 tops 8.23 by 0.07, not by a full step.
test('isBigFinale holds the 0.1 margin on 2-dp season averages, not 0.05', () => {
  assert.equal(isBigFinale(season(8.23, 7.93, 8.00, 8.30)), false);
  // A full step above the next-best average still passes, float dust and all.
  assert.equal(isBigFinale(season(8.15, 8.30, 8.36, 8.46)), true);
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

// --- in-progress seasons (D1) ---
//
// IMDb's TSVs carry no "season finished" flag, so tagInProgress reads it off
// the episode list plus the build clock. Three shapes claim something about the
// finale, and a finale that has not aired cannot support them.

// Season fixture in the shape findMatches emits: episode numbers matter here.
// `lastRatedYear` mirrors the build-internal `_lastRatedYear` findMatches
// attaches: the air year of the season's LATEST rated episode, which is what
// the recency test actually reads. Omitted, it falls back to seasonYear, which
// is what every caller outside a real build does.
const seasonRec = (seriesId, season, seasonYear, ratings, startEp = 1, lastRatedYear) => {
  const rec = {
    seriesId,
    season,
    seasonYear,
    avgRating: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100,
    shapes: [],
    episodes: ratings.map((r, i) => ({ episode: startEp + i, rating: r, votes: 1000 })),
  };
  if (lastRatedYear !== undefined) rec._lastRatedYear = lastRatedYear;
  return rec;
};

const listedMap = (entries) => new Map(
  entries.map(([id, seasons]) => [id, new Map(Object.entries(seasons).map(([s, n]) => [Number(s), n]))]),
);

test('detectShapes withholds the three finale shapes while a season is airing', () => {
  const bigFinale = season(7.5, 7.6, 7.5, 9.5);
  assert.ok(detectShapes(bigFinale).includes('big-finale'));
  assert.equal(detectShapes(bigFinale, { inProgress: true }).includes('big-finale'), false);

  const badFinale = season(8.5, 8.6, 8.4, 7.2);
  assert.ok(detectShapes(badFinale).includes('bad-finale'));
  assert.equal(detectShapes(badFinale, { inProgress: true }).includes('bad-finale'), false);

  const uShaped = season(9.0, 7.9, 7.8, 9.1);
  assert.ok(detectShapes(uShaped).includes('u-shaped'));
  assert.equal(detectShapes(uShaped, { inProgress: true }).includes('u-shaped'), false);

  // Everything that describes what has aired so far keeps working mid-season
  // (this curve ends on a tie, so it carries no finale-dependent shape).
  const climbing = season(7.0, 7.2, 7.4, 8.0, 8.2, 8.2);
  assert.deepEqual(detectShapes(climbing, { inProgress: true }), detectShapes(climbing));
});

test('shapeConfidence never scores a shape the in-progress season was denied', () => {
  const bigFinale = season(7.5, 7.6, 7.5, 9.5);
  assert.ok(shapeConfidence(bigFinale)['big-finale'] > 0);
  assert.equal('big-finale' in shapeConfidence(bigFinale, { inProgress: true }), false);
});

test('a genuinely finished short season still earns its finale shape', () => {
  // A complete 6-episode 2011 British drama: IMDb lists exactly 6 episodes and
  // the season is old, so nothing about it says "still airing".
  const matches = [seasonRec('ttOld', 1, 2011, [7.4, 7.5, 7.3, 7.6, 7.5, 8.2])];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttOld', { 1: 6 }]]) });
  assert.equal('inProgress' in matches[0], false);
  assert.ok(detectShapes(matches[0].episodes).includes('big-finale'));
});

test('tagInProgress flags a current-year season with episodes listed after the last rated one', () => {
  const matches = [
    seasonRec('ttA', 3, 2025, [8.1, 7.9, 8.2, 7.8, 7.9, 8.1, 7.6, 8.4]),
    seasonRec('ttA', 4, 2026, [8.3, 8.4, 8.3, 8.2]),
  ];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttA', { 3: 8, 4: 8 }]]) });
  assert.equal(matches[0].inProgress, undefined, 'a season with a later season after it is finished');
  assert.equal(matches[1].inProgress, true);
});

test('tagInProgress ignores an unrated tail on an old season', () => {
  // 6,665 seasons before 2021 end on an unrated episode simply because nobody
  // rated it. Without the recency guard the rule would strip labels from all
  // of them, back to 1932.
  const matches = [seasonRec('ttOld', 6, 1962, [8.0, 8.1, 8.2, 8.3])];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttOld', { 6: 40 }]]) });
  assert.equal('inProgress' in matches[0], false);
});

test('tagInProgress flags a current-year season far shorter than the one before it', () => {
  // Jujutsu Kaisen S3: IMDb lists only the 12 episodes that have aired, so
  // there is no tail to see; the drop from 23 episodes is the only signal.
  const matches = [
    seasonRec('ttJ', 2, 2023, Array(23).fill(9.0)),
    seasonRec('ttJ', 3, 2026, [9.2, 8.8, 7.7, 9.7, 8.3, 8.2, 8.1, 9.0, 9.6, 8.9, 9.0, 9.8]),
  ];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttJ', { 2: 23, 3: 12 }]]) });
  assert.equal(matches[1].inProgress, true);
});

test('tagInProgress compares against the previous season, so a shortened format is not "airing"', () => {
  // Criminal Minds ran 22-24 episodes for 15 seasons and 10 since the revival.
  // Against the show's median it looks half-finished; against the season
  // before it, it is exactly the same length.
  const matches = [
    seasonRec('ttC', 17, 2024, Array(10).fill(7.5)),
    seasonRec('ttC', 18, 2025, Array(10).fill(7.6)),
    seasonRec('ttC', 19, 2026, Array(10).fill(7.7)),
  ];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttC', { 17: 10, 18: 10, 19: 10 }]]) });
  assert.equal('inProgress' in matches[2], false);
});

test('tagInProgress does not call last year\'s finished season "airing"', () => {
  // The defect this rule shipped with: seasonYear is the season's EARLIEST air
  // year, so a season that ran and ended in 2025 satisfied a
  // `seasonYear >= buildYear - 1` test for the whole of 2026. Paired with an
  // unrated tail (most obscure shows never get their finale rated) that called
  // 223 demonstrably finished seasons "still airing". The season's LATEST rated
  // year is what settles it.
  const matches = [seasonRec('ttFin', 6, 2025, [7.4, 7.5, 7.3, 8.6], 1, 2025)];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttFin', { 6: 12 }]]) });
  assert.equal('inProgress' in matches[0], false);
  assert.ok(detectShapes(matches[0].episodes).includes('big-finale'), 'and it keeps the label it earned');
});

test('tagInProgress still flags a run that began last year and is airing now', () => {
  // A split-cours or autumn-to-spring season: it STARTED in 2025, so seasonYear
  // is 2025, but episodes are still being rated in 2026.
  const matches = [seasonRec('ttSplit', 2, 2025, [8.1, 8.2, 8.0, 8.3], 1, 2026)];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttSplit', { 2: 12 }]]) });
  assert.equal(matches[0].inProgress, true);
});

test('tagInProgress does not read a sparsely rated long season as a short one', () => {
  // MasterChef Australia S18: 17 rated of 60 listed. The rated count alone
  // looks like a season a third the length of the one before; the listed count
  // says it is simply under-rated, and rule 1 is the one entitled to decide.
  const matches = [
    seasonRec('ttM', 17, 2025, Array(40).fill(7.5), 1, 2025),
    seasonRec('ttM', 18, 2026, Array(17).fill(7.6), 1, 2026),
  ];
  tagInProgress(matches, { buildYear: 2026, listedMaxEp: listedMap([['ttM', { 17: 40, 18: 60 }]]) });
  // Rule 1 flags it (60 listed > 17 rated), which is correct; the point of the
  // test is that rule 2 is not what decided it.
  assert.equal(matches[1].inProgress, true);
  const sparseNoTail = [
    seasonRec('ttN', 1, 2025, Array(40).fill(7.5), 1, 2025),
    seasonRec('ttN', 2, 2026, Array(17).fill(7.6), 1, 2026),
  ];
  // Same shape of data, but IMDb lists exactly what we have ratings for at the
  // END of the season: 17 of 17 is genuinely short, so rule 2 fires.
  tagInProgress(sparseNoTail, { buildYear: 2026, listedMaxEp: listedMap([['ttN', { 1: 40, 2: 17 }]]) });
  assert.equal(sparseNoTail[1].inProgress, true);
});

test('tagInProgress makes no claim without a build year', () => {
  const matches = [seasonRec('ttA', 1, 2026, [8.0, 8.1, 8.2, 8.3])];
  tagInProgress(matches, { listedMaxEp: listedMap([['ttA', { 1: 10 }]]) });
  assert.equal('inProgress' in matches[0], false);
});

test('tagSavedBestForLast skips a series whose highest-numbered season is airing', () => {
  const build = () => [
    seasonRec('ttS', 1, 2022, [8.2, 8.3, 8.1, 8.2]),
    seasonRec('ttS', 2, 2023, [7.9, 8.0, 7.8, 8.1]),
    seasonRec('ttS', 3, 2026, [9.0, 8.9, 9.1, 9.0]),
  ];
  const finished = build();
  tagSavedBestForLast(finished);
  assert.ok(finished[2].shapes.includes('saved-best-for-last'), 'control: it does fire when S3 has ended');

  const airing = build();
  airing[2].inProgress = true;
  tagSavedBestForLast(airing);
  assert.equal(airing[2].shapes.includes('saved-best-for-last'), false);
});

test('tagShapeDrift skips a series whose highest-numbered season is airing', () => {
  const build = () => [
    seasonRec('ttD', 1, 2021, [8.5, 8.6, 8.4, 8.5]),
    seasonRec('ttD', 2, 2022, [8.4, 8.5, 8.6, 8.5]),
    seasonRec('ttD', 3, 2026, [7.7, 8.2, 7.9]),
  ];
  const finished = build();
  tagShapeDrift(finished);
  assert.ok(finished[2].shapes.includes('shape-drift'), 'control: a 0.5+ drop does drift');

  const airing = build();
  airing[2].inProgress = true;
  tagShapeDrift(airing);
  assert.equal(airing[2].shapes.includes('shape-drift'), false);
  assert.equal(airing[2].driftNote, undefined);
});

test('findMatches stamps inProgress and withholds the finale shapes end to end', () => {
  const year = 2026;
  const series = new Map([
    ['tt700', { title: 'Airing', year: 2020, type: 'tvSeries', genres: ['Drama'] }],
  ]);
  const withYear = (episode, rating) => ({ ...ep(episode, rating), year });
  const episodes = new Map([
    ['tt700', new Map([
      [1, [withYear(1, 7.5), withYear(2, 7.6), withYear(3, 7.5), withYear(4, 9.5)]],
    ])],
  ]);
  const listedMaxEp = listedMap([['tt700', { 1: 10 }]]);

  const airing = findMatches(series, episodes, { buildYear: year, listedMaxEp });
  assert.equal(airing[0].inProgress, true);
  assert.equal(airing[0].shapes.includes('big-finale'), false);
  assert.equal('big-finale' in airing[0].confidence, false);

  // Same season, but IMDb lists no episode past the fourth: it has ended.
  const done = findMatches(series, episodes, {
    buildYear: year,
    listedMaxEp: listedMap([['tt700', { 1: 4 }]]),
  });
  assert.equal('inProgress' in done[0], false);
  assert.ok(done[0].shapes.includes('big-finale'));
});
