import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelOptions } from '../js/engine/strength.js';

test('no active switch resolves to null, so the Strength object is unchanged', () => {
  assert.equal(resolveModelOptions(undefined), null);
  assert.equal(resolveModelOptions(null), null);
  assert.equal(resolveModelOptions({}), null);
  assert.equal(resolveModelOptions({ goalDispersion: 1 }), null);
  assert.equal(resolveModelOptions({ odds: false }), null);
  // Keys that belong to other candidates are not this module's business.
  assert.equal(resolveModelOptions({ someOtherKnob: 3 }), null);
});

test('the odds switch defaults to weight 1 and takes a weight in [0, 1]', () => {
  assert.deepEqual(resolveModelOptions({ odds: true }), { odds: { weight: 1 } });
  assert.deepEqual(resolveModelOptions({ odds: { weight: 0.65 } }), { odds: { weight: 0.65 } });
  assert.throws(() => resolveModelOptions({ odds: { weight: 1.5 } }), /weight/);
  assert.throws(() => resolveModelOptions({ odds: { weight: '0.5' } }), /weight/);
});

test('a goal dispersion must be a positive number', () => {
  assert.deepEqual(resolveModelOptions({ goalDispersion: 1.16 }), { goalDispersion: 1.16 });
  assert.deepEqual(resolveModelOptions({ goalDispersion: 1.16, odds: { weight: 0.5 } }), { odds: { weight: 0.5 }, goalDispersion: 1.16 });
  assert.throws(() => resolveModelOptions({ goalDispersion: 0 }), /positive/);
  assert.throws(() => resolveModelOptions({ goalDispersion: 'x' }), /positive/);
});
