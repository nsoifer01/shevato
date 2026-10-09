// The deeper transfer search (backend audit 2026-10-09, B3).
//
// WHAT CHANGED. transfers.js searched at most two moves, so a manager holding
// three to five free transfers was recommended the same two moves he would make
// with two, and banked transfers above two could never be spent. It now
// searches up to the free transfers held (max 5) by a beam over the existing
// pools, keeps every depth in the shortlist so the planner can still roll, and
// puts budget enablers (the cheapest player at each price step) into the pair
// pool so a downgrade can fund an upgrade.
//
//   control      the shipped search (beam to the free transfers held + enablers)
//   old-search   maxTransfers 2, no enablers: bit-identical to the search
//                before 2026-10-09
//   no-enablers  the beam without the enablers, to isolate them
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26.
//   - Deltas read arm minus control, so a NEGATIVE old-search delta means the
//     new search wins. The new search is a correction (it can spend transfers
//     the game lets a manager spend) and is KEPT unless old-search beats it
//     with t >= 2.0 or the new search loses more than 15 a window in any
//     season against old-search. Reported with transfers and hits per window,
//     because a deeper search that spends banked transfers on marginal moves
//     is the churn cost entry 24 warns about.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/transfer-depth.mjs
export default {
  name: 'transfer depth',
  question: 'Does searching up to the free transfers held, with budget enablers, beat the two-move search?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: beam to the free transfers held (max 5) plus enablers' },
    { name: 'old-search', description: 'two moves at most, no enablers (the search before 2026-10-09)', opts: { planOptions: { transferOptions: { maxTransfers: 2, pairEnablers: false } } } },
    { name: 'no-enablers', description: 'the beam without enablers', opts: { planOptions: { transferOptions: { pairEnablers: false } } } },
  ],
};
