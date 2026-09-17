// Holding the Bench Boost for a double gameweek (registry entry 34).
//
// WHY. chip-rules-known.mjs measured the bench upgrade (sell any bench player
// for a Bench Boost) and its boosted benches carried 0.00 players with a second
// fixture a play: on the calendar as it was known (entry 31) a double is
// visible about three weeks ahead, and the shipped rule has spent the chip on a
// good ordinary bench long before. So the double-gameweek question is not how
// to build the bench but whether to wait. `benchDoubleHold` keeps a Bench Boost
// whose window reaches gameweek 30 or later (where the cup clashes that make
// doubles fall) until a week in which at least two clubs play twice, or until
// its last week; with `benchUpgrade` the planner may then rebuild the bench
// into doubling players.
//
// PRE-REGISTERED, written before any arm ran:
//   - Chips ON, known calendar: instrument 3 (15 windows) and full seasons (3 x
//     3). Instrument 3 cannot judge waiting fairly (a window that ends before
//     the double costs the held chip nothing), so the FULL SEASONS decide and
//     instrument 3 is the guard.
//   - SHIP an arm only if its full seasons beat control by a mean of +10 a
//     replay or more with no season below -15, instrument 3 reads t > -2.0 with
//     no season below -15, AND its Bench Boosts carry at least one bench player
//     with a second fixture a play on average. Otherwise REJECT both.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/bench-double-hold.mjs [--instrument seasons --seeds 1,2,3]
export default {
  name: 'bench double hold',
  question: 'Does holding the Bench Boost for a double gameweek win points?',
  instrument: 'paired',
  chips: true,
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: played on a good bench unless a near week is clearly better' },
    { name: 'double-hold', description: 'held for a double gameweek in a window reaching gameweek 30', opts: { planOptions: { benchDoubleHold: true } } },
    { name: 'double-hold-upgrade', description: 'held for a double, and any bench player may be sold for it', opts: { planOptions: { benchDoubleHold: true, benchUpgrade: true } } },
  ],
};
