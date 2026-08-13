# Availability-aware expected minutes

**Status: REJECTED, settled 2026-08-12 on a corrected instrument and a corrected
statistic. The signal ships disabled and this file is closed unless one of the
two named conditions changes.**

> ## 2026-08-12: the verdict, and why the +574 was not one
>
> The rejection was voided in August because the replay underneath it seeded the
> previous season through a name match. The re-measurement then read +574 over 45
> paired trajectories (t 2.02, 31W/14L) and was deliberately left as "not an
> acceptance". It has now been run again, and the answer is that there is no
> effect to accept.
>
> Two things changed between that reading and this one, and both are corrections
> to the instrument rather than to the signal.
>
> **The replay could not represent minutes.** Its start-rate denominator excluded
> the previous season it had just seeded, so pStart was pinned at 1.000 for 89% of
> the owned pool at gameweek 3 and for a majority of it until gameweek 20. An
> availability signal is a minutes signal, and it was being measured by an
> instrument that had no minutes to move. See `experiments/replay-evidence.md`.
>
> **45 trajectories were never 45 samples.** Three seeds through one window are
> the same thirteen gameweeks of the same season with the same fixtures, the same
> prices and the same injuries; only the search RNG differs. Pairing cancels that
> noise, which is what it is for, but it does not make three correlated replays
> into three observations. The honest unit is the window, with seeds averaged
> inside it: fifteen, not forty-five.
>
> Re-run on the corrected tree (`scripts/experiment.mjs --config
> experiments/configs/availability.mjs`), both arms on one fingerprinted tree:
>
> | statistic | per window (seeds averaged) | per trajectory |
> | --- | ---: | ---: |
> | observations | 15 | 45 |
> | total delta | +171 | +514 |
> | mean | +11.4 | +11.4 |
> | standard error | 10.8 | 7.5 |
> | t | **1.06** | 1.51 |
> | p | **0.31** | 0.14 |
> | wins / losses / ties | **7 / 7 / 1** | 27 / 15 / 3 |
> | sign test p | **1.00** | 0.09 |
>
> Seven wins and seven losses. And the whole aggregate is ONE window:
>
> | season | gw1-13 | gw7-19 | gw14-26 | gw20-32 | gw27-38 |
> | --- | ---: | ---: | ---: | ---: | ---: |
> | 2022-23 | -0.7 | -11.0 | -21.0 | +10.0 | +31.3 |
> | 2023-24 | +19.0 | -18.7 | +65.3 | **+131.7** | 0.0 |
> | 2024-25 | -2.0 | -38.0 | -23.7 | +10.0 | +19.0 |
>
> Drop 2023-24 gw20-32 and the mean falls from +11.4 to +2.8. That single window
> was replayed at three seeds, so in the per-trajectory view it contributed three
> wins of +119, +131 and +145, which is most of the distance between t 1.06 and
> t 1.51. The registry's own rule says a total carried by one window is not a
> result; this is that rule's textbook case.
>
> ### Decision: REJECT, and this time on the strongest instrument available
>
> Not "inconclusive". The signal has now been measured three times on three
> different trees and has never produced a consistent effect: it wins two windows
> big, loses several small, and splits 7-7 with a sign test of exactly 1.00. The
> mechanism section below explains why, and nothing in it has been disturbed by
> either correction: the signal is retrospective by construction, fires the week
> AFTER a player goes down and clears the week AFTER he returns, and has no
> expected return date.
>
> **What would reopen it, unchanged from the original entry:** a pre-deadline
> source of team news, or an expected return date. Both would let a doubt resolve
> upward before the player has already played. Absent one, this is closed.
>
> Everything below the next heading is the original entry. Its planner points
> tables are void; its join, leakage and prediction sections are not.

## Superseded status note (2026-08-11)

**The REJECTION IS VOID. Every points number in this file was measured on
a replay whose cross-season prior seeding was broken. The signal still ships
disabled, because voiding a rejection is not an acceptance.**

