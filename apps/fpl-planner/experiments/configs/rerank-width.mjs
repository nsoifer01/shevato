// How many fast-ranked transfer candidates are re-scored exactly (2026-10-16).
//
// WHAT WAS FOUND. A sweep of 61 real managers before GW7 of 2026/27 found one
// (entry 4703156, 3 free transfers) whose recommended three-move plan is beaten
// by a legal neighbour (sell Konsa rather than Dedic) by 0.31 on the planner's
// own objective. The better plan IS generated: it is cut when transfers.js
// keeps the top `rerankCandidates` (16) of the fast lineup proxy for exact
// re-scoring, and the planner only ranks what survives. Widening to 20 or more
// finds it, for about 10 to 20% more plan CPU.
//
// A wider shortlist can only raise the planner's own objective (it chooses the
// best of a superset), so this is a search correction rather than a model
// change; points still decide, as the Methodology says.
//
//   control    the shipped shortlist, 16
//   rerank-24  24 re-scored exactly
//   rerank-32  32 re-scored exactly
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26. Deltas read arm minus control.
//   - As for the transfer-depth correction (registry 35): the wider shortlist
//     is ADOPTED at the smaller width unless it loses with t <= -2.0, or loses
//     more than 15 a window in any season. If 24 and 32 disagree in sign, that
//     is noise (non-monotone) and only the objective argument stands.
//   - Plan CPU on the live-size pool is reported, and the width is not adopted
//     if tests/perf-live-size.test.mjs's ceiling breaks.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/rerank-width.mjs
export default {
  name: 'rerank width',
  question: 'Does re-scoring more fast-ranked transfer candidates exactly cost or gain points?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: 16 candidates re-scored exactly' },
    { name: 'rerank-24', description: '24 candidates re-scored exactly', opts: { planOptions: { transferOptions: { rerankCandidates: 24 } } } },
    { name: 'rerank-32', description: '32 candidates re-scored exactly', opts: { planOptions: { transferOptions: { rerankCandidates: 32 } } } },
  ],
};
