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
  parseDateISO, isoWeekStart, isoWeekEnd, isoWeekId,
  monthId, monthStart, monthEnd, periodBounds, periodRecords,
  periodOutcomeVsRival, runningRivalPeriodRecords, periodTallyText,
  rankByScore, positionHitsForDay, accumulatePositionHits,
  finishPositionsForDay, fieldSharesForDay, competitionRanksForDay,
  accumulateFinishPositions,
  avgPositionColor, avgPositionColors,
  myAvgByContinent,
  compareNamesCI, compareWinPctDesc,
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

test('mapTapHistoryToRounds: a present-but-malformed roundData is dropped, NOT recovered via rounds', () => {
  // Web-safety guarantee: the rounds fallback fires only when roundData is
  // entirely ABSENT. Any entry that carries roundData (the web shape always
  // does) behaves exactly as it did before — including being dropped when
  // malformed — even if a valid `rounds` sits alongside it. This keeps non-iOS
  // players byte-for-byte unchanged.
  const wrongLen  = { roundData: roundDataDay.roundData.slice(0, 4), rounds: iosRoundsDay.rounds };
  const outOfRange = { roundData: roundDataDay.roundData.map((r, i) => i === 0 ? { ...r, score: 101 } : r), rounds: iosRoundsDay.rounds };
  assert.deepEqual(mapTapHistoryToRounds({ d: wrongLen }), {});
  assert.deepEqual(mapTapHistoryToRounds({ d: outOfRange }), {});
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

// --- parseDateISO ----------------------------------------------------------

test('parseDateISO: reads the parts off the string, not a local-time Date', () => {
  assert.deepEqual(parseDateISO('2026-08-02'),
    { year: 2026, month: 8, day: 2, ms: Date.UTC(2026, 7, 2) });
});

test('parseDateISO: rejects malformed and impossible dates', () => {
  assert.equal(parseDateISO('2026-2-2'), null);      // needs zero padding
  assert.equal(parseDateISO('2026-02-30'), null);    // would roll over to Mar 2
  assert.equal(parseDateISO('2026-13-01'), null);
  assert.equal(parseDateISO('not a date'), null);
  assert.equal(parseDateISO(null), null);
  assert.equal(parseDateISO(20260802), null);
});

// --- ISO week bucketing ----------------------------------------------------
// Weeks run Monday to Sunday, so the boundary cases that matter are a Sunday
// (last day of its week, not the first) and the turn of the year.

test('isoWeekStart / isoWeekEnd: Monday opens the week, Sunday closes it', () => {
  assert.equal(isoWeekStart('2026-07-27'), '2026-07-27'); // Monday is its own start
  assert.equal(isoWeekEnd('2026-07-27'), '2026-08-02');
});

test('isoWeekStart: a Sunday lands in the Monday-started week that precedes it', () => {
  // 2026-08-02 is a Sunday; the naive "week starts Sunday" bucketing would
  // open a new week here and split the Mon-Sat games away from it.
  assert.equal(isoWeekStart('2026-08-02'), '2026-07-27');
  assert.equal(isoWeekEnd('2026-08-02'), '2026-08-02');
  assert.equal(isoWeekId('2026-08-02'), isoWeekId('2026-07-27'));
});

test('isoWeekStart: the next Monday opens a fresh week', () => {
  assert.equal(isoWeekStart('2026-08-03'), '2026-08-03');
  assert.notEqual(isoWeekId('2026-08-03'), isoWeekId('2026-08-02'));
});

test('isoWeekId: week-numbering year follows the week Thursday across new year', () => {
  assert.equal(isoWeekId('2021-01-01'), '2020-W53'); // Friday, still 2020's week 53
  assert.equal(isoWeekId('2020-12-28'), '2020-W53'); // same week, previous year
  assert.equal(isoWeekId('2019-12-30'), '2020-W01'); // Monday, already 2020's week 1
  assert.equal(isoWeekId('2026-01-01'), '2026-W01'); // Thursday opens week 1
});

test('isoWeekId: pads the week number to two digits so ids sort as text', () => {
  assert.equal(isoWeekId('2026-03-05'), '2026-W10');
  assert.equal(isoWeekId('2026-02-26'), '2026-W09');
  assert.ok(isoWeekId('2026-02-26') < isoWeekId('2026-03-05'));
});

test('isoWeekId: the bucket does not move with the host timezone', () => {
  // The browser is not pinned to UTC the way this test file is. Date math on
  // the string must give the same week in Los Angeles as in Kiritimati.
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(isoWeekId('2026-08-03'), '2026-W32');
    assert.equal(isoWeekStart('2026-08-03'), '2026-08-03');
    assert.equal(monthId('2026-08-01'), '2026-08');
    process.env.TZ = 'Pacific/Kiritimati';
    assert.equal(isoWeekId('2026-08-03'), '2026-W32');
    assert.equal(isoWeekStart('2026-08-03'), '2026-08-03');
    assert.equal(monthId('2026-08-01'), '2026-08');
  } finally {
    process.env.TZ = original;
  }
});

test('isoWeek helpers: malformed dates yield null instead of a garbage bucket', () => {
  assert.equal(isoWeekId('nope'), null);
  assert.equal(isoWeekStart(''), null);
  assert.equal(isoWeekEnd(undefined), null);
});

// --- month bucketing -------------------------------------------------------

test('monthId / monthStart / monthEnd: calendar month bounds', () => {
  assert.equal(monthId('2026-08-02'), '2026-08');
  assert.equal(monthStart('2026-08-02'), '2026-08-01');
  assert.equal(monthEnd('2026-08-02'), '2026-08-31');
  assert.equal(monthEnd('2026-06-15'), '2026-06-30');
  assert.equal(monthEnd('2026-12-31'), '2026-12-31');
});

test('monthEnd: leap years get February 29', () => {
  assert.equal(monthEnd('2024-02-10'), '2024-02-29');
  assert.equal(monthEnd('2026-02-10'), '2026-02-28');
});

test('month helpers: malformed dates yield null', () => {
  assert.equal(monthId('2026-8'), null);
  assert.equal(monthStart('nope'), null);
  assert.equal(monthEnd(null), null);
});

// --- periodBounds ----------------------------------------------------------

test('periodBounds: picks the week or the month for the same date', () => {
  assert.deepEqual(periodBounds('2026-08-01', 'week'),
    { id: '2026-W31', start: '2026-07-27', end: '2026-08-02' });
  assert.deepEqual(periodBounds('2026-08-01', 'month'),
    { id: '2026-08', start: '2026-08-01', end: '2026-08-31' });
});

test('periodBounds: anything other than "month" buckets by week', () => {
  assert.equal(periodBounds('2026-08-01', 'week').id, '2026-W31');
  assert.equal(periodBounds('2026-08-01', undefined).id, '2026-W31');
});

// --- periodRecords ---------------------------------------------------------
// A log spanning two ISO weeks and two months, two rivals, one tie, plus the
// two kinds of one-sided day the sync can produce. Hand-computed below.
const recordLog = [
  { rivalId: 'a', date: '2026-07-22', myScore: 600, theirScore: 500 }, // W  week30 / Jul
  { rivalId: 'b', date: '2026-07-22', myScore: 600, theirScore: 700 }, // L  week30 / Jul
  { rivalId: 'a', date: '2026-07-24', myScore: 500, theirScore: 500 }, // T  week30 / Jul
  { rivalId: 'a', date: '2026-07-31', myScore: 700, theirScore: 400 }, // W  week31 / Jul
  { rivalId: 'b', date: '2026-08-01', myScore: 300, theirScore: 900 }, // L  week31 / Aug
  { rivalId: 'a', date: '2026-08-02', theirScore: 800 },               // rival-only day
  { rivalId: 'b', date: '2026-07-29', myScore: 750 },                  // solo day
];

test('periodRecords: weekly buckets are newest first with the Sunday game in the Monday week', () => {
  const weeks = periodRecords(recordLog, 'week');
  assert.deepEqual(weeks.map(w => w.id), ['2026-W31', '2026-W30']);
  assert.equal(weeks[0].start, '2026-07-27');
  assert.equal(weeks[0].end, '2026-08-02');
  assert.equal(weeks[0].unit, 'week');
});

test('periodRecords: overall W-L-T and win % per week match the hand count', () => {
  const [w31, w30] = periodRecords(recordLog, 'week');
  // Week 31: Jul 31 win, Aug 1 loss. The Aug 2 rival-only day counts for nobody.
  assert.deepEqual(
    { games: w31.games, wins: w31.wins, losses: w31.losses, ties: w31.ties },
    { games: 2, wins: 1, losses: 1, ties: 0 });
  assert.equal(w31.decided, 2);
  assert.equal(w31.winPct, 50);
  // Week 30: win, loss, tie. Win % counts decided games only, so 1 of 2.
  assert.deepEqual(
    { games: w30.games, wins: w30.wins, losses: w30.losses, ties: w30.ties },
    { games: 3, wins: 1, losses: 1, ties: 1 });
  assert.equal(w30.decided, 2);
  assert.equal(w30.winPct, 50);
});

test('periodRecords: per-rival breakdown splits the week, biggest sample first', () => {
  const [, w30] = periodRecords(recordLog, 'week');
  assert.deepEqual(w30.byRival.map(r => r.rivalId), ['a', 'b']);
  assert.deepEqual(
    { games: w30.byRival[0].games, wins: w30.byRival[0].wins, ties: w30.byRival[0].ties },
    { games: 2, wins: 1, ties: 1 });
  assert.equal(w30.byRival[0].winPct, 100); // 1 win, 0 losses, the tie is undecided
  assert.deepEqual(
    { games: w30.byRival[1].games, losses: w30.byRival[1].losses },
    { games: 1, losses: 1 });
  assert.equal(w30.byRival[1].winPct, 0);
});

test('periodRecords: monthly buckets split the week that straddles the month end', () => {
  const months = periodRecords(recordLog, 'month');
  assert.deepEqual(months.map(m => m.id), ['2026-08', '2026-07']);
  assert.equal(months[0].unit, 'month');
  assert.equal(months[0].start, '2026-08-01');
  assert.equal(months[0].end, '2026-08-31');
  // August so far: only the Aug 1 loss (Aug 2 is rival-only).
  assert.deepEqual(
    { games: months[0].games, wins: months[0].wins, losses: months[0].losses },
    { games: 1, wins: 0, losses: 1 });
  // July: two wins, one loss, one tie across both rivals.
  assert.deepEqual(
    { games: months[1].games, wins: months[1].wins, losses: months[1].losses, ties: months[1].ties },
    { games: 4, wins: 2, losses: 1, ties: 1 });
  assert.equal(months[1].decided, 3);
  closeTo(months[1].winPct, (2 / 3) * 100, 1e-9);
});

test('periodRecords: one-sided days never create a period of their own', () => {
  const oneSided = [
    { rivalId: 'a', date: '2026-05-04', theirScore: 800 },
    { rivalId: 'b', date: '2026-05-05', myScore: 700 },
  ];
  assert.deepEqual(periodRecords(oneSided, 'week'), []);
  assert.deepEqual(periodRecords(oneSided, 'month'), []);
});

test('periodRecords: a period of nothing but ties reports no decided games', () => {
  const allTies = [
    { rivalId: 'a', date: '2026-05-04', myScore: 500, theirScore: 500 },
    { rivalId: 'a', date: '2026-05-05', myScore: 600, theirScore: 600 },
  ];
  const [week] = periodRecords(allTies, 'week');
  assert.equal(week.games, 2);
  assert.equal(week.ties, 2);
  assert.equal(week.decided, 0);
  assert.equal(week.winPct, 0);
});

test('periodRecords: legacy totals-only games and round arrays bucket alike', () => {
  const mixed = [
    { rivalId: 'a', date: '2026-05-04', myScore: 500, theirScore: 400 },
    { rivalId: 'a', date: '2026-05-05', myScores: [80, 80, 80, 80, 80], theirScores: [10, 10, 10, 10, 10] },
  ];
  const [week] = periodRecords(mixed, 'week');
  assert.equal(week.games, 2);
  assert.equal(week.wins, 2);
});

test('periodRecords: undated or malformed games are skipped, not bucketed', () => {
  const dirty = [
    { rivalId: 'a', date: 'whenever', myScore: 500, theirScore: 400 },
    { rivalId: 'a', myScore: 500, theirScore: 400 },
    null,
    { rivalId: 'a', date: '2026-05-04', myScore: 500, theirScore: 400 },
  ];
  const weeks = periodRecords(dirty, 'week');
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].games, 1);
});

