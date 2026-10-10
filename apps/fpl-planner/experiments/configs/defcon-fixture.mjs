// Fixture-aware defensive contribution (backend audit 2026-10-09, b3).
//
// WHAT CHANGES. With planOptions.modelOptions.defconFixtureBeta = beta, a
// player's defensive-action count in a fixture is scaled by the opponent's
// expected goals over what his club usually concedes, to the power beta
// (projections.js). beta = 0 is the shipped model.
//
// FITTED on 2025-26, the only archived season with the data, by Poisson
// likelihood of the actual action counts of outfield starters at each
// production-regime deadline (scripts/calibration/calibrate-defcon-fixture.mjs):
// beta 0.10 on gameweeks 2-19, 0.10 on the full season (0.15 defenders, 0.05
// midfielders, -0.05 forwards). Held out on gameweeks 20-38: log likelihood
// per row -2.51800 -> -2.51656, award Brier 0.11727 -> 0.11710. A real but
// very small effect; the expectation is INCONCLUSIVE.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, chips off). Defensive contribution only scores in
//     2025-26, so that is the only exposed season (5 windows); the other two
//     seasons are structural controls and must read exactly zero.
//   - ACCEPT iff the exposed per-window t >= 2.0 and its mean is positive.
//     INCONCLUSIVE iff 1.0 <= t < 2.0. REJECT otherwise.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/defcon-fixture.mjs
export default {
  name: 'defcon fixture',
  question: 'Does scaling defensive actions by the fixture win planner points?',
  instrument: 'paired',
  exposure: { seasons: ['2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: defensive actions at the player\'s own rate' },
    { name: 'beta-010', description: 'rate x defenceScale ^ 0.10', opts: { planOptions: { modelOptions: { defconFixtureBeta: 0.1 } } } },
  ],
};
