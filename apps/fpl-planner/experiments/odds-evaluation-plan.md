# Do bookmaker odds improve this planner?

Status: **plan only. Nothing here has been run.** No odds account exists, so no
odds data exists, so there is no result to report. This document exists so that
the experiment is designed before the data is bought rather than after, and so
that the bar it has to clear is written down before anyone is emotionally
invested in the answer.

The thing being tested is the first of the two known weaknesses in
`js/engine/fixtures.js`: the fixture model is built from team attack and defence
ratings fitted on past goals, and it cannot see injuries, rotation, form or
transfers the way a betting market can. A market price is a forecast produced by
people with money at stake and access to team news, so the hypothesis is that
replacing (or blending into) the ratings-derived expected goals with
odds-derived expected goals produces better fixture inputs and therefore better
FPL decisions.

The second weakness, expected minutes, is deliberately **out of scope here**.
See the closing section for why it cannot be evaluated on the same footing yet.

## The bar, and why it is set where it is

A statistical improvement is not a result. This project has already produced one
and thrown it away.

`models/fpl-planner-v2.json` carries a trained start-probability calibrator that
beats its own statistical baseline on the metric it was trained for: test log
loss 0.3006 against 0.3135, expected calibration error 0.0447 improved to
0.0221. Switching it on cost points in every leakage-free replay that was run:

| Season replayed | planner | greedy-xp | hold |
| --- | --- | --- | --- |
| 2024-25 | 2371 to 2211 (-160) | 2284 to 2215 (-69) | 2006 to 1953 (-53) |
| 2023-24 | 1943 to 1853 (-90) | 1947 to 1892 (-55) | 1928 to 1944 (+16) |

Both seasons, both decision strategies, same direction. That is why
`engineConsumes` in the shipped artifact is empty.

So, stated plainly and up front:

> **If odds improve a statistical metric but reduce planner points, they do not
> ship.** The statistical metrics below are diagnostics that tell us *why* a
> result happened. The planner metrics are the result.

A change that improves the statistical metrics and leaves planner points flat
does not ship either, because it adds a paid external dependency, a failure
mode, and a per-gameweek fetch, in exchange for nothing a user can see.

## Part 0: what has to exist before any of this can run

### 0.1 The snapshot set

Three replay seasons, 38 gameweeks each, 114 snapshots total. For each
gameweek, one odds snapshot taken **at or before that gameweek's FPL deadline**,
covering every Premier League fixture in that gameweek.

The deadline is 90 minutes before the first kickoff of the gameweek. The archive
dataset carries `kickoff_time` per row, so for each gameweek:

```
deadline(gw)  = min(kickoff_time of any fixture in gw) - 90 minutes
snapshotAt(gw) = deadline(gw) - 5 minutes
```

The 5 minute margin is not superstition. It absorbs any disagreement between the
provider's snapshot clock and FPL's deadline clock, and it costs almost nothing
in information: prices move very little in the last five minutes before a
Friday-evening deadline compared with how much they move across the week.

### 0.2 Fixture matching, and the rule when it fails

Bookmakers write team names their own way ("Wolverhampton Wanderers", "Nott'ham
Forest"). Every odds event must be matched to exactly one archive fixture by
(home team, away team, kickoff date). `js/engine/odds.js` pushes this onto the
caller through a required `resolveTeam(name)` and throws on an unresolved name,
on purpose: a silent wrong match corrupts a projection invisibly.

Rule: a gameweek in which **any** fixture fails to match is excluded from the
paired comparison entirely, not partially filled. The count of excluded
gameweeks per season is reported alongside every metric. A comparison run on a
subset that quietly differs between arms is worthless.

### 0.3 The leakage rules, which are the whole experiment

1. Every derived fixture row carries `fetchedAt`, taken from the provider's
   snapshot timestamp and never from the request time or the local clock. The
   adapter test in `tests/odds.test.mjs` pins this specific property.
2. Before a gameweek is planned, assert `fetchedAt <= deadline(gw)` for every
   fixture row used. A violation is a hard error, not a warning, and not a
   filter.
3. Odds for gameweek N are visible to the plan for gameweek N and to nothing
   earlier. The existing accumulator guard in `js/engine/backtest.js`
   (`gameStateAt` throws when the accumulator has already absorbed the gameweek
   being requested) is the model for this: the failure must be structural.
4. The multi-gameweek horizon is the subtle one. The planner looks 3 gameweeks
   ahead. Odds for gameweek N+1 and N+2 **do not exist** at the deadline for
   gameweek N in any usable form, so the horizon beyond the current gameweek
   must keep using the ratings model. Any design where a future gameweek's odds
   leak backwards into the current plan is not a variant to test, it is a bug.
   Variant C below is the honest way to handle the horizon.
5. `tests/leakage.test.mjs` gets a case for the odds path before any result is
   believed.

### 0.4 Budget

At The Odds API's published quota rules (historical requests cost 10 credits per
market per region), one snapshot covering `h2h,totals` in the `uk` region is 20
credits. 114 snapshots is 2,280 credits, plus the events lookups. That fits
inside a single month of the cheapest paid plan. Weekly live use afterwards is
2 credits per gameweek.