> ## 2026-08-11: what was wrong, and what it was not
>
> **The join described in this file is NOT the broken one.** It matches
> API-Football names to FPL element ids WITHIN one season, and a season-scoped
> element id is the correct key for that. Audited and cleared: each season's
> records are downloaded per season (`?season=<year>`), stored per season
> (`.data/availability/<year>.json`), and joined against that same season's
> dataset only. The five-rung ladder, the club constraint and the ambiguity
> refusal are all sound, and the match rates in the table below still reproduce
> exactly.
>
> **The replay underneath it was broken.** `createAccumulator` seeds every
> player's rates at gameweek 1 from the previous season, and it matched the two
> seasons on the archive's raw `name` string. It dropped 14 of 526 returning
> players entering 2023-24 and 23 of 513 entering 2024-25, discarding 11,366 and
> 19,061 prior-season minutes. That is a minutes experiment measured on a replay
> that had thrown away minutes, which is exactly the wrong place for it.
>
> **Both recorded verdicts are void:** the +5 on nine windows here, and the +620
> on 45 paired trajectories in `transfer-churn.md`. Void because of what produced
> them, not because the replacement numbers are far away; on the stronger
> instrument the replacement is close, and that is worth knowing too.
>
> ### Re-measured on the corrected join
>
> Both arms replayed back to back on a frozen tree, the AFTER arm being the
> BEFORE arm plus only the identity files. Nine chip-free windows:
>
> | tree | availability off | availability on | delta | W-L-T |
> | --- | ---: | ---: | ---: | --- |
> | broken join | 6572 | 6486 | **-86** | 4-5-0 |
> | corrected join | 6412 | 6525 | **+113** | 6-3-0 |
>
> The sign flips. On the instrument this experiment was rejected on, the signal
> goes from losing points to gaining them, and the only thing that changed is
> whether returning players kept their previous season.
>
> 45 paired trajectories, which `registry.md` names as the instrument that
> decides. Both join arms were run, so the fix can be separated from the tree:
>
> | measurement | total | mean | se | t | W / L / T | per season |
> | --- | ---: | ---: | ---: | ---: | --- | --- |
> | corrected join, this tree | +574 | +12.8 | 6.3 | 2.02 | 31 / 14 / 0 | +35, +462, +77 |
> | broken join, same frozen tree | +542 | +12.0 | 7.5 | 1.60 | 30 / 15 / 0 | +35, +186, +321 |
> | recorded 2026-08-10, older tree | +620 | +13.8 | 7.3 | 1.88 | 24 / 18 / 3 | -137, +729, +28 |
>
> **Read the first two rows against each other, not the first and the third.** On
> instrument 3 the identity fix is worth +32 to the availability delta, which is
> nothing. The large differences against the recorded row (the win/loss split, and
> 2022-23 moving from -137 to +35) are NOT this fix: 2022-23 has no prior season
> to join, its replay is bit-identical across both arms, and it still reads +35 on
> the broken-join arm. Those differences belong to the corrected transfer state
> machine and whatever else moved the tree between 2026-08-10 and now.
>
> So the two instruments say different things about the fix itself: instrument 2
> swings by +199 and changes sign, instrument 3 moves by +32 and does not. That
> is a statement about the instruments, and instrument 2 with nine samples
> against roughly 30 points of per-window noise is the one to distrust.
>
> ### This is not an acceptance
>
> The evidence that rejected this experiment is gone, and that is all that has
> been established. It is not re-accepted here, for three reasons, and all three
> are for the owner rather than for the person who fixed the join:
>
> 1. t 2.02 over 45 windows that OVERLAP is not 45 independent samples, so the
>    standard error is optimistic and the registry already says so.
> 2. The mechanism that justified the original rejection is untouched. The signal
>    is still retrospective by construction, still fires the week after a player
>    goes down and stops the week after he returns, and still has no expected
>    return date. The "Why a better model is not more points" section below still
>    stands as written.
> 3. Nothing about the fix makes the signal a better forecast. It made the
>    BASELINE better informed, and a large part of what moved is that a
>    correctly-seeded replay reacts differently, not that the injuries were more
>    useful.
>
> The signal therefore stays behind `FPL_AVAILABILITY=1` and OFF by default until
> someone decides it on its merits.
>
> Everything below this box is the original entry, kept as written. Its planner
> points tables are void; its join, leakage and prediction sections are not.

## Original entry (2026-08-10)

**Status: REJECTED for the planner. The prediction model is kept, the replay signal ships disabled.**

Date: 2026-08-11. Branch `feature/fpl-planner`.

## What the question was

`js/engine/backtest.js` hardcoded `status: 'a'` and `chanceNext: null` for every
historical player, because the FPL per-gameweek archive has no availability
columns. The replay therefore believed an entire league was fit for an entire
season, and no availability work could be measured at all. This experiment
sourced a real historical availability signal, joined it to the archive, wired
it through a leakage rule, and asked the only question that decides anything:
does it win points.

## What changed

### Data (`scripts/fetch-availability.mjs`)

