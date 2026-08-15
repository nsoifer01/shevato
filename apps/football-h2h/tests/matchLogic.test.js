'use strict';

// Pin timezone so date-based sort assertions stay deterministic across CI/dev.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    compareGames,
    sortGames,
    nextGameId,
    nextGameNumber,
    normalizePenaltyWinner,
    parseImportPayload,
} = require('../js/match-logic.js');

// --- compareGames -----------------------------------------------------

test('compareGames: unknown column returns 0 (stable)', () => {
    assert.equal(compareGames({ id: 1 }, { id: 2 }, 'nonsense', 'asc'), 0);
});

test('compareGames: numeric id ascending', () => {
    assert.equal(compareGames({ id: 1 }, { id: 2 }, 'game', 'asc'), -1);
    assert.equal(compareGames({ id: 2 }, { id: 1 }, 'game', 'asc'), 1);
    assert.equal(compareGames({ id: 1 }, { id: 1 }, 'game', 'asc'), 0);
});

test('compareGames: numeric id descending', () => {
    assert.equal(compareGames({ id: 1 }, { id: 2 }, 'game', 'desc'), 1);
    assert.equal(compareGames({ id: 2 }, { id: 1 }, 'game', 'desc'), -1);
});

test('compareGames: missing dateTime sorts as epoch (oldest)', () => {
    const a = { dateTime: '2026-04-01T00:00:00Z' };
    const b = {}; // no dateTime
    assert.equal(compareGames(a, b, 'date', 'asc'), 1);   // a is later
    assert.equal(compareGames(b, a, 'date', 'asc'), -1);  // b is "earlier"
});

test('compareGames: player1Goals ascending', () => {
    assert.equal(compareGames({ player1Goals: 1 }, { player1Goals: 3 }, 'player1', 'asc'), -1);
});

test('compareGames: player2Goals descending', () => {
    assert.equal(compareGames({ player2Goals: 1 }, { player2Goals: 3 }, 'player2', 'desc'), 1);
});

// --- sortGames --------------------------------------------------------

test('sortGames: empty / non-array returns []', () => {
    assert.deepEqual(sortGames([], 'date', 'asc'), []);
    assert.deepEqual(sortGames(null, 'date', 'asc'), []);
    assert.deepEqual(sortGames(undefined, 'date', 'asc'), []);
});

test('sortGames: does not mutate the input array', () => {
    const games = [{ id: 2 }, { id: 1 }];
    const before = games.slice();
    sortGames(games, 'game', 'asc');
    assert.deepEqual(games, before);
});

test('sortGames: by date desc puts newest first, missing dateTime last', () => {
    const games = [
        { id: 'old', dateTime: '2026-04-01T00:00:00Z' },
        { id: 'noDate' },
        { id: 'new', dateTime: '2026-04-30T00:00:00Z' },
    ];
    const sorted = sortGames(games, 'date', 'desc');
    assert.deepEqual(sorted.map(g => g.id), ['new', 'old', 'noDate']);
});

// Negative goal counts can no longer be written (submitSidebarGame and the
// edit modal both reject them; see sidebarAddGame.test.js), but rows stored
// before that fix may still carry them. These tests pin the comparator's
// behaviour for such legacy rows: it is a total order on the numbers, so
// negatives sort below zero rather than being treated as missing.
test('sortGames: by player1 asc handles negative + zero goals', () => {
    const games = [
        { player1Goals: 3 },
        { player1Goals: 0 },
        { player1Goals: -2 },
        { player1Goals: 1 },
        { player1Goals: -1 },
    ];
    const sorted = sortGames(games, 'player1', 'asc');
    assert.deepEqual(sorted.map(g => g.player1Goals), [-2, -1, 0, 1, 3]);
});

test('sortGames: by player2 desc puts the negatives last', () => {
    const games = [{ player2Goals: -1 }, { player2Goals: 2 }, { player2Goals: 0 }];
    const sorted = sortGames(games, 'player2', 'desc');
    assert.deepEqual(sorted.map(g => g.player2Goals), [2, 0, -1]);
});

