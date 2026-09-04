'use strict';

// Edit-path validation, driven through the live editGame() in
// js/football-h2h.js. The Edit Game modal is built by createFormModal
// (modalUtils.js), so the harness stubs that out, captures the onSave
// callback editGame registers, and invokes it with raw form data the way a
// Save click would. See vm-harness.js for the loading rules.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    makeContext,
    loadInto,
    runIn,
    toHost,
    storedGames,
} = require('./vm-harness.js');

const quietConsole = Object.assign(Object.create(null), console, { warn: () => {} });

const GAME = {
    id: 1,
    gameNumber: 1,
    player1Goals: 2,
    player2Goals: 0,
    player1Team: 'Ultimate Team',
    player2Team: 'Ultimate Team',
    penaltyWinner: null,
    dateTime: '2026-01-10T15:00:00.000Z',
};

// Loads the app, seeds one game, opens the edit modal for it, and returns
// the captured onSave plus the capture channels the assertions read.
function editCtx(seed = GAME) {
    const modal = { opts: null };
    const errors = [];
    const toasts = [];

    const ctx = makeContext({
        console: quietConsole,
        createFormModal: (opts) => { modal.opts = opts; },
        showFormError: (msg) => errors.push(msg),
        hideFormError: () => {},
        showToast: (message, type) => toasts.push({ message, type }),
    });
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'football-h2h.js');

    runIn(ctx, `games = ${JSON.stringify([seed])}; window.games = games;`);
    ctx.saveGames();
    ctx.updateUI = () => {};

    ctx.editGame(seed.id);
    assert.ok(modal.opts, 'editGame must open the edit modal');

    return {
        ctx,
        errors,
        toasts,
        // Stand in for what a cross-tab write, a remote sync delivery or the
        // 10-minute auto-backup does: replace the whole `games` array while
        // the dialog is open.
        replaceGames: (rows) => runIn(ctx, `games = ${JSON.stringify(rows)}; window.games = games;`),
        allGames: () => toHost(runIn(ctx, 'games')),
        // Raw form data as createFormModal would collect it, defaulting to
        // a valid no-op edit of the seeded game.
        save: (overrides = {}) => modal.opts.onSave({
            date: '2026-01-10',
            time: '15:00:00',
            player1Goals: String(seed.player1Goals),
            player2Goals: String(seed.player2Goals),
            penaltyWinner: '',
            player1TeamType: 'Ultimate Team',
            player1Team: '',
            player2TeamType: 'Ultimate Team',
            player2Team: '',
            note: '',
            ...overrides,
        }),
        game: () => toHost(runIn(ctx, 'games[0]')),
    };
}

test('edit game: negative goals are rejected and nothing changes', () => {
    const h = editCtx();
    const result = h.save({ player1Goals: '-2' });
    assert.equal(result, false, 'the modal must stay open');
    assert.deepEqual(h.errors, ['Goals for Player 1 must be a whole number from 0 to 99']);
    assert.equal(h.game().player1Goals, 2, 'the stored game is untouched');
});

test('edit game: a negative second goal count names the second player', () => {
    const h = editCtx();
    const result = h.save({ player2Goals: '-1' });
    assert.equal(result, false);
    assert.deepEqual(h.errors, ['Goals for Player 2 must be a whole number from 0 to 99']);
});

test('edit game: non-integer, scientific-notation and over-99 goal values are rejected', () => {
    // `1e2` and `2.0` pass Number.isInteger; the shared parseGoals rule
    // requires plain digits 0..99 (the max="99" hint used to be decorative).
    for (const bad of ['1.5', 'abc', '1e2', '2.0', '100', '999999999999999999999']) {
        const h = editCtx();
        assert.equal(h.save({ player1Goals: bad }), false, `"${bad}" must be rejected`);
        assert.equal(h.errors.length, 1);
        assert.equal(h.game().player1Goals, 2);
    }
});

test('edit game: a valid edit stores numeric goals and persists', () => {
    const h = editCtx();
    h.save({ player1Goals: '4', player2Goals: '1' });
    assert.deepEqual(h.errors, []);
    const game = h.game();
    assert.equal(game.player1Goals, 4);
    assert.equal(game.player2Goals, 1);
    assert.equal(typeof game.player1Goals, 'number');
    assert.equal(storedGames(h.ctx)[0].player1Goals, 4, 'the edit is persisted');
});

test('edit game: 0 goals is a valid value on the edit path too', () => {
    const h = editCtx();
    h.save({ player1Goals: '0', player2Goals: '0', penaltyWinner: 'draw' });
    assert.deepEqual(h.errors, []);
    assert.equal(h.game().player1Goals, 0);
    assert.equal(h.game().penaltyWinner, 'draw');
});

test('edit game: a drawn edit stores the penalty winner as a NUMBER', () => {
    const h = editCtx();
    h.save({ player1Goals: '1', player2Goals: '1', penaltyWinner: '2' });
    assert.deepEqual(h.errors, []);
    assert.equal(h.game().penaltyWinner, 2);
    assert.equal(typeof h.game().penaltyWinner, 'number');
});


// ---------------------------------------------------------------------------
// The dialog outlives the array it was opened against.
//
// `games` is REPLACED wholesale whenever storage is re-read: a second tab
// writing, a remote sync delivery, the 10-minute auto-backup, the 1 s
// syncSystemReady refresh. The edit path looked its row up with
// `games.indexOf(game)` on the object captured when the dialog opened, and
// the `if (gameIndex !== -1)` had no else, so Save silently did nothing.
// ---------------------------------------------------------------------------

test('edit game: a save still lands after the games array was replaced underneath', () => {
    const h = editCtx();

    // Same row, same id, different object identity: exactly what re-reading
    // storage produces.
    h.replaceGames([{ ...GAME }, { ...GAME, id: 2, gameNumber: 2, player1Goals: 0, player2Goals: 0 }]);

    h.save({ player1Goals: '7', player2Goals: '3' });

    assert.deepEqual(h.errors, [], 'a valid edit must not raise a form error');
    const rows = h.allGames();
    assert.equal(rows.length, 2, 'the other row is untouched');
    const edited = rows.find((g) => g.id === GAME.id);
    assert.equal(edited.player1Goals, 7, 'the edit must reach the row that is actually in the array now');
    assert.equal(edited.player2Goals, 3);
    assert.equal(storedGames(h.ctx).find((g) => g.id === GAME.id).player1Goals, 7,
        'and must be persisted');
});

test('edit game: editing a row that was deleted elsewhere says so instead of failing silently', () => {
    const h = editCtx();
    h.replaceGames([{ ...GAME, id: 99, gameNumber: 1 }]);

    h.save({ player1Goals: '7' });

    assert.equal(h.allGames().length, 1, 'nothing is added');
    assert.equal(h.allGames()[0].id, 99, 'and the surviving row is not overwritten');
    assert.ok(
        h.toasts.some((t) => t.type === 'error' && /another tab/i.test(t.message)),
        `the user must be told; got ${JSON.stringify(h.toasts)}`
    );
});
