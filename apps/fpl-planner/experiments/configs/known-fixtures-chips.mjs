// The replay's calendar as it was known at each deadline, measured with chips
// ON (registry entry 31). The pre-registration is the header of
// known-fixtures.mjs; the arms are the same.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/known-fixtures-chips.mjs
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/known-fixtures-chips.mjs --instrument seasons --seeds 1,2,3
export default {
  name: 'known fixtures chips',
  question: 'How much did replaying the final fixture list flatter the chip decisions?',
  instrument: 'paired',
  chips: true,
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'the final fixture list (the replay before entry 31)', opts: { fixtureLead: null } },
    { name: 'lead-1', description: 'a reschedule is known 1 gameweek before its week', opts: { fixtureLead: 1 } },
    { name: 'lead-3', description: 'known 3 gameweeks before (the replay default)', opts: { fixtureLead: 3 } },
    { name: 'lead-6', description: 'known 6 gameweeks before', opts: { fixtureLead: 6 } },
  ],
};
