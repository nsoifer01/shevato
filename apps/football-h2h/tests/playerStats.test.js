'use strict';

// Pin timezone so M/D/YYYY assertions on ISO dates are deterministic across
// CI/dev machines. Must be set before any Date objects are constructed.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    computePlayerStats,
    scoresInOrder,
    matchResult,
    matchResultsInOrder,
    computeMatchStreaks,
    longestRun,
    longestMatchRun,
    highestScoreGame,
    cleanScores,
    formatNumber,
    formatPercent,
    formatDateShort,
    formatRangeText,
    formatMatchText,
    compareStat
} = require('../js/playerStats.js');

test('cleanScores: drops null/undefined/non-numeric but keeps zeros', () => {
    assert.deepEqual(cleanScores([0, 1, null, undefined, 'foo', NaN, '', 2]), [0, 1, 2]);
    assert.deepEqual(cleanScores('not an array'), []);
    assert.deepEqual(cleanScores([]), []);
});

test('computePlayerStats: empty input returns all zeros, no NaN/Infinity', () => {
    const s = computePlayerStats([]);
    for (const [key, value] of Object.entries(s)) {
        assert.ok(Number.isFinite(value), `${key} must be finite, got ${value}`);
    }
    assert.equal(s.games, 0);
    assert.equal(s.totalGoals, 0);
    assert.equal(s.goalsPerGame, 0);
    assert.equal(s.scoringRate, 0);
    assert.equal(s.stddev, 0);
});

test('computePlayerStats: single game with zero score', () => {
    const s = computePlayerStats([0]);
    assert.equal(s.games, 1);
    assert.equal(s.totalGoals, 0);
    assert.equal(s.goalsPerGame, 0);
    assert.equal(s.highestScore, 0);
    assert.equal(s.lowestScore, 0);
    assert.equal(s.scoringRate, 0);
    assert.equal(s.multiGoalRate, 0);
    assert.equal(s.currentScoringStreak, 0);
    assert.equal(s.currentScorelessStreak, 1);
    assert.equal(s.longestScoringStreak, 0);
    assert.equal(s.longestScorelessStreak, 1);
    assert.equal(s.stddev, 0); // games < 2 → 0, not NaN
    assert.equal(s.median, 0);
});

test('computePlayerStats: totals, averages, highs/lows over a mixed run', () => {
    const s = computePlayerStats([2, 0, 3, 1, 4]);
    assert.equal(s.games, 5);
    assert.equal(s.totalGoals, 10);
    assert.equal(s.goalsPerGame, 2);
    assert.equal(s.highestScore, 4);
    assert.equal(s.lowestScore, 0);
    assert.equal(s.scoringRate, 0.8);        // 4 of 5 scored
    assert.equal(s.multiGoalRate, 0.6);      // 3 of 5: 2, 3, 4
});

test('computePlayerStats: retired fields are not exposed, rates are', () => {
    const s = computePlayerStats([2, 0, 3]);
    // Removed count fields
    assert.equal(s.scoringGames, undefined);
    assert.equal(s.scorelessGames, undefined);
    assert.equal(s.multiGoalGames, undefined);
    assert.equal(s.hatTricks, undefined);
    // Fully removed (neither count nor rate)
    assert.equal(s.hatTrickRate, undefined);
    // scorelessRate removed — it's 1 - scoringRate, redundant
    assert.equal(s.scorelessRate, undefined);
    // Surviving rates are finite numbers
    assert.ok(Number.isFinite(s.multiGoalRate));
    assert.ok(Number.isFinite(s.scoringRate));
});

test('computePlayerStats: all-scoring → scoringRate is 1, no NaN', () => {
    const s = computePlayerStats([1, 2, 3]);
    assert.equal(s.scoringRate, 1);
});

test('computePlayerStats: all-scoreless → scoringRate is 0', () => {
    const s = computePlayerStats([0, 0, 0, 0]);
    assert.equal(s.scoringRate, 0);
    assert.equal(s.multiGoalRate, 0);
});

test('computePlayerStats: empty input → all rate fields are 0 (no divide-by-zero)', () => {
    const s = computePlayerStats([]);
    assert.equal(s.scoringRate, 0);
    assert.equal(s.multiGoalRate, 0);
});

test('computePlayerStats: median — odd vs even length', () => {
    assert.equal(computePlayerStats([5, 1, 3]).median, 3);
    assert.equal(computePlayerStats([1, 2, 3, 4]).median, 2.5);
});

test('computePlayerStats: current streak uses most-recent games', () => {
    // chronological: old → new. Last 3 games are scoring.
    const scoring = computePlayerStats([0, 0, 1, 2, 3]);
    assert.equal(scoring.currentScoringStreak, 3);
    assert.equal(scoring.currentScorelessStreak, 0);

    const scoreless = computePlayerStats([2, 3, 0, 0]);
    assert.equal(scoreless.currentScoringStreak, 0);
    assert.equal(scoreless.currentScorelessStreak, 2);
});

