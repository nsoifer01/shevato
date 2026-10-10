// Recent form in the start probability (backend audit 2026-10-09, b1).
//
// WHAT CHANGES. With planOptions.modelOptions.recency set, minutes.js corrects
// the shipped start probability of every player FPL lists as available with
// his last three gameweeks (player.recentGws: starts, fixtures and minutes per
// gameweek, strictly before the deadline; js/engine/backtest.js
// attachRecentForm):
//
//   logit(p) = a + b * logit(base) + c * (recentShare - base)
//              + d * startedLast + e * benchedButUsed
//
// COEFFICIENTS, fitted on start outcomes only, never on planner points
// (scripts/calibration/calibrate-recency.mjs, leave-one-season-out): each
// replayed season gets the coefficients fitted WITHOUT it (`bySeason`), so no
// season is scored on a fit that saw it. The four folds agree closely.
//
// MEASURED BEFORE THIS REGISTRATION (held out, single-fixture gameweeks):
//   start log loss, shipped -> recency: 2022-23 0.3685 -> 0.2977, 2023-24
//   0.3418 -> 0.2690, 2024-25 0.3556 -> 0.2948, 2025-26 0.3314 -> 0.2694,
//   better in every gameweek bucket of every season.
//   Regulars (shipped pStart >= 0.6) who started none of their last three:
//   shipped 0.69, recency 0.16 to 0.18, actually started 0.20 to 0.22.
//   Regulars who started all three: shipped 0.85, recency 0.89, started 0.88.
//   Prediction metrics do not decide (registry Methodology): two earlier
//   minutes candidates improved log loss and lost points.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, 3 seeds, chips off), production regime,
//     exposure 2023-24, 2024-25, 2025-26.
//   - ACCEPT iff per-window mean t >= 2.0 AND no exposed season's per-window
//     mean below -15. INCONCLUSIVE iff 1.0 <= t < 2.0 with no season below -15.
//     REJECT otherwise.
//   - Reported alongside: transfers and hits per window (entry 24: a change
//     that moves many near-indifferent decisions is a churn cost, not a gain).
//   - PRODUCTION NOTE: the app has no per-gameweek history today; an ACCEPT
//     obliges the data layer to read the last three `event/{gw}/live`
//     payloads (stats.starts, stats.minutes) and attach the same recentGws.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/recency-start.mjs
const FIT = {
  coefficients: { intercept: -1.1834, weights: [0.7933, 2.1724, 1.4065, 1.9571] },
  bySeason: {
    '2022-23': { intercept: -1.1749, weights: [0.8035, 2.1811, 1.3816, 1.989] },
    '2023-24': { intercept: -1.1643, weights: [0.7931, 2.1497, 1.3827, 1.9024] },
    '2024-25': { intercept: -1.2277, weights: [0.7832, 2.1502, 1.4758, 1.9891] },
    '2025-26': { intercept: -1.1674, weights: [0.7931, 2.207, 1.3875, 1.9481] },
  },
};

export const RECENCY_FIT = FIT;

export default {
  name: 'recency start',
  question: 'Does correcting the start probability with the last three gameweeks win planner points?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: season starts over club matches with last season as the prior' },
    {
      name: 'recency',
      description: 'start probability corrected by the last three gameweeks (held-out coefficients per season)',
      opts: { planOptions: { modelOptions: { recency: FIT } } },
    },
  ],
};
