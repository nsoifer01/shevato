# Sub-on rate shrinkage: REJECT

**Decision: REJECT.** Nothing shipped. The engine is unchanged.

The defect this was aimed at is REAL, measured, and still open; what failed is
this fix for it.

## The defect

`minutes.js` builds `pAppear` as

```
baseAppear = baseStart + (1 - baseStart) * subOnRate
```

`baseStart` is shrunk toward a position prior with weight `n/(n+6)`, so it
cannot reach 1 for any input. `subOnRate` is the ONLY rate in the file with no
shrinkage at all:

```js
const benchMatches    = Math.max(1, evidence - player.starts);
const inferredSubApps = Math.min(benchMatches, benchMinutes / prior.subMinutes);
subOnRate             = clamp01(inferredSubApps / benchMatches);
```

and `benchMinutes` is not bench minutes. It is `minutes - starts *
prior.starterMinutes`, a residual against a LEAGUE-AVERAGE constant, so it
measures how much more than average a player plays per start. The identity is
exact: B.Fernandes plays 87.7 minutes per start against a prior of 82.30, and
37 x 5.40 = 199.9 is precisely his "bench minutes" of 200. Divided by 20 that
is 10 inferred sub appearances, clipped by `benchMatches` of 3, so the ratio
saturates at exactly 1 and `pAppear` is a hard 1.0000.

The better and more complete the starter, the more certainly the model
concludes he came off the bench in every match he did not start.

**Incidence, live 2026/27 payload at GW3:** 66 of 505 playable players pinned at
exactly 1.0000, and 41.1% of the pool owned by 5% of managers or more. Without
the shipped opening baseline it is still 29 of 505, so this is not an
opening-weeks artefact. Zero players are pinned on `pStart`.

**Consequence:** with a whole eleven at `pAppear` 1, `absenceDistribution`
returns "no starter can ever miss", so `autosubValue` is 0, `gkValue` is 0, and
the `minutesRiskWeight * (1 - pAppear)` term of the selection score is 0. The
auto-substitution model and the documented reserve-keeper logic are inert.

**Ground truth**, all 283 player-seasons with 30+ starts in the three archives:

| season | players | matches | appearances | P(appear) | P(appear \| did not start) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2023-24 | 86 | 3263 | 3043 | 0.9326 | 0.3472 |
| 2024-25 | 98 | 3716 | 3470 | 0.9338 | 0.3692 |
| 2025-26 | 99 | 3752 | 3492 | 0.9307 | 0.3705 |
| all | 283 | 10731 | 10005 | **0.9323** | **0.3632** |

A nailed starter appears in 93.2% of his club's matches, not 100%.

## The candidate

Shrink the rate toward a measured per-position prior with the same `n/(n+K)`
form the file already uses for start rate, starter minutes and sub minutes,
using the `prior.subOnRate` field `positionPriors()` already computes and
which nothing currently consumes:

```js
const SUB_ON_RATE_SHRINK_MATCHES = 4;                                  // as SUB_MINUTES_SHRINK_APPS
const SUB_ON_RATE_PRIOR = { 1: 0.005, 2: 0.120, 3: 0.211, 4: 0.226 };  // GKP DEF MID FWD

const wSubOn = benchMatches / (benchMatches + SUB_ON_RATE_SHRINK_MATCHES);
subOnRate = clamp01(wSubOn * (inferredSubApps / benchMatches) + (1 - wSubOn) * prior.subOnRate);
```

The priors are measured over 56,415 non-start player-matches across the three
archives. The positional split is not decoration: a keeper who did not start
comes on 0.48% of the time, a forward 22.6%.

Run behind `FPL_SUBON_SHRINK=1` on the `experiments/configs/` pattern, off by
default, with `null-arm` confirming +0 on all 60 trajectories before the run.

## The evidence

`node apps/fpl-planner/scripts/experiment.mjs --config .../subon-shrinkage.mjs`
Tree engine 50514c8f8267, git 863c985, data 53e66c698d74, 120 replays in 343.5s.

| measure | per window (seeds averaged) | per trajectory |
| --- | ---: | ---: |
| observations | 20 | 60 |
| total delta | +158 | +473 |
| mean | +7.9 | +7.9 |
| standard error | 8.5 | 5.8 |
| **t** | **0.93** | 1.37 |
| p (two-sided) | 0.36 | 0.18 |
| 95% CI of the mean | **-9.8 to +25.6** | -3.7 to +19.4 |
| wins / losses / ties | 11 / 8 / 1 | 33 / 24 / 3 |
| **sign test p** | **0.65** | 0.29 |

