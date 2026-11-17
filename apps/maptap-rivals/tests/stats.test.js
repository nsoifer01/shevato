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
  SYNC_NOTE, mergeMapTapSync,
  resultOf, resultLoc, stdDev, average, streaks, linearTrend, projectNext,
  rivalryScoreFromGames,
  parseDateISO, isoWeekStart, isoWeekEnd, isoWeekId,
  monthId, monthStart, monthEnd, periodBounds, periodRecords,
  periodOutcomeVsRival, runningRivalPeriodRecords, periodTallyText,
  rankByScore, rankAccuracyForDay, accumulateRankAccuracy,
  preGameCutoffMs, isPreGameInstant, puzzleFingerprint, buildPredictionSnapshot,
  snapshotId, sanitizeSnapshots, canonicalSnapshots, validLatLng, allCitiesLocated,
  finishPositionsForDay, fieldSharesForDay, competitionRanksForDay,
  roundRanksForDay, podiumTier, accumulateFinishPositions,
  avgPositionColor, avgPositionColors,
  myAvgByContinent, myAvgByRound,
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

test('parseMapTapScore: "final" and "total" are accepted as the total keyword', () => {
  // The documented tolerance: MapTap has changed the wording of this line
  // before, so anything final/total-ish with or without a separator counts.
  assert.equal(parseMapTapScore('10 20 30 40 50\nfinal: 360').finalScore, 360);
  assert.equal(parseMapTapScore('10 20 30 40 50\nTotal = 360').finalScore, 360);
  assert.equal(parseMapTapScore('10 20 30 40 50\nFinal Score 360').finalScore, 360);
});

test('parseMapTapScore: a total keyword swallows its whole line, so a one-line paste fails', () => {
  // Pinning a real failure mode rather than an edge case: the total branch
  // `continue`s, so the round-line scan never sees a line that also matched
  // final/total. A share collapsed onto one line therefore parses as null and
  // the textarea shows its error state, even though every number is present.
  assert.equal(parseMapTapScore('May 10 95 89 91 9 64 Final score: 585'), null);
  // Split across lines, the same content parses.
  assert.deepEqual(parseMapTapScore('May 10\n95 89 91 9 64\nFinal score: 585').rounds,
    [95, 89, 91, 9, 64]);
});

test('parseMapTapScore: a share dated ahead of today belongs to LAST year (Dec 31 pasted in January)', () => {
  // Shares carry no year. Until 2026-08-22 this test pinned the old rule
  // (always the current year), which dated a "Dec 31" share pasted on Jan 1
  // a full year into the future (audit defect D14). The rule now: current
  // year unless that lands more than a day ahead of today, then last year.
  // Expectations are computed from the clock so the test holds on any day.
  const now = new Date();
  const year = now.getFullYear();
  const expectYear = (monthIdx, day) =>
    (new Date(year, monthIdx, day).getTime() - now.getTime() > 86400000) ? year - 1 : year;
  assert.equal(parseMapTapScore('Dec 31\n10 20 30 40 50').date, `${expectYear(11, 31)}-12-31`);
  assert.equal(parseMapTapScore('Jan 1\n10 20 30 40 50').date, `${expectYear(0, 1)}-01-01`);
  // Today itself is never pushed back a year.
  const m = now.toLocaleString('en-US', { month: 'short' });
  assert.equal(parseMapTapScore(`${m} ${now.getDate()}\n10 20 30 40 50`).date.slice(0, 4), String(year));
});

test('parseMapTapScore: a day that does not exist in its month is not a date ("Feb 30" used to roll to Mar 2)', () => {
  const r = parseMapTapScore('Feb 30\n10 20 30 40 50');
  assert.ok(r, 'the rounds still parse');
  assert.equal(r.date, null);
  assert.equal(parseMapTapScore('Apr 31\n10 20 30 40 50').date, null);
  assert.match(parseMapTapScore('Feb 28\n10 20 30 40 50').date, /-02-28$/);
});

