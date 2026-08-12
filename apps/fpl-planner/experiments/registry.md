# FPL Planner experiment registry

One entry per experiment that changed, or tried to change, how the planner
decides. It exists so that a known-failed idea is not re-tested from scratch,
and so that an accepted number can be traced back to the run that justified it.

An entry is written when the decision is made, whichever way it goes. A REJECT
is as useful as an ACCEPT: it is the only record that the idea was tried.

Rules for this file:

- Season points come from `node apps/fpl-planner/scripts/backtest.mjs --season
  <season>` at the shipped default horizon, all 38 gameweeks, seed 1, balanced
  risk, analytic projections, previous season seeded where one exists. Anything
  else is stated in the entry.
- All three comparable seasons are reported (2022-23, 2023-24, 2024-25), never a
  single season and never an aggregate on its own. Consistency is part of the
  result.
- Before and after are replayed back to back on the same working tree. The
  absolute numbers move whenever the replay harness or the projection path
  moves, so a delta is only meaningful against a baseline measured beside it.
- A prediction metric that improves is not a result. Only season points decide.

Baselines, same settings. Measured 2026-08-12 on the corrected replay evidence
(`experiments/replay-evidence.md`) at the shipped default horizon, which is now
5 (entry 9):

| strategy  | 2022-23 | 2023-24 | 2024-25 |  total |
|-----------|--------:|--------:|--------:|-------:|
| planner   |    2209 |    2208 |    2453 |   6870 |
| greedy-xp |    2076 |    2219 |    2253 |   6548 |
| hold      |    1453 |    2107 |    2112 |   5672 |
| fdr       |    1255 |    1010 |    1282 |   3547 |

45 paired trajectories, chips off, the deciding instrument: **34,051**
(11,138 / 11,134 / 11,779), measured 2026-08-13 after entries 11 (xG
denominator) and 14 (historical season rules). Chips-on full seasons under the
rules the seasons were actually played by: **6975** (2239 / 2283 / 2453).
Superseded: 34,071 after entry 11 alone, 33,684 before it, 32,713 at the old
horizon-3 default.

`greedy-xp` is this planner at horizon 1 and so does not move with the default;
`hold` and `fdr` do, because their opening squad is built over the horizon.

**Do not compare a new number against any of these without re-measuring the
control arm on your own tree.** That instruction has now been vindicated four
times, most recently by a 1253-point move.

> ### DO NOT QUOTE ANY PLANNER NUMBER PUBLISHED IN THIS FILE BEFORE 2026-08-12
>
> The replay's minutes model was degenerate. Its start-rate numerator carried
> half of the previous season and its denominator counted only this one, so
> pStart was pinned at 1.000 for 89% of the owned pool at gameweek 3 and for a
> majority of it through gameweek 20. Separately, the 2022-23 archive has no
> `starts` column at all for gameweeks 1 to 15, which inverted that stretch into
> a league of substitutes.
>
> Expected minutes multiply every other component of a projection, so for roughly
> half of every replayed season the instrument had its single most
> decision-relevant quantity held at a constant. Correcting both is worth +1253
> points over 45 paired trajectories, larger than any effect this file has ever
> accepted or rejected.
>
> The full audit, the 98.6%-validated reconstruction and the before/after tables
> are in `experiments/replay-evidence.md`.
>
> The older warnings below still stand as history: the broken cross-season join
> (2026-08-11) and the broken transfer model (2026-08-11).

> ### EVERY PLANNER NUMBER IN THIS FILE WAS MEASURED WITH A BROKEN CROSS-SEASON
> ### JOIN, INCLUDING THE ONES CORRECTED FOR THE TRANSFER MODEL
>
> The replay seeds a player's rates at gameweek 1 from the season before, which
> at gameweek 1 is the only evidence there is. It matched the two seasons on the
> archive's raw `name` string, and the archive respells returning players freely:
> accents restored, maternal surnames added, nicknames expanded, Japanese names
> flipped. So the join silently dropped 14 of 526 returning players entering
> 2023-24 and 23 of 513 entering 2024-25, throwing away 11,366 and 19,061
> prior-season minutes. Rodri, Tomiyasu, Mitoma, Coufal and Joe Gomez each began
> a season looking to the planner like a man who had never played.
>
> It never matched the WRONG player, so no entry below is corrupt the way an
> `element` join would have made it. It is understated, in a different direction
> and by a different amount in each season, which is enough to make any two
> entries measured either side of the fix incomparable.
>
> `code` is now the canonical identity, verified stable on all four seasons we
> hold, and the join resolves 100% of returning players with zero collisions. The
> full audit, the evidence that `element` is reassigned every season, and the
> before/after replays are in `experiments/cross-season-identity.md`.
>
> Entries below have NOT been re-run except where an entry says so.
>
> ### EVERY PLANNER NUMBER PUBLISHED IN THIS FILE BEFORE 2026-08-11 WAS MEASURED
> ### WITH A BROKEN TRANSFER MODEL
>
> The engine gave itself ONE FREE TRANSFER TOO MANY in every gameweek of every
> season of every replay. `computeFreeTransfers` seeded the count at 1 BEFORE
> gameweek 1 and then added the weekly transfer for gameweek 2 on top, so a
> manager who never transferred was modelled with 2 free transfers going into
> gameweek 2, 3 into gameweek 3, 4 into gameweek 4 and 5 into gameweek 5, against
> a true 1, 2, 3 and 4. Separately, the pre-season branch reported
> `rules.maxFreeTransfers` (five, the CAP) where the true answer is unlimited.
>
> This was not cosmetic. The free-transfer count enters the optimizer's objective
> twice: it decides how many of a candidate's transfers are charged at
> `rules.hitCost`, and it prices what a candidate banks. Every transfer decision
> in every replay behind the entries below was therefore taken under a constraint
> the real game does not have.
>
> The old baseline table read planner 2151 / 1817 / 2371 = 6339, greedy-xp 6128,
> hold 5543, and the nine chip-free windows read 6324 before registry entry 4 and
> 6402 after it. Those are superseded, not archived as valid. The per-entry
> tables below have NOT been re-run; each entry now carries a note saying so.
>
> `js/engine/transfer-state.js` is the only module allowed to do this arithmetic
> now, and `tests/transfer-state.test.mjs` walks the transitions as sequences,
> which is what the previous 3000 passing assertions could not do: every one of
> them checked that a snapshot was LEGAL, and a manager carrying one extra free
> transfer all season is legal in every single gameweek.

---

## 1. Default planning horizon, 5 to 3

- **Date:** 2026-08-10
- **What changed:** `DEFAULT_HORIZON` in `js/engine/planner.js`, 5 to 3. The
  horizon stays user configurable at 3, 5 or 8 in Settings; this is only the
  number a manager gets before they choose one.
- **Prediction metric:** projection bias, reported by the backtest, on 2024-25:
  +0.3 points per gameweek at horizon 3 against +8.0 at horizon 5 (positive
  means the model overprojected).
- **Planner points, measured against greedy-xp:**

  | season         | h3 vs greedy | h5 vs greedy |
  |----------------|-------------:|-------------:|
  | 2022-23        |          +85 |         +159 |
  | 2023-24        |          +39 |          +93 |
  | 2024-25        |          +87 |         -222 |
  | 3 season total |         +211 |          +30 |

- **Decision: ACCEPT.** Horizon 3 beats the greedy baseline in every season.
  Horizon 5 wins two seasons and collapses in the third, so its three season
  edge is a coin toss dressed as a strategy. The mechanism is projection bias:
  each extra gameweek of horizon imports more projection error than the fixture
  swing it is reading is worth.
- **Re-test if:** projection calibration materially improves. The bias is the
  whole reason the shorter horizon wins, so a better calibrated projection could
  move the answer back out. Do not move the number without re-running the sweep.

