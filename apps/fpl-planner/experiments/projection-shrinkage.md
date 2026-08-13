# Small-sample shrinkage of the per-90 rates

**Date:** 2026-08-11
**Decision: REJECT.** Reverted. `js/engine/projections.js` is back to the state
that reproduces 2151 / 1817 / 2371.

This is the experiment registry entry 3 asked for by name: "shrinkage of per 90
rates toward a pre-season prior when in-season minutes are thin, measured on
transfers and lineups as well as chips". It was built, it fixed the defect it
was aimed at, and it did not pay in season points.

---

## 1. Hypothesis

A per-90 rate divided out of a handful of minutes is almost pure noise, and the
projection treats it as fact. That is what manufactures the 116 projected points
of measured advantage behind the 2023-24 gameweek 2 wildcard: the rebuild is
built from players whose rates are extrapolations of a cameo. Shrinking every
rate toward a position prior by how much football is behind it fixes the INPUT,
where the defect is, rather than taxing the OUTPUT the way the rejected
wildcard premium did, and should improve transfers and lineups at the same time.

The formulation is empirical-Bayes, one line, no thresholds anywhere:

```
shrunk = (own total + prior rate * k) / (own nineties + k)
```

which is "credit the player with k nineties of league-average play before
reading his own". A player with 2000 minutes is untouched. A player with 2
minutes is the prior. Applied to every rate `underlyingRates` produces: xG, xA,
BPS (which is what the bonus model reads), saves, defensive contribution,
yellow cards, red cards, penalties saved.

## 2. The prior, and why this one

Three candidates were on the table. Only one is always available.

- **The player's own last-season rate.** Not a separate field, and it does not
  need to be: pre-season the payload's season totals ARE last season, and the
  replay seeds them the same way at weight 0.5. So a returning player's
  last-season rate already enters as the OBSERVATION, with a full season of
  nineties behind it, and the shrinkage barely moves it. There is nothing to
  add here.
- **The promoted-club prior in `strength.js`.** It is a CLUB-level statement
  about attack and defence and it belongs there. It composes with a player-level
  prior multiplicatively through the fixture scaling, so a promoted club's new
  striker gets the league forward rate scaled down by his club's fitted attack.
  Nothing to move.
- **The position's league rate**, measured from the same payload every other
  population number in the file is measured from (`bonusModel` fits the bonus
  curve there, `positionPriors` fits the start rates there). Re-fits itself every
  season, needs no constant. **Chosen.**

