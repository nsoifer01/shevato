'use strict';
// Former known-defect quarantine for Arena's extracted modules
// (TESTING-AUDIT.md defects 24 and 25 plus two NaN-hardening gaps). All
// four defects were fixed on 2026-08-15, so every test here now asserts
// the CORRECT behavior with no todo option and doubles as the regression
// pin. Never weaken these to match broken behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../js/config.js');
const { normalizeRoomCode, aggregateAnswerStats } = require('../js/room-state.js');
const { speedBonus, scoreAnswer } = require('../js/scoring.js');

// Defect 24 (fixed): validity means length AND alphabet, not just length.
test('normalizeRoomCode rejects codes containing characters outside ROOM_CODE_ALPHABET', () => {
    // Every character of this code is one the generator can never emit.
    const impossible = 'IL0O1';
    for (const ch of impossible) {
        assert.equal(Config.ROOM_CODE_ALPHABET.includes(ch), false,
            `precondition: ${ch} must be outside the alphabet`);
    }
    assert.equal(normalizeRoomCode(impossible), '',
        'a code no generator can produce should normalize to empty (rejected)');
    // A single bad character poisons an otherwise-valid code too.
    assert.equal(normalizeRoomCode('ABCD0'), '');
    assert.equal(normalizeRoomCode('OBCDE'), '');
});

// NaN hardening (fixed): a NaN here would flow into a Firestore increment.
test('speedBonus clamps a NaN timeLeftMs to zero bonus instead of propagating NaN', () => {
    assert.equal(speedBonus(NaN, 15000), 0);
    assert.equal(speedBonus(undefined, 15000), 0);
    assert.equal(speedBonus(Infinity, 15000), 0);
});

test('scoreAnswer with a missing timeLeftMs yields a numeric non-negative score', () => {
    const r = scoreAnswer({ correct: true, totalMs: 15000, streakBefore: 0 });
    assert.ok(Number.isFinite(r.pointsEarned), `pointsEarned is ${r.pointsEarned}`);
    assert.ok(r.pointsEarned >= 0);
    // Missing time left means zero speed bonus: base points only.
    assert.equal(r.pointsEarned, Config.SCORE_BASE_CORRECT);
});

// Defect 25 (DECIDED 2026-08-15): trivia accuracy divides by TOTAL rounds,
// consistent with the deliberately-fixed Globe Drop aggregator - skipped
// rounds count as misses. The old answered-count denominator (3 correct
// answers in a 10-question game reporting 100%) is asserted AGAINST below
// so it cannot silently come back.
test('aggregateAnswerStats accuracy denominator is total rounds, never the answered count', () => {
    const threeCorrect = [
        { correct: true }, { correct: true }, { correct: true },
    ];
    const stats = aggregateAnswerStats(threeCorrect, 10);
    assert.equal(stats.accuracy, 0.3,
        'three correct answers in a 10-question game are 30%');
    assert.notEqual(stats.accuracy, 1,
        'regression guard: the pre-decision answered-count denominator reported 100% here');
    // Legacy-caller fallback: with no totalRounds the answered count still
    // applies, so old persisted call sites do not change meaning.
    assert.equal(aggregateAnswerStats(threeCorrect).accuracy, 1);
});