test('weightedTotal / average / stdDev: a non-numeric slot counts as 0 and non-finite values are ignored (no NaN)', () => {
  // One imported record with myScores [null, "x", 50, 50, 50] used to turn
  // the dashboard "Avg score", every rival average and the leaderboard
  // rivalry column into a literal "NaN" (audit defect D4).
  assert.equal(weightedTotal([null, 'x', 50, 50, 50]), 50 * 2 + 50 * 3 + 50 * 3);
  assert.equal(getMyTotal({ myScores: [null, 'x', 50, 50, 50] }), 400);
  assert.equal(average([500, NaN, 700]), 600);
  assert.equal(average([NaN]), 0);
  assert.equal(stdDev([500, NaN, 500]), 0);
  assert.ok(Number.isFinite(stdDev([500, Infinity, 700, 900])));
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
// iOS 4.04+ day: rounds[] only: score + targetCity name, no coordinates.
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

// MapTap's own scorer (deriveDailyScoreFromRounds in maptap.gg's js/ui.js)
// keys every entry by its `round` (or iOS `roundNumber`) field, first entry
// wins per round, and gives up unless all five rounds are there. Reading the
// array by POSITION instead put an out-of-order day's scores (and cities) on
// the wrong rounds, weighted the daily total wrongly, accepted a day with a
// round missing and a duplicate in its place, and dropped a day whose array
// carried a repeated round MapTap itself scores.
const shuffled = (day, order) => ({ ...day, roundData: order.map((i) => day.roundData[i]) });
// The weighted total MapTap derives from the round numbers themselves.
const mapTapTotal = (arr) => {
  const seen = new Map();
  for (const r of arr) { const n = Number(r.round ?? r.roundNumber); if (n >= 1 && n <= 5 && !seen.has(n)) seen.set(n, Number(r.score)); }
  return [...seen].reduce((a, [n, sc]) => a + sc * [1, 1, 2, 3, 3][n - 1], 0);
};

test('mapTapHistoryToRounds: an out-of-order roundData day is read by round number, cities moving with their scores', () => {
  const day = shuffled(roundDataDay, [2, 0, 4, 1, 3]); // rounds 3,1,5,2,4
  const out = mapTapHistoryToRounds({ '2026-06-14': day })['2026-06-14'];
  assert.deepEqual(out.scores, [95, 80, 70, 90, 60]);
  assert.deepEqual(out.cities.map((c) => c.name), roundDataDay.roundData.map((r) => r.cityName));
  assert.equal(weightedTotal(out.scores), mapTapTotal(day.roundData));
});

test('mapTapHistoryToRounds: an out-of-order iOS rounds day is read by roundNumber', () => {
  const day = { ...iosRoundsDay, rounds: [4, 3, 2, 1, 0].map((i) => iosRoundsDay.rounds[i]) };
  const out = mapTapHistoryToRounds({ '2026-06-14': day })['2026-06-14'];
  assert.deepEqual(out.scores, [95, 95, 94, 98, 95]);
  assert.equal(out.cities[3].name, 'Bingen, Germany');
});

test('mapTapHistoryToRounds: a repeated round keeps the first entry, as MapTap scores it', () => {
  const dup = { ...roundDataDay.roundData[1], score: 10 };
  const day = { ...roundDataDay, roundData: [...roundDataDay.roundData.slice(0, 2), dup, ...roundDataDay.roundData.slice(2)] };
  const out = mapTapHistoryToRounds({ '2026-06-14': day })['2026-06-14'];
  assert.ok(out, 'a six-entry day MapTap can score is not dropped');
  assert.deepEqual(out.scores, [95, 80, 70, 90, 60]);
  assert.equal(weightedTotal(out.scores), mapTapTotal(day.roundData));
});

test('mapTapHistoryToRounds: a day missing a round, or a partial game, is rejected rather than misread', () => {
  const missing5 = { ...roundDataDay, roundData: [...roundDataDay.roundData.slice(0, 4), { ...roundDataDay.roundData[1], score: 10 }] };
  assert.equal(mapTapHistoryToRounds({ d: missing5 }).d, undefined);
  const partial = { ...roundDataDay, roundData: roundDataDay.roundData.slice(0, 4) };
  assert.equal(mapTapHistoryToRounds({ d: partial }).d, undefined);
});

test('mapTapHistoryToRounds: an array carrying no round numbers at all keeps its order', () => {
  const unnumbered = { ...roundDataDay, roundData: roundDataDay.roundData.map(({ round, ...r }) => r) };
  assert.deepEqual(mapTapHistoryToRounds({ d: unnumbered }).d.scores, [95, 80, 70, 90, 60]);
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
  // does) behaves exactly as it did before (including being dropped when
  // malformed), even if a valid `rounds` sits alongside it. This keeps non-iOS
  // players byte-for-byte unchanged.
  const wrongLen  = { roundData: roundDataDay.roundData.slice(0, 4), rounds: iosRoundsDay.rounds };
  const outOfRange = { roundData: roundDataDay.roundData.map((r, i) => i === 0 ? { ...r, score: 101 } : r), rounds: iosRoundsDay.rounds };
  assert.deepEqual(mapTapHistoryToRounds({ d: wrongLen }), {});
  assert.deepEqual(mapTapHistoryToRounds({ d: outOfRange }), {});
});

// --- mergeMapTapSync -------------------------------------------------------

// One day's rounds in the shape mapTapHistoryToRounds emits, plus a caller
// with every argument defaulted so each test only names what it is about.
const city = (n) => ({ lat: n, lng: n, name: `C${n}` });
const day = (scores) => ({ scores, cities: [city(1), city(2), city(3), city(4), city(5)] });
const merge = (over) => mergeMapTapSync({
  rivalId: 'r1', mineByDate: {}, theirsByDate: {}, existingGames: [],
  makeId: (() => { let n = 0; return () => `id${++n}`; })(), now: 1000,
  ...over,
});

test('mergeMapTapSync: a day only I played becomes a me-only row', () => {
  const out = merge({ mineByDate: { '2026-08-20': day([90, 90, 90, 90, 90]) } });
  assert.equal(out.added, 1);
  const g = out.newGames[0];
  assert.deepEqual(g.myScores, [90, 90, 90, 90, 90]);
  assert.equal(g.myScore, weightedTotal([90, 90, 90, 90, 90]));
  // No rival side at all, not a zero, which would read as a 900-0 blowout.
  assert.equal('theirScores' in g, false);
  assert.equal('theirScore' in g, false);
  assert.equal(iPlayed(g), true);
  assert.equal(theyPlayed(g), false);
  assert.equal(resultOf(g), null);
  // The puzzle geometry comes off my own history, so the continent
  // breakdown and the predictor see the day.
  assert.equal(g.cities.length, N_LOCS);
  assert.equal(g.note, SYNC_NOTE);
});

test('mergeMapTapSync: a day only they played still becomes a rival-only row', () => {
  const out = merge({ theirsByDate: { '2026-08-20': day([80, 80, 80, 80, 80]) } });
  assert.equal(out.added, 1);
  const g = out.newGames[0];
  assert.equal('myScores' in g, false);
  assert.deepEqual(g.theirScores, [80, 80, 80, 80, 80]);
  assert.equal(theyPlayed(g), true);
  assert.equal(iPlayed(g), false);
});

test('mergeMapTapSync: a shared day becomes one full head-to-head row', () => {
  const out = merge({
    mineByDate:   { '2026-08-20': day([90, 90, 90, 90, 90]) },
    theirsByDate: { '2026-08-20': day([80, 80, 80, 80, 80]) },
  });
  assert.equal(out.added, 1);
  assert.equal(bothPlayed(out.newGames[0]), true);
  assert.equal(resultOf(out.newGames[0]), 'W');
});

test('mergeMapTapSync: the walk covers the union of both histories, in date order', () => {
  const out = merge({
    mineByDate:   { '2026-08-20': day([90, 90, 90, 90, 90]), '2026-08-22': day([70, 70, 70, 70, 70]) },
    theirsByDate: { '2026-08-21': day([80, 80, 80, 80, 80]), '2026-08-22': day([60, 60, 60, 60, 60]) },
  });
  assert.equal(out.added, 3);
  assert.deepEqual(out.newGames.map(g => g.date), ['2026-08-20', '2026-08-21', '2026-08-22']);
  // createdAt is spread so two rows written in the same millisecond keep
  // the walk's order.
  assert.deepEqual(out.newGames.map(g => g.createdAt), [1000, 1001, 1002]);
});

test('mergeMapTapSync: a me-only row upgrades in place once the rival plays that day', () => {
  const meOnly = {
    id: 'g1', rivalId: 'r1', date: '2026-08-20', note: SYNC_NOTE,
    myScores: [90, 90, 90, 90, 90], myScore: 900, cities: day([]).cities, createdAt: 1,
  };
  const out = merge({
    existingGames: [meOnly],
    mineByDate:   { '2026-08-20': day([90, 90, 90, 90, 90]) },
    theirsByDate: { '2026-08-20': day([80, 80, 80, 80, 80]) },
  });
  assert.equal(out.added, 0);
  assert.equal(out.updated, 1);
  assert.deepEqual(meOnly.theirScores, [80, 80, 80, 80, 80]);
  assert.equal(meOnly.theirScore, weightedTotal([80, 80, 80, 80, 80]));
  assert.equal(resultOf(meOnly), 'W');
});

test('mergeMapTapSync: a rival-only row still upgrades once I play that day', () => {
  const rivalOnlyRow = {
    id: 'g1', rivalId: 'r1', date: '2026-08-20', note: SYNC_NOTE,
    theirScores: [80, 80, 80, 80, 80], theirScore: 800, cities: day([]).cities, createdAt: 1,
  };
  const out = merge({
    existingGames: [rivalOnlyRow],
    mineByDate:   { '2026-08-20': day([90, 90, 90, 90, 90]) },
    theirsByDate: { '2026-08-20': day([80, 80, 80, 80, 80]) },
  });
  assert.equal(out.updated, 1);
  assert.deepEqual(rivalOnlyRow.myScores, [90, 90, 90, 90, 90]);
  assert.equal(bothPlayed(rivalOnlyRow), true);
});

test('mergeMapTapSync: a stored side is never cleared by a pull that lacks it', () => {
  // MapTap gains days, it never loses them: a history that no longer reports
  // my side (a re-pointed profile, a partial payload) must not downgrade a
  // full head-to-head row back to rival-only, or vice versa.
  const full = {
    id: 'g1', rivalId: 'r1', date: '2026-08-20', note: SYNC_NOTE,
    myScores: [90, 90, 90, 90, 90], myScore: 900,
    theirScores: [80, 80, 80, 80, 80], theirScore: 800,
    cities: day([]).cities, createdAt: 1,
  };
  const out = merge({ existingGames: [full], theirsByDate: { '2026-08-20': day([80, 80, 80, 80, 80]) } });
  assert.equal(out.updated, 0);
  assert.deepEqual(full.myScores, [90, 90, 90, 90, 90]);

  const out2 = merge({ existingGames: [full], mineByDate: { '2026-08-20': day([90, 90, 90, 90, 90]) } });
  assert.equal(out2.updated, 0);
  assert.deepEqual(full.theirScores, [80, 80, 80, 80, 80]);
});

test('mergeMapTapSync: rows the user typed keep their scores but still get cities backfilled', () => {
  const manual = {
    id: 'g1', rivalId: 'r1', date: '2026-08-20', note: 'typed it myself',
    myScores: [10, 10, 10, 10, 10], myScore: 100, createdAt: 1,
  };
  const out = merge({ existingGames: [manual], mineByDate: { '2026-08-20': day([90, 90, 90, 90, 90]) } });
  assert.equal(out.backfilled, 1);
  assert.equal(out.updated, 0);
  assert.deepEqual(manual.myScores, [10, 10, 10, 10, 10]);
  assert.equal(manual.cities.length, N_LOCS);
});

test('mergeMapTapSync: only this rival\'s rows are considered', () => {
  const otherRival = {
    id: 'g1', rivalId: 'r2', date: '2026-08-20', note: SYNC_NOTE,
    myScores: [90, 90, 90, 90, 90], myScore: 900, cities: day([]).cities, createdAt: 1,
  };
  const out = merge({ existingGames: [otherRival], mineByDate: { '2026-08-20': day([90, 90, 90, 90, 90]) } });
  // r2's row is not r1's day: r1 gets its own me-only row.
  assert.equal(out.added, 1);
  assert.equal(out.newGames[0].rivalId, 'r1');
});

test('mergeMapTapSync: a "__proto__" day is data, and merging pollutes nothing', () => {
  const mine = JSON.parse('{"__proto__":{"scores":[90,90,90,90,90],"cities":[]}}');
  const out = merge({ mineByDate: mine });
  assert.equal(out.added, 1);
  assert.equal(out.newGames[0].date, '__proto__');
  // No usable geometry on that entry, so no stub cities array is stored.
  assert.equal('cities' in out.newGames[0], false);
  assert.equal(({}).scores, undefined);
});

test('mergeMapTapSync: nothing to pull reports three zeroes and no rows', () => {
  const out = merge({});
  assert.deepEqual(out, { newGames: [], added: 0, updated: 0, backfilled: 0 });
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

// --- rankAccuracyForDay / accumulateRankAccuracy ---------------------------
// Oracles below never call rankByScore or competitionRanksForDay: the
// predicted slot is worked out by hand from the totals and names, the random
// baseline by enumerating every possible order, and pairwise accuracy pair by
// pair from the totals.

// Every permutation of [0..n-1].
function permutations(n) {
  if (n === 1) return [[0]];
  const out = [];
  for (const p of permutations(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}
// Oracle: share of all N! orders in which `key` lands in a slot no other
// player with a strictly higher total needs and no lower one takes, i.e.
// inside the span of slots its tied group occupies.
function randomHitRateOracle(field, key) {
  const me = field.find(e => e.key === key);
  const above = field.filter(e => e.actualTotal > me.actualTotal).length;
  const tied = field.filter(e => e.actualTotal === me.actualTotal).length;
  const perms = permutations(field.length);
  let hits = 0;
  for (const perm of perms) {
    const slot = perm.indexOf(field.indexOf(me)) + 1;
    if (slot > above && slot <= above + tied) hits++;
  }
  return hits / perms.length;
}
// Oracle: the predicted order compared pair by pair, ties in the predicted
// total broken by name exactly as the card lists them.
function pairwiseOracle(field, key) {
  const me = field.find(e => e.key === key);
  const ahead = (a, b) => a.predictedTotal > b.predictedTotal ||
    (a.predictedTotal === b.predictedTotal && a.name.localeCompare(b.name) < 0);
  let right = 0, pairs = 0;
  for (const o of field) {
    if (o === me || o.actualTotal === me.actualTotal) continue;
    pairs++;
    if (ahead(me, o) === (me.actualTotal > o.actualTotal)) right++;
  }
  return { right, pairs };
}

test('rankAccuracyForDay: a hit is finishing in the predicted place', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 850 },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
  ];
  // Predicted a, b, c. Actual b (850), a (800), c (400): only c held its spot.
  const r = rankAccuracyForDay(day);
  assert.deepEqual({ a: r.a.hit, b: r.b.hit, c: r.c.hit }, { a: false, b: false, c: true });
  for (const k of ['a', 'b', 'c']) closeTo(r[k].chance, 1 / 3);
  // a-b wrong, a-c right, b-c right.
  assert.deepEqual([r.a.pairsRight, r.a.pairs, r.b.pairsRight, r.b.pairs, r.c.pairsRight, r.c.pairs],
    [1, 2, 1, 2, 2, 2]);
});

test('rankAccuracyForDay: players tied on the day both hit when predicted into the tied places', () => {
  // Tied for 1st (competition rank 1 and 1), predicted 1st and 2nd. Under
  // strict competition-rank equality Zed, predicted 2nd but ranked 1st,
  // would miss; the tie-span rule credits both, and the outcome no longer
  // depends on which name sorts first.
  const day = [
    { key: 'z', name: 'Zed', predictedTotal: 700, actualTotal: 600 },
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 600 },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
  ];
  const r = rankAccuracyForDay(day);
  assert.deepEqual([r.a.hit, r.z.hit, r.c.hit], [true, true, true]);
  closeTo(r.a.chance, 2 / 3);
  closeTo(r.c.chance, 1 / 3);
  // The tied pair has no right answer and is not counted.
  assert.deepEqual([r.a.pairs, r.z.pairs, r.c.pairs], [1, 1, 2]);
  // Renaming so the other player sorts first changes nothing.
  const renamed = day.map(e => ({ ...e, name: e.key === 'z' ? 'Aaa' : e.name }));
  assert.deepEqual(rankAccuracyForDay(renamed), r);
});

test('rankAccuracyForDay: a player predicted outside the tied places still misses', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 600 },
    { key: 'b', name: 'Bob', predictedTotal: 800, actualTotal: 900 },
    { key: 'c', name: 'Cid', predictedTotal: 700, actualTotal: 600 },
  ];
  // Actual: Bob 1st, Ann and Cid tied over places 2-3. Predicted Ann 1st.
  const r = rankAccuracyForDay(day);
  assert.deepEqual([r.a.hit, r.b.hit, r.c.hit], [false, false, true]);
});

test('rankAccuracyForDay: matches the enumeration and pair oracles on random fields of 2 to 6 players', () => {
  let seed = 20261116;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const names = ['Ann', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay'];
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + rnd(5);
    // Totals from a tiny range so ties in both orders are common.
    const field = names.slice(0, n).map((name, i) => ({
      key: 'k' + i, name, predictedTotal: 800 + 10 * rnd(3), actualTotal: 800 + 10 * rnd(3),
    }));
    const r = rankAccuracyForDay(field);
    assert.equal(Object.keys(r).length, n);
    for (const e of field) {
      closeTo(r[e.key].chance, randomHitRateOracle(field, e.key));
      const pw = pairwiseOracle(field, e.key);
      assert.deepEqual([r[e.key].pairsRight, r[e.key].pairs], [pw.right, pw.pairs]);
    }
  }
});