test('computePlayerStats: longest streaks scan entire history', () => {
    const s = computePlayerStats([1, 2, 0, 3, 4, 5, 0, 0, 1]);
    assert.equal(s.longestScoringStreak, 3); // 3,4,5
    assert.equal(s.longestScorelessStreak, 2); // 0,0
    assert.equal(s.currentScoringStreak, 1);
});

test('computePlayerStats: all-zero history — scoreless streaks', () => {
    const s = computePlayerStats([0, 0, 0, 0]);
    assert.equal(s.currentScoringStreak, 0);
    assert.equal(s.longestScoringStreak, 0);
    assert.equal(s.currentScorelessStreak, 4);
    assert.equal(s.longestScorelessStreak, 4);
    assert.equal(s.stddev, 0);
});

test('computePlayerStats: all-identical scores → stddev exactly 0, finite', () => {
    const s = computePlayerStats([2, 2, 2, 2]);
    assert.equal(s.stddev, 0);
    assert.ok(Number.isFinite(s.stddev));
});

test('computePlayerStats: stddev for a known series', () => {
    // Population stddev of [0, 2, 4, 6, 8] is sqrt(8) ≈ 2.8284
    const s = computePlayerStats([0, 2, 4, 6, 8]);
    assert.ok(Math.abs(s.stddev - Math.sqrt(8)) < 1e-9);
});

test('computePlayerStats: recent form windows clamp to available games', () => {
    const s = computePlayerStats([3, 1]);
    // last 3 with only 2 games should average the 2 we have (no padding with 0).
    assert.equal(s.recentFormLast3, 2);
    assert.equal(s.recentFormLast5, 2);

    const empty = computePlayerStats([]);
    assert.equal(empty.recentFormLast3, 0);
    assert.equal(empty.recentFormLast5, 0);
});

test('computePlayerStats: recent form only uses most recent N', () => {
    // chronological: 10,10,10,1,1,1 → last 3 = [1,1,1], last 5 = [10,10,1,1,1]
    const s = computePlayerStats([10, 10, 10, 1, 1, 1]);
    assert.equal(s.recentFormLast3, 1);
    assert.equal(s.recentFormLast5, (10 + 10 + 1 + 1 + 1) / 5);
});

test('computePlayerStats: every returned field is finite (no NaN/Infinity)', () => {
    const inputs = [[], [0], [5], [0, 0, 0], [1, 2, 3, 4, 5], [3, 3, 3]];
    for (const input of inputs) {
        const s = computePlayerStats(input);
        for (const [k, v] of Object.entries(s)) {
            assert.ok(Number.isFinite(v), `input=${JSON.stringify(input)} field=${k} value=${v}`);
        }
    }
});

test('computePlayerStats: ignores null/missing scores in input', () => {
    const s = computePlayerStats([1, null, 2, undefined, 3]);
    assert.equal(s.games, 3);
    assert.equal(s.totalGoals, 6);
    assert.equal(s.goalsPerGame, 2);
});

test('computePlayerStats: current scoring streak breaks on a null at the tail', () => {
    // Walking back from the end: null breaks immediately → current = 0.
    const s = computePlayerStats([1, 1, 1, null]);
    assert.equal(s.currentScoringStreak, 0);
    assert.equal(s.currentScorelessStreak, 0);
});

test('computePlayerStats: current scoring streak breaks at first null walking backward', () => {
    // Walking back: 1 (n=1), 1 (n=2), null → break. Current = 2 (NOT 4).
    const s = computePlayerStats([1, 1, null, 1, 1]);
    assert.equal(s.currentScoringStreak, 2);
});

test('computePlayerStats: current scoreless streak breaks on null', () => {
    // Walking back: 0 (n=1), 0 (n=2), null → break. Current scoreless = 2.
    const s = computePlayerStats([0, 0, null, 0, 0]);
    assert.equal(s.currentScorelessStreak, 2);
    assert.equal(s.currentScoringStreak, 0);
});

test('computePlayerStats: current streaks unaffected by null when there are none', () => {
    // Behavior identical to pre-spec for null-free histories.
    const s = computePlayerStats([0, 1, 1, 1]);
    assert.equal(s.currentScoringStreak, 3);
    assert.equal(s.currentScorelessStreak, 0);
});

test('computePlayerStats: opposite condition still breaks current streak (not just null)', () => {
    const s = computePlayerStats([1, 1, 0, 1, 1, 1]);
    // Last three are scoring → current scoring = 3, current scoreless = 0.
    assert.equal(s.currentScoringStreak, 3);
    assert.equal(s.currentScorelessStreak, 0);
});

test('scoresInOrder: sorts by dateTime then id, skips null scores', () => {
    const games = [
        { id: 3, dateTime: '2025-01-03T12:00:00Z', player1Goals: 2, player2Goals: 1 },
        { id: 1, dateTime: '2025-01-01T12:00:00Z', player1Goals: 0, player2Goals: 3 },
        { id: 2, dateTime: '2025-01-02T12:00:00Z', player1Goals: 1, player2Goals: 1 },
        { id: 4, dateTime: '2025-01-04T12:00:00Z', player1Goals: null, player2Goals: 2 }
    ];
    assert.deepEqual(scoresInOrder(games, 'player1Goals'), [0, 1, 2]);
    assert.deepEqual(scoresInOrder(games, 'player2Goals'), [3, 1, 1, 2]);
});

