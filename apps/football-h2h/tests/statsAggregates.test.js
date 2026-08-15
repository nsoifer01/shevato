'use strict';

// H2H aggregate counting, driven through the live updateStatisticsWithData()
// in js/football-h2h.js (what the H2H Stats and General Stats tabs render).
// The stat elements are stub nodes; the numbers asserted are the ones the app
// writes into them.
//
// The last block is a drift guard: the same win/draw rule is implemented twice
// in this app (this counter, and playerStats.matchResult which drives the
// comparison table, streak badge and form strip). They must agree game for
// game or the two tabs contradict each other.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, makeElement, loadInto } = require('./vm-harness.js');
const { matchResult } = require('../js/playerStats.js');

const STAT_IDS = [
    'totalGames',
    'player1Wins',
    'player2Wins',
    'player1Wins90',
    'player2Wins90',
    'player1PenaltyWins',
    'player2PenaltyWins',
    'totalDraws',
    'goalsPerGame',
    'penaltyShootouts',
];

// updateStatisticsWithData console.warn's about the 90-minute cards whenever
// they are absent, which they always are here.
const quietConsole = Object.assign(Object.create(null), console, { warn: () => {} });

function aggregates(games) {
    const elements = {};
    for (const id of STAT_IDS) elements[id] = makeElement();

    const ctx = makeContext({ elements, console: quietConsole });
    // Same load order as index.html: the aggregate's missing-score guard
    // calls through window.FootballPlayerStats.toScore.
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'football-h2h.js');
    ctx.window.games = games;
    ctx.updateStatisticsWithData(games);

    const out = {};
    for (const id of STAT_IDS) out[id] = elements[id].textContent;
    return out;
}

function game(id, p1, p2, penaltyWinner = null) {
    return {
        id,
        dateTime: `2026-05-${String(id).padStart(2, '0')}T12:00:00Z`,
        player1Goals: p1,
        player2Goals: p2,
        penaltyWinner,
    };
}

// --- counting ----------------------------------------------------------

test('aggregates: no games leaves every counter at zero, goals/game at 0', () => {
    const a = aggregates([]);
    assert.equal(a.totalGames, 0);
    assert.equal(a.player1Wins, 0);
    assert.equal(a.player2Wins, 0);
    assert.equal(a.totalDraws, 0);
    assert.equal(a.penaltyShootouts, 0);
    assert.equal(a.goalsPerGame, '0');
});

test('aggregates: regulation wins count for both the total and the 90-minute tally', () => {
    const a = aggregates([game(1, 3, 1), game(2, 0, 2), game(3, 2, 1)]);
    assert.equal(a.player1Wins, 2);
    assert.equal(a.player2Wins, 1);
    assert.equal(a.player1Wins90, 2);
    assert.equal(a.player2Wins90, 1);
    assert.equal(a.player1PenaltyWins, 0);
    assert.equal(a.player2PenaltyWins, 0);
    assert.equal(a.totalDraws, 0);
    assert.equal(a.penaltyShootouts, 0);
});

test('aggregates: a shootout win counts as a win but NOT as a 90-minute win', () => {
    const a = aggregates([game(1, 2, 2, 1), game(2, 1, 1, 2)]);
    assert.equal(a.player1Wins, 1);
    assert.equal(a.player2Wins, 1);
    assert.equal(a.player1Wins90, 0, 'a shootout is not a 90-minute win');
    assert.equal(a.player2Wins90, 0);
    assert.equal(a.player1PenaltyWins, 1);
    assert.equal(a.player2PenaltyWins, 1);
    assert.equal(a.totalDraws, 0, 'a decided shootout is not a draw');
    assert.equal(a.penaltyShootouts, 2);
});

test('aggregates: a drawn shootout counts as a draw AND as a shootout', () => {
    const a = aggregates([game(1, 1, 1, 'draw')]);
    assert.equal(a.totalDraws, 1);
    assert.equal(a.penaltyShootouts, 1);
    assert.equal(a.player1Wins, 0);
    assert.equal(a.player2Wins, 0);
});

test('aggregates: a level score with no shootout is a plain draw', () => {
    const a = aggregates([game(1, 0, 0), game(2, 2, 2, null)]);
    assert.equal(a.totalDraws, 2);
    assert.equal(a.penaltyShootouts, 0, 'no shootout was played');
});

test('aggregates: goals per game - whole numbers drop the decimal, others keep one', () => {
    assert.equal(aggregates([game(1, 2, 2, 'draw'), game(2, 3, 1)]).goalsPerGame, '4');
    assert.equal(aggregates([game(1, 2, 1), game(2, 1, 0)]).goalsPerGame, '2');
    assert.equal(aggregates([game(1, 1, 1, 'draw'), game(2, 3, 0)]).goalsPerGame, '2.5');
    assert.equal(aggregates([game(1, 1, 0)]).goalsPerGame, '1');
});