test('periodRecords: no games at all yields an empty list', () => {
  assert.deepEqual(periodRecords([], 'week'), []);
  assert.deepEqual(periodRecords(null, 'month'), []);
});

test('periodRecords: games whose rival is gone are dropped from the split and the total', () => {
  // 'ghost' is a rival the sync resurrected games for after a delete: it must
  // count nowhere, not as an extra row and not in the period's own W-L-T.
  const withGhost = recordLog.concat([
    { rivalId: 'ghost', date: '2026-07-22', myScore: 900, theirScore: 100 }, // W week30
    { rivalId: 'ghost', date: '2026-07-31', myScore: 100, theirScore: 900 }, // L week31
  ]);
  const [w31, w30] = periodRecords(withGhost, 'week', new Set(['a', 'b']));
  assert.deepEqual(w30.byRival.map(r => r.rivalId), ['a', 'b']);
  assert.deepEqual(
    { games: w30.games, wins: w30.wins, losses: w30.losses, ties: w30.ties },
    { games: 3, wins: 1, losses: 1, ties: 1 });
  assert.deepEqual(w31.byRival.map(r => r.rivalId), ['a', 'b']);
  assert.equal(w31.games, 2);
});

test('periodRecords: a period left with only gone rivals disappears entirely', () => {
  const onlyGhost = [
    { rivalId: 'ghost', date: '2026-05-04', myScore: 500, theirScore: 400 },
  ];
  assert.deepEqual(periodRecords(onlyGhost, 'week', new Set(['a'])), []);
  assert.deepEqual(periodRecords(onlyGhost, 'month', ['a']), []);
});