test('compareGames: a negative goal count is ordered below zero, not treated as missing', () => {
    assert.equal(compareGames({ player1Goals: -1 }, { player1Goals: 0 }, 'player1', 'asc'), -1);
    assert.equal(compareGames({ player1Goals: 0 }, { player1Goals: -1 }, 'player1', 'asc'), 1);
    assert.equal(compareGames({ player2Goals: -3 }, { player2Goals: -1 }, 'player2', 'asc'), -1);
    assert.equal(compareGames({ player2Goals: -2 }, { player2Goals: -2 }, 'player2', 'asc'), 0);
});

// --- nextGameId / nextGameNumber ---------------------------------------
// Both ride the same max(existing) + 1 rule. nextGameNumber is what the live
// add path (submitSidebarGame) stamps on new games; it additionally floors
// the max at games.length because rows WITHOUT a gameNumber render their
// 1-based position, so a fresh number must clear the positional range too.

test('nextGameId: empty / non-array returns 1', () => {
    assert.equal(nextGameId([]), 1);
    assert.equal(nextGameId(null), 1);
    assert.equal(nextGameId(undefined), 1);
});

test('nextGameId: returns max(id) + 1', () => {
    assert.equal(nextGameId([{ id: 1 }, { id: 5 }, { id: 3 }]), 6);
});

test('nextGameId: skips non-numeric / missing IDs (so partial imports are safe)', () => {
    assert.equal(
        nextGameId([{ id: 1 }, { id: 'corrupt' }, { id: NaN }, { id: 4 }, {}]),
        5,
    );
});

test('nextGameId: never yields NaN even when every id is bad', () => {
    const result = nextGameId([{ id: 'a' }, { id: null }, {}]);
    assert.ok(Number.isFinite(result));
    assert.equal(result, 1);
});

test('nextGameNumber: empty / non-array returns 1', () => {
    assert.equal(nextGameNumber([]), 1);
    assert.equal(nextGameNumber(null), 1);
    assert.equal(nextGameNumber(undefined), 1);
});

test('nextGameNumber: max(gameNumber) + 1, so a deleted game never frees its number', () => {
    // Numbers in use after deleting the middle of three games: 1 and 3.
    assert.equal(nextGameNumber([{ gameNumber: 1 }, { gameNumber: 3 }]), 4);
});

test('nextGameNumber: rows without a gameNumber render positionally, so the length floors the max', () => {
    // Three legacy rows with no gameNumber display as 1, 2, 3; the next
    // number must be 4, not 1.
    assert.equal(nextGameNumber([{}, {}, {}]), 4);
    assert.equal(nextGameNumber([{ gameNumber: 2 }, {}, {}]), 4);
});

test('nextGameNumber: skips non-numeric values instead of yielding NaN', () => {
    assert.equal(nextGameNumber([{ gameNumber: 'corrupt' }, { gameNumber: 5 }]), 6);
});

// --- normalizePenaltyWinner --------------------------------------------

test('normalizePenaltyWinner: canonical values pass through untouched', () => {
    assert.equal(normalizePenaltyWinner(1), 1);
    assert.equal(normalizePenaltyWinner(2), 2);
    assert.equal(normalizePenaltyWinner('draw'), 'draw');
    assert.equal(normalizePenaltyWinner(null), null);
});

test('normalizePenaltyWinner: legacy string "1" / "2" become numbers', () => {
    assert.equal(normalizePenaltyWinner('1'), 1);
    assert.equal(normalizePenaltyWinner('2'), 2);
});

test('normalizePenaltyWinner: anything else collapses to null (no shootout)', () => {
    for (const junk of [undefined, '', '3', 3, 'player1', true, {}, []]) {
        assert.equal(normalizePenaltyWinner(junk), null, `for ${JSON.stringify(junk)}`);
    }
});

// --- parseImportPayload ----------------------------------------------

test('parseImportPayload: rejects null / non-objects', () => {
    assert.equal(parseImportPayload(null).ok, false);
    assert.equal(parseImportPayload(undefined).ok, false);
    assert.equal(parseImportPayload('string').ok, false);
    assert.equal(parseImportPayload(42).ok, false);
});

