// The prior-season weight DERIVED from cross-season persistence, replacing the
// decaying-prior hypothesis that the diagnosis disconfirmed.
//
// DIAGNOSIS (2026-08-12, registry entry 20). Entry 18's raw windows show w0
// losing enormously in gw1-13 (-95.6/window across all three exposed seasons)
// and small flat weights winning from gw14 on - which LOOKS like decay. The
// leakage-free persistence measurement says otherwise: the K minimizing
// next-5-match prediction error for returning players is 1-5 equivalent
// matches at EVERY m from 2 to 30, in every season pair including regime-change
// 2025-26, with no downward trend. There is no decay; there is a boundary
// regime at m~0 where the blend (K*P + m*C)/(K+m) equals P for ANY K>0, so a
// small K already substitutes fully for absent evidence. What made w0 lose
// early is falling to price priors instead; what makes K=19 (the replay's 0.5)
// lose later is 7x overweighting. One small flat weight serves both regimes.
//
// The candidate weights are DERIVED, not tuned on planner points: K=2.5 -> 
// w = 2.5/38 = 0.066 (pooled best), with K=5 -> w = 0.132 as a robustness
// bracket chosen from the per-pair spread. No other values were measured
// against planner points before this registration.
//
// PRE-REGISTERED, written before the run:
//   - Exposure: 2023-24, 2024-25, 2025-26 (2022-23 windows are structural).
//   - PRIMARY: w007 vs control (0.5, the replay default). SHIP the new replay
//     default iff t >= 2.0 on the 15 exposed windows AND no exposed season
//     mean below -15 AND w007 does not lose to w0 (it must not be worse than
//     the production-equivalent no-prior state).
//   - SECONDARY, production-path question: w007 vs w0. Recorded either way;
//     t >= 2.0 here (with the primary failing) is production-path evidence
//     without a replay-default change.
//   - w013 is a robustness bracket only: it cannot ship, it can only warn (if
//     it beats w007 materially, the derivation's K is under-read and the
//     question re-opens at the diagnostic level, not with more arms).
//   - Expected mechanism: vs control, gains MID/LATE and roughly neutral
//     EARLY; vs w0, gains EARLY. Falsified by an early collapse under w007, a
//     season collapse, or no gain against either comparator.
//   - A second INCONCLUSIVE on the prior-weight family parks the question
//     until a fifth season exists.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/prior-weight-derived.mjs
export default {
  name: 'prior weight derived',
  question: 'Does the persistence-derived prior weight (w=0.066, K=2.5 equivalent matches) beat the replay default and the no-prior production state?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'weight 0.5 (K=19), the shipped replay default' },
    { name: 'w0', description: 'no prior: the shipped in-season production state', opts: { priorSeasonWeight: 0 } },
    { name: 'w007', description: 'derived weight 0.066 (K=2.5), the candidate', opts: { priorSeasonWeight: 0.066 } },
    { name: 'w013', description: 'robustness bracket 0.132 (K=5); cannot ship, can only warn', opts: { priorSeasonWeight: 0.132 } },
  ],
};