test('scoresInOrder: id breaks ties when dateTime is identical', () => {
    const games = [
        { id: 5, dateTime: '2025-01-01T12:00:00Z', player1Goals: 5 },
        { id: 2, dateTime: '2025-01-01T12:00:00Z', player1Goals: 2 },
        { id: 9, dateTime: '2025-01-01T12:00:00Z', player1Goals: 9 }
    ];
    assert.deepEqual(scoresInOrder(games, 'player1Goals'), [2, 5, 9]);
});

test('scoresInOrder: tolerates missing/invalid dateTime without crashing', () => {
    const games = [
        { id: 1, player1Goals: 1 },
        { id: 2, dateTime: 'not-a-date', player1Goals: 2 },
        { id: 3, dateTime: '2025-01-01T00:00:00Z', player1Goals: 3 }
    ];
    const out = scoresInOrder(games, 'player1Goals');
    assert.equal(out.length, 3);
});

test('scoresInOrder: returns [] for non-arrays', () => {
    assert.deepEqual(scoresInOrder(null, 'player1Goals'), []);
    assert.deepEqual(scoresInOrder(undefined, 'player1Goals'), []);
    assert.deepEqual(scoresInOrder('nope', 'player1Goals'), []);
});

test('formatNumber: no NaN/Infinity strings in output', () => {
    assert.equal(formatNumber(NaN), '0');
    assert.equal(formatNumber(Infinity), '0');
    assert.equal(formatNumber(-Infinity), '0');
    assert.equal(formatNumber(3), '3');
    assert.equal(formatNumber(2.5), '2.5');
    assert.equal(formatNumber(2.5, 2), '2.50');
});

test('formatPercent: handles non-finite input safely', () => {
    assert.equal(formatPercent(NaN), '0%');
    assert.equal(formatPercent(Infinity), '0%');
    assert.equal(formatPercent(0.5), '50%');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(1), '100%');
});

test('compareStat: higher-is-better picks bigger value', () => {
    assert.deepEqual(compareStat('higher', 5, 3), { winner: 'p1', diff: 2 });
    assert.deepEqual(compareStat('higher', 3, 5), { winner: 'p2', diff: -2 });
});

test('compareStat: lower-is-better picks smaller value', () => {
    assert.deepEqual(compareStat('lower', 2, 4), { winner: 'p1', diff: -2 });
    assert.deepEqual(compareStat('lower', 4, 2), { winner: 'p2', diff: 2 });
});

test('compareStat: equal values are ties (higher & lower)', () => {
    assert.deepEqual(compareStat('higher', 3, 3), { winner: 'tie', diff: 0 });
    assert.deepEqual(compareStat('lower', 0, 0), { winner: 'tie', diff: 0 });
});

test('compareStat: neutral never picks a winner, still returns signed diff', () => {
    assert.deepEqual(compareStat('neutral', 3, 1), { winner: 'neutral', diff: 2 });
    assert.deepEqual(compareStat('neutral', 1, 3), { winner: 'neutral', diff: -2 });
    assert.deepEqual(compareStat('neutral', 2, 2), { winner: 'neutral', diff: 0 });
});

test('compareStat: non-finite values collapse to neutral, no NaN leaks', () => {
    assert.deepEqual(compareStat('higher', NaN, 3), { winner: 'neutral', diff: 0 });
    assert.deepEqual(compareStat('lower', 3, Infinity), { winner: 'neutral', diff: 0 });
    assert.deepEqual(compareStat('higher', null, undefined), { winner: 'neutral', diff: 0 });
});

test('compareStat: unknown direction is treated as neutral', () => {
    assert.deepEqual(compareStat('sideways', 5, 3), { winner: 'neutral', diff: 2 });
});

// -- Penalty-aware match result --

test('matchResult: regular win (me > opp), penaltyWinner irrelevant', () => {
    assert.equal(matchResult(3, 1, null, 1), 'W');
    assert.equal(matchResult(3, 1, 2, 1), 'W');     // pen field ignored when regulation decided
    assert.equal(matchResult(3, 1, 'draw', 1), 'W');
});

test('matchResult: regular loss (me < opp)', () => {
    assert.equal(matchResult(0, 2, null, 1), 'L');
    assert.equal(matchResult(0, 2, 1, 1), 'L');     // pen field ignored
});

test('matchResult: regulation tie + my side wins penalties → W', () => {
    assert.equal(matchResult(2, 2, 1, 1), 'W');     // p1 wins shootout, asking from p1
    assert.equal(matchResult(2, 2, 2, 2), 'W');     // p2 wins shootout, asking from p2
});

test('matchResult: regulation tie + opponent wins penalties → L', () => {
    assert.equal(matchResult(2, 2, 2, 1), 'L');     // p2 wins, asking from p1
    assert.equal(matchResult(2, 2, 1, 2), 'L');     // p1 wins, asking from p2
});