test('rankAccuracyForDay: a player with no prediction is invisible to the ranking', () => {
  const day = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 850 },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
    // Newcomer with a synced score but not enough history to be predicted.
    { key: 'd', name: 'Dee', predictedTotal: null, actualTotal: 1000 },
  ];
  const r = rankAccuracyForDay(day);
  assert.equal('d' in r, false);
  // Dee's 1000 must not push everyone down a place.
  assert.deepEqual([r.a.hit, r.b.hit, r.c.hit], [false, false, true]);
});

test('rankAccuracyForDay: an absent player does not shift the places of those who played', () => {
  const withAbsentee = [
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    // Predicted to finish second but never played: holds no slot.
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
    { key: 'c', name: 'Cid', predictedTotal: 500, actualTotal: 400 },
    { key: 'd', name: 'Dee', predictedTotal: 300, actualTotal: 200 },
  ];
  const without = withAbsentee.filter(e => e.key !== 'b');
  const r = rankAccuracyForDay(withAbsentee);
  assert.deepEqual(Object.keys(r).sort(), ['a', 'c', 'd']);
  assert.ok(r.a.hit && r.c.hit && r.d.hit);
  assert.deepEqual(r, rankAccuracyForDay(without));
});

test('rankAccuracyForDay: a lone player is not a ranking and is not eligible', () => {
  // Before 2026-11-16 a field of one counted as an automatic hit.
  assert.deepEqual(rankAccuracyForDay([{ key: 'a', name: 'Ann', predictedTotal: 400, actualTotal: 900 }]), {});
  assert.deepEqual(rankAccuracyForDay([
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
  ]), {});
});

test('rankAccuracyForDay: a day nobody played produces no eligible players', () => {
  assert.deepEqual(rankAccuracyForDay([
    { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: null },
    { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
  ]), {});
  assert.deepEqual(rankAccuracyForDay([]), {});
});

test('accumulateRankAccuracy: sums hits, eligible days, chance and pairs per player', () => {
  const days = [
    [ // both hold their spots
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
      { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 600 },
    ],
    [ // Bob upsets Ann
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 500 },
      { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: 950 },
    ],
    [ // Ann alone: a field of one counts for nobody
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 800 },
      { key: 'b', name: 'Bob', predictedTotal: 700, actualTotal: null },
    ],
    [ // three players, Cid and Ann tie for 2nd
      { key: 'a', name: 'Ann', predictedTotal: 900, actualTotal: 700 },
      { key: 'b', name: 'Bob', predictedTotal: 800, actualTotal: 900 },
      { key: 'c', name: 'Cid', predictedTotal: 600, actualTotal: 700 },
    ],
  ];
  const r = accumulateRankAccuracy(days);
  assert.deepEqual(Object.keys(r).sort(), ['a', 'b', 'c']);
  assert.deepEqual({ ...r.a, chance: 0 }, { hits: 1, eligible: 3, chance: 0, pairsRight: 1, pairs: 3 });
  closeTo(r.a.chance, 0.5 + 0.5 + 2 / 3);
  // Bob: right on day 1, wrong on day 2; day 4 wrong against Ann, right against Cid.
  assert.deepEqual({ ...r.b, chance: 0 }, { hits: 1, eligible: 3, chance: 0, pairsRight: 2, pairs: 4 });
  closeTo(r.b.chance, 0.5 + 0.5 + 1 / 3);
  assert.deepEqual({ ...r.c, chance: 0 }, { hits: 1, eligible: 1, chance: 0, pairsRight: 1, pairs: 1 });
  closeTo(r.c.chance, 2 / 3);
});

test('accumulateRankAccuracy: no history at all yields no records (never 0/0)', () => {
  assert.deepEqual(accumulateRankAccuracy([]), {});
  assert.deepEqual(accumulateRankAccuracy(null), {});
  assert.deepEqual(accumulateRankAccuracy([[{ key: 'a', name: 'Ann', predictedTotal: null, actualTotal: 800 }], []]), {});
});

//
// The per-player accumulators key by rival id straight from storage. Ids the
// app generates (uid(), js/app.js:191) are safe, but importData (js/app.js)
// assigns `state.rivals` / `state.games` verbatim from a user-supplied backup
// JSON with no id validation, so '__proto__' is reachable through the
// Export / import feature. Fixed 2026-08-15: every such accumulator builds in
// a Map and returns via Object.fromEntries, so any string is a safe key.

test('rankAccuracyForDay: a rival id of "__proto__" gets a record like anyone else',
  () => {
    // Regression test for the fixed defect (2026-08-15): the accumulators
    // build in a Map and return through Object.fromEntries, which defines
    // own data properties, so '__proto__' can no longer hit the
    // Object.prototype setter and vanish from the Spot-on figures.
    const day = [
      { key: '__proto__', name: 'Imported', predictedTotal: 900, actualTotal: 900 },
      { key: 'r1', name: 'Bea', predictedTotal: 100, actualTotal: 100 },
    ];
    const hits = rankAccuracyForDay(day);
    assert.deepEqual(Object.keys(hits).sort(), ['__proto__', 'r1']);
    assert.equal(hits['__proto__'].hit, true);
    assert.equal(hits.r1.hit, true);
  });

test('accumulateFinishPositions: a rival id of "__proto__" does not corrupt the other players',
  () => {
    // Regression test for the fixed defect (2026-08-15): before the
    // Map + Object.fromEntries accumulators, out['__proto__'] = <object> set
    // the accumulator's prototype, dropping the player from Object.keys and
    // collapsing the day's field size to 1, which sent every other player's
    // share (n - pos) / (n - 1) to a divide by zero.
    const out = accumulateFinishPositions(
      [[{ key: '__proto__', total: 900 }, { key: 'r1', total: 100 }]],
      ['2026-08-01'],
    );
    assert.deepEqual(Object.keys(out).sort(), ['__proto__', 'r1']);
    // Second of two is a 0% share and a 2-player field, whoever the winner was.
    assert.equal(out.r1.share, 0);
    assert.equal(out.r1.maxField, 2);
    assert.deepEqual(out.r1.counts, { 2: 1 });
    assert.deepEqual(out.r1.dates, { 2: ['2026-08-01'] });
  });

// ===========================================================================
// 2026-08-22 quality pass: local calendar dates, eligibility, import validation
// ===========================================================================
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const S = require('../js/stats.js');

test('localDateISO / todayISO: read the LOCAL calendar components', () => {
  assert.equal(S.localDateISO(new Date(2026, 7, 22, 0, 5)), '2026-08-22');
  assert.equal(S.localDateISO(new Date(2026, 7, 22, 23, 59)), '2026-08-22');
  assert.equal(S.localDateISO(new Date('nope')), null);
  assert.equal(S.todayISO(new Date(2026, 0, 1, 0, 0, 1)), '2026-01-01');
});

