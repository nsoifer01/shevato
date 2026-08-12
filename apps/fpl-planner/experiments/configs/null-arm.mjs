// The instrument's own control: two arms that differ in nothing.
//
// Every delta must be EXACTLY zero. If this run reports anything else, the
// runner is not measuring what it claims to: either the replay is not
// deterministic under a fixed seed, or a worker is leaking state between cells,
// or the arms are not as identical as their definitions say. Run it after any
// change to the runner, the worker or the replay harness, and before believing
// a result that came out close to zero.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/null-arm.mjs
export default {
  name: 'null arm',
  question: 'Does the runner report zero when nothing changed?',
  instrument: 'paired',
  arms: [
    { name: 'control', description: 'the shipped tree' },
    { name: 'candidate', description: 'the shipped tree, again' },
  ],
};
