// What a banked free transfer is worth, by how many are already banked
// (backend audit 2026-10-09, roadmap Phase 2).
//
// WHAT CHANGES. The balanced profile values every transfer carried into next
// week at 0.6 points (planner.js RISK_PROFILES rollBonus), so rolling from one
// to two is worth what rolling from four to five is. FPL-Optimization-Tools
// (sertalpbilal, Apache-2.0) values the n-th banked transfer by a falling table
// (2.0 / 1.6 / 1.3 / 1.1 for the 2nd..5th against 1.5 for one). The candidate
// keeps the shipped value of the second transfer's neighbourhood and the same
// average and only changes the SHAPE: the value of the first, second, third,
// fourth and fifth transfer carried is
//
//   [0.6, 0.8, 0.64, 0.52, 0.44]
//
// (sertalpbilal's 2.0 : 1.6 : 1.3 : 1.1 rescaled so the second is 0.8), so
// rolling to a second transfer is worth more than today and rolling to a
// fourth or fifth less. Entry 30 measured the LEVEL of the flat value and kept
// it; this measures its shape and nothing else.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26. One candidate, no sweep.
//   - ACCEPT iff per-window t >= 2.0 AND no exposed season's mean below -15.
//     INCONCLUSIVE iff 1.0 <= t < 2.0. REJECT otherwise.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/ft-value.mjs
export default {
  name: 'banked transfer value shape',
  question: 'Does a falling value per banked transfer beat a flat 0.6?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: 0.6 per banked transfer' },
    {
      name: 'falling',
      description: 'value of the 1st..5th banked transfer 0.6 / 0.8 / 0.64 / 0.52 / 0.44',
      opts: { planOptions: { rollBonus: [0.6, 0.8, 0.64, 0.52, 0.44] } },
    },
  ],
};