test('parseImportPayload: rejects payload missing games array', () => {
    assert.equal(parseImportPayload({}).ok, false);
    assert.equal(parseImportPayload({ games: null }).ok, false);
    assert.equal(parseImportPayload({ games: 'not an array' }).ok, false);
});

test('parseImportPayload: accepts minimal valid payload, defaults player names', () => {
    const out = parseImportPayload({ games: [] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.games, []);
    assert.equal(out.rejected, 0);
    assert.deepEqual(out.players, { player1: 'Player 1', player2: 'Player 2' });
});

test('parseImportPayload: accepts payload with players block', () => {
    const out = parseImportPayload({
        games: [{ id: 1, player1Goals: 2, player2Goals: 1 }],
        players: { player1: 'Alice', player2: 'Bob' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.games.length, 1);
    assert.equal(out.players.player1, 'Alice');
    assert.equal(out.players.player2, 'Bob');
});

test('parseImportPayload: non-string player names fall back to defaults', () => {
    const out = parseImportPayload({
        games: [],
        players: { player1: 42, player2: null },
    });
    assert.equal(out.ok, true);
    assert.equal(out.players.player1, 'Player 1');
    assert.equal(out.players.player2, 'Player 2');
});

// --- parseImportPayload: per-game row validation ------------------------
// Rows are validated so a malformed game can never reach the stats counters
// (a scoreless row used to render literal NaN as Goals/Game).

test('parseImportPayload: a row missing a score is dropped and counted as rejected', () => {
    const out = parseImportPayload({
        games: [
            { id: 1, player1Goals: 2, player2Goals: 1 },
            { id: 2, note: 'no scores at all' },
        ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.games.length, 1);
    assert.equal(out.games[0].id, 1);
    assert.equal(out.rejected, 1);
});

test('parseImportPayload: negative, fractional and non-numeric scores are rejected', () => {
    const bad = [
        { id: 1, player1Goals: -3, player2Goals: 1 },
        { id: 2, player1Goals: 1.5, player2Goals: 0 },
        { id: 3, player1Goals: 'abc', player2Goals: 0 },
        { id: 4, player1Goals: null, player2Goals: 0 },
        { id: 5, player1Goals: [], player2Goals: 0 },
        'not even an object',
        null,
    ];
    const out = parseImportPayload({ games: bad });
    assert.equal(out.ok, true);
    assert.deepEqual(out.games, []);
    assert.equal(out.rejected, bad.length);
});

test('parseImportPayload: numeric-string scores are coerced to numbers', () => {
    const out = parseImportPayload({ games: [{ id: 1, player1Goals: '2', player2Goals: '0' }] });
    assert.equal(out.rejected, 0);
    assert.equal(out.games[0].player1Goals, 2);
    assert.equal(typeof out.games[0].player1Goals, 'number');
    assert.equal(out.games[0].player2Goals, 0);
});

test('parseImportPayload: penaltyWinner is normalized on the way in', () => {
    const out = parseImportPayload({
        games: [
            { id: 1, player1Goals: 1, player2Goals: 1, penaltyWinner: '1' },
            { id: 2, player1Goals: 2, player2Goals: 2, penaltyWinner: 'draw' },
            { id: 3, player1Goals: 0, player2Goals: 0, penaltyWinner: 'player1' },
            { id: 4, player1Goals: 3, player2Goals: 1 },
        ],
    });
    assert.equal(out.rejected, 0);
    assert.equal(out.games[0].penaltyWinner, 1);
    assert.equal(typeof out.games[0].penaltyWinner, 'number');
    assert.equal(out.games[1].penaltyWinner, 'draw');
    assert.equal(out.games[2].penaltyWinner, null, 'unknown junk collapses to null');
    assert.equal(out.games[3].penaltyWinner, null, 'absent stays null');
});

test('parseImportPayload: other row fields come across verbatim, input rows are not mutated', () => {
    const row = { id: 7, player1Goals: '1', player2Goals: 0, dateTime: '2026-01-01T00:00:00Z', note: 'kept' };
    const out = parseImportPayload({ games: [row] });
    assert.equal(out.games[0].dateTime, '2026-01-01T00:00:00Z');
    assert.equal(out.games[0].note, 'kept');
    assert.equal(row.player1Goals, '1', 'the caller\'s payload must not be mutated');
});