The prior is MINUTES-weighted (sum of the position's totals over sum of the
position's nineties), not a mean of per-player rates, and that choice matters
exactly where the noise is. On the 2023-24 gameweek 2 payload:

| position | players | per-minute xG/90 | per-player xG/90 | per-minute BPS/90 | per-player BPS/90 |
|----------|--------:|-----------------:|-----------------:|------------------:|------------------:|
| GK       |      35 |           0.0002 |           0.0001 |             19.12 |             19.94 |
| DEF      |     172 |           0.0372 |           0.0355 |             17.65 |             20.73 |
| MID      |     225 |           0.1174 |           0.1102 |             15.62 |             29.78 |
| FWD      |      59 |           0.3363 |           0.3341 |             17.52 |             25.57 |

The two agree on xG and disagree by a factor of two on BPS, because the
per-player mean is dominated by the same cameo rates the shrinkage exists to
correct. A cameo contributes its two minutes to both sides of a minutes-weighted
ratio, so it cannot distort the population the way it distorts its own rate.

`strength.js` was read and deliberately left alone. Its two squad aggregates are
already minutes-weighted at club level (`aggregateSquadXg` divides summed xG by
summed squad minutes), it already shrinks the club measurement toward a prior by
`MINUTES_SHRINK_K` = 12000 squad minutes, and player xGC is never read per 90 by
the projection at all: the concession lambda comes from the fixture model's
`opponentXg`, not from the player. There is no small-sample per-90 division in
that file to fix.

## 3. Estimating k from the archive

k is the sample size, in nineties, at which a player's own evidence and the
prior deserve equal weight. It is derived, not chosen.

Model a count with n nineties behind it as quasi-Poisson: mean `mu * n`,
variance `phi * mu * n`, with the true rates `mu` spread across players with
mean `m` and variance `tau^2`. The posterior mean is the expression in section 1
with

```
k = phi * m / tau^2
```

All three are measurable in the archive, and each is measured separately.

- **`phi`, the within-player dispersion.** Pearson dispersion of a player's own
  gameweeks around his own season rate, summed over players and divided by the
  degrees of freedom. This is the "within" half of the variance argument.
- **`m`, the pooled rate.** Sum of the position's totals over sum of its
  nineties.
- **`tau^2`, the between-player variance.** The minutes-weighted spread of
  observed season rates MINUS the sampling variance `phi` implies, which for
  weights `n_i / N` is `phi * m * P / N` with P player-seasons. This is the
  "between" half: it is what is left of the spread once the noise is removed.

Measured over 2022-23, 2023-24 and 2024-25 (1686 player-seasons with minutes),
defensive contribution over 2025-26, the only season whose archive carries
clearances, blocks, interceptions, recoveries and tackles. Minimum sample 10
nineties, so the correction term is small and reliable.

| rate      | pos | player-seasons | m       | phi    | var(total) | within  | tau^2   | k      |
|-----------|-----|---------------:|--------:|-------:|-----------:|--------:|--------:|-------:|
| xG        | GK  |             78 |  0.0002 |  0.069 |     0.0000 |  0.0000 |  0.0000 | 1122.1 |
| xG        | DEF |            374 |  0.0464 |  0.221 |     0.0010 |  0.0005 |  0.0006 |   17.7 |
| xG        | MID |            431 |  0.1526 |  0.308 |     0.0148 |  0.0021 |  0.0127 |    3.7 |
| xG        | FWD |            107 |  0.3867 |  0.416 |     0.0280 |  0.0078 |  0.0202 |    8.0 |
| xA        | GK  |             78 |  0.0016 |  0.031 |     0.0000 |  0.0000 |  0.0000 |   10.4 |
| xA        | DEF |            374 |  0.0501 |  0.176 |     0.0022 |  0.0004 |  0.0018 |    4.9 |
| xA        | MID |            431 |  0.1171 |  0.207 |     0.0056 |  0.0011 |  0.0046 |    5.3 |
| xA        | FWD |            107 |  0.0734 |  0.177 |     0.0020 |  0.0006 |  0.0013 |    9.7 |
| bps       | GK  |             78 | 16.7390 |  4.851 |    11.2103 |  2.9958 |  8.2145 |    9.9 |
| bps       | DEF |            374 | 15.5532 |  7.228 |    14.5972 |  4.9526 |  9.6445 |   11.7 |
| bps       | MID |            431 | 16.4610 |  9.919 |    15.8414 |  7.2396 |  8.6019 |   19.0 |
| bps       | FWD |            107 | 17.6741 | 21.242 |    33.9083 | 18.1905 | 15.7178 |   23.9 |
| saves     | GK  |             78 |  3.0790 |  1.190 |     0.5005 |  0.1351 |  0.3654 |   10.0 |
| defCon    | DEF |            147 |  7.6783 |  1.812 |     3.7112 |  0.6599 |  3.0512 |    4.6 |
| defCon    | MID |            181 |  8.5735 |  1.604 |     5.8172 |  0.7167 |  5.1005 |    2.7 |
| defCon    | FWD |             44 |  4.7156 |  1.766 |     1.6703 |  0.4547 |  1.2156 |    6.9 |
| yellow    | DEF |            374 |  0.1779 |  1.007 |     0.0091 |  0.0079 |  0.0012 |  148.8 |
| yellow    | MID |            431 |  0.1986 |  1.212 |     0.0151 |  0.0107 |  0.0045 |   53.8 |
| yellow    | FWD |            107 |  0.1576 |  2.192 |     0.0135 |  0.0167 | -0.0033 |    n/a |
| red       | DEF |            374 |  0.0062 |  1.790 |     0.0003 |  0.0005 | -0.0002 |    n/a |
| red       | MID |            431 |  0.0051 |  1.343 |     0.0002 |  0.0003 | -0.0001 |    n/a |
| pensSaved | GK  |             78 |  0.0180 |  1.017 |     0.0006 |  0.0007 | -0.0001 |    n/a |

The numbers say three things worth keeping even though the change is rejected.

- **Position matters and not in the obvious direction.** A defender's xG rate
  gets k = 17.7 because defenders are nearly identical to each other, so it takes
  most of a season of evidence to earn any separation. A midfielder's gets k =
  3.7 because midfielders genuinely differ, so four matches already say
  something. Forwards land at 8.0 because their higher rate carries more
  sampling noise per ninety.
- **BPS is the noisiest thing in the projection.** A forward's BPS dispersion is
  21.2, meaning a single gameweek's BPS varies twenty times more than a Poisson
  count of the same mean. Half a season of BPS is barely worth the league
  average.
- **Cards and penalty saves have no measurable between-player signal at all.**
  tau^2 comes out at or below zero for red cards in every position, for
  penalties saved, and for a forward's yellows. On this evidence no player's
  card rate is distinguishable from his position's, so those got
  `PRIOR_NINETIES_MAX` = 200 nineties, which is the prior in all but name.

**Stability.** The estimates were run at minimum-sample cutoffs of 5, 10 and 20
nineties. They barely move for the rates that matter (xG for midfielders: 3.72,
3.70, 3.80; xG for forwards: 8.27, 7.95, 7.53; saves: 10.26, 10.03, 10.10;
xA for defenders: 4.52, 4.85, 4.54). They move for the ones with almost no
between-player variance to measure (a goalkeeper's xG, a defender's yellows),
which is the same statement as "there is nothing there to estimate". Defensive
contribution was checked at cutoffs of 3, 5 and 8 nineties: 4.57 / 4.56 / 4.27
for defenders, 2.73 / 2.70 / 2.63 for midfielders.

## 4. Prediction quality, stratified by sample size

Projected against actual points, every player-gameweek in the 260-most-owned
pool the replay actually decides over, all three seasons, one gameweek ahead.
Buckets are the player's accumulated minutes AT THE TIME OF THE PROJECTION,
which is the same n the rate is divided by. Aggregate error hides this defect
completely, which is the whole reason it survived.

| bucket    |     n | MAE before | MAE after |  bias before | bias after | max projection before | max after |
|-----------|------:|-----------:|----------:|-------------:|-----------:|----------------------:|----------:|
| 0-90      |  3145 |      0.896 |     0.966 |       +0.245 |     +0.329 |                  19.9 |       4.6 |
| 90-450    |  3608 |      1.662 |     1.676 |       -0.175 |     -0.181 |                   7.6 |       6.5 |
| 450-900   |  3734 |      2.043 |     2.049 |       -0.168 |     -0.190 |                   6.3 |       5.4 |
| 900+      | 18122 |      2.494 |     2.479 |       +0.254 |     +0.202 |                  12.9 |      12.2 |
| AGGREGATE | 28609 |      2.155 |     2.155 |       +0.144 |     +0.116 |                  19.9 |      12.2 |

The tail is fixed in the way that matters and NOT in the way the bucket average
reports. The largest projection handed to a player with under 90 minutes behind
him falls from 19.9 to 4.6, and every absurd projection in the top twelve
disappears. But the bucket's mean error gets worse, because the bucket is 2138
players with EXACTLY zero minutes against 1007 with between 1 and 89, and giving
a zero-minute player his position's league rate raises a group that was already
overprojected:

| group inside 0-90 |    n | projected after | actual | MAE after |
|-------------------|-----:|----------------:|-------:|----------:|
| exactly 0 minutes | 2138 |           0.761 |  0.399 |     0.864 |
| 1 to 89 minutes   | 1007 |           0.989 |  0.728 |     1.181 |

That residual is a MINUTES problem, not a rates problem: a zero-minute player at
a high price gets a start probability of up to 0.78 from the price percentile in
`minutes.js`, and no rate prior can correct that. The variant that leaves
zero-minute players unshrunk (section 7, `nz`) does fix the bucket average, at
0.888 MAE and +0.238 bias, better than before on every single line of the table.

The body of the distribution improves: the 900+ bucket, which is 63 per cent of
all decisions, gains on both MAE and bias, and the aggregate bias falls from
+0.144 to +0.116 with MAE unchanged to three decimals. So this is not a tail fix
that damages the body.

## 5. The pathological case, directly

**Cauley Woodrow, Luton Town, 2 minutes played.** The exact 19.9 the registry
records is his, at 2023-24 gameweek 3. In those 2 minutes he was credited with
0.37 expected assists, which the projection read as a rate:

| quantity                      | before | after |
|-------------------------------|-------:|------:|
| minutes on the board          |      2 |     2 |
| xA per 90                     |  16.65 | 0.091 |
| BPS per 90                    |  315.0 |  17.7 |
| expected assists, one fixture | 13.115 | 0.072 |
| assist POINTS, one fixture    |  39.34 |  0.22 |
| xPoints                       |  19.92 |  2.85 |
| ceiling                       |     27 |     6 |
| points he actually scored     |      0 |     0 |

The 39.34 assist points are truncated to a 19.92-point projection only because
the component distributions cap at 8 events. Nothing else in the file objected.

At the gameweek 2 deadline the planner plays its wildcard, and it optimizes over
gameweeks 2 to 4. Woodrow projected 0.00, 22.60 and 22.90 across that horizon
(gameweek 2 is 0.00 because Luton's fixture was postponed), which made him the
highest-projected player in the entire pool, and the wildcard bought him.

| 2023-24 gameweek 2 wildcard                          | before | after |
|------------------------------------------------------|-------:|------:|
| highest projection among sub-90-minute players        |   8.72 |  3.91 |
| highest over the whole gw2-gw4 horizon                |  22.90 |  4.33 |
| squad members with under 90 minutes behind them       |   4/15 |  1/15 |
| projected gameweek points for the eleven plus captain |   71.0 |  50.3 |
| what that wildcard was actually worth                 |    -96 |   +35 |

The 19.9-point projection for a 2-minute player is gone, the 96-point-per-week
squad is gone, and the single decision the whole line of enquiry started from
swings by 131 points. The mechanism registry entry 3 identified was correct.

## 6. Planner points, protocol 1: full-season replay

All 38 gameweeks, shipped default horizon 3, seed 1, balanced risk, analytic
projections, previous season seeded, chips on. Before and after replayed back to
back on the same tree; the before column reproduces the shipped baseline exactly.

| season  | planner before | planner after | delta | greedy before | greedy after | hold before | hold after |
|---------|---------------:|--------------:|------:|--------------:|-------------:|------------:|-----------:|
| 2022-23 |           2151 |          2156 |    +5 |          2066 |         1950 |        1627 |       1616 |
| 2023-24 |           1817 |          2130 |  +313 |          1778 |         2001 |        1910 |       1591 |
| 2024-25 |           2371 |          2108 |  -263 |          2284 |         2105 |        2006 |       1771 |
| total   |           6339 |          6394 |   +55 |          6128 |         6056 |        5543 |       4978 |

| measure   | before | after |
|-----------|-------:|------:|
| vs greedy |   +211 |  +338 |
| vs hold   |   +796 | +1416 |

Both baselines are beaten by more than before, in every season. And the total
gain is +55 points carried entirely by one season, with another season losing
263. That is an aggregate gain with a large single-season collapse, which this
project has already rejected twice.

## 7. Planner points, protocol 2: nine chip-free windows

A single season replay is one deterministic trajectory, and one forked chip can
swing a half-season. Three seasons, each split into gw1-13, gw14-26 and gw27-38,
chips removed from the rules so none can be played. The before column reproduces
the 6324 a previous experiment measured.

| season  | window   | before | after | delta |
|---------|----------|-------:|------:|------:|
| 2022-23 | gw1-13   |    529 |   510 |   -19 |
| 2022-23 | gw14-26  |    767 |   755 |   -12 |
| 2022-23 | gw27-38  |    789 |   783 |    -6 |
| 2023-24 | gw1-13   |    687 |   707 |   +20 |
| 2023-24 | gw14-26  |    613 |   617 |    +4 |
| 2023-24 | gw27-38  |    696 |   695 |    -1 |
| 2024-25 | gw1-13   |    739 |   780 |   +41 |
| 2024-25 | gw14-26  |    871 |   910 |   +39 |
| 2024-25 | gw27-38  |    633 |   547 |   -86 |
| total   |          |   6324 |  6304 |   -20 |

**4 wins, 5 losses, 0 ties, and 20 points down.** The protocol with nine
independent trajectories says the change is worth nothing, and says it while the
three-season replay says +55. The two protocols also disagree about where the
gain is: the full replay credits 2023-24 with +313 and the windows credit it
with +23.

## 8. The k sweep, reported whole

k was NOT tuned. The variance argument produced one number per rate per position
and that is what section 6 and section 7 measure. The sweep below exists to show
what the answer is sensitive to, and it is reported in full precisely because
one of its rows scores better than the derived k.

| variant                     | 2022-23 | 2023-24 | 2024-25 | season total | 9 windows | window W-L |
|-----------------------------|--------:|--------:|--------:|-------------:|----------:|-----------|
| before, no shrinkage        |    2151 |    1817 |    2371 |         6339 |      6324 | -         |
| k x 0.5                     |    2103 |    2096 |    2286 |         6485 |      6410 | 5-4       |
| **k x 1.0, the derived k**  |    2156 |    2130 |    2108 |     **6394** |  **6304** | **4-5**   |
| k x 2.0                     |    2113 |    1912 |    2052 |         6077 |      6229 | 3-6       |
| k x 1.0, zero-minute players left unshrunk | 2129 | 1852 | 2165 | 6146 | 6434 | 5-4 |

Nothing here is monotone in the amount of shrinkage. Half the derived k scores
best on both protocols; twice it scores worst on both; the derived k is middling
on one and worst-but-one on the other; and the zero-minute variant is the best
of all on the nine windows (+110) while being 193 points DOWN over the three
seasons, which is a flat contradiction between the two protocols on the same
change. Every row loses at least one season by more than 200 points somewhere.

This is the signature of a change whose effect on season points is smaller than
the noise of the measurement, and picking the row that wins would be fitting the
protocol rather than the football.

## 9. Did the wildcard move

**No, and that is the honest answer to the question the whole line of enquiry
started from.**

| season  | wildcard gameweeks before | after | first wildcard moved |
|---------|---------------------------|-------|----------------------|
| 2022-23 | 6, 20                     | 6, 20 | no                   |
| 2023-24 | 2, 24                     | 2, 27 | no                   |
| 2024-25 | 2, 30                     | 2, 29 | no                   |

The planner still wildcards at gameweek 2 in two of three seasons. Fixing the
projections did not make it patient. What it changed is what that wildcard BUYS:
the 2023-24 gameweek 2 rebuild goes from 4 squad members with under 90 minutes
behind them to 1, its projected weekly total falls from 71 to 50, and its
measured value goes from -96 to +35. The second wildcard moves in both seasons
that have one, which is a downstream consequence of a different squad, not a
timing decision.

So the early wildcard is not itself the defect. The defect was what the early
wildcard was allowed to believe, and correcting that belief is worth 131 points
on that one decision while being worth nothing across a season.

## 10. Decision

**REJECT.** Reverted in full. `js/engine/projections.js` is back to the state
that reproduces 2151 / 1817 / 2371 and the gameweek 2 wildcards, verified after
the revert.

The bar was: planner points improve or hold AND consistency holds across
seasons. The derived k gains 55 points across three seasons while losing 263 in
2024-25, and loses 20 points across the nine chip-free windows with 4 wins and 5
losses. An aggregate gain carried by one season with another collapsing is the
pattern this project has rejected twice, and the better-powered protocol does
not even show the aggregate gain.

What it did achieve is real and is the reason this file exists rather than a
one-line note: a 19.9-point projection for a player with 2 minutes on the board
is indefensible, it is now 2.85, the aggregate projection bias improves from
+0.144 to +0.116, and the 900+ minute bucket that carries 63 per cent of all
decisions improves on both MAE and bias. None of that shows up in season points.

## 11. Re-test rules

- **Do not re-test** the same construction hoping for a better k. The sweep in
  section 8 covers a factor of four and is not monotone; the answer is noise at
  this sample size. Three seasons of replay cannot resolve a change worth tens of
  points.
- **Do not** ship the k x 0.5 row because it scores 6485. It is the winner of a
  five-row sweep on the only three seasons that exist, it loses two of those
  three seasons, and there is no argument behind the 0.5 other than that it won.
- **Worth testing instead**, and section 4 points straight at it: the residual
  overprojection of the 0-90 bucket is a MINUTES problem. 2138 of the 3145
  player-gameweeks in that bucket are players with exactly zero minutes, they
  score 0.399 points on average, and `minutes.js` gives an expensive one a start
  probability of up to 0.78 from price percentile alone. That is a bigger and
  better-identified error than the rates were.
- **If the projection path is rewritten** for another reason, the k table in
  section 3 is still the right table and does not need re-deriving. The
  estimation script is a variance decomposition over the archive and is
  reproducible from section 3 alone.
