'use strict';

// Pin timezone so the date-parsing assertions stay deterministic across CI/dev
// (parseMapTapScore normalizes through getTimezoneOffset).
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  N_LOCS, WEIGHTS, MAX_RAW, MONTHS,
  weightedTotal, predTotalFromScores, hasLocs, iPlayed, theyPlayed, bothPlayed, arrEq,
  getMyTotal, getTheirTotal, parseMapTapScore, mapTapHistoryToRounds,
  resultOf, resultLoc, stdDev, average, streaks, linearTrend, projectNext,
  rivalryScoreFromGames,
} = require('../js/stats.js');

// Helpers: a totals-only game where both sides played, and a rival-only day.
const g = (my, their) => ({ myScore: my, theirScore: their });
const rivalOnly = (their) => ({ theirScore: their });
const win = g(1000, 0);
const loss = g(0, 1000);
const tie = g(500, 500);
const closeTo = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// --- constants -------------------------------------------------------------

test('constants: scoring weights are [1,1,2,3,3] over 5 rounds, raw cap 100', () => {
  assert.equal(N_LOCS, 5);
  assert.deepEqual(WEIGHTS, [1, 1, 2, 3, 3]);
  assert.equal(MAX_RAW, 100);
  assert.equal(MONTHS.length, 12);
});

// --- weightedTotal ---------------------------------------------------------

test('weightedTotal: applies the [1,1,2,3,3] multipliers', () => {
  assert.equal(weightedTotal([10, 20, 30, 40, 50]), 10 + 20 + 60 + 120 + 150); // 360
});

test('weightedTotal: a perfect board maxes at 1000', () => {
  assert.equal(weightedTotal([100, 100, 100, 100, 100]), 1000);
});

test('weightedTotal: a zero board is 0', () => {
  assert.equal(weightedTotal([0, 0, 0, 0, 0]), 0);
});

test('weightedTotal: missing/blank slots count as 0', () => {
  assert.equal(weightedTotal([null, undefined, 5, 5, 5]), 5 * 2 + 5 * 3 + 5 * 3); // 40
});

test('weightedTotal: wrong length returns 0', () => {
  assert.equal(weightedTotal([1, 2, 3]), 0);
  assert.equal(weightedTotal([1, 2, 3, 4, 5, 6]), 0);
});

test('weightedTotal: non-array returns 0', () => {
  assert.equal(weightedTotal('nope'), 0);
  assert.equal(weightedTotal(null), 0);
  assert.equal(weightedTotal(undefined), 0);
});

// --- side presence ---------------------------------------------------------

test('hasLocs: true only when both score arrays exist', () => {
  assert.equal(hasLocs({ myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] }), true);
  assert.equal(hasLocs({ myScores: [1, 2, 3, 4, 5] }), false);
  assert.equal(hasLocs({ myScore: 100, theirScore: 90 }), false);
});

test('iPlayed / theyPlayed: arrays or finite totals count as played', () => {
  assert.equal(iPlayed({ myScores: [1, 2, 3, 4, 5] }), true);
  assert.equal(iPlayed({ myScore: 500 }), true);
  assert.equal(iPlayed({ myScore: NaN }), false);
  assert.equal(iPlayed({}), false);
  assert.equal(theyPlayed({ theirScore: 0 }), true); // 0 is a real score
  assert.equal(theyPlayed({}), false);
});

test('bothPlayed: needs a real score on each side', () => {
  assert.equal(bothPlayed(g(500, 400)), true);
  assert.equal(bothPlayed(rivalOnly(400)), false);
  assert.equal(bothPlayed({ myScore: 500 }), false);
});

// --- arrEq -----------------------------------------------------------------

test('arrEq: element-wise array equality', () => {
  assert.equal(arrEq([1, 2, 3], [1, 2, 3]), true);
  assert.equal(arrEq([1, 2, 3], [1, 2, 4]), false);
  assert.equal(arrEq([1, 2], [1, 2, 3]), false);
  const ref = [1, 2];
  assert.equal(arrEq(ref, ref), true);
  assert.equal(arrEq(null, [1]), false);
});

