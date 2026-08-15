'use strict';

// Legacy-date migration and the import apply-step, driven through the live
// migrateGameDates() / loadGames() / importData() in js/football-h2h.js.
// match-logic.test.js already covers the import ENVELOPE check
// (parseImportPayload); this file covers what happens after the user confirms.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    makeContext,
    makeElement,
    loadInto,
    runIn,
    storedGames,
    fixedDate,
} = require('./vm-harness.js');

const NOW = '2026-08-15T12:00:00.000Z';
const quietConsole = Object.assign(Object.create(null), console, { warn: () => {} });

function appCtx(extra = {}) {
    const ctx = makeContext({ console: quietConsole, Date: fixedDate(NOW), ...extra });
    // Same load order as index.html: importData() calls through
    // window.FootballMatchLogic.parseImportPayload.
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'football-h2h.js');
    return ctx;
}

// --- migrateGameDates ---------------------------------------------------

test('migrateGameDates: games that already carry a dateTime are left alone', () => {
    const ctx = appCtx();
    const games = [
        { id: 1, dateTime: '2024-01-01T10:00:00.000Z' },
        { id: 2, dateTime: '2024-01-02T10:00:00.000Z' },
    ];
    assert.equal(ctx.migrateGameDates(games), false);
    assert.equal(games[0].dateTime, '2024-01-01T10:00:00.000Z');
    assert.ok(!('lastModified' in games[0]));
});

test('migrateGameDates: an empty list needs no migration', () => {
    const ctx = appCtx();
    assert.equal(ctx.migrateGameDates([]), false);
});

test('migrateGameDates: undated games are spread backwards, oldest first', () => {
    const ctx = appCtx();
    const games = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.equal(ctx.migrateGameDates(games), true);
    // daysBack = length - index, so the first entry is the oldest and no game
    // is stamped "today" (the newest lands one day back).
    assert.deepEqual(games.map((g) => g.dateTime), [
        '2026-08-12T12:00:00.000Z',
        '2026-08-13T12:00:00.000Z',
        '2026-08-14T12:00:00.000Z',
    ]);
    assert.equal(games[0].lastModified, NOW);
});

test('migrateGameDates: only the undated entries are touched', () => {
    const ctx = appCtx();
    const games = [
        { id: 1 },
        { id: 2, dateTime: '2024-06-01T10:00:00.000Z' },
        { id: 3 },
    ];
    assert.equal(ctx.migrateGameDates(games), true);
    // Position in the array, not the neighbours' dates, decides the stamp: a
    // migrated game can therefore end up newer than an already-dated game that
    // sits after it. Only reachable with a partly-dated list (hand-edited or
    // third-party import), so it is pinned here rather than fixed.
    assert.equal(games[0].dateTime, '2026-08-12T12:00:00.000Z');
    assert.equal(games[1].dateTime, '2024-06-01T10:00:00.000Z');
    assert.equal(games[2].dateTime, '2026-08-14T12:00:00.000Z');
});

test('loadGames: a legacy saved list is migrated and written back once', () => {
    const ctx = appCtx();
    ctx.localStorage.setItem('footballH2HGames', JSON.stringify([
        { id: 1, player1Goals: 2, player2Goals: 1 },
        { id: 2, player1Goals: 0, player2Goals: 0, penaltyWinner: 1 },
    ]));
    ctx.loadGames();

    const stored = storedGames(ctx);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].dateTime, '2026-08-13T12:00:00.000Z');
    assert.equal(stored[1].dateTime, '2026-08-14T12:00:00.000Z');
    // The in-memory list and the global the sidebar reads are the same data.
    assert.equal(runIn(ctx, 'games.length'), 2);
    assert.equal(ctx.window.games.length, 2);
});

test('loadGames: no saved key leaves an empty list, writes nothing', () => {
    const ctx = appCtx();
    ctx.loadGames();
    assert.equal(runIn(ctx, 'games.length'), 0);
    assert.equal(ctx.localStorage.getItem('footballH2HGames'), null);
});

// --- import apply-step --------------------------------------------------

// importData() builds a file input, so the harness has to hand it a file and
// then drive the confirmation modal the same way a click would.
function importCtx(existingGames = []) {
    const modals = { confirm: null, success: null, error: null };
    const input = makeElement();

    function FakeFileReader() {}
    FakeFileReader.prototype.readAsText = function readAsText(file) {
        this.onload({ target: { result: file.content } });
    };

    const ctx = appCtx({
        FileReader: FakeFileReader,
        createConfirmationModal: (opts) => { modals.confirm = opts; },
        createSuccessModal: (opts) => { modals.success = opts; },
        createErrorModal: (opts) => { modals.error = opts; },
        createWarningModal: () => {},
    });
    ctx.document.createElement = () => input;

    runIn(ctx, `games = ${JSON.stringify(existingGames)}; window.games = games;`);
    ctx.saveGames();
    ctx.savePlayers();

    return {
        ctx,
        modals,
        open: (text) => {
            input.click = () => input.onchange({ target: { files: [{ content: text }] } });
            ctx.importData();
            input.click();
        },
        confirm: () => modals.confirm.onConfirm(),
        games: () => JSON.parse(runIn(ctx, 'JSON.stringify(games)')),
        players: () => JSON.parse(ctx.localStorage.getItem('footballH2HPlayers')),
    };
}

