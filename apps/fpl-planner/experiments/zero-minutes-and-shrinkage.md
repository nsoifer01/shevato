# Zero-minute start probability, together with per-90 shrinkage

**Date:** 2026-08-11
**Decision: REJECT on planner points. NOT reverted, pending an owner call on
output quality.** See section 12: the code is sitting uncommitted in the working
tree because the case for shipping it is a product judgement, not a modelling
one, and it is not mine to make.

This is the "worth testing instead" of `projection-shrinkage.md` section 11,
tested the way that file said it should be: not as a replacement for the
shrinkage but TOGETHER with it, because the diagnosis was that the two defects
were masking each other.

That diagnosis is confirmed. Neither fix is worth anything on its own. The pair
is worth +78 points over the nine chip-free windows, which is the protocol this
project treats as deciding, and it is worth a 19.92 point projection for a
2-minute substitute becoming 3.91. It also loses 278 points in one season of the
shipped full-season replay, and that is what fails it.

---

## 1. The hypothesis, restated

`projection-shrinkage.md` section 4 found one place its shrinkage made
predictions WORSE: the 0-90 minute bucket, whose mean error rose from 0.896 to
0.966. It diagnosed why and did not act on it:

> That residual is a MINUTES problem, not a rates problem: a zero-minute player
> at a high price gets a start probability of up to 0.78 from the price
> percentile in `minutes.js`, and no rate prior can correct that.

So the two defects hide each other. Shrinking a zero-minute player's rates gives
him the league average, which is a plausible number, and the minutes model then
multiplies it by a start probability that is far too high, producing a confident
projection for a player about whom nothing is known. Fixing the rates alone
raises an already overprojected group. Fixing the minutes alone leaves the money
free to move to the 1-to-89 minute players, whose rates are still cameo
extrapolations. Section 6 measures both halves of that sentence and both are
true.

## 2. What was measured, and on which tree

Everything below was run on a frozen copy of `apps/fpl-planner` taken at
2026-08-11 12:11 local, with `.data` symlinked to the real archive. `js/engine/
transfers.js` was `751f470e` in that copy. Another agent changed it to
`2ad5295f` while these runs were in flight, so the frozen copy is the reason
every column here is comparable: the ONLY files that differ between the four
arms are `js/engine/projections.js` and `js/engine/minutes.js`, verified by
checksum on all eighteen engine files before each run.

The four arms:

| arm | `projections.js` | `minutes.js` |
|-----|------------------|--------------|
| base        | shipped | shipped |
| shrink only | empirical-Bayes rates | shipped |
| minutes only | shipped | zero-minute decay |
| both        | empirical-Bayes rates | zero-minute decay |

The base arm reproduces every recorded baseline exactly: 2151 / 1817 / 2371 on
the full-season replay, 6324 across the nine chip-free windows, and the
28,609-row prediction table of `projection-shrinkage.md` section 4 to three
decimals in every cell. The shrink-only arm reproduces that experiment's arm
exactly too, including its wildcard gameweeks (6/20, 2/27, 2/29) and its 6304
across the windows, which is the check that the shrinkage was restored as
derived rather than re-invented.

## 3. The shrinkage, restored unchanged

Restored at the DERIVED k, k x 1.0, exactly as `projection-shrinkage.md` section
3 measured it. Nothing was re-derived and nothing was swept.

```
shrunk = (own total + prior rate * k) / (own nineties + k)
```

