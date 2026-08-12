// The shipped tree, measured on whichever instrument is asked for. One arm, no
// comparison: this exists so a baseline is a command rather than a number
// copied out of a document that may be a month old.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/baseline.mjs --instrument seasons
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/baseline.mjs --instrument windows
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/baseline.mjs --instrument paired
export default {
  name: 'baseline',
  question: 'What does the shipped tree score right now?',
  instrument: 'windows',
  arms: [
    { name: 'control', description: 'the shipped tree, no overrides' },
  ],
};