Per season:

| season | control | candidate | delta | mean | W-L-T |
| --- | ---: | ---: | ---: | ---: | --- |
| 2022-23 | 10606 | 11122 | **+516** | +34.4 | 10-2-3 |
| 2023-24 | 10943 | 11239 | **+296** | +19.7 | 11-4-0 |
| 2024-25 | 11788 | 11723 | **-65** | -4.3 | 6-9-0 |
| 2025-26 | 10677 | 10403 | **-274** | -18.3 | 6-9-0 |

## Why this is a REJECT

1. **Two of four seasons lose**, and they are the two most recent. The
   Methodology section's rule is explicit: an aggregate gain hiding a
   single-season collapse is a rejection, not a win.
2. **t = 0.93 with the CI straddling zero.** The file's own standard is that
   "a t near 2 is suggestive, not a result"; 0.93 is not even suggestive.
3. **Sign test p = 0.65.** 11-8-1 across the windows is a coin flip.
4. **The constants were fitted in sample and still lost.** The priors were
   measured on 2023-24, 2024-25 and 2025-26, which are three of the four
   evaluated seasons, so the +473 is if anything optimistic.

## The trap this walked into, again

Calibration improved on essentially every subgroup, measured out of sample on
the replay's own leakage-guarded path (`gameStateAt`), 83,238 one-fixture
player-gameweeks:

| slice | control predicted / observed / error | candidate predicted / observed / error |
| --- | --- | --- |
| all | 0.4241 / 0.3981 / **+0.0260** | 0.4107 / 0.3981 / **+0.0126** |
| pAppear == 1.0000 | 1.0000 / 0.8531 / **+0.1469** (9.49% of rows) | bin is empty |
| nailed, pStart>=0.80 | 0.9681 / 0.9049 / +0.0632 | 0.9152 / 0.9049 / **+0.0103** |
| rotation 0.40-0.80 | 0.7663 / 0.7117 / +0.0546 | 0.7331 / 0.7117 / **+0.0214** |
| fringe 0.10-0.40 | 0.3779 / 0.3789 / -0.0010 | 0.3732 / 0.3789 / -0.0057 |
| deep, pStart<0.10 | 0.0616 / 0.0448 / +0.0169 | 0.0655 / 0.0448 / +0.0207 |
| GKP | 0.3216 / 0.2392 / +0.0824 | 0.3056 / 0.2392 / +0.0664 |
| DEF | 0.4675 / 0.4075 / +0.0600 | 0.4461 / 0.4075 / +0.0386 |
| MID | 0.4294 / 0.4284 / +0.0011 | 0.4197 / 0.4284 / -0.0087 |
| FWD | 0.3798 / 0.4094 / -0.0296 | 0.3775 / 0.4094 / -0.0318 |
| Brier, all | 0.1434 | **0.1400** |
| xMins bias | +2.42 | +2.05 |

Overall bias halves, the worst-calibrated bin in the model disappears, every
season improves, and no new floor or ceiling appears (the highest populated bin
becomes [0.95, 0.99) with 28 rows). **And the points do not follow.** This is
the third time the registry has recorded that shape. Prediction metrics do not
decide anything here; points decide.

## What the evidence says to investigate next

The likely mechanism is that this is a LEVEL correction, not an ORDER
correction. It lowers `pAppear` for nearly every established player by a
similar factor, and entry 12's order test says a level correction cancels out
of every ranking and only bites where it crosses a threshold. Consistent with
that, on team 3855835 at GW3 the candidate leaves the starting eleven and both
armbands unchanged and moves only the bench order and `autosubValue`.

So the next step is diagnosis before another arm, which is what the Methodology
asks for:

1. **Measure how often the candidate changes a DECISION**, not a number: the
   eleven, the armband, the transfer, the chip, per gameweek across the replay.
   If that rate is low, the points result is noise around zero and no variant of
   this shrinkage will read differently on this instrument.
2. **Fix the estimator rather than damp it.** Shrinkage hides the saturation but
   the residual is still contaminated: `benchMinutes` measures minutes above the
   league-average start, not bench appearances. An estimator that used the
   player's OWN minutes per start would not manufacture phantom sub appearances
   in the first place, and would not need a prior to stay off 1.
3. **Ask whether `pAppear` reaching 1 costs points at all.** It demonstrably
   costs CALIBRATION and it demonstrably zeroes the auto-substitution model, and
   those are worth stating in the UI. Whether they are worth season points is a
   separate question this run answers with "not measurably".
