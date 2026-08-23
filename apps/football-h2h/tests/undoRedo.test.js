'use strict';

// Undo / redo round trips, driven through the live addToHistory /
// undoLastAction / redoLastAction in js/sidebar.js.
//
// Both scripts are loaded so the harness matches the page: sidebar.js mutates
// the `games` binding declared by football-h2h.js and persists through the
// real saveGames(). actionHistory and currentHistoryIndex are top-level `let`
// bindings, so the stack is only observable through behaviour.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, runIn, storedGames } = require('./vm-harness.js');

const quietConsole = Object.assign(Object.create(null), console, { warn: () => {} });

function makeHistoryCtx(initialGames = []) {
    const toasts = [];
    const ctx = makeContext({ console: quietConsole });
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'sidebar.js');
    loadInto(ctx, 'football-h2h.js');
    ctx.window.showToast = (msg) => toasts.push(msg);
    runIn(ctx, `games = ${JSON.stringify(initialGames)}; window.games = games;`);
    ctx.saveGames();
    return {
        ctx,
        toasts,
        games: () => JSON.parse(runIn(ctx, 'JSON.stringify(games)')),
        ids: () => runIn(ctx, 'games.map(g => g.id).join(",")'),
        stored: () => storedGames(ctx),
        push: (game) => runIn(ctx, `games.push(${JSON.stringify(game)}); window.games = games;`),
    };
}

function game(id, p1, p2) {
    return {
        id,
        gameNumber: id,
        dateTime: `2026-05-0${id}T12:00:00Z`,
        player1Goals: p1,
        player2Goals: p2,
        penaltyWinner: null,
        player1Team: 'Ultimate Team',
        player2Team: 'Ultimate Team',
    };
}

// --- add ---------------------------------------------------------------

test('undo/redo: an added game is removed by undo and restored by redo', () => {
    const h = makeHistoryCtx([game(1, 2, 1)]);
    const added = game(2, 3, 0);
    h.push(added);
    h.ctx.addToHistory({ type: 'add_game', data: added });

    h.ctx.undoLastAction();
    assert.equal(h.ids(), '1');
    assert.deepEqual(h.stored().map((g) => g.id), [1], 'undo must persist');

    h.ctx.redoLastAction();
    assert.equal(h.ids(), '1,2');
    assert.deepEqual(h.stored().map((g) => g.id), [1, 2], 'redo must persist');
    assert.deepEqual(h.games()[1], added);
});

test('undo/redo: consecutive adds unwind newest first', () => {
    const h = makeHistoryCtx([]);
    for (const id of [1, 2, 3]) {
        const g = game(id, id, 0);
        h.push(g);
        h.ctx.addToHistory({ type: 'add_game', data: g });
    }
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '1,2');
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '1');
    h.ctx.redoLastAction();
    assert.equal(h.ids(), '1,2');
    h.ctx.redoLastAction();
    assert.equal(h.ids(), '1,2,3');
});

// --- delete ------------------------------------------------------------

test('undo/redo: a deleted game comes back on undo and goes again on redo', () => {
    const h = makeHistoryCtx([game(1, 2, 1), game(2, 0, 0), game(3, 1, 4)]);
    const removed = game(2, 0, 0);
    h.ctx.addToHistory({ type: 'delete_game', data: removed });
    runIn(h.ctx, 'games = games.filter(g => g.id !== 2); window.games = games;');
    h.ctx.saveGames();

    h.ctx.undoLastAction();
    // Restored by push, so it lands at the END of the list rather than at its
    // original index. Harmless today because every view sorts by date or game
    // number before rendering.
    assert.equal(h.ids(), '1,3,2');
    assert.deepEqual(h.games().find((g) => g.id === 2), removed);

    h.ctx.redoLastAction();
    assert.equal(h.ids(), '1,3');
    assert.deepEqual(h.stored().map((g) => g.id), [1, 3]);
});

// --- edit --------------------------------------------------------------

test('undo/redo: an edit reverts to the original data and can be re-applied', () => {
    const original = game(1, 2, 1);
    const edited = { ...original, player1Goals: 5, player2Goals: 0 };
    const h = makeHistoryCtx([original]);

    runIn(h.ctx, `games[0] = ${JSON.stringify(edited)}; window.games = games;`);
    h.ctx.saveGames();
    h.ctx.addToHistory({ type: 'edit_game', data: { originalData: original, newData: edited } });

    h.ctx.undoLastAction();
    assert.deepEqual(h.games()[0], original);
    assert.deepEqual(h.stored()[0], original);

    h.ctx.redoLastAction();
    assert.deepEqual(h.games()[0], edited);
    assert.deepEqual(h.stored()[0], edited);
});

test('undo/redo: undoing an edit for a game that no longer exists changes nothing', () => {
    const original = game(1, 2, 1);
    const edited = { ...original, player1Goals: 9 };
    const h = makeHistoryCtx([]);
    h.ctx.addToHistory({ type: 'edit_game', data: { originalData: original, newData: edited } });
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '');
});

// --- stack bounds ------------------------------------------------------

test('undo/redo: the history stack is capped at 50 actions (oldest evicted)', () => {
    const h = makeHistoryCtx([]);
    for (let i = 0; i < 60; i += 1) {
        const g = { ...game(1, 1, 0), id: i, gameNumber: i + 1 };
        h.push(g);
        h.ctx.addToHistory({ type: 'add_game', data: g });
    }
    assert.equal(h.games().length, 60);

    for (let i = 0; i < 80; i += 1) h.ctx.undoLastAction();

    // 50 undos landed; the 10 oldest actions were evicted from the buffer, so
    // those games are no longer undoable.
    assert.equal(h.games().length, 10);
    assert.equal(h.ids(), '0,1,2,3,4,5,6,7,8,9');
    assert.ok(h.toasts.includes('Nothing to undo'));
});

