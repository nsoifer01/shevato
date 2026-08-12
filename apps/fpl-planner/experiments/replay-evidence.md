# The evidence the replay hands the model, and three ways it was wrong

**Status: SHIPPED, as corrections. None is a modelling change and none was
adopted because it scored better. All three are cases of the replay telling the
model something untrue about what it knew.**

Date: 2026-08-12. Files: `js/engine/backtest.js`, `js/engine/minutes.js`, new
`tests/replay-evidence.test.mjs`.

The first two move the deciding instrument by **+1253 points over 45 paired
trajectories**, which is larger than every effect this project has ever measured,
accepted or rejected. Every planner number published before this date was
produced by an instrument that could not represent expected minutes for roughly
half of every season it replayed.

---

## Defect 1: the starts column does not exist for the first fifteen gameweeks of 2022-23

FPL added `starts` to its per-gameweek payload part way through that season and
the public archive faithfully reproduces the gap. Summed over each archive:

| season | sum(starts) | 11 x 2 x 380 | rows with minutes >= 60 |
| --- | ---: | ---: | ---: |
| 2022-23 | 5,368 | 8,360 | 7,842 |
| 2023-24 | 8,360 | 8,360 | 7,852 |
| 2024-25 | 8,360 | 8,360 | 7,820 |
| 2025-26 | 8,362 | 8,360 | 7,815 |

Three seasons match the arithmetic of football exactly. 2022-23 is 36% short,
and not at random: the column is **exactly zero for gameweeks 1 to 15** and
correct from 16 on. (Gameweek 7 is absent from that season's archive altogether.
That is real: the round was postponed after the death of Queen Elizabeth II and
its fixtures were rescheduled. The replay treats it as a blank for all twenty
clubs, which is what it was.)

### Why a missing column is a model inversion

`minutes.js` reads a player's start rate as `starts / matches`. With starts at
zero it concludes nobody in the league ever starts, infers that every minute
played must have been a substitute minute, and returns pStart 0 with pAppear
near 1: a whole division of substitutes who play about 68 minutes each. The
60-minute appearance point and clean sheets fall out with it. 2022-23's replay
under-projected by 16 points a gameweek.

Two of the nine chip-free windows and six of the 45 paired trajectories sit
inside that stretch.

### The reconstruction, and how it was checked

Exactly eleven players start a fixture for a club, and a starter usually outlasts
a substitute, so the eleven with the most minutes in a club's fixture are taken
as its starting eleven. That is a claim about football, so it was measured
against the two seasons that carry the truth:

| season | rows correct | false starts | missed starts | team-fixtures with any error |
| --- | ---: | ---: | ---: | ---: |
| 2023-24 | 98.66% | 199 | 199 | 176 / 760 |
| 2024-25 | 98.64% | 188 | 188 | 170 / 760 |

The errors always come in pairs inside one team-fixture: a starter withdrawn
early swapped with a substitute brought on early. The COUNT is exact by
construction, so aggregate and position-level start rates carry no error at all,
and an individual player's rate is wrong by at most a match or two a season.

A variant that forced every player over 60 minutes to be a starter and then
filled up to eleven scored identically (98.66% / 98.64%), so the simpler rule
ships. A plain "60 minutes or more" rule scores worse (98.04% / 97.76%) and, more
importantly, gets the count wrong.

Reconstruction runs ONLY where the column is absent, detected per gameweek: a
gameweek with minutes on the board and no starts anywhere cannot have happened.
Real data is never overwritten, and `dataset.startsReconstructed` names the
gameweeks so a report can state it.

---

## Defect 2: the previous season was seeded into the numerator and not the denominator

The replay seeds each player's totals at gameweek 1 from the season before, at
half weight, because that is the state FPL itself puts a manager in every August.
Those totals are a NUMERATOR. `minutes.js` divided them by the matches THIS
season had played, because on a live payload that is the only kind of match there
is: FPL resets every element's totals in August, so `starts` and `minutes` always
describe the current season.