- **2026-08-11, THE JUSTIFICATION ABOVE NO LONGER HOLDS AS WRITTEN. The DECISION
  survives, on a different instrument.** Both tables in this entry were measured
  with the broken transfer model. Re-measured on the corrected one, all 38
  gameweeks, seed 1, balanced:

  | season         | h3 points | h5 points | greedy | h3 vs greedy | h5 vs greedy |
  |----------------|----------:|----------:|-------:|-------------:|-------------:|
  | 2022-23        |      2131 |      2150 |   1995 |         +136 |         +155 |
  | 2023-24        |      1898 |      1947 |   1950 |          -52 |           -3 |
  | 2024-25        |      2087 |      2232 |   2131 |          -44 |         +101 |
  | 3 season total |      6116 |      6329 |   6076 |          +40 |         +253 |

  The claim "horizon 3 beats the greedy baseline in every season" is now FALSE:
  it beats it in one. The claim "horizon 5 collapses in the third season" is also
  now false: horizon 5 beats horizon 3 in all three, by 213 points in total.

  On the deciding instrument, the nine chip-free windows, the answer is the other
  way and it is not close:

  | season  | window  |   h3 |   h5 |
  |---------|---------|-----:|-----:|
  | 2022-23 | gw1-13  |  507 |  539 |
  | 2022-23 | gw14-26 |  794 |  787 |
  | 2022-23 | gw27-38 |  821 |  801 |
  | 2023-24 | gw1-13  |  747 |  745 |
  | 2023-24 | gw14-26 |  639 |  615 |
  | 2023-24 | gw27-38 |  802 |  728 |
  | 2024-25 | gw1-13  |  814 |  746 |
  | 2024-25 | gw14-26 |  883 |  756 |
  | 2024-25 | gw27-38 |  565 |  533 |
  | total   |         | **6572** | 6250 |

  Horizon 3 wins 8 of the 9 windows and the aggregate by 322. The Methodology
  section of this file ranks a single full-season replay as the WEAKEST
  instrument precisely because one forked chip cascades through everything after
  it, and the chips are exactly where the two full-season columns diverge. So
  `DEFAULT_HORIZON` stays at 3 and has NOT been changed.

  What must not be repeated is the sentence that justified it. The horizon's
  advantage over greedy is thinner and less consistent than this entry claimed,
  and it was the extra free transfer that made it look otherwise.
- **Re-test properly:** this comparison deserves instrument 3 (45 paired
  trajectories), which has never been run for the horizon. Two instruments
  disagreeing by 535 points is the signature the Methodology section says means
  the sample is too small to decide with.

- **2026-08-12: SUPERSEDED BY ENTRY 9. The decision is reversed and this entry's
  evidence is withdrawn.** Both tables here, and the nine-window table that
  rescued the decision on 2026-08-11, were measured on a replay whose start
  probability was pinned at 1.000 for most of the owned pool for half of every
  seeded season (entry 7). The re-test condition this entry wrote for itself
  fired at the same time, because correcting that evidence moved projection bias
  from about zero to -7 points a gameweek. Re-run on 45 paired trajectories read
  as 15 windows, horizon 5 beats horizon 3 by 21.6 points a window, t 2.32,
  11 windows to 4, positive in all three seasons. `DEFAULT_HORIZON` is 5.

  The durable lesson is not about the horizon. It is that this entry was decided
  twice, on two instruments, and both readings were of an engine whose most
  decision-relevant quantity was a constant. Check that the instrument can
  represent the change before measuring the change.

## 2. Trained ML artifact feeding the engine

- **Date:** 2026-08-10
- **What changed:** nothing shipped. `models/fpl-planner-v2.json` is loaded at
  runtime with `engineConsumes: []`, so no field of it reaches the engine.
- **Prediction metric:** the artifact's start calibrator beats its own
  statistical baseline on held-out data: test log loss 0.3006 against 0.3135,
  expected calibration error 0.0447 down to 0.0221.
- **Planner points, leakage-free replay** (train excluding the replayed season,
  then replay that season with and without the artifact):

  | season  | strategy  | without | with | delta |
  |---------|-----------|--------:|-----:|------:|
  | 2024-25 | planner   |    2371 | 2211 |  -160 |
  | 2024-25 | greedy-xp |    2284 | 2215 |   -69 |
  | 2024-25 | hold      |    2006 | 1953 |   -53 |
  | 2023-24 | planner   |    1943 | 1853 |   -90 |
  | 2023-24 | greedy-xp |    1947 | 1892 |   -55 |
  | 2023-24 | hold      |    1928 | 1944 |   +16 |

  Projection bias on 2024-25 moved from +0.33 to +2.6 points per gameweek, and
  the planner's edge over greedy collapsed from +87 to -4.
- **Decision: REJECT for production.** The artifact improves its own statistical
  metrics and loses season points in leakage-free replay, in both seasons and
  under two different decision rules. The calibrator JSON stays in the file so
  the decision can be re-tested, not because it is pending.
- **2026-08-11:** the table above was measured with the broken transfer model and
  has NOT been re-run. The verdict is not in doubt: the artifact loses in both
  seasons under all three decision rules, including `hold`, which makes no
  transfers at all and is provably untouched by the transfer fix. A defect that
  cannot reach `hold` cannot be what produced a -53 on `hold`.
- **Re-test if:** the engine's own projection path changes enough that the
  comparison is against a different baseline. A better log loss on its own is
  not grounds to re-enable it. Re-test with `scripts/backtest.mjs --model`
  against a season the artifact was not trained on; the script refuses a leaking
  combination.

## 3. Wildcard information maturity premium

- **Date:** 2026-08-11
- **The defect this was aimed at:** replay plays the first wildcard at gameweek 2
  in two of three seasons. The opening 15 is built with no in-season information
  at all, so after one gameweek the optimizer has enough new signal that a
  rebuild clears the flat 12 point `WILDCARD_HORIZON_THRESHOLD` easily. That one
  decision was worth +117 points in 2024-25 and -96 in 2023-24.
- **What was tried:** the wildcard bar stopped being a constant and became the
  flat threshold plus an optimism premium priced off how much football is behind
  the projections of the players the rebuild buys:

  ```
  premium = z * sigma * W * SUM over incoming players of
            max(0, 1/sqrt(n_i + n0) - 1/sqrt(n_mature))
  ```

  sigma = 2.7, the within-player SD of a gameweek score, measured over the three
  seasons (2.67, 2.76, 2.62). n_i = minutes/90 behind player i, read from the
  field `underlyingRates()` itself divides by. n0 = 0.25 nineties, the floor that
  says a cameo is not a sample. n_mature = 20 nineties, the evidence a later
  rebuild would stand on, which makes the premium vanish for a squad of
  established players instead of taxing April rebuilds for uncertainty there is
  no longer any way to reduce. W = the sum of the horizon's discount weights, so
  the premium is in the same discounted horizon points as the advantage. The sum
  is linear rather than a root sum of squares because selection turns estimation
  error into a one sided bias, and biases add. The same premium at weight 1 was
  also applied to the free hit, which is the same optimizer-built squad measured
  the same way.

- **Prediction metrics:** two were measured first, and neither supports the
  mechanism the premium assumes.
  - Attenuation of the projections (slope of realized on projected points, top
    260 owned players, per gameweek, leakage-free) does not degrade early. The
    slope sits near 1.0 from gameweek 2 onward and the correlation improves only
    mildly, r about 0.33 at m below 5 against 0.38 at m above 20.
  - Selection optimism of the top 15 projected players (their mean projection
    minus their mean realized score, net of the same gap over the whole pool)
    shows no decay through the season: +0.37 points per player at m 6 to 10
    against -0.13 at m 21 to 33, inside the noise of the measurement.

