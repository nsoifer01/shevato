// Dependency-free statistics and machine learning primitives.
//
// The repo has no bundler and no npm dependencies, so every piece of maths the
// planner needs is written here: linear algebra, three generalized linear
// models, two probability calibrators, the metric set the training pipeline
// selects models with, and the small discrete-distribution algebra the
// projection model composes player point distributions from.
//
// Everything is pure, synchronous and deterministic. The only randomness in the
// whole model layer comes from `makeRng(seed)`, so a training run with the same
// seed and the same data produces byte-identical output.

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32). Used for shuffles and train/validation
// splits, never for anything the browser renders.
// ---------------------------------------------------------------------------

export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Linear algebra
//
// Two solvers on purpose. Cholesky is the right tool for the symmetric positive
// definite systems ridge and IRLS produce and it is roughly twice as fast, but
// it fails outright on a system that is only positive SEMI-definite (perfectly
// collinear features, or lambda = 0 on a rank-deficient design). Rather than
// pretend that cannot happen, `solveSymmetric` falls back to Gaussian
// elimination with partial pivoting, which handles anything short of an exactly
// singular matrix.
// ---------------------------------------------------------------------------

export function choleskySolve(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > 0)) return null;
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  const yv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * yv[k];
    yv[i] = sum / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = yv[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return Array.from(x);
}

export function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) r[j] = row[j];
    r[n] = b[i];
    return r;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[pivot];
      M[pivot] = M[col];
      M[col] = tmp;
    }
    const p = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

export function solveSymmetric(A, b) {
  const viaChol = choleskySolve(A, b);
  if (viaChol && viaChol.every(Number.isFinite)) return viaChol;
  const viaGauss = gaussSolve(A, b);
  if (viaGauss && viaGauss.every(Number.isFinite)) return viaGauss;
  throw new Error('ml: singular system, cannot solve');
}

// ---------------------------------------------------------------------------
// Ridge regression, closed form.
//
// The intercept is NOT penalized. That is why the design is centered first:
// centering makes the intercept orthogonal to the slopes, so it can be
// recovered afterwards from the means instead of sitting in the penalized
// system. With lambda = 0 this is ordinary least squares exactly.
// ---------------------------------------------------------------------------

export function ridge(X, y, lambda = 1e-6, opts = {}) {
  const n = X.length;
  if (!n) throw new Error('ml.ridge: empty design matrix');
  const d = X[0].length;
  const weightsIn = opts.sampleWeights || null;

  let wsum = 0;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = weightsIn ? weightsIn[i] : 1;
    wsum += w[i];
  }

  const xbar = new Float64Array(d);
  let ybar = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) xbar[j] += w[i] * X[i][j];
    ybar += w[i] * y[i];
  }
  for (let j = 0; j < d; j++) xbar[j] /= wsum;
  ybar /= wsum;

  const A = Array.from({ length: d }, () => new Float64Array(d));
  const b = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    const yc = y[i] - ybar;
    for (let j = 0; j < d; j++) {
      const xj = X[i][j] - xbar[j];
      b[j] += wi * xj * yc;
      for (let k = j; k < d; k++) A[j][k] += wi * xj * (X[i][k] - xbar[k]);
    }
  }
  for (let j = 0; j < d; j++) {
    for (let k = 0; k < j; k++) A[j][k] = A[k][j];
    A[j][j] += lambda;
  }

  const weights = solveSymmetric(A.map(r => Array.from(r)), Array.from(b));
  let intercept = ybar;
  for (let j = 0; j < d; j++) intercept -= weights[j] * xbar[j];
  return { weights, intercept };
}

// ---------------------------------------------------------------------------
// Poisson regression by IRLS.
//
// log(mu) = intercept + X w. The working response and weights are the standard
// canonical-link updates; the only additions are an eta clamp (exp(700)
// overflows to Infinity and poisons the whole system) and an unpenalized
// intercept column.
// ---------------------------------------------------------------------------

const ETA_CLAMP = 30;