EPL injury and doubt records from API-Football v3 (league 39), one request per
season, three requests total against a 100-per-day free plan. The whole season
comes back in a single unpaginated response. Files land in the gitignored
`.data/availability/<year>.json`; the key is read from `APIFOOTBALL_KEY` and is
never logged, never written and never committed. Seasons are the API's own
numbering, so FPL 2022-23 is API season 2022.

| season | records | type "Missing Fixture" | type "Questionable" |
| --- | --- | --- | --- |
| 2022-23 | 3,056 | | |
| 2023-24 | 3,853 | 3,228 | 625 |
| 2024-25 | 3,168 | | |

### The join (`js/engine/backtest.js`)

> Audited 2026-08-11 and CLEARED. This join is within-season, so keying it on the
> season-scoped element id is correct, and the match rates below still reproduce
> exactly. `normalizeName` now lives in `js/engine/player-identity.js` and is
> re-exported here, so one implementation of accent folding serves both this join
> and the cross-season one; behaviour is unchanged.

The API gives a name on a shirt ("R. Hojlund", "M. Cucurella") and the archive
gives a full legal name ("Rasmus Højlund", "Marc Cucurella Saseta"). The matcher
is a five rung ladder, every rung constrained to the club and every rung
requiring a UNIQUE candidate: exact, initials plus surname anywhere in the name,
full token containment, last-token surname, then a single distinctive
non-particle token. Four club aliases cover the only clubs the two sources spell
differently (Manchester City, Manchester United, Nottingham Forest, Tottenham).
Accents are folded, and so are the letters NFD cannot decompose (ø, æ, ß, ð, þ,
ł, đ), without which "Højlund" becomes "hjlund" and matches nothing.

The asymmetry is deliberate: an unmatched player falls back to being assumed
fit, which is the error the replay already had, while a wrong match invents an
injury for a fit player and makes the planner sell him. Ambiguity is never
resolved by guessing.

| season | records matched | distinct names matched | ambiguous |
| --- | --- | --- | --- |
| 2022-23 | 2,890 / 3,056 (94.6%) | 376 / 385 (97.7%) | 0 |
| 2023-24 | 3,814 / 3,853 (99.0%) | 422 / 432 (97.7%) | 0 |
| 2024-25 | 3,102 / 3,168 (97.9%) | 404 / 410 (98.5%) | 1 |

Unmatched names fall into three groups, all of them safe:

- Not in the FPL game at all, so there is nothing to match: B. Mendy, M.
  Greenwood, J. Steer, N. Opoku, J. Donacien, V. Kompany (a manager).