- **Planner points.** Before and after replayed back to back on the same tree,
  all 38 gameweeks, horizon 3, seed 1:

  | season  | wildcard gws before | wildcard gws after | before | after | delta |
  |---------|---------------------|--------------------|-------:|------:|------:|
  | 2022-23 | 6, 20               | 21                 |   2151 |  2065 |   -86 |
  | 2023-24 | 2, 24               | 2, 24              |   1817 |  1817 |     0 |
  | 2024-25 | 2, 30               | 8, 23              |   2371 |  2124 |  -247 |
  | total   |                     |                    |   6339 |  6006 |  -333 |

  | measure   | before | after |
  |-----------|-------:|------:|
  | vs greedy |   +211 |  -269 |
  | vs hold   |   +796 |  +463 |

  Variants, measured the same way earlier in the same session (directional: some
  of these runs straddled another agent's in-flight edits to `backtest.js`, and
  the baseline in that state was the same 6339 total):

  | variant                                     | 2022-23 | 2023-24 | 2024-25 | total |
  |---------------------------------------------|--------:|--------:|--------:|------:|
  | crude gate, no wildcard before m>=3          |    2151 |    1917 |    2250 |  6318 |
  | crude gate, no wildcard before m>=5          |    2151 |    1986 |    2326 |  6463 |
  | crude gate, no wildcard before m>=10         |    2111 |    1932 |    2333 |  6376 |
  | premium, no maturity term, z=0.4             |    2094 |    1895 |    2371 |  6360 |
  | premium, no maturity term, z=0.7             |    2094 |    1895 |    2256 |  6245 |
  | premium, no maturity term, z=1.0             |    2163 |    1809 |    2256 |  6228 |
  | premium, maturity term, wildcard only, z=1.0 |    2064 |    1817 |    2250 |  6131 |

- **Decision: REJECT.** The premium costs 333 points over three seasons, no
  season improves, and the planner's edge over greedy-xp inverts from +211 to
  -269. No setting of z was better than neutral, and z was not tuned to rescue
  it: 1 is the neutral anchor (one standard error of upward bias per selected
  player) and the sweep either did nothing below it or made things worse above.
- **2026-08-11:** every number in this entry, including the before column and the
  whole variant sweep, was measured with the broken transfer model, and none has
  been re-run. The verdict stands on its mechanism rather than its arithmetic:
  the measured rebuild advantage INVERTS the outcomes it is supposed to order
  (+116 measured for a wildcard worth -96, +42 for one worth +117), and the
  transfer allowance does not enter that inversion at all. The absolute totals in
  the tables are dead numbers; do not quote them or compare a new run against
  them.

- **Why it cannot work, which is the part worth keeping.** The measured rebuild
  advantage does not order the outcomes, it inverts them.

  | season  | gw2 rebuild, measured advantage | what that wildcard was worth |
  |---------|--------------------------------:|-----------------------------:|
  | 2023-24 |                    +116 points |                    -96 points |
  | 2024-25 |                     +42 points |                   +117 points |

  Any bar, uncertainty-scaled or not, blocks the +42 before it blocks the +116,
  so it removes the good early wildcard and keeps the bad one. That is exactly
  what the replay shows: 2023-24's gameweek 2 wildcard survived the premium
  untouched while 2024-25's was pushed to gameweek 8 and lost 247 points.

  Two supporting facts. The 2023-24 gameweek 2 rebuild projects 96 points per
  gameweek for an eleven plus captain, which is not a football number: it is
  built out of players with 2 and 16 minutes on the board whose per 90 rates are
  extrapolations of a cameo (one player with 2 minutes played projected 19.9
  points). And the weeks the planner currently plays a profitable wildcard have
  measured advantages of 13 to 18 points, barely over the flat 12, so a premium
  large enough to matter at gameweek 2 is also large enough to suppress those.
  The two regimes differ by a factor of 3 to 9 in measured advantage but only by
  a factor of about 5 in evidence, entering as 1/sqrt. No monotone function of
  evidence separates them.

- **Where the defect actually lives:** in the projection of a player who has
  played a cameo, not in `chips.js`. A per 90 rate estimated from 2 minutes with
  no shrinkage is what manufactures the 116 point advantage, and the chip
  evaluator is only the first place it becomes expensive. Shrinking early season
  rates toward a pre-season prior inside `projections.js` would fix the input
  rather than tax the output, and would improve transfers and lineups at the
  same time.
- **Do not re-test:** an uncertainty, standard error, shrinkage or value of
  information bar on the wildcard's measured advantage, in any of these forms.
  The measurement it would be scaling is the broken quantity.
- **Worth testing instead:** shrinkage of per 90 rates toward a pre-season prior
  when in-season minutes are thin, measured on transfers and lineups as well as
  chips. The crude gate rows above also hint that a wildcard held through the
  first few gameweeks is not itself harmful (m>=5 scored 6463 against a 6339
  baseline), but a gate is a rule with no mechanism, and the m>=3 and m>=10 rows
  either side of it move the other way, so the m>=5 row is a coin toss and not a
  finding.

---

# Methodology: how to measure a planner change

Read this before running another experiment. Four experiments have now been
rejected, and at least one of those rejections is under suspicion because the
instrument was too weak, not because the idea was bad. Getting the protocol
right matters more than the change being tested.

## The instruments, weakest to strongest

1. **One full-season replay.** Nearly useless on its own. It is a single
   deterministic trajectory, and one forked chip decision cascades through
   everything after it. Observed: moving a wildcard from gameweek 30 to 22
   diverged a second half by 211 points. Use it to sanity-check that a change
   did something, never to decide.
2. **Nine chip-free windows** (three seasons x gw1-13 / gw14-26 / gw27-38,
   chips removed from the rules catalogue so none can be played). Removes the
   chip cascade. **Current baseline total 6412**, measured 2026-08-11 on the
   corrected transfer state machine and the canonical identity join. The 6572
   this section used to quote was the same tree with the broken join; the 6324
   before that, and the 6402 that superseded it in entry 4, were both measured
   with the broken transfer model as well. Better than instrument 1, but still
   one seed, and the seed alone moves 9-10 of 15 windows with a mean spread of
   21-32 points.
3. **45 paired trajectories, read as FIFTEEN WINDOWS** (5 sliding windows x 3
   seasons, each replayed at 3 seeds, chips off). Pairs each arm against the
   control on the same trajectory so seed noise cancels instead of masquerading
   as signal. This is the instrument that decides.

   **Average the seeds inside a window before you count anything.** Three seeds
   through one window are the same thirteen gameweeks of the same season, with
   the same fixtures, the same prices and the same injuries; only the search RNG
   differs. Pairing removes that noise, which is what it is for, but it does not
   turn three correlated replays into three observations. Counting them
   separately triple-counts any effect that happens to land in one window, and
   that is not hypothetical: it is the entire difference between the availability
   signal reading t 1.51 (27W/15L) and t 1.06 (7W/7L/1T) on the same 90 replays.

   Report, in this order: the per-window mean, its standard error and t, the
   win/loss/tie split over the fifteen windows, the per-season split, and the
   per-window table so a total carried by one window cannot hide.

**Running it is one command and takes about three minutes:**

```sh
node apps/fpl-planner/scripts/experiment.mjs --config <experiments/configs/x.mjs>
```

`scripts/experiment.mjs` fingerprints the engine, the scripts and the season data
before the run and again after it, and refuses to report a run whose tree moved
underneath it. It re-measures the control arm every time and offers no way to
compare against a stored baseline. `experiments/configs/null-arm.mjs` runs two
identical arms and must report exactly zero on all 45 trajectories; run it after
touching the runner or the replay.

## The result that forced this

The availability experiment was REJECTED on instrument 2 at +5 points, a wash.
Re-measured on instrument 3 by a later experiment it read +620, t 1.88, 24 wins
/ 18 losses. Those were the same change, and the disagreement is what this
section was written to explain.

**2026-08-12: and the resolution was that neither reading meant anything.** Run
on a tree whose minutes model works, and counted per window rather than per
trajectory, the same change reads +11.4 a window with a standard error of 10.8,
seven wins and seven losses, and a sign test of exactly 1.00. Both of the
readings this section was built to reconcile were artefacts: instrument 2 was
noise, and instrument 3 was seed-triple-counting one good window on top of an
instrument that could not represent minutes.

**Both of those numbers are now void.** They were produced by replays whose
cross-season prior seeding matched two seasons on a raw name string and dropped
14 to 23 returning players per season. Re-measured with both join arms run on
one frozen tree, so the fix is separable from the tree:

| instrument | broken join | corrected join | swing |
| --- | ---: | ---: | ---: |
| 2, nine windows | -86 (4W/5L) | +113 (6W/3L) | +199, sign flips |
| 3, 45 trajectories | +542 (t 1.60, 30W/15L) | +574 (t 2.02, 31W/14L) | +32 |

The lesson this section drew is now much better evidenced, and it is sharper than
it was. The SAME underlying change, measured either side of the same data fix,
moves by 199 points and changes sign on instrument 2 and by 32 points on
instrument 3. The nine windows are not merely noisy, they are noisy enough to
invert a verdict on a defect that the stronger instrument barely registers.

The verdict remains NOT reopened: a voided rejection is not an acceptance, and
the mechanism that justified it is untouched. See the box at the top of
`experiments/availability-minutes.md`.

## Rules

- Report per-season AND aggregate. An aggregate gain hiding a single-season
  collapse is a rejection, not a win.
- Report wins, losses and ties, not only the total. A total can be carried by
  one lucky window.
- Re-measure the BEFORE arm yourself, on the tree you are testing. Several
  experiments here ran concurrently and the baseline moved under three of them.
- A non-monotone parameter sweep means noise dominates. Do not pick the best
  cell out of a non-monotone sweep, that is fitting the noise.
- Prediction metrics do not decide anything. Two experiments improved log loss,
  Brier, calibration and MAE, and both cost points or washed out. Points decide.
- **Before measuring a change to a model, check that the instrument can
  represent what the model does.** An availability signal was measured three
  times against a replay whose start probability was pinned at 1.000, and a
  start-rate experiment would have been measured against a season with no starts
  column. Both defects were invisible to 739 passing tests, because a
  probability of exactly 1 is a legal probability and a missing column parses as
  a zero.

---

## 4. Small-sample shrinkage + zero-minutes start probability

**Decision: ACCEPT.** Shipped. Reversible in one step, see section 12 of
`experiments/zero-minutes-and-shrinkage.md`.

Two defects that masked each other, which is why each failed alone:

- per-90 rates were computed from any sample size without shrinkage, so a
  2-minute cameo produced an xA/90 of 16.65 and a 19.9 point projection
- a player with ZERO minutes was assigned a start probability up to 0.78 from
  his PRICE, so shrinkage handed that phantom starter a plausible rate

Fixed together: quasi-Poisson empirical Bayes on the rates (k derived from
between vs within variance over 1686 player-seasons, not tuned), plus
`NO_HISTORY_PRIOR_MATCHES` fitted by maximum likelihood per season and shipped
at the conservative end of its range.

### The evidence, and why the instruments disagree

| protocol | before | after | delta | W-L-T |
| --- | ---: | ---: | ---: | --- |
| nine chip-free windows (decider) | 6324 | 6402 | **+78** | 5-4-0 |
| chip-free full 38 | 6247 | 6348 | **+101** | 2-1 |
| full season WITH chips | 6339 | 6107 | -232 | 1-2 |

**2026-08-11: all six of those numbers were measured with the broken transfer
model and have NOT been re-run.** The verdict is not reopened, on the mechanism
rather than the arithmetic: the defect this entry fixed is a per-90 rate
estimated from a 2-minute cameo, which is a PROJECTION defect, and the transfer
allowance does not appear anywhere in it. The calibration evidence below
(predicted 0.157 to 0.053 against an observed 0.063) is a property of the
projection model alone and is unaffected. The deltas are the part worth keeping;
the absolute totals are dead and the corrected tree scores 6116 with chips and
6572 across the nine windows.

Zero-minutes calibration, the number that says the defect was real: predicted
0.157 -> 0.053 against an observed 0.063, so a 2.49x overshoot became 0.84x.
The top price bin predicted 0.740 and observed 0.050. Aggregate error improved
too: MAE 2.155 -> 2.121, bias +0.144 -> +0.080.

**Why the chips-on loss did not decide it.** 2024-25 falls 278, but about 93 of
that is chips simply scoring less (free hit +49 to -2, bench boost +10 to 0) and
chip-free that same season loses only 6 across its three windows. The Methodology
section above ranks a single full-season replay as the WEAKEST instrument
precisely because one forked chip cascades through everything after it, and both
chip-free protocols are positive. Deciding on the weakest instrument, against two
stronger ones, would contradict the rule this file already sets.

### The other reason, stated plainly

This is not only a points question. All eight of the worst sub-90-minute
projections in the archive are gone: gameweek 3 of 2023-24 went from a 2-minute
player at 19.92 points to an 87-minute player at 3.72. The real season starts in
ten days, when EVERY player has near-zero minutes and this failure mode is at its
worst. Shipping a recommendation engine that projects a cameo substitute above a
premium striker costs trust that a backtest cannot measure.

**Gameweek 1 is untouched**: the decay weight is exactly 1 with no match played.

### Known cost, not hidden

A January signing is charged for the 20 matches he was not eligible for. Pooled,
that group starts 0.9% of the time so the aggregate is right, but the individual
answer is wrong until he plays once.

### What would overturn this

A 45-paired-trajectory run (instrument 3) showing a loss. It was started and did
not finish. Until then this rests on instruments 2 and 2b, both positive.

---

## 5. Free transfers: an authoritative state machine, and a season-long off-by-one

- **Date:** 2026-08-11
- **This is a correctness fix, not an experiment.** It is in this file because it
  invalidates every planner number the file published, and because the way it
  survived the test suite is the most useful thing in the entry.

### The defect

Two of them, both in `js/engine/squad.js`, and four more copies of the same
arithmetic scattered across `planner.js`, `transfers.js`, `chips.js` and
`backtest.js`.

1. **`computeFreeTransfers` was off by one for the whole season.** It seeded the
   count at 1 BEFORE gameweek 1 and then applied the weekly +1 for gameweek 2 on
   top. A manager who never transfers:

   | going into | it reported | the rules say |
   |------------|------------:|--------------:|
   | GW2        |           2 |             1 |
   | GW3        |           3 |             2 |
   | GW4        |           4 |             3 |
   | GW5        |           5 |             4 |
   | GW6        |           5 |             5 |

   The replay harness had the same seed independently (`emptySquad` started at
   `freeTransfers: 1`), so every gameweek of every historical replay ran one free
   transfer rich.

2. **Pre-season reported the CAP.** The draft branch set `freeTransfers:
   rules.maxFreeTransfers`, so the app told a manager with no squad that he had
   5 free transfers. Before the first deadline transfers are UNLIMITED, and the
   first gameweek after it has exactly ONE. Unlimited does not roll over. The
   projected plan then compounded it into "you go into next gameweek with 5 free
   transfers" for gameweeks 2 and 3.

### Optimizer-affecting, not display-only

The count enters the objective in two places, so this changed decisions rather
than captions:

- `hits = max(0, transfers - free)` decides how many of a candidate's transfers
  are charged 4 points. A candidate that was free at 2 banked is a hit at 1.
- the roll term prices what a candidate banks, in both `transfers.js`
  (`ftValuePoints`) and `planner.js` (`rollBonus`).

The proof is in the replay: transfer counts fall (217 to 202 across three
seasons), a hit appears in 2024-25 that the old model never had to take, and the
chip trajectory forks. The check that says it is the transfers and nothing else:
`hold`, which never transfers, is bit-identical before and after in all three
seasons (1605 / 1592 / 1771).

### Why 3000 passing tests did not catch it

Every assertion in the suite tested a SNAPSHOT: is this count between 0 and the
cap, is this plan legal, is this hit priced at 4. A manager carrying one extra
free transfer all season satisfies all of them, in every gameweek. There was no
test anywhere that walked gameweek 1 to gameweek 6 and asserted 1, 2, 3, 4, 5.

`tests/transfer-state.test.mjs` is that test, and it reads as sequences.

### The replay, before and after

Both arms replayed back to back on the same tree, all 38 gameweeks, horizon 3,
seed 1, balanced, previous season seeded where one exists.

