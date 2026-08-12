# Pricing the round trip: a churn cost in the transfer search

**Status: REJECTED. The mechanism works, the churn falls, the points do not
follow. `retentionCredit` ships at 0 and the search is bit-for-bit what it was
before it existed.**

Date: 2026-08-11. Branch `feature/fpl-planner`. Files: `js/engine/transfers.js`,
`tests/transfers.test.mjs`.

> ## 2026-08-11, later the same day: every points table here is VOID
>
> All of these numbers came from replays whose cross-season prior seeding matched
> the two seasons on the archive's raw `name` string, which silently dropped 14
> of 526 returning players entering 2023-24 and 23 of 513 entering 2024-25, along
> with 11,366 and 19,061 of their prior-season minutes. See
> `experiments/cross-season-identity.md`.
>
> **The `+620` in the tables below is void**, and it is the number `registry.md`
> quotes as the reason to distrust instrument 2. Re-measured over the same 45
> paired trajectories, with both join arms run on one frozen tree:
>
> | arm | total | mean | se | t | W / L / T | per season |
> | --- | ---: | ---: | ---: | ---: | --- | --- |
> | corrected join | +574 | +12.8 | 6.3 | 2.02 | 31 / 14 / 0 | +35, +462, +77 |
> | broken join, same tree | +542 | +12.0 | 7.5 | 1.60 | 30 / 15 / 0 | +35, +186, +321 |
> | recorded here, older tree | +620 | +13.8 | 7.3 | 1.88 | 24 / 18 / 3 | -137, +729, +28 |
>
> On this instrument the join fix is worth +32, which is nothing. The distance
> between either new row and the recorded one is mostly the corrected transfer
> state machine, not the join: 2022-23 has no prior season to seed, so the fix
> cannot touch it, and it reads +35 on both new rows against the recorded -137.
>
> The `retentionCredit` sweep itself has NOT been re-run. Its REJECTION is not
> disturbed by this: the sweep was non-monotone across the parameter, which the
> Methodology section already treats as noise dominating, and a better-seeded
> replay does not turn a non-monotone sweep into a result. Anyone re-opening the
> churn cost must re-run the whole sweep on the corrected join rather than read
> the tables below.

## What the question was

`experiments/availability-minutes.md` rejected a real historical availability
signal and named the reason. The signal improved the minutes model on every
prediction metric it has, and the planner still did not gain points, because the
transfer engine reacted to it:

> The signal is retrospective by construction, so it fires the week AFTER a
> player goes down and keeps firing until the week AFTER he returns. A three
> gameweek horizon then values him at almost nothing, the optimizer sells him,
> and when he comes back the planner has to buy him again at full price having
> eaten the spread twice.

Its closing line: "a transfer engine that prices the cost of selling and
re-buying the same player would stop the churn that ate the gain." This
experiment builds that and measures it.

## The formulation, and the one that was measured and discarded first

### Discarded: charge the realised cash spread

The obvious charge is the money FPL destroys on a sale. A player bought at P and
now worth N sells for `P + floor((N - P) / 2)`, so `nowCost - sellingTenths` is
gone the moment he leaves and is only recovered if he is never wanted back. Both
numbers are already in `searchTransfers`.

It was instrumented before it was written, by wrapping the replay's planner
strategy and recording every sale with the squad state it was made from. It
cannot work:

| replay | sales | total spread destroyed | mean per sale | sales destroying nothing |
| --- | --- | --- | --- | --- |
| 2023-24, availability off | 68 | 30 tenths | 0.44 | 50 (74%) |
| 2024-25, availability off | 74 | 44 tenths | 0.59 | 49 (66%) |
| 2023-24, availability on | 70 | 34 tenths | 0.49 | 50 (71%) |
| 2024-25, availability on | 75 | 25 tenths | 0.33 | 59 (79%) |

Three point zero to four point four million destroyed across an entire season,
two thirds to four fifths of sales destroying nothing at all, and the total FALLS
when the injury signal is switched on. The reason is structural: the sell-on fee
applies only to a price RISE, and a player who has just gone down is not rising.
The cash spread is a real cost, it is simply an order of magnitude too small to
be a mechanism, and it is smallest exactly where the churn is worst. Charging it
would have been a random tax on the quarter of sales that happen to involve a
riser.

The same instrumentation confirmed the churn itself is real: 25% to 31% of sales
are re-bought later in the same season.

### Shipped (at zero): `retentionCredit`

The cost that has the right size is not cash, it is the value the horizon strips
off a player the squad already owns.

```
doubt(out) = 1 - availability(out)
churnCost  = retentionCredit * SUM over pairs of
               doubt(out_i) * max(0, value(in_i) - value(out_i))
```

