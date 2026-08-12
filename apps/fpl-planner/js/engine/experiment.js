// Paired-trajectory experiments: the plan, the statistics and the report.
//
// WHY THIS EXISTS. `experiments/registry.md` ranks three measurement
// instruments and names the third one, 45 paired trajectories, as the one that
// decides. Every experiment in that file was nevertheless argued from the
// weaker two, because the strong one was a manual afternoon: freeze a copy of
// the tree, edit a constant, run ninety replays by hand, paste the numbers into
// a table. Three verdicts in the file are wrong or void, and in every case the
// reason is a measurement mistake rather than a modelling one.
//
// This module is the arithmetic of that instrument, kept pure and away from the
// process pool that runs it (`scripts/experiment.mjs`), so it can be tested
// against hand-computed values rather than against itself.
//
// THE DESIGN, IN ONE PARAGRAPH. A CELL is one replay: a season, a gameweek
// window, a seed and an ARM. An arm is a named configuration difference, and
// exactly one of them is the control. A TRAJECTORY is a (season, window, seed)
// triple, and every arm is replayed on every trajectory, so each arm's number
// can be differenced against the control's on the SAME trajectory. That pairing
// is the whole point: the seed alone moves a single window by 20 to 30 points,
// which is larger than most effects worth shipping, and pairing cancels it
// instead of letting it masquerade as signal.
//
// WHAT IS DELIBERATELY NOT HERE. No verdict is computed. The runner reports
// mean, standard error, t, the win/loss/tie split and the per-season
// breakdown, and a human reads them against the rules in registry.md. An
// automatic ACCEPT would be a rule with no mechanism, and this project has
// already rejected one of those.

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// The instruments registry.md defines, as data. `paired` is the decider: five
// SLIDING windows per season, so a trajectory boundary is never a property of
// the calendar, times three seeds. The windows overlap on purpose (they cover
// the season more than once) and that overlap is reported as a caveat rather
// than corrected for, because correcting it would need a model of the
// correlation between overlapping replays that nobody has.
//
// WHICH SEASONS is deliberately NOT here. It is a fact about what has been
// downloaded onto a particular machine, not about the instrument, and a season
// label in an engine module is exactly what `tests/rules.test.mjs` refuses. The
// caller supplies it; on three seasons `paired` is the 45 trajectories the
// registry names.
export const INSTRUMENTS = Object.freeze({
  paired: {
    key: 'paired',
    label: 'Paired trajectories (5 sliding windows x 3 seeds per season, chips off)',
    windows: [[1, 13], [7, 19], [14, 26], [20, 32], [27, 38]],
    seeds: [1, 2, 3],
    chips: false,
    rank: 3,
  },
  windows: {
    key: 'windows',
    label: 'Chip-free thirds (3 splits per season, one seed)',
    windows: [[1, 13], [14, 26], [27, 38]],
    seeds: [1],
    chips: false,
    rank: 2,
  },
  seasons: {
    key: 'seasons',
    label: 'Full seasons with chips (one seed)',
    windows: [[1, 38]],
    seeds: [1],
    chips: true,
    rank: 1,
  },
});

export const CONTROL_ARM = 'control';

export function trajectoryKey({ season, window, seed }) {
  return `${season}|gw${window[0]}-${window[1]}|seed${seed}`;
}

