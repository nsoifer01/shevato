// The chip decisions recalibrated for analytic-2 (registry entry 30), measured
// with chips ON.
//
// WHAT CHANGED. Bench boost: played once all four bench players are likely to
// play and the bench projects the 8-point bar, held only for a week inside the
// projection horizon that is clearly better (4.7 points, the measured bias plus
// revision noise of a bench estimate), never compared with extrapolated weeks
// beyond the horizon; the planner evaluates it on every transfer candidate's
// squad, searches separately for the sales that repair a bench with a player
// unlikely to play, and credits it with its net value (this week's bench less
// the least keeping the chip is worth). Triple captain: compared only with
// weeks of its own chip window, by the measured 1.0-point revision margin
// instead of 2.5, and credited with its net value. A bench boost or triple
// captain is played in the last week of its window rather than lost, and earlier
// when the two need every week left. Wildcard and free hit keep their 12-point
// bars and are never forced. The timing rules were chosen on
// scripts/calibration/calibrate-chips.mjs, never on these points.
//
// Registry entry 30 reports three candidates run on this config, all against
// the same control runs. A: no bench repair, no shared deadline, the bench
// boost credited against its best near week less 1.7 (seasons only; its triple
// captain expired behind a bench boost in the same last week). B: A plus the
// repair, the shared deadline over all four chips and the 4.7 credit, with every
// chip forced in its last week; it failed the season guard (2023-24 -17.7 a
// window). C: B with only the bench boost and triple captain forced, the
// wildcard and free hit back to their bars alone.
//
// HOW IT IS RUN. The control arm is the pre-change tree (origin/master at
// d4cae20c) and the candidate the branch tree, each as a single-arm run of this
// config on identical trajectories, merged by trajectory and re-rendered with
// `--rerender`, as entry 29 was.
//
// PRE-REGISTERED, written before either run:
//   - Exposure: 2023-24, 2024-25, 2025-26.
//   - The objective is chip decision quality under analytic-2, measured by the
//     calibration instrument. Planner points with chips on are the guard.
//   - SHIP if the per-window mean is not significantly negative (t > -2.0 on
//     15 windows) AND no exposed season's per-window mean is below -15.
//   - Expected mechanism: fewer chips played in the last week of a window,
//     triple captains no longer expiring, bench boosts played on usable
//     benches. Chips are one or two plays a window, so the points delta is
//     expected to be small and noisy.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/chip-thresholds.mjs
export default {
  name: 'chip thresholds analytic-2',
  question: 'Do the recalibrated chip decisions hold planner points with chips on?',
  instrument: 'paired',
  chips: true,
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'the tree being replayed (run once in each tree; see the header)' },
  ],
};
