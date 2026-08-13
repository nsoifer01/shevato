# FPL Planner regression leaderboard

Season points scored by the planner in a full historical replay, one row per
engine version. Every row is `node apps/fpl-planner/scripts/backtest.mjs
--season <season>` over all 38 gameweeks at the shipped default horizon of 3,
seed 1, balanced risk, analytic projections, previous season seeded where one
exists.

`vs greedy` and `vs hold` are against the baselines replayed in the SAME run, so
they move with the engine and are never carried forward from an older row. A row
whose baselines were not replayed beside it does not belong here.

Read the per-season columns before the total. A row that gains in aggregate
while losing a season is not an improvement, it is a bet, and the note column
says so.

## 2026-08-12, later: the instrument is now FOUR seasons and the totals below are three-season numbers

2025-26 qualified as a replay season (registry entry 15) after the evidence
corrections of entries 11 and 14 and a load-time dedupe of its ten duplicated
archive rows. Current four-season chips-on baseline, each season under its own
historical rules, at the shipped horizon 5:

| strategy | 2022-23 | 2023-24 | 2024-25 | 2025-26 | total |
|----------|--------:|--------:|--------:|--------:|------:|
| planner  |    2239 |    2283 |    2453 |    2040 |  9015 |

Deciding instrument (paired, chips off, 20 windows / 60 trajectories): planner
control **44,181** (11,138 / 11,134 / 11,779 / 10,130). 2025-26's lower level
is the season itself, not the engine: within it the planner beats greedy by 79
and hold by 519, normal margins, and its like-for-like projection bias (+2.1 a
gameweek) is the best-calibrated of the four seasons.

Every three-season total below this line predates entries 11, 14 and 15 in
some combination; compare nothing against them without re-measuring.

## 2026-08-12: every row below was measured with a degenerate minutes model

Superseding everything under it. The replay's start-rate numerator carried half
of the previous season while its denominator counted only the current one, so
pStart came out at 1.000 for 89% of the owned pool at gameweek 3 and for a
majority of it through gameweek 20. Separately, the 2022-23 archive has no
`starts` column at all before gameweek 16, which inverted that stretch into a
league of substitutes. Expected minutes multiply every other component of a
projection. See `experiments/replay-evidence.md`.

**Current, measured 2026-08-12 on the corrected evidence at the shipped default
horizon, which is now 5 (registry entry 9):**

| strategy  | 2022-23 | 2023-24 | 2024-25 |  total |
|-----------|--------:|--------:|--------:|-------:|
| planner   |    2209 |    2208 |    2453 |   6870 |
| greedy-xp |    2076 |    2219 |    2253 |   6548 |
| hold      |    1453 |    2107 |    2112 |   5672 |
| fdr       |    1255 |    1010 |    1282 |   3547 |

The same tree at the old default of 3 read planner 2247 / 2229 / 2328 = 6804,
and the same cells before the evidence fix read 6336. On 45 paired trajectories
the evidence fix is worth **+1253** (30W-15L), concentrated in the two seasons
that have a previous season to seed: +744 in 2023-24, +488 in 2024-25, +21 in
2022-23, which has none and is the control. The horizon change is worth a
further **+971** on the same instrument (+21.6 a window, t 2.32, 11-4-0).

Deciding instrument, current arm, 45 paired trajectories: **33,684**
(10,888 / 11,017 / 11,779).

**The planner's edge over greedy-xp is +133 / -11 / +200 by season, total
+322.** It loses 2023-24 by eleven points. The pattern worth remembering is that
this margin is the quantity most sensitive to instrument defects, and it has
moved with every correction: +136 / -52 / -44, then +184 / -2 / -49, then
+171 / +10 / +75, now +133 / -11 / +200.

## Every row below was measured with a broken cross-season join

Superseding, not replacing, the transfer-model note under it. Both are true, and
a row can be wrong for both reasons.