Seeding half a season into the numerator and none of it into the denominator
inflates a returning player's start rate by about 19 matches. Measured on
2024-25, over the 260 most-owned players, which is the pool the replay actually
projects:

| gameweek | players reading starts/matches >= 1 | median pStart | 90th pct pStart |
| ---: | ---: | ---: | ---: |
| 3 | 89% | 1.000 | 1.000 |
| 5 | 82% | 1.000 | 1.000 |
| 10 | 71% | 1.000 | 1.000 |
| 20 | 57% | 0.916 | 0.945 |
| 38 | 40% | 0.835 | 0.936 |

Every position prior was pinned at 1.000 as well, because the priors are measured
from the same players with the same denominator. For the first half of every
seeded season the replay could not distinguish a nailed starter from a rotation
risk. Expected minutes multiply every other component of a projection, so this is
not a corner case: it is the single most decision-relevant quantity the engine
has, held at a constant.

The same defect ran the other way at gameweek 1, where the pre-season denominator
is a full 38 matches but the numerator carried only half of the prior season, so
every returning player's start rate was understated by exactly two.

### The fix

Whoever builds the numerator owns the denominator. `appearances` already counts
one per archive row, and the archive writes a row per registered player per
fixture, so it is exactly the number of matches the evidence covers: 19 for a
full prior season at half weight, less for a January arrival, two for a double
gameweek. `gameStateAt` publishes it as `evidenceMatches` and `minutes.js`
divides by it, in the start rate, its shrinkage weight, the inferred substitute
appearances and the bench-match denominator.

**A live payload has no such field and the model falls back to counting this
season's matches, so production behaviour is unchanged.** A test asserts that: a
payload declaring `evidenceMatches` equal to the team match count reproduces a
payload that declares nothing, player for player, on pStart and xMins.

After the fix, the same measurement:

| gameweek | median pStart | 90th pct pStart | position priors |
| ---: | ---: | ---: | --- |
| 1 | 0.605 | 0.822 | 0.39 to 0.56 |
| 3 | 0.574 | 0.823 | 0.36 to 0.56 |
| 10 | 0.609 | 0.836 | 0.35 to 0.54 |
| 38 | 0.610 | 0.857 | 0.31 to 0.45 |

Stable across the season, and discriminating: a nailed starter and a rotation
player no longer read the same.

---

## What it moved

45 paired trajectories, the same 45 cells before and after, both arms run by
`scripts/experiment.mjs` with the tree fingerprinted on each side
(`935929c13465` before, `7fc4ed764421` after):

| season | before | after | delta | W-L-T |
| --- | ---: | ---: | ---: | --- |
| 2022-23 | 10,851 | 10,872 | +21 | 6-9-0 |
| 2023-24 | 9,727 | 10,471 | **+744** | 13-2-0 |
| 2024-25 | 10,882 | 11,370 | **+488** | 11-4-0 |
| total | 31,460 | 32,713 | **+1253** | 30-15-0 |

The two seeded seasons move by hundreds; 2022-23, which has no downloaded
predecessor and therefore never had the second defect, barely moves at all. That
split is the control: it is what says the gain is the denominator fix rather than
something else that changed on the tree.

Full seasons with chips, same before and after:

| strategy | 2022-23 | 2023-24 | 2024-25 | total |
| --- | ---: | ---: | ---: | ---: |
| planner, before | 2114 | 1946 | 2276 | 6336 |
| planner, after | **2247** | **2229** | **2328** | **6804** |
| greedy-xp, before | 1946 | 2093 | 2122 | 6161 |
| greedy-xp, after | 2076 | 2219 | 2253 | 6548 |
| hold, before | 1520 | 1714 | 1525 | 4759 |
| hold, after | 1512 | 2129 | 1893 | 5534 |

`hold` never makes a transfer, so its +775 is pure squad selection and lineup:
the opening fifteen is better because the minutes it was picked on are real.

## What it cost, and the open question it leaves

Projection bias moved with it, and not in a flattering direction:

| season | before | after | after, auto-subs off the actual side |
| --- | ---: | ---: | ---: |
| 2022-23 | -16.2 | -19.1 | -14.6 |
| 2023-24 | +3.2 | -7.9 | -3.9 |
| 2024-25 | -1.5 | -8.5 | -7.0 |

Positive means the model overprojected. (The "after" columns are at horizon 3,
the default when this was measured; at the horizon 5 default that registry entry
9 then chose, the like-for-like column reads -14.6 / -3.9 / -8.2.)

The old near-zero bias in the seeded seasons was two errors cancelling: pStart
pinned at 1 inflated every projection, and something else deflates it. With the
minutes honest, the engine now **under-projects**, and that is a real open
question rather than a side effect.

Chased on the same day, and the answer is precise. Over 9,727 projected
player-gameweeks of 2024-25, leakage-free: among players who actually started,
the model predicts **3.825** points per 90 against an observed **3.823**. The
points-given-minutes model is not implicated at all. pStart is predicted 0.532
against an observed 0.565, and xMins 48.5 against 50.5, in every decile from the
second up. The mechanism is the shrinkage TARGET: `baseStart` is pulled toward
the position's league-wide start rate, measured over every player with a minute
to his name, while the pool the planner projects is the 260 most-owned, whose
true start rate is well above that. See FINDINGS, "Minutes and projections",
for the candidate fix and why it is not shipped on prediction metrics alone.

It also fires the re-test condition registry entry 1 wrote for itself: the
horizon default of 3 was justified by projection bias, and the bias has
materially changed. See registry entry 9.

## Reproducing

```sh
node apps/fpl-planner/scripts/experiment.mjs \
  --config apps/fpl-planner/experiments/configs/baseline.mjs --instrument paired
node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
node --test apps/fpl-planner/tests/replay-evidence.test.mjs
```

---

## Defect 3, found the same day by checking the arithmetic instead of the code

The two defects above were found by asking what the replay believed. The third
was found by asking whether the ACTUALS were right: every played row's
`total_points` was rebuilt from its own component columns under the scoring
table `rules.js` derives.

| season | played rows | rebuild exactly |
| --- | ---: | ---: |
| 2022-23 | 11,345 | 100.00% |
| 2023-24 | 11,384 | 100.00% |
| 2024-25 | 11,566 | 100.00% |
| 2025-26 | 11,498 | 87.68%, every gap exactly -2 |

Three seasons at 100.00% is a strong result on its own: it eliminates the
scoring table as a source of any projected-versus-actual gap, and it verifies
the two constants `rules.js` hardcodes because the API does not publish them.

The 2025-26 gap was the reconstruction's own blind spot, and chasing it found
the defect. **That season's archive carries `clearances_blocks_interceptions`,
`recoveries`, `tackles` and `defensive_contribution`**; the earlier ones do not,
because the rule did not exist. `gameStateAt` was hardcoding all four to zero,
under a comment that said the archive carried no such columns, which was true
when it was written and stopped being true when the season turned over.

Nothing in the current experiments touches it: 2025-26 is not in the replayed
set, and the three that are have no such columns, so they replay bit-identical
(2209 / 2208 / 2453 before and after). It is fixed because it is a trap with a
short fuse: the season is already downloaded, adding it to `KNOWN_SEASONS` is a
one-line change anybody would make, and the replay would then project zero
defensive contribution against actuals that contain it on about one played row
in eight, under-rating exactly the defender-and-holding-midfielder archetype the
rule was introduced to reward.

Adding the defensive-contribution term to the reconstruction takes 2025-26 to
100.00% as well, which incidentally verifies the DEF 10 and MID/FWD 12 action
thresholds against 11,498 real awards.

**`scripts/validate-history.mjs` is that check, kept.** It runs the starts
arithmetic, the points reconstruction, the schema, the coverage, the duplicate
classification and the identity-table presence over every downloaded season, and
would have caught all three of this file's defects in seconds.