function irls(X, y, opts, linkFns) {
  const n = X.length;
  const d = X[0].length;
  const lambda = opts.lambda === undefined ? 1e-6 : opts.lambda;
  const maxIter = opts.maxIter === undefined ? 50 : opts.maxIter;
  const tol = opts.tol === undefined ? 1e-8 : opts.tol;
  const sw = opts.sampleWeights || null;
  const p = d + 1; // column 0 is the intercept

  let beta = new Float64Array(p);
  beta[0] = linkFns.init(y);

  let iterations = 0;
  let converged = false;

  for (; iterations < maxIter; iterations++) {
    const A = Array.from({ length: p }, () => new Float64Array(p));
    const rhs = new Float64Array(p);
    const row = new Float64Array(p);

    for (let i = 0; i < n; i++) {
      row[0] = 1;
      for (let j = 0; j < d; j++) row[j + 1] = X[i][j];
      let eta = 0;
      for (let j = 0; j < p; j++) eta += beta[j] * row[j];
      if (eta > ETA_CLAMP) eta = ETA_CLAMP;
      if (eta < -ETA_CLAMP) eta = -ETA_CLAMP;

      const { mu, weight } = linkFns.step(eta);
      const wi = (sw ? sw[i] : 1) * weight;
      const z = eta + (y[i] - mu) / weight;

      for (let j = 0; j < p; j++) {
        rhs[j] += wi * row[j] * z;
        for (let k = j; k < p; k++) A[j][k] += wi * row[j] * row[k];
      }
    }

    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) A[j][k] = A[k][j];
      // Ridge the slopes only. Penalizing the intercept would bias the fitted
      // base rate toward exp(0) = 1, which is meaningless for points data.
      A[j][j] += j === 0 ? 1e-10 : lambda;
    }

    const next = solveSymmetric(A.map(r => Array.from(r)), Array.from(rhs));
    let maxDelta = 0;
    for (let j = 0; j < p; j++) maxDelta = Math.max(maxDelta, Math.abs(next[j] - beta[j]));
    beta = Float64Array.from(next);
    if (maxDelta < tol) {
      converged = true;
      iterations += 1;
      break;
    }
  }

  return {
    intercept: beta[0],
    weights: Array.from(beta.slice(1)),
    iterations,
    converged,
  };
}

export function poissonRegression(X, y, opts = {}) {
  return irls(X, y, opts, {
    init: (ys) => {
      let s = 0;
      for (const v of ys) s += v;
      const mean = Math.max(s / ys.length, 1e-6);
      return Math.log(mean);
    },
    step: (eta) => {
      const mu = Math.exp(eta);
      return { mu, weight: Math.max(mu, 1e-8) };
    },
  });
}

export function logisticRegression(X, y, opts = {}) {
  return irls(X, y, opts, {
    init: (ys) => {
      let s = 0;
      for (const v of ys) s += v;
      const rate = Math.min(Math.max(s / ys.length, 1e-4), 1 - 1e-4);
      return Math.log(rate / (1 - rate));
    },
    step: (eta) => {
      const mu = 1 / (1 + Math.exp(-eta));
      return { mu, weight: Math.max(mu * (1 - mu), 1e-6) };
    },
  });
}

export function linearPredict(model, row) {
  let eta = model.intercept;
  for (let j = 0; j < model.weights.length; j++) eta += model.weights[j] * row[j];
  return eta;
}

export function predictRidge(model, row) {
  return linearPredict(model, row);
}

export function predictPoisson(model, row) {
  const eta = Math.min(Math.max(linearPredict(model, row), -ETA_CLAMP), ETA_CLAMP);
  return Math.exp(eta);
}

export function predictLogistic(model, row) {
  const eta = Math.min(Math.max(linearPredict(model, row), -ETA_CLAMP), ETA_CLAMP);
  return 1 / (1 + Math.exp(-eta));
}

