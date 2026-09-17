// The chip rules on the calendar as it was known at each deadline (registry
// entries 33 and 34), measured with chips ON.
//
// WHAT CHANGED SINCE ENTRY 30. Entry 31 took the hindsight out of the replay's
// fixture list, and the chip calibration recorded again on that calendar
// (scripts/calibration/calibrate-chips.mjs, --tree analytic2-known and
// analytic1-known) moved two measured numbers: a captain's estimate for a week
// five to eight gameweeks out moves by 1.6 points before it arrives, not 1.0,
// and a near-week bench estimate by 3.2, not 3.0. The shipped tree therefore
// has TRIPLE_CAPTAIN_MARGIN 2.0 (was 1.0) and BENCH_BOOST_HOLD_MARGIN 5.0 (was
// 4.7), each chosen on the calibration instrument before this config ran.
//
// ARMS. Run in two trees and merged by trajectory, as entries 29 and 30 were:
//   control          the chip logic before entry 30 (d4cae20c chips.js,
//                    planner.js, transfers.js) on this harness; run as the only
//                    arm of this config in that tree
//   candidate        this tree's defaults (its `control` arm here)
//   outfield-gate    the availability condition on the three outfield bench
//                    players only: on the calibration instrument it beat the
//                    all-four gate in three of four recordings (both models,
//                    both calendars), by 0.9 a window on average
//   bench-upgrade    the bench repair widened to the sales of ANY bench player
//                    (entry 34: double-gameweek benches)
//
// PRE-REGISTERED, written before any arm ran:
//   - Exposure 2023-24, 2024-25, 2025-26; instrument 3 (15 windows) and full
//     seasons (3 seasons x 3 seeds).
//   - GUARD, candidate against control: t > -2.0 on instrument 3 and no exposed
//     season below -15 a window.
//   - GATE: ship 'outfield' if outfield-gate against candidate reads a mean of
//     at least 0 on instrument 3 AND on the full seasons, with no season below
//     -15; otherwise keep 'all'.
//   - BENCH UPGRADE: ship it only if bench-upgrade against candidate reads t >=
//     1.0 on instrument 3, no season below -15, does not lose points on the full
//     seasons, AND its Bench Boosts carry more bench players with a second
//     fixture and more bench points a play. Instrument 3 favours early chip
//     plays, so more boosts without more points a boost is not the mechanism.
//     Otherwise REJECT and remove it.
//
// RESULT (registry entries 33 and 34): the guard passed; outfield-gate and
// bench-upgrade failed their registrations and their switches were removed.
// To re-run those arms, restore `benchGate` and `benchUpgrade` from commit
// a043aa68 (the first commit of the pull request that added entry 34).
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/chip-rules-known.mjs [--instrument seasons --seeds 1,2,3]
export default {
  name: 'chip rules known calendar',
  question: 'Do the chip rules hold on the calendar as it was known, and do an outfield gate or a bench upgrade add to them?',
  instrument: 'paired',
  chips: true,
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'this tree\'s defaults (merged as `candidate` against the pre-entry-30 tree)' },
    { name: 'outfield-gate', description: 'availability required of the three outfield bench players only', opts: { planOptions: { benchGate: 'outfield' } } },
    { name: 'bench-upgrade', description: 'any bench player may be sold for a Bench Boost', opts: { planOptions: { benchUpgrade: true } } },
  ],
};