test('periodRecords: an array of known ids works the same as a Set', () => {
  const set = periodRecords(recordLog, 'week', new Set(['a']));
  const arr = periodRecords(recordLog, 'week', ['a']);
  assert.deepEqual(arr, set);
  assert.deepEqual(arr.flatMap(w => w.byRival.map(r => r.rivalId)), ['a', 'a']);
});

test('periodRecords: omitting the known-rival set buckets every game', () => {
  const withGhost = recordLog.concat([
    { rivalId: 'ghost', date: '2026-07-22', myScore: 900, theirScore: 100 },
  ]);
  const [, w30] = periodRecords(withGhost, 'week');
  assert.deepEqual(w30.byRival.map(r => r.rivalId).sort(), ['a', 'b', 'ghost']);
  assert.equal(w30.games, 4);
});

// --- periodOutcomeVsRival / runningRivalPeriodRecords ----------------------
// Three consecutive ISO weeks inside one month, two rivals. Hand-computed:
//   week Jun 8:  a W,W -> won      b L    -> lost
//   week Jun 15: a L,L -> lost     b absent
//   week Jun 22: a W,L -> tied     b W    -> won
// So over the whole month a is 3W-3L (tied) and b is 1W-1L (tied), which is
// what makes the monthly tallies differ from the weekly ones.
const runLog = [
  { rivalId: 'a', date: '2026-06-08', myScore: 600, theirScore: 500 },
  { rivalId: 'a', date: '2026-06-09', myScore: 600, theirScore: 500 },
  { rivalId: 'b', date: '2026-06-10', myScore: 400, theirScore: 500 },
  { rivalId: 'a', date: '2026-06-15', myScore: 400, theirScore: 500 },
  { rivalId: 'a', date: '2026-06-16', myScore: 400, theirScore: 500 },
  { rivalId: 'a', date: '2026-06-22', myScore: 600, theirScore: 500 },
  { rivalId: 'a', date: '2026-06-23', myScore: 400, theirScore: 500 },
  { rivalId: 'b', date: '2026-06-24', myScore: 600, theirScore: 500 },
];

test('periodOutcomeVsRival: the W/L balance decides the period, ties do not', () => {
  assert.equal(periodOutcomeVsRival({ games: 3, wins: 2, losses: 1, ties: 0 }), 'won');
  assert.equal(periodOutcomeVsRival({ games: 3, wins: 1, losses: 2, ties: 0 }), 'lost');
  assert.equal(periodOutcomeVsRival({ games: 4, wins: 2, losses: 2, ties: 0 }), 'tied');
  // A period of nothing but ties is still a period you played: it is drawn.
  assert.equal(periodOutcomeVsRival({ games: 2, wins: 0, losses: 0, ties: 2 }), 'tied');
  // Never played in that period, so it counts for nothing.
  assert.equal(periodOutcomeVsRival({ games: 0, wins: 0, losses: 0, ties: 0 }), null);
  assert.equal(periodOutcomeVsRival(null), null);
});

test('runningRivalPeriodRecords: weekly tallies accumulate oldest to newest', () => {
  const running = runningRivalPeriodRecords(periodRecords(runLog, 'week'));
  assert.deepEqual(running['2026-W24'], {
    a: { won: 1, lost: 0, tied: 0 },
    b: { won: 0, lost: 1, tied: 0 },
  });
  assert.deepEqual(running['2026-W25'], {
    a: { won: 1, lost: 1, tied: 0 },
    b: { won: 0, lost: 1, tied: 0 }, // not played that week, tally untouched
  });
  assert.deepEqual(running['2026-W26'], {
    a: { won: 1, lost: 1, tied: 1 },
    b: { won: 1, lost: 1, tied: 0 },
  });
});

