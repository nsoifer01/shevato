'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    streakMultiplier,
    speedBonus,
    scoreAnswer,
    rankPlayers
} = require('../js/scoring.js');

// --- streakMultiplier --------------------------------------------------

test('streakMultiplier: 0 and 1 stay at 1.0x (no bonus for first correct)', () => {
    assert.equal(streakMultiplier(0), 1);
    assert.equal(streakMultiplier(1), 1);
});

test('streakMultiplier: grows by step per additional correct, capped', () => {
    const { STREAK_MULTIPLIER_STEP, STREAK_MULTIPLIER_CAP } = Config;
    assert.equal(streakMultiplier(2), 1 + STREAK_MULTIPLIER_STEP * 1);
    assert.equal(streakMultiplier(3), 1 + STREAK_MULTIPLIER_STEP * 2);
    assert.equal(streakMultiplier(1 + STREAK_MULTIPLIER_CAP), 1 + STREAK_MULTIPLIER_STEP * STREAK_MULTIPLIER_CAP);
    // Past the cap, multiplier should not grow further.
    assert.equal(streakMultiplier(1 + STREAK_MULTIPLIER_CAP + 5), 1 + STREAK_MULTIPLIER_STEP * STREAK_MULTIPLIER_CAP);
});

// --- speedBonus --------------------------------------------------------

test('speedBonus: full bonus when answer arrives instantly', () => {
    assert.equal(speedBonus(Config.QUESTION_TIME_MS, Config.QUESTION_TIME_MS), Config.SCORE_SPEED_BONUS_MAX);
});

test('speedBonus: zero at the buzzer', () => {
    assert.equal(speedBonus(0, Config.QUESTION_TIME_MS), 0);
});

test('speedBonus: clamps negatives (late writes) to zero', () => {
    assert.equal(speedBonus(-500, Config.QUESTION_TIME_MS), 0);
});

test('speedBonus: clamps over-total inputs to full bonus', () => {
    assert.equal(speedBonus(Config.QUESTION_TIME_MS * 2, Config.QUESTION_TIME_MS), Config.SCORE_SPEED_BONUS_MAX);
});

test('speedBonus: zero total => zero bonus (no divide by zero)', () => {
    assert.equal(speedBonus(1000, 0), 0);
});

// --- scoreAnswer -------------------------------------------------------

test('scoreAnswer: wrong answer returns 0 points and resets streak', () => {
    const r = scoreAnswer({ correct: false, timeLeftMs: 8000, totalMs: 15000, streakBefore: 4 });
    assert.equal(r.pointsEarned, 0);
    assert.equal(r.streakAfter, 0);
    assert.equal(r.breakdown.correct, false);
});

test('scoreAnswer: correct first answer => base + speedBonus, streak=1, no multiplier', () => {
    const r = scoreAnswer({
        correct: true,
        timeLeftMs: Config.QUESTION_TIME_MS,
        totalMs: Config.QUESTION_TIME_MS,
        streakBefore: 0
    });
    assert.equal(r.streakAfter, 1);
    assert.equal(r.breakdown.multiplier, 1);
    assert.equal(r.pointsEarned, Config.SCORE_BASE_CORRECT + Config.SCORE_SPEED_BONUS_MAX);
});

test('scoreAnswer: second-in-a-row correct picks up the +10% multiplier', () => {
    const r = scoreAnswer({
        correct: true,
        timeLeftMs: 0,
        totalMs: Config.QUESTION_TIME_MS,
        streakBefore: 1
    });
    assert.equal(r.streakAfter, 2);
    const expected = Math.round(Config.SCORE_BASE_CORRECT * (1 + Config.STREAK_MULTIPLIER_STEP));
    assert.equal(r.pointsEarned, expected);
});

test('scoreAnswer: streak multiplier caps at the configured ceiling', () => {
    const huge = scoreAnswer({
        correct: true,
        timeLeftMs: 0,
        totalMs: Config.QUESTION_TIME_MS,
        streakBefore: 99
    });
    const expectedMult = 1 + Config.STREAK_MULTIPLIER_STEP * Config.STREAK_MULTIPLIER_CAP;
    assert.equal(huge.breakdown.multiplier, expectedMult);
    assert.equal(huge.pointsEarned, Math.round(Config.SCORE_BASE_CORRECT * expectedMult));
});

// --- rankPlayers -------------------------------------------------------

test('rankPlayers: empty / non-array => []', () => {
    assert.deepEqual(rankPlayers([]), []);
    assert.deepEqual(rankPlayers(null), []);
});

test('rankPlayers: highest score wins, streak breaks ties, name stabilizes', () => {
    const ranked = rankPlayers([
        { displayName: 'Charlie', score: 500, streak: 0 },
        { displayName: 'Alice',   score: 1000, streak: 2 },
        { displayName: 'Bob',     score: 1000, streak: 3 },
        { displayName: 'Dana',    score: 500, streak: 0 }
    ]);
    assert.deepEqual(ranked.map(p => p.displayName), ['Bob', 'Alice', 'Charlie', 'Dana']);
});

test('rankPlayers: does not mutate input', () => {
    const input = [{ displayName: 'A', score: 1, streak: 0 }, { displayName: 'B', score: 2, streak: 0 }];
    const copy = input.slice();
    rankPlayers(input);
    assert.deepEqual(input, copy);
});