- A shirt nickname the legal name never contains: Casemiro (archive "Carlos
  Henrique Casimiro"), Jonny ("Jonathan Castro Otto"), Rodri ("Rodrigo
  Hernandez"), Jorginho ("Jorge Luiz Frello Filho"), Beto, Vitinho, Chiquinho,
  L. Paqueta.
- Genuinely ambiguous inside one club: "Gabriel" at Arsenal, where three players
  answer to it.

### The leakage rule

> A record may inform gameweek N only if its fixture kicked off strictly before
> the gameweek N deadline.

`fixture.date` is a KICKOFF, which is after the deadline the planner decides at,
so a record from gameweek N used in gameweek N is the team sheet rather than a
forecast. Because the replay's boundary for gameweek N is the earliest kickoff
in gameweek N, the rule reduces to "only earlier gameweeks count". It is
enforced in `buildAvailabilityIndex` and pinned by
`tests/availability.test.mjs`, where the test walks a ten gameweek spell and
asserts both that the newest record read is before the boundary AND that the
observed spell length is exactly `gw - 4`. Admitting the current gameweek would
make the run one longer and fail the test.

**What the model can therefore know:** that a player was listed as unavailable
for his club's last match AND recorded no minutes in it, plus how many matches
that has now run for, plus how such spells have ended so far this season.

**What it cannot know:** this week's team news, a press conference, a return to
training, or an expected return date. A returning player is invisible until the
return has already happened, so the model is late by construction on every
comeback. That is the price of not leaking.

Turning a spell into a number is done ONLINE. The continuation rate applied at
gameweek N is measured only from spells whose outcome was already observable
before the gameweek N boundary, blended with a documented prior (weight 25
spells, prior 0.72 for "Missing Fixture" and 0.45 for "Questionable"). Buckets
are type by run length (1, 2, 3-4, 5+) by role, where role is the player's own
start rate so far. The role split is not a knob, it is a correction: pooled, a
listed player plays 10% of the time, but split out, a first choice player listed
for one match plays the next one 37-40% of the time against 11-15% for a fringe
player, and pooling punishes exactly the players a manager most wants to keep.

### The minutes framework (`js/engine/minutes.js`)

`projectMinutes` now returns the three outcome decomposition explicitly:
`pStart`, `pBench`, `pNone` summing to one, with `xMinsIfStart` and
`xMinsIfBench` as the conditional expectations and `xMins` as their mixture.
The existing exports and every existing assertion are unchanged.

The one behavioural change is availability over a horizon. `chance_of_playing_next_round`
is, by its name, about the NEXT round; carrying it flat across a three gameweek
horizon asserts that an injury never heals. Measured across all three seasons,
the doubt attached to a player who missed his club's last match decays by a
factor of 0.92 per gameweek:

| offset | 2022-23 | 2023-24 | 2024-25 |
| --- | --- | --- | --- |
| play rate, same gameweek | 0.095 | 0.097 | 0.107 |
| remaining doubt, 1 gameweek out | 0.916 | 0.927 | 0.918 |
| remaining doubt, 2 gameweeks out | 0.855 | 0.860 | 0.856 |

0.92 squared is 0.846 against an observed 0.855 to 0.860, so a geometric decay
fits. The gameweek being decided is never relaxed, and the doubt never clears
entirely. Applying the framework with no availability signal reproduces the
baseline season points EXACTLY (2151 / 1817 / 2371), which is the proof that the
refactor changed nothing on its own.

## Prediction metrics

Every row is out of sample: the only fitted parameters are the online
continuation rates, which see strictly earlier gameweeks. Scored over every
player-gameweek with a real fixture (24,957 + 28,742 + 26,919 = 80,618 rows).

| season | log loss | Brier | xMins MAE | ECE |
| --- | --- | --- | --- | --- |
| 2022-23 base | 0.5745 | 0.1588 | 27.70 | 0.0877 |
| 2022-23 with availability | **0.5617** | **0.1534** | **25.77** | 0.0881 |
| 2023-24 base | 0.4519 | 0.1461 | 26.97 | 0.0898 |
| 2023-24 with availability | **0.4116** | **0.1309** | **24.41** | **0.0555** |
| 2024-25 base | 0.4490 | 0.1446 | 25.85 | 0.0795 |
| 2024-25 with availability | **0.4164** | **0.1322** | **23.80** | **0.0547** |

Pooled calibration of P(start), all three seasons:

| bin | n base | pred | observed | n arm | pred | observed |
| --- | --- | --- | --- | --- | --- | --- |
| 0.0-0.1 | 19495 | 0.049 | 0.060 | 23976 | 0.045 | 0.055 |
| 0.1-0.2 | 18514 | 0.146 | 0.103 | 18766 | 0.145 | 0.107 |
| 0.2-0.3 | 8516 | 0.247 | 0.247 | 7977 | 0.246 | 0.271 |
| 0.3-0.4 | 7428 | 0.351 | 0.313 | 6367 | 0.350 | 0.369 |
| 0.4-0.5 | 6878 | 0.449 | 0.333 | 5763 | 0.450 | 0.389 |
| 0.5-0.6 | 5951 | 0.550 | 0.381 | 5190 | 0.549 | 0.423 |
| 0.6-0.7 | 5054 | 0.653 | 0.521 | 4294 | 0.653 | 0.595 |
| 0.7-0.8 | 5284 | 0.748 | 0.689 | 4873 | 0.748 | 0.730 |
| 0.8-0.9 | 3042 | 0.841 | 0.883 | 2956 | 0.842 | 0.896 |
| 0.9-1.0 | 456 | 0.927 | 0.941 | 456 | 0.927 | 0.941 |
| **ECE** | | | **0.0523** | | | **0.0344** |

The model is over-confident in the 0.4 to 0.7 range both before and after, and
the availability signal closes about a third of that gap. Every mid-range bin
moves toward its observed rate and none moves away.

## Planner points, the deciding metric

> **VOID.** Every number in this section was produced by a replay whose
> cross-season prior seeding dropped 14 to 23 returning players per season. See
> the box at the top of this file for the re-measurement.

Horizon 3, seed 1, gameweeks 1 to 38. Measured against a frozen copy of the app
tree taken at commit `aadee48` before any edit, so the ONLY difference between
the columns is the files this experiment owns. The baseline column reproduces
the previously recorded numbers exactly. (The seed is inert here: seeds 1, 2 and
3 all give 2371 on the 2024-25 baseline.)

| season | baseline | availability only | availability + framework | greedy-xp base | greedy-xp arm | hold base | hold arm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2022-23 | 2151 | 2184 (+33) | 2184 (+33) | 2066 | 2021 | 1627 | 1617 |
| 2023-24 | 1817 | 1938 (+121) | 2093 (+276) | 1778 | 1899 | 1910 | 1937 |
| 2024-25 | 2371 | 2285 (-86) | 2080 (-291) | 2284 | 2062 | 2006 | 2024 |
| **total** | **6339** | **6407 (+68)** | **6357 (+18)** | 6128 | 5982 | 5543 | 5578 |

A gain in aggregate that comes with a 291 point collapse in one season is a
rejection by the rule this project already set for itself.

The season totals are also close to unusable as evidence, and that matters more
than the sign. A single replay is one deterministic trajectory: the arm moved
2024-25's second wildcard from gameweek 30 to gameweek 22 and its free hit from
34 to 30, and the whole second half diverges from there (-211 points after
gameweek 19). To get samples that one forked chip cannot decide, the same
comparison was run over nine independent windows with chips disabled:

| window | baseline | availability only | availability + framework |
| --- | --- | --- | --- |
| 2022-23 gw1-13 | 529 | 509 | 509 |
| 2022-23 gw14-26 | 767 | 767 | 767 |
| 2022-23 gw27-38 | 789 | 778 | 778 |
| 2023-24 gw1-13 | 687 | 674 | 674 |
| 2023-24 gw14-26 | 613 | 704 | 704 |
| 2023-24 gw27-38 | 696 | 718 | 719 |
| 2024-25 gw1-13 | 739 | 714 | 766 |
| 2024-25 gw14-26 | 871 | 755 | 793 |
| 2024-25 gw27-38 | 633 | 619 | 619 |
| **total** | **6324** | **6238** | **6329** |

Over nine windows the full arm is +5 points, or 0.08%, with three wins, five
losses and one tie. That is a wash. The framework is worth +91 over the raw
availability signal, so the role conditioning and the horizon recovery earn
their place, but they earn it by cancelling out damage rather than by adding
points.

## Why a better model is not more points

The `hold` column is the tell. Hold makes no transfers, so it isolates the
lineup and captaincy effect of better minutes: 1627 to 1617, 1910 to 1937, 2006
to 2024, a total of +35. Positive, small, consistent. Everything larger than
that in the planner column comes from the transfer engine reacting.

The reaction is bad in a specific and understandable way. The signal is
retrospective by construction, so it fires the week AFTER a player goes down and
keeps firing until the week AFTER he returns. A three gameweek horizon then
values him at almost nothing, the optimizer sells him, and when he comes back
the planner has to buy him again at full price having eaten the spread twice.
That round trip is exactly the knee-jerk transfer human managers are warned
about, and the model has no expected return date to protect it, because the data
that would supply one is post-deadline news.

## Decision

**REJECT.** The replay signal ships behind `FPL_AVAILABILITY=1` and is OFF by
default. With it off, the change is bit-for-bit identical to the previous
behaviour, verified on two seasons against the current tree.

Kept, because it is correct and now testable:

- the blocking bug is fixed: the replay can carry a real availability signal
  instead of asserting everyone is fit, and defaults to the old behaviour when
  no dataset is supplied
- the join, the leakage rule and the online estimator, all under test
- the three outcome decomposition in `minutes.js`
- the horizon recovery of a doubt, which is measured rather than assumed and is
  provably a no-op wherever no doubt exists

Not shipped:

- the availability signal as a default input to the replay

What would change the verdict: an expected return date, or any pre-deadline
source of team news. Both would let a doubt resolve upward before the player has
already played, which is the single thing this signal cannot do. Failing that, a
transfer engine that prices the cost of selling and re-buying the same player
would stop the churn that ate the gain.

## Reproducing

```
export APIFOOTBALL_KEY="$(netlify env:get APIFOOTBALL_KEY)"
node apps/fpl-planner/scripts/fetch-availability.mjs
node apps/fpl-planner/scripts/fetch-availability.mjs --report

node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
FPL_AVAILABILITY=1 node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
```

Note on the data: the 2022-23 archive's `starts` column is only partly
populated (313 starts across a 1,560 row sample against 505 for 2023-24 on 1,749
rows), so start rates in that season are understated for every arm equally, and
the role split has very few first choice players to work with there.
