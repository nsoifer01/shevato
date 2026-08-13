// The planning horizon, re-tested because its own re-test condition fired.
//
// Registry entry 1 shipped `DEFAULT_HORIZON = 3` and named the condition that
// would reopen it: "projection calibration materially improves. The bias is the
// whole reason the shorter horizon wins." Correcting the replay's start-rate
// evidence moved 2024-25's projection bias from -1.5 to -8.5 points a gameweek
// and 2023-24's from +3.2 to -7.9, which is a material change in exactly that
// quantity, in the opposite direction from the one the entry assumed.
//
// The entry also decided on nine chip-free windows at one seed, which this
// project now knows is fifteen correlated readings dressed as nine.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/horizon.mjs
export default {
  name: 'planning horizon',
  question: 'Is 3 still the right default horizon now that the projections have changed?',
  instrument: 'paired',
  arms: [
    { name: 'control', description: 'horizon 3, the shipped default' },
    { name: 'horizon-5', description: 'horizon 5', opts: { horizon: 5 } },
    { name: 'horizon-8', description: 'horizon 8, the longest Settings offers', opts: { horizon: 8 } },
  ],
};
