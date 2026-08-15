'use strict';

// Add-game validation and persistence, driven through the live
// submitSidebarGame() in js/sidebar.js (the only path the UI uses to create a
// game). The sidebar form inputs are stubbed elements; everything else is the
// real code. See vm-harness.js for the loading rules.

// Pin timezone so the dateTime stamped on a new game is deterministic.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    makeContext,
    makeElement,
    loadInto,
    toHost,
    fixedDate,
} = require('./vm-harness.js');

const NOW_ISO = '2026-08-15T12:34:56.789Z';

// Build a sandbox with the sidebar add-game form filled in as described.
// Returns the context plus the capture objects the assertions read.
function addGameCtx(form = {}, existingGames = []) {
    const values = {
        player1Goals: '',
        player2Goals: '',
        player1TeamType: 'Ultimate Team',
        player2TeamType: 'Ultimate Team',
        player1Team: '',
        player2Team: '',
        player1CustomTeam: '',
        player2CustomTeam: '',
        penalty: '',
        date: '',
        note: '',
        ...form,
    };

    const errorEl = makeElement();
    const elements = {
        'sidebar-player1-goals': makeElement({ value: values.player1Goals }),
        'sidebar-player2-goals': makeElement({ value: values.player2Goals }),
        'sidebar-player1-team-type': makeElement({ value: values.player1TeamType }),
        'sidebar-player2-team-type': makeElement({ value: values.player2TeamType }),
        'sidebar-player1-team': makeElement({ value: values.player1Team }),
        'sidebar-player2-team': makeElement({ value: values.player2Team }),
        'sidebar-player1-custom-team': makeElement({ value: values.player1CustomTeam }),
        'sidebar-player2-custom-team': makeElement({ value: values.player2CustomTeam }),
        'sidebar-penalty-winner': makeElement({ value: values.penalty }),
        'sidebar-date-input': makeElement({ value: values.date }),
        'sidebar-game-note': makeElement({ value: values.note }),
        'sidebar-game-error': errorEl,
        'sidebar-game-form': makeElement(),
        'sidebar-add-game-btn': makeElement(),
        'sidebar-game-inputs': makeElement(),
    };

    const history = [];
    const toasts = [];
    let saveCount = 0;

    const ctx = makeContext({ elements, Date: fixedDate(NOW_ISO) });
    loadInto(ctx, 'sidebar.js');

    ctx.window.games = existingGames;
    ctx.window.player1Name = 'Alex';
    ctx.window.player2Name = 'Sam';
    ctx.window.saveGames = () => { saveCount += 1; };
    ctx.window.updateUI = () => {};
    ctx.window.addToHistory = (action) => history.push(toHost(action));
    ctx.window.showToast = (msg, kind) => toasts.push({ msg, kind });

    return {
        ctx,
        games: existingGames,
        history,
        toasts,
        get saveCount() { return saveCount; },
        get error() {
            return errorEl.classes.has('show') ? errorEl.textContent : null;
        },
        submit: () => ctx.submitSidebarGame(),
        last: () => toHost(existingGames[existingGames.length - 1]),
    };
}

// --- goals validation --------------------------------------------------

test('add game: 0 is a valid goal count, not a missing value', () => {
    const h = addGameCtx({ player1Goals: '0', player2Goals: '1' });
    h.submit();
    assert.equal(h.error, null);
    assert.equal(h.games.length, 1);
    assert.equal(h.last().player1Goals, 0);
    assert.equal(h.last().player2Goals, 1);
});

test('add game: a blank goal field is rejected and nothing is saved', () => {
    const h = addGameCtx({ player1Goals: '', player2Goals: '2' });
    h.submit();
    assert.equal(h.error, 'Please enter goals for Alex');
    assert.equal(h.games.length, 0);
    assert.equal(h.saveCount, 0);
    assert.equal(h.history.length, 0);
});

test('add game: a blank second goal field names the second player', () => {
    const h = addGameCtx({ player1Goals: '2', player2Goals: '' });
    h.submit();
    assert.equal(h.error, 'Please enter goals for Sam');
    assert.equal(h.games.length, 0);
});

test('add game: negative goals are rejected', { todo: 'KNOWN DEFECT: submitSidebarGame does not range-check goals, so a negative value typed into the number input (min="0" is only a browser hint, never re-checked in JS) is stored as-is and pollutes every derived stat.' }, () => {
    const h = addGameCtx({ player1Goals: '-3', player2Goals: '1' });
    h.submit();
    assert.notEqual(h.error, null);
    assert.equal(h.games.length, 0);
});

// --- draw / penalty rule -----------------------------------------------

test('add game: a drawn score without a penalty result is rejected', () => {
    const h = addGameCtx({ player1Goals: '2', player2Goals: '2', penalty: '' });
    h.submit();
    assert.equal(h.error, 'Please select a penalty result for draw games');
    assert.equal(h.games.length, 0);
});

test('add game: 0-0 counts as a draw and also needs a penalty result', () => {
    const h = addGameCtx({ player1Goals: '0', player2Goals: '0', penalty: '' });
    h.submit();
    assert.equal(h.error, 'Please select a penalty result for draw games');
    assert.equal(h.games.length, 0);
});

