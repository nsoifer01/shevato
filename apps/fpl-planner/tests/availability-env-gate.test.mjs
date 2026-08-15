// The availability signal's environment gate.
//
// The signal was measured and REJECTED (experiments/registry.md: +11.4 a
// window, se 10.8, sign test p = 1.00), so the replay must be bit-identical
// to not having the feature unless FPL_AVAILABILITY is set explicitly. The
// README's bit-identical claim rests first of all on this gate: if it ever
// reads as ON by default, every replay silently consumes a rejected signal
// and every number measured against the registry's baselines is void.
//
// The gate itself is the testable seam. The full bit-identical property is a
// replay-level fact exercised by the null-arm config and the fingerprinted
// experiment runner; what a unit test can and does pin is that the switch is
// OFF unless the environment says exactly ON.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { availabilityEnvEnabled } from '../js/engine/backtest.js';

// Save/restore rather than a subprocess: the gate reads process.env at call
// time, so mutating and restoring it inside one test is race-free under the
// node --test process-per-file model (nothing else in THIS file touches env).
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'FPL_AVAILABILITY');
  const previous = process.env.FPL_AVAILABILITY;
  if (value === undefined) delete process.env.FPL_AVAILABILITY;
  else process.env.FPL_AVAILABILITY = value;
  try {
    return fn();
  } finally {
    if (had) process.env.FPL_AVAILABILITY = previous;
    else delete process.env.FPL_AVAILABILITY;
  }
}

test('the gate is OFF when the variable is absent, which is every normal run', () => {
  withEnv(undefined, () => {
    assert.equal(availabilityEnvEnabled(), false);
  });
});

test('the gate opens only for the two documented spellings', () => {
  withEnv('1', () => assert.equal(availabilityEnvEnabled(), true));
  withEnv('true', () => assert.equal(availabilityEnvEnabled(), true));
});

test('anything else reads as OFF, never as "probably meant on"', () => {
  // A half-set variable silently enabling a rejected signal is the failure
  // mode; an experiment that WANTS it on will notice it being off.
  for (const value of ['0', 'false', '', 'yes', 'TRUE', '2', ' 1']) {
    withEnv(value, () => {
      assert.equal(availabilityEnvEnabled(), false, `FPL_AVAILABILITY=${JSON.stringify(value)}`);
    });
  }
});

test('this process is not itself running under the flag', () => {
  // If CI or a local shell exports FPL_AVAILABILITY, every replay-driven test
  // in the suite is measuring the rejected arm without saying so. Fail loudly
  // here rather than letting the rest of the suite pass on the wrong physics.
  assert.equal(availabilityEnvEnabled(), false,
    'FPL_AVAILABILITY is set in this environment; unset it before running the suite');
});