test('addDaysISO: crosses month, year and leap-day boundaries, timezone-free', () => {
  assert.equal(S.addDaysISO('2026-08-31', 1), '2026-09-01');
  assert.equal(S.addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.equal(S.addDaysISO('2027-01-01', -1), '2026-12-31');
  assert.equal(S.addDaysISO('2024-02-28', 1), '2024-02-29');
  assert.equal(S.addDaysISO('2024-02-29', 1), '2024-03-01');
  assert.equal(S.addDaysISO('2026-02-28', 1), '2026-03-01');
  assert.equal(S.addDaysISO('2026-08-22', 0), '2026-08-22');
  assert.equal(S.addDaysISO('2026-08-22', -555), '2025-02-13');
  assert.equal(S.addDaysISO('2026-02-30', 1), null);
  assert.equal(S.addDaysISO('2026-08-22', NaN), null);
});

test('daysBetweenISO / dayOfWeekISO: timezone-free calendar arithmetic', () => {
  assert.equal(S.daysBetweenISO('2026-08-20', '2026-08-22'), 2);
  assert.equal(S.daysBetweenISO('2026-08-22', '2026-08-20'), -2);
  assert.equal(S.daysBetweenISO('2025-12-31', '2026-01-01'), 1);
  assert.equal(S.daysBetweenISO('x', '2026-01-01'), null);
  assert.equal(S.dayOfWeekISO('2026-08-22'), 6); // Saturday
  assert.equal(S.dayOfWeekISO('2026-08-16'), 0); // Sunday
  assert.equal(S.dayOfWeekISO('2026-08-17'), 1); // Monday
  assert.equal(S.dayOfWeekISO('junk'), null);
});

test('formatDate: a day string, a datetime, a Date, an epoch number and junk', () => {
  assert.equal(S.formatDate('2026-08-22', 'short'), 'Aug 22');
  assert.equal(S.formatDate('2026-08-22', 'medium'), 'Aug 22, 2026');
  assert.equal(S.formatDate('2026-08-22', 'long'), 'Sat, Aug 22, 2026');
  assert.equal(S.formatDate('2026-08-01', 'month'), 'August 2026');
  assert.equal(S.formatDate('2026-08-22'), 'Aug 22, 2026');
  // The real persisted shapes that used to render '' (profile verifiedAt,
  // MapTap joinDate): a datetime is shown as the local day it falls on.
  const local = new Date(2026, 7, 22, 12, 0, 0);
  assert.equal(S.formatDate(local.toISOString(), 'medium'), 'Aug 22, 2026');
  assert.equal(S.formatDate('2025-03-02T10:00:00.000Z', 'short').length > 0, true);
  assert.equal(S.formatDate(local, 'medium'), 'Aug 22, 2026');
  assert.equal(S.formatDate(local.getTime(), 'medium'), 'Aug 22, 2026');
  for (const bad of ['', null, undefined, 'junk', '2026-08', '2026-02-30', NaN, {}, new Date('x')]) {
    assert.equal(S.formatDate(bad, 'medium'), '', `junk ${String(bad)}`);
  }
});

test('calendarDayOf: the local day an instant falls on', () => {
  const local = new Date(2026, 7, 22, 23, 30, 0);
  assert.equal(S.calendarDayOf(local.toISOString()), '2026-08-22');
  assert.equal(S.calendarDayOf('2026-08-22'), '2026-08-22');
  assert.equal(S.calendarDayOf('junk'), null);
});

// The contract that matters: run the helpers in child processes pinned to
// four zones (a US one, UTC, a UTC+2 one and a UTC+12 one) and require the
// same local day everywhere. The pre-fix code path (toISOString on a local
// midnight) is run alongside to prove the zones would have disagreed.
test('local calendar dates hold under positive UTC offsets (child processes per TZ)', () => {
  const script = `
    const S = require(${JSON.stringify(path.join(__dirname, '..', 'js', 'stats.js'))});
    const midnight = new Date(2026, 7, 22, 0, 0, 0);      // local midnight Aug 22
    const lateNight = new Date(2026, 7, 22, 23, 45, 0);   // local 23:45 Aug 22
    const nye = new Date(2026, 11, 31, 0, 30, 0);         // local Dec 31 00:30
    const leap = new Date(2024, 1, 29, 0, 10, 0);         // local Feb 29 00:10
    process.stdout.write(JSON.stringify({
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: midnight.getTimezoneOffset(),
      today: S.todayISO(midnight),
      late: S.todayISO(lateNight),
      nye: S.todayISO(nye),
      leap: S.todayISO(leap),
      legacy: midnight.toISOString().slice(0, 10),
      plus1: S.addDaysISO(S.todayISO(midnight), 1),
      fmtInstant: S.formatDate(midnight.toISOString(), 'short'),
      fmtDay: S.formatDate('2026-08-22', 'short'),
    }));`;
  const results = {};
  for (const tz of ['America/Chicago', 'UTC', 'Europe/Berlin', 'Pacific/Auckland']) {
    const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    results[tz] = JSON.parse(out);
  }
  for (const [tz, r] of Object.entries(results)) {
    assert.equal(r.today, '2026-08-22', `${tz}: todayISO at local midnight`);
    assert.equal(r.late, '2026-08-22', `${tz}: todayISO at local 23:45`);
    assert.equal(r.nye, '2026-12-31', `${tz}: year boundary`);
    assert.equal(r.leap, '2024-02-29', `${tz}: leap day`);
    assert.equal(r.plus1, '2026-08-23', `${tz}: addDaysISO`);
    assert.equal(r.fmtInstant, 'Aug 22', `${tz}: datetime formats as its local day`);
    assert.equal(r.fmtDay, 'Aug 22', `${tz}: day string formats as itself`);
  }
  // Proof the zones differ in the way the old code depended on.
  assert.equal(results['Europe/Berlin'].legacy, '2026-08-21');
  assert.equal(results['Pacific/Auckland'].legacy, '2026-08-21');
  assert.equal(results['America/Chicago'].legacy, '2026-08-22');
});

test('parityOutlook: the number is FUTURE wins needed, not halved historical flips', () => {
  // The reported regression: 26W/128L/1T showed "51 flipped results", which is
  // ceil(102/2) - how many PAST losses would have to be rewritten. A player
  // reads it as "win 51 more", which is false. Each future win closes the gap
  // by one, so the honest answer is the full 102.
  const behind = S.parityOutlook({ wins: 26, losses: 128, ties: 1 });
  assert.equal(behind.state, 'behind');
  assert.equal(behind.winsNeeded, 102);
  assert.equal(behind.headline, 'Need 102 more wins to even the record');
  assert.equal(behind.sub, 'Current record: 26W · 128L · 1T');
  assert.equal(behind.title, 'Path to parity');
  assert.equal(behind.tone, 'is-bad');
  // Never the old halved figure, under any deficit bigger than one.
  for (const [w, l] of [[26, 128], [0, 7], [3, 10], [50, 60]]) {
    const o = S.parityOutlook({ wins: w, losses: l });
    const halved = Math.ceil((l - w) / 2);
    assert.equal(o.winsNeeded, l - w, `${w}W/${l}L`);
    assert.notEqual(o.winsNeeded, halved, `${w}W/${l}L must not report the halved ${halved}`);
  }
});

test('parityOutlook: a one-game deficit asks for one more win, in the singular', () => {
  const o = S.parityOutlook({ wins: 9, losses: 10 });
  assert.equal(o.winsNeeded, 1);
  assert.equal(o.headline, 'Need 1 more win to even the record');
  assert.equal(o.sub, 'Current record: 9W · 10L');
});

test('parityOutlook: an even record says so instead of asking for wins', () => {
  const o = S.parityOutlook({ wins: 64, losses: 64, ties: 3 });
  assert.equal(o.state, 'even');
  assert.equal(o.winsNeeded, 0);
  assert.equal(o.title, 'Record balance');
  assert.equal(o.headline, 'The record is even');
  assert.equal(o.sub, 'Current record: 64W · 64L · 3T · win your next to go ahead');
  assert.equal(o.tone, '');
  // A brand-new player is even at 0-0, but "the record is even" would be odd.
  const fresh = S.parityOutlook({ wins: 0, losses: 0, ties: 0 });
  assert.equal(fresh.state, 'even');
  assert.equal(fresh.headline, 'No decided games yet');
  assert.equal(fresh.sub, 'Win your first game to go ahead');
});

test('parityOutlook: ahead reports the lead, never a negative wins-needed', () => {
  const o = S.parityOutlook({ wins: 12, losses: 5, ties: 2 });
  assert.equal(o.state, 'ahead');
  assert.equal(o.winsNeeded, 0);
  assert.equal(o.margin, 7);
  assert.equal(o.headline, 'Ahead by 7 wins');
  assert.equal(o.sub, 'Current record: 12W · 5L · 2T');
  assert.equal(o.tone, 'is-good');
  assert.equal(S.parityOutlook({ wins: 5, losses: 4 }).headline, 'Ahead by 1 win');
  // No record can ever ask for a negative or fractional number of wins.
  for (let w = 0; w <= 20; w++) {
    for (let l = 0; l <= 20; l++) {
      const p = S.parityOutlook({ wins: w, losses: l, ties: 2 });
      assert.ok(Number.isInteger(p.winsNeeded) && p.winsNeeded >= 0, `${w}W/${l}L`);
      assert.equal(p.winsNeeded, Math.max(0, l - w));
      // Winning exactly that many more games really does even the record.
      assert.equal(w + p.winsNeeded, Math.max(w, l));
    }
  }
});

test('parityOutlook: ties never move the parity distance, and junk records do not crash it', () => {
  const base = S.parityOutlook({ wins: 4, losses: 9, ties: 0 });
  for (const ties of [1, 5, 100]) {
    const withTies = S.parityOutlook({ wins: 4, losses: 9, ties });
    assert.equal(withTies.winsNeeded, base.winsNeeded, `ties ${ties} must not change the distance`);
    assert.match(withTies.sub, new RegExp(`· ${ties}T`));
  }
  // A record with no ties omits the T segment rather than printing "0T".
  assert.equal(base.sub, 'Current record: 4W · 9L');
  for (const junk of [null, undefined, {}, { wins: NaN, losses: 'x', ties: -3 }, { wins: -5, losses: -2 }]) {
    const o = S.parityOutlook(junk);
    assert.equal(o.state, 'even');
    assert.equal(o.winsNeeded, 0);
    assert.equal(o.headline, 'No decided games yet');
  }
  // Fractional counts are floored, never rendered as decimals.
  assert.equal(S.parityOutlook({ wins: 1.9, losses: 4.7 }).headline, 'Need 3 more wins to even the record');
});

test('countNoun: singular / plural / custom plural', () => {
  assert.equal(S.countNoun(1, 'game'), '1 game');
  assert.equal(S.countNoun(0, 'game'), '0 games');
  assert.equal(S.countNoun(3, 'day'), '3 days');
  assert.equal(S.countNoun(2, 'rival', 'rivals'), '2 rivals');
  assert.equal(S.countNoun(NaN, 'game'), '0 games');
});

test('parseMapTapScore: exposes dateParts and refuses Feb 29 in a common year instead of rolling to Mar 1', () => {
  const p = S.parseMapTapScore('Aug 10\n95 89 91 9 64');
  assert.deepEqual(p.dateParts, { monthIdx: 7, day: 10 });
  const year = new Date().getFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const feb = S.parseMapTapScore('February 29\n1 2 3 4 5');
  assert.deepEqual(feb.dateParts, { monthIdx: 1, day: 29 });
  assert.equal(feb.date, leap ? `${year}-02-29` : null);
  assert.equal(S.parseMapTapScore('1 2 3 4 5').dateParts, null);
});

// ---- eligibility ----
const ELIG = [
  { id: 'a', rivalId: 'r1', date: '2026-08-10', myScores: [80, 80, 80, 80, 80], theirScores: [70, 70, 70, 70, 70] },
  { id: 'b', rivalId: 'r2', date: '2026-08-10', myScores: [80, 80, 80, 80, 80], theirScores: [90, 90, 90, 90, 90] },
  { id: 'c', rivalId: 'r1', date: '2026-08-11', myScore: 500, theirScore: 650 },
  { id: 'd', rivalId: 'r2', date: '2026-08-12', theirScores: [40, 40, 40, 40, 40] },           // rival-only
  { id: 'e', rivalId: 'gone', date: '2026-08-13', myScores: [10, 10, 10, 10, 10], theirScores: [90, 90, 90, 90, 90] }, // orphan
  { id: 'f', rivalId: 'r1', date: 'not-a-date', myScore: 900, theirScore: 100 },
  null, 42, { id: 'g', date: '2026-08-14', myScore: 1, theirScore: 2 },
];

test('eligibleH2HGames: both sides played, live rival, valid date, real object', () => {
  assert.deepEqual(S.eligibleH2HGames(ELIG, ['r1', 'r2']).map(g => g.id), ['a', 'b', 'c']);
  assert.deepEqual(S.eligibleH2HGames(ELIG, new Set(['r1'])).map(g => g.id), ['a', 'c']);
});

test('eligibleH2HGames: without a rival list only the structural rules apply (orphans stay)', () => {
  assert.deepEqual(S.eligibleH2HGames(ELIG).map(g => g.id), ['a', 'b', 'c', 'e']);
});

test('overallRecord: W-L-T, win % over all games, per-game and per-day averages', () => {
  const r = S.overallRecord(ELIG, ['r1', 'r2']);
  assert.deepEqual({ games: r.games, wins: r.wins, losses: r.losses, ties: r.ties, days: r.days },
    { games: 3, wins: 1, losses: 2, ties: 0, days: 2 });
  assert.ok(Math.abs(r.winPct - 33.333) < 0.01);
  assert.ok(Math.abs(r.myAvg - (800 + 800 + 500) / 3) < 1e-9);
  assert.equal(r.myAvgByDay, (800 + 500) / 2);
});

test('overallRecord: an orphaned game cannot move the record (the audit #1 contradiction)', () => {
  const withOrphan = S.overallRecord(ELIG, ['r1', 'r2']);
  const without = S.overallRecord(ELIG.filter(g => !g || g.rivalId !== 'gone'), ['r1', 'r2']);
  assert.deepEqual(withOrphan, without);
  assert.deepEqual(S.overallRecord([], ['r1']), { games: 0, wins: 0, losses: 0, ties: 0, winPct: 0, myAvg: 0, days: 0, myAvgByDay: 0 });
});

test('overallRecord agrees with periodRecords on the same eligible set', () => {
  const known = ['r1', 'r2'];
  const weeks = S.periodRecords(ELIG, 'week', known);
  const sum = weeks.reduce((a, w) => ({ games: a.games + w.games, wins: a.wins + w.wins, losses: a.losses + w.losses, ties: a.ties + w.ties }), { games: 0, wins: 0, losses: 0, ties: 0 });
  const r = S.overallRecord(ELIG, known);
  assert.deepEqual(sum, { games: r.games, wins: r.wins, losses: r.losses, ties: r.ties });
});

// ---- backup import ----
test('sanitizeBackup: rejects anything that is not a rivals+games object without touching state', () => {
  for (const bad of [null, 'x', 42, [], {}, { rivals: [] }, { games: [] }, { rivals: 'x', games: [] }]) {
    const r = S.sanitizeBackup(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /backup/);
  }
});

test('sanitizeBackup: the audit\'s malformed fixture imports only the safe rows and counts the rest', () => {
  const r = S.sanitizeBackup({
    rivals: [{ id: 'm1', name: 'Mal', color: '#fff', icon: '🙂' }, { id: 'm2' }, null, 'junk', { name: 'NoId', color: 'red' }],
    games: [
      { id: 'q1', rivalId: 'm1', date: 20260818, myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] },
      { id: 'q2', rivalId: 'm1', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] },
      { id: 'q3', rivalId: 'm1', date: '2026-08-19', myScores: 'abc', theirScores: [1, 2, 3, 4, 5], myScore: 'x', theirScore: null },
      null, 42,
      { id: 'q4', rivalId: 'm1', date: '2026-02-30', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5], myScore: 40, theirScore: 40 },
      { id: 'q5', rivalId: 'm1', date: '2026-08-20', myScores: [90, 90, 90, 90, 90], theirScores: [10, 10, 10, 10, 10], cities: [{ lat: '1', lng: null }, {}, null, { lat: 2, lng: 3, name: 'X' }, { lat: 'abc', lng: 'x' }], note: 42, extra: 'dropped' },
    ],
  }, { makeId: () => 'gen' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rivals, [{ id: 'm1', name: 'Mal', color: '#fff', icon: '🙂', maptapUsername: '', createdAt: 0 }, { id: 'm2', name: 'Rival', color: '#6366f1', icon: '🎯', maptapUsername: '', createdAt: 0 }]);
  assert.deepEqual(r.dropped, { rivals: 3, games: 5 });
  // q3: rival-only (their array clean, my side unusable) survives as rival-only
  assert.deepEqual(r.games.map(g => g.id), ['q3', 'q5']);
  assert.equal(r.games[0].myScores, undefined);
  assert.equal(r.games[0].myScore, undefined);
  assert.equal(r.games[0].theirScore, 36); // 1+2+3*2+4*3+5*3
  const q5 = r.games[1];
  assert.equal(q5.note, '');
  assert.equal('extra' in q5, false);
  assert.deepEqual(q5.cities, [{ lat: 1, lng: null }, { lat: null, lng: null }, { lat: null, lng: null }, { lat: 2, lng: 3, name: 'X' }, { lat: null, lng: null }]);
  assert.equal(q5.myScore, 900);
});

