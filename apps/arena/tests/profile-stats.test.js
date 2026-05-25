/*
 * Brain Arena — profile-stats helpers (Item #7 + #2 leaderboard gate).
 * Tests cover the by-game-type accumulator and the daily-personal-best
 * gate that maybeWriteDailyLeaderboard uses to skip non-PB writes.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ProfileStats = require('../js/profile-stats.js');

/* -------------- accumulateByGameType -------------- */

test('accumulateByGameType: first game initializes the bucket', () => {
    const next = ProfileStats.accumulateByGameType(undefined, {
        scoreEarned: 250,
        winsDelta: 1,
        bullseyesDelta: 2,
        bestRoundThisGame: 130
    });
    assert.deepEqual(next, {
        xp: 250,
        gamesPlayed: 1,
        wins: 1,
        bullseyes: 2,
        bestRoundScore: 130
    });
});

test('accumulateByGameType: subsequent games accumulate, bestRound is max', () => {
    const after1 = ProfileStats.accumulateByGameType({}, {
        scoreEarned: 100, winsDelta: 0, bullseyesDelta: 0, bestRoundThisGame: 50
    });
    const after2 = ProfileStats.accumulateByGameType(after1, {
        scoreEarned: 200, winsDelta: 1, bullseyesDelta: 1, bestRoundThisGame: 90
    });
    assert.equal(after2.xp, 300);
    assert.equal(after2.gamesPlayed, 2);
    assert.equal(after2.wins, 1);
    assert.equal(after2.bullseyes, 1);
    assert.equal(after2.bestRoundScore, 90, 'best round bumps from 50 to 90');
});

test('accumulateByGameType: bestRound stays put when new game is worse', () => {
    const prev = { xp: 100, gamesPlayed: 1, wins: 1, bullseyes: 0, bestRoundScore: 200 };
    const next = ProfileStats.accumulateByGameType(prev, {
        scoreEarned: 50, winsDelta: 0, bullseyesDelta: 0, bestRoundThisGame: 30
    });
    assert.equal(next.bestRoundScore, 200);
    assert.equal(next.xp, 150);
});

test('accumulateByGameType: negative / NaN inputs clamp to 0', () => {
    const next = ProfileStats.accumulateByGameType({}, {
        scoreEarned: -50, winsDelta: 'oops', bullseyesDelta: null, bestRoundThisGame: NaN
    });
    assert.deepEqual(next, {
        xp: 0, gamesPlayed: 1, wins: 0, bullseyes: 0, bestRoundScore: 0
    });
});

test('accumulateByGameType: does not mutate prev', () => {
    const prev = { xp: 100, gamesPlayed: 2, wins: 1, bullseyes: 3, bestRoundScore: 75 };
    const frozen = JSON.stringify(prev);
    ProfileStats.accumulateByGameType(prev, {
        scoreEarned: 50, winsDelta: 1, bullseyesDelta: 1, bestRoundThisGame: 100
    });
    assert.equal(JSON.stringify(prev), frozen, 'prev unchanged');
});

test('accumulateByGameType: missing fields default to 0/no-op', () => {
    const next = ProfileStats.accumulateByGameType({}, {});
    assert.deepEqual(next, { xp: 0, gamesPlayed: 1, wins: 0, bullseyes: 0, bestRoundScore: 0 });
});

test('accumulateByGameType: prev with string-shaped numbers gets coerced', () => {
    // Firestore can stringify on edge cases (legacy records). Helper
    // tolerates that so the math doesn't blow up to NaN.
    const next = ProfileStats.accumulateByGameType(
        { xp: '50', gamesPlayed: '3', wins: '1', bullseyes: '2', bestRoundScore: '80' },
        { scoreEarned: 10, winsDelta: 1, bullseyesDelta: 0, bestRoundThisGame: 50 }
    );
    assert.equal(next.xp, 60);
    assert.equal(next.gamesPlayed, 4);
    assert.equal(next.wins, 2);
    assert.equal(next.bullseyes, 2);
    assert.equal(next.bestRoundScore, 80);
});

/* -------------- isDailyPersonalBest -------------- */

test('isDailyPersonalBest: no prior entry (null / undefined) → always yes', () => {
    assert.equal(ProfileStats.isDailyPersonalBest(0, null), true);
    assert.equal(ProfileStats.isDailyPersonalBest(0, undefined), true);
    assert.equal(ProfileStats.isDailyPersonalBest(500, null), true);
});

test('isDailyPersonalBest: sentinel -1 (no doc) → always yes', () => {
    assert.equal(ProfileStats.isDailyPersonalBest(100, -1), true);
});

test('isDailyPersonalBest: strict greater-than (ties do NOT count)', () => {
    assert.equal(ProfileStats.isDailyPersonalBest(500, 500), false, 'tie is not a PB');
    assert.equal(ProfileStats.isDailyPersonalBest(501, 500), true);
    assert.equal(ProfileStats.isDailyPersonalBest(499, 500), false);
});

test('isDailyPersonalBest: NaN newScore → false (never write garbage)', () => {
    assert.equal(ProfileStats.isDailyPersonalBest(NaN, 100), false);
    assert.equal(ProfileStats.isDailyPersonalBest('x', 100), false);
});

test('isDailyPersonalBest: NaN prevScore treated as no-prior → yes', () => {
    assert.equal(ProfileStats.isDailyPersonalBest(100, 'corrupt'), true);
    assert.equal(ProfileStats.isDailyPersonalBest(100, NaN), true);
});