test('runningRivalPeriodRecords: monthly counts months, not weeks', () => {
  const running = runningRivalPeriodRecords(periodRecords(runLog, 'month'));
  assert.deepEqual(running['2026-06'], {
    a: { won: 0, lost: 0, tied: 1 },
    b: { won: 0, lost: 0, tied: 1 },
  });
});

test('runningRivalPeriodRecords: input order does not matter, snapshots are independent', () => {
  const weeks = periodRecords(runLog, 'week');            // newest first
  const fromNewest = runningRivalPeriodRecords(weeks);
  const fromOldest = runningRivalPeriodRecords(weeks.slice().reverse());
  assert.deepEqual(fromNewest, fromOldest);
  // Mutating one period's snapshot must not bleed into the next period's.
  fromNewest['2026-W24'].a.won = 99;
  assert.equal(fromNewest['2026-W26'].a.won, 1);
});

test('runningRivalPeriodRecords: nothing to replay yields nothing', () => {
  assert.deepEqual(runningRivalPeriodRecords([]), {});
  assert.deepEqual(runningRivalPeriodRecords(null), {});
});

test('periodTallyText: the tied component only renders once it is nonzero', () => {
  assert.equal(periodTallyText({ won: 9, lost: 8, tied: 0 }), '9-8');
  assert.equal(periodTallyText({ won: 63, lost: 54, tied: 1 }), '63-54-1');
  assert.equal(periodTallyText({ won: 0, lost: 0, tied: 0 }), '0-0');
  assert.equal(periodTallyText(null), '');
});

// --- rankByScore -----------------------------------------------------------

test('rankByScore: highest score first, name breaks the tie', () => {
  const entries = [
    { key: 'z', name: 'Zed', predictedTotal: 500 },
    { key: 'a', name: 'Ann', predictedTotal: 500 },
    { key: 'm', name: 'Moe', predictedTotal: 900 },
  ];
  assert.deepEqual(rankByScore(entries, 'predictedTotal'), ['m', 'a', 'z']);
});

test('rankByScore: entries without a usable score drop out of the ranking', () => {
  const entries = [
    { key: 'a', name: 'Ann', predictedTotal: 500, actualTotal: null },
    { key: 'b', name: 'Bob', predictedTotal: 400, actualTotal: 600 },
  ];
  assert.deepEqual(rankByScore(entries, 'actualTotal'), ['b']);
});

test('rankByScore: does not mutate the caller array', () => {
  const entries = [
    { key: 'a', name: 'Ann', predictedTotal: 100 },
    { key: 'b', name: 'Bob', predictedTotal: 900 },
  ];
  rankByScore(entries, 'predictedTotal');
  assert.deepEqual(entries.map(e => e.key), ['a', 'b']);
});

// --- positionHitsForDay ----------------------------------------------------

test('positionHitsForDay: a hit is finishing exactly where you were predicted', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 850 },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
  ];
  // Predicted a, b, c. Actual b (850), a (800), c (400): only c held its spot.
  assert.deepEqual(positionHitsForDay(day), { a: false, b: false, c: true });
});

test('positionHitsForDay: ties in the actual scores fall back to name order', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 600 },
    { key: 'z', name: 'Zed', predictedTotal: 700, actualTotal: 600 },
  ];
  // Equal actuals: Ann sorts first by name and so keeps her predicted spot.
  assert.deepEqual(positionHitsForDay(day), { a: true, z: true });
});

test('positionHitsForDay: a player with no prediction is invisible to the ranking', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 850 },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
    // Newcomer with a synced score but not enough history to be predicted.
    { key: 'd', name: 'Dee', predictedTotal: null, actualTotal: 1000 },
  ];
  const hits = positionHitsForDay(day);
  assert.equal('d' in hits, false);
  // Dee's 1000 must not push everyone down a rank.
  assert.deepEqual(hits, { a: false, b: false, c: true });
});

test('positionHitsForDay: a predicted player who sat out is not eligible', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
  ];
  const hits = positionHitsForDay(day);
  assert.equal('b' in hits, false);
  // Both rankings cover only Ann and Cid, so each one keeps its predicted spot.
  assert.deepEqual(hits, { a: true, c: true });
});

test('positionHitsForDay: an absent player does not shift the ranks of those who played', () => {
  const withAbsentee = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    // Predicted to finish second but never played: holds no rank slot.
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
    { key: 'd', name: 'Dee', predictedTotal: 300, actualTotal: 200 },
  ];
  const sameDayWithoutHim = withAbsentee.filter(e => e.key !== 'b');
  // Cid and Dee, predicted third and fourth, can still hit their real
  // positions (first and second among the three who showed up) - the whole
  // point of ranking predictions over the players who actually played.
  assert.deepEqual(positionHitsForDay(withAbsentee), { a: true, c: true, d: true });
  assert.deepEqual(positionHitsForDay(withAbsentee), positionHitsForDay(sameDayWithoutHim));
});

test('positionHitsForDay: a lone player who played always hits', () => {
  assert.deepEqual(
    positionHitsForDay([{ key: 'a', name: 'Ann', predictedTotal: 400, actualTotal: 900 }]),
    { a: true });
});

test('positionHitsForDay: a day nobody played produces no eligible players', () => {
  assert.deepEqual(positionHitsForDay([
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: null },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
  ]), {});
  assert.deepEqual(positionHitsForDay([]), {});
});

// --- accumulatePositionHits ------------------------------------------------

test('accumulatePositionHits: counts hits and eligible days per player', () => {
  const days = [
    [ // both hold their spots
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
      { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 600 },
    ],
    [ // Bob upsets Ann
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 500 },
      { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 950 },
    ],
    [ // Ann alone: eligible for her, not for Bob
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
      { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
    ],
  ];
  assert.deepEqual(accumulatePositionHits(days), {
    a: { hits: 2, eligible: 3 },
    b: { hits: 1, eligible: 2 },
  });
});

test('accumulatePositionHits: days without any prediction contribute nothing', () => {
  const days = [
    [{ key: 'a', name: 'Ann', predictedTotal: null, actualTotal: 800 }],
    [],
  ];
  assert.deepEqual(accumulatePositionHits(days), {});
});

