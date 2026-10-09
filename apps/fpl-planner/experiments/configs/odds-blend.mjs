// Bookmaker odds blended into the decided gameweek's expected goals
// (experiments/odds-evaluation-plan.md, variants A and B), OFFLINE ONLY.
//
// WHAT CHANGES. With planOptions.modelOptions.odds set, the replay attaches the
// football-data.co.uk pre-closing MARKET AVERAGE prices (1X2 and over/under
// 2.5, Shin de-margined, inverted to Poisson means by odds.js deriveFromOdds)
// for the fixtures of the gameweek being decided, and only those collected
// before its deadline (odds.js fixtureOddsAtDeadline; collection bound Friday
// 17:00 UK for weekend fixtures, Tuesday 13:00 for midweek). That week's
// expected goals become w * odds + (1 - w) * model; every later week of the
// horizon stays on the ratings model, because no later round is priced at the
// deadline. Closing prices are never read (taken at kickoff, after the
// deadline). Withheld by the gate: 38 / 11 / 7 of 380 fixtures in 2023-24 /
// 2024-25 / 2025-26 (rearranged midweek matches inside weekend gameweeks and
// holiday rounds whose deadline precedes the collection).
//
// THE WEIGHT, fitted on PREDICTION targets only, never on planner points
// (scripts/calibration/calibrate-goal-model.mjs, Poisson log-likelihood of
// team goals at each deadline, production regime): leave-one-season-out w is
// 0.70 / 0.75 / 0.55 for held-out 2023-24 / 2024-25 / 2025-26, full fit 0.65.
// One w for every season is a property of an arm, so the candidate uses the
// full fit; that is in-sample on the PREDICTION fit for each held-out season,
// stated here rather than hidden. Replace (w = 1) is a bracket only.
//
// MEASURED BEFORE THIS REGISTRATION (prediction level, held out):
//   - goal log-likelihood per side, blend vs model: +0.0082 / +0.0024 / +0.0096
//     (positive in all three); odds alone +0.0049 / -0.0015 / +0.0121.
//   - 1X2 log loss, model -> blend: 0.9178 -> 0.9016, 0.9659 -> 0.9661,
//     1.0365 -> 1.0243. The raw Friday market itself read 0.9706 in 2024-25,
//     no better than the ratings model, so this is not a broken integration.
//   - clean-sheet Brier, model -> blend: 0.1492 -> 0.1497, 0.1687 -> 0.1699,
//     0.1820 -> 0.1796. WORSE IN TWO OF THREE SEASONS. The plan's binding
//     statistical gate 5 ("clean-sheet Brier improve or hold") is therefore
//     already failed in 2023-24 and 2024-25, by 0.0005 and 0.0012.
//   - order: within a gameweek the market ranks the sides' expected goals at
//     Spearman 0.88 / 0.87 / 0.89 against the model, so the blend reorders
//     fixtures rather than shifting a level; the level moves by under 0.02.
//   - player xP downstream (rankable players, one week ahead, w as above): the
//     top-20 by xP scored -0.05 (se 0.08) / +0.00 (0.07) / +0.05 (0.06) actual
//     points a gameweek against control; the captain pick changed in 4 to 7
//     gameweeks a season. Expect a small effect.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), production regime,
//     exposure 2023-24, 2024-25, 2025-26 (every window is exposed: odds exist
//     for every season).
//   - PRIMARY, blend-065 vs control: ACCEPT iff the per-window mean has t >= 2.0
//     AND no exposed season mean is below -15 a window AND captaincy value does
//     not fall. Because gate 5 of the plan is already failed at the prediction
//     level, nothing weaker than this can ship it, and an ACCEPT still goes to
//     the owner as a decision (a runtime odds feed on the public site is a
//     terms question the data page does not settle; this experiment is
//     offline only).
//   - INCONCLUSIVE iff 1.0 <= t < 2.0 with no season below -15. REJECT
//     otherwise, including any season below -15 whatever t says.
//   - replace-100 is a bracket and cannot ship. If it beats blend-065 by more
//     than one standard error, the prediction-fitted w is under-reading the
//     market and the question re-opens at the prediction level, not with more
//     planner arms.
//   - Hits and transfers are reported as a sanity counter: a candidate whose
//     hits rise by more than a quarter is INCONCLUSIVE at best until the
//     mechanism is explained (registry entry 12).
//
// REFUSES TO RUN without the odds files: download them first with
//   node apps/fpl-planner/scripts/fetch-odds.mjs
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/odds-blend.mjs

import fs from 'node:fs';

import { oddsPath } from '../../scripts/lib/odds-football-data.mjs';

const SEASONS = ['2023-24', '2024-25', '2025-26'];

const missing = SEASONS.filter(s => !fs.existsSync(oddsPath(s)));
if (missing.length) {
  throw new Error(`odds-blend: no odds for ${missing.join(', ')}. Run: node apps/fpl-planner/scripts/fetch-odds.mjs`);
}

export default {
  name: 'odds blend',
  question: 'Does blending pre-deadline bookmaker expected goals into the decided gameweek beat the ratings model on planner points?',
  instrument: 'paired',
  seasons: SEASONS,
  exposure: { seasons: SEASONS },
  arms: [
    { name: 'control', description: 'the ratings model alone (the shipped fixture model)' },
    { name: 'blend-065', description: 'w = 0.65 (full prediction fit), the candidate', opts: { planOptions: { modelOptions: { odds: { weight: 0.65 } } } } },
    { name: 'replace-100', description: 'w = 1, odds replace the model for the decided week; bracket only', opts: { planOptions: { modelOptions: { odds: { weight: 1 } } } } },
  ],
};