If the backfill turns out to cost more than one month of the cheapest paid plan,
stop and re-read this section before spending, because the size of the prize
does not change with the size of the bill.

## Part 1: the design

A paired replay. Same seasons, same dataset, same seed, same horizon, same
risk setting, same code, one difference.

| Arm | Fixture expected goals from |
| --- | --- |
| Baseline | `js/engine/fixtures.js` as it ships today |
| A: replace | `deriveFromOdds()` for the current gameweek, ratings model for the rest of the horizon |
| B: blend | `w * odds + (1 - w) * ratings` in log space for the current gameweek, w in {0.25, 0.5, 0.75} |
| C: recalibrate | Odds used to refit team ratings at each deadline, so the horizon inherits the market's view rather than being spliced onto it |

Variant C is the only one where the horizon benefits, and it is also the one
most likely to help, because the horizon is where this planner earns its edge
over `greedy-xp`. It is more work than A or B and should be built only if A or B
show a signal.

Every arm runs `scripts/backtest.mjs` over 2022-23, 2023-24 and 2024-25 with
`--gw-from 1 --gw-to 38` and the shipped horizon. Reports are versioned and
never overwritten, the way the existing ones under `.data/backtests/` are.

## Part 2: prediction metrics (necessary, not sufficient)

These are computed per fixture across all three seasons and reported for both
arms. They diagnose. They do not decide.

**2.1 Expected goals error.** Against actual goals scored, per team per fixture:
mean absolute error and root mean squared error of `xGH` and `xGA`. Reported
separately for home and away, because a model that is right on average by being
wrong in both directions is not right.

**2.2 Total goals error.** MAE of `xGH + xGA` against actual total goals. This
is the cleanest single test of whether the over/under market beats the ratings
model, because under Poisson the totals market pins the sum exactly and the
ratings model has to infer it.

**2.3 Clean sheet Brier score and calibration.** Outcome is "the opponent failed
to score", prediction is `pCSHome` / `pCSAway`. Report the Brier score and a
10-bin reliability table using the same shape as `calibration()` in
`js/engine/minutes.js` (expected calibration error, max gap, per-bin predicted
against observed). Clean sheets are where defenders and goalkeepers make their
points, so a calibration failure here is a direct FPL cost, and it is the one
statistical metric most likely to move together with points.

**2.4 Match outcome log loss and Brier.** Three-way outcome against
`pWinHome / pDraw / pWinAway`. Expect the odds arm to win this comfortably, and
expect that to prove nothing on its own. Record it anyway, because if the odds
arm does *not* win this, the integration is broken and the rest of the run
should be abandoned rather than interpreted.

**2.5 Draw residual distribution.** `deriveFromOdds()` reports `drawResidual`,
the gap between the fitted Poisson draw probability and the market's. Report its
mean and its 5th/95th percentiles. Independent Poisson understates draws, so a
mean around -0.02 is expected and healthy. A large spread flags fixtures where
the Poisson assumption fits badly and whose derived clean-sheet numbers deserve
less weight, which is a candidate refinement rather than a defect.

**2.6 Player points error.** The metric that sits between the fixture model and
the decision. Per player per gameweek, on players with a non-trivial projection
(the existing pool cut is fine), report MAE and mean signed bias of projected
against actual FPL points. Bias matters more than MAE here: the calibrator
episode showed projection bias moving from +0.33 to +2.6 points per gameweek
while the underlying probability model got *better*, and that bias is what
wrecked the transfer decisions.

## Part 3: planner metrics (these decide)

All from `scripts/backtest.mjs`, all across all three seasons, all against the
baseline arm run on identical data.

**3.1 Season points.** `comparison.primary.seasonPoints`. The headline. Reported
per season and summed.

**3.2 Points above `greedy-xp`.** `comparison.aboveBaseline['greedy-xp']`. This
is the planner's actual edge: the value of looking ahead rather than picking the
best single gameweek. The calibrator collapsed this from +87 to -4 in 2024-25
while season points fell, which is exactly the diagnostic that told us the
problem was decision quality and not scoring. If odds raise season points but
shrink this gap, something is wrong and it needs explaining before shipping.