test('undo/redo: nothing to undo / nothing to redo are reported, not thrown', () => {
    const h = makeHistoryCtx([game(1, 1, 0)]);
    h.ctx.undoLastAction();
    h.ctx.redoLastAction();
    assert.deepEqual(h.toasts, ['Nothing to undo', 'Nothing to redo']);
    assert.equal(h.ids(), '1');
});

test('undo/redo: redo runs out at the top of the stack', () => {
    const h = makeHistoryCtx([]);
    const g = game(1, 1, 0);
    h.push(g);
    h.ctx.addToHistory({ type: 'add_game', data: g });
    h.ctx.undoLastAction();
    h.ctx.redoLastAction();
    h.ctx.redoLastAction();
    assert.equal(h.ids(), '1', 'the second redo must not re-add the game twice');
    assert.equal(h.toasts.filter((t) => t === 'Nothing to redo').length, 1);
});

// --- redo truncation ---------------------------------------------------

test('undo/redo: a new action after an undo discards the redo tail', () => {
    const h = makeHistoryCtx([]);
    const first = game(1, 1, 0);
    h.push(first);
    h.ctx.addToHistory({ type: 'add_game', data: first });

    h.ctx.undoLastAction();
    assert.equal(h.ids(), '');

    // The user adds a different game instead of redoing.
    const second = game(2, 3, 3);
    h.push(second);
    h.ctx.addToHistory({ type: 'add_game', data: second });

    h.ctx.redoLastAction();
    assert.equal(h.ids(), '2', 'the discarded first add must not come back');
    assert.ok(h.toasts.includes('Nothing to redo'));

    // The surviving branch still undoes normally.
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '');
});

test('undo/redo: truncation only drops the undone tail, not the whole stack', () => {
    const h = makeHistoryCtx([]);
    for (const id of [1, 2, 3]) {
        const g = game(id, id, 0);
        h.push(g);
        h.ctx.addToHistory({ type: 'add_game', data: g });
    }
    h.ctx.undoLastAction();
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '1');

    const replacement = game(4, 4, 4);
    h.push(replacement);
    h.ctx.addToHistory({ type: 'add_game', data: replacement });

    h.ctx.undoLastAction();
    assert.equal(h.ids(), '1');
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '', 'the first add is still on the stack');
    h.ctx.undoLastAction();
    assert.ok(h.toasts.includes('Nothing to undo'));
});

// --- destructive actions reset the stack -------------------------------------
// Clear All Data and import replace the whole list; a surviving stack would
// replay a deleted game into the new data ("Undo: delete game" stayed live
// after a clear and resurrected the game).

function clearCtx(initialGames) {
    const h = makeHistoryCtx(initialGames);
    const modals = [];
    h.ctx.createConfirmationModal = (opts) => { modals.push(opts); };
    h.ctx.createSuccessModal = () => {};
    h.ctx.createErrorModal = () => {};
    const undoBtn = { disabled: false, title: '' };
    h.ctx.__elements['sidebar-undo-btn'] = undoBtn;
    h.ctx.__elements['sidebar-redo-btn'] = { disabled: false, title: '' };
    return { ...h, modals, undoBtn };
}

test('clear all data: empties the undo stack, and undo afterwards changes nothing', () => {
    const h = clearCtx([game(1, 2, 1), game(2, 0, 0)]);
    runIn(h.ctx, 'games = games.filter(g => g.id !== 2); window.games = games;');
    h.ctx.saveGames();
    h.ctx.addToHistory({ type: 'delete_game', data: game(2, 0, 0) });
    assert.equal(h.undoBtn.disabled, false);

    h.ctx.confirmClearData();
    h.modals[0].onConfirm();
    assert.deepEqual(h.stored(), []);
    assert.equal(h.undoBtn.disabled, true, 'Undo is disabled after a clear');
    assert.equal(h.undoBtn.title, 'Nothing to undo');

    h.ctx.undoLastAction();
    assert.deepEqual(h.stored(), [], 'the deleted game must not come back into the cleared list');
    assert.ok(h.toasts.includes('Nothing to undo'));

    // clear -> undo -> write -> reload: the new write is what persists.
    h.push(game(3, 1, 0));
    h.ctx.saveGames();
    h.ctx.loadGames();
    assert.equal(h.ids(), '3');
});

test('import: empties the undo stack so a foreign delete cannot replay into the imported list', () => {
    const h = clearCtx([game(1, 2, 1)]);
    h.ctx.addToHistory({ type: 'add_game', data: game(1, 2, 1) });
    assert.equal(h.undoBtn.title, 'Undo: add game');

    // Drive the import apply step the way importMigration.test.js does.
    const input = { click: () => {}, onchange: null, type: '', accept: '' };
    h.ctx.document.createElement = () => input;
    h.ctx.FileReader = function FakeFileReader() {
        this.readAsText = (file) => this.onload({ target: { result: file.content } });
    };
    h.ctx.importData();
    input.onchange({ target: { files: [{ content: JSON.stringify({ games: [{ id: 9, player1Goals: 3, player2Goals: 0, dateTime: '2026-05-09T12:00:00Z' }] }) }] } });
    const confirm = h.modals.find((m) => m.title === 'Import Data?');
    confirm.onConfirm();
    assert.equal(h.ids(), '9');
    assert.equal(h.undoBtn.disabled, true, 'Undo is disabled after an import');
    h.ctx.undoLastAction();
    assert.equal(h.ids(), '9');
});