test('matchResult: regulation tie + no penalty winner → D', () => {
    assert.equal(matchResult(1, 1, null, 1), 'D');
    assert.equal(matchResult(1, 1, undefined, 1), 'D');
    assert.equal(matchResult(1, 1, 'draw', 1), 'D'); // shootout itself drew
    assert.equal(matchResult(0, 0, null, 1), 'D');
});

test('matchResult: missing me or opp score → null', () => {
    assert.equal(matchResult(null, 2, null, 1), null);
    assert.equal(matchResult(2, null, null, 1), null);
    assert.equal(matchResult(undefined, undefined, 1, 1), null);
});

// -- matchResultsInOrder --

test('matchResultsInOrder: sorts and applies result per game', () => {
    const games = [
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: 1 }, // W for p1
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 3, player2Goals: 0, penaltyWinner: null },  // W for p1
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 2, player2Goals: 2, penaltyWinner: 2 }, // L for p1
        { id: 4, dateTime: '2025-01-04T00:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: null }  // D
    ];
    assert.deepEqual(matchResultsInOrder(games, 'player1Goals', 'player2Goals', 1),
        ['W', 'W', 'L', 'D']);
    // From p2 perspective the same history flips the penalty-decided games.
    assert.deepEqual(matchResultsInOrder(games, 'player2Goals', 'player1Goals', 2),
        ['L', 'L', 'W', 'D']);
});

test('matchResultsInOrder: non-array → []', () => {
    assert.deepEqual(matchResultsInOrder(null, 'a', 'b', 1), []);
    assert.deepEqual(matchResultsInOrder(undefined, 'a', 'b', 1), []);
});

test('matchResultsInOrder: missing scores → null entry preserves alignment', () => {
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: null, player2Goals: 1, penaltyWinner: null },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }
    ];
    assert.deepEqual(matchResultsInOrder(games, 'player1Goals', 'player2Goals', 1),
        [null, 'W']);
});

// -- Match-based current streaks (computeMatchStreaks now takes results) --

test('computeMatchStreaks: active winning streak counts consecutive Ws from the tail', () => {
    assert.deepEqual(computeMatchStreaks(['L', 'W', 'W', 'W']), {
        currentWinningStreak: 3,
        currentLosingStreak: 0
    });
});

test('computeMatchStreaks: active losing streak counts consecutive Ls from the tail', () => {
    assert.deepEqual(computeMatchStreaks(['W', 'L', 'L']), {
        currentWinningStreak: 0,
        currentLosingStreak: 2
    });
});

test('computeMatchStreaks: draw at the tail breaks both streaks', () => {
    assert.deepEqual(computeMatchStreaks(['W', 'W', 'D']), {
        currentWinningStreak: 0,
        currentLosingStreak: 0
    });
});

test('computeMatchStreaks: draw mid-history is a boundary, not a reset', () => {
    // W, D, W, W → only the two games after the draw count toward current.
    assert.deepEqual(computeMatchStreaks(['W', 'D', 'W', 'W']), {
        currentWinningStreak: 2,
        currentLosingStreak: 0
    });
});

test('computeMatchStreaks: a loss after wins ends the winning streak at the loss boundary', () => {
    assert.deepEqual(computeMatchStreaks(['W', 'W', 'L']), {
        currentWinningStreak: 0,
        currentLosingStreak: 1
    });
});

test('computeMatchStreaks: no games → 0s (no divide-by-zero paths)', () => {
    assert.deepEqual(computeMatchStreaks([]), {
        currentWinningStreak: 0,
        currentLosingStreak: 0
    });
});

test('computeMatchStreaks: non-array input → safe 0s', () => {
    assert.deepEqual(computeMatchStreaks(null),       { currentWinningStreak: 0, currentLosingStreak: 0 });
    assert.deepEqual(computeMatchStreaks(undefined),  { currentWinningStreak: 0, currentLosingStreak: 0 });
    assert.deepEqual(computeMatchStreaks('not-array'),{ currentWinningStreak: 0, currentLosingStreak: 0 });
});

test('computeMatchStreaks: null entries are skipped, not streak breakers', () => {
    assert.deepEqual(computeMatchStreaks(['W', null, 'W']), {
        currentWinningStreak: 2,
        currentLosingStreak: 0
    });
});

test('computeMatchStreaks: most-recent valid result sets the active streak type', () => {
    assert.deepEqual(computeMatchStreaks(['L', 'W']), {
        currentWinningStreak: 1,
        currentLosingStreak: 0
    });
});