// --- getMyTotal / getTheirTotal -------------------------------------------

test('getMyTotal: arrays go through weightedTotal, scalars pass through', () => {
  assert.equal(getMyTotal({ myScores: [10, 20, 30, 40, 50] }), 360);
  assert.equal(getMyTotal({ myScore: 585 }), 585);
  assert.equal(getMyTotal({}), 0);
  assert.equal(getMyTotal({ myScore: NaN }), 0);
});

test('getTheirTotal: arrays go through weightedTotal, scalars pass through', () => {
  assert.equal(getTheirTotal({ theirScores: [100, 100, 100, 100, 100] }), 1000);
  assert.equal(getTheirTotal({ theirScore: 420 }), 420);
  assert.equal(getTheirTotal({}), 0);
});

test('getMyTotal: array form wins even if a legacy scalar is also present', () => {
  assert.equal(getMyTotal({ myScores: [0, 0, 0, 0, 0], myScore: 999 }), 0);
});

// --- parseMapTapScore ------------------------------------------------------

test('parseMapTapScore: parses the canonical shareable format', () => {
  const r = parseMapTapScore('May 10\n95 89 91 9 64\nFinal score: 585');
  assert.deepEqual(r.rounds, [95, 89, 91, 9, 64]);
  assert.equal(r.finalScore, 585);
  assert.equal(r.computedTotal, 585); // 95+89+182+27+192
  assert.equal(r.totalMismatch, false);
  assert.match(r.date, /^\d{4}-05-10$/);
});

test('parseMapTapScore: tolerant of line order and stray emoji on round numbers', () => {
  const r = parseMapTapScore('Final score: 585\n95🏅 89✨ 91🎉 9🤢 64🙃\nMay 10');
  assert.deepEqual(r.rounds, [95, 89, 91, 9, 64]);
  assert.equal(r.computedTotal, 585);
});

test('parseMapTapScore: flags a final-score / computed-total mismatch', () => {
  const r = parseMapTapScore('10 20 30 40 50\nFinal score: 999');
  assert.equal(r.computedTotal, 360);
  assert.equal(r.finalScore, 999);
  assert.equal(r.totalMismatch, true);
});

test('parseMapTapScore: computes the total when no final score is given', () => {
  const r = parseMapTapScore('10 20 30 40 50');
  assert.equal(r.computedTotal, 360);
  assert.equal(r.finalScore, null);
  assert.equal(r.totalMismatch, false);
  assert.equal(r.date, null);
});

test('parseMapTapScore: "Day Month" date form also works', () => {
  const r = parseMapTapScore('10 May\n1 2 3 4 5');
  assert.match(r.date, /^\d{4}-05-10$/);
});

test('parseMapTapScore: rejects a board with an out-of-range number', () => {
  // 101 > MAX_RAW, so no line qualifies as the round line.
  assert.equal(parseMapTapScore('101 50 50 50 50'), null);
});

test('parseMapTapScore: needs exactly five numbers', () => {
  assert.equal(parseMapTapScore('10 20 30 40'), null);
  assert.equal(parseMapTapScore('10 20 30 40 50 60'), null);
});

test('parseMapTapScore: empty / blank / junk input returns null', () => {
  assert.equal(parseMapTapScore(''), null);
  assert.equal(parseMapTapScore('   \n  '), null);
  assert.equal(parseMapTapScore('hello world'), null);
  assert.equal(parseMapTapScore(null), null);
});

// --- mapTapHistoryToRounds -------------------------------------------------