// ---------------------------------------------------------------------------
// Calibration
//
// Two methods with different failure modes, both usable through the same
// `predict` interface so a caller can swap them without changing code:
//
// - 'platt'  fits a 1-parameter logistic on the logit of the raw probability.
//            Cheap, monotone by construction, needs very little data, but can
//            only stretch or shift a sigmoid.
// - 'bins'   equal-count binning followed by pool-adjacent-violators, i.e. the
//            isotonic fit at bin resolution. It can represent an arbitrary
//            monotone distortion but needs enough data per bin to be stable.
// ---------------------------------------------------------------------------

const P_CLIP = 1e-6;

function clipProb(p) {
  return Math.min(Math.max(p, P_CLIP), 1 - P_CLIP);
}

function logit(p) {
  const c = clipProb(p);
  return Math.log(c / (1 - c));
}

// Pool adjacent violators: repeatedly merge any pair of neighbouring blocks
// whose means run backwards, until the sequence is non-decreasing. This is the
// exact isotonic regression solution for squared loss.
function poolAdjacentViolators(values, weights) {
  const v = values.slice();
  const w = weights.slice();
  let i = 0;
  while (i < v.length - 1) {
    if (v[i] <= v[i + 1] + 1e-12) {
      i++;
      continue;
    }
    const tw = w[i] + w[i + 1];
    v[i] = (v[i] * w[i] + v[i + 1] * w[i + 1]) / tw;
    w[i] = tw;
    v.splice(i + 1, 1);
    w.splice(i + 1, 1);
    if (i > 0) i--;
  }
  return { values: v, weights: w };
}

export function calibrate(probs, outcomes, method = 'bins', opts = {}) {
  if (probs.length !== outcomes.length) throw new Error('ml.calibrate: length mismatch');
  if (method === 'platt') {
    const X = probs.map(p => [logit(p)]);
    const fit = logisticRegression(X, outcomes, { lambda: opts.lambda === undefined ? 1e-6 : opts.lambda });
    return {
      method: 'platt',
      a: fit.weights[0],
      b: fit.intercept,
      n: probs.length,
      predict(p) {
        return predictLogistic(fit, [logit(p)]);
      },
      toJSON() {
        return { method: 'platt', a: fit.weights[0], b: fit.intercept, n: probs.length };
      },
    };
  }

  const nBins = opts.bins || 10;
  const idx = probs.map((p, i) => i).sort((a, b) => probs[a] - probs[b] || a - b);
  const per = Math.max(1, Math.floor(idx.length / nBins));
  const raw = [];
  let start = 0;
  while (start < idx.length) {
    // Fold a short trailing remainder into the last bin instead of shipping a
    // 1-sample bin whose observed rate is 0 or 1.
    const end = idx.length - (start + per) < per ? idx.length : start + per;
    const slice = idx.slice(start, end);
    let sp = 0;
    let so = 0;
    for (const i of slice) {
      sp += probs[i];
      so += outcomes[i];
    }
    raw.push({
      lo: probs[slice[0]],
      hi: probs[slice[slice.length - 1]],
      n: slice.length,
      meanPredicted: sp / slice.length,
      observed: so / slice.length,
    });
    start = end;
  }

  const pav = poolAdjacentViolators(raw.map(b => b.observed), raw.map(b => b.n));
  // Spread the pooled block values back over the original bins.
  const smoothed = [];
  let cursor = 0;
  for (let bi = 0; bi < pav.values.length; bi++) {
    let remaining = pav.weights[bi];
    while (remaining > 1e-9 && cursor < raw.length) {
      smoothed.push({ ...raw[cursor], observed: pav.values[bi] });
      remaining -= raw[cursor].n;
      cursor++;
    }
  }
  while (cursor < raw.length) smoothed.push({ ...raw[cursor++] });

  const points = smoothed.map(b => ({ x: b.meanPredicted, y: b.observed }));

  function predict(p) {
    if (!points.length) return p;
    if (p <= points[0].x) return points[0].y;
    if (p >= points[points.length - 1].x) return points[points.length - 1].y;
    for (let i = 1; i < points.length; i++) {
      if (p <= points[i].x) {
        const a = points[i - 1];
        const b = points[i];
        const t = b.x === a.x ? 0 : (p - a.x) / (b.x - a.x);
        return a.y + t * (b.y - a.y);
      }
    }
    return points[points.length - 1].y;
  }

  return {
    method: 'bins',
    bins: smoothed,
    n: probs.length,
    predict,
    toJSON() {
      return { method: 'bins', n: probs.length, points };
    },
  };
}

