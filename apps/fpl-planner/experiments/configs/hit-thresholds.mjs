// The hit and roll margins, re-measured under analytic-2 (registry entry 30).
//
// WHY. Four constants decide when a transfer is worth a hit and when a free
// transfer is worth keeping, and all four are in points: the planner's
// `hitMarginPoints` (2.0) and `rollBonus` (0.6), and the transfer search's
// `hitMargin` (1.5) and `ftValuePoints` (1.2). They were set, and the search's
// pair swept (experiments/transfer-churn.md), on projections entry 29 showed
// were 20 to 30% low. A points margin set against a compressed scale is a
// different margin once the scale moves, so each is moved to half and to double
// against the shipped values on the new projections.
//
// The two hit margins move together and the two roll values move together:
// they gate the same decision in series (the search ranks hit plans with its
// margin, the planner accepts one with its own), so moving one alone would
// leave the other binding.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3, paired trajectories, chips off, exposure 2023-24, 2024-25,
//     2025-26 (15 windows).
//   - KEEP the shipped margins unless an arm beats control with t >= 2.0 on 15
//     windows AND no exposed season's per-window mean below -15. A significant
//     loss for both directions of one pair is the evidence the shipped value is
//     calibrated.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/hit-thresholds.mjs
export default {
  name: 'hit thresholds analytic-2',
  question: 'Are the hit and roll margins still calibrated on the analytic-2 projections?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: hitMarginPoints 2.0 + search hitMargin 1.5, rollBonus 0.6 + ftValuePoints 1.2' },
    {
      name: 'hits-half',
      description: 'hit margins halved: hitMarginPoints 1.0, search hitMargin 0.75',
      opts: { planOptions: { hitMarginPoints: 1.0, transferOptions: { hitMargin: 0.75 } } },
    },
    {
      name: 'hits-double',
      description: 'hit margins doubled: hitMarginPoints 4.0, search hitMargin 3.0',
      opts: { planOptions: { hitMarginPoints: 4.0, transferOptions: { hitMargin: 3.0 } } },
    },
    {
      name: 'roll-half',
      description: 'roll values halved: rollBonus 0.3, search ftValuePoints 0.6',
      opts: { planOptions: { rollBonus: 0.3, transferOptions: { ftValuePoints: 0.6 } } },
    },
    {
      name: 'roll-double',
      description: 'roll values doubled: rollBonus 1.2, search ftValuePoints 2.4',
      opts: { planOptions: { rollBonus: 1.2, transferOptions: { ftValuePoints: 2.4 } } },
    },
  ],
};
