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
    parseGoals,
    isDraw,
    assignIds,
    cleanPlayerName,
    cleanTeamName,
    cleanNote,
} = require('../js/match-logic.js');

// --- compareGames -----------------------------------------------------

test('compareGames: unknown column returns 0 (stable)', () => {
    assert.equal(compareGames({ id: 1 }, { id: 2 }, 'nonsense', 'asc'), 0);
});

// Changed 2026-08-23: these used to pin "Game #" sorting by `id`. The column
// DISPLAYS gameNumber, and id only coincides with it for games added live;
// imports and undo-restored rows sorted in an order the user could not see
// (first click showed 10,9,...,1 under an ascending indicator). The
// comparator now sorts by gameNumber, falling back to id for rows without one.
test('compareGames: "game" sorts by the displayed gameNumber, not the id', () => {
    const a = { id: 200, gameNumber: 1 };
    const b = { id: 100, gameNumber: 2 };
    assert.equal(compareGames(a, b, 'game', 'asc'), -1);
    assert.equal(compareGames(b, a, 'game', 'asc'), 1);
    assert.equal(compareGames(a, { id: 5, gameNumber: 1 }, 'game', 'asc'), 0);
    assert.equal(compareGames(a, b, 'game', 'desc'), 1);
});

test('compareGames: rows without a gameNumber fall back to their id', () => {
    assert.equal(compareGames({ id: 1 }, { id: 2 }, 'game', 'asc'), -1);
    assert.equal(compareGames({ id: 2 }, { id: 1 }, 'game', 'desc'), -1);
});