The replay seeds every player's rates at gameweek 1 from the season before, and
it matched the two seasons on the archive's raw `name` string. The archive
respells returning players freely: accents get restored, a maternal surname
appears, a nickname expands, a Japanese name flips order. So the join silently
dropped 14 of 526 returning players going into 2023-24 and 23 of 513 going into
2024-25, discarding 11,366 and 19,061 prior-season minutes respectively. Rodri,
Tomiyasu, Mitoma, Coufal and Joe Gomez all began a season looking to the planner
like men who had never played, and at gameweek 1 the previous season is the only
input there is.

It never matched the WRONG player, so nothing below is corrupt in the way an
`element` join would have made it. It is understated in a specific direction and
by a different amount in each season, which is worse than useless for comparing
two rows measured either side of the fix.

`code` is now the canonical identity and the join resolves 100% of returning
players. See `experiments/cross-season-identity.md`.

**Corrected baselines, measured 2026-08-11 on a frozen tree** (the AFTER arm is
the BEFORE arm plus only the identity files, because other work was editing
`lineup.js`, `squad-builder.js` and `counterfactual.js` at the same time):

| strategy  | 2022-23 | 2023-24 | 2024-25 |  total |
|-----------|--------:|--------:|--------:|-------:|
| planner   |    2152 |    2048 |    2234 |   6434 |
| greedy-xp |    1968 |    2050 |    2283 |   6301 |
| hold      |    1605 |    1677 |    1606 |   4888 |
| fdr       |    1497 |     713 |    1217 |   3427 |

The same tree with the broken join, replayed beside it, so the two are
comparable:

| strategy  | 2022-23 | 2023-24 | 2024-25 |  total |
|-----------|--------:|--------:|--------:|-------:|
| planner   |    2152 |    2028 |    2054 |   6234 |
| greedy-xp |    1968 |    1983 |    2099 |   6050 |
| hold      |    1605 |    1592 |    1771 |   4968 |
| fdr       |    1497 |     712 |    1205 |   3414 |

2022-23 is bit-identical in every strategy because 2021-22 is not downloaded, so
that season has no prior to join. It is the control that says the fix moved the
cross-season seeding and nothing else.

Nine chip-free windows on the same two trees: **6412 corrected, 6572 broken.**
The two instruments disagree in sign, +200 on full seasons and -160 on nine
windows. Neither is an engine change. Both are the same engine measured on data
that was previously incomplete.

The planner's edge over greedy-xp on the corrected join is +184 / -2 / -49 by
season, total +133.

## Every row above the 2026-08-11 line was measured with a broken transfer model

The engine carried ONE FREE TRANSFER TOO MANY in every gameweek of every replay,
in every season, for every strategy that transfers. The replay seeded the
opening squad with a free transfer already earned and then added the weekly one
on top, so a manager who never transferred was modelled with 2 free transfers
going into gameweek 2, 3 into gameweek 3, 4 into gameweek 4 and 5 into gameweek
5, against a true 1, 2, 3 and 4. That is not a display defect: free transfers
enter the optimizer's objective directly, through the hit cost a candidate is
charged and through the value of what it banks, so every transfer decision in
the archive was taken under the wrong constraint.

Every number above the line is therefore a measurement of a game that is not
Fantasy Premier League. They are kept only so the corrected rows can be read
against something. Do not quote them.