test('computeMatchStreaks: penalty-rule end-to-end — regulation draws decided by pens count', () => {
    // p1 perspective. Tail sequence after sorting: regulation L, then a 2-2 with
    // p1 winning the shootout (counts as W), then a 1-1 drawn shootout (D).
    // Tail D → current winning = 0, current losing = 0. Without the penalty
    // rule the 2-2-with-pens game would also be a draw and the tail would still
    // give all zeros, so use a stronger example below.
    const games = [
        { id: 1, dateTime: '2025-03-01T12:00:00Z', player1Goals: 0, player2Goals: 1, penaltyWinner: null },  // L
        { id: 2, dateTime: '2025-03-02T12:00:00Z', player1Goals: 2, player2Goals: 2, penaltyWinner: 1 },     // W (penalties)
        { id: 3, dateTime: '2025-03-03T12:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: 1 }      // W (penalties)
    ];
    const results = matchResultsInOrder(games, 'player1Goals', 'player2Goals', 1);
    assert.deepEqual(results, ['L', 'W', 'W']);
    assert.deepEqual(computeMatchStreaks(results), {
        currentWinningStreak: 2,
        currentLosingStreak: 0
    });
    // From p2 perspective, both penalty wins flip to losses.
    const p2Results = matchResultsInOrder(games, 'player2Goals', 'player1Goals', 2);
    assert.deepEqual(p2Results, ['W', 'L', 'L']);
    assert.deepEqual(computeMatchStreaks(p2Results), {
        currentWinningStreak: 0,
        currentLosingStreak: 2
    });
});

// -- Longest match-based runs (penalty-aware) --

test('longestMatchRun: longest winning run with date span', () => {
    const games = [
        { id: 1, dateTime: '2025-04-01T12:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }, // W
        { id: 2, dateTime: '2025-04-02T12:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: 1 },    // W (pens)
        { id: 3, dateTime: '2025-04-03T12:00:00Z', player1Goals: 3, player2Goals: 0, penaltyWinner: null }, // W
        { id: 4, dateTime: '2025-04-04T12:00:00Z', player1Goals: 0, player2Goals: 1, penaltyWinner: null }  // L
    ];
    const run = longestMatchRun(games, 'player1Goals', 'player2Goals', 1, (r) => r === 'W');
    assert.equal(run.length, 3);
    assert.equal(run.startDate, '2025-04-01T12:00:00Z');
    assert.equal(run.endDate, '2025-04-03T12:00:00Z');
});

test('longestMatchRun: ties pick the most recent run', () => {
    const games = [
        { id: 1, dateTime: '2025-04-01T12:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }, // W
        { id: 2, dateTime: '2025-04-02T12:00:00Z', player1Goals: 3, player2Goals: 0, penaltyWinner: null }, // W
        { id: 3, dateTime: '2025-04-03T12:00:00Z', player1Goals: 0, player2Goals: 2, penaltyWinner: null }, // L
        { id: 4, dateTime: '2025-04-04T12:00:00Z', player1Goals: 1, player2Goals: 0, penaltyWinner: null }, // W
        { id: 5, dateTime: '2025-04-05T12:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: 1 }     // W (pens)
    ];
    const run = longestMatchRun(games, 'player1Goals', 'player2Goals', 1, (r) => r === 'W');
    assert.equal(run.length, 2);
    assert.equal(run.startDate, '2025-04-04T12:00:00Z'); // later 2-game run wins
    assert.equal(run.endDate, '2025-04-05T12:00:00Z');
});

test('longestMatchRun: penalty losses end winning runs', () => {
    // p1 view: W, W, then a 2-2 with p2 winning pens (counts as L for p1),
    // then W. Longest winning run is 2, not 3.
    const games = [
        { id: 1, dateTime: '2025-04-01T12:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null },
        { id: 2, dateTime: '2025-04-02T12:00:00Z', player1Goals: 3, player2Goals: 0, penaltyWinner: null },
        { id: 3, dateTime: '2025-04-03T12:00:00Z', player1Goals: 2, player2Goals: 2, penaltyWinner: 2 },   // L for p1
        { id: 4, dateTime: '2025-04-04T12:00:00Z', player1Goals: 1, player2Goals: 0, penaltyWinner: null }
    ];
    const winRun = longestMatchRun(games, 'player1Goals', 'player2Goals', 1, (r) => r === 'W');
    assert.equal(winRun.length, 2);
    assert.equal(winRun.startDate, '2025-04-01T12:00:00Z');
    assert.equal(winRun.endDate, '2025-04-02T12:00:00Z');
});

test('longestMatchRun: longest losing run', () => {
    const games = [
        { id: 1, dateTime: '2025-04-01T12:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }, // W
        { id: 2, dateTime: '2025-04-02T12:00:00Z', player1Goals: 0, player2Goals: 1, penaltyWinner: null }, // L
        { id: 3, dateTime: '2025-04-03T12:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: 2 },    // L (pens)
        { id: 4, dateTime: '2025-04-04T12:00:00Z', player1Goals: 0, player2Goals: 3, penaltyWinner: null }  // L
    ];
    const lossRun = longestMatchRun(games, 'player1Goals', 'player2Goals', 1, (r) => r === 'L');
    assert.equal(lossRun.length, 3);
    assert.equal(lossRun.startDate, '2025-04-02T12:00:00Z');
    assert.equal(lossRun.endDate, '2025-04-04T12:00:00Z');
});

test('longestMatchRun: a true draw breaks both winning and losing runs', () => {
    const games = [
        { id: 1, dateTime: '2025-04-01T12:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }, // W
        { id: 2, dateTime: '2025-04-02T12:00:00Z', player1Goals: 3, player2Goals: 0, penaltyWinner: null }, // W
        { id: 3, dateTime: '2025-04-03T12:00:00Z', player1Goals: 1, player2Goals: 1, penaltyWinner: null }, // D
        { id: 4, dateTime: '2025-04-04T12:00:00Z', player1Goals: 1, player2Goals: 0, penaltyWinner: null }  // W
    ];
    const winRun = longestMatchRun(games, 'player1Goals', 'player2Goals', 1, (r) => r === 'W');
    assert.equal(winRun.length, 2); // not 3 — the draw broke the run
});

test('longestMatchRun: empty / non-array → safe zero result', () => {
    assert.deepEqual(longestMatchRun([], 'a', 'b', 1, () => true),
        { length: 0, startDate: null, endDate: null });
    assert.deepEqual(longestMatchRun(null, 'a', 'b', 1, () => true),
        { length: 0, startDate: null, endDate: null });
});

// -- Longest run with date range --

const scoring = (s) => s > 0;
const scoreless = (s) => s === 0;

test('longestRun: basic scoring run returns length + ISO start/end', () => {
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 2 },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 3 },
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 1 },
        { id: 4, dateTime: '2025-01-04T00:00:00Z', player1Goals: 0 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 3);
    assert.equal(run.startDate, '2025-01-01T00:00:00Z');
    assert.equal(run.endDate, '2025-01-03T00:00:00Z');
});

test('longestRun: ties pick the MOST RECENT run', () => {
    // Two 3-game scoring runs separated by a scoreless game.
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 1 },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 1 },
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 1 },
        { id: 4, dateTime: '2025-01-04T00:00:00Z', player1Goals: 0 },
        { id: 5, dateTime: '2025-01-05T00:00:00Z', player1Goals: 2 },
        { id: 6, dateTime: '2025-01-06T00:00:00Z', player1Goals: 2 },
        { id: 7, dateTime: '2025-01-07T00:00:00Z', player1Goals: 2 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 3);
    assert.equal(run.startDate, '2025-01-05T00:00:00Z');
    assert.equal(run.endDate, '2025-01-07T00:00:00Z');
});

test('longestRun: length 0 → null dates (no run at all)', () => {
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 0 },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 0 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 0);
    assert.equal(run.startDate, null);
    assert.equal(run.endDate, null);
});

test('longestRun: empty input → zeros and nulls', () => {
    assert.deepEqual(longestRun([], 'player1Goals', scoring),
        { length: 0, startDate: null, endDate: null });
});

test('longestRun: non-array input → safe zeros', () => {
    assert.deepEqual(longestRun(null, 'player1Goals', scoring),
        { length: 0, startDate: null, endDate: null });
    assert.deepEqual(longestRun(undefined, 'player1Goals', scoring),
        { length: 0, startDate: null, endDate: null });
});

test('longestRun: null scores are skipped, not treated as streak breakers', () => {
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 2 },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: null },
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 3 },
        { id: 4, dateTime: '2025-01-04T00:00:00Z', player1Goals: 1 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 3); // Three real scoring games; null ignored.
    assert.equal(run.startDate, '2025-01-01T00:00:00Z');
    assert.equal(run.endDate, '2025-01-04T00:00:00Z');
});

