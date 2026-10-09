// Two-gameweek transfer paths (backend audit 2026-10-09, C/Phase 3).
//
// WHAT CHANGES. With planOptions.pathPlanning set, the planner ranks this
// week's six leading non-chip candidates (and always the roll) by the best
// two-gameweek PATH each opens: this week's points less this week's hits, plus
// the discounted best objective next week after a full transfer search from
// the state the candidate leaves (planner.js pathObjectives). The shipped
// ranking instead holds each candidate's squad over the whole horizon and
// values a banked transfer at a flat 0.6. Same horizon, same scorer, same
// lineup, armband and auto-substitution model; only what a kept transfer is
// worth changes, from a constant to what it can buy next week.
//
// COST. About 1.7x the CPU of a plan on the sample (3.1 s against 1.9 s);
// reported with the result.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26.
//   - ACCEPT iff per-window t >= 2.0 AND no exposed season's mean below -15.
//     INCONCLUSIVE iff 1.0 <= t < 2.0. REJECT otherwise. A win also has to be
//     worth its CPU: the plan must stay inside the perf budget.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/transfer-paths.mjs
export default {
  name: 'transfer paths',
  question: 'Does ranking this week by its best two-gameweek path beat a flat value per banked transfer?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: this week\'s squad over the horizon plus 0.6 per banked transfer' },
    { name: 'paths', description: 'best two-gameweek path from the six leading candidates', opts: { planOptions: { pathPlanning: { width: 6 } } } },
  ],
};
