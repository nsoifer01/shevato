// Suspensions over the horizon: the old treatment against the date-aware one
// (backend audit 2026-10-09, B2).
//
// WHY A REPLAY CAN MEASURE THIS AT ALL. The archive has no injury or
// suspension flags, so `s` never occurs in a normal replay. Red cards are in
// it, and a ban is known at the deadline after the card, so suspensions are
// rebuilt without leakage (js/engine/backtest.js suspensionHook, replay option
// `syntheticSuspensions`): a player sent off is banned from his club's next
// fixture (one match; the archive cannot tell a second yellow from a straight
// red, so this is the shortest ban and the most conservative reading).
//
//   legacy  the banned player is projected at zero for the WHOLE horizon,
//           which is how every `i` and `s` was projected before 2026-10-09
//           (encoded as status `u`, which still is);
//   dated   the banned player carries what FPL serves ("Suspended until
//           <date>") and minutes.js zeroes only the gameweeks before it.
//
// Both arms see exactly the same suspensions on the same trajectories; the
// control sees none (the shipped replay), so control vs either arm is also the
// value of knowing about bans at all.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26.
//   - The decision is dated vs legacy, read as the difference of their deltas
//     against control on each window. B2 is a correctness fix and ships on
//     correctness (an unknown return is not a five-week absence); points are
//     the GUARD: it is held only if dated is significantly WORSE than legacy
//     (t <= -2.0) or any season's mean is below -15.
//   - Red cards are rare (a handful a gameweek league-wide, rarer still in a
//     planner's squad), so a small or null effect is the expected reading.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/suspensions.mjs
export default {
  name: 'suspensions',
  question: 'Does projecting a banned player back after his ban beat projecting him out for the whole horizon?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'no suspensions attached (the shipped replay)' },
    { name: 'legacy', description: 'banned players zero for the whole horizon (pre-2026-10-09 treatment)', opts: { syntheticSuspensions: 'legacy' } },
    { name: 'dated', description: 'banned players carry FPL\'s "Suspended until" news (2026-10-09 treatment)', opts: { syntheticSuspensions: 'dated' } },
  ],
};
