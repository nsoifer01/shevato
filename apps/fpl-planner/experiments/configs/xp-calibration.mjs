// The xP calibration repair of 2026-09-16 (registry entry 29), measured in the
// PRODUCTION evidence regime.
//
// WHAT CHANGED. The start model (a previous-season prior with a carry weight
// that grows with the season, replacing six matches of shrinkage toward the
// pool of every player with a minute), the bench model (no opportunities is no
// evidence), the hour curves by position, last season carried into every rate
// that measurably persists, xA converted to FPL assists, bonus from the
// player's own carried rate, team strength from last season's and this
// season's squad xG with goals down-weighted, and the venue factor taken out
// of the fixture scaling. Every parameter was fitted on prediction targets
// (scripts/calibration/*.mjs), never on planner points.
//
// HOW IT IS RUN. The change replaces the evidence regime itself, so the two
// arms cannot live in one tree: the control arm is replayed from a snapshot of
// the tree taken after the production-regime harness landed and before any
// model change, and the candidate from the tree with the repair, each as a
// single-arm run of this config on identical trajectories (same seasons,
// windows, seeds, chips off). The two result files are merged and re-rendered
// with `--rerender`, which pairs them by trajectory exactly as a two-arm run
// does.
//
// PRE-REGISTERED, written before either run:
//   - Exposure: 2023-24, 2024-25, 2025-26 (every season with a predecessor;
//     2022-23 cannot be replayed as production).
//   - The owner's objective for this change is CALIBRATION: projections that
//     match what players then score, measured by scripts/calibration-report.mjs
//     and the 2026/27 deadline backchecks. Planner points are the guard, not
//     the target.
//   - SHIP if the per-window mean is not significantly negative (t > -2.0 on
//     the 15 exposed windows) AND no exposed season's per-window mean is below
//     -15. A significant loss blocks shipping and is reported as such.
//   - Expected mechanism: larger gains in the opening windows (gw1-13, where
//     the old regime overlaid last season at full weight then dropped it), and
//     neutral later. More hits are expected, because the absolute hit and chip
//     thresholds were tuned on projections that were 20-30% low.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/xp-calibration.mjs
export default {
  name: 'xp calibration',
  question: 'Does the xP calibration repair hold planner points in the production evidence regime?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'the tree being replayed (run once in each tree; see the header)' },
  ],
};