| season  | measure   | before | after | delta |
|---------|-----------|-------:|------:|------:|
| 2022-23 | planner   |   2121 |  2131 |   +10 |
|         | vs greedy |   +139 |  +136 |    -3 |
|         | vs hold   |   +516 |  +526 |   +10 |
|         | transfers |     68 |    66 |    -2 |
|         | hits      |      0 |     0 |     0 |
| 2023-24 | planner   |   1893 |  1898 |    +5 |
|         | vs greedy |    -62 |   -52 |   +10 |
|         | vs hold   |   +301 |  +306 |    +5 |
|         | transfers |     73 |    72 |    -1 |
|         | hits      |      0 |     0 |     0 |
| 2024-25 | planner   |   2093 |  2087 |    -6 |
|         | vs greedy |    -13 |   -44 |   -31 |
|         | vs hold   |   +322 |  +316 |    -6 |
|         | transfers |     76 |    64 |   -12 |
|         | hits      |      0 |     1 |    +1 |
| total   | planner   |   6107 |  6116 |    +9 |

Baselines beside them: greedy-xp 6043 to 6076, hold 4968 to 4968.

Nine chip-free windows, the deciding instrument:

| season  | window  | before | after | delta |
|---------|---------|-------:|------:|------:|
| 2022-23 | gw1-13  |    559 |   507 |   -52 |
| 2022-23 | gw14-26 |    755 |   794 |   +39 |
| 2022-23 | gw27-38 |    783 |   821 |   +38 |
| 2023-24 | gw1-13  |    756 |   747 |    -9 |
| 2023-24 | gw14-26 |    617 |   639 |   +22 |
| 2023-24 | gw27-38 |    695 |   802 |  +107 |
| 2024-25 | gw1-13  |    780 |   814 |   +34 |
| 2024-25 | gw14-26 |    910 |   883 |   -27 |
| 2024-25 | gw27-38 |    547 |   565 |   +18 |
| total   |         |   6402 |  6572 | **+170**, 6-3-0 |

**The points are not the point.** +9 over three seasons with chips and +170
across the windows is well inside the noise this file documents (the seed alone
moves 9-10 of 15 windows). The change ships because the old arithmetic was not
the game's, not because the corrected arithmetic scores better. If it had cost
200 points it would still ship.

### What it changed structurally

`js/engine/transfer-state.js` is now the only module that knows how the
allowance evolves: a pre-season state that means unlimited rather than a number,
one `advance` that owns the gameweek-to-gameweek transition, one `hitCost`, one
`transferAccounting`. `squad.js`, `planner.js`, `transfers.js`, `chips.js`,
`backtest.js` and `explain.js` consume it and no longer carry copies of
`Math.min(cap, kept + 1)` or `max(0, count - free)`.

### Do not

- Do not compare a new experiment against any planner total published in this
  file before 2026-08-11. Re-measure the before arm on your own tree, which this
  file's Methodology section already required and which would have caught this
  four experiments ago.

---

## 6. Canonical cross-season player identity

- **Date:** 2026-08-11
- **Kind:** data-integrity fix, not a modelling change. No model behaviour was
  altered except where a join was wrong.
- **Files:** new `js/engine/player-identity.js`; `js/engine/backtest.js`,
  `scripts/fetch-history.mjs`, `scripts/backtest.mjs`, `scripts/train-model.mjs`,
  new `tests/player-identity.test.mjs`.
- **Full write-up:** `experiments/cross-season-identity.md`.

### What was wrong

FPL reassigns `element` every season. An element id present in two consecutive
seasons is the same footballer in 0.13%, 0.00% and 0.12% of cases across the
three pairs we hold, so a cross-season join keyed on it is a shuffle rather than
a lossy join. Found by regressing start rate in season N+1 on season N: slope
0.017 joined on `element` against 0.691 joined on name, for a quantity that is
one of the most persistent in the sport.

**No production code joined on `element` across a season.** The audit checked
every use of `element`, `id`, `code`, `player_id` and every player-keyed Map in
the repository, and the trainer, the availability pipeline, the minutes model
and the projection path are all within-season. The single cross-season join in
the shipped tree is the replay's prior-season seeding, and it matched on the
archive's raw `name` string: never the wrong player, but it discarded 14 of 526
returning players entering 2023-24 and 23 of 513 entering 2024-25, with 11,366
and 19,061 of their prior-season minutes. Rodri, Tomiyasu, Mitoma, Coufal and
Joe Gomez each started a season with no history at all.

### What was established

`code` is the canonical identifier, and that was measured rather than assumed.
It is ABSENT from `merged_gw.csv` in all four seasons; it is present in
`players_raw.csv` in the same archive, which also carries `id` equal to
merged_gw's `element`, so `element + season -> code` is an exact bridge. Every
code shared by two consecutive seasons names the same footballer: 526/526,
513/513 and 534/534.

### Points

Both arms replayed back to back on a frozen tree, the AFTER arm being the BEFORE
arm plus only the files this entry owns, because other work was editing
`lineup.js`, `squad-builder.js` and `counterfactual.js` concurrently.

| instrument | broken join | corrected join |
| --- | ---: | ---: |
| full seasons, planner | 6234 | 6434 |
| nine chip-free windows | 6572 | 6412 |

2022-23 is bit-identical for all four strategies, because 2021-22 is not
downloaded and that season therefore has no prior to join. That is the control.

### Decision

**SHIP.** The same reasoning as entry 5: this is what the data says, and a
replay that discards a returning player's season is not measuring the game. The
two instruments disagreeing in sign is the point, not a problem to resolve. No
verdict in this file was re-decided on the strength of it.

### What it invalidates

- Every planner points number in this file and in `leaderboard.md` measured
  before this entry. Baseline tables at the top of both files are re-measured.
- The availability experiment's rejection, on both instruments. Re-run: see
  entry above and the box in `experiments/availability-minutes.md`.
- The `+620` in `experiments/transfer-churn.md`, re-run to +574 (t 2.02,
  31W/14L). The churn-cost rejection itself stands on a non-monotone sweep and
  is not disturbed.

### Open, deliberately not fixed here

`buildTeamHistory` in `scripts/train-model.mjs` keys clubs by NAME and is queried
with `opponent_team`, a season-scoped club INDEX, so `oppConcededPerMatch` and
`oppScoredPerMatch` are identically zero on all 27,138 rows of every season. Two
of twenty-four declared features are dead and carry a fitted weight of exactly
zero. Same class of defect, an id joined against the wrong key space, but WITHIN
a season and therefore not this entry's subject. It reaches no user:
`engineConsumes` is empty. Reviving two features changes every fitted candidate
and needs a retrain, a re-evaluation and its own before/after, which is a
modelling round and was not smuggled into an integrity fix.

### Re-test if

The archive gains a `code` column of its own, or `players_raw.csv` stops being
published. `tests/player-identity.test.mjs` fails loudly in both cases rather
than falling back to a name match.

---

## 7. The replay's evidence: a missing starts column and a numerator without its denominator

- **Date:** 2026-08-12
- **Kind:** correctness fix to the MEASURING INSTRUMENT, not a modelling change.
  Production behaviour is unchanged by construction and a test asserts it.
- **Files:** `js/engine/backtest.js`, `js/engine/minutes.js`, new
  `tests/replay-evidence.test.mjs`.
- **Full write-up:** `experiments/replay-evidence.md`.

Two defects, both in what the replay told the minutes model it knew.

1. **The 2022-23 archive has no `starts` column for gameweeks 1 to 15.** FPL
   added the field mid-season. Summed over each archive, `starts` is 8,360 in
   2023-24, 2024-25 and 2025-26, which is exactly 11 x 2 x 380, and 5,368 in
   2022-23. With starts at zero the model reads a league in which nobody starts,
   infers every minute was a substitute minute, and returns pStart 0 with pAppear
   near 1. Reconstructed as the eleven players with the most minutes in each
   club's fixture, validated at 98.66% and 98.64% of rows against the two seasons
   that carry the truth, with the count exact by construction.

