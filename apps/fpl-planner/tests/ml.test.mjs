import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeRng,
  shuffle,
  ridge,
  poissonRegression,
  logisticRegression,
  predictPoisson,
  predictLogistic,
  linearPredict,
  solveSymmetric,
  calibrate,
  calibratorFromJSON,
  metrics,
  poissonPmf,
  poissonVector,
  poissonTail,
  distPoint,
  distBernoulli,
  distConvolve,
  distMix,
  distMean,
  distVariance,
  distQuantile,
} from '../js/engine/ml.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b} (eps ${eps})`);

test('solveSymmetric solves a hand-checked 2x2 system', () => {
  // [[4,1],[1,3]] x = [1,2]  ->  x = (1/11, 7/11)
  const x = solveSymmetric([[4, 1], [1, 3]], [1, 2]);
  close(x[0], 1 / 11, 1e-12);
  close(x[1], 7 / 11, 1e-12);
});

test('solveSymmetric falls back to pivoted elimination on a non positive definite system', () => {
  // Indefinite (eigenvalues +/-), so Cholesky must fail and the fallback runs.
  const x = solveSymmetric([[0, 1], [1, 0]], [2, 3]);
  close(x[0], 3, 1e-12);
  close(x[1], 2, 1e-12);
});

test('ridge with lambda 0 recovers the exact OLS solution on a noiseless system', () => {
  // y = 3 + 2*x1 - 1*x2 exactly.
  const X = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [1, 2]];
  const y = X.map(([a, b]) => 3 + 2 * a - 1 * b);
  const m = ridge(X, y, 0);
  close(m.intercept, 3, 1e-9);
  close(m.weights[0], 2, 1e-9);
  close(m.weights[1], -1, 1e-9);
});

test('ridge with a positive lambda shrinks slopes toward zero but keeps the mean', () => {
  const X = [[0], [1], [2], [3], [4]];
  const y = [1, 3, 5, 7, 9]; // slope 2, intercept 1
  const ols = ridge(X, y, 0);
  const pen = ridge(X, y, 10);
  close(ols.weights[0], 2, 1e-9);
  assert.ok(pen.weights[0] < ols.weights[0], 'ridge must shrink the slope');
  assert.ok(pen.weights[0] > 0, 'ridge must not flip the sign here');
  // The fitted mean is preserved because the intercept is unpenalized.
  const meanX = 2;
  const meanY = 5;
  close(pen.intercept + pen.weights[0] * meanX, meanY, 1e-9);
});

test('ridge sample weights change the fit in the expected direction', () => {
  const X = [[0], [1]];
  const y = [0, 10];
  const even = ridge(X, y, 0);
  close(even.weights[0], 10, 1e-9);
  const weighted = ridge([[0], [1], [1]], [0, 10, 0], 0);
  close(weighted.weights[0], 5, 1e-9);
  const sw = ridge(X, y, 0, { sampleWeights: [2, 1] });
  close(sw.weights[0], 10, 1e-9); // two points still determine the line exactly
});

test('poissonRegression recovers a known rate when the data sits exactly on the mean', () => {
  // The IRLS score equation is X'(y - mu) = 0. Setting y to the true mean makes
  // the true parameters the exact solution, so this is an analytic check.
  const b0 = 0.5;
  const b1 = 0.8;
  const X = [[-2], [-1], [0], [1], [2], [3]];
  const y = X.map(([x]) => Math.exp(b0 + b1 * x));
  const m = poissonRegression(X, y, { lambda: 0, tol: 1e-12, maxIter: 200 });
  assert.ok(m.converged, 'IRLS should converge');
  close(m.intercept, b0, 1e-8);
  close(m.weights[0], b1, 1e-8);
  close(predictPoisson(m, [1]), Math.exp(b0 + b1), 1e-7);
});

test('poissonRegression with no informative feature recovers log of the mean count', () => {
  const y = [0, 1, 2, 3, 4, 2, 1, 1];
  const X = y.map(() => [0]);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const m = poissonRegression(X, y, { lambda: 1e-8, tol: 1e-12, maxIter: 200 });
  close(m.intercept, Math.log(mean), 1e-7);
});

test('logisticRegression recovers known coefficients when outcomes sit on the true probability', () => {
  const b0 = -0.4;
  const b1 = 1.3;
  const X = [[-3], [-2], [-1], [0], [1], [2], [3]];
  const y = X.map(([x]) => 1 / (1 + Math.exp(-(b0 + b1 * x))));
  const m = logisticRegression(X, y, { lambda: 0, tol: 1e-12, maxIter: 200 });
  close(m.intercept, b0, 1e-7);
  close(m.weights[0], b1, 1e-7);
  close(predictLogistic(m, [0]), 1 / (1 + Math.exp(-b0)), 1e-7);
});

test('logisticRegression with an uninformative feature recovers the base rate', () => {
  const y = [1, 1, 1, 0, 0, 0, 0, 0, 1, 1];
  const X = y.map(() => [0]);
  const m = logisticRegression(X, y, { lambda: 1e-10, tol: 1e-12, maxIter: 300 });
  close(predictLogistic(m, [0]), 0.5, 1e-6);
});

test('linearPredict is the plain dot product plus intercept', () => {
  close(linearPredict({ intercept: 1, weights: [2, 3] }, [4, 5]), 1 + 8 + 15, 1e-12);
});