// Rehydrate a calibrator that was serialized into a model artifact.
export function calibratorFromJSON(json) {
  if (!json) return null;
  if (json.method === 'platt') {
    const model = { intercept: json.b, weights: [json.a] };
    return { method: 'platt', predict: (p) => predictLogistic(model, [logit(p)]) };
  }
  const points = json.points || [];
  return {
    method: 'bins',
    predict(p) {
      if (!points.length) return p;
      if (p <= points[0].x) return points[0].y;
      if (p >= points[points.length - 1].x) return points[points.length - 1].y;
      for (let i = 1; i < points.length; i++) {
        if (p <= points[i].x) {
          const a = points[i - 1];
          const b = points[i];
          const t = b.x === a.x ? 0 : (p - a.x) / (b.x - a.x);
          return a.y + t * (b.y - a.y);
        }
      }
      return points[points.length - 1].y;
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics. Target-appropriate by design: MAE/RMSE for points, Poisson deviance
// for counts, log loss / Brier / calibration bins for probabilities.
// ---------------------------------------------------------------------------

export const metrics = {
  mae(y, yhat) {
    let s = 0;
    for (let i = 0; i < y.length; i++) s += Math.abs(y[i] - yhat[i]);
    return s / y.length;
  },

  rmse(y, yhat) {
    let s = 0;
    for (let i = 0; i < y.length; i++) {
      const d = y[i] - yhat[i];
      s += d * d;
    }
    return Math.sqrt(s / y.length);
  },

  logLoss(y, p) {
    let s = 0;
    for (let i = 0; i < y.length; i++) {
      const c = clipProb(p[i]);
      s += y[i] ? -Math.log(c) : -Math.log(1 - c);
    }
    return s / y.length;
  },

  brier(y, p) {
    let s = 0;
    for (let i = 0; i < y.length; i++) {
      const d = p[i] - y[i];
      s += d * d;
    }
    return s / y.length;
  },

  // Mean unit deviance for the Poisson family. 2 * sum(y*log(y/mu) - (y - mu)),
  // with the y = 0 term taken at its limit of 0.
  poissonDeviance(y, mu) {
    let s = 0;
    for (let i = 0; i < y.length; i++) {
      const m = Math.max(mu[i], 1e-9);
      const term = y[i] > 0 ? y[i] * Math.log(y[i] / m) - (y[i] - m) : m;
      s += 2 * term;
    }
    return s / y.length;
  },

  // Fixed-width bins across [0,1]. Returns the bins plus expected calibration
  // error (sample-weighted mean gap) and the worst single-bin gap.
  calibrationBins(p, y, nBins = 10) {
    const bins = [];
    for (let i = 0; i < nBins; i++) {
      bins.push({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, sumPredicted: 0, sumObserved: 0 });
    }
    for (let i = 0; i < p.length; i++) {
      const b = Math.min(nBins - 1, Math.max(0, Math.floor(p[i] * nBins)));
      bins[b].n++;
      bins[b].sumPredicted += p[i];
      bins[b].sumObserved += y[i];
    }
    let ece = 0;
    let maxGap = 0;
    const out = bins.map(b => {
      const meanPredicted = b.n ? b.sumPredicted / b.n : 0;
      const observedRate = b.n ? b.sumObserved / b.n : 0;
      if (b.n) {
        const gap = Math.abs(meanPredicted - observedRate);
        ece += (b.n / p.length) * gap;
        maxGap = Math.max(maxGap, gap);
      }
      return { lo: b.lo, hi: b.hi, n: b.n, meanPredicted, observedRate };
    });
    return { bins: out, ece, maxGap, n: p.length };
  },
};

// ---------------------------------------------------------------------------
// Poisson distribution helpers.
//
// Computed by forward recurrence (p(k) = p(k-1) * lambda / k) rather than
// lambda^k / k!, because the factorial overflows long before the probabilities
// stop mattering.
// ---------------------------------------------------------------------------

export function poissonPmf(k, lambda) {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p = (p * lambda) / i;
  return p;
}

// Probability vector over 0..maxK with everything above maxK folded into the
// last cell, so the vector always sums to exactly 1 (to floating point). That
// property is what makes the fixture model's outcome probabilities sum to 1.
export function poissonVector(lambda, maxK) {
  const out = new Array(maxK + 1).fill(0);
  if (lambda <= 0) {
    out[0] = 1;
    return out;
  }
  let p = Math.exp(-lambda);
  let cum = 0;
  for (let k = 0; k < maxK; k++) {
    out[k] = p;
    cum += p;
    p = (p * lambda) / (k + 1);
  }
  out[maxK] = Math.max(0, 1 - cum);
  return out;
}

// P(N >= k)
export function poissonTail(k, lambda) {
  if (k <= 0) return 1;
  if (lambda <= 0) return 0;
  let p = Math.exp(-lambda);
  let cum = p;
  for (let i = 1; i < k; i++) {
    p = (p * lambda) / i;
    cum += p;
  }
  return Math.min(1, Math.max(0, 1 - cum));
}

// ---------------------------------------------------------------------------
// Discrete distribution algebra over INTEGER values.
//
// FPL points are integers, and every component of a player's score is an
// integer count. Composing the components by convolution therefore gives the
// exact point distribution rather than a normal approximation, which matters
// because the distribution is strongly zero-inflated (a player who does not
// play scores nothing) and a normal quantile would put the "ceiling" in the
// wrong place for exactly the differential picks that decision hinges on.
//
// Shape: { offset, p } where p[i] = P(value === offset + i).
// ---------------------------------------------------------------------------

export function distPoint(value) {
  return { offset: value, p: [1] };
}

export function distFrom(offset, probs) {
  return { offset, p: probs.slice() };
}

export function distBernoulli(prob, value) {
  if (value === 0) return distPoint(0);
  const lo = Math.min(0, value);
  const hi = Math.max(0, value);
  const p = new Array(hi - lo + 1).fill(0);
  p[0 - lo] += 1 - prob;
  p[value - lo] += prob;
  return { offset: lo, p };
}

export function distConvolve(a, b) {
  const p = new Array(a.p.length + b.p.length - 1).fill(0);
  for (let i = 0; i < a.p.length; i++) {
    const ai = a.p[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.p.length; j++) p[i + j] += ai * b.p[j];
  }
  return { offset: a.offset + b.offset, p };
}

export function distMix(parts) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const { dist } of parts) {
    lo = Math.min(lo, dist.offset);
    hi = Math.max(hi, dist.offset + dist.p.length - 1);
  }
  if (!Number.isFinite(lo)) return distPoint(0);
  const p = new Array(hi - lo + 1).fill(0);
  for (const { weight, dist } of parts) {
    if (!weight) continue;
    for (let i = 0; i < dist.p.length; i++) p[dist.offset + i - lo] += weight * dist.p[i];
  }
  return { offset: lo, p };
}

export function distMean(d) {
  let s = 0;
  for (let i = 0; i < d.p.length; i++) s += d.p[i] * (d.offset + i);
  return s;
}

export function distVariance(d) {
  const m = distMean(d);
  let s = 0;
  for (let i = 0; i < d.p.length; i++) {
    const v = d.offset + i - m;
    s += d.p[i] * v * v;
  }
  return s;
}

// Smallest value v with P(X <= v) >= q. Used for the projection ceiling.
export function distQuantile(d, q) {
  let cum = 0;
  for (let i = 0; i < d.p.length; i++) {
    cum += d.p[i];
    if (cum >= q - 1e-12) return d.offset + i;
  }
  return d.offset + d.p.length - 1;
}