test('sanitizeBackup: a clean export round-trips unchanged (scalars recomputed from arrays)', () => {
  const rivals = [{ id: 'r-ari', name: 'Ari', color: '#f59e0b', icon: '🦊', maptapUsername: 'ari_mt', createdAt: 5 }];
  const games = [{ id: 'g1', rivalId: 'r-ari', date: '2026-08-10', myScores: [80, 80, 80, 80, 80], theirScores: [70, 75, 65, 55, 45], myScore: 800, theirScore: 575, note: 'synced from MapTap', createdAt: 9, cities: [{ lat: 1, lng: 2, name: 'A' }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }] }];
  const r = S.sanitizeBackup({ rivals, games, me: ' Nikita ', myIcon: '🧭' });
  assert.deepEqual(r.rivals, rivals);
  assert.deepEqual(r.games, games);
  assert.equal(r.me, 'Nikita');
  assert.equal(r.myIcon, '🧭');
  assert.deepEqual(r.dropped, { rivals: 0, games: 0 });
});

test('sanitizeBackup: legacy totals-only games and rival-only days are kept; duplicate rival ids collapse', () => {
  const r = S.sanitizeBackup({
    rivals: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A again' }],
    games: [
      { id: '1', rivalId: 'a', date: '2026-01-01', myScore: 500, theirScore: 480 },
      { id: '2', rivalId: 'a', date: '2026-01-02', theirScores: [50, 50, 50, 50, 50] },
      { id: '3', rivalId: 'a', date: '2026-01-03', myScore: 2000, theirScore: 480 }, // my scalar out of range -> dropped side -> rival-only
      { rivalId: 'a', date: '2026-01-04', myScore: 1, theirScore: 2 },              // no id -> generated
    ],
  }, { makeId: () => 'gen' });
  assert.equal(r.rivals.length, 1);
  assert.equal(r.dropped.rivals, 1);
  assert.deepEqual(r.games.map(g => [g.id, g.myScore, g.theirScore]), [['1', 500, 480], ['2', undefined, 500], ['3', undefined, 480], ['gen', 1, 2]]);
});

test('sanitizeBackup: "__proto__" ids are data and never pollute Object.prototype; me/myIcon must be strings', () => {
  const r = S.sanitizeBackup(JSON.parse('{"rivals":[{"id":"__proto__","name":"P"}],"games":[{"id":"x","rivalId":"__proto__","date":"__proto__","myScore":1,"theirScore":2},{"id":"y","rivalId":"__proto__","date":"2026-08-01","myScore":1,"theirScore":2}],"me":{"polluted":true},"__proto__":{"polluted":1}}'));
  assert.equal(r.ok, true);
  assert.equal(r.rivals[0].id, '__proto__');
  assert.deepEqual(r.games.map(g => g.id), ['y']);
  assert.equal(r.me, null);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(r.rivals[0], 'id'), true);
});

// ---- one row per (rival, day): collapseDuplicateDays ----------------------
//
// Two devices that log the same day for the same rival each mint their own
// row id, and the sync layer's record merge (sync-system/sync-helpers.mjs,
// mergeRecordCollections) keys records by id, so it keeps BOTH rows and every
// W-L-T figure counts that day twice. The collapse is the app's half of that
// contract: every game list entering the app (boot, another tab, a sync
// delivery, a backup import) passes through sanitizeBackup, which folds each
// (rival, day) group into one row by a fixed rule that does not depend on the
// order the rows arrived in, so two devices collapsing the same merged log
// write the same row and converge. See FINDINGS, "Two devices, one day".
const R5 = (n) => [n, n, n, n, n];

test('collapseDuplicateDays: a lone row per (rival, day) is returned untouched, by reference', () => {
  const games = [
    { id: 'a', rivalId: 'r1', date: '2026-09-01', note: '', createdAt: 1, myScore: 500, theirScore: 400 },
    { id: 'b', rivalId: 'r1', date: '2026-09-02', note: '', createdAt: 2, myScore: 500, theirScore: 400 },
    { id: 'c', rivalId: 'r2', date: '2026-09-01', note: '', createdAt: 3, myScore: 500, theirScore: 400 },
  ];
  const out = S.collapseDuplicateDays(games);
  assert.deepEqual(out.merged, []);
  assert.equal(out.games.length, 3);
  out.games.forEach((g, i) => assert.equal(g, games[i], 'same object, so an unchanged log persists byte-identical'));
});

test('collapseDuplicateDays: round scores beat a totals-only side, and the day counts once', () => {
  const cities = R5(0).map((_, i) => ({ lat: 10 + i, lng: 20 + i, name: `C${i}` }));
  const games = [
    // A hand-entered legacy row: totals only, on this device.
    { id: 'old', rivalId: 'r1', date: '2026-09-10', note: '', createdAt: 10, myScore: 790, theirScore: 640 },
    // The same day synced from MapTap on another device.
    { id: 'syn', rivalId: 'r1', date: '2026-09-10', note: SYNC_NOTE, createdAt: 20, myScores: R5(80), myScore: 800, theirScores: R5(60), theirScore: 600, cities },
  ];
  const out = S.collapseDuplicateDays(games);
  assert.equal(out.games.length, 1);
  assert.deepEqual(out.games[0], {
    id: 'old', rivalId: 'r1', date: '2026-09-10', note: '', createdAt: 10,
    myScores: R5(80), myScore: 800, theirScores: R5(60), theirScore: 600, cities,
  });
  assert.deepEqual(out.merged, [{ rivalId: 'r1', date: '2026-09-10', count: 2, positions: [0, 1] }]);
  const rec = S.overallRecord(out.games);
  assert.deepEqual([rec.games, rec.wins, rec.losses], [1, 1, 0], 'one day, one win: never 2-0');
});

test('collapseDuplicateDays: with rounds on both rows, a hand-entered row beats a synced one (as a paste over a synced day does)', () => {
  const games = [
    { id: 's', rivalId: 'r1', date: '2026-09-10', note: SYNC_NOTE, createdAt: 10, myScores: R5(80), myScore: 800, theirScores: R5(60), theirScore: 600 },
    { id: 'p', rivalId: 'r1', date: '2026-09-10', note: '', createdAt: 50, myScores: R5(80), myScore: 800, theirScores: R5(90), theirScore: 900 },
  ];
  const [row] = S.collapseDuplicateDays(games).games;
  assert.equal(row.id, 'p');
  assert.deepEqual(row.theirScores, R5(90));
  assert.equal(row.note, '', 'a row carrying a hand-entered side must shed the sync marker, or the next sync would overwrite it');
  assert.equal(row.createdAt, 10, 'the day keeps its earliest creation stamp');
});

test('collapseDuplicateDays: a me-only and a rival-only synced row become one head-to-head, whatever order they arrive in', () => {
  const mine = { id: 'b', rivalId: 'r1', date: '2026-09-11', note: SYNC_NOTE, createdAt: 300, myScores: R5(80), myScore: 800 };
  const theirs = { id: 'a', rivalId: 'r1', date: '2026-09-11', note: SYNC_NOTE, createdAt: 300, theirScores: R5(70), theirScore: 700 };
  const one = S.collapseDuplicateDays([mine, theirs]).games;
  const two = S.collapseDuplicateDays([theirs, mine]).games;
  assert.deepEqual(one, two, 'both devices must write the same row, or they never converge');
  assert.deepEqual(one, [{
    id: 'a', rivalId: 'r1', date: '2026-09-11', note: SYNC_NOTE, createdAt: 300,
    myScores: R5(80), myScore: 800, theirScores: R5(70), theirScore: 700,
  }]);
  assert.equal(resultOf(one[0]), 'W');
});

test('collapseDuplicateDays: every distinct manual note survives, and the merged row sits where the day first appeared', () => {
  const games = [
    { id: 'x', rivalId: 'r1', date: '2026-09-12', note: 'rematch at lunch', createdAt: 5, myScore: 600, theirScore: 500 },
    { id: 'other', rivalId: 'r2', date: '2026-09-12', note: '', createdAt: 6, myScore: 1, theirScore: 2 },
    { id: 'y', rivalId: 'r1', date: '2026-09-12', note: SYNC_NOTE, createdAt: 7, myScores: R5(60), myScore: 600, theirScores: R5(50), theirScore: 500 },
    { id: 'z', rivalId: 'r1', date: '2026-09-12', note: 'imported from WhatsApp', createdAt: 9, myScore: 600, theirScore: 500 },
    { id: 'w', rivalId: 'r1', date: '2026-09-12', note: 'rematch at lunch', createdAt: 11, myScore: 600, theirScore: 500 },
  ];
  const out = S.collapseDuplicateDays(games);
  assert.deepEqual(out.games.map(g => g.id), ['x', 'other']);
  assert.equal(out.games[0].note, 'rematch at lunch / imported from WhatsApp');
  assert.deepEqual(out.games[0].myScores, R5(60));
  assert.deepEqual(out.merged, [{ rivalId: 'r1', date: '2026-09-12', count: 4, positions: [0, 2, 3, 4] }]);
  assert.deepEqual(S.collapseDuplicateDays(out.games).merged, [], 'idempotent: a collapsed log collapses to itself');
});