test('longestRun: input sorted internally — unsorted games work', () => {
    const games = [
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 1 },
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 2 },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 3 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 3);
    assert.equal(run.startDate, '2025-01-01T00:00:00Z');
    assert.equal(run.endDate, '2025-01-03T00:00:00Z');
});

test('longestRun: single-game run → startDate === endDate', () => {
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 0 },
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 2 },
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 0 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 1);
    assert.equal(run.startDate, run.endDate);
    assert.equal(run.startDate, '2025-01-02T00:00:00Z');
});

test('longestRun: games missing dateTime → length counted, dates can be null', () => {
    const games = [
        { id: 1, player1Goals: 2 },
        { id: 2, player1Goals: 3 }
    ];
    const run = longestRun(games, 'player1Goals', scoring);
    assert.equal(run.length, 2);
    assert.equal(run.startDate, null);
    assert.equal(run.endDate, null);
});

test('formatDateShort: renders M/D/YYYY with no leading zeros, no month name', () => {
    assert.equal(formatDateShort('2026-04-24T12:00:00Z'), '4/24/2026');
    assert.equal(formatDateShort('2025-01-03T12:00:00Z'), '1/3/2025');
    assert.equal(formatDateShort('2026-10-07T12:00:00Z'), '10/7/2026');
    assert.equal(formatDateShort('2026-12-31T12:00:00Z'), '12/31/2026');
});

test('formatDateShort: bad input → null (no NaN/Invalid Date leaks)', () => {
    assert.equal(formatDateShort(null), null);
    assert.equal(formatDateShort(undefined), null);
    assert.equal(formatDateShort(''), null);
    assert.equal(formatDateShort('not-a-date'), null);
});

test('formatRangeText: multi-game run → "(M/D/YYYY – M/D/YYYY)"', () => {
    const text = formatRangeText({
        length: 14,
        startDate: '2026-04-10T12:00:00Z',
        endDate: '2026-04-24T12:00:00Z'
    });
    assert.equal(text, '(4/10/2026 – 4/24/2026)');
});