**3.3 Points above `hold`.** `comparison.aboveBaseline.hold`. The floor. If a
change cannot beat doing nothing, nothing else matters.

**3.4 Points above `fdr`.** The existing third baseline, reported for
completeness.

**3.5 Wildcard timing.** For each season and arm: the gameweek each chip was
played, and the chip value the replay assigns it (measured against holding the
pre-chip squad, which is what `js/engine/chips.js` already does). Odds should
sharpen wildcard timing if they help at all, because a wildcard is a bet on a
fixture run and a fixture run is precisely what the market prices better than a
ratings model. A wildcard that moves by a gameweek or two and gains value is
real evidence. A wildcard that moves and loses value is evidence against.

**3.6 Captaincy value.** Per season: total points scored by the captain pick
(doubled), and the gap to the perfect-hindsight captain choice from the same
squad. Captaincy is the single highest-leverage weekly decision and the one most
directly downstream of expected goals, so this is where an odds edge should show
up first and most clearly. If odds do not improve captaincy, be very suspicious
of a season-points gain elsewhere: it is probably noise.

**3.7 Transfer churn.** Number of transfers made and points spent on hits, per
season. Not a decision metric, a sanity metric. A model that gets more confident
every week and starts taking hits it did not take before can gain points for one
season and lose them for the next two.

## Part 4: the decision rule, written before the data exists

Ship the odds integration only if **all** of the following hold.

1. Season points improve in **at least 2 of 3** seasons and the three-season
   total improves by **more than 25 points**. Twenty-five points is roughly one
   good captaincy call per season and is comfortably above the run-to-run noise
   the existing replays show at a fixed seed.
2. Points above `greedy-xp` does not fall in any season. The planner's edge over
   single-gameweek greed is the product; a change that raises the total while
   eroding that edge is a change to the wrong thing.
3. Points above `hold` improves in at least 2 of 3 seasons.
4. Player-points bias (2.6) does not get worse in absolute value in any season.
5. Clean-sheet Brier and expected calibration error improve or hold. This is the
   one statistical gate that is binding, because clean sheets are the direct
   channel from fixture quality to FPL points.
6. The leakage assertions in 0.3 pass on every gameweek of every season, with
   zero excluded gameweeks from unmatched fixtures in the seasons being counted,
   or with the exclusions reported and the result robust to dropping those
   gameweeks from both arms.

If 1 fails, stop, whatever 2 to 6 say.
If 1 passes and 2 fails, do not ship; investigate, because that pattern means
something is being gained by luck and something else is being lost by design.

Blend weight `w` is chosen on the three-season total, and the chosen weight must
still satisfy every gate above. If only one value of `w` in {0.25, 0.5, 0.75}
passes and its neighbours fail badly, that is overfitting to three seasons, not
a discovery. Prefer the weight whose neighbours also help.

## Part 5: what gets written down

One report per arm per season under `.data/backtests/`, versioned, never
overwritten, the existing convention. Plus one summary table in this directory
recording, for every arm: three-season points, per-season points, points above
each baseline, chip timing, captaincy gap, every statistical metric in Part 2,
the number of excluded gameweeks, the exact snapshot timestamps used, and the
provider and margin-removal method (`ODDS_PARAMS.marginMethod`, currently Shin).

Negative results are written down in the same detail as positive ones. The
calibrator table at the top of this document is the reason we know not to retry
that idea, and it only exists because the losing run was recorded.

## Part 6: expected minutes, and why it is not in this experiment

Availability and rotation are the other known weakness and the larger one, since
minutes multiply everything else. They are excluded here for one reason:
**there is no historical availability data to replay against.**

`js/engine/backtest.js` builds every historical player with `status: 'a'` and
`chanceNext: null`, because the archive carries no availability columns. FPL's
own `bootstrap-static` is a live snapshot with no history: it reports the
current `status`, `chance_of_playing_next_round`, `news` and `news_added`, and
nothing about last season. So an availability feed could be integrated, but its
effect could not be measured, and by the rule at the top of this document an
unmeasurable change does not ship.

Two things would change that, and they are prerequisites rather than tasks:

1. A source of historical availability that can be reconstructed as of a past
   deadline (per-player injury and suspension windows with start and end dates
   would do it, evaluated as "was this player sidelined on the date of that
   deadline").
2. A backtest harness that can carry a per-gameweek availability signal at all,
   which today it cannot, since it hardcodes `'a'`.

Until both exist, the honest position is that the expected-minutes weakness is
real, measured, and not currently fixable in a way we could prove. Building it
anyway would be repeating the calibrator mistake with a monthly invoice attached.
