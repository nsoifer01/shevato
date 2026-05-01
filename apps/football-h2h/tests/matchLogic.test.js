'use strict';

// Pin timezone so date-based sort assertions stay deterministic across CI/dev.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    compareGames,
    sortGames,
    nextGameId,
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

test('sortGames: by player1 asc handles negative + zero goals', () => {
    const games = [{ player1Goals: 3 }, { player1Goals: 0 }, { player1Goals: 1 }];
    const sorted = sortGames(games, 'player1', 'asc');
    assert.deepEqual(sorted.map(g => g.player1Goals), [0, 1, 3]);
});

// --- nextGameId -------------------------------------------------------

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
    assert.deepEqual(out.players, { player1: 'Player 1', player2: 'Player 2' });
});

test('parseImportPayload: accepts payload with players block', () => {
    const out = parseImportPayload({
        games: [{ id: 1 }],
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
