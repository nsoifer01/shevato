// Cross-season vs within-season evidence weighting: opts.priorSeasonWeight.
//
// WHAT THE PARAMETER IS. The replay seeds every returning player's totals at
// gameweek 1 from the previous season at this weight, into every numerator AND
// its denominator (evidenceMatches, xMinutes), which is what makes the sweep
// honest (entry 7). The prior's absolute contribution never decays; its share
// falls as real gameweeks absorb. Newcomers are untouched. 2022-23 has no
// downloadable predecessor, so its five windows are structural ties in every
// arm and the effective instrument is 15 windows.
//
// WHY THE ARMS ARE WHAT THEY ARE. Production is weight 1 PRE-season (bootstrap
// carries last season's totals as the feature base) and weight 0 IN-season
// (FPL resets totals; the app fetches no history), so the shipped replay
// default of 0.5 models an app that exists in neither phase. w=0 is the
// shipped in-season app; the gap between w=0 and the best nonzero arm is the
// measured value of ever building a production prior-evidence path.
//
// PRE-REGISTERED, written before the run:
//   - Arms: 0 (shipped app), 0.25, 0.5 (control, replay default), 1.0.
//   - PRIMARY question: is w=0 materially worse than the best nonzero arm?
//     If so at t >= 2 on the windows, that number is the case for the
//     production data path, whatever the replay default does.
//   - Replay-default change: only if an arm beats control at t >= 2 with no
//     season collapse. If the sweep is monotone INTO the w=1 boundary, widen
//     the range in a follow-up rather than shipping the boundary; if it is
//     non-monotone with no clear interior winner, the default stays 0.5.
//   - No cell-picking: a best isolated cell in a non-monotone sweep is noise.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/prior-weight.mjs
export default {
  name: 'prior season weight',
  question: 'How much previous-season evidence should seed a returning player, and what is prior evidence worth at all?',
  instrument: 'paired',
  arms: [
    { name: 'control', description: 'weight 0.5, the shipped replay default' },
    { name: 'w0', description: 'no prior seeding: the shipped in-season production app', opts: { priorSeasonWeight: 0 } },
    { name: 'w25', description: 'quarter weight', opts: { priorSeasonWeight: 0.25 } },
    { name: 'w100', description: 'full weight: last season counts as this season', opts: { priorSeasonWeight: 1 } },
  ],
};