// Web/legacy day: roundData[] carrying answer-city coordinates.
const roundDataDay = {
  date: '2026-06-14', finalScore: 920,
  roundData: [
    { round: 1, score: 95, cityLat: 35.96, cityLng: -83.92, cityName: 'Knoxville, Tennessee' },
    { round: 2, score: 80, cityLat: 46.84, cityLng: 0.91,   cityName: 'Châtellerault, France' },
    { round: 3, score: 70, cityLat: 54.51, cityLng: 9.69,   cityName: 'Schleswig, Germany' },
    { round: 4, score: 90, cityLat: 49.92, cityLng: 7.74,   cityName: 'Bingen, Germany' },
    { round: 5, score: 60, cityLat: 57.36, cityLng: 33.66,  cityName: 'Ostashkov, Russia' },
  ],
};
// iOS 4.04+ day: rounds[] only — score + targetCity name, no coordinates.
const iosRoundsDay = {
  date: '2026-06-14', finalScore: 957, clientPlatform: 'ios', clientVersion: '4.04 (4)',
  rounds: [
    { roundNumber: 1, targetCity: 'Knoxville, Tennessee', userLat: 37.9, userLng: -87.7, score: 95, timeSpent: 4457 },
    { roundNumber: 2, targetCity: 'Châtellerault, France', userLat: 46.0, userLng: 0.0,  score: 95, timeSpent: 3000 },
    { roundNumber: 3, targetCity: 'Schleswig, Germany',    userLat: 54.0, userLng: 9.0,  score: 94, timeSpent: 3000 },
    { roundNumber: 4, targetCity: 'Bingen, Germany',       userLat: 49.0, userLng: 7.0,  score: 98, timeSpent: 3000 },
    { roundNumber: 5, targetCity: 'Ostashkov, Russia',     userLat: 57.0, userLng: 33.0, score: 95, timeSpent: 3000 },
  ],
};

test('mapTapHistoryToRounds: parses the web/legacy roundData shape with city coords', () => {
  const out = mapTapHistoryToRounds({ '2026-06-14': roundDataDay });
  assert.deepEqual(out['2026-06-14'].scores, [95, 80, 70, 90, 60]);
  assert.deepEqual(out['2026-06-14'].cities[0], { lat: 35.96, lng: -83.92, name: 'Knoxville, Tennessee' });
});

test('mapTapHistoryToRounds: falls back to the iOS 4.04 rounds shape when roundData is absent', () => {
  const out = mapTapHistoryToRounds({ '2026-06-14': iosRoundsDay });
  // Scores still pair, which is the whole point of the fallback.
  assert.deepEqual(out['2026-06-14'].scores, [95, 95, 94, 98, 95]);
  // City name is kept (from targetCity); coordinates are unavailable → NaN.
  assert.equal(out['2026-06-14'].cities[0].name, 'Knoxville, Tennessee');
  assert.ok(Number.isNaN(out['2026-06-14'].cities[0].lat));
  assert.ok(Number.isNaN(out['2026-06-14'].cities[0].lng));
});

test('mapTapHistoryToRounds: prefers roundData when an entry has BOTH (web shape)', () => {
  // The web client writes both keys; we must keep the coordinate-rich one.
  const both = { ...roundDataDay, rounds: iosRoundsDay.rounds };
  const out = mapTapHistoryToRounds({ '2026-06-14': both });
  assert.deepEqual(out['2026-06-14'].scores, [95, 80, 70, 90, 60]); // roundData scores
  assert.equal(out['2026-06-14'].cities[0].lat, 35.96);            // roundData coords
});

test('mapTapHistoryToRounds: keeps each day in its own correct format', () => {
  const out = mapTapHistoryToRounds({ '2026-06-13': roundDataDay, '2026-06-14': iosRoundsDay });
  assert.equal(Object.keys(out).length, 2);
  assert.equal(out['2026-06-13'].cities[0].lat, 35.96);
  assert.ok(Number.isNaN(out['2026-06-14'].cities[0].lat));
});

test('mapTapHistoryToRounds: rejects entries with neither a clean roundData nor rounds array', () => {
  assert.deepEqual(mapTapHistoryToRounds({}), {});
  assert.deepEqual(mapTapHistoryToRounds(null), {});
  assert.deepEqual(mapTapHistoryToRounds({ d: null }), {});
  assert.deepEqual(mapTapHistoryToRounds({ d: { finalScore: 500 } }), {}); // no rounds at all
  // Wrong length is rejected on both paths.
  assert.deepEqual(mapTapHistoryToRounds({ d: { roundData: roundDataDay.roundData.slice(0, 4) } }), {});
  assert.deepEqual(mapTapHistoryToRounds({ d: { rounds: iosRoundsDay.rounds.slice(0, 4) } }), {});
});

