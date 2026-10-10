// The armband on expected points alone (backend audit 2026-10-09, b4).
//
// WHAT CHANGES. captain.js ranks the armband on 0.75 x mean + 0.25 x the 85th
// percentile, plus four bounded tilts (penalty duty, set-piece duty, fixture
// difficulty, minutes confidence). Fixture difficulty and confidence are
// already in the projection, and set-piece duty is already in xG, so the tilts
// can count the same evidence twice; entry 26 made the inputs coherent but
// never measured the weights on points. The replay scores the captain's actual
// points, which an expected-value rule maximizes by construction.
//
//   ev-only     mean weight 1, upside 0, tilts off
//   no-tilts    the shipped mean/upside blend, tilts off
//
// The floors (pAppear 0.5 for the captain, 0.35 for the vice) and the vice's
// measured same-club discount are unchanged in both arms.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26. The two arms answer two questions (the blend, the tilts); the
//     better of them is NOT picked after the fact.
//   - ACCEPT an arm iff per-window t >= 2.0 AND no exposed season's mean below
//     -15. INCONCLUSIVE iff 1.0 <= t < 2.0. REJECT otherwise.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/captain-ev.mjs
export default {
  name: 'captain expected value',
  question: 'Does ranking the armband on expected points alone, or without the tilts, win planner points?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: 0.75 mean + 0.25 ceiling + bounded tilts' },
    {
      name: 'ev-only',
      description: 'expected points only, no tilts',
      opts: { planOptions: { lineupOptions: { captainWeights: { meanWeight: 1, upsideWeight: 0 }, captainTilts: false } } },
    },
    {
      name: 'no-tilts',
      description: 'the shipped blend, no tilts',
      opts: { planOptions: { lineupOptions: { captainTilts: false } } },
    },
  ],
};
