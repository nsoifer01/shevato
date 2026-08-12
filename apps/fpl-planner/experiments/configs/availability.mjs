// The historical availability signal, on the instrument that decides.
//
// experiments/availability-minutes.md rejected this on nine chip-free windows
// at +5 points (a wash), a later run read +620 on 45 paired trajectories, and
// then BOTH were voided because the replay underneath them seeded the previous
// season through a name match that dropped 14 to 23 returning players. The
// re-measurement on the corrected join read +113 and +574 and was deliberately
// not treated as an acceptance.
//
// Every one of those numbers was also measured with a replay whose start-rate
// denominator excluded the previous season it had just seeded, which pinned
// pStart at 1.000 for most of the owned pool for half of every seeded season.
// An availability signal is a MINUTES signal, so it was being measured on an
// instrument that could not represent minutes. This is the re-run.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/availability.mjs
export default {
  name: 'availability signal',
  question: 'Does the historical injury and doubt signal win FPL points?',
  instrument: 'paired',
  arms: [
    { name: 'control', description: 'shipped: the replay believes everyone is fit' },
    {
      name: 'candidate',
      description: 'API-Football injury and doubt records, leakage-gated to gameweeks already played',
      env: { FPL_AVAILABILITY: '1' },
    },
  ],
};