test('accumulatePositionHits: no history at all yields no records (never 0/0)', () => {
  assert.deepEqual(accumulatePositionHits([]), {});
  assert.deepEqual(accumulatePositionHits(null), {});
});

// --- finishPositionsForDay -------------------------------------------------

test('finishPositionsForDay: highest daily total finishes first', () => {
  assert.deepEqual(finishPositionsForDay([
    { key: 'a', total: 700 },
    { key: 'b', total: 900 },
    { key: 'c', total: 500 },
  ]), { b: 1, a: 2, c: 3 });
});

test('finishPositionsForDay: tied totals share the mean of the ranks they span', () => {
  // Two tied firsts split ranks 1 and 2, so the podium reads 1.5, 1.5, 3
  // instead of handing one of them first place on a name coin-flip.
  assert.deepEqual(finishPositionsForDay([
    { key: 'zoe', total: 900 },
    { key: 'ann', total: 900 },
    { key: 'bob', total: 400 },
  ]), { zoe: 1.5, ann: 1.5, bob: 3 });
});

test('finishPositionsForDay: a three-way tie for second averages ranks 2, 3 and 4', () => {
  assert.deepEqual(finishPositionsForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: 600 },
    { key: 'c', total: 600 },
    { key: 'd', total: 600 },
  ]), { a: 1, b: 3, c: 3, d: 3 });
});

test('finishPositionsForDay: everyone tied shares one position', () => {
  assert.deepEqual(finishPositionsForDay([
    { key: 'a', total: 500 },
    { key: 'b', total: 500 },
  ]), { a: 1.5, b: 1.5 });
});

test('finishPositionsForDay: a solo day has no position to award', () => {
  // Position is a claim about the other players; with nobody else there is
  // nothing to claim, so the day must not inflate anyone's average to 1.0.
  assert.deepEqual(finishPositionsForDay([{ key: 'a', total: 900 }]), {});
  assert.deepEqual(finishPositionsForDay([]), {});
  assert.deepEqual(finishPositionsForDay(null), {});
});

test('finishPositionsForDay: players who did not play are not ranked', () => {
  assert.deepEqual(finishPositionsForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: null },
    { key: 'c', total: 300 },
  ]), { a: 1, c: 2 });
  // Only one of the three actually played: still a solo day.
  assert.deepEqual(finishPositionsForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: null },
    { key: 'c', total: undefined },
  ]), {});
});

test('finishPositionsForDay: does not mutate the caller array', () => {
  const day = [{ key: 'a', total: 100 }, { key: 'b', total: 900 }];
  finishPositionsForDay(day);
  assert.deepEqual(day.map(e => e.key), ['a', 'b']);
});

// --- fieldSharesForDay -----------------------------------------------------

test('fieldSharesForDay: first beats the whole field, last beats none of it', () => {
  assert.deepEqual(fieldSharesForDay([
    { key: 'a', total: 700 },
    { key: 'b', total: 900 },
    { key: 'c', total: 500 },
  ]), { b: 1, a: 0.5, c: 0 });
});

test('fieldSharesForDay: finishing last is 0% whatever the field size', () => {
  // The whole point of the metric: last of three is not a better day than
  // last of ten just because the number 3 is smaller than the number 10.
  const last3 = fieldSharesForDay([
    { key: 'a', total: 900 }, { key: 'b', total: 800 }, { key: 'z', total: 100 },
  ]);
  const last4 = fieldSharesForDay([
    { key: 'a', total: 900 }, { key: 'b', total: 800 },
    { key: 'c', total: 700 }, { key: 'z', total: 100 },
  ]);
  const last10 = fieldSharesForDay(
    Array.from({ length: 9 }, (_, i) => ({ key: `p${i}`, total: 900 - i * 10 }))
      .concat([{ key: 'z', total: 100 }]));
  assert.equal(last3.z, 0);
  assert.equal(last4.z, 0);
  assert.equal(last10.z, 0);
  // And first is 1 across the same three field sizes.
  assert.equal(last3.a, 1);
  assert.equal(last4.a, 1);
  assert.equal(last10.p0, 1);
});

test('fieldSharesForDay: a two-player day is all or nothing', () => {
  assert.deepEqual(fieldSharesForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: 500 },
  ]), { a: 1, b: 0 });
});

test('fieldSharesForDay: tied players split the credit their ranks span', () => {
  // Two tied firsts of three share rank 1.5, so each beat (3 - 1.5) / 2 of
  // the field: three quarters, not the full field and not half of it.
  closeTo(fieldSharesForDay([
    { key: 'zoe', total: 900 },
    { key: 'ann', total: 900 },
    { key: 'bob', total: 400 },
  ]).zoe, 0.75);
  // Everyone tied means nobody beat anybody: dead centre.
  assert.deepEqual(fieldSharesForDay([
    { key: 'a', total: 500 },
    { key: 'b', total: 500 },
  ]), { a: 0.5, b: 0.5 });
  const allTied = fieldSharesForDay([
    { key: 'a', total: 500 }, { key: 'b', total: 500 }, { key: 'c', total: 500 },
  ]);
  closeTo(allTied.a, 0.5);
  closeTo(allTied.c, 0.5);
});

test('fieldSharesForDay: a solo day awards no share', () => {
  assert.deepEqual(fieldSharesForDay([{ key: 'a', total: 900 }]), {});
  assert.deepEqual(fieldSharesForDay([
    { key: 'a', total: 900 }, { key: 'b', total: null },
  ]), {});
  assert.deepEqual(fieldSharesForDay([]), {});
  assert.deepEqual(fieldSharesForDay(null), {});
});

// --- competitionRanksForDay ------------------------------------------------

test('competitionRanksForDay: distinct totals rank 1..N by total descending', () => {
  assert.deepEqual(competitionRanksForDay([
    { key: 'a', total: 700 },
    { key: 'b', total: 900 },
    { key: 'c', total: 500 },
  ]), { b: 1, a: 2, c: 3 });
});