`value` is the pruned discounted horizon value the search already computes.
`availability` comes from `availabilityCeiling` in `minutes.js`, so the charge
reads the same number the projection did rather than duplicating the status
table. `outIds[i]` and `inIds[i]` are the same swap, because every candidate is
built by pairing an outgoing player with a replacement drawn from his own
position's pool.

`value(in) - value(out)` is the entire reason the search wants the swap. If the
outgoing player would rank at or above his replacement when fit, which is the
premise of ever buying him back, then every point of that gap is an artefact of
the doubt. `doubt` is the probability the artefact applies to the gameweek being
decided, so `doubt * gap` is the part of the apparent gain a fit player would
never have handed over, and `retentionCredit` is how much of it the engine
refuses to spend a transfer on.

Three properties that follow from the shape rather than from tuning:

- bounded by the gain, so it can never make a losing transfer look sensible
- zero on the roll, and zero on any candidate that sells nobody doubtful
- zero at both ends of the availability range. A fit player has availability 1
  and needs no protection. A player the game has ruled out has availability 0:
  there is no doubt to be wrong about, and protecting him would be the engine
  refusing to move on from a season-ending injury.

It is charged in `score()` alongside `hitMargin`, and deliberately NOT inside
`xPointsHorizon`, because a decision margin must not contaminate the points
number shown to a user. It is exposed as `churnCost` on every returned plan and
as `TRANSFER_DEFAULTS.retentionCredit`.

## How this was measured

Every number below comes from ONE frozen copy of `js/` and `tests/`, taken at
12:08 on 2026-08-11, because other work in the same branch moved `chips.js` at
11:25 and `projections.js` at 12:04 and a sweep whose baseline shifts halfway
through measures nothing. An earlier sweep run across that boundary produced a
+156 point result on the nine windows that did not survive re-measurement on a
fixed tree; it is discarded and does not appear here.

The frozen copy reproduces all four previously published baselines EXACTLY, which
is what makes it a valid basis:

| baseline | published | frozen tree |
| --- | --- | --- |
| nine chip-free windows, availability off | 6324 | 6324 |
| nine chip-free windows, availability on | 6329 | 6329 |
| full seasons, availability off | 2151 / 1817 / 2371 | 2151 / 1817 / 2371 |
| full seasons, availability on | 2184 / 2093 / 2080 | 2184 / 2093 / 2080 |

All runs are horizon 3 (the shipped default), risk balanced, analytic
projections, no trained artifact.

### The instrument problem, quantified

A single replay is one deterministic trajectory. The previous experiment showed
one forked wildcard diverging a second half by 211 points. Even the nine
chip-free windows are noisier than the effects being measured, and the seed makes
that measurable: holding everything else fixed and running seeds 1, 2 and 3
through the same thirteen gameweek window,

| arm | windows the seed alone moves | mean spread | largest |
| --- | --- | --- | --- |
| availability off | 9 of 15 | 32.1 points | 153 |
| availability on, credit 0 | 10 of 15 | 20.9 points | 61 |
| availability on, credit 0.5 | 10 of 15 | 29.2 points | 127 |

A single window carries roughly 30 points of seed noise, so a nine window total
carries something like 60 to 90. That is larger than any effect this change
produces, which is why a third instrument was added: five SLIDING chip-free
windows per season (gw1-13, 7-19, 14-26, 20-32, 27-38) times three seeds times
three seasons, giving 45 trajectories that can be compared in PAIRS. Paired
differences cancel the window and the season and leave the parameter.

## The parameter sweep

Nine canonical chip-free windows, availability ON, seed 1:

| retentionCredit | 22-23 gw1-13 | gw14-26 | gw27-38 | 23-24 gw1-13 | gw14-26 | gw27-38 | 24-25 gw1-13 | gw14-26 | gw27-38 | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 509 | 767 | 778 | 674 | 704 | 719 | 766 | 793 | 619 | **6329** |
| 0.15 | 533 | 767 | 778 | 674 | 693 | 719 | 766 | 793 | 626 | **6349** |
| 0.25 | 533 | 767 | 778 | 674 | 714 | 648 | 766 | 793 | 626 | **6299** |
| 0.35 | 533 | 767 | 778 | 677 | 714 | 648 | 766 | 793 | 620 | **6296** |
| 0.5 | 512 | 767 | 778 | 675 | 734 | 648 | 766 | 793 | 643 | **6316** |
| 0.6 | 512 | 767 | 778 | 675 | 685 | 648 | 772 | 793 | 630 | **6260** |
| 0.75 | 512 | 767 | 778 | 675 | 671 | 648 | 772 | 793 | 618 | **6234** |
| 1 | 512 | 767 | 778 | 669 | 658 | 648 | 772 | 792 | 618 | **6214** |