const VALID_EXPORT = JSON.stringify({
    players: { player1: 'Alex', player2: 'Sam' },
    games: [
        { id: 11, player1Goals: 3, player2Goals: 1, dateTime: '2026-02-01T10:00:00.000Z' },
        { id: 12, player1Goals: 1, player2Goals: 1, penaltyWinner: 2, dateTime: '2026-02-02T10:00:00.000Z' },
    ],
    exportDate: '2026-02-03T10:00:00.000Z',
});

test('import: nothing is applied until the confirmation is accepted', () => {
    const h = importCtx([{ id: 1, player1Goals: 5, player2Goals: 5, dateTime: NOW }]);
    h.open(VALID_EXPORT);
    assert.ok(h.modals.confirm, 'a confirmation modal should be raised');
    assert.equal(h.games().length, 1, 'the current list must survive until confirm');
    assert.equal(storedGames(h.ctx).length, 1);
    assert.equal(h.modals.success, null);
});

test('import: confirming REPLACES the games list and persists it', () => {
    const h = importCtx([
        { id: 1, player1Goals: 5, player2Goals: 5, dateTime: NOW },
        { id: 2, player1Goals: 0, player2Goals: 1, dateTime: NOW },
    ]);
    h.open(VALID_EXPORT);
    h.confirm();

    const stored = storedGames(h.ctx);
    assert.deepEqual(stored.map((g) => g.id), [11, 12], 'import replaces, never merges');
    assert.equal(stored[1].penaltyWinner, 2);
    assert.equal(h.ctx.window.games.length, 2, 'the sidebar global follows the import');
    assert.ok(h.modals.success, 'a success modal should be shown');
    assert.ok(h.modals.success.message.includes('2 games'));
});

test('import: player names come across and are saved', () => {
    const h = importCtx([]);
    h.open(VALID_EXPORT);
    assert.ok(h.modals.confirm.message.includes('Alex'), 'the rename is disclosed up front');
    h.confirm();
    assert.deepEqual(h.players(), { player1: 'Alex', player2: 'Sam' });
    assert.equal(h.ctx.window.player1Name, 'Alex');
    assert.equal(h.ctx.window.player2Name, 'Sam');
});

test('import: an export without a players block keeps the default names', () => {
    const h = importCtx([]);
    h.open(JSON.stringify({ games: [{ id: 1, player1Goals: 1, player2Goals: 0, dateTime: NOW }] }));
    h.confirm();
    assert.deepEqual(h.players(), { player1: 'Player 1', player2: 'Player 2' });
});

test('import: undated games in the file are migrated on the way in', () => {
    const h = importCtx([]);
    h.open(JSON.stringify({
        games: [
            { id: 1, player1Goals: 2, player2Goals: 0 },
            { id: 2, player1Goals: 1, player2Goals: 1, penaltyWinner: 1 },
        ],
    }));
    h.confirm();
    const stored = storedGames(h.ctx);
    assert.equal(stored[0].dateTime, '2026-08-13T12:00:00.000Z');
    assert.equal(stored[1].dateTime, '2026-08-14T12:00:00.000Z');
});

test('import: an empty games array is accepted and clears the list', () => {
    const h = importCtx([{ id: 1, player1Goals: 1, player2Goals: 0, dateTime: NOW }]);
    h.open(JSON.stringify({ games: [] }));
    assert.ok(h.modals.confirm.message.includes('0 games'));
    h.confirm();
    assert.deepEqual(storedGames(h.ctx), []);
});

test('import: cancelling leaves the current data untouched', () => {
    const existing = [{ id: 1, player1Goals: 5, player2Goals: 5, dateTime: NOW }];
    const h = importCtx(existing);
    h.open(VALID_EXPORT);
    h.modals.confirm.onCancel();
    assert.deepEqual(storedGames(h.ctx).map((g) => g.id), [1]);
    assert.equal(h.modals.success, null);
});

test('import: unparseable JSON errors out before any confirmation', () => {
    const h = importCtx([{ id: 1, player1Goals: 1, player2Goals: 0, dateTime: NOW }]);
    h.open('{ not json');
    assert.equal(h.modals.confirm, null);
    assert.ok(h.modals.error.title.includes('Import Error'));
    assert.deepEqual(storedGames(h.ctx).map((g) => g.id), [1]);
});

test('import: a payload with no games array is refused', () => {
    const h = importCtx([{ id: 1, player1Goals: 1, player2Goals: 0, dateTime: NOW }]);
    h.open(JSON.stringify({ players: { player1: 'A', player2: 'B' } }));
    assert.equal(h.modals.confirm, null);
    assert.ok(h.modals.error.title.includes('Import Failed'));
    assert.deepEqual(storedGames(h.ctx).map((g) => g.id), [1]);
});

test('import: per-game fields are NOT validated, only the envelope', () => {
    // Pinned actual behaviour: parseImportPayload checks the shape of the file,
    // not of each game, so a malformed row is stored verbatim. That is what
    // lets a scoreless row reach the stats counters (see the goals/game NaN
    // case in statsAggregates.test.js).
    const h = importCtx([]);
    h.open(JSON.stringify({ games: [{ id: 1, dateTime: NOW, note: 'no scores at all' }] }));
    h.confirm();
    const stored = storedGames(h.ctx);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].player1Goals, undefined);
});