test('mapTapHistoryToRounds: rejects out-of-range or non-numeric scores on either path', () => {
  const badRoundData = { roundData: roundDataDay.roundData.map((r, i) => i === 0 ? { ...r, score: 101 } : r) };
  const badRounds = { rounds: iosRoundsDay.rounds.map((r, i) => i === 0 ? { ...r, score: 'NaN' } : r) };
  assert.deepEqual(mapTapHistoryToRounds({ d: badRoundData }), {});
  assert.deepEqual(mapTapHistoryToRounds({ d: badRounds }), {});
});

// --- results ---------------------------------------------------------------

test('resultOf: W / L / T from totals', () => {
  assert.equal(resultOf(win), 'W');
  assert.equal(resultOf(loss), 'L');
  assert.equal(resultOf(tie), 'T');
});

test('resultOf: rival-only (or me-only) days have no result', () => {
  assert.equal(resultOf(rivalOnly(500)), null);
  assert.equal(resultOf({ myScore: 500 }), null);
});

test('resultLoc: per-round comparison', () => {
  assert.equal(resultLoc(90, 80), 'W');
  assert.equal(resultLoc(80, 90), 'L');
  assert.equal(resultLoc(80, 80), 'T');
});

// --- aggregates ------------------------------------------------------------

test('average: mean of values, empty is 0', () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([]), 0);
  assert.equal(average([7]), 7);
});

test('stdDev: population standard deviation, <2 values is 0', () => {
  assert.equal(stdDev([]), 0);
  assert.equal(stdDev([5]), 0);
  assert.equal(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2); // textbook example
});

// --- streaks ---------------------------------------------------------------

test('streaks: tracks current and longest runs (oldest-first)', () => {
  const s = streaks([win, win, loss, win]);
  assert.equal(s.curMine, 1);      // last game is a win
  assert.equal(s.curTheirs, 0);
  assert.equal(s.longestMine, 2);  // the opening WW
  assert.equal(s.longestTheirs, 1);
});

test('streaks: a tie resets both runs', () => {
  const s = streaks([win, win, tie, win]);
  assert.equal(s.longestMine, 2);
  assert.equal(s.curMine, 1);
});

test('streaks: their unbeaten run is reported on the rival side', () => {
  const s = streaks([loss, loss, loss]);
  assert.equal(s.curTheirs, 3);
  assert.equal(s.longestTheirs, 3);
  assert.equal(s.curMine, 0);
});

test('streaks: rival-only days (null result) break a run without scoring', () => {
  const s = streaks([win, rivalOnly(900), win]);
  assert.equal(s.longestMine, 1); // the null day resets the run
  assert.equal(s.curMine, 1);
});

test('streaks: empty list is all zeros', () => {
  assert.deepEqual(streaks([]), { curMine: 0, curTheirs: 0, longestMine: 0, longestTheirs: 0 });
});

// --- trend / projection ----------------------------------------------------

test('linearTrend: positive slope when improving, 0 when flat or sparse', () => {
  assert.equal(linearTrend([1, 2, 3, 4]), 1);
  assert.equal(linearTrend([4, 3, 2, 1]), -1);
  assert.equal(linearTrend([5, 5, 5]), 0);
  assert.equal(linearTrend([5]), 0);
});

test('projectNext: extrapolates the next value', () => {
  assert.equal(projectNext([1, 2, 3, 4]), 5);
  assert.equal(projectNext([]), 0);
  assert.equal(projectNext([7]), 7);
});

test('projectNext: clamps to the 0–1000 daily-total range', () => {
  assert.equal(projectNext([2000, 2000]), 1000); // would project 2000
  assert.equal(projectNext([10, 5, 0]), 0);       // would project negative
});

// --- rivalryScoreFromGames -------------------------------------------------

test('rivalryScoreFromGames: no games is a neutral 0', () => {
  assert.equal(rivalryScoreFromGames([]), 0);
  assert.equal(rivalryScoreFromGames(null), 0);
});