2b. **A third defect, found the same day and shipped with them:** the 2025-26
   archive carries the four defensive-contribution columns and the replay was
   hardcoding them to zero, under a comment that was true when it was written.
   No current experiment touches that season and the three that are replayed
   have no such columns, so they are bit-identical either way (2209 / 2208 /
   2453). It is fixed because the season is already downloaded and adding it to
   `KNOWN_SEASONS` is a one-line change, after which the replay would project no
   defensive contribution against actuals that contain it on one played row in
   eight. Found by rebuilding every row's `total_points` from its own
   components: three seasons reconstruct at 100.00%, 2025-26 missed by exactly
   -2 on 12.3% of rows, and closing that gap verified the DEF 10 and MID/FWD 12
   thresholds against 11,498 real awards. `scripts/validate-history.mjs` keeps
   the check.

2. **The previous season was seeded into the numerator and not the denominator.**
   The replay seeds a player's totals from last season at half weight;
   `minutes.js` divided them by the matches THIS season had played. On 2024-25's
   260 most-owned players, 89% read a start rate at or above 1 at gameweek 3,
   82% at gameweek 5, 71% at gameweek 10. Median AND 90th-percentile pStart:
   1.000. Every position prior: 1.000. Fixed by publishing `evidenceMatches`
   alongside the totals, which the archive already counts as `appearances`.

### Points

45 paired trajectories, the same cells either side, tree fingerprinted on both:

| season | before | after | delta | W-L-T |
| --- | ---: | ---: | ---: | --- |
| 2022-23 | 10,851 | 10,872 | +21 | 6-9-0 |
| 2023-24 | 9,727 | 10,471 | +744 | 13-2-0 |
| 2024-25 | 10,882 | 11,370 | +488 | 11-4-0 |
| total | 31,460 | **32,713** | **+1253** | 30-15-0 |

2022-23 has no downloaded predecessor and so never had the second defect. It
barely moves, which is the control that says the gain is the fix.

Full seasons with chips: planner 6336 to 6804, greedy-xp 6161 to 6548, hold 4759
to 5534. `hold` never transfers, so its +775 is the opening squad being picked on
real minutes.

### Decision

**SHIP.** As with entries 5 and 6, this is what the data says rather than what
scores better, and it would ship if it cost points. What it changes for everyone
else is that no planner number in this file measured before today is comparable
to one measured after it.

### What it leaves open

Projection bias moved from about zero to **-7 points a gameweek** in the seeded
seasons (the model now UNDER-projects by roughly 11%, measured like for like with
auto-substitutions taken off the actual side). The old near-zero was two errors
cancelling. That is the largest open modelling question on the board and it fires
entry 1's own re-test condition; see entry 9.

## 8. Availability signal: REJECTED, settled

- **Date:** 2026-08-12
- **Write-up:** `experiments/availability-minutes.md`, box at the top.
- **Instrument:** 45 paired trajectories read as 15 windows, on the corrected
  evidence tree, both arms in one fingerprinted run.

| statistic | per window | per trajectory |
| --- | ---: | ---: |
| observations | 15 | 45 |
| total | +171 | +514 |
| mean | +11.4 | +11.4 |
| se | 10.8 | 7.5 |
| t | **1.06** | 1.51 |
| W / L / T | **7 / 7 / 1** | 27 / 15 / 3 |
| sign test p | **1.00** | 0.09 |

The aggregate is one window: 2023-24 gw20-32 at +131.7, three seeds of which
contributed +119, +131 and +145 to the per-trajectory view. Drop it and the mean
is +2.8.

- **Decision: REJECT.** Three measurements on three trees have never produced a
  consistent effect. The mechanism that justified the original rejection is
  untouched: the signal is retrospective by construction, fires the week after a
  player goes down and clears the week after he returns. It stays behind
  `FPL_AVAILABILITY=1`, off by default.
- **Re-test only if** a pre-deadline source of team news or an expected return
  date becomes available. Not otherwise.
- **What this experiment cost the project is worth recording:** it was rejected,
  voided, re-measured, quoted as the reason to distrust a whole instrument, and
  rejected again, across four sessions. Two of those rounds were spent measuring
  a minutes signal on a replay that had no working minutes model.

## 9. Default planning horizon, 3 back to 5

- **Date:** 2026-08-12
- **What changed:** `DEFAULT_HORIZON` in `js/engine/planner.js`, 3 to 5, plus the
  two constants required to equal it (`js/engine/lineup.js`, `js/ui/store.js`
  `DEFAULT_SETTINGS`). Settings still offers 3, 5 and 8.
- **Why this was reopened:** entry 1 wrote its own re-test condition, "if
  projection calibration materially improves, re-run the sweep. The bias is why
  the shorter horizon wins." Entry 7 moved projection bias from about zero to
  -7 points a gameweek in the seeded seasons, which fired it. Entry 1's evidence
  was also nine chip-free windows at one seed, measured on the replay whose
  pStart was pinned at 1.000, so it is withdrawn rather than outweighed.

### The deciding instrument: 45 paired trajectories read as 15 windows, chips off

| arm | per-window mean | se | t | p | W-L-T | trajectory total |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| horizon 5 | **+21.6** | 9.3 | **2.32** | 0.04 | **11-4-0** | +971 |
| horizon 8 | +17.7 | 13.8 | 1.28 | 0.22 | 9-6-0 | +795 |

Per season, horizon 5 against horizon 3: **+16, +546, +409**. Positive in all
three, which is the consistency this file requires of an aggregate.

Both candidates beat the control and 5 beats 8, so this is an interior optimum
rather than "more horizon is always better". That shape is itself evidence: a
result that improved monotonically to the edge of the sweep would be the
signature of a bug in the parameter, and a peak in the middle is what a real
trade-off looks like.

### The weakest instrument disagrees, and is reported anyway

Full 38 gameweeks WITH chips, one seed:

| arm | 2022-23 | 2023-24 | 2024-25 | total |
| --- | ---: | ---: | ---: | ---: |
| horizon 3 (control) | 2247 | 2229 | 2328 | 6804 |
| horizon 5 | 2209 | 2208 | **2453** | **6870** |
| horizon 8 | 2067 | 2229 | 2450 | 6746 |

Horizon 5 gains 66 points while losing two seasons of three. Three trajectories
cannot separate a 20-point-a-window effect from chip cascade, and these replays
additionally run on the 2025-26 chip catalogue, which hands those seasons three
chips they did not have. It is reported because it was measured.

### Cost

Plan generation on the sample dataset roughly doubles, 613-801ms to
1098-1536ms, in a Web Worker behind a loading state.
`tests/perf-budget.test.mjs` carries the measurement and still has several times
its budget in hand.

### Decision: ACCEPT

The instrument that decides says horizon 5 by 21.6 points a window with a t of
2.32, positive in every season, 11 windows to 4. Nothing now supports 3: its
evidence was measured on a replay that could not represent expected minutes.

- **Re-test if:** the under-projection entry 7 leaves open is fixed. The
  horizon's value depends on how much projection error each extra gameweek
  imports, so the quantity that reopened this question will reopen it again when
  it moves. Run `experiments/configs/horizon.mjs`; about twenty minutes.
- **Do not** decide this on full-season replays. Two sessions have now reached
  two different answers from three chips-on trajectories.

## 10. The start-rate shrinkage target, conditioned on ownership

- **Date:** 2026-08-12
- **Decision: REJECT.** The candidate is removed from the tree; `baseStart`
  shrinks toward the flat position rate exactly as before.

### The defect it was aimed at, which is real and stays open

With the replay's minutes evidence corrected (entry 7), the engine
under-projects. Diagnosed over 9,727 projected player-gameweeks of 2024-25,
leakage-free:

| quantity | predicted | observed |
| --- | ---: | ---: |
| points per 90, among players who actually started | 3.825 | 3.823 |
| pStart | 0.532 | 0.565 |
| xMins | 48.5 | 50.5 |
| top 11 by projection, per gameweek | 52.2 | 57.5 |

The points-given-minutes model is calibrated to three decimal places. pStart is
3 to 5 points of probability low, in every decile from the second up.