Nothing beats zero by more than 20 points, which is inside one window's seed
noise, and everything from 0.25 up is below it. There is no interior optimum to
find. The three values carried into the wider instruments are 0.25, 0.5 and 0.75:
0.25 because it is the smallest setting that changes behaviour at all, 0.5
because it is the midpoint of a bounded parameter and the best of the larger
settings here, 0.75 to establish where the damage starts.

## Protocol A: full season replay, all three seasons, horizon 3

| arm | 2022-23 | 2023-24 | 2024-25 | total | vs greedy-xp | vs hold |
| --- | --- | --- | --- | --- | --- | --- |
| shipped default (credit 0, availability off) | 2151 | 1817 | 2371 | **6339** | +211 | +796 |
| credit 0.5, availability off | 2151 | 1817 | 2371 | **6339** | +211 | +796 |
| credit 0, availability on | 2184 | 2093 | 2080 | **6357** | +375 | +779 |
| credit 0.25, availability on | 2198 | 1944 | 2223 | **6365** | +406 | +787 |
| credit 0.5, availability on | 2239 | 2044 | 2298 | **6581** | +592 | +1003 |

The two baselines behave differently and the difference matters. `hold` makes no
transfers, so the credit cannot touch it, and it does not: 1627 / 1910 / 2006 =
5543 in every availability-off arm and 1617 / 1937 / 2024 = 5578 in every
availability-on arm. `greedy-xp` is this same planner run at horizon 1, so it
goes through the identical transfer search and IS an arm rather than a fixture:
6128 with availability off at either credit, then 5982, 5959 and 5989 with
availability on at credits 0, 0.25 and 0.5. Its "vs greedy-xp" column is
therefore computed against its own arm, not against a fixed number.

Two things are real in this table and one is not.

Real: with availability off, credit 0.5 is IDENTICAL to credit 0 on every season
and every strategy, and identically so window for window on protocol B. No player
in that replay carries a doubt, `doubts` is empty, and the charge is a provable
no-op. Turning the parameter off means nothing happens, not that a smaller
version of it happens.

Real: `hold` moves by +35 across the availability arms and by nothing at all
across the credit arms, which reconfirms that everything else in the table is the
transfer engine.

Not real: the +224 that credit 0.5 appears to add on top of availability. Season
totals are single trajectories, the previous experiment already showed one chip
choice deciding 211 points of a second half, and protocol B does not reproduce
this. It is reported because it was measured, not because it is evidence.

## Protocol B: the nine chip-free windows, and 45 paired trajectories

Nine canonical windows, against the shipped 6324:

| arm | total | vs shipped | wins | losses | ties |
| --- | --- | --- | --- | --- | --- |
| credit 0.5, availability off | 6324 | 0 | 0 | 0 | 9 |
| credit 0, availability on | 6329 | +5 | 3 | 5 | 1 |
| credit 0.25, availability on | 6299 | -25 | 3 | 5 | 1 |
| credit 0.5, availability on | 6316 | -8 | 3 | 5 | 1 |
| credit 0.75, availability on | 6234 | -90 | 2 | 6 | 1 |

Against the availability arm rather than the shipped default, which is the
comparison the change is actually for:

| credit | delta | wins | losses | ties |
| --- | --- | --- | --- | --- |
| 0.25 | -30 | 3 | 1 | 5 |
| 0.5 | -13 | 4 | 1 | 4 |
| 0.75 | -95 | 3 | 3 | 3 |

Credit 0.5 wins four windows and loses one and is still 13 points down, because
the single loss is 2023-24 gw27-38 giving up 71. That is the shape of a change
whose wins are small and whose losses are not, and it is the reason the win count
is reported next to the total rather than instead of it.

45 paired trajectories, each pair the same season, same window, same seed:

| comparison | delta | mean per trajectory | se | t | W / L / T |
| --- | --- | --- | --- | --- | --- |
| availability on vs off, credit 0 | +620 | +13.8 | 7.3 | 1.88 | 24 / 18 / 3 |
| credit 0.25 vs 0, availability on | +84 | +1.9 | 3.5 | 0.53 | 13 / 5 / 27 |
| credit 0.5 vs 0, availability on | -132 | -2.9 | 4.0 | -0.73 | 17 / 13 / 15 |
| credit 0.75 vs 0, availability on | -525 | -11.7 | 4.2 | -2.81 | 13 / 21 / 11 |
| credit 0.5 + availability vs shipped | +488 | +10.8 | 7.6 | 1.43 | 23 / 19 / 3 |