test('rivalryScoreFromGames: one decisive win/loss is symmetric ±10', () => {
  closeTo(rivalryScoreFromGames([win]), 10);
  closeTo(rivalryScoreFromGames([loss]), -10);
});

test('rivalryScoreFromGames: ten straight max-margin wins reach the +100 ceiling', () => {
  closeTo(rivalryScoreFromGames(Array(10).fill(win)), 100);
});

test('rivalryScoreFromGames: a tie-only history is 0', () => {
  closeTo(rivalryScoreFromGames([tie, tie, tie]), 0);
});

test('rivalryScoreFromGames: blends win signal and margin', () => {
  // n=1, my=600 their=500: volume 0.1, recencyWinRate 1, recencyMarginRate 0.1.
  closeTo(rivalryScoreFromGames([g(600, 500)]), 0.1 * 50 * (1 + 0.1)); // 5.5
});

test('rivalryScoreFromGames: rival-only days are excluded, not counted as losses', () => {
  assert.equal(
    rivalryScoreFromGames([win, rivalOnly(900), rivalOnly(800)]),
    rivalryScoreFromGames([win]),
  );
});

test('rivalryScoreFromGames: recency weighting favors the latest games', () => {
  // oldest-first: an old loss then a recent win should net positive.
  assert.ok(rivalryScoreFromGames([loss, win]) > 0);
  // and the mirror nets negative.
  assert.ok(rivalryScoreFromGames([win, loss]) < 0);
});

// --- predTotalFromScores ---------------------------------------------------
// The predicted-total column must always equal the sum of the whole-number
// per-round chips the dashboard shows (chips = Math.round(score)). The total
// therefore rounds each round BEFORE weighting, never the raw float sum.

// Mirror of the dashboard chip math: round each round, then weight and sum.
const sumOfRoundedChips = (scores) =>
  scores.reduce((t, s, i) => t + Math.round(s) * WEIGHTS[i], 0);

test('predTotalFromScores: whole-number rounds equal the plain weighted total', () => {
  assert.equal(predTotalFromScores([10, 20, 30, 40, 50]), weightedTotal([10, 20, 30, 40, 50])); // 360
});

test('predTotalFromScores: reconciles with the rounded chips (no compound-rounding drift)', () => {
  // Floats whose raw weighted sum would round UP past the chip sum: each round
  // carries a +0.1 fraction that, weighted by [1,1,2,3,3], adds exactly 1.0.
  const scores = [91.1, 91.1, 92.1, 91.1, 89.1];
  const chipSum = sumOfRoundedChips(scores); // 91 + 91 + 92*2 + 91*3 + 89*3 = 906
  assert.equal(chipSum, 906);
  // Raw weighted sum is 907.0 and rounds to 907 under the old logic.
  assert.equal(Math.round(weightedTotal(scores)), 907);
  // New logic matches the chips exactly.
  assert.equal(predTotalFromScores(scores), 906);
});

test('predTotalFromScores: always equals the chip sum across mixed fractions', () => {
  const cases = [
    [91.4, 91.4, 92.2, 91.1, 89.3],
    [0.5, 1.5, 2.5, 3.5, 4.5],
    [99.6, 99.6, 99.6, 99.6, 99.6],
    [10.49, 20.5, 30.51, 40.4, 50.6],
  ];
  for (const scores of cases) {
    assert.equal(predTotalFromScores(scores), sumOfRoundedChips(scores), `scores=${scores}`);
  }
});

test('predTotalFromScores: clamps to [0, 1000] and floors at 0', () => {
  assert.equal(predTotalFromScores([100, 100, 100, 100, 100]), 1000);
  assert.equal(predTotalFromScores([120, 120, 120, 120, 120]), 1000); // over-cap raw clamps down
  assert.equal(predTotalFromScores([0, 0, 0, 0, 0]), 0);
});

test('predTotalFromScores: malformed input returns null (distinct from a 0 total)', () => {
  assert.equal(predTotalFromScores([1, 2, 3]), null);
  assert.equal(predTotalFromScores('nope'), null);
  assert.equal(predTotalFromScores(null), null);
});