test('competitionRanksForDay: ties take the top of their span, next rank skips', () => {
  // "1224": both tied players finished 2nd, and nobody finished 3rd.
  assert.deepEqual(competitionRanksForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: 700 },
    { key: 'c', total: 700 },
    { key: 'd', total: 500 },
  ]), { a: 1, b: 2, c: 2, d: 4 });
  // Tied for first: both finished 1st, unlike the fractional 1.5 of
  // finishPositionsForDay.
  assert.deepEqual(competitionRanksForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: 900 },
    { key: 'c', total: 400 },
  ]), { a: 1, b: 1, c: 3 });
});

test('competitionRanksForDay: same eligibility rules as fractional positions', () => {
  // Non-players are unranked, and a day with fewer than two actual players
  // awards no positions at all.
  assert.deepEqual(competitionRanksForDay([
    { key: 'a', total: 900 },
    { key: 'b', total: null },
    { key: 'c', total: 300 },
  ]), { a: 1, c: 2 });
  assert.deepEqual(competitionRanksForDay([{ key: 'a', total: 900 }]), {});
  assert.deepEqual(competitionRanksForDay([]), {});
  assert.deepEqual(competitionRanksForDay(null), {});
});

test('competitionRanksForDay: does not mutate the caller array', () => {
  const day = [{ key: 'a', total: 100 }, { key: 'b', total: 900 }];
  competitionRanksForDay(day);
  assert.deepEqual(day.map(e => e.key), ['a', 'b']);
});

// --- accumulateFinishPositions ---------------------------------------------

test('accumulateFinishPositions: averages the qualifying days only', () => {
  const days = [
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }],   // a 1st, b 2nd
    [{ key: 'a', total: 400 }, { key: 'b', total: 800 }],   // a 2nd, b 1st
    [{ key: 'a', total: 700 }, { key: 'b', total: 700 }],   // both 1.5
    [{ key: 'a', total: 650 }],                             // solo: excluded
  ];
  const out = accumulateFinishPositions(days);
  assert.equal(out.a.days, 3);
  assert.equal(out.b.days, 3);
  closeTo(out.a.avg, (1 + 2 + 1.5) / 3);
  closeTo(out.b.avg, (2 + 1 + 1.5) / 3);
  // Same three days as shares of the field beaten: won, lost, drew.
  closeTo(out.a.share, (1 + 0 + 0.5) / 3);
  closeTo(out.b.share, (0 + 1 + 0.5) / 3);
});

test('accumulateFinishPositions: the share is field-size proof, the average is not', () => {
  // Two days finishing dead last, one in a field of three and one in a field
  // of four. The raw average finish drifts to 3.5 purely because the second
  // field was bigger; the share stays at 0 because last is last.
  const out = accumulateFinishPositions([
    [{ key: 'a', total: 900 }, { key: 'b', total: 800 }, { key: 'z', total: 100 }],
    [{ key: 'a', total: 900 }, { key: 'b', total: 800 },
     { key: 'c', total: 700 }, { key: 'z', total: 100 }],
  ]);
  assert.equal(out.z.days, 2);
  closeTo(out.z.avg, 3.5);
  assert.equal(out.z.share, 0);
  // The player who won both is 100% both times, again regardless of N.
  closeTo(out.a.avg, 1);
  assert.equal(out.a.share, 1);
});

test('accumulateFinishPositions: a day you sat out is nobody else\'s problem', () => {
  const days = [
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }, { key: 'c', total: 100 }],
    [{ key: 'a', total: 900 }, { key: 'b', total: null }, { key: 'c', total: 100 }],
  ];
  const out = accumulateFinishPositions(days);
  assert.equal(out.b.days, 1);
  closeTo(out.b.avg, 2);
  closeTo(out.b.share, 0.5);
  // With b away, c is second on day two, so c averages (3 + 2) / 2.
  assert.equal(out.c.days, 2);
  closeTo(out.c.avg, 2.5);
  // c was last on both days though, so the share does not reward the smaller
  // field the way the raw position does.
  assert.equal(out.c.share, 0);
});

test('accumulateFinishPositions: counts bucket each day at the competition rank', () => {
  const days = [
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }],   // a 1st, b 2nd
    [{ key: 'a', total: 400 }, { key: 'b', total: 800 }],   // a 2nd, b 1st
    [{ key: 'a', total: 700 }, { key: 'b', total: 700 }],   // tied: both 1st
  ];
  const out = accumulateFinishPositions(days);
  assert.deepEqual(out.a.counts, { 1: 2, 2: 1 });
  assert.deepEqual(out.b.counts, { 1: 2, 2: 1 });
  // The tie counts as a 1st for both, while the fractional average still
  // carries the 1.5 - the two metrics legitimately disagree on tie days.
  closeTo(out.a.avg, (1 + 2 + 1.5) / 3);
});

test('accumulateFinishPositions: a parallel ISO array attributes each finish to its day', () => {
  const days = [
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }],   // a 1st, b 2nd
    [{ key: 'a', total: 400 }, { key: 'b', total: 800 }],   // a 2nd, b 1st
    [{ key: 'a', total: 700 }, { key: 'b', total: 700 }],   // tied: both 1st
  ];
  const out = accumulateFinishPositions(days, ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.deepEqual(out.a.dates, { 1: ['2026-08-01', '2026-08-03'], 2: ['2026-08-02'] });
  assert.deepEqual(out.b.dates, { 1: ['2026-08-02', '2026-08-03'], 2: ['2026-08-01'] });
});

test('accumulateFinishPositions: without ISO dates the counts stand alone', () => {
  const out = accumulateFinishPositions([
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }],
  ]);
  assert.deepEqual(out.a.dates, {});
  assert.deepEqual(out.a.counts, { 1: 1 });
});

