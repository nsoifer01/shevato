// The replay's calendar as it was known at each deadline (registry entry 31).
//
// WHAT CHANGED. The production-regime replay used to rebuild every deadline's
// fixtures payload from the season's FINAL fixture list, so a match postponed
// out of one round and played in a later double sat in the double from the
// first deadline. It now shows each fixture where it stood then: in its
// original round (fixture ids number the original calendar) until its move is
// known, undated while postponed, and dated FIXTURE_ANNOUNCE_LEAD gameweeks
// before the week it moved into (js/engine/backtest.js, THE CALENDAR AS IT WAS
// KNOWN). The week being decided reads exactly as before; only later weeks lose
// the hindsight.
//
// WHY IT IS MEASURED. This is an instrument correction, accepted on
// correctness, not on points. What is measured is how much hindsight the old
// calendar was worth, and whether that depends on the announcement lead, which
// no archive records: 1, 3 and 6 gameweeks against the final list.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instruments 3 (paired, 15 windows) chips OFF with this config, and chips
//     ON with known-fixtures-chips.mjs, plus that config's full seasons.
//   - Expected: chips off, within noise (the planner looks four weeks past the
//     deadline and a move is known three weeks before its week); chips on, the
//     final list reads HIGHER than lead 3, and leads 1 to 6 are ordered.
//   - ACCEPT lead 3 as the replay default whatever the points say. If lead 1
//     and lead 6 differ from lead 3 by more than their standard errors on the
//     chips-on instrument, the chip rules are re-checked on recordings made at
//     both leads before anything else is concluded from a chips-on replay.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/known-fixtures.mjs
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/known-fixtures-chips.mjs [--instrument seasons --seeds 1,2,3]
export default {
  name: 'known fixtures',
  question: 'How much did replaying the final fixture list flatter the planner?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'the final fixture list (the replay before entry 31)', opts: { fixtureLead: null } },
    { name: 'lead-1', description: 'a reschedule is known 1 gameweek before its week', opts: { fixtureLead: 1 } },
    { name: 'lead-3', description: 'known 3 gameweeks before (the replay default)', opts: { fixtureLead: 3 } },
    { name: 'lead-6', description: 'known 6 gameweeks before', opts: { fixtureLead: 6 } },
  ],
};
