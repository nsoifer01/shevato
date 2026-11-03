// Two corrections of the transfer search, found by the exact reference in
// tests/optimizer-reference.test.mjs (ledger row 33, its two `todo` cases).
//
// WHAT WAS FOUND. With two free transfers the planner recommended a free pair
// that a legal free pair beat on its own objective by 0.18 (variant-21) and
// 0.40 (stress-5). A sweep of 118 seeded squads (1 to 3 free transfers) found
// four such misses, two of each cause:
//   1. FUNDING SALES NEVER PAIRED. Pair sales are drawn only from the players
//      with the largest upgrade plus the best cash per point. A sale chosen
//      for the money it frees (João Pedro to Gonzalo, which pays for Mudryk to
//      Mbeumo) is neither, so the pair was never generated.
//   2. THE SHORTLIST RANKED ON A DIFFERENT NUMBER. Candidates are cut to 24 on
//      squadHorizonValue, which ADDS the bench's auto-substitution value and
//      captains the top projection; the planner ranks on squadObjective, which
//      has neither (lineup.js). Within one move count the exact re-score minus
//      its auto-sub term equals the planner's objective to the last digit, and
//      with it the two disagreed by 0.5 to 0.8 (one sd), so the better plan sat
//      37th and 43rd and was cut.
//
//   control      the search before (no funding pairs, proxy shortlist)
//   funding      funding pairs only
//   objective    the shortlist on the objective only (fast stage without the
//                auto-sub term, exact stage on squadObjective)
//   both         both corrections (the candidate to ship)
//
// Each can only widen what reaches the planner or rank it on the planner's own
// number, so each is a correction of the search, and points are the guard, as
// for registries 35, 47 and 48.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, 3 seeds, chips off), exposure
//     2023-24, 2024-25, 2025-26. Deltas read arm minus control.
//   - Each correction is ADOPTED unless it loses with t <= -2.0, or any season
//     loses more than 15 a window (registry 35's standard).
//   - Plan CPU on the live pool is reported and a correction is not adopted
//     if tests/perf-live-size.test.mjs's ceiling breaks.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/pair-search.mjs
const OFF = { fundingPairs: false, shortlistOnObjective: false };
export default {
  name: 'pair search',
  question: 'Do funding pairs and an objective-ranked shortlist cost or gain points?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'search before', opts: { planOptions: { transferOptions: OFF } } },
    { name: 'funding', description: 'funding pairs', opts: { planOptions: { transferOptions: { ...OFF, fundingPairs: true } } } },
    { name: 'objective', description: 'shortlist on the objective', opts: { planOptions: { transferOptions: { ...OFF, shortlistOnObjective: true } } } },
    { name: 'both', description: 'both corrections', opts: { planOptions: { transferOptions: { fundingPairs: true, shortlistOnObjective: true } } } },
  ],
};
