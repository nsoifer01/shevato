// The lineup's non-appearance weight, the sweep extended (registry entry 32).
//
// WHY. lineup-risk.mjs moved `minutesRiskWeight` to 0, 0.175 and 0.7 around the
// shipped 0.35: -5.8, -7.4 and +5.2 points a window, the double reading t 1.90
// (8 wins, 3 losses), short of its pre-registered t >= 2.0. The sweep rises with
// the weight, which on a scale that analytic-2 lifted is what an under-weighted
// penalty looks like, and a monotone sweep is the one shape this project reads
// as signal rather than noise. This extends it rather than re-reading it.
//
// PRE-REGISTERED, written before any arm ran:
//   - Same instrument: 3, paired, chips off, 15 windows, known calendar.
//   - ADOPT the largest weight of 0.7, 1.05 and 1.4 whose arm beats control with
//     t >= 2.0 on 15 windows, no exposed season below -15, and a per-window mean
//     no lower than every smaller weight's (0.7 from lineup-risk.mjs). If none
//     qualifies, KEEP 0.35.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/lineup-risk-extended.mjs
export default {
  name: 'lineup risk extended',
  question: 'Does a heavier non-appearance weight keep paying past 0.7?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: minutesRiskWeight 0.35' },
    { name: 'minutes-1.05', description: 'minutesRiskWeight 1.05', opts: { planOptions: { lineupOptions: { minutesRiskWeight: 1.05 } } } },
    { name: 'minutes-1.4', description: 'minutesRiskWeight 1.4', opts: { planOptions: { lineupOptions: { minutesRiskWeight: 1.4 } } } },
  ],
};
