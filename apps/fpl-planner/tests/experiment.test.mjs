// The experiment runner's arithmetic, checked against published values rather
// than against itself.
//
// This is the module that decides whether a change ships, so a bug in it is
// worse than a bug in anything it measures: it would not produce a wrong plan,
// it would produce a wrong VERDICT, and the verdict is what gets written down
// and believed for a year. Every statistic below is therefore checked against a
// t-table, a hand-computed binomial or an arithmetic identity, never against
// another function in the same file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INSTRUMENTS,
  CONTROL_ARM,
  buildCells,
  trajectoryKey,
  pairArms,
  pairedStats,
  tTestP,
  tCritical,
  signTestP,
  incompleteBeta,
  formatReport,
} from '../js/engine/experiment.js';
import { KNOWN_SEASONS } from '../scripts/backtest.mjs';

const ARMS = [{ name: 'control' }, { name: 'candidate' }];

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('the deciding instrument is 60 trajectories over the replayable seasons', () => {
  const i = INSTRUMENTS.paired;
  // The season count comes from the source of truth (scripts/backtest.mjs
  // KNOWN_SEASONS), not from a literal: this test used to hardcode "3 seasons
  // = 45", which survived the fourth season qualifying (registry entry 15) and
  // could never fail again. When THIS fails, the season list moved: update the
  // literal here and the trajectory counts quoted in README.md, FINDINGS.md
  // and experiments/registry.md in the same change.
  assert.equal(KNOWN_SEASONS.length * i.windows.length * i.seeds.length, 60);
  assert.equal(i.windows.length, 5, 'five sliding windows per season');
  assert.equal(i.seeds.length, 3, 'three seeds per window');
  assert.equal(i.chips, false);
  assert.equal(i.rank, 3);
  // The seasons are the caller's, not the instrument's: a season label inside
  // js/engine is what tests/rules.test.mjs exists to refuse.
  assert.equal(i.seasons, undefined);
});

test('buildCells covers every season x window x seed x arm exactly once', () => {
  const cells = buildCells({ seasons: ['a', 'b'], windows: [[1, 5], [6, 10]], seeds: [1, 2, 3], arms: ARMS });
  assert.equal(cells.length, 2 * 2 * 3 * 2);
  assert.equal(new Set(cells.map(c => c.id)).size, cells.length);
  // Two arms per trajectory and no more, which is what makes the pairing legal.
  const byTrajectory = new Map();
  for (const c of cells) byTrajectory.set(c.trajectory, (byTrajectory.get(c.trajectory) || 0) + 1);
  assert.equal(byTrajectory.size, 12);
  for (const n of byTrajectory.values()) assert.equal(n, 2);
});

test('buildCells is deterministic', () => {
  const args = { seasons: ['a', 'b'], windows: [[1, 5]], seeds: [1, 2], arms: ARMS };
  assert.deepEqual(buildCells(args).map(c => c.id), buildCells(args).map(c => c.id));
});

test('an experiment without a control arm is refused', () => {
  assert.throws(
    () => buildCells({ seasons: ['a'], windows: [[1, 5]], seeds: [1], arms: [{ name: 'a' }, { name: 'b' }] }),
    /must be named "control"/,
  );
});

test('duplicate arm names are refused, because they would silently overwrite a pairing', () => {
  assert.throws(
    () => buildCells({ seasons: ['a'], windows: [[1, 5]], seeds: [1], arms: [{ name: CONTROL_ARM }, { name: CONTROL_ARM }] }),
    /duplicate arm names/,
  );
});

test('a trajectory key names the season, window and seed and nothing else', () => {
  // The arm must NOT be part of it: the key is what two arms are paired on.
  assert.equal(trajectoryKey({ season: '2024-25', window: [7, 19], seed: 3 }), '2024-25|gw7-19|seed3');
});

// ---------------------------------------------------------------------------
// Statistics, against published tables
// ---------------------------------------------------------------------------