Per season, credit 0.25 against credit 0: +53, -72, +103. Credit 0.5: -8, -175,
+51. Credit 0.75: -23, -424, -78.

The best setting the change has is worth 1.9 points per thirteen gameweek
trajectory with a standard error of 3.5. The windows overlap, so even that t of
0.53 is generous. This is a null result at the best setting and a clearly
negative one at 0.75.

## The availability interaction

This was the point of the exercise: the churn cost exists to make the previously
rejected availability signal usable. It does not.

| instrument | availability alone | availability + best credit |
| --- | --- | --- |
| nine windows | 6329 (+5 vs shipped) | 6316 at 0.5, 6299 at 0.25 |
| full seasons | 6357 (+18 vs shipped) | 6581 at 0.5, 6365 at 0.25 |
| 45 paired trajectories | +620 (t 1.88, 24W/18L/3T) | +84 at 0.25 (t 0.53), -132 at 0.5 |

The availability signal does NOT need the churn cost to look better than it did.
On 45 paired trajectories it is +620 on its own, 24 wins to 18 losses, and per
season -137 / +729 / +28. That is a much more favourable reading than the nine
windows gave it, and it is a finding about the INSTRUMENT rather than about this
change: the previous experiment's "wash, three wins five losses one tie" was
measured with nine samples against roughly 30 points of per-window noise. Nothing
here recommends re-opening that verdict on its own, because -137 in 2022-23 is
still a season going the wrong way, and the decision belongs to whoever owns that
experiment. It is recorded so the next person measuring it uses enough samples.

## Did the mechanism actually fire

Yes, which is what makes this a clean rejection rather than a bug. Credit 0.5
against credit 0, availability on, full season:

| season | flagged sales | round trips | season points |
| --- | --- | --- | --- |
| 2023-24, credit 0 | 26 of 70 | 19 (27%) | 2093 |
| 2023-24, credit 0.5 | 22 of 73 | 16 (22%) | 2044 |
| 2024-25, credit 0 | 16 of 75 | 22 (29%) | 2080 |
| 2024-25, credit 0.5 | 10 of 72 | 21 (29%) | 2298 |

Sales of doubtful players fall by 15% and 38%. The churn the diagnosis pointed at
really does go away. The points go one way in one season and the other way in the
other.

## Why it does not pay, as far as the evidence goes

Two reasons, both visible in the data above.

The charge cannot tell a two week doubt from a season-ending one. The
discriminator would be an expected return date, and the availability report
already established that the only pre-deadline source of one is team news the
model is not allowed to see. So the credit protects the knee-jerk sale and the
correct sale identically, and the two roughly cancel: 13 wins and 5 losses at
0.25 with 27 trajectories untouched, for a net of +1.9 points each.

And the search's score is not the planner's objective. `planner.js` re-scores
every returned candidate under `scoreCandidate` and picks the maximum, so a
charge added inside `searchTransfers` can only change WHICH candidates are
returned, not which of them is chosen. That is a real lever, and it is why the
mechanism fires at all, but it is a blunter one than the arithmetic suggests.
Making the charge decide rather than filter would mean changing `planner.js`,
which this experiment did not own. A future attempt should start there.

## Decision

**REJECT.** `retentionCredit` ships at 0.

Kept, because it is correct, tested and worth being able to reproduce:

- the parameter, its derivation and its bounds, in the `transfers.js` header
- `churnCost` on every returned plan, and `TRANSFER_DEFAULTS.retentionCredit`
  exported for the model-status panel
- six assertions in `tests/transfers.test.mjs` pinning the mechanism at an
  explicit credit, and one pinning that the shipped default leaves the search
  bit-for-bit identical to a run with the parameter forced to zero

Not shipped:

- any nonzero charge on selling a doubtful player

What would change the verdict: an expected return date, which would let the
charge fire only on doubts that are actually temporary; or moving the term into
`planner.js`'s objective so it decides rather than filters. Absent either, this
is a wash at its best setting and a loss at its worst, and an aggregate that
rests on one season's full-replay trajectory is exactly the evidence this project
has twice declined to accept.

## Reproducing

```
node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
FPL_AVAILABILITY=1 node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
```

The chip-free windows are the same replay with `rules.chips` emptied and
`--gw-from` / `--gw-to` set; the sliding-window instrument is the same again over
gw1-13, 7-19, 14-26, 20-32 and 27-38 with seeds 1, 2 and 3. The parameter is
`TRANSFER_DEFAULTS.retentionCredit` in `js/engine/transfers.js`; `planner.js`
passes a fixed whitelist of options into `searchTransfers`, so a sweep sets the
default in the file rather than threading an option through.