// Every cell the experiment needs, in a deterministic order. The order matters
// only for reproducibility of the log; the pool hands them out as workers free
// up, so wall-clock order is not this order.
export function buildCells({ seasons, windows, seeds, arms }) {
  if (!arms || !arms.length) throw new Error('experiment: at least one arm is required');
  const names = arms.map(a => a.name);
  if (new Set(names).size !== names.length) throw new Error(`experiment: duplicate arm names in [${names.join(', ')}]`);
  if (!names.includes(CONTROL_ARM)) {
    throw new Error(`experiment: one arm must be named "${CONTROL_ARM}"; got [${names.join(', ')}]`);
  }

  const cells = [];
  for (const season of seasons) {
    for (const window of windows) {
      for (const seed of seeds) {
        for (const arm of arms) {
          cells.push({
            id: `${season}|gw${window[0]}-${window[1]}|seed${seed}|${arm.name}`,
            trajectory: trajectoryKey({ season, window, seed }),
            season,
            window,
            seed,
            arm: arm.name,
          });
        }
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Statistics
//
// A paired difference per trajectory, and the two tests that read it: a t on
// the mean, and a sign test on the win/loss split. They answer different
// questions and disagreeing is informative. The t is sensitive to one enormous
// trajectory (a forked chip, a wildcard landing differently), the sign test is
// not and is correspondingly blunt.
// ---------------------------------------------------------------------------

// Continued fraction for the incomplete beta function (Numerical Recipes 6.4),
// which is all the special-function machinery the two tests need.
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Regularized incomplete beta I_x(a, b).
export function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

// Two-sided p for Student's t. I_{df/(df+t^2)}(df/2, 1/2) IS that p, with no
// integration step of its own.
export function tTestP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return 1;
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

// The two-sided 95% critical value, by bisection on the p above. Exact enough
// to quote a confidence interval and short enough to read.
export function tCritical(df, alpha = 0.05) {
  if (df <= 0) return NaN;
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTestP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Two-sided sign test on wins against losses, ties discarded. Exact binomial
// at p = 0.5, which for the sample sizes here is cheap and needs no
// approximation.
export function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(gammaln(n + 1) - gammaln(i + 1) - gammaln(n - i + 1) - n * Math.LN2);
  }
  return Math.min(1, 2 * sum);
}

// The paired summary of a list of per-trajectory differences.
export function pairedStats(deltas) {
  const n = deltas.length;
  if (!n) {
    return { n: 0, total: 0, mean: 0, sd: 0, se: 0, t: 0, p: 1, ci: [0, 0], wins: 0, losses: 0, ties: 0, signP: 1 };
  }
  const total = deltas.reduce((s, d) => s + d, 0);
  const mean = total / n;
  const variance = n > 1 ? deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  const t = se > 0 ? mean / se : 0;
  const df = n - 1;
  const crit = df > 0 ? tCritical(df) : 0;
  const wins = deltas.filter(d => d > 0).length;
  const losses = deltas.filter(d => d < 0).length;
  return {
    n,
    total,
    mean,
    sd,
    se,
    t,
    p: df > 0 ? tTestP(t, df) : 1,
    ci: [mean - crit * se, mean + crit * se],
    wins,
    losses,
    ties: n - wins - losses,
    signP: signTestP(wins, losses),
  };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

// Results in, per-arm comparisons out. A trajectory missing either side is
// REPORTED rather than dropped silently: a pair that failed to run is a hole in
// the instrument, and an instrument with holes should say so.
export function pairArms(results, { arms, controlArm = CONTROL_ARM } = {}) {
  const byTrajectory = new Map();
  for (const r of results) {
    if (!byTrajectory.has(r.trajectory)) byTrajectory.set(r.trajectory, new Map());
    byTrajectory.get(r.trajectory).set(r.arm, r);
  }

  const armNames = arms || [...new Set(results.map(r => r.arm))];
  const candidates = armNames.filter(a => a !== controlArm);
  const comparisons = [];

  for (const arm of candidates) {
    const pairs = [];
    const incomplete = [];
    for (const [trajectory, byArm] of byTrajectory) {
      const control = byArm.get(controlArm);
      const candidate = byArm.get(arm);
      if (!control || !candidate) {
        incomplete.push(trajectory);
        continue;
      }
      pairs.push({
        trajectory,
        season: control.season,
        window: control.window,
        seed: control.seed,
        control: control.points,
        candidate: candidate.points,
        delta: candidate.points - control.points,
      });
    }
    pairs.sort((a, b) => (a.trajectory < b.trajectory ? -1 : 1));

    const bySeason = new Map();
    for (const p of pairs) {
      if (!bySeason.has(p.season)) bySeason.set(p.season, []);
      bySeason.get(p.season).push(p);
    }

    // Seeds are not samples of the world. Three seeds through one window are
    // the same thirteen gameweeks of the same season with a different search
    // RNG, so they share every fixture, every price and every injury. Pairing
    // cancels the seed's noise, which is what it is for, but it does not turn
    // three correlated replays into three independent observations: an effect
    // that lands in one window shows up three times and reads as consistency.
    //
    // The honest unit is therefore the WINDOW, with the seeds averaged inside
    // it. On the standard instrument that is 15 observations rather than 45,
    // and it is the number the verdict should be read off.
    const byWindowKey = new Map();
    for (const p of pairs) {
      const key = `${p.season}|gw${p.window[0]}-${p.window[1]}`;
      if (!byWindowKey.has(key)) byWindowKey.set(key, { key, season: p.season, window: p.window, deltas: [] });
      byWindowKey.get(key).deltas.push(p.delta);
    }
    const windows = [...byWindowKey.values()].map(w => ({
      ...w,
      seeds: w.deltas.length,
      delta: w.deltas.reduce((s, d) => s + d, 0) / w.deltas.length,
    }));

    comparisons.push({
      arm,
      controlArm,
      pairs,
      incomplete,
      stats: pairedStats(pairs.map(p => p.delta)),
      windows,
      windowStats: pairedStats(windows.map(w => w.delta)),
      controlTotal: pairs.reduce((s, p) => s + p.control, 0),
      candidateTotal: pairs.reduce((s, p) => s + p.candidate, 0),
      bySeason: [...bySeason.entries()].map(([season, list]) => ({
        season,
        stats: pairedStats(list.map(p => p.delta)),
        controlTotal: list.reduce((s, p) => s + p.control, 0),
        candidateTotal: list.reduce((s, p) => s + p.candidate, 0),
      })),
    });
  }

  return comparisons;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const n1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const signed = (v, fmt = n1) => `${v >= 0 ? '+' : ''}${fmt(v)}`;

// A markdown report an experiment write-up can quote directly, and which states
// the things a table of totals hides: the split, the spread, the holes and the
// fact that overlapping windows make the standard error optimistic.
export function formatReport({ config, comparisons, results, fingerprint, runtimeMs }) {
  const out = [];
  const arms = config.arms.map(a => a.name);

  out.push(`# Experiment: ${config.name}`);
  out.push('');
  if (config.question) {
    out.push(`**Question:** ${config.question}`);
    out.push('');
  }
  out.push(`- **Instrument:** ${config.instrumentLabel} (rank ${config.instrumentRank} of 3 in registry.md)`);
  out.push(`- **Seasons:** ${config.seasons.join(', ')}`);
  out.push(`- **Windows:** ${config.windows.map(w => `gw${w[0]}-${w[1]}`).join(', ')}`);
  out.push(`- **Seeds:** ${config.seeds.join(', ')}`);
  out.push(`- **Chips:** ${config.chips ? 'in play' : 'removed from the rules catalogue'}`);
  out.push(`- **Strategy:** ${config.strategy}, horizon ${config.horizon === null ? 'shipped default' : config.horizon}, risk ${config.risk}`);
  out.push(`- **Arms:** ${arms.join(', ')}`);
  out.push(`- **Cells:** ${results.length} replays in ${n1(runtimeMs / 1000)}s wall clock`);
  if (fingerprint) {
    out.push(`- **Tree:** engine ${fingerprint.engine}, git ${fingerprint.git}${fingerprint.dirty ? ' (dirty)' : ''}`);
    out.push(`- **Data:** ${fingerprint.data}`);
  }
  out.push('');
  out.push('Every arm is replayed on every trajectory and differenced against the');
  out.push('control on the SAME trajectory, so seed and window noise cancel instead');
  out.push('of masquerading as signal.');
  out.push('');

  for (const arm of config.arms) {
    if (!arm.description) continue;
    out.push(`- \`${arm.name}\`: ${arm.description}`);
  }
  out.push('');

  // Absolute totals per arm, per season. A paired delta says which arm is
  // better; this says what either of them actually scored, which is the number
  // a future experiment needs to check that its own control still reproduces.
  const seasons = [...new Set(results.map(r => r.season))].sort();
  out.push('## Arm totals');
  out.push('');
  out.push(`| arm | ${seasons.join(' | ')} | total | trajectories |`);
  out.push(`| --- | ${seasons.map(() => '---:').join(' | ')} | ---: | ---: |`);
  for (const arm of arms) {
    const mine = results.filter(r => r.arm === arm);
    const cells = seasons.map(s => mine.filter(r => r.season === s).reduce((sum, r) => sum + r.points, 0));
    out.push(`| ${arm} | ${cells.join(' | ')} | ${cells.reduce((a, b) => a + b, 0)} | ${mine.length} |`);
  }
  out.push('');

  if (!comparisons.length) {
    out.push('This is a BASELINE run: one arm, nothing to compare it against. The');
    out.push('totals above are what a later experiment must reproduce on its own');
    out.push('control arm before its delta means anything.');
    out.push('');
  }

  for (const c of comparisons) {
    const s = c.stats;
    const w = c.windowStats;
    out.push(`## ${c.arm} vs ${c.controlArm}`);
    out.push('');
    out.push('The left column is the one to read. Seeds through one window are');
    out.push('the same season, the same fixtures and the same injuries with a');
    out.push('different search RNG, so they are averaged rather than counted.');
    out.push('');
    out.push('| measure | per window (seeds averaged) | per trajectory |');
    out.push('| --- | ---: | ---: |');
    out.push(`| observations | ${w.n} | ${s.n} |`);
    out.push(`| total delta | ${signed(w.total, v => String(Math.round(v)))} | ${signed(s.total, v => String(Math.round(v)))} |`);
    out.push(`| mean | ${signed(w.mean)} | ${signed(s.mean)} |`);
    out.push(`| standard deviation | ${n1(w.sd)} | ${n1(s.sd)} |`);
    out.push(`| standard error | ${n1(w.se)} | ${n1(s.se)} |`);
    out.push(`| t | ${n2(w.t)} | ${n2(s.t)} |`);
    out.push(`| p (two-sided) | ${n2(w.p)} | ${n2(s.p)} |`);
    out.push(`| 95% CI of the mean | ${signed(w.ci[0])} to ${signed(w.ci[1])} | ${signed(s.ci[0])} to ${signed(s.ci[1])} |`);
    out.push(`| wins / losses / ties | ${w.wins} / ${w.losses} / ${w.ties} | ${s.wins} / ${s.losses} / ${s.ties} |`);
    out.push(`| sign test p | ${n2(w.signP)} | ${n2(s.signP)} |`);
    out.push('');
    out.push(`Control scored ${c.controlTotal} across the ${s.n} trajectories, candidate ${c.candidateTotal}.`);
    out.push('');

    out.push('Per window, so a total carried by one window cannot hide:');
    out.push('');
    out.push('| season | window | mean delta | seeds |');
    out.push('| --- | --- | ---: | ---: |');
    for (const row of c.windows) {
      out.push(`| ${row.season} | gw${row.window[0]}-${row.window[1]} | ${signed(row.delta)} | ${row.seeds} |`);
    }
    out.push('');

    if (c.bySeason.length > 1) {
      out.push('Per season, because an aggregate hiding a single-season collapse is a');
      out.push('rejection rather than a win:');
      out.push('');
      out.push('| season | control | candidate | delta | mean | W-L-T |');
      out.push('| --- | ---: | ---: | ---: | ---: | --- |');
      for (const row of c.bySeason) {
        out.push(
          `| ${row.season} | ${row.controlTotal} | ${row.candidateTotal} `
          + `| ${signed(row.stats.total, v => String(Math.round(v)))} | ${signed(row.stats.mean)} `
          + `| ${row.stats.wins}-${row.stats.losses}-${row.stats.ties} |`,
        );
      }
      out.push('');
    }

    if (c.incomplete.length) {
      out.push(`**${c.incomplete.length} trajectories are incomplete and were excluded:** ${c.incomplete.join(', ')}.`);
      out.push('');
    }

    out.push('<details><summary>Every trajectory</summary>');
    out.push('');
    out.push('| season | window | seed | control | candidate | delta |');
    out.push('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const p of c.pairs) {
      out.push(
        `| ${p.season} | gw${p.window[0]}-${p.window[1]} | ${p.seed} | ${p.control} | ${p.candidate} `
        + `| ${signed(p.delta, v => String(Math.round(v)))} |`,
      );
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }

  out.push('## How to read this');
  out.push('');
  out.push('- The windows OVERLAP, so the trajectories are not independent and the');
  out.push('  standard error above is optimistic. A t near 2 is suggestive, not a');
  out.push('  result.');
  out.push('- Report the per-season split and the win/loss/tie counts with the total.');
  out.push('  A total can be carried by one lucky trajectory.');
  out.push('- Prediction metrics decide nothing here. Points decide.');
  out.push('- The verdict is a human decision recorded in `experiments/registry.md`.');
  out.push('  This file is evidence, not a verdict.');
  out.push('');

  return out.join('\n');
}
