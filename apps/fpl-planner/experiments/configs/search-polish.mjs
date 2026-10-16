// Two corrections of the transfer search found by the 2026-10-16 follow-up
// audit (after PR #611), measured as one experiment.
//
// WHAT WAS FOUND.
//   1. THE HIT DEPTH. transfers.js searched `max(2, min(free transfers, 5))`
//      moves deep and ignored the profile's `maxHits`, so a hit was generated
//      only with ONE free transfer. With two, a third move was never built:
//      on squads derived from the real GW7 managers the planner rolled a free
//      pair while a legal one-hit triple scored +2.7 and +8.2 on its own
//      objective, clearing the 2.0 hit bar.
//   2. THE POLISH. Candidates are generated and shortlisted on a fast proxy
//      (squadHorizonValue) that disagrees with the objective the planner ranks
//      on, so a better plan can be cut or never generated. On 10 of 40 such
//      squads with three to five free transfers the plan was 0.1 to 1.3 below
//      a legal plan an independent search found; half were out of reach of any
//      shortlist width, so registry 47's 24 cannot be the whole answer.
//      planner.js polishTopCandidates hill-climbs the best free and the best
//      hit plan by single swaps scored exactly.
//
// Both can only raise the planner's own objective (a deeper candidate set, a
// candidate that scores higher than the one it came from), so each is a
// correction of the search rather than a change of strategy, and points are
// measured as the guard, as for the transfer depth (registry 35) and the
// shortlist (registry 47).
//
//   control      the shipped search
//   hit-depth    the depth counts the hits the profile allows (cap 5)
//   polish       the exact-objective polish of the two leading plans
//   both         both corrections
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, 3 seeds, chips off), exposure
//     2023-24, 2024-25, 2025-26. Deltas read arm minus control.
//   - Each correction is ADOPTED unless it loses with t <= -2.0, or any season
//     loses more than 15 a window (registry 35's standard).
//   - Plan CPU on the live pool is reported and a correction is not adopted
//     if tests/perf-live-size.test.mjs's ceiling breaks.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/search-polish.mjs
export default {
  name: 'search polish',
  question: 'Do the hit depth and the exact-objective polish of the transfer search cost or gain points?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped search' },
    { name: 'hit-depth', description: 'depth counts the allowed hits', opts: { planOptions: { transferOptions: { hitDepth: true } } } },
    { name: 'polish', description: 'exact-objective polish of the two leading plans', opts: { planOptions: { polish: true } } },
    { name: 'both', description: 'hit depth and polish', opts: { planOptions: { polish: true, transferOptions: { hitDepth: true } } } },
  ],
};