The prior is the position's minutes-weighted league rate, re-fitted from the
payload every time, in `positionRatePriors`. The k table is transcribed into
`PRIOR_NINETIES` in `js/engine/projections.js` with `PRIOR_NINETIES_MAX` = 200
as both cap and default, so a goalkeeper's expected goals (measured k = 1122)
and every rate whose between-player variance came out at or below zero (all red
cards, penalty saves, a forward's yellows) are the prior in all but name.

`shrinkRates` is a separate exported function rather than a change to
`underlyingRates`, so the raw per-90 division and the posterior stay separately
readable and separately testable, and so the leakage tests that call
`underlyingRates` bare keep testing what they were written to test.

## 4. The zero-minute defect, measured before it was touched

Every player-gameweek in the 260-most-owned pool, all three seasons, one
gameweek ahead, restricted to players with EXACTLY zero accumulated minutes at
the moment of the projection. 2138 rows.

| group | n | predicted pStart | observed start rate | observed appearance rate |
|-------|--:|-----------------:|--------------------:|-------------------------:|
| all zero-minute rows | 2138 | 0.189 | 0.031 | 0.149 |

**The model predicts an 18.9 per cent chance of starting for a group that starts
3.1 per cent of the time.** The defect is real and it is a factor of six.

It is worse than the average makes it look, because the error is concentrated
where the price is highest. Predicted-probability bins, same rows:

| bin | n | mean predicted | observed |
|-----|--:|---------------:|---------:|
| 0.0-0.1 | 1267 | 0.084 | 0.024 |
| 0.1-0.2 |  385 | 0.129 | 0.005 |
| 0.2-0.3 |  133 | 0.251 | 0.000 |
| 0.3-0.4 |   49 | 0.350 | 0.184 |
| 0.4-0.5 |   25 | 0.448 | 0.120 |
| 0.5-0.6 |   70 | 0.547 | 0.143 |
| 0.6-0.7 |   90 | 0.666 | 0.067 |
| 0.7-0.8 |  119 | 0.740 | 0.050 |

The top bin is out by a factor of fifteen, and the relationship is not merely
mis-levelled, it is flat: the price percentile's AUC for starting inside this
group is 0.56. Price barely orders these players at all.

### Where the error actually is

Splitting the same rows by how many matches the player's own club had already
finished at the time of the projection is what identifies it:

| matches his club had played | n | mean price pct | observed start rate | observed appearance rate |
|-----------------------------|--:|---------------:|--------------------:|-------------------------:|
| 0 (pre-season or gameweek 1) | 377 | 0.463 | 0.125 | 0.668 |
| 1 to 3                       | 302 | 0.141 | 0.010 | 0.096 |
| 4 to 9                       | 414 | 0.080 | 0.010 | 0.041 |
| 10 to 19                     | 466 | 0.080 | 0.015 | 0.030 |
| 20 or more                   | 579 | 0.079 | 0.009 | 0.012 |

The appearance rate falls by a factor of 55 from one end of that table to the
other, monotonically, in all three seasons independently. The model's prediction
across the same table is FLAT at about 0.135, because price does not change and
price is all it reads.

So the price prior is not wrong. It is EXPIRED. Checked directly against the
pre-season rows, where it is the only signal available and where its answer is
allowed to stand:

| season | n | predicted start | observed start | predicted appear | observed appear |
|--------|--:|----------------:|---------------:|-----------------:|----------------:|
| 2022-23 | 260 | 0.459 | 0.000 | 0.578 | 0.727 |
| 2023-24 |  59 | 0.277 | 0.424 | 0.436 | 0.542 |
| 2024-25 |  58 | 0.287 | 0.379 | 0.444 | 0.534 |

Pre-season the prior slightly UNDER-predicts. `NO_HISTORY_MIN_START` = 0.08 and
`NO_HISTORY_MAX_START` = 0.78 are therefore left alone, and this experiment
changes nothing at all about gameweek 1.

(2022-23's observed start rate of 0.000 against a 0.727 appearance rate is not a
finding, it is the known defect in that archive's `starts` column, already
recorded in `availability-minutes.md`. Every start-based number below is
therefore fitted on 2023-24 and 2024-25 only, with 2022-23 used on appearances
as an independent check.)

## 5. The fix, and the one parameter it introduces

A player with zero minutes is not a player with no evidence. He is a player who
started none of the m matches his club has played. That is a count, and the
posterior for it under a Beta prior of strength m0 centred on the price-derived
rate p0 is

```
baseStart = p0 * NO_HISTORY_PRIOR_MATCHES / (m + NO_HISTORY_PRIOR_MATCHES)
```

which is the same shrinkage every other estimate in `minutes.js` already uses.
At m = 0 the weight is exactly 1, so pre-season and gameweek 1 are untouched by
construction rather than by a special case. The same weight is applied to
`NO_HISTORY_SUB_ON_RATE`, because "zero minutes after m matches" bears on
appearing at all and not only on starting; without that, a player who has never
been on the pitch keeps a 22 per cent chance of coming off the bench forever.

m is the player's OWN club's finished matches, not the league maximum, so a run
of postponements does not charge him for chances he never had.

### The parameter is measured, not chosen

`NO_HISTORY_PRIOR_MATCHES` is the number of matches of evidence the price signal
is worth. Fitted by maximum Bernoulli likelihood over the archive's zero-minute
player-gameweeks with m >= 1, one fit per season per outcome so the spread can
be read rather than asserted:

| outcome | population | n | fitted strength |
|---------|-----------|--:|----------------:|
| starts      | 2023-24              |  320 | 0.671 |
| starts      | 2024-25              |  496 | 0.776 |
| starts      | pooled               |  816 | 0.718 |
| appearances | 2022-23              |  945 | 0.933 |
| appearances | 2023-24              |  320 | 0.771 |
| appearances | 2024-25              |  496 | 0.848 |
| appearances | pooled               | 1761 | 0.876 |

Five independent fits between 0.67 and 0.93. Sensitivity to the range of m,
which is where the estimate is weakest because the positives are so few:

| restriction | appearances | starts |
|-------------|------------:|-------:|
| 1 <= m <= 5  | 0.649 | 0.347 |
| 1 <= m <= 12 | 0.712 | 0.415 |
| m >= 1       | 0.876 | 0.718 |

**Shipped value: 1 match.** It is the round number at the TOP of the measured
range, and the top is the conservative end: a larger strength means less decay
and a smaller departure from the shipped behaviour. It was not tuned on season
points and no other value was replayed.

### What it cannot do

It cannot tell a January signing from a youth player. Both arrive with zero
minutes at a club that has played twenty matches, and both are now pushed to
almost no chance of starting. The pooled start rate for that group is 0.9 per
cent so the pooled answer is right, but the individual answer for a marquee
mid-season arrival is wrong until he plays. Nothing in the payload separates
them; `costChangeStart` is zero in the archive and the news field is not
reliable. This is a real cost and it is stated rather than hidden.

## 6. Prediction error, stratified, all four arms

28,609 player-gameweeks. Buckets are accumulated minutes AT THE TIME OF THE
PROJECTION, which is the same n the rate is divided by. Rows whose club has no
fixture are dropped, because a blank gameweek is projected 0 and scores 0.

**Mean absolute error**

| bucket | n | base | shrink only | minutes only | both |
|--------|--:|-----:|------------:|-------------:|-----:|
| exactly 0 |  2138 | 0.750 | **0.864** | 0.393 | 0.412 |
| 1 to 90   |  1007 | 1.205 | 1.181 | 1.205 | 1.181 |
| 90-450    |  3608 | 1.662 | 1.676 | 1.662 | 1.676 |
| 450-900   |  3734 | 2.043 | 2.049 | 2.043 | 2.049 |
| 900+      | 18122 | 2.494 | 2.479 | 2.494 | 2.479 |
| AGGREGATE | 28609 | 2.155 | 2.155 | 2.128 | **2.121** |

**Bias** (positive means overprojected)

| bucket | n | base | shrink only | minutes only | both |
|--------|--:|-----:|------------:|-------------:|-----:|
| exactly 0 |  2138 | +0.227 | **+0.361** | -0.162 | -0.129 |
| 1 to 90   |  1007 | +0.283 | +0.261 | +0.283 | +0.261 |
| 90-450    |  3608 | -0.175 | -0.181 | -0.175 | -0.181 |
| 450-900   |  3734 | -0.168 | -0.190 | -0.168 | -0.190 |
| 900+      | 18122 | +0.254 | +0.202 | +0.254 | +0.202 |
| AGGREGATE | 28609 | +0.144 | +0.116 | +0.115 | **+0.080** |

**Largest single projection in the bucket**

| bucket | base | shrink only | minutes only | both |
|--------|-----:|------------:|-------------:|-----:|
| exactly 0 |  4.2 |  4.6 |  2.8 |  3.2 |
| 1 to 90   | 19.9 |  4.4 | 19.9 |  4.4 |
| 900+      | 12.9 | 12.2 | 12.9 | 12.2 |
| AGGREGATE | 19.9 | 12.2 | 19.9 | 12.2 |

The three tables say the same thing three ways, and it is the whole point of
running the two changes together. The columns are almost perfectly disjoint:
shrinkage owns the 1-to-90 bucket and the body of the distribution and cannot
help the zero bucket (it hurts it, 0.750 to 0.864); the minutes decay owns the
zero bucket and cannot touch the 19.9 point cameo, because Cauley Woodrow had
two minutes, not zero. Only the combined arm improves aggregate MAE and bias at
the same time, and it improves bias by more than the two arms do separately
(+0.144 to +0.080 against +0.116 and +0.115).

## 7. Calibration of pStart for the zero-minute group, before and after

The number this experiment exists to move.

| population | n | predicted before | predicted after | observed |
|------------|--:|-----------------:|----------------:|---------:|
| all three seasons          | 2138 | 0.189 | 0.088 | 0.031 |
| 2023-24 and 2024-25 only   |  933 | 0.157 | 0.053 | 0.063 |

The second row is the honest one, because it excludes the season whose `starts`
column is broken. **Predicted-to-observed goes from 2.49x to 0.84x.** The model
stops claiming a group starts two and a half times more often than it does, and
lands slightly conservative.

By how long the player has been unplayed, which is the shape rather than the
level:

| matches his club had played | n | predicted before | predicted after | observed start | observed appearance |
|-----------------------------|--:|-----------------:|----------------:|---------------:|--------------------:|
| 0        | 377 | 0.404 | 0.404 | 0.125 | 0.668 |
| 1 to 3   | 306 | 0.178 | 0.069 | 0.013 | 0.098 |
| 4 to 9   | 416 | 0.138 | 0.020 | 0.007 | 0.039 |
| 10 to 19 | 488 | 0.135 | 0.009 | 0.014 | 0.031 |
| 20+      | 551 | 0.134 | 0.005 | 0.009 | 0.011 |

Before, the prediction is flat at 0.135 against an observed rate flat at 0.01.
After, it tracks. The m = 0 row is identical in both columns by construction,
and its observed 0.125 is the 2022-23 archive defect dragging down a true 0.40.

Per season:

| season | n | predicted before | predicted after | observed |
|--------|--:|-----------------:|----------------:|---------:|
| 2022-23 | 1205 | 0.213 | 0.116 | 0.006 (unreliable) |
| 2023-24 |  379 | 0.186 | 0.065 | 0.082 |
| 2024-25 |  554 | 0.138 | 0.045 | 0.051 |

## 8. Planner points, protocol 1: full-season replay

All 38 gameweeks, shipped default horizon 3, seed 1, balanced risk, analytic
projections, previous season seeded, chips on.

| season | base | shrink only | minutes only | both | delta |
|--------|-----:|------------:|-------------:|-----:|------:|
| 2022-23 | 2151 | 2156 | 2118 | 2121 |  -30 |
| 2023-24 | 1817 | 2130 | 1817 | 1893 |  +76 |
| 2024-25 | 2371 | 2108 | 2347 | 2093 | -278 |
| total   | 6339 | 6394 | 6282 | 6107 | -232 |

| measure   | base | both |
|-----------|-----:|-----:|
| vs greedy-xp | +211 |  +64 |
| vs hold      | +796 | +1139 |

Baselines replayed beside it: greedy-xp 2066 / 1778 / 2284 becomes 1982 / 1955 /
2106, and hold 1627 / 1910 / 2006 becomes 1605 / 1592 / 1771.

Wildcard gameweeks:

| season | base | shrink only | minutes only | both |
|--------|------|-------------|--------------|------|
| 2022-23 | 6, 20 | 6, 20 | 18, 21 | 8, 20 |
| 2023-24 | 2, 24 | 2, 27 | 2, 24  | 2, 20 |
| 2024-25 | 2, 30 | 2, 29 | 2, 30  | 2, 29 |

The planner still wildcards at gameweek 2 in the two seasons it always has. What
changes is what that wildcard is allowed to believe. The 2023-24 gameweek 2
rebuild, the single worst decision in the archive, goes from **-96 points to
+14**.

The 2024-25 loss is not seed noise. Seeds 1, 2 and 3 give 2371 / 2371 / 2371 on
the base arm and 2093 / 2093 / 2086 on the combined arm.

## 9. Planner points, protocol 2: nine chip-free windows

Three seasons, each split into gw1-13, gw14-26 and gw27-38, chips removed from
the rules catalogue so none can be played. Nine independent trajectories, and
the protocol this project treats as deciding.

| season | window | base | shrink only | minutes only | both | delta |
|--------|--------|-----:|------------:|-------------:|-----:|------:|
| 2022-23 | gw1-13  | 529 | 510 | 521 | 559 | +30 |
| 2022-23 | gw14-26 | 767 | 755 | 767 | 755 | -12 |
| 2022-23 | gw27-38 | 789 | 783 | 789 | 783 |  -6 |
| 2023-24 | gw1-13  | 687 | 707 | 687 | 756 | +69 |
| 2023-24 | gw14-26 | 613 | 617 | 613 | 617 |  +4 |
| 2023-24 | gw27-38 | 696 | 695 | 696 | 695 |  -1 |
| 2024-25 | gw1-13  | 739 | 780 | 733 | 780 | +41 |
| 2024-25 | gw14-26 | 871 | 910 | 871 | 910 | +39 |
| 2024-25 | gw27-38 | 633 | 547 | 633 | 547 | -86 |
| total   |         | 6324 | 6304 | 6310 | **6402** | **+78** |

| arm | total | delta | wins | losses | ties |
|-----|------:|------:|-----:|-------:|-----:|
| shrink only  | 6304 | -20 | 4 | 5 | 0 |
| minutes only | 6310 | -14 | 0 | 2 | 7 |
| **both**     | **6402** | **+78** | **5** | **4** | **0** |

**This is the interaction, and it is as clean as this kind of thing ever gets.**
Neither fix alone is worth anything. Together they are worth +78, and every
point of the difference comes from the three gw1-13 windows, which is where
zero-minute players are in the pool at all. Six of the nine windows are
bit-identical between the shrink-only arm and the combined arm, because after
gameweek 13 there is almost nobody left with zero minutes to decay.

Per season the combined arm is 2085 to 2097, 1996 to 2068 and 2243 to 2237. No
season loses more than 6 points on this protocol.

The one large loss, 2024-25 gw27-38 at -86, is entirely the shrinkage: the
shrink-only and combined arms give the identical 547, and by gameweek 27 the
minutes decay has nothing left to act on. It is the same -86 the previous
experiment measured, reproduced exactly.

### The same protocol over a full 38 gameweeks, chips off

Chips are the largest single source of variance in a season replay, so the same
comparison over the whole season with them removed separates "the change made
worse decisions" from "the change forked the chip trajectory":

| season | base | shrink only | minutes only | both | delta |
|--------|-----:|------------:|-------------:|-----:|------:|
| 2022-23 | 2092 | 2077 | 1997 | 2108 |  +16 |
| 2023-24 | 1850 | 1982 | 1850 | 2031 | +181 |
| 2024-25 | 2305 | 2209 | 2164 | 2209 |  -96 |
| total   | 6247 | 6268 | 6011 | 6348 | +101 |

Two wins and one loss, +101. Note the minutes-only column: 6011, a 236 point
loss, which is the mechanism from section 1 made visible. Suppressing a
zero-minute player's start probability without shrinking anybody's rates just
moves the money to the 1-to-89 minute players, who are the worst-projected group
in the whole table.

## 10. Where the 2024-25 season goes, since that is what fails it

2024-25 with chips on is +58 through gameweek 13 and then loses 340 points over
gameweeks 14 to 38.

| quantity | base | both |
|----------|-----:|-----:|
| total chip value | 271 | 178 |
| wildcard @2 | +117 | +98 |
| bench boost | @5 = +10, @37 = +3 | @4 = 0, @33 = +10 |
| second wildcard | @30 = +72 | @29 = +52 |
| free hit | @34 = +49 | @32 = -2 |
| points left on the bench | 178 | 114 |
| projection bias per gameweek, selected squad | +0.33 | +3.80 |

93 of the 278 are chips scoring less. The rest is a squad that diverges from
gameweek 14 onward and never converges back. The chip-free full-season row above
puts the non-chip part of the 2024-25 loss at 96 points, and the three chip-free
windows put it at 6, which means most of even that is one squad trajectory
compounding rather than a repeated bad decision.

That is an explanation. It is not an exemption. The shipped app has chips
enabled, and a manager replaying 2024-25 with this change scores 2093 instead of
2371.

The selected-squad projection bias is worth recording because registry entry 1
turns on it. Across the three seasons it moves from -14.98 / +12.98 / +0.33 to
-16.43 / +4.28 / +3.80. Better on average, no better in spread.

## 11. Decision

**REJECT.**

The bar was: the nine-window protocol improves or holds AND no season collapses.

The nine-window protocol improves, by +78 with 5 wins and 4 losses, and no
season moves by more than 6 points on it. The chip-free full-season replay
improves by +101. The prediction quality improves on aggregate MAE, on aggregate
bias, on the exactly-zero bucket, on the 900+ bucket that carries 63 per cent of
all decisions, and on the largest projection in every stratum.

And 2024-25 loses 278 points in the configuration the app actually ships, seed
independently. This project has already rejected two changes for a single-season
collapse of 263 and 291 points while their aggregates looked acceptable, and a
278 point collapse does not become acceptable because the aggregate this time is
carried by a better protocol. Half a season of a real manager's year is not a
rounding error.

## 12. Why it is not reverted, and what to do with it

`projection-shrinkage.md` was reverted because it fixed nothing that survived
its own rejection. This one is different, and the difference is not about
points.

**The output-quality case, which is a separate question and a strong one.**
Highest projection handed to a player with under 90 minutes on the board, at the
gameweeks where the season is decided by people who have just paid attention for
the first time:

| season | gameweek | before | after |
|--------|---------:|--------|-------|
| 2023-24 | 2 | Simon Adingra, 16 min, **8.72** | Joao Pedro, 87 min, 3.91 |
| 2023-24 | 3 | Cauley Woodrow, 2 min, **19.92** | Jurrien Timber, 49 min, 3.72 |
| 2023-24 | 4 | Cauley Woodrow, 2 min, **17.67** | Martin Dubravka, 78 min, 3.03 |
| 2024-25 | 2 | Lucas Bergvall, 12 min, **8.11** | Kaoru Mitoma, 88 min, 4.38 |
| 2024-25 | 3 | Joao Felix, 22 min, **5.82** | Daniel Jebbison, 36 min, 3.84 |
| 2024-25 | 4 | Leander Dendoncker, 59 min, 5.07 | Leander Dendoncker, 59 min, 3.37 |
| 2022-23 | 2 | John Stones, 0 min, 1.91 | Oleksandr Zinchenko, 82 min, 1.25 |
| 2022-23 | 3 | Harvey Barnes, 0 min, 1.54 | Alphonse Areola, 61 min, 1.24 |
| 2022-23 | 4 | Marcos Alonso, 0 min, 1.73 | Alphonse Areola, 61 min, 1.20 |

Woodrow scored 0. Every one of the eight worst sub-90-minute projections in the
three-season archive is gone, the largest falls from 19.92 to 3.91, and after
the change no player with under 90 minutes behind him is ever the top projection
by a margin that would put him in a recommended transfer.

Two things about the timing. First, gameweek 1 is untouched: the minutes decay
has weight exactly 1 when no match has been played, and the only gameweek 1
change is that a player with no minutes now gets his position's league rate
instead of literally zero, which raises a promoted club's first-choice
goalkeeper from 2.79 to 3.25 rather than lowering anything. Second, every
absurdity in the table above is a gameweek 2, 3 or 4 output. The real season
starts in ten days.

**So: the planner verdict is REJECT and the output-quality case is strong. That
is a product decision, not a modelling one.** A recommendation engine that tells
a manager to buy a substitute at 19.9 expected points loses the user before it
ever gets the chance to be 232 points wrong over three notional seasons, and the
232 is mostly one season's chip trajectory. If the answer is "ship it anyway
because the app has to be credible in August", that is a defensible answer and
this file is the evidence for it. It is not mine to give.

The code is therefore **left in the working tree, uncommitted, on
`feature/fpl-planner`**, so the call can go either way without redoing the work.
Nothing was committed and nothing was pushed.

**To revert**, remove from `js/engine/projections.js`: the `PRIOR_NINETIES_MAX`
and `PRIOR_NINETIES` block, `positionRatePriors`, `priorNinetiesFor`,
`shrinkRates`, the two `PROJECTION_PARAMS` keys, the `ratePriors` argument on
`projectPlayerGw` and `buildProjections`, and restore `const rates =
underlyingRates(player, { gw })`. From `js/engine/minutes.js`: remove
`NO_HISTORY_PRIOR_MATCHES`, `matchesPlayedByTeam` and its two `MINUTES_PARAMS`
keys, restore the undecayed `baseStart` and `subOnRate` in the no-history branch
and the `no-history-prior` reason. Then delete the tests added to
`tests/projections.test.mjs` and `tests/minutes.test.mjs`. The base arm scores
2151 / 1817 / 2371 and 6324, which is the check.

## 13. Re-test rules

- **Do not re-test either half on its own.** Section 6 and section 9 measure
  both singly and both are worth nothing or worse. The finding is the
  interaction.
- **Do not sweep `NO_HISTORY_PRIOR_MATCHES`.** It is the top of a measured range
  of five independent fits, and it was never replayed at any other value, which
  is the only reason it can be trusted. Sweeping it on three seasons would
  repeat exactly the mistake `projection-shrinkage.md` section 8 documents.
- **Do not sweep k.** That sweep exists, it covers a factor of four, and it is
  not monotone.
- **What would change the verdict:** a chip evaluator whose decisions do not
  fork a whole half-season, which is the term that carries 93 of the 278 points
  directly and most of the rest through squad divergence. On the two protocols
  that hold chips fixed this change wins on both.
- **Worth testing separately:** the 2024-25 free hit at gameweek 32 scoring -2
  against +49 at gameweek 34. A chip that is worth negative points was still
  played, which is a chip evaluator question and has nothing to do with
  projections.
- **A January signing has no way in.** The decay charges him for twenty matches
  he was not eligible for. If a "minutes at this club" or arrival-date signal
  ever exists in the payload, that is the exception the parameter should learn.
