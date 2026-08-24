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

// Changed 2026-08-23: this test used to pin "an empty games array is
// accepted and clears the list". A file with zero usable games replaced the
// user's whole list (and reset the names) behind a confirm that merely
// mentioned "0 games"; the audit called for a guard, so it is now refused.
test('import: a file with no usable games is refused and nothing changes', () => {
    const h = importCtx([{ id: 1, player1Goals: 1, player2Goals: 0, dateTime: NOW }]);
    h.open(JSON.stringify({ games: [] }));
    assert.equal(h.modals.confirm, null, 'no confirmation for an empty import');
    assert.ok(h.modals.error && h.modals.error.title.includes('Nothing to Import'));
    assert.deepEqual(storedGames(h.ctx).map((g) => g.id), [1]);

    const allBad = importCtx([{ id: 1, player1Goals: 1, player2Goals: 0, dateTime: NOW }]);
    allBad.open(JSON.stringify({ games: [{ id: 9, note: 'no scores' }, { id: 10, player1Goals: -1, player2Goals: 0 }] }));
    assert.equal(allBad.modals.confirm, null);
    assert.ok(allBad.modals.error.message.includes('2 rows'), allBad.modals.error.message);
    assert.deepEqual(storedGames(allBad.ctx).map((g) => g.id), [1]);
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

test('import: malformed rows are dropped, disclosed up front, and never stored', () => {
    const h = importCtx([]);
    h.open(JSON.stringify({
        games: [
            { id: 1, player1Goals: 2, player2Goals: 1, dateTime: NOW },
            { id: 2, dateTime: NOW, note: 'no scores at all' },
            { id: 3, player1Goals: -4, player2Goals: 0, dateTime: NOW },
        ],
    }));
    assert.ok(h.modals.confirm.message.includes('1 game'), 'only the valid row is counted');
    assert.ok(
        h.modals.confirm.message.includes('2 invalid rows'),
        `the skip must be disclosed before confirming, got: ${h.modals.confirm.message}`,
    );
    h.confirm();
    const stored = storedGames(h.ctx);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 1);
});

test('import: a legacy string penaltyWinner is normalized to a number on the way in', () => {
    const h = importCtx([]);
    h.open(JSON.stringify({
        games: [{ id: 1, player1Goals: 1, player2Goals: 1, penaltyWinner: '2', dateTime: NOW }],
    }));
    h.confirm();
    const stored = storedGames(h.ctx);
    assert.equal(stored[0].penaltyWinner, 2);
    assert.equal(typeof stored[0].penaltyWinner, 'number');
});

// --- migratePenaltyWinners (load-path normalization) ---------------------

test('migratePenaltyWinners: string "1" / "2" become numbers, everything else is untouched', () => {
    const ctx = appCtx();
    const games = [
        { id: 1, penaltyWinner: '1' },
        { id: 2, penaltyWinner: '2' },
        { id: 3, penaltyWinner: 1 },
        { id: 4, penaltyWinner: 'draw' },
        { id: 5, penaltyWinner: null },
        { id: 6 },
    ];
    assert.equal(ctx.migratePenaltyWinners(games), true);
    assert.deepEqual(games.map((g) => g.penaltyWinner), [1, 2, 1, 'draw', null, undefined]);
});

test('migratePenaltyWinners: reports false when nothing needed rewriting', () => {
    const ctx = appCtx();
    const games = [{ id: 1, penaltyWinner: 2 }, { id: 2, penaltyWinner: null }];
    assert.equal(ctx.migratePenaltyWinners(games), false);
});

test('loadGames: a stored legacy string penaltyWinner is normalized and written back', () => {
    const ctx = appCtx();
    ctx.localStorage.setItem('footballH2HGames', JSON.stringify([
        { id: 1, player1Goals: 1, player2Goals: 1, penaltyWinner: '1', dateTime: '2026-01-01T00:00:00.000Z' },
    ]));
    ctx.loadGames();
    const stored = storedGames(ctx);
    assert.equal(stored[0].penaltyWinner, 1);
    assert.equal(typeof stored[0].penaltyWinner, 'number');
    assert.equal(ctx.window.games[0].penaltyWinner, 1, 'the in-memory list is normalized too');
});

// --- older-shape export fixture -------------------------------------------
// What a pre-2026 export looked like: no players block, no ids, no
// gameNumbers, string penalty winners, one undated row. It must still import
// intact, and every row must come out with a stable id so edit / delete act
// on exactly one game.

const LEGACY_EXPORT = JSON.stringify({
    games: [
        { player1Goals: 1, player2Goals: 0, dateTime: '2025-08-01T10:00:00.000Z', player1Team: 'Arsenal', player2Team: 'Ultimate Team' },
        { player1Goals: 2, player2Goals: 2, penaltyWinner: '1', dateTime: '2025-08-02T10:00:00.000Z' },
        { player1Goals: 0, player2Goals: 1 },
    ],
});

test('import: an older-shape export (no ids / players / gameNumbers) imports with ids and numbers assigned', () => {
    const h = importCtx([]);
    h.open(LEGACY_EXPORT);
    h.confirm();
    const stored = storedGames(h.ctx);
    assert.equal(stored.length, 3);
    assert.deepEqual(stored.map((g) => typeof g.id), ['number', 'number', 'number']);
    assert.equal(new Set(stored.map((g) => g.id)).size, 3, 'ids are unique');
    assert.deepEqual(stored.map((g) => g.gameNumber), [1, 2, 3]);
    assert.equal(stored[1].penaltyWinner, 1);
    assert.equal(stored[0].player1Team, 'Arsenal');
    assert.ok(stored[2].dateTime, 'the undated row was migrated');
    assert.deepEqual(h.players(), { player1: 'Player 1', player2: 'Player 2' });
});

test('import: repaired dates and repeated ids are disclosed in the confirmation', () => {
    const h = importCtx([]);
    h.open(JSON.stringify({ games: [
        { id: 1, player1Goals: 1, player2Goals: 0, dateTime: 'garbage' },
        { id: 1, player1Goals: 2, player2Goals: 0, dateTime: NOW },
    ] }));
    const msg = h.modals.confirm.message;
    assert.ok(msg.includes('1 row has an unreadable date'), msg);
    assert.ok(msg.includes('1 invalid row') && msg.includes('repeated id'), msg);
});

// --- delete / edit target exactly one row ------------------------------------

function deleteCtx() {
    const modals = [];
    const ctx = appCtx({ createConfirmationModal: (opts) => { modals.push(opts); } });
    return { ctx, modals };
}

test('delete: on an id-less stored list, loadGames heals ids and deleting one row removes exactly that row', () => {
    const { ctx, modals } = deleteCtx();
    ctx.localStorage.setItem('footballH2HGames', JSON.stringify([
        { player1Goals: 1, player2Goals: 0, dateTime: '2026-08-01T10:00:00.000Z' },
        { player1Goals: 2, player2Goals: 2, penaltyWinner: 1, dateTime: '2026-08-02T10:00:00.000Z' },
        { player1Goals: 0, player2Goals: 1, dateTime: '2026-08-03T10:00:00.000Z' },
    ]));
    ctx.loadGames();
    ctx.updateUI = () => {};
    const games = JSON.parse(runIn(ctx, 'JSON.stringify(games)'));
    assert.equal(new Set(games.map((g) => g.id)).size, 3, 'every row has a distinct id after load');
    assert.deepEqual(storedGames(ctx).map((g) => typeof g.id), ['number', 'number', 'number'], 'the heal is persisted');

    const target = games.find((g) => g.player1Goals === 2);
    ctx.deleteGame(target.id);
    assert.equal(modals.length, 1);
    assert.ok(modals[0].message.includes('2 - 2'), 'the confirm names the game that was clicked');
    modals[0].onConfirm();
    assert.deepEqual(storedGames(ctx).map((g) => `${g.player1Goals}-${g.player2Goals}`), ['1-0', '0-1']);
});

test('delete / edit: an undefined id never matches a row (the mass-delete regression)', () => {
    const { ctx, modals } = deleteCtx();
    // Rows with no id can still arrive in memory from another device via
    // sync; the UI must not act on `undefined`.
    runIn(ctx, 'games = [{player1Goals:1,player2Goals:0},{player1Goals:2,player2Goals:2}]; window.games = games;');
    ctx.deleteGame(undefined);
    assert.equal(modals.length, 0, 'no confirm modal for an undefined id');
    assert.equal(runIn(ctx, 'games.length'), 2);
    let opened = false;
    ctx.createFormModal = () => { opened = true; };
    ctx.editGame(undefined);
    assert.equal(opened, false, 'no edit modal for an undefined id');
});

// --- corrupted storage -----------------------------------------------------

test('loadGames: corrupted JSON is reported, never thrown, and the blob is not overwritten', () => {
    const ctx = appCtx();
    ctx.localStorage.setItem('footballH2HGames', '{not json');
    assert.doesNotThrow(() => ctx.loadGames());
    assert.equal(runIn(ctx, 'games.length'), 0);
    assert.equal(ctx.localStorage.getItem('footballH2HGames'), '{not json', 'the unreadable blob is left in place');

    // A save is refused while the blob is unreadable...
    runIn(ctx, 'games.push({id:1,player1Goals:1,player2Goals:0}); window.games = games;');
    assert.equal(ctx.saveGames(), false);
    assert.equal(ctx.localStorage.getItem('footballH2HGames'), '{not json');

    // ...and the empty-state notice says so.
    const p = makeElement();
    const noGames = makeElement({ querySelector: () => p });
    ctx.__elements.gamesTableBody = makeElement();
    ctx.__elements.noGames = noGames;
    ctx.renderGamesTableWithData([]);
    assert.ok(p.textContent.includes('could not be read'), p.textContent);
});

test('loadGames: a non-array blob is treated the same as corrupted JSON', () => {
    const ctx = appCtx();
    ctx.localStorage.setItem('footballH2HGames', '{"a":1}');
    assert.doesNotThrow(() => ctx.loadGames());
    assert.equal(runIn(ctx, 'games.length'), 0);
    assert.equal(ctx.localStorage.getItem('footballH2HGames'), '{"a":1}');
});

test('loadGames: corrupted player names / icons fall back to defaults without throwing', () => {
    const ctx = appCtx();
    ctx.localStorage.setItem('footballH2HPlayers', 'null');
    ctx.localStorage.setItem('footballH2HPlayerIcons', '[]');
    assert.doesNotThrow(() => { ctx.loadPlayers(); ctx.loadPlayerIcons(); });
    assert.equal(runIn(ctx, 'player1Name'), 'Player 1');
    assert.deepEqual(JSON.parse(runIn(ctx, 'JSON.stringify(playerIcons)')), { player1: '⚽', player2: '⚽' });
});

test('clear all data: replaces an unreadable blob (the one deliberate overwrite)', () => {
    let confirm = null;
    const ctx = appCtx({ createConfirmationModal: (opts) => { confirm = opts; }, createSuccessModal: () => {} });
    ctx.localStorage.setItem('footballH2HGames', '{not json');
    ctx.loadGames();
    ctx.updateUI = () => {};
    ctx.confirmClearData();
    confirm.onConfirm();
    assert.equal(ctx.localStorage.getItem('footballH2HGames'), '[]');
    runIn(ctx, 'games.push({id:1,player1Goals:1,player2Goals:0}); window.games = games;');
    assert.equal(ctx.saveGames(), true, 'saves work again after the clear');
});
