'use strict';

// Name hygiene on the live write path and the session summary's ordering,
// driven through the real updatePlayerName() / buildSessionSummaryText() in
// js/football-h2h.js.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, runIn } = require('./vm-harness.js');

function appCtx() {
    const ctx = makeContext();
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'football-h2h.js');
    return ctx;
}

test('updatePlayerName: a whitespace-only name falls back to the default instead of blanking every label', () => {
    const ctx = appCtx();
    ctx.updatePlayerName(1, '   ');
    assert.equal(runIn(ctx, 'player1Name'), 'Player 1');
    assert.equal(JSON.parse(ctx.localStorage.getItem('footballH2HPlayers')).player1, 'Player 1');
});

test('updatePlayerName: names are trimmed and capped at 30 characters', () => {
    const ctx = appCtx();
    ctx.updatePlayerName(2, '  ' + 'Z'.repeat(120) + '  ');
    const stored = JSON.parse(ctx.localStorage.getItem('footballH2HPlayers')).player2;
    assert.equal(stored, 'Z'.repeat(30));
});

test('session summary: matches are listed chronologically regardless of storage order', () => {
    const ctx = appCtx();
    runIn(ctx, "player1Name = 'Alex'; player2Name = 'Sam';");
    const games = [
        { id: 3, player1Goals: 3, player2Goals: 0, dateTime: '2026-08-10T10:00:00.000Z' },
        { id: 1, player1Goals: 1, player2Goals: 0, dateTime: '2026-08-01T10:00:00.000Z' },
        { id: 2, player1Goals: 2, player2Goals: 2, penaltyWinner: 2, dateTime: '2026-08-05T10:00:00.000Z', note: 'pens' },
    ];
    const text = runIn(ctx, `buildSessionSummaryText(${JSON.stringify(games)})`);
    const lines = text.split('\n').slice(5);
    assert.deepEqual(lines.map((l) => l.slice(0, 3)), ['1–0', '2–2', '3–0']);
    assert.ok(lines[1].includes('Sam wins pens') && lines[1].endsWith(', pens'));
});