test('accumulateFinishPositions: maxField tracks the biggest field each player saw', () => {
  const out = accumulateFinishPositions([
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }],
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }, { key: 'c', total: 100 }],
  ]);
  assert.equal(out.a.maxField, 3);
  assert.equal(out.b.maxField, 3);
  // c only ever competed in the three-player day.
  assert.equal(out.c.maxField, 3);
  assert.deepEqual(out.c.counts, { 3: 1 });
  // A zero-count position inside the range stays absent from counts - the
  // UI renders the gap from maxField, not from a stored zero.
  assert.equal('2' in out.c.counts, false);
});

test('accumulateFinishPositions: a player with no qualifying day is absent', () => {
  const out = accumulateFinishPositions([
    [{ key: 'a', total: 900 }, { key: 'b', total: 500 }],
    [{ key: 'c', total: 900 }],
  ]);
  assert.equal('c' in out, false);
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b']);
});

// --- avgPositionColor / avgPositionColors ----------------------------------

test('avgPositionColor: the ramp ends and midpoint are the app tone colors', () => {
  assert.equal(avgPositionColor(0), 'rgb(74, 222, 128)');
  assert.equal(avgPositionColor(0.5), 'rgb(250, 204, 21)');
  assert.equal(avgPositionColor(1), 'rgb(248, 113, 113)');
});

test('avgPositionColor: each half is a straight blend between its two anchors', () => {
  assert.equal(avgPositionColor(0.25), 'rgb(162, 213, 75)');
  assert.equal(avgPositionColor(0.75), 'rgb(249, 159, 67)');
  // Out-of-range input clamps rather than running off the end of the ramp.
  assert.equal(avgPositionColor(-2), avgPositionColor(0));
  assert.equal(avgPositionColor(9), avgPositionColor(1));
});

test('avgPositionColor: hue only ever walks green -> yellow -> red', () => {
  // The point of the ramp is that a reader sees one gradient, not a set of
  // unrelated colors, so hue must fall monotonically from green to red with
  // no detour through blue.
  const hueOf = (t) => {
    const [r, g, b] = avgPositionColor(t).match(/\d+/g).map(Number);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    const h = max === r ? (g - b) / (max - min)
            : max === g ? 2 + (b - r) / (max - min)
                        : 4 + (r - g) / (max - min);
    return ((h * 60) % 360 + 360) % 360;
  };
  let prev = hueOf(0);
  assert.ok(prev > 130 && prev < 150, `green end hue was ${prev}`);
  for (let i = 1; i <= 40; i++) {
    const h = hueOf(i / 40);
    assert.ok(h < prev, `hue rose at step ${i}: ${prev} -> ${h}`);
    prev = h;
  }
  assert.equal(prev, 0);
});

test('avgPositionColors: lowest input is green, highest is red, middles interpolate', () => {
  // The card feeds negated field shares, so the biggest share (1) arrives as
  // the smallest number and must take the green end.
  const out = avgPositionColors([-1, -0.75, -0.5, 0]);
  assert.equal(out[0], 'rgb(74, 222, 128)');
  assert.equal(out[3], 'rgb(248, 113, 113)');
  assert.equal(out[1], avgPositionColor(0.25));
  assert.equal(out[2], avgPositionColor(0.5));
});

test('avgPositionColors: rows without a figure keep their slot and stay null', () => {
  const out = avgPositionColors([-0.8, null, -0.2, undefined]);
  assert.deepEqual(out, ['rgb(74, 222, 128)', null, 'rgb(248, 113, 113)', null]);
});

test('avgPositionColors: nothing to compare against means no ramp at all', () => {
  // One player with a figure has no better or worse to be measured against,
  // and identical figures are not a ranking, so both stay neutral.
  assert.deepEqual(avgPositionColors([-0.5, null, null]), [null, null, null]);
  assert.deepEqual(avgPositionColors([-0.5, -0.5, -0.5]), [null, null, null]);
  assert.deepEqual(avgPositionColors([]), []);
});

test('accumulateFinishPositions: no history at all yields no records', () => {
  assert.deepEqual(accumulateFinishPositions([]), {});
  assert.deepEqual(accumulateFinishPositions(null), {});
  assert.deepEqual(accumulateFinishPositions([[], [{ key: 'a', total: 700 }]]), {});
});

// --- myAvgByContinent ------------------------------------------------------

// Stand-in for app.js's classifyContinent. The whole point of injecting the
// classifier is that stats.js never needs the real bounding boxes, so a crude
// longitude split is enough to exercise the bucketing.
const classifyStub = (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'Unknown';
  if (lng < -30) return 'North America';
  if (lng < 60) return 'Europe';
  return 'Asia';
};
// 5 cities, all in Europe unless overridden.
const euCities = () => [
  { lat: 48, lng: 2 }, { lat: 52, lng: 13 }, { lat: 41, lng: 12 },
  { lat: 55, lng: -3 }, { lat: 40, lng: -3 },
];
const geoGame = (date, rivalId, myScores, cities) =>
  ({ id: `${date}-${rivalId}`, rivalId, date, myScores, theirScores: [1, 1, 1, 1, 1], cities });

test('myAvgByContinent: one day logged against 3 rivals counts its rounds once', () => {
  // The trap: a multi-rival day is stored as one game record per rival, each
  // repeating the SAME myScores and the SAME cities. Counting every record
  // would triple the round count and leave the average untouched, so the
  // skew is invisible without this assertion.
  const scores = [80, 90, 100, 60, 70];
  const games = ['r1', 'r2', 'r3'].map(r => geoGame('2026-08-01', r, scores, euCities()));
  const out = myAvgByContinent(games, classifyStub);
  assert.equal(out.totalRounds, 5);
  assert.equal(out.days, 1);
  assert.deepEqual(out.rows, [{ continent: 'Europe', rounds: 5, myAvg: 80 }]);
});

test('myAvgByContinent: averages my raw round scores per continent', () => {
  const cities = [
    { lat: 48, lng: 2 }, { lat: 52, lng: 13 },      // Europe
    { lat: 40, lng: -74 }, { lat: 34, lng: -118 },  // North America
    { lat: 35, lng: 139 },                          // Asia
  ];
  const out = myAvgByContinent([geoGame('2026-08-01', 'r1', [90, 80, 60, 40, 100], cities)], classifyStub);
  assert.equal(out.totalRounds, 5);
  assert.deepEqual(out.rows, [
    { continent: 'Europe', rounds: 2, myAvg: 85 },
    { continent: 'North America', rounds: 2, myAvg: 50 },
    { continent: 'Asia', rounds: 1, myAvg: 100 },
  ]);
});