test('metrics are hand-computable', () => {
  close(metrics.mae([1, 2, 3], [1.5, 2.5, 2]), (0.5 + 0.5 + 1) / 3, 1e-12);
  close(metrics.rmse([0, 0], [3, 4]), Math.sqrt((9 + 16) / 2), 1e-12);
  close(metrics.brier([1, 0], [0.75, 0.25]), (0.0625 + 0.0625) / 2, 1e-12);
  close(metrics.logLoss([1, 0], [0.5, 0.5]), Math.log(2), 1e-12);
  // Poisson deviance with y = mu is exactly 0.
  close(metrics.poissonDeviance([2, 3], [2, 3]), 0, 1e-12);
  // y = 0, mu = 1 gives 2 * mu = 2 per observation.
  close(metrics.poissonDeviance([0, 0], [1, 1]), 2, 1e-12);
});

test('calibrationBins bins by predicted probability and reports the gap', () => {
  const p = [0.05, 0.15, 0.85, 0.95];
  const y = [0, 0, 1, 1];
  const r = metrics.calibrationBins(p, y, 10);
  assert.equal(r.n, 4);
  const filled = r.bins.filter(b => b.n > 0);
  assert.equal(filled.length, 4);
  close(r.ece, (0.05 + 0.15 + 0.15 + 0.05) / 4, 1e-12);
  close(r.maxGap, 0.15, 1e-12);
});

test('platt calibration pulls systematically overconfident probabilities toward the truth', () => {
  // Raw model says 0.9 whenever the truth is 0.6, and 0.1 whenever it is 0.4.
  const probs = [];
  const outcomes = [];
  for (let i = 0; i < 100; i++) {
    probs.push(0.9);
    outcomes.push(i < 60 ? 1 : 0);
    probs.push(0.1);
    outcomes.push(i < 40 ? 1 : 0);
  }
  const raw = metrics.logLoss(outcomes, probs);
  const cal = calibrate(probs, outcomes, 'platt');
  const fixed = probs.map(p => cal.predict(p));
  assert.ok(metrics.logLoss(outcomes, fixed) < raw, 'calibration must improve log loss');
  assert.ok(Math.abs(cal.predict(0.9) - 0.6) < 0.03, `expected ~0.6, got ${cal.predict(0.9)}`);
  assert.ok(Math.abs(cal.predict(0.1) - 0.4) < 0.03, `expected ~0.4, got ${cal.predict(0.1)}`);
});

test('bin calibration is monotone and round-trips through JSON', () => {
  const probs = [];
  const outcomes = [];
  const rng = makeRng(7);
  for (let i = 0; i < 600; i++) {
    const p = rng();
    probs.push(p);
    // True probability is p squared, so the raw score is badly miscalibrated.
    outcomes.push(rng() < p * p ? 1 : 0);
  }
  const cal = calibrate(probs, outcomes, 'bins', { bins: 10 });
  let prev = -Infinity;
  for (let x = 0; x <= 1.0001; x += 0.05) {
    const v = cal.predict(x);
    assert.ok(v >= prev - 1e-12, `calibrator not monotone at ${x}`);
    assert.ok(v >= 0 && v <= 1);
    prev = v;
  }
  assert.ok(metrics.brier(outcomes, probs.map(p => cal.predict(p))) < metrics.brier(outcomes, probs));

  const rehydrated = calibratorFromJSON(JSON.parse(JSON.stringify(cal)));
  close(rehydrated.predict(0.42), cal.predict(0.42), 1e-12);
});

test('poissonPmf matches hand-computed values', () => {
  close(poissonPmf(0, 1.5), Math.exp(-1.5), 1e-15);
  close(poissonPmf(1, 1.5), 1.5 * Math.exp(-1.5), 1e-15);
  close(poissonPmf(2, 1.5), (1.5 * 1.5 / 2) * Math.exp(-1.5), 1e-15);
  close(poissonPmf(0, 0), 1, 1e-15);
  assert.equal(poissonPmf(-1, 2), 0);
});

test('poissonVector sums to exactly one and folds the tail into the last cell', () => {
  for (const lambda of [0, 0.2, 1.4, 3.9, 12]) {
    const v = poissonVector(lambda, 10);
    const sum = v.reduce((a, b) => a + b, 0);
    close(sum, 1, 1e-12);
    for (let k = 0; k < 10; k++) close(v[k], poissonPmf(k, lambda), 1e-12);
  }
});

test('poissonTail is one minus the cdf', () => {
  close(poissonTail(1, 2), 1 - Math.exp(-2), 1e-12);
  close(poissonTail(2, 2), 1 - Math.exp(-2) - 2 * Math.exp(-2), 1e-12);
  assert.equal(poissonTail(0, 5), 1);
  assert.equal(poissonTail(3, 0), 0);
});

test('discrete distribution algebra composes exactly', () => {
  const a = distBernoulli(0.5, 1);
  const b = distBernoulli(0.5, 1);
  const sum = distConvolve(a, b);
  close(sum.p[0], 0.25, 1e-12);
  close(sum.p[1], 0.5, 1e-12);
  close(sum.p[2], 0.25, 1e-12);
  close(distMean(sum), 1, 1e-12);
  close(distVariance(sum), 0.5, 1e-12);

  // Negative support (a card) shifts the offset rather than clipping.
  const card = distBernoulli(0.25, -1);
  const withCard = distConvolve(sum, card);
  assert.equal(withCard.offset, -1);
  close(distMean(withCard), 1 - 0.25, 1e-12);

  const mixed = distMix([
    { weight: 0.5, dist: distPoint(0) },
    { weight: 0.5, dist: distPoint(4) },
  ]);
  close(distMean(mixed), 2, 1e-12);
  close(distVariance(mixed), 4, 1e-12);
  assert.equal(distQuantile(mixed, 0.5), 0);
  assert.equal(distQuantile(mixed, 0.85), 4);
});

test('makeRng is deterministic and shuffle is reproducible for a seed', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
  const s1 = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(9));
  const s2 = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(9));
  assert.deepEqual(s1, s2);
  assert.notDeepEqual(s1, [1, 2, 3, 4, 5, 6, 7, 8]);
});