test('sanitizeBackup: a backup holding the same rival and day twice imports one row and says so', () => {
  const r = S.sanitizeBackup({
    rivals: [{ id: 'r1', name: 'Ari' }],
    games: [
      { id: 'g1', rivalId: 'r1', date: '2026-08-03', myScore: 700, theirScore: 500, note: 'first paste' },
      { id: 'g2', rivalId: 'r1', date: '2026-08-04', myScore: 600, theirScore: 700 },
      { id: 'g3', rivalId: 'r1', date: '2026-08-03', myScores: R5(70), theirScores: R5(50) },
    ],
  });
  assert.deepEqual(r.games.map(g => [g.id, g.date]), [['g1', '2026-08-03'], ['g2', '2026-08-04']]);
  assert.deepEqual(r.games[0].myScores, R5(70));
  assert.equal(r.games[0].note, 'first paste');
  assert.deepEqual(r.dropped, { rivals: 0, games: 0 }, 'a merge drops no data, so it is not counted as skipped');
  assert.ok(r.repaired.some(x => /games #1, #3 \(2026-08-03\)/.test(x) && /merged into one/.test(x)), r.repaired.join(' | '));
  assert.equal(S.overallRecord(r.games).games, 2);
});

// --- myAvgByRound ----------------------------------------------------------

const h2h = (date, rivalId, myScores, theirScores) =>
  ({ id: `${date}-${rivalId}`, rivalId, date, myScores, theirScores });

test('myAvgByRound: averages my rounds and the rivals\' rounds, with the gap in daily points', () => {
  const out = myAvgByRound([
    h2h('2026-08-01', 'a', [90, 80, 70, 60, 50], [80, 80, 80, 80, 80]),
    h2h('2026-08-02', 'a', [100, 90, 80, 70, 60], [90, 70, 60, 90, 40]),
  ], ['a']);
  assert.equal(out.days, 2);
  assert.equal(out.rivalRows, 2);
  assert.deepEqual(out.rows.map(r => r.round), [1, 2, 3, 4, 5]);
  assert.deepEqual(out.rows.map(r => r.weight), WEIGHTS);
  assert.deepEqual(out.rows.map(r => r.myAvg), [95, 85, 75, 65, 55]);
  assert.deepEqual(out.rows.map(r => r.rivalsAvg), [85, 75, 70, 85, 60]);
  assert.deepEqual(out.rows.map(r => r.diff), [10, 10, 5, -20, -5]);
  assert.deepEqual(out.rows.map(r => r.points), [10, 10, 10, -60, -15]);
  assert.equal(out.netPoints, -45);
  assert.equal(out.weakest, 3, 'round 4 costs the most points (-60)');
  assert.equal(out.strongest, 0, 'rounds 1-3 tie on +10; the first one wins the tie');
});

test('myAvgByRound: netPoints equals my average daily total minus the rivals\'', () => {
  const games = [
    h2h('2026-08-01', 'a', [93, 88, 71, 64, 52], [97, 91, 80, 55, 61]),
    h2h('2026-08-02', 'a', [100, 76, 90, 81, 33], [88, 94, 70, 79, 72]),
    h2h('2026-08-02', 'b', [100, 76, 90, 81, 33], [60, 99, 85, 40, 90]),
  ];
  const out = myAvgByRound(games, ['a', 'b']);
  const myDaily = (weightedTotal(games[0].myScores) + weightedTotal(games[1].myScores)) / 2;
  const rivalsDaily = (weightedTotal(games[0].theirScores) +
    (weightedTotal(games[1].theirScores) + weightedTotal(games[2].theirScores)) / 2) / 2;
  closeTo(out.netPoints, myDaily - rivalsDaily);
  closeTo(out.rows.reduce((s, r) => s + r.points, 0), out.netPoints);
});

test('myAvgByRound: a day logged against 3 rivals counts once on my side, and once (averaged) on theirs', () => {
  const out = myAvgByRound([
    h2h('2026-08-01', 'a', [50, 50, 50, 50, 50], [90, 90, 90, 90, 90]),
    h2h('2026-08-01', 'b', [50, 50, 50, 50, 50], [60, 60, 60, 60, 60]),
    h2h('2026-08-01', 'c', [50, 50, 50, 50, 50], [30, 30, 30, 30, 30]),
    h2h('2026-08-02', 'a', [70, 70, 70, 70, 70], [70, 70, 70, 70, 70]),
  ], ['a', 'b', 'c']);
  assert.equal(out.days, 2);
  assert.equal(out.rivalRows, 4);
  // Day 1's rivals average 60, day 2's 70: 65 per round. Row-averaging
  // would give (90+60+30+70)/4 = 62.5 and over-weight the busy day.
  assert.deepEqual(out.rows.map(r => r.rivalsAvg), [65, 65, 65, 65, 65]);
  assert.deepEqual(out.rows.map(r => r.myAvg), [60, 60, 60, 60, 60]);
});

test('myAvgByRound: rival-only, me-only, totals-only and orphaned rows contribute nothing', () => {
  const out = myAvgByRound([
    h2h('2026-08-01', 'a', [80, 80, 80, 80, 80], [70, 70, 70, 70, 70]),
    { id: 'ro', rivalId: 'a', date: '2026-08-02', theirScores: [10, 10, 10, 10, 10], theirScore: 100 },
    { id: 'mo', rivalId: 'a', date: '2026-08-03', myScores: [10, 10, 10, 10, 10], myScore: 100 },
    { id: 'tt', rivalId: 'a', date: '2026-08-04', myScore: 900, theirScore: 100 },
    h2h('2026-08-05', 'gone', [0, 0, 0, 0, 0], [100, 100, 100, 100, 100]),
  ], ['a']);
  assert.equal(out.days, 1);
  assert.deepEqual(out.rows.map(r => r.myAvg), [80, 80, 80, 80, 80]);
  assert.deepEqual(out.rows.map(r => r.rivalsAvg), [70, 70, 70, 70, 70]);
});

test('myAvgByRound: a row with a malformed round is skipped whole, never read as 0', () => {
  const out = myAvgByRound([
    h2h('2026-08-01', 'a', [80, 80, 80, 80, 80], [70, 70, 70, 70, 70]),
    h2h('2026-08-02', 'a', [80, null, 80, 80, 80], [70, 70, 70, 70, 70]),
    h2h('2026-08-03', 'a', [80, 80, 80, 80, 80], [70, 70, '', 70, 70]),
    h2h('2026-08-04', 'a', [80, 80, 80, 80], [70, 70, 70, 70]),
    h2h('2026-08-05', 'a', [80, 80, 80, 80, 'x'], [70, 70, 70, 70, 70]),
  ], ['a']);
  assert.equal(out.days, 1);
  assert.deepEqual(out.rows.map(r => r.myAvg), [80, 80, 80, 80, 80]);
});

test('myAvgByRound: weakest / strongest are null when no round is behind / ahead', () => {
  const ahead = myAvgByRound([h2h('2026-08-01', 'a', [90, 90, 90, 90, 90], [80, 90, 80, 80, 80])], ['a']);
  assert.equal(ahead.weakest, null);
  assert.equal(ahead.strongest, 3, 'rounds 4 and 5 tie on +30; the first one wins the tie');
  const level = myAvgByRound([h2h('2026-08-01', 'a', [70, 70, 70, 70, 70], [70, 70, 70, 70, 70])], ['a']);
  assert.equal(level.weakest, null);
  assert.equal(level.strongest, null);
  assert.equal(level.netPoints, 0);
});

test('myAvgByRound: no qualifying games yields an empty result', () => {
  const empty = { rows: [], days: 0, rivalRows: 0, netPoints: 0, weakest: null, strongest: null };
  assert.deepEqual(myAvgByRound([], ['a']), empty);
  assert.deepEqual(myAvgByRound(null, ['a']), empty);
  assert.deepEqual(myAvgByRound([h2h('2026-08-01', 'a', [1, 1, 1, 1, 1], [1, 1, 1, 1, 1])], []), empty);
});

// A synced row stored while rounds were still read by array position has its
// scores AND cities in the same wrong order. The next sync re-reads the day by
// round number; it must move the cities with the scores, or each score would
// sit beside another round's city (and the continent figures would follow).
test('mergeMapTapSync: re-ordered scores on a synced row bring their cities with them', () => {
  const stale = {
    id: 'g1', rivalId: 'r1', date: '2026-08-20', note: SYNC_NOTE, createdAt: 1,
    myScores: [70, 95, 60, 80, 90], myScore: weightedTotal([70, 95, 60, 80, 90]),
    theirScores: [50, 50, 50, 50, 50], theirScore: 500,
    cities: [city(3), city(1), city(5), city(2), city(4)],
  };
  const out = merge({
    existingGames: [stale],
    mineByDate: { '2026-08-20': day([95, 80, 70, 90, 60]) },
    theirsByDate: { '2026-08-20': day([50, 50, 50, 50, 50]) },
  });
  assert.equal(out.updated, 1);
  assert.deepEqual(stale.myScores, [95, 80, 70, 90, 60]);
  assert.equal(stale.myScore, weightedTotal([95, 80, 70, 90, 60]));
  assert.deepEqual(stale.cities.map((c) => c.name), ['C1', 'C2', 'C3', 'C4', 'C5']);
});

// Found reviewing the fix above: my side arriving in the iOS shape (names, no
// coordinates) must not overwrite a row's cities that DO have coordinates,
// which came from the rival's web roundData; the day would drop out of every
// continent figure.
test('mergeMapTapSync: re-ordered scores never trade cities with coordinates for cities without', () => {
  const stale = {
    id: 'g1', rivalId: 'r1', date: '2026-08-20', note: SYNC_NOTE, createdAt: 1,
    theirScores: [50, 50, 50, 50, 50], theirScore: 500,
    cities: [city(1), city(2), city(3), city(4), city(5)],
  };
  const iosMine = { scores: [90, 90, 90, 90, 90], cities: [1, 2, 3, 4, 5].map((n) => ({ lat: NaN, lng: NaN, name: `C${n}` })) };
  const out = merge({ existingGames: [stale], mineByDate: { '2026-08-20': iosMine }, theirsByDate: { '2026-08-20': day([50, 50, 50, 50, 50]) } });
  assert.equal(out.updated, 1);
  assert.deepEqual(stale.myScores, [90, 90, 90, 90, 90]);
  assert.equal(stale.cities[0].lat, 1, 'the coordinates are kept');
});

// MapTap's scorer skips an entry whose score is not a number BEFORE first-entry
// -wins, so a later readable entry for that round still counts.
test('mapTapHistoryToRounds: an unreadable score does not claim its round', () => {
  const bad = { ...roundDataDay.roundData[0], score: 'x' };
  const dayx = { ...roundDataDay, roundData: [bad, ...roundDataDay.roundData] };
  assert.deepEqual(mapTapHistoryToRounds({ d: dayx }).d.scores, [95, 80, 70, 90, 60]);
});

// --- roundRanksForDay -------------------------------------------------------
// Oracles written from the rules, not from the engine: MapTap's round weights
// typed out here, and competition rank as 1 + the number of players whose
// cumulative score is strictly higher.

const RULE_WEIGHTS = [1, 1, 2, 3, 3];
const cumThrough = (scores, k) =>
  scores.slice(0, k + 1).reduce((t, v, i) => t + v * RULE_WEIGHTS[i], 0);
const oracleRank = (field, key, k) => {
  const mine = cumThrough(field.find(e => e.key === key).scores, k);
  return 1 + field.filter(e => cumThrough(e.scores, k) > mine).length;
};
const ranksOf = (res, key) => res[key].map(s => (s ? s.rank : null));
const movesOf = (res, key) => res[key].map(s => (s ? s.move : null));

test('roundRanksForDay: cumulative weighted ranks and movement, worked by hand', () => {
  // Cumulative (weights 1,1,2,3,3):
  //   a: 90, 180, 220, 250, 280
  //   b: 80, 170, 350, 590, 830
  //   c: 95, 190, 290, 590, 800
  const res = roundRanksForDay([
    { key: 'a', scores: [90, 90, 20, 10, 10] },
    { key: 'b', scores: [80, 90, 90, 80, 80] },
    { key: 'c', scores: [95, 95, 50, 100, 70] },
  ]);
  assert.deepEqual(ranksOf(res, 'a'), [2, 2, 3, 3, 3]);
  assert.deepEqual(ranksOf(res, 'b'), [3, 3, 1, 1, 1]);
  assert.deepEqual(ranksOf(res, 'c'), [1, 1, 2, 1, 2]);
  // Movement is places gained against the previous round; none on round 1.
  assert.deepEqual(movesOf(res, 'a'), [null, 0, -1, 0, 0]);
  assert.deepEqual(movesOf(res, 'b'), [null, 0, 2, 0, 0]);
  assert.deepEqual(movesOf(res, 'c'), [null, 0, -1, 1, -1]);
  assert.equal(res.a[0].field, 3);
});

test('roundRanksForDay: the multiplier, not the raw score, decides a round', () => {
  // Raw round 3 is equal-ish, but round 3 counts double: b's 60-point raw
  // edge there is worth 120 and overtakes a's 100-point lead.
  const res = roundRanksForDay([
    { key: 'a', scores: [100, 100, 0, 0, 0] },
    { key: 'b', scores: [50, 50, 60, 0, 0] },
  ]);
  assert.deepEqual(ranksOf(res, 'a'), [1, 1, 2, 2, 2]);
  assert.deepEqual(ranksOf(res, 'b'), [2, 2, 1, 1, 1]);
  assert.deepEqual(movesOf(res, 'b'), [null, 0, 1, 0, 0]);
});

test('roundRanksForDay: ties share the best position (1, 1, 3) and move together', () => {
  const res = roundRanksForDay([
    { key: 'a', scores: [80, 80, 80, 80, 80] },
    { key: 'b', scores: [80, 80, 80, 80, 80] },
    { key: 'c', scores: [90, 10, 10, 10, 10] },
  ]);
  assert.deepEqual(ranksOf(res, 'a'), [2, 1, 1, 1, 1]);
  assert.deepEqual(ranksOf(res, 'b'), [2, 1, 1, 1, 1]);
  assert.deepEqual(ranksOf(res, 'c'), [1, 3, 3, 3, 3]);
  assert.deepEqual(movesOf(res, 'a'), [null, 1, 0, 0, 0]);
  assert.deepEqual(movesOf(res, 'c'), [null, -2, 0, 0, 0]);
  // `tied` marks a shared rank: a and b share every round, c is alone.
  assert.deepEqual(res.a.map(x => x.tied), [true, true, true, true, true]);
  assert.deepEqual(res.c.map(x => x.tied), [false, false, false, false, false]);
});

test('roundRanksForDay: players who have not played are outside the field', () => {
  const res = roundRanksForDay([
    { key: 'a', scores: [50, 50, 50, 50, 50] },
    { key: 'b', scores: null },
    { key: 'c', scores: [60, 60, 60, 60, 60] },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(res, 'b'), false);
  assert.deepEqual(ranksOf(res, 'a'), [2, 2, 2, 2, 2]);
  assert.equal(res.a[4].field, 2);
});

test('roundRanksForDay: fewer than two players yields no ranks', () => {
  assert.deepEqual(roundRanksForDay([]), {});
  assert.deepEqual(roundRanksForDay(null), {});
  assert.deepEqual(roundRanksForDay([
    { key: 'a', scores: [50, 50, 50, 50, 50] },
    { key: 'b', scores: null },
  ]), {});
});

test('roundRanksForDay: a missing round is never zero; that round and later go unranked for everyone', () => {
  for (const missing of [null, undefined, NaN, '50']) {
    for (let k = 0; k < 5; k++) {
      const gap = [50, 50, 50, 50, 50];
      gap[k] = missing;
      const res = roundRanksForDay([
        { key: 'a', scores: gap },
        { key: 'b', scores: [10, 10, 10, 10, 10] },
        { key: 'c', scores: [90, 90, 90, 90, 90] },
      ]);
      for (const key of ['a', 'b', 'c']) {
        for (let i = 0; i < 5; i++) {
          if (i < k) assert.ok(res[key][i], `${key} R${i + 1} ranked before the gap at R${k + 1}`);
          else assert.equal(res[key][i], null, `${key} R${i + 1} must be unranked (gap at R${k + 1}, ${missing})`);
        }
      }
    }
  }
  // A short array is incomplete play, not a 5-round day.
  const short = roundRanksForDay([
    { key: 'a', scores: [50, 50, 50] },
    { key: 'b', scores: [10, 10, 10, 10, 10] },
  ]);
  assert.deepEqual(ranksOf(short, 'a'), [null, null, null, null, null]);
});

test('roundRanksForDay: property, every slot matches the oracle and round 5 is the final standing', () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let trial = 0; trial < 500; trial++) {
    const n = 2 + rnd(6);
    // Coarse scores (multiples of 10) so ties happen often.
    const field = Array.from({ length: n }, (_, p) => ({
      key: 'p' + p,
      scores: Array.from({ length: 5 }, () => rnd(11) * 10),
    }));
    const res = roundRanksForDay(field);
    for (const e of field) {
      for (let k = 0; k < 5; k++) {
        const slot = res[e.key][k];
        assert.equal(slot.rank, oracleRank(field, e.key, k));
        assert.equal(slot.field, n);
        assert.equal(slot.move, k === 0 ? null : oracleRank(field, e.key, k - 1) - slot.rank);
        const mine = cumThrough(e.scores, k);
        assert.equal(slot.tied, field.filter(o => o !== e && cumThrough(o.scores, k) === mine).length > 0);
      }
      // Round 5 agrees with the day's final leaderboard, which ranks the
      // weighted total the Actual column shows.
      const finalRank = 1 + field.filter(o => weightedTotal(o.scores) > weightedTotal(e.scores)).length;
      assert.equal(res[e.key][4].rank, finalRank);
      assert.equal(res[e.key][4].rank, competitionRanksForDay(
        field.map(o => ({ key: o.key, total: weightedTotal(o.scores) })))[e.key]);
    }
  }
});

test('roundRanksForDay: a __proto__ player id stays an own key', () => {
  const res = roundRanksForDay([
    { key: '__proto__', scores: [90, 90, 90, 90, 90] },
    { key: 'b', scores: [10, 10, 10, 10, 10] },
  ]);
  assert.ok(Object.prototype.hasOwnProperty.call(res, '__proto__'));
  assert.deepEqual(ranksOf(res, '__proto__'), [1, 1, 1, 1, 1]);
});

// --- podiumTier ------------------------------------------------------------

test('podiumTier: gold, silver, bronze for 1-3, none below, whatever the field size', () => {
  assert.equal(podiumTier(1), 'gold');
  assert.equal(podiumTier(2), 'silver');
  assert.equal(podiumTier(3), 'bronze');
  for (const r of [4, 5, 8, 15, 40, 0, null, undefined, NaN, '1']) assert.equal(podiumTier(r), null, String(r));
  // Fields of 2, 3, 8 and 15 with every round tied in pairs: tiers follow the
  // shared rank, so both players on a shared place get the same tier, and a
  // place below 3 gets none however many players there are.
  for (const n of [2, 3, 8, 15]) {
    const field = Array.from({ length: n }, (_, p) => ({ key: 'p' + p, scores: Array(5).fill(100 - Math.floor(p / 2) * 5) }));
    const res = roundRanksForDay(field);
    for (const e of field) {
      const p = Number(e.key.slice(1));
      const expectedRank = 1 + 2 * Math.floor(p / 2);   // 1, 1, 3, 3, 5, 5, ...
      for (const slot of res[e.key]) {
        assert.equal(slot.rank, expectedRank);
        assert.equal(podiumTier(slot.rank), expectedRank === 1 ? 'gold' : expectedRank === 3 ? 'bronze' : null);
      }
    }
  }
  // T#2 shares silver.
  const t2 = roundRanksForDay([
    { key: 'a', scores: [90, 90, 90, 90, 90] },
    { key: 'b', scores: [50, 50, 50, 50, 50] },
    { key: 'c', scores: [50, 50, 50, 50, 50] },
  ]);
  assert.equal(t2.b[4].tied, true);
  assert.equal(podiumTier(t2.b[4].rank), 'silver');
  assert.equal(podiumTier(t2.c[4].rank), 'silver');
});

// --- coordinates ------------------------------------------------------------

test('validLatLng: missing, blank and non-numeric coordinates are missing, never (0, 0)', () => {
  // Number(null), Number('') and Number([]) are all 0: the defect that put
  // seven name-only puzzle days and four synced rows at the Gulf of Guinea.
  for (const bad of [null, undefined, '', '  ', [], {}, 'abc', NaN, Infinity, true]) {
    assert.equal(validLatLng({ lat: bad, lng: 10 }), null, `lat ${String(bad)}`);
    assert.equal(validLatLng({ lat: 10, lng: bad }), null, `lng ${String(bad)}`);
  }
  assert.equal(validLatLng({}), null);
  assert.equal(validLatLng(null), null);
  assert.equal(validLatLng({ lat: 91, lng: 0 }), null);
  assert.equal(validLatLng({ lat: 0, lng: -180.5 }), null);
});

test('validLatLng: a real zero is a coordinate (equator, prime meridian, both)', () => {
  assert.deepEqual(validLatLng({ lat: 0, lng: 32.5 }), { lat: 0, lng: 32.5 });
  assert.deepEqual(validLatLng({ lat: 51.48, lng: 0 }), { lat: 51.48, lng: 0 });
  assert.deepEqual(validLatLng({ lat: 0, lng: 0 }), { lat: 0, lng: 0 });
  assert.deepEqual(validLatLng({ lat: '-33.9', lng: '18.4' }), { lat: -33.9, lng: 18.4 });
  assert.deepEqual(validLatLng({ lat: 90, lng: -180 }), { lat: 90, lng: -180 });
});

test('allCitiesLocated: all five must be located', () => {
  const city = { lat: 1, lng: 2 };
  assert.equal(allCitiesLocated([city, city, city, city, city]), true);
  assert.equal(allCitiesLocated([city, city, city, city, { lat: null, lng: null, name: 'Apia' }]), false);
  assert.equal(allCitiesLocated([city, city, city, city]), false);
  assert.equal(allCitiesLocated(null), false);
});

// --- June 3 2026: a hand-entered row and the MapTap sync ----------------------
// The real conflict: two rows typed in by hand on 2026-06-03 carried
// 6,3,26,21,14 (166) for both sides, while MapTap's game history records
// 95,96,88,79,57 (775) for the owner and different scores for each rival.

const JUNE3 = '2026-06-03';
const mapTapSide = (scores) => ({ [JUNE3]: { scores, cities: null } });

test('mergeMapTapSync: a hand-entered row is never overwritten, however MapTap disagrees', () => {
  const hand = { id: 'h1', rivalId: 'em', date: JUNE3, note: '', createdAt: 1,
    myScores: [6, 3, 26, 21, 14], myScore: 166, theirScores: [6, 3, 26, 21, 14], theirScore: 166 };
  const res = mergeMapTapSync({
    rivalId: 'em', existingGames: [hand], makeId: () => 'new', now: 2,
    mineByDate: mapTapSide([95, 96, 88, 79, 57]), theirsByDate: mapTapSide([96, 98, 99, 77, 47]),
  });
  assert.equal(res.newGames.length, 0);
  assert.equal(res.updated, 0);
  assert.deepEqual(hand.myScores, [6, 3, 26, 21, 14]);
});

test('mergeMapTapSync: with the hand-entered row deleted, one synced row carries MapTap\'s scores', () => {
  const res = mergeMapTapSync({
    rivalId: 'em', existingGames: [], makeId: () => 'new', now: 2,
    mineByDate: mapTapSide([95, 96, 88, 79, 57]), theirsByDate: mapTapSide([96, 98, 99, 77, 47]),
  });
  assert.equal(res.newGames.length, 1);
  const row = res.newGames[0];
  assert.equal(row.note, SYNC_NOTE);
  // Totals worked by hand at weights 1,1,2,3,3.
  assert.equal(row.myScore, 95 + 96 + 2 * 88 + 3 * 79 + 3 * 57);
  assert.equal(row.myScore, 775);
  assert.equal(row.theirScore, 96 + 98 + 2 * 99 + 3 * 77 + 3 * 47);
  assert.equal(row.theirScore, 764);
  // A second sync with the same history adds nothing and changes nothing.
  const again = mergeMapTapSync({
    rivalId: 'em', existingGames: res.newGames, makeId: () => 'dup', now: 3,
    mineByDate: mapTapSide([95, 96, 88, 79, 57]), theirsByDate: mapTapSide([96, 98, 99, 77, 47]),
  });
  assert.deepEqual([again.newGames.length, again.added, again.updated], [0, 0, 0]);
  assert.equal(res.newGames[0].myScore, 775);
});

// --- pre-game prediction snapshots -------------------------------------------

const LOCATED = [
  { lat: 24.0889, lng: 32.8998 }, { lat: 41.3275, lng: 19.8189 }, { lat: 49.5938, lng: 17.2509 },
  { lat: 6.1498, lng: 6.7857 }, { lat: 18.4706, lng: -66.7208 },
];
const snapInput = (over = {}) => ({
  date: '2026-11-20',
  takenAtMs: Date.UTC(2026, 10, 18, 12, 0, 0),
  model: 'geo-idw-1',
  through: '2026-11-17',
  cities: LOCATED,
  players: [
    { key: '@me', name: 'Nikita', scores: [88.4, 89.6, 91.2, 88.0, 86.5] },
    { key: 'r1', name: 'Jenia', scores: [92.1, 95.0, 95.4, 90.2, 91.0] },
    { key: 'r2', name: 'Greg', scores: [90, 92, 93, 89, 93] },
    { key: 'r3', name: 'Newcomer', scores: null },
  ],
  ...over,
});

test('preGameCutoffMs: a day starts first at UTC+14, 10:00 UTC the day before', () => {
  assert.equal(preGameCutoffMs('2026-11-20'), Date.UTC(2026, 10, 19, 10, 0, 0));
  assert.equal(preGameCutoffMs('2027-01-01'), Date.UTC(2026, 11, 31, 10, 0, 0));
  assert.equal(preGameCutoffMs('2028-03-01'), Date.UTC(2028, 1, 29, 10, 0, 0));
  assert.ok(Number.isNaN(preGameCutoffMs('2026-02-30')));
  assert.equal(isPreGameInstant('2026-11-20', Date.UTC(2026, 10, 19, 9, 59, 59, 999)), true);
  assert.equal(isPreGameInstant('2026-11-20', Date.UTC(2026, 10, 19, 10, 0, 0)), false);
});

test('buildPredictionSnapshot: stores rounded rounds, their weighted total and the predicted place', () => {
  const snap = buildPredictionSnapshot(snapInput());
  assert.equal(snap.date, '2026-11-20');
  assert.equal(snap.takenAt, '2026-11-18T12:00:00.000Z');
  assert.equal(snap.model, 'geo-idw-1');
  assert.equal(snap.through, '2026-11-17');
  // Rounded per round first, then weighted 1,1,2,3,3 (the card's chips).
  assert.deepEqual(snap.players['@me'], { r: [88, 90, 91, 88, 87], t: 88 + 90 + 182 + 264 + 261, p: 3 });
  assert.deepEqual(snap.players.r1, { r: [92, 95, 95, 90, 91], t: 92 + 95 + 190 + 270 + 273, p: 1 });
  assert.deepEqual(snap.players.r2, { r: [90, 92, 93, 89, 93], t: 90 + 92 + 186 + 267 + 279, p: 2 });
  // No prediction, no entry; and no names anywhere in what is stored.
  assert.equal('r3' in snap.players, false);
  assert.ok(!/Nikita|Jenia|Greg/.test(JSON.stringify(snap)));
  assert.match(snap.puzzle, /^[0-9a-f]{8}$/);
});

test('buildPredictionSnapshot: equal predicted totals take the card order (name)', () => {
  const snap = buildPredictionSnapshot(snapInput({ players: [
    { key: 'b', name: 'Bob', scores: [90, 90, 90, 90, 90] },
    { key: 'a', name: 'Ann', scores: [90, 90, 90, 90, 90] },
  ] }));
  assert.deepEqual([snap.players.a.p, snap.players.b.p], [1, 2]);
});

test('buildPredictionSnapshot: refuses anything that cannot be called pre-game or is not a forecast', () => {
  const cut = Date.UTC(2026, 10, 19, 10, 0, 0);
  assert.equal(buildPredictionSnapshot(snapInput({ takenAtMs: cut })), null);
  assert.equal(buildPredictionSnapshot(snapInput({ takenAtMs: cut + 3600e3 })), null);
  assert.notEqual(buildPredictionSnapshot(snapInput({ takenAtMs: cut - 1 })), null);
  assert.equal(buildPredictionSnapshot(snapInput({ cities: LOCATED.slice(0, 4).concat([{ lat: null, lng: null }]) })), null);
  assert.equal(buildPredictionSnapshot(snapInput({ players: [{ key: 'x', name: 'X', scores: null }] })), null);
  assert.equal(buildPredictionSnapshot(snapInput({ model: '' })), null);
  assert.equal(buildPredictionSnapshot(null), null);
});

test('puzzleFingerprint: same coordinates same print, any change a different one', () => {
  assert.equal(puzzleFingerprint(LOCATED), puzzleFingerprint(LOCATED.map(c => ({ ...c, name: 'x' }))));
  const moved = LOCATED.slice(); moved[4] = { lat: 18.4706, lng: -66.7209 };
  assert.notEqual(puzzleFingerprint(LOCATED), puzzleFingerprint(moved));
  const swapped = [LOCATED[1], LOCATED[0], ...LOCATED.slice(2)];
  assert.notEqual(puzzleFingerprint(LOCATED), puzzleFingerprint(swapped));
  assert.equal(puzzleFingerprint(LOCATED.slice(0, 4)), null);
});

test('sanitizeSnapshots: keeps valid entries byte for byte and drops everything else', () => {
  const good = buildPredictionSnapshot(snapInput());
  const id = snapshotId(good);
  assert.equal(id, '2026-11-20@2026-11-18T12:00:00.000Z');
  const late = { ...good, takenAt: '2026-11-19T10:00:00.000Z' };          // after the cutoff
  const wrongId = { ...good };
  const badRound = { ...good, takenAt: '2026-11-18T13:00:00.000Z', players: { a: { r: [1, 2, 3, 4, 101], t: 10, p: 1 } } };
  const raw = {
    [id]: good,
    [snapshotId(late)]: late,
    'nonsense@key': wrongId,
    [snapshotId(badRound)]: badRound,                                          // a round over 100
    '__proto__': good,
  };
  const out = sanitizeSnapshots(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(Object.keys(out), [id]);
  assert.equal(JSON.stringify(out[id]), JSON.stringify(good));
  assert.deepEqual(sanitizeSnapshots(null), {});
  assert.deepEqual(sanitizeSnapshots([good]), {});
});

test('canonicalSnapshots: the earliest capture of a date stays the original', () => {
  const first = buildPredictionSnapshot(snapInput({ takenAtMs: Date.UTC(2026, 10, 17, 8) }));
  const later = buildPredictionSnapshot(snapInput({ takenAtMs: Date.UTC(2026, 10, 18, 20),
    players: [{ key: '@me', name: 'Nikita', scores: [10, 10, 10, 10, 10] }] }));
  const other = buildPredictionSnapshot(snapInput({ date: '2026-11-21', takenAtMs: Date.UTC(2026, 10, 18, 20) }));
  const map = { [snapshotId(later)]: later, [snapshotId(first)]: first, [snapshotId(other)]: other };
  const canon = canonicalSnapshots(map);
  assert.deepEqual([...canon.keys()].sort(), ['2026-11-20', '2026-11-21']);
  assert.equal(canon.get('2026-11-20').takenAt, first.takenAt);
});

test('snapshots: two devices capturing the same day merge as two entries, no conflict', async () => {
  const { mergeValues } = await import('../../../sync-system/sync-helpers.mjs');
  const a = buildPredictionSnapshot(snapInput({ takenAtMs: Date.UTC(2026, 10, 17, 8) }));
  const b = buildPredictionSnapshot(snapInput({ takenAtMs: Date.UTC(2026, 10, 17, 9) }));
  const res = mergeValues(null, { [snapshotId(a)]: a }, { [snapshotId(b)]: b });
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(Object.keys(res.merged).sort(), [snapshotId(a), snapshotId(b)].sort());
  assert.equal(canonicalSnapshots(res.merged).get('2026-11-20').takenAt, a.takenAt);
});