test('formatRangeText: single-game run collapses to "(M/D/YYYY)"', () => {
    const text = formatRangeText({
        length: 1,
        startDate: '2026-04-24T12:00:00Z',
        endDate: '2026-04-24T12:00:00Z'
    });
    assert.equal(text, '(4/24/2026)');
});

test('formatRangeText: length 0 or missing dates → null', () => {
    assert.equal(formatRangeText({ length: 0, startDate: null, endDate: null }), null);
    assert.equal(formatRangeText({ length: 3, startDate: null, endDate: '2026-04-10T12:00:00Z' }), null);
    assert.equal(formatRangeText({ length: 3, startDate: '2026-04-10T12:00:00Z', endDate: null }), null);
    assert.equal(formatRangeText(null), null);
    assert.equal(formatRangeText(undefined), null);
});

test('formatRangeText: invalid dates → null (no Invalid Date string)', () => {
    const text = formatRangeText({ length: 3, startDate: 'not-a-date', endDate: 'also-bad' });
    assert.equal(text, null);
});

test('formatRangeText: reversed range is swapped, never displayed backwards', () => {
    const text = formatRangeText({
        length: 3,
        startDate: '2026-04-24T12:00:00Z', // later
        endDate: '2026-04-10T12:00:00Z'    // earlier
    });
    assert.equal(text, '(4/10/2026 – 4/24/2026)');
});

// -- Highest-score game (with opponent score and date) --

test('highestScoreGame: returns highest me-score with opponent and date', () => {
    const games = [
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: 2, player2Goals: 1 },
        { id: 2, dateTime: '2025-01-12T12:00:00Z', player1Goals: 5, player2Goals: 3 },
        { id: 3, dateTime: '2025-01-14T12:00:00Z', player1Goals: 3, player2Goals: 2 }
    ];
    assert.deepEqual(highestScoreGame(games, 'player1Goals', 'player2Goals'), {
        score: 5,
        opponentScore: 3,
        date: '2025-01-12T12:00:00Z'
    });
});

test('highestScoreGame: from the opponent\'s perspective, me/opp keys swap', () => {
    const games = [
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: 2, player2Goals: 4 },
        { id: 2, dateTime: '2025-01-12T12:00:00Z', player1Goals: 5, player2Goals: 3 }
    ];
    // Nikita (player2) perspective — highest is 4 from game 1 where Dean scored 2.
    assert.deepEqual(highestScoreGame(games, 'player2Goals', 'player1Goals'), {
        score: 4,
        opponentScore: 2,
        date: '2025-01-10T12:00:00Z'
    });
});

test('highestScoreGame: ties resolve to the MOST RECENT game', () => {
    const games = [
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: 4, player2Goals: 2 },
        { id: 2, dateTime: '2025-01-15T12:00:00Z', player1Goals: 4, player2Goals: 0 },
        { id: 3, dateTime: '2025-01-20T12:00:00Z', player1Goals: 4, player2Goals: 1 }
    ];
    const best = highestScoreGame(games, 'player1Goals', 'player2Goals');
    assert.equal(best.score, 4);
    assert.equal(best.opponentScore, 1);
    assert.equal(best.date, '2025-01-20T12:00:00Z');
});

test('highestScoreGame: unsorted input is sorted internally', () => {
    const games = [
        { id: 3, dateTime: '2025-01-20T12:00:00Z', player1Goals: 4, player2Goals: 0 },
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: 5, player2Goals: 3 },
        { id: 2, dateTime: '2025-01-15T12:00:00Z', player1Goals: 2, player2Goals: 1 }
    ];
    assert.deepEqual(highestScoreGame(games, 'player1Goals', 'player2Goals'), {
        score: 5,
        opponentScore: 3,
        date: '2025-01-10T12:00:00Z'
    });
});

test('highestScoreGame: empty games → safe zero/nulls, no NaN', () => {
    assert.deepEqual(highestScoreGame([], 'player1Goals', 'player2Goals'), {
        score: 0, opponentScore: null, date: null
    });
});

test('highestScoreGame: non-array input → safe zero/nulls', () => {
    assert.deepEqual(highestScoreGame(null, 'a', 'b'),
        { score: 0, opponentScore: null, date: null });
    assert.deepEqual(highestScoreGame(undefined, 'a', 'b'),
        { score: 0, opponentScore: null, date: null });
});

test('highestScoreGame: null me-scores are skipped', () => {
    const games = [
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: null, player2Goals: 3 },
        { id: 2, dateTime: '2025-01-12T12:00:00Z', player1Goals: 4, player2Goals: 1 }
    ];
    assert.deepEqual(highestScoreGame(games, 'player1Goals', 'player2Goals'), {
        score: 4, opponentScore: 1, date: '2025-01-12T12:00:00Z'
    });
});

test('highestScoreGame: null opponent score is preserved on the result', () => {
    const games = [
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: 5, player2Goals: null }
    ];
    assert.deepEqual(highestScoreGame(games, 'player1Goals', 'player2Goals'), {
        score: 5, opponentScore: null, date: '2025-01-10T12:00:00Z'
    });
});