test('aggregates: goals per game counts both sides, including 0-0', () => {
    const a = aggregates([game(1, 0, 0), game(2, 0, 0), game(3, 4, 2)]);
    assert.equal(a.totalGames, 3);
    assert.equal(a.goalsPerGame, '2');
});

test('aggregates: a game with missing goals must not print NaN as goals/game', () => {
    // The scoreless row is skipped from every counter; goals/game averages
    // over the counted rows only (the same rows matchResult scores).
    const a = aggregates([game(1, 2, 1), { id: 2, dateTime: '2026-05-02T12:00:00Z' }]);
    assert.notEqual(a.goalsPerGame, 'NaN');
    assert.equal(a.goalsPerGame, '3');
    assert.equal(a.player1Wins, 1);
    assert.equal(a.totalDraws, 0, 'a scoreless row is skipped, not counted as a draw');
    assert.equal(a.totalGames, 2, 'the header count still reflects every stored row');
});

test('aggregates: null / empty-string scores are skipped the same way toScore skips them', () => {
    const a = aggregates([
        game(1, 1, 0),
        { id: 2, dateTime: '2026-05-02T12:00:00Z', player1Goals: null, player2Goals: 2 },
        { id: 3, dateTime: '2026-05-03T12:00:00Z', player1Goals: '', player2Goals: 1 },
    ]);
    assert.equal(a.player1Wins, 1);
    assert.equal(a.player2Wins, 0);
    assert.equal(a.totalDraws, 0);
    assert.equal(a.goalsPerGame, '1');
});

// --- drift guard: this counter vs playerStats.matchResult ---------------

// Same rule, computed the other way: 'W' from player 1's perspective is a
// player-1 win, 'L' is a player-2 win, 'D' is a draw.
function expectedFromMatchResult(games) {
    let player1Wins = 0;
    let player2Wins = 0;
    let draws = 0;
    for (const g of games) {
        const r = matchResult(g.player1Goals, g.player2Goals, g.penaltyWinner, 1);
        if (r === 'W') player1Wins += 1;
        else if (r === 'L') player2Wins += 1;
        else if (r === 'D') draws += 1;
    }
    return { player1Wins, player2Wins, draws };
}

function assertNoDrift(games) {
    const a = aggregates(games);
    const expected = expectedFromMatchResult(games);
    assert.deepEqual(
        { player1Wins: a.player1Wins, player2Wins: a.player2Wins, draws: a.totalDraws },
        expected,
        'H2H Stats counters and playerStats.matchResult disagree on the same games',
    );
    // The two perspectives of matchResult must also mirror each other.
    const mirrored = games.map((g) => matchResult(g.player2Goals, g.player1Goals, g.penaltyWinner, 2));
    assert.equal(mirrored.filter((r) => r === 'W').length, a.player2Wins);
    assert.equal(mirrored.filter((r) => r === 'L').length, a.player1Wins);
}

test('drift guard: regulation results agree with matchResult', () => {
    assertNoDrift([game(1, 3, 1), game(2, 0, 2), game(3, 1, 0), game(4, 0, 5)]);
});

test('drift guard: shootout wins agree with matchResult', () => {
    assertNoDrift([game(1, 2, 2, 1), game(2, 1, 1, 2), game(3, 0, 0, 1)]);
});

test('drift guard: drawn shootouts and plain draws agree with matchResult', () => {
    assertNoDrift([game(1, 1, 1, 'draw'), game(2, 2, 2, null), game(3, 0, 0)]);
});

test('drift guard: a full mixed history agrees with matchResult', () => {
    assertNoDrift([
        game(1, 3, 1),
        game(2, 1, 1, 1),
        game(3, 0, 0, 'draw'),
        game(4, 2, 4),
        game(5, 2, 2, 2),
        game(6, 1, 1),
        game(7, 5, 0),
        game(8, 0, 0, 2),
    ]);
});

test('drift guard: a string penaltyWinner is read the same way by both counters', () => {
    // Legacy rows carrying '1' / '2' (a removed modal path stored the raw
    // select string) are normalized on load AND both readers coerce with
    // Number(), so even an un-migrated row counts identically on both tabs.
    assertNoDrift([game(1, 1, 1, '1'), game(2, 2, 2, '2')]);
    // And both read a string '1' as a player-1 penalty win, specifically.
    const a = aggregates([game(1, 1, 1, '1')]);
    assert.equal(a.player1Wins, 1);
    assert.equal(a.player1PenaltyWins, 1);
    assert.equal(a.player2Wins, 0);
    assert.equal(a.totalDraws, 0);
    assert.equal(a.penaltyShootouts, 1);
});

test('drift guard: rows with a missing score are skipped by both counters', () => {
    assertNoDrift([
        game(1, 2, 1),
        { id: 2, dateTime: '2026-05-02T12:00:00Z', player1Goals: null, player2Goals: 1 },
        { id: 3, dateTime: '2026-05-03T12:00:00Z' },
    ]);
});