test('myAvgByContinent: chips sort by rounds desc, then continent name A-Z', () => {
  // Asia and North America tie on 2 rounds each; Europe leads on 6.
  const day1 = [
    { lat: 48, lng: 2 }, { lat: 52, lng: 13 },
    { lat: 35, lng: 139 }, { lat: 40, lng: -74 }, { lat: 34, lng: -118 },
  ];
  const day2 = [
    { lat: 48, lng: 2 }, { lat: 52, lng: 13 },
    { lat: 35, lng: 139 }, { lat: 48, lng: 2 }, { lat: 48, lng: 2 },
  ];
  const out = myAvgByContinent([
    geoGame('2026-08-01', 'r1', [50, 50, 50, 50, 50], day1),
    geoGame('2026-08-02', 'r1', [50, 50, 50, 50, 50], day2),
  ], classifyStub);
  assert.deepEqual(out.rows.map(r => [r.continent, r.rounds]), [
    ['Europe', 6], ['Asia', 2], ['North America', 2],
  ]);
});

test('myAvgByContinent: pasted games carry no coordinates and contribute nothing', () => {
  const out = myAvgByContinent([
    { id: 'a', rivalId: 'r1', date: '2026-08-01', myScores: [90, 90, 90, 90, 90], theirScores: [1, 1, 1, 1, 1] },
    { id: 'b', rivalId: 'r1', date: '2026-08-02', myScore: 700, theirScore: 600 },
    // A short cities array is corrupt geo, not a partial day.
    { id: 'c', rivalId: 'r1', date: '2026-08-03', myScores: [90, 90, 90, 90, 90], cities: [{ lat: 48, lng: 2 }] },
  ], classifyStub);
  assert.deepEqual(out, { rows: [], totalRounds: 0, days: 0 });
});

test('myAvgByContinent: rival-only days (my side absent) contribute nothing', () => {
  // Sync writes a game for a day the rival played and I did not. Counting it
  // would drag every continent average toward 0 with rounds I never played.
  const out = myAvgByContinent([
    { id: 'a', rivalId: 'r1', date: '2026-08-01', theirScores: [90, 90, 90, 90, 90], cities: euCities() },
    geoGame('2026-08-02', 'r1', [60, 60, 60, 60, 60], euCities()),
  ], classifyStub);
  assert.equal(out.days, 1);
  assert.deepEqual(out.rows, [{ continent: 'Europe', rounds: 5, myAvg: 60 }]);
});

test('myAvgByContinent: rounds with no usable coordinates are dropped, not bucketed', () => {
  const cities = [
    { lat: 48, lng: 2 }, { lat: 52, lng: 13 }, { lat: 41, lng: 12 },
    {}, { lat: 'nope', lng: 'nope' },
  ];
  const out = myAvgByContinent([geoGame('2026-08-01', 'r1', [90, 60, 90, 0, 0], cities)], classifyStub);
  assert.equal(out.totalRounds, 3);
  assert.deepEqual(out.rows, [{ continent: 'Europe', rounds: 3, myAvg: 80 }]);
  assert.equal(out.rows.some(r => r.continent === 'Unknown'), false);
});

test('myAvgByContinent: no games at all yields an empty band', () => {
  assert.deepEqual(myAvgByContinent([], classifyStub), { rows: [], totalRounds: 0, days: 0 });
  assert.deepEqual(myAvgByContinent(null, classifyStub), { rows: [], totalRounds: 0, days: 0 });
});

// --- compareNamesCI --------------------------------------------------------

test('compareNamesCI: sorts ABC regardless of case', () => {
  const names = ['Zoe', 'ann', 'Bob', 'charlie'];
  assert.deepEqual(names.slice().sort(compareNamesCI), ['ann', 'Bob', 'charlie', 'Zoe']);
  // A plain code-unit sort buries every lowercase name under the capitals,
  // which is exactly the ordering the rival lists must not fall back to.
  assert.deepEqual(names.slice().sort(), ['Bob', 'Zoe', 'ann', 'charlie']);
});

test('compareNamesCI: names differing only in case keep a stable order', () => {
  assert.ok(compareNamesCI('bob', 'Bob') !== 0);
  assert.equal(compareNamesCI('bob', 'Bob'), -compareNamesCI('Bob', 'bob'));
});

test('compareNamesCI: identical names compare equal, missing names sort first', () => {
  assert.equal(compareNamesCI('Ann', 'Ann'), 0);
  assert.ok(compareNamesCI(null, 'Ann') < 0);
  assert.ok(compareNamesCI(undefined, '') === 0);
});

// --- compareWinPctDesc -----------------------------------------------------

test('compareWinPctDesc: best win % first', () => {
  const recs = [
    { rivalId: 'a', decided: 4, winPct: 50 },
    { rivalId: 'b', decided: 3, winPct: 100 },
    { rivalId: 'c', decided: 5, winPct: 20 },
  ];
  assert.deepEqual(recs.slice().sort(compareWinPctDesc).map(r => r.rivalId), ['b', 'a', 'c']);
});

test('compareWinPctDesc: a record with nothing decided sorts below a real 0%', () => {
  const allTies = { rivalId: 'ties', decided: 0, winPct: 0 };
  const allLosses = { rivalId: 'losses', decided: 3, winPct: 0 };
  assert.ok(compareWinPctDesc(allTies, allLosses) > 0);
  assert.deepEqual([allTies, allLosses].sort(compareWinPctDesc).map(r => r.rivalId),
    ['losses', 'ties']);
});

test('compareWinPctDesc: equal win % is left to the caller tie-break', () => {
  assert.equal(compareWinPctDesc({ decided: 2, winPct: 50 }, { decided: 6, winPct: 50 }), 0);
});