test('add game: penalty winner is stored as a NUMBER (playerStats compares with ===)', () => {
    for (const [selected, stored] of [['1', 1], ['2', 2]]) {
        const h = addGameCtx({ player1Goals: '1', player2Goals: '1', penalty: selected });
        h.submit();
        assert.equal(h.error, null);
        assert.equal(h.last().penaltyWinner, stored);
        assert.equal(typeof h.last().penaltyWinner, 'number');
    }
});

test('add game: a drawn shootout stores the string "draw"', () => {
    const h = addGameCtx({ player1Goals: '1', player2Goals: '1', penalty: 'draw' });
    h.submit();
    assert.equal(h.last().penaltyWinner, 'draw');
});

test('add game: a stale penalty selection is ignored when regulation was decided', () => {
    const h = addGameCtx({ player1Goals: '3', player2Goals: '1', penalty: '2' });
    h.submit();
    assert.equal(h.last().penaltyWinner, null);
});

// --- custom ("Other") team names ---------------------------------------

test('add game: an "Other" team type with a blank name is rejected', () => {
    const h = addGameCtx({
        player1Goals: '1', player2Goals: '0',
        player1TeamType: 'Other', player1CustomTeam: '',
    });
    h.submit();
    assert.equal(h.error, 'Please enter a team name for Alex');
    assert.equal(h.games.length, 0);
});

test('add game: a whitespace-only "Other" team name is rejected too', () => {
    const h = addGameCtx({
        player1Goals: '1', player2Goals: '0',
        player2TeamType: 'Other', player2CustomTeam: '   ',
    });
    h.submit();
    assert.equal(h.error, 'Please enter a team name for Sam');
    assert.equal(h.games.length, 0);
});

test('add game: a filled "Other" team name is stored verbatim', () => {
    const h = addGameCtx({
        player1Goals: '1', player2Goals: '0',
        player1TeamType: 'Other', player1CustomTeam: 'Sunday League XI',
    });
    h.submit();
    assert.equal(h.error, null);
    assert.equal(h.last().player1Team, 'Sunday League XI');
});

test('add game: league and Ultimate Team selections are stored as the team name', () => {
    const h = addGameCtx({
        player1Goals: '2', player2Goals: '0',
        player1TeamType: 'Premier League', player1Team: 'Arsenal',
        player2TeamType: 'Ultimate Team',
    });
    h.submit();
    assert.equal(h.last().player1Team, 'Arsenal');
    assert.equal(h.last().player2Team, 'Ultimate Team');
});

// --- persisted record shape --------------------------------------------

test('add game: record shape - id from Date.now(), gameNumber, sidebar date + current clock', () => {
    const existing = [{ id: 1, gameNumber: 1 }, { id: 2, gameNumber: 2 }];
    const h = addGameCtx({
        player1Goals: '3', player2Goals: '2', date: '2026-03-05',
    }, existing);
    h.submit();

    const game = h.last();
    assert.equal(game.id, new Date(NOW_ISO).getTime());
    assert.equal(game.gameNumber, 3);
    // Date comes from the sidebar's standing game date, time from the clock.
    assert.equal(game.dateTime, '2026-03-05T12:34:56.789Z');
    assert.equal(game.player1Team, 'Ultimate Team');
    assert.equal(game.player2Team, 'Ultimate Team');
    assert.equal(game.penaltyWinner, null);
    assert.equal(h.saveCount, 1);
});

test('add game: with no sidebar date set the stamp falls back to now', () => {
    const h = addGameCtx({ player1Goals: '1', player2Goals: '0', date: '' });
    h.submit();
    assert.equal(h.last().dateTime, NOW_ISO);
});

test('add game: a note is trimmed, and omitted entirely when blank', () => {
    const withNote = addGameCtx({ player1Goals: '1', player2Goals: '0', note: '  First one back  ' });
    withNote.submit();
    assert.equal(withNote.last().note, 'First one back');

    const blank = addGameCtx({ player1Goals: '1', player2Goals: '0', note: '   ' });
    blank.submit();
    assert.ok(!('note' in blank.last()), 'blank note must not be persisted');
});

test('add game: the add is pushed onto the undo history and toasted', () => {
    const h = addGameCtx({ player1Goals: '1', player2Goals: '0' });
    h.submit();
    assert.equal(h.history.length, 1);
    assert.equal(h.history[0].type, 'add_game');
    assert.equal(h.history[0].data.id, h.last().id);
    assert.deepEqual(h.toasts, [{ msg: 'Game added successfully!', kind: 'success' }]);
});

test('add game: gameNumber stays unique after an earlier game is deleted', { todo: 'KNOWN DEFECT: gameNumber is derived from games.length + 1, so deleting any game and adding a new one re-issues a number that is already in use (history table then shows two rows with the same game #).' }, () => {
    // Three games logged, the middle one deleted: numbers in use are 1 and 3.
    const existing = [{ id: 1, gameNumber: 1 }, { id: 3, gameNumber: 3 }];
    const h = addGameCtx({ player1Goals: '1', player2Goals: '0' }, existing);
    h.submit();
    const numbers = existing.map((g) => g.gameNumber);
    assert.equal(new Set(numbers).size, numbers.length, `duplicate gameNumber: ${numbers.join(',')}`);
});

// --- failure path -------------------------------------------------------

test('add game: with no games array present nothing is saved and an error shows', () => {
    const h = addGameCtx({ player1Goals: '1', player2Goals: '0' });
    h.ctx.window.games = undefined;
    h.submit();
    assert.equal(h.error, 'Unable to save game. Please try again.');
    assert.equal(h.saveCount, 0);
});