| version | 2022-23 | 2023-24 | 2024-25 | total | vs greedy | vs hold | note |
|---------|--------:|--------:|--------:|------:|----------:|--------:|------|
| **shipped: corrected replay evidence, horizon 5** | **2209** | **2208** | **2453** | **6870** | **+322** | **+1198** | current engine, 2026-08-12. Registry entries 7 and 9. |
| corrected replay evidence, horizon 3 | 2247 | 2229 | 2328 | 6804 | +256 | +1270 | the same tree at the previous default. Chips-on prefers it in two seasons of three; the deciding instrument prefers horizon 5 by 21.6 points a window. |
| degenerate minutes model, horizon 3 | 2114 | 1946 | 2276 | 6336 | +175 | +1577 | the same tree without the two evidence fixes, replayed beside them. |
| canonical cross-season identity, horizon 3 | 2152 | 2048 | 2234 | 6434 | +133 | +1546 | superseded, and measured on a tree that has since moved as well. Do not compare against the rows above. |
| broken cross-season join, horizon 3 | 2152 | 2028 | 2054 | 6234 | +184 | +1266 | the same tree with the prior season matched on the raw name string. Not the row below: this one was measured on a frozen tree beside the fix. |
| broken transfer model AND broken join: corrected transfer state machine, horizon 3 | 2131 | 1898 | 2087 | 6116 | +40 | +1148 | superseded. Measured before the identity fix and on a tree since moved by other work. |
| broken transfer model: shrinkage + zero-minutes, horizon 3 | 2121 | 1893 | 2093 | 6107 | +64 | +1139 | the tree immediately before the transfer fix. One free transfer too many in every gameweek. |
| broken transfer model: flat wildcard bar, horizon 3 | 2151 | 1817 | 2371 | 6339 | +211 | +796 | also predates registry entry 4 (shrinkage), so it is two engine changes out of date as well. |
| broken transfer model: wildcard information maturity premium (z=1) | 2065 | 1817 | 2124 | 6006 | -269 | +463 | rejected. Registry entry 3. |

Baselines beside the superseded row, replayed in the same runs. The current
baselines are in the corrected table at the top of this file:

| strategy  | 2022-23 | 2023-24 | 2024-25 |  total |
|-----------|--------:|--------:|--------:|-------:|
| planner   |    2131 |    1898 |    2087 |   6116 |
| greedy-xp |    1995 |    1950 |    2131 |   6076 |
| hold      |    1605 |    1592 |    1771 |   4968 |

Nine chip-free windows (the deciding instrument, see registry Methodology):

| version | total | W-L-T vs the row below |
|---------|------:|------------------------|
| **shipped: canonical cross-season identity, horizon 3** | **6412** | 3-6-0 |
| broken cross-season join, horizon 3 | 6572 | measured on the same frozen tree |
| broken transfer model, horizon 3 | 6402 | two fixes out of date |

## Regressions worth remembering

- **The planner's edge over greedy-xp is thin and season-dependent**, and every
  correction has moved it: +136 / -52 / -44 under the broken transfer model,
  +184 / -2 / -49 on the corrected join, and +171 / +10 / +75 on the corrected
  minutes evidence. It is positive in all three seasons for the first time, by
  10 points in one of them. The pattern to remember is that this margin is the
  quantity most sensitive to instrument defects, so a change to it is the first
  thing to distrust.
- **The replay takes almost no hits** (0, 0 and 0 across the three seasons at
  the shipped horizon, 1 before the evidence fix). Real managers take several a
  season. The engine under-projects by about 7 points a gameweek, so every
  4-point hit is compared against an understated gain; see FINDINGS, "Minutes
  and projections".
- **The two instruments disagree about the identity fix.** Full seasons say +200,
  nine chip-free windows say -160. That is not a contradiction to resolve, it is
  the per-window noise the Methodology section already warns about, and it is the
  reason no verdict was drawn from either.
- **`hold` is bit-identical before and after the transfer fix** (1605 / 1592 /
  1771). It never transfers, so it cannot be touched by the allowance, and that
  it did not move is the check that says the fix changed transfer decisions and
  nothing else.
- **2023-24 is no longer the season the planner loses to doing nothing.** It
  scores 1898 against hold's 1592. The old 1817-against-1910 pairing predates
  registry entry 4 as well as this fix.
- **2024-25 punishes patience.** Its gameweek 2 wildcard was worth +98 in the
  corrected replay. Anything that delays the first wildcard gives most of that
  back.
- **Both baselines share `chips.js`**, so a chip change lifts or sinks all three
  strategies, and a change that helps greedy more than the planner shows up as a
  regression in `vs greedy` even when the planner's own points went up.