The mechanism looked clear. `baseStart` is shrunk toward the position's
league-wide start rate, measured over every player with a minute to his name,
while the pool the planner projects is the 260 most-owned, whose true rate is
well above that. The pull is downward for nearly everything the engine
evaluates, and it never disappears because the weight caps out near 0.86.

### The candidate

Shrink toward the position rate for the player's OWNERSHIP QUARTILE instead,
each bucket itself shrunk toward the position rate by its own sample size.
Ownership is published pre-deadline, needs no new data source, and is already
what the pool is selected on.

It fires as designed: at gameweek 12 of 2024-25 the midfielder buckets read
0.196 / 0.238 / 0.383 / 0.600 against a flat 0.396, and 244 of the 260 pooled
players' pStart moved, mean +0.026, largest +0.088.

Prediction metrics improve, and not only where the pool is selected:

| scored over | arm | bias | Brier | log loss | ECE |
| --- | --- | ---: | ---: | ---: | ---: |
| owned pool, 2024-25 | flat | -0.033 | 0.1859 | 0.5502 | 0.0350 |
| owned pool, 2024-25 | ownership | -0.008 | 0.1838 | 0.5448 | 0.0146 |
| every player with history, 2024-25 | flat | +0.023 | 0.1566 | 0.4780 | 0.0338 |
| every player with history, 2024-25 | ownership | +0.021 | 0.1542 | 0.4696 | 0.0240 |

The flat prior is too LOW for the owned pool and too HIGH for everyone else,
which is the signature of an unconditional target rather than a wrong one.

### Planner points, 45 paired trajectories read as 15 windows

| statistic | per window | per trajectory |
| --- | ---: | ---: |
| total | +43 | +129 |
| mean | +2.9 | +2.9 |
| se | 7.7 | 6.0 |
| t | 0.37 | 0.48 |
| W / L / T | 7 / 8 / 0 | 23 / 21 / 1 |
| sign test p | 1.00 | 0.88 |

Per season: +272, **-218**, +75. Seven wins, eight losses, and the one season
that goes backwards does so 4 windows to 11.

### Why it does not pay, which is the part worth keeping

The predicted mechanism did not fire, and the counters say so plainly:

| measure, summed over 45 trajectories | control | ownership |
| --- | ---: | ---: |
| hits taken | 6 | **2** |
| transfers | 521 | 526 |
| bench points left | 3,474 | **3,844** |
| projection bias per gameweek | -11.27 | -10.46 |

The argument for this change was that under-projection makes the engine too
timid at its ABSOLUTE thresholds, so a correction should buy more hits. Hits went
DOWN, and the projection bias closed by 0.8 points of the eight it was supposed
to close.

The reason is that a shrinkage target only matters in proportion to `1 - w`, and
`w` is large exactly for the players who make the eleven. Established starters
carry 19 to 38 matches of evidence and barely feel the prior at all; the players
the correction moves are the low-evidence ones, who are not in the team. So the
change repriced the squad's fringe, not its spine, and the eleven's projection
barely moved.

**Which relocates the open question rather than answering it.** The top decile of
projections is 7.6% low on points while its expected minutes are within 1%
(predicted 4.178 points on 75.9 minutes against an observed 4.494 on 76.8), so
whatever is missing at the top of the market is NOT minutes. The next hypothesis
is the per-90 rate shrinkage: an elite attacker's rate is pulled toward his
position's by the same empirical-Bayes k, and `PRIOR_NINETIES` for a midfielder's
expected goals is only 3.7 nineties, which is weak, but bonus (k = 19 to 24) is
not. Look there before looking at minutes again.

### What was removed

The bucket machinery and the `tuning` option that carried it through
`buildProjections` and `projectMinutes` are gone; production never consumed
either. To re-run this, the change is one block in `positionPriors`, one term in
`baseStart`, and a `tuning` pass-through in three call sites, plus an arm with
`opts: { tuning: { startPrior: 'ownership' } }`.

## 11. The xG/xA denominator: expected data starts at 2022-23 gameweek 16

- **Date:** 2026-08-13
- **Kind:** correctness fix to the measuring instrument, entry 7's fourth
  member. Same bug class (a numerator divided by minutes it does not cover),
  same fix pattern (the caller that builds the numerator declares the
  denominator), same production guarantee (a live payload never sets the field
  and is bit-identical by construction; tests assert it).
- **Files:** `js/engine/backtest.js` (`flagExpectedData`, `xMinutes`),
  `js/engine/projections.js` (`xNineties` in `underlyingRates`/`shrinkRates`),
  `scripts/validate-history.mjs` (coverage check), four new tests in
  `tests/replay-evidence.test.mjs`.
- **Write-up:** `experiments/replay-evidence.md`, defect 4.

The 2022-23 archive's expected_* columns are exactly zero before gameweek 16
(they shipped with `starts`). The replay accumulated xG from gameweek 16 on and
divided by minutes from gameweek 1, so every 2022-23 attacking rate was
understated in proportion to pre-16 minutes: Haaland's mid-season xG/90 read
0.369 against a covered-minutes 0.723. The season's totals then seeded 2023-24
at the same understatement.

### Points, 45 paired trajectories

| season | before | after | delta |
| --- | ---: | ---: | ---: |
| 2022-23 | 10,888 | 11,119 | +231 |
| 2023-24 | 11,017 | 11,173 | +156 |
| 2024-25 | 11,779 | 11,779 | **0, bit-identical** |
| total | 33,684 | **34,071** | **+387**, 7-2-6 by window |

The exposure gradient is the proof: the unexposed season does not move by a
single point, and within 2022-23 the uncovered opening window moves by exactly
zero. Null arm clean before and after.

### Decision

**SHIP.** Correctness, not modelling; it would ship at -387. The deciding
instrument's control arm is now **34,071** and nothing measured against 33,684
is comparable.

### Re-test if

`fetch-history.mjs` ever swaps archive sources, or a future season introduces a
column mid-year again. `validate-history.mjs` now warns on any gameweek whose
league-wide expected sum is zero with minutes on the board.

## 12. Assist lambda scaled by the measured FPL-assists-per-xA ratio

- **Date:** 2026-08-13
- **Decision: REJECT.** The candidate is removed; the assist lambda comes
  straight from xA exactly as before.

### The mechanism it was aimed at, which is real and now measured

