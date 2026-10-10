// The planner against the two simple decision rules, on the deciding instrument.
//
// WHY. "The planner beats greedy and hold" has so far been read off single
// full-season replays (registry baselines table; the 2026-10-09 audit: planner
// 2230 / 2322 / 2213 against greedy 2174 / 2267 / 2129), which is instrument 1:
// one seed, chips on, one forked chip decision away from a different number.
// This measures the same question the way every engine change is measured:
// paired trajectories, five sliding windows per season at three seeds, chips
// off, seeds averaged inside a window before anything is counted.
//
// THE ARMS swap the DECISION RULE (`strategy`), not a parameter, so they share
// every trajectory with the control: same season, window, seed, data and
// projections. The control is the shipped planner, so every delta reads as
// "baseline minus planner": negative means the planner wins that window.
//   - greedy-xp: the same planner at horizon 1, so the delta is what looking
//     past this gameweek is worth;
//   - hold: the opening squad of each window built the planner's way, then
//     never transferred, so the delta is what the transfer engine is worth.
//
// Exposure is every season the instrument replays (no treatment is switched
// on, so there is no structural control window). Not a pre-registered
// experiment: nothing ships on it. It is the reference reading for "how much
// does the planner add" and is re-run after any planner change that claims to
// make it better.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/strategies.mjs
export default {
  name: 'planner vs baselines',
  question: 'How much do the planner\'s horizon and its transfers add over greedy-xp and hold, per window?',
  instrument: 'paired',
  chips: false,
  arms: [
    { name: 'control', description: 'the shipped planner (strategy planner)' },
    { name: 'greedy-xp', description: 'the planner at horizon 1 (strategy greedy-xp)', strategy: 'greedy-xp' },
    { name: 'hold', description: 'opening squad built by the planner, never transferred (strategy hold)', strategy: 'hold' },
  ],
};
