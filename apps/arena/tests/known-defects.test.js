'use strict';
// Known-defect quarantine for Arena's extracted modules (TESTING-AUDIT.md).
//
// Each `todo` test asserts the CORRECT behavior and currently fails; node's
// runner reports it as TODO without failing the suite. When the defect is
// fixed, remove the todo option in the same PR and mark the defect resolved
// in TESTING-AUDIT.md. Never weaken these to match broken behavior.
//
// The final test is NOT a todo: it pins a behavior whose correct answer is a
// product decision, so it documents today's semantics instead of presuming
// the outcome.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../js/config.js');
const { normalizeRoomCode, aggregateAnswerStats } = require('../js/room-state.js');
const { speedBonus, scoreAnswer } = require('../js/scoring.js');

test('normalizeRoomCode rejects codes containing characters outside ROOM_CODE_ALPHABET',
  { todo: 'KNOWN DEFECT: only length is validated (room-state.js filters [^A-Z0-9], never the alphabet), so IL0O1 - five characters the alphabet deliberately excludes - is accepted and looked up instead of rejected (TESTING-AUDIT.md defect 24)' },
  () => {
    // Every character of this code is one the generator can never emit.
    const impossible = 'IL0O1';
    for (const ch of impossible) {
      assert.equal(Config.ROOM_CODE_ALPHABET.includes(ch), false,
        `precondition: ${ch} must be outside the alphabet`);
    }
    assert.equal(normalizeRoomCode(impossible), '',
      'a code no generator can produce should normalize to empty (rejected)');
  });

test('speedBonus clamps a NaN timeLeftMs to zero bonus instead of propagating NaN',
  { todo: 'KNOWN DEFECT (hardening): Math.max(0, Math.min(1, NaN)) propagates NaN; a NaN here would flow into a Firestore increment. Unreachable in production today because the caller guards totalMs > 0' },
  () => {
    assert.equal(speedBonus(NaN, 15000), 0);
  });

test('scoreAnswer with a missing timeLeftMs yields a numeric non-negative score',
  { todo: 'KNOWN DEFECT (hardening): pointsEarned becomes NaN when timeLeftMs is omitted; correct behavior is treating the missing value as zero time left' },
  () => {
    const r = scoreAnswer({ correct: true, totalMs: 15000, streakBefore: 0 });
    assert.ok(Number.isFinite(r.pointsEarned), `pointsEarned is ${r.pointsEarned}`);
    assert.ok(r.pointsEarned >= 0);
  });

// Product decision needed, so this pins CURRENT behavior rather than judging
// it: trivia accuracy divides by ANSWERED entries, so 3 correct answers in a
// 10-question game report accuracy 1. Globe Drop's aggregator was deliberately
// changed to divide by total rounds (skipped rounds count as 0), and the two
// modes now disagree. Whichever way the owner decides, this test states
// today's trivia semantics so the choice is made consciously
// (TESTING-AUDIT.md defect 25).
test('aggregateAnswerStats accuracy denominator is the answered count, not total rounds (current behavior, decision pending)', () => {
  const stats = aggregateAnswerStats([
    { correct: true }, { correct: true }, { correct: true },
  ]);
  assert.equal(stats.accuracy, 1,
    'three answered-correct entries report 100% regardless of unanswered rounds');
});
