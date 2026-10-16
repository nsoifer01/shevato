// One basis for every later week of a Triple Captain's window (2026-10-16).
//
// WHAT WAS FOUND. tripleCaptainDecision compares this week's armband with the
// best later week of the chip's window, and estimateXp values a later week by
// its projection when it falls inside the planning horizon and by a per-fixture
// extrapolation when it falls outside. The two disagree for the same week (the
// owner's GW10: 5.45 extrapolated at horizon 3, 6.30 projected at horizon 5;
// GW14: 6.00 against 7.00), so the week named "best" moves with the Horizon
// setting (GW8 at 3, GW10 at 5, GW14 at 8) and the play-or-hold decision
// compares weeks on two scales at once.
//
//   control        the shipped mixed basis
//   extrapolated   every later week valued by the extrapolation
//
// PRE-REGISTERED, written before any arm ran. This changes a chip decision, so
// it is a model change, not a search correction:
//   - Chips-on paired instrument (15 windows, 3 seeds), exposure 2023-24,
//     2024-25, 2025-26. Deltas read arm minus control.
//   - ADOPT only if it does not lose: per-window delta >= 0 and no season below
//     -15 a window. Otherwise REJECT, keep the mixed basis and say in FINDINGS
//     that the named week depends on the horizon. The 2.0 margin (registry 31)
//     was selected on the mixed basis and is not re-selected here.
//
// RESULT 1 (2026-10-16 22:55 UTC): extrapolated +2.4 a window, t 1.68, per
// season +1.5 / +0.0 / +5.6: ADOPTED as the default (registry 49).
//
// SECOND RUN, pre-registered before it ran: the extrapolation's per-fixture
// rate is still read over the horizon, so the owner's best week remained
// GW14 / GW14 / GW10 / GW14 / GW14 at horizons 3, 4, 5, 6, 8. Arm
// 'extrapolated-3' reads the rate over a fixed three weeks (always projected),
// which names GW14 at every horizon. Control is now 'extrapolated', the new
// default; same rule: ADOPT only if per-window delta >= 0 and no season below
// -15 a window. 'mixed' is replayed alongside as the old shipped basis.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/tc-later-basis.mjs
export default {
  name: 'tc later basis',
  question: 'Does valuing every later Triple Captain week on one basis cost or gain points?',
  instrument: 'paired',
  chips: true,
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  // Run 1's arms were control = 'mixed' (then shipped) and 'extrapolated'.
  arms: [
    { name: 'control', description: 'shipped since run 1: every later week extrapolated, rate over the horizon' },
    { name: 'extrapolated-3', description: 'every later week extrapolated, rate over a fixed three weeks', opts: { planOptions: { tcLaterBasis: 'extrapolated-3' } } },
    { name: 'mixed', description: 'shipped until 2026-10-16: projections inside the horizon', opts: { planOptions: { tcLaterBasis: 'mixed' } } },
  ],
};
