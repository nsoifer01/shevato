'use strict';

// Pure helpers added in the 2026-08-23 remediation round (audit D4 ghost
// players, D5 end-screen rewrite, D8 leaderboard vs profile drift). Each
// test pins a WHY: the value that used to be wrong in production.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    isPlayerLive, livePlayers, finalRankingSnapshot, endOfGameStatsDelta
} = require('../js/room-state.js');

const NOW = 1_700_000_000_000;
const ts = (ms) => ({ toMillis: () => ms });

// --- liveness (D4) ----------------------------------------------------

test('isPlayerLive: a doc with no timestamps is live (fresh join, pending serverTimestamp)', () => {
    assert.equal(isPlayerLive({ uid: 'a' }, NOW), true);
    assert.equal(isPlayerLive(null, NOW), false);
});

test('isPlayerLive: disconnectedAt inside the grace window keeps the player live (refresh restores their score)', () => {
    assert.equal(isPlayerLive({ disconnectedAt: NOW - Config.DISCONNECT_GRACE_MS + 1000, lastSeen: ts(NOW) }, NOW), true);
});

test('isPlayerLive: disconnectedAt older than the grace window is a ghost', () => {
    // The audit ghost: tab navigated away, 31 s later still counted in
    // every() for early reveal and in rematchPlayerCount.
    assert.equal(isPlayerLive({ disconnectedAt: NOW - Config.DISCONNECT_GRACE_MS - 1000, lastSeen: ts(NOW) }, NOW), false);
});

test('isPlayerLive: a stale lastSeen heartbeat (crashed tab, no beforeunload) is a ghost; a fresh one is live', () => {
    assert.equal(isPlayerLive({ lastSeen: ts(NOW - Config.PRESENCE_STALE_MS - 1) }, NOW), false);
    assert.equal(isPlayerLive({ lastSeen: NOW - Config.PRESENCE_STALE_MS - 1 }, NOW), false, 'epoch-ms lastSeen is read too');
    assert.equal(isPlayerLive({ lastSeen: ts(NOW - Config.PRESENCE_HEARTBEAT_MS * 2) }, NOW), true,
        'two missed heartbeats are still inside the presence window (background-tab timer throttling)');
});

test('livePlayers filters ghosts and keeps order', () => {
    const players = [
        { uid: 'a', lastSeen: ts(NOW) },
        { uid: 'ghost', disconnectedAt: NOW - 60000, lastSeen: ts(NOW - 60000) },
        { uid: 'b', lastSeen: ts(NOW - 1000) }
    ];
    assert.deepEqual(livePlayers(players, NOW).map((p) => p.uid), ['a', 'b']);
    assert.deepEqual(livePlayers(null, NOW), []);
});

// --- final ranking snapshot (D5) --------------------------------------

test('finalRankingSnapshot ranks best first with deterministic tie-breaks and compact fields only', () => {
    const snap = finalRankingSnapshot([
        { uid: 'c', displayName: 'Cara', score: 906, streak: 1, answers: [{ big: 'payload' }] },
        { uid: 'a', displayName: 'Ann', score: 1176, streak: 3 },
        { uid: 'b', displayName: 'Bob', score: 906, streak: 2 }
    ]);
    assert.deepEqual(snap, [
        { uid: 'a', displayName: 'Ann', score: 1176, streak: 3 },
        { uid: 'b', displayName: 'Bob', score: 906, streak: 2 },
        { uid: 'c', displayName: 'Cara', score: 906, streak: 1 }
    ]);
    assert.ok(!('answers' in snap[2]), 'answers never ride the room doc');
});

test('finalRankingSnapshot honours a custom score function (Globe Drop recomputed totals)', () => {
    const snap = finalRankingSnapshot(
        [{ uid: 'a', displayName: 'A', score: 5 }, { uid: 'b', displayName: 'B', score: 50 }],
        (p) => (p.uid === 'a' ? 100 : 10)
    );
    assert.deepEqual(snap.map((p) => p.uid), ['a', 'b']);
    assert.equal(snap[0].score, 100);
});

test('finalRankingSnapshot drops malformed entries and coerces NaN scores to 0', () => {
    const snap = finalRankingSnapshot([{ uid: 'a', displayName: null, score: 'x' }, { displayName: 'no uid' }, null]);
    assert.deepEqual(snap, [{ uid: 'a', displayName: '', score: 0, streak: 0 }]);
});

// --- end-of-game stats delta (D8) -------------------------------------

test('endOfGameStatsDelta: a daily run with one player never counts as a win', () => {
    // The audit saw "You won! Nice work." and wins +1 on a solo daily.
    const d = endOfGameStatsDelta({ playMode: 'daily', didWin: true, playerCount: 1, score: 280, answers: [] });
    assert.equal(d.winsDelta, 0);
    assert.equal(d.gamesDelta, 1);
    assert.equal(d.scoreDelta, 280);
});

test('endOfGameStatsDelta: solo never wins; multi with an opponent does', () => {
    assert.equal(endOfGameStatsDelta({ playMode: 'solo', didWin: true, playerCount: 1, score: 1 }).winsDelta, 0);
    assert.equal(endOfGameStatsDelta({ playMode: 'multi', didWin: true, playerCount: 1, score: 1 }).winsDelta, 0,
        'a multi room whose opponents all left before the end is not a win either');
    assert.equal(endOfGameStatsDelta({ playMode: 'multi', didWin: true, playerCount: 2, score: 1 }).winsDelta, 1);
    assert.equal(endOfGameStatsDelta({ playMode: 'multi', didWin: false, playerCount: 2, score: 1 }).winsDelta, 0);
});

test('endOfGameStatsDelta: bullseyes and best round come from the answer records', () => {
    const d = endOfGameStatsDelta({
        playMode: 'multi', didWin: false, playerCount: 2, score: 312,
        answers: [
            { basePoints: 99, points: 198, multiplier: 2 },
            { points: 100, multiplier: 1 },            // legacy record: base derived = 100
            { basePoints: 40, points: 60, multiplier: 1.5 },
            null
        ]
    });
    assert.equal(d.bullseyes, 2);
    assert.equal(d.bestRound, 198);
});
