// The lineup's risk weights, re-measured on analytic-2 (registry entry 32).
//
// WHY. `optimizeLineup` ranks an eleven on
//   xPoints - riskAversion * sd - minutesRiskWeight * (1 - pAppear)
// with the balanced profile's riskAversion 0.05 and minutesRiskWeight 0.35
// (js/engine/lineup.js RISK_PROFILES), written with the engine on 2026-08-12
// and never measured. minutesRiskWeight is in points, and analytic-2 moved both
// the points scale and the appearance probabilities it multiplies (entry 29),
// so the same number is a different penalty now. Every lineup the planner
// scores (transfer candidates, chip evaluations, the plan itself) uses it.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3, paired trajectories, chips off, 15 windows, on the known
//     calendar (entry 31). Each weight to 0, half and double.
//   - KEEP the shipped weights unless an arm beats control with t >= 2.0 AND no
//     exposed season's per-window mean is below -15.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/lineup-risk.mjs
export default {
  name: 'lineup risk analytic-2',
  question: 'Are the lineup risk weights still calibrated on the analytic-2 projections?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: riskAversion 0.05, minutesRiskWeight 0.35' },
    { name: 'minutes-0', description: 'minutesRiskWeight 0', opts: { planOptions: { lineupOptions: { minutesRiskWeight: 0 } } } },
    { name: 'minutes-half', description: 'minutesRiskWeight 0.175', opts: { planOptions: { lineupOptions: { minutesRiskWeight: 0.175 } } } },
    { name: 'minutes-double', description: 'minutesRiskWeight 0.7', opts: { planOptions: { lineupOptions: { minutesRiskWeight: 0.7 } } } },
    { name: 'sd-0', description: 'riskAversion 0', opts: { planOptions: { lineupOptions: { riskAversion: 0 } } } },
    { name: 'sd-double', description: 'riskAversion 0.1', opts: { planOptions: { lineupOptions: { riskAversion: 0.1 } } } },
  ],
};