An FPL assist is broader than the Opta assist xA models: rebounds, deflections,
winning a converted penalty and forcing an own goal all count. League-wide,
actual FPL assists run at **1.42 / 1.37 / 1.38 times xA** in the three complete
recent seasons, while goals sit at 0.98 to 1.0 times xG. The component
decomposition (this entry's parent diagnosis) measured missing assists as 55%
of the top projection decile's gap in 2024-25 and 49% in 2023-24, the single
largest component in both.

### The candidate

Multiply the assist lambda by an ONLINE league ratio: summed pre-deadline
assists over summed pre-deadline xA, covered rows only so 2022-23's
half-coverage cannot poison it, capped at 2, defaulting to 1 with no evidence.
Nothing typed in, nothing fitted to the replayed seasons. Verified live: the
ratio reads 1.35-1.43 from gameweek 1 (seeded) and exactly 1.0 in 2022-23 until
covered data exists.

### Planner points, 45 paired trajectories read as 15 windows

| statistic | per window | per trajectory |
| --- | ---: | ---: |
| total | **-156** | -467 |
| mean | -10.4 | -10.4 |
| se | 6.0 | 4.4 |
| t | -1.73 | -2.36 |
| W / L / T | 4 / 9 / 2 | 13 / 26 / 6 |

Per season: -121 (0W-9L-6T), -309 (6W-9L), -37 (7W-8L). Negative in all three.

### Why a true correction loses points, which is the entry worth keeping

Projection bias improved (-9.40 to -7.14 a gameweek) and points fell: the fifth
change in this project to improve a calibration quantity and not the planner.
The decision-level counters say how:

| summed over 45 trajectories | control | candidate |
| --- | ---: | ---: |
| captaincy value | 1,766 | **1,709** |
| hits | 12 | **19** |
| transfers | 523 | 539 |

1. **The planner acts on rankings, and the correction reranks wrongly.** The
   quartile table held the warning before the run: the TOP creativity quartile
   has the LOWEST assists-per-xA ratio (1.32-1.40 against 1.45-1.50 for the
   middle). The league multiplier hands its largest absolute boosts to exactly
   the players whose extra-assist premium is smallest, tilting captaincy and
   transfers toward elite creators and away from finishers.
2. **A level correction crosses absolute thresholds.** Inflated assist
   projections pushed seven more swaps over the 4-point hit bar, and they did
   not pay.

The general lesson, sharper than before: a component can be genuinely
under-projected IN AGGREGATE while every decision-relevant COMPARISON is
already right, because the aggregate gap sits mostly on the level, and the
level cancels out of a ranking. Only the part of a correction that changes
ORDER changes decisions, and here the induced order-change pointed the wrong
way.

### Do not re-test

- A flat multiplicative assist scale, at any strength, measured or tuned.
- An additive per-90 assist constant: it changes levels only, so it cannot
  change decisions except through the hit/chip thresholds it just failed at.

### Worth testing instead, if assists are ever revisited

A ratio conditioned on WHERE the extra assists come from (penalty-winning
dribblers, corner takers, rebound-generating shot volume), because the failure
was the gradient, not the level. Set-piece order is already in the payload and
`setPieceMultipliers` is the natural seam. Requires evidence that the
conditioning signal is stable season over season before any run.

### Reconstruction

One multiplier in `projectFixtureForPlayer` (`lamAssists *= ratio`), a cached
`leagueAssistRatio(gameState)` summing player totals, an `assistsCovered`
accumulator field beside `xMinutes`, and a `tuning` pass-through in
`buildProjections`/`projectPlayerGw` and the backtest's `plannerDecide`. All
removed; this entry is the spec.

## 13. Bonus curve fitted in its query space

- **Date:** 2026-08-13
- **Decision: INCONCLUSIVE, not shipped.** Direction positive, no
  significance, and the same rule that rejected the availability signal at
  t 1.06 applies at t 0.80.

### The mismatch, which is real and measured

`bonusModel` fits an isotonic curve on RAW season bps/90 and the projection
queries it with a SHRUNK rate. A curve convex at the top under-reads queries
drawn from that compressed distribution: on the top raw-bps decile (players
with 8+ nineties of evidence), curve(shrunk input) predicts 0.550 bonus/90 in
2024-25 against an observed 0.749, while curve(raw input) predicts 0.696 - the
curve itself is nearly calibrated and the query transformation is what loses
the points. Bonus is 24-54% of the top projection decile's gap.

Unlike entry 12, the ORDER diagnostic passed before the run: inside the top
decile the bonus deficit grows monotonically with projected points (gaps 0.083
/ 0.128 / 0.305 by tercile in 2024-25, 0.049 / 0.142 / 0.184 in 2023-24), so
the correction steepens an ordering that is already right.

### The candidate

Fit the same isotonic curve on (shrunk bps/90 -> raw bonus/90), so fit and
query live in one space. No new constants; noise control preserved. Verified to
move the top-26 of a live pool by +0.06 bonus points and the mid-pool by +0.02.

### Planner points, 45 paired trajectories read as 15 windows

| statistic | per window | per trajectory |
| --- | ---: | ---: |
| total | +99 | +297 |
| mean | +6.6 | +6.6 |
| se | 8.3 | 6.3 |
| t | 0.80 | 1.05 |
| W / L / T | 10 / 5 / 0 | 28 / 17 / 0 |

Per season: +228 (12W-3L), -7 (7W-8L), +76 (9W-6L). Spread across windows, no
single-window carry, no season collapse - the healthiest-looking null this
project has produced, and still a null.

### Why this is INCONCLUSIVE rather than REJECT

Two things distinguish it from entries 8, 10 and 12. The pre-registered order
diagnostic passed, and the theoretical direction is one-sided (a convex curve
under a compressed query distribution can only under-read). But the achievable
effect is small - the shrunk-fit curve recovers ~0.06 xPoints for top players -
and a true effect that size cannot clear t 2 on fifteen windows. The instrument
cannot decide effects this small; that is a statement about the instrument, and
it is why this entry is not a rejection of the mechanism.

There is also a genuine counter-argument recorded for balance: isotonic
regression on noisy raw x already suffers regression dilution, which FLATTENS
the fitted curve and partially compensates the shrinkage of the query. The two
biases offset by different amounts at different evidence levels, so "fit and
query in one space" is a modelling preference, not an external truth like a
free-transfer count. That is why it does not ship on principle the way entries
5, 6, 7 and 11 did.

### Re-test when the instrument gains power

When 2025-26 becomes a replayable season (complete, chip catalogue corrected
per the open-work list, defensive contribution already parsed), the instrument
grows to 20 windows and a +6.6 mean with this spread would read at roughly
t 1.1-1.3; two such seasons would decide it. Do not re-run before then and do
not bundle it with another bonus change.

### Reconstruction

`bonusModel(gameState, { tuning })` keyed cache; fit x = `shrinkRates(
underlyingRates(p, {}), { position, priors }).bps` when
`tuning.bonusFitSpace === 'shrunk'`; `tuning` threaded through
`buildProjections` and the backtest's `plannerDecide`. All removed; this entry
is the spec.

## 14. Historical season rules: chips, the transfer cap and the World Cup break

- **Date:** 2026-08-13
- **Kind:** correctness fix to the replay's rules fidelity. Ships on principle.
- **Files:** `scripts/backtest.mjs` (`historicalRules`, `loadRules(season)`),
  `js/engine/transfer-state.js` (two era flags with live-game defaults),
  `scripts/experiment-worker.mjs` (per-season rules), four sequence tests in
  `tests/transfer-state.test.mjs`.

The replay scored every historical season under the 2026-27 bootstrap fixture:
two of every chip, a 5-transfer bank, chip weeks preserving the bank, and no
World Cup break. The seasons actually played were:

| season | chips | FT cap | chip week banks? | other |
| --- | --- | --- | --- | --- |
| 2022-23 | 2 WC (2-16, 18-38), 1 FH, 1 BB, 1 TC | 2 | no | unlimited transfers at GW17 |
| 2023-24 | 2 WC (2-20, 21-38), 1 FH, 1 BB, 1 TC | 2 | no | |
| 2024-25 | 2 WC (2-19, 20-38), 1 FH, 1 BB, 1 TC | 5 | yes | AM chip, not modelled |

Windows verified against premierleague.com announcements. Season literals live
in the script (the engine bans them); the engine reads `maxFreeTransfers`,
`chipPreservesBank` and `unlimitedEvents` off the rules object with defaults
that reproduce the live game, and the unlimited week reuses the pre-season
phase (no count; the following week starts at exactly one).

### What it changed

Chips-on full seasons, the first totals ever measured under the rules those
seasons were played by: **2239 / 2283 / 2453 = 6975**. Every chip lands inside
its historical window, one FH/BB/TC each, and the 2022-23 replay takes its
second wildcard at GW18, the free rebuild after the World Cup break that real
managers took. Prior chips-on totals (6870 and everything before) were measured
under a catalogue with three chips those seasons did not have; do not compare
against them.

Chip-free paired instrument: 34,071 to **34,051** (+19 / -39 / 0 by season), a
wobble from the 2-cap and the GW17 unlimited week in the two affected seasons;
2024-25 is bit-identical because its era rules match the modern fixture with
chips stripped. Null arm exactly zero.

### What it unblocks

Chip-strategy experiments, which were invalid under the anachronistic
catalogue, and (with the already-parsed defensive contribution) the path to
2025-26 as a fourth replayable season, which is entry 13's re-test condition.

### Known residual approximations

- The GW17 unlimited week models the ALLOWANCE correctly but the planner still
  only searches its normal move depth, so it rebuilds less than a real manager
  could. A search limit, correctly NOT written into game state.
- 2022-23 prices during the break and the January-window value drift are the
  archive's own, unchanged.