test('sortGames: a dataset with ids descending against gameNumbers sorts 1..n by game', () => {
    const games = [5, 4, 3, 2, 1].map((n, i) => ({ id: 100 - i, gameNumber: n }));
    assert.deepEqual(sortGames(games, 'game', 'asc').map((g) => g.gameNumber), [1, 2, 3, 4, 5]);
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

// --- parseGoals / isDraw -----------------------------------------------
// One rule for every write path: plain digits, 0..99.

test('parseGoals: plain digit strings and integers 0..99 are accepted', () => {
    assert.equal(parseGoals('0'), 0);
    assert.equal(parseGoals('02'), 2);
    assert.equal(parseGoals(' 7 '), 7);
    assert.equal(parseGoals('99'), 99);
    assert.equal(parseGoals(5), 5);
});

test('parseGoals: scientific notation, decimals, negatives, over-99 and junk are rejected', () => {
    for (const bad of ['1e2', '2.0', '-1', '100', '999999999999999999999', '', '  ', 'abc', null, undefined, [], {}, 1.5, -2, 100, NaN, Infinity]) {
        assert.equal(parseGoals(bad), null, `for ${JSON.stringify(String(bad))}`);
    }
});

test('isDraw: compares parsed numbers, so 02 vs 2 and 2 vs 2 are draws', () => {
    assert.equal(isDraw('2', '02'), true);
    assert.equal(isDraw('0', '0'), true);
    assert.equal(isDraw(1, '1'), true);
    assert.equal(isDraw('2', '3'), false);
    assert.equal(isDraw('', ''), false, 'two blanks are not a draw');
    assert.equal(isDraw('2.0', '2'), false, 'an invalid value is never a draw (submit rejects it)');
});

// --- text limits ---------------------------------------------------------

test('cleanPlayerName: trims, caps at 30 and falls back when blank', () => {
    assert.equal(cleanPlayerName('  Zoë  ', 'Player 1'), 'Zoë');
    assert.equal(cleanPlayerName('   ', 'Player 1'), 'Player 1');
    assert.equal(cleanPlayerName(42, 'Player 2'), 'Player 2');
    assert.equal(cleanPlayerName('x'.repeat(120), 'Player 1').length, 30);
});

test('cleanTeamName / cleanNote: trim and cap', () => {
    assert.equal(cleanTeamName('  Spurs  ', 'Other'), 'Spurs');
    assert.equal(cleanTeamName('', 'Other'), 'Other');
    assert.equal(cleanTeamName('t'.repeat(60), 'Other').length, 40);
    assert.equal(cleanNote('  a note  '), 'a note');
    assert.equal(cleanNote('   '), undefined);
    assert.equal(cleanNote('n'.repeat(100)).length, 80);
});

// --- assignIds --------------------------------------------------------------

test('assignIds: id-less rows receive fresh unique ids above the existing max, keyed rows keep theirs', () => {
    const games = [{ id: 7 }, {}, { id: 'abc' }, { id: 3 }];
    const healed = assignIds(games);
    assert.deepEqual(games.map((g) => g.id), [7, 8, 9, 3]);
    assert.equal(new Set(games.map((g) => g.id)).size, 4);
    assert.ok(healed >= 2);
});

test('assignIds: a repeated id is re-keyed so delete / edit can target exactly one row', () => {
    const games = [{ id: 5 }, { id: 5 }];
    assignIds(games);
    assert.notEqual(games[0].id, games[1].id);
});

test('assignIds: missing gameNumbers are issued in array order above the existing max', () => {
    const games = [{ id: 1 }, { id: 2, gameNumber: 4 }, { id: 3 }];
    assignIds(games);
    assert.deepEqual(games.map((g) => g.gameNumber), [5, 4, 6]);
    const legacy = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assignIds(legacy);
    assert.deepEqual(legacy.map((g) => g.gameNumber), [1, 2, 3], 'a numberless list keeps its positional numbers');
});

// --- parseImportPayload: ids, dates, text ----------------------------------

test('parseImportPayload: every accepted row comes back with a numeric id and a gameNumber', () => {
    const out = parseImportPayload({ games: [
        { player1Goals: 1, player2Goals: 0 },
        { id: 'x', player1Goals: 2, player2Goals: 2, penaltyWinner: '1' },
        { id: 40, player1Goals: 0, player2Goals: 1 },
    ] });
    assert.equal(out.rejected, 0);
    assert.deepEqual(out.games.map((g) => typeof g.id), ['number', 'number', 'number']);
    assert.equal(new Set(out.games.map((g) => g.id)).size, 3, 'ids are unique');
    assert.equal(out.games[2].id, 40, 'an existing numeric id is kept');
    assert.deepEqual(out.games.map((g) => typeof g.gameNumber), ['number', 'number', 'number']);
    assert.equal(out.repairs.ids > 0, true);
});

test('parseImportPayload: a row repeating an earlier id is rejected and disclosed', () => {
    const out = parseImportPayload({ games: [
        { id: 1, player1Goals: 1, player2Goals: 0 },
        { id: 1, player1Goals: 3, player2Goals: 0 },
    ] });
    assert.equal(out.games.length, 1);
    assert.equal(out.games[0].player1Goals, 1, 'the first occurrence wins');
    assert.equal(out.rejected, 1);
    assert.equal(out.repairs.duplicates, 1);
});

test('parseImportPayload: an unparseable dateTime is dropped (so the migration dates it) and disclosed', () => {
    const out = parseImportPayload({ games: [
        { id: 1, player1Goals: 1, player2Goals: 1, penaltyWinner: 2, dateTime: 'garbage' },
        { id: 2, player1Goals: 1, player2Goals: 0, dateTime: '2026-02-02T10:00:00.000Z' },
    ] });
    assert.equal(out.rejected, 0);
    assert.ok(!('dateTime' in out.games[0]));
    assert.equal(out.games[1].dateTime, '2026-02-02T10:00:00.000Z');
    assert.equal(out.repairs.dates, 1);
});

test('parseImportPayload: names, teams and notes are trimmed and capped on the way in', () => {
    const out = parseImportPayload({
        players: { player1: '  ' + 'a'.repeat(50), player2: '   ' },
        games: [{ id: 1, player1Goals: 1, player2Goals: 0, player1Team: '  Spurs ', player2Team: '', note: '  ' + 'n'.repeat(100) }],
    });
    assert.equal(out.players.player1, 'a'.repeat(30));
    assert.equal(out.players.player2, 'Player 2');
    assert.equal(out.games[0].player1Team, 'Spurs');
    assert.equal(out.games[0].player2Team, 'Ultimate Team');
    assert.equal(out.games[0].note.length, 80);
});

test('parseImportPayload: scores over 99 are rejected like any other invalid score', () => {
    const out = parseImportPayload({ games: [{ id: 1, player1Goals: 100, player2Goals: 0 }, { id: 2, player1Goals: '1e2', player2Goals: 0 }] });
    assert.deepEqual(out.games, []);
    assert.equal(out.rejected, 2);
});