test('formatMatchText: full detail → "(M/D/YYYY, me–opp)"', () => {
    assert.equal(formatMatchText({
        score: 5, opponentScore: 3, date: '2025-01-12T12:00:00Z'
    }), '(1/12/2025, 5–3)');
});

test('formatMatchText: score of 0 is still valid (shutout loss)', () => {
    assert.equal(formatMatchText({
        score: 0, opponentScore: 2, date: '2025-01-12T12:00:00Z'
    }), '(1/12/2025, 0–2)');
});

test('formatMatchText: missing date → null (UI falls back to bare value)', () => {
    assert.equal(formatMatchText({ score: 5, opponentScore: 3, date: null }), null);
    assert.equal(formatMatchText({ score: 5, opponentScore: 3, date: 'not-a-date' }), null);
});

test('formatMatchText: missing opponent score → null', () => {
    assert.equal(formatMatchText({
        score: 5, opponentScore: null, date: '2025-01-12T12:00:00Z'
    }), null);
    assert.equal(formatMatchText({
        score: 5, opponentScore: NaN, date: '2025-01-12T12:00:00Z'
    }), null);
});

test('formatMatchText: null/empty detail → null', () => {
    assert.equal(formatMatchText(null), null);
    assert.equal(formatMatchText(undefined), null);
    assert.equal(formatMatchText({}), null);
});

test('highestScoreGame + formatMatchText: end-to-end produces the displayed string', () => {
    const games = [
        { id: 1, dateTime: '2025-01-10T12:00:00Z', player1Goals: 2, player2Goals: 1 },
        { id: 2, dateTime: '2025-01-12T12:00:00Z', player1Goals: 5, player2Goals: 3 },
        { id: 3, dateTime: '2025-01-14T12:00:00Z', player1Goals: 1, player2Goals: 0 }
    ];
    const best = highestScoreGame(games, 'player1Goals', 'player2Goals');
    assert.equal(formatMatchText(best), '(1/12/2025, 5–3)');
});

test('longestRun + formatRangeText: end-to-end produces the displayed string', () => {
    // Unsorted input, 3-game scoring run mid-history.
    const games = [
        { id: 2, dateTime: '2026-04-15T12:00:00Z', player1Goals: 2 },
        { id: 1, dateTime: '2026-04-10T12:00:00Z', player1Goals: 1 },
        { id: 3, dateTime: '2026-04-20T12:00:00Z', player1Goals: 3 },
        { id: 4, dateTime: '2026-04-24T12:00:00Z', player1Goals: 0 }
    ];
    const run = longestRun(games, 'player1Goals', (s) => s > 0);
    assert.equal(run.length, 3);
    assert.equal(formatRangeText(run), '(4/10/2026 – 4/20/2026)');
});

test('longestRun: works for scoreless predicate too', () => {
    const games = [
        { id: 1, dateTime: '2025-02-01T00:00:00Z', player1Goals: 2 },
        { id: 2, dateTime: '2025-02-02T00:00:00Z', player1Goals: 0 },
        { id: 3, dateTime: '2025-02-03T00:00:00Z', player1Goals: 0 },
        { id: 4, dateTime: '2025-02-04T00:00:00Z', player1Goals: 0 },
        { id: 5, dateTime: '2025-02-05T00:00:00Z', player1Goals: 1 }
    ];
    const run = longestRun(games, 'player1Goals', scoreless);
    assert.equal(run.length, 3);
    assert.equal(run.startDate, '2025-02-02T00:00:00Z');
    assert.equal(run.endDate, '2025-02-04T00:00:00Z');
});

test('computeMatchStreaks + matchResultsInOrder: end-to-end from a games array', () => {
    // Dean perspective: W, W, L, W, W, W → current winning = 3.
    const games = [
        { id: 1, dateTime: '2025-01-01T00:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }, // W
        { id: 2, dateTime: '2025-01-02T00:00:00Z', player1Goals: 3, player2Goals: 0, penaltyWinner: null }, // W
        { id: 3, dateTime: '2025-01-03T00:00:00Z', player1Goals: 1, player2Goals: 4, penaltyWinner: null }, // L
        { id: 4, dateTime: '2025-01-04T00:00:00Z', player1Goals: 2, player2Goals: 1, penaltyWinner: null }, // W
        { id: 5, dateTime: '2025-01-05T00:00:00Z', player1Goals: 3, player2Goals: 2, penaltyWinner: null }, // W
        { id: 6, dateTime: '2025-01-06T00:00:00Z', player1Goals: 1, player2Goals: 0, penaltyWinner: null }  // W
    ];
    const p1Results = matchResultsInOrder(games, 'player1Goals', 'player2Goals', 1);
    const p2Results = matchResultsInOrder(games, 'player2Goals', 'player1Goals', 2);
    assert.deepEqual(computeMatchStreaks(p1Results), {
        currentWinningStreak: 3,
        currentLosingStreak: 0
    });
    // From the opponent's perspective the same history is L, L, W, L, L, L.
    assert.deepEqual(computeMatchStreaks(p2Results), {
        currentWinningStreak: 0,
        currentLosingStreak: 3
    });
});