test('the incomplete beta matches values with closed forms', () => {
  // I_x(1,1) = x, and I_0.5(a,a) = 0.5 for any a by symmetry.
  assert.ok(Math.abs(incompleteBeta(1, 1, 0.37) - 0.37) < 1e-9);
  assert.ok(Math.abs(incompleteBeta(3, 3, 0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(incompleteBeta(0.5, 0.5, 0.5) - 0.5) < 1e-9);
  assert.equal(incompleteBeta(2, 3, 0), 0);
  assert.equal(incompleteBeta(2, 3, 1), 1);
});

test('two-sided t p-values match a printed t-table', () => {
  // Textbook two-sided critical values: p is 0.05 at these (t, df) pairs.
  for (const [t, df] of [[12.706, 1], [4.303, 2], [2.262, 9], [2.086, 20], [2.015, 44], [1.960, 100000]]) {
    const p = tTestP(t, df);
    assert.ok(Math.abs(p - 0.05) < 5e-4, `t=${t} df=${df} gave p=${p}`);
  }
  // And a value away from the 5% line: t = 1 on 10 df is p = 0.3409.
  assert.ok(Math.abs(tTestP(1, 10) - 0.3409) < 1e-3);
  assert.ok(Math.abs(tTestP(0, 10) - 1) < 1e-12);
});

test('the critical value inverts the p-value', () => {
  for (const df of [1, 2, 9, 20, 44, 100]) {
    const crit = tCritical(df);
    assert.ok(Math.abs(tTestP(crit, df) - 0.05) < 1e-6);
  }
  assert.ok(Math.abs(tCritical(9) - 2.262) < 1e-3);
  assert.ok(Math.abs(tCritical(44) - 2.015) < 1e-3);
});

test('the sign test is the exact binomial, hand-computed', () => {
  // 5 wins, 0 losses: two-sided p = 2 * 0.5^5.
  assert.ok(Math.abs(signTestP(5, 0) - 2 * 0.5 ** 5) < 1e-12);
  // 4 wins, 1 loss: 2 * (C(5,0) + C(5,1)) / 2^5 = 2 * 6/32.
  assert.ok(Math.abs(signTestP(4, 1) - (2 * 6) / 32) < 1e-12);
  assert.equal(signTestP(3, 3), 1);
  assert.equal(signTestP(0, 0), 1);
  // Symmetric in its arguments: a loss is a win seen from the other arm.
  assert.equal(signTestP(9, 2), signTestP(2, 9));
});

test('pairedStats agrees with arithmetic done by hand', () => {
  const deltas = [10, -4, 6, 0, 8];
  const s = pairedStats(deltas);
  assert.equal(s.n, 5);
  assert.equal(s.total, 20);
  assert.equal(s.mean, 4);
  // Sample variance: ((6)^2 + (-8)^2 + 2^2 + (-4)^2 + 4^2) / 4 = 136/4 = 34.
  assert.ok(Math.abs(s.sd - Math.sqrt(34)) < 1e-12);
  assert.ok(Math.abs(s.se - Math.sqrt(34 / 5)) < 1e-12);
  assert.ok(Math.abs(s.t - 4 / Math.sqrt(34 / 5)) < 1e-12);
  assert.deepEqual([s.wins, s.losses, s.ties], [3, 1, 1]);
  // The interval is centred on the mean and its half-width is crit * se.
  assert.ok(Math.abs((s.ci[0] + s.ci[1]) / 2 - s.mean) < 1e-9);
  assert.ok(Math.abs((s.ci[1] - s.ci[0]) / 2 - tCritical(4) * s.se) < 1e-9);
});

test('a single trajectory has no standard error to report and does not pretend to', () => {
  const s = pairedStats([12]);
  assert.equal(s.n, 1);
  assert.equal(s.se, 0);
  assert.equal(s.t, 0);
  assert.equal(s.p, 1);
});

test('an all-zero difference is a tie, not a win', () => {
  const s = pairedStats([0, 0, 0]);
  assert.deepEqual([s.wins, s.losses, s.ties], [0, 0, 3]);
  assert.equal(s.t, 0);
  assert.equal(s.signP, 1);
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

const result = (season, window, seed, arm, points) => ({
  trajectory: trajectoryKey({ season, window, seed }),
  season,
  window,
  seed,
  arm,
  points,
});

test('arms are differenced on the same trajectory, never across trajectories', () => {
  const results = [
    result('2023-24', [1, 13], 1, 'control', 700),
    result('2023-24', [1, 13], 1, 'candidate', 720),
    result('2023-24', [1, 13], 2, 'control', 650),
    result('2023-24', [1, 13], 2, 'candidate', 640),
    result('2024-25', [1, 13], 1, 'control', 800),
    result('2024-25', [1, 13], 1, 'candidate', 830),
  ];
  const [c] = pairArms(results, { arms: ['control', 'candidate'] });
  assert.equal(c.arm, 'candidate');
  assert.equal(c.pairs.length, 3);
  assert.deepEqual(c.pairs.map(p => p.delta), [20, -10, 30]);
  assert.equal(c.stats.total, 40);
  assert.equal(c.controlTotal, 2150);
  assert.equal(c.candidateTotal, 2190);
  // The identity that says the pairing did not lose or double count anything.
  assert.equal(c.candidateTotal - c.controlTotal, c.stats.total);
});

test('seeds through one window are averaged, not counted as separate evidence', () => {
  // The trap this exists for: an effect that lands in ONE window shows up once
  // per seed and reads as three consistent observations. Here the effect is
  // +90 in a single window and zero in another, which per trajectory looks like
  // three wins and three ties, and per window is one win and one tie.
  const results = [];
  for (const seed of [1, 2, 3]) {
    results.push(result('2023-24', [20, 32], seed, 'control', 600));
    results.push(result('2023-24', [20, 32], seed, 'candidate', 690));
    results.push(result('2023-24', [1, 13], seed, 'control', 700));
    results.push(result('2023-24', [1, 13], seed, 'candidate', 700));
  }
  const [c] = pairArms(results, { arms: ['control', 'candidate'] });

  assert.equal(c.stats.n, 6, 'six trajectories');
  assert.equal(c.windowStats.n, 2, 'two windows');
  assert.equal(c.stats.total, 270, 'the trajectory total triple counts the effect');
  assert.equal(c.windowStats.total, 90, 'the window total counts it once');
  assert.deepEqual([c.stats.wins, c.stats.ties], [3, 3]);
  assert.deepEqual([c.windowStats.wins, c.windowStats.ties], [1, 1]);
  // Windows come out in trajectory-key order, so gw1-13 precedes gw20-32.
  assert.deepEqual(c.windows.map(w => `gw${w.window[0]}-${w.window[1]}`), ['gw1-13', 'gw20-32']);
  assert.deepEqual(c.windows.map(w => w.delta), [0, 90]);
  assert.deepEqual(c.windows.map(w => w.seeds), [3, 3]);
});

test('with one seed the window statistic and the trajectory statistic agree', () => {
  const results = [];
  for (const window of [[1, 13], [14, 26], [27, 38]]) {
    results.push(result('2024-25', window, 1, 'control', 700));
    results.push(result('2024-25', window, 1, 'candidate', 700 + window[0]));
  }
  const [c] = pairArms(results, { arms: ['control', 'candidate'] });
  assert.equal(c.stats.n, c.windowStats.n);
  assert.equal(c.stats.total, c.windowStats.total);
  assert.equal(c.stats.t, c.windowStats.t);
});

test('a trajectory missing one arm is reported, not silently dropped', () => {
  const results = [
    result('2024-25', [1, 13], 1, 'control', 800),
    result('2024-25', [1, 13], 1, 'candidate', 830),
    result('2024-25', [1, 13], 2, 'control', 790),
  ];
  const [c] = pairArms(results, { arms: ['control', 'candidate'] });
  assert.equal(c.pairs.length, 1);
  assert.deepEqual(c.incomplete, ['2024-25|gw1-13|seed2']);
});

test('per-season splits sum to the aggregate', () => {
  const results = [];
  for (const [season, base] of [['2022-23', 600], ['2023-24', 700], ['2024-25', 800]]) {
    for (const seed of [1, 2, 3]) {
      results.push(result(season, [1, 13], seed, 'control', base + seed));
      results.push(result(season, [1, 13], seed, 'candidate', base + seed * 2));
    }
  }
  const [c] = pairArms(results, { arms: ['control', 'candidate'] });
  assert.equal(c.bySeason.length, 3);
  assert.equal(c.bySeason.reduce((s, r) => s + r.stats.total, 0), c.stats.total);
  assert.equal(c.bySeason.reduce((s, r) => s + r.stats.n, 0), c.stats.n);
});

test('three arms produce two comparisons, both against the one control', () => {
  const results = [];
  for (const arm of ['control', 'a', 'b']) {
    results.push(result('2024-25', [1, 13], 1, arm, arm === 'control' ? 100 : arm === 'a' ? 110 : 90));
  }
  const comparisons = pairArms(results, { arms: ['control', 'a', 'b'] });
  assert.deepEqual(comparisons.map(c => c.arm), ['a', 'b']);
  assert.deepEqual(comparisons.map(c => c.stats.total), [10, -10]);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test('the report states the split, the caveat and the fact that it is not a verdict', () => {
  const results = [
    result('2024-25', [1, 13], 1, 'control', 800),
    result('2024-25', [1, 13], 1, 'candidate', 830),
  ];
  const config = {
    name: 'demo',
    question: 'does it?',
    instrumentLabel: INSTRUMENTS.paired.label,
    instrumentRank: 3,
    seasons: ['2024-25'],
    windows: [[1, 13]],
    seeds: [1],
    chips: false,
    strategy: 'planner',
    horizon: null,
    risk: 'balanced',
    arms: [{ name: 'control' }, { name: 'candidate', description: 'the thing' }],
  };
  const md = formatReport({
    config,
    comparisons: pairArms(results, { arms: ['control', 'candidate'] }),
    results,
    fingerprint: { engine: 'abc123', data: '2 files, def456', git: 'deadbee', dirty: true },
    runtimeMs: 1000,
  });

  assert.match(md, /# Experiment: demo/);
  assert.match(md, /per window \(seeds averaged\)/);
  assert.match(md, /wins \/ losses \/ ties \| 1 \/ 0 \/ 0 \| 1 \/ 0 \/ 0/);
  assert.match(md, /engine abc123/);
  assert.match(md, /\(dirty\)/);
  assert.match(md, /standard error above is optimistic/);
  assert.match(md, /evidence, not a verdict/);
  assert.match(md, /Prediction metrics decide nothing/);
});

// ---------------------------------------------------------------------------
// Declared exposure: structural windows are controls, not observations
// ---------------------------------------------------------------------------

test('declared exposure excludes structural windows from inference but keeps them in the table', () => {
  const results = [];
  // Two exposed seasons with a +12 effect, one structural season at exactly 0.
  for (const [season, effect] of [['2023-24', 12], ['2024-25', 12], ['2022-23', 0]]) {
    for (const window of [[1, 13], [14, 26]]) {
      for (const seed of [1, 2]) {
        results.push(result(season, window, seed, 'control', 700));
        results.push(result(season, window, seed, 'candidate', 700 + effect));
      }
    }
  }
  const noExposure = pairArms(results, { arms: ['control', 'candidate'] })[0];
  const withExposure = pairArms(results, {
    arms: ['control', 'candidate'],
    exposure: { seasons: ['2023-24', '2024-25'] },
  })[0];

  assert.equal(noExposure.windowStats.n, 6, 'all six windows without a declaration');
  assert.equal(withExposure.windowStats.n, 4, 'primary inference on the exposed four');
  assert.equal(withExposure.structuralWindowCount, 2);
  assert.equal(withExposure.windows.length, 6, 'the table still carries every window');
  assert.ok(Math.abs(withExposure.windowStats.mean - 12) < 1e-9, 'the mean is no longer diluted');
  assert.ok(Math.abs(noExposure.windowStats.mean - 8) < 1e-9, 'the diluted mean this exists to avoid');
  assert.deepEqual(withExposure.structuralLeaks, [], 'zeros where zeros belong');
  // Ties in W/L/T: exposed windows only.
  assert.deepEqual([withExposure.windowStats.wins, withExposure.windowStats.losses, withExposure.windowStats.ties], [4, 0, 0]);
});

test('a declared-structural window that moves raises the scope-leak alarm', () => {
  const results = [
    result('2023-24', [1, 13], 1, 'control', 700),
    result('2023-24', [1, 13], 1, 'candidate', 710),
    result('2022-23', [1, 13], 1, 'control', 600),
    result('2022-23', [1, 13], 1, 'candidate', 605),  // MUST be zero; it is not
  ];
  const c = pairArms(results, { arms: ['control', 'candidate'], exposure: { seasons: ['2023-24'] } })[0];
  assert.deepEqual(c.structuralLeaks, ['2022-23|gw1-13']);
  const md = formatReport({
    config: {
      name: 'leak', question: null, instrumentLabel: 'x', instrumentRank: 3,
      seasons: ['2022-23', '2023-24'], windows: [[1, 13]], seeds: [1], chips: false,
      strategy: 'planner', horizon: null, risk: 'balanced',
      arms: [{ name: 'control' }, { name: 'candidate' }], exposure: { seasons: ['2023-24'] },
    },
    comparisons: [c],
    results,
    fingerprint: null,
    runtimeMs: 0,
  });
  assert.match(md, /ALARM - SCOPE LEAK/);
  assert.match(md, /2022-23 \(structural\)/);
});

test('no declared exposure is the old behaviour exactly', () => {
  const results = [
    result('2024-25', [1, 13], 1, 'control', 800),
    result('2024-25', [1, 13], 1, 'candidate', 830),
  ];
  const a = pairArms(results, { arms: ['control', 'candidate'] })[0];
  assert.equal(a.exposure, null);
  assert.equal(a.structuralWindowCount, 0);
  assert.equal(a.windowStats.n, 1);
});
