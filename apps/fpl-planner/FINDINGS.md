# FINDINGS - FPL Planner

Accumulated engineering knowledge for this app: discoveries, root causes,
quirks, constraints, decisions and regression risks that a future session would
otherwise rediscover the hard way. This is a LIVING document, not a diary:
rewrite sections when the truth changes, merge duplicates, delete what stops
being true. `README.md` (beside this file) says what the app is and how it
works; this file says what we learned building it.

Experiment history with verdicts lives in `experiments/` (`registry.md` is the
index; its Methodology section is REQUIRED reading before any planner or model
experiment). This file summarizes and points at it rather than duplicating the
tables.

---

## The verification lesson (read this first)

The app shipped with thousands of passing tests and three serious bugs an owner
found by clicking around for minutes. All three shared one cause: **every test
compared the system to itself.** Snapshot legality tests (squad legal,
affordable, within limits) pass happily on a wrong premise, because they
inherit it.

| Bug | What tests checked | What nobody checked |
| --- | --- | --- |
| Free transfers showed 5 pre-season, off-by-one all season | plan legal given the state | whether the STATE was right |
| Counterfactual "beat" the recommended squad | each optimizer returns a legal squad | that two paths answering one question AGREE |
| Cross-season join on `element` ids | the join produced rows | that the rows were the SAME PLAYER |
| pStart pinned at 1.000 for most of every replayed season | 0 <= pStart <= pAppear <= 1, exhaustively | that the number was ever anything but 1 |
| 2022-23 replayed as a league with no starters | the column parsed, the season replayed | that a season contains 8,360 starts |
| The season-statistics rollover collapses every projection | every projection is a finite number | that a gameweek total was ever near 50 rather than 20 |

The last two are 2026-08-12 and they are the same joke as the first three: the
whole suite passed, because a probability of exactly 1 is a legal probability.
The class is **a quantity nobody ever checks for VARIATION**, only for legality.
A constant is legal.

The test classes that catch this, all present and to be maintained:

1. **Sequence tests**: state evolution across gameweeks (`tests/transfer-state.test.mjs`, 22 walks).
2. **Cross-feature agreement**: one question via two paths must agree (`tests/optimizer-consistency.test.mjs`).
3. **Ground-truth joins**: identity verified empirically, wrong keys refused (`tests/player-identity.test.mjs`).
4. **Target correctness**: validate a model against the thing it predicts (see pStart below).
5. **Arithmetic of the sport**: a club fields eleven, a player cannot start more
   matches than he was present for (`tests/replay-evidence.test.mjs`). Both are
   facts about football that no amount of internal consistency can supply.

Raw test count is not evidence of correctness. Do not report it as if it were.

## FPL rules and API facts (verified against live data)

- **The API is fully public.** No key, no registration, no terms-acceptance
  flow, no robots.txt on the host. The authenticated `my-team` endpoint (exact
  selling prices, FTs) needs the user's FPL password; deliberately not built,
  and absent from the proxy allowlist so it cannot be reached.
- **No CORS headers at all**, verified with a real browser origin. A browser
  cannot call the API directly; the Netlify proxy is the only working path.
- **Free transfers**: unlimited before the GW1 deadline (a state, not a
  number), then 1 per gameweek, roll to a cap of 5, hits 4 points each.
  Wildcard and free-hit weeks make that week's transfers free WITHOUT spending
  the banked count. `js/engine/transfer-state.js` is the single owner of this
  arithmetic; the off-by-one that lived in scattered copies (seeded ft=1
  BEFORE gameweek 1) contaminated every replay until 2026-08-11, and the
  pre-season branch returned the CAP (5) as if it were a current value.
- **Not in the payload, hardcoded in exactly one documented place each**
  (`rules.js`): the 4-point hit, the defensive-contribution thresholds (DEF 10,
  MID/FWD 12), the saves-per-point divisor (3) and goals-conceded divisor (2).
  Everything else, including the full scoring table and chip windows, is read
  from `bootstrap-static`.
- **Chips come twice** in the CURRENT season: 8 entries, one per half-season.
  Wildcard and free hit are NOT legal in GW1 (windows open GW2); bench boost and
  triple captain are. Always route through `chipAvailableAt`. That doubling
  arrived in 2025-26: 2022-23 through 2024-25 had two wildcards but one free
  hit, one bench boost and one triple captain, and the replay scores those
  seasons under their own catalogues via `historicalRules` in
  `scripts/backtest.mjs` (registry entry 14), along with the era's 2-transfer
  bank, chip weeks not banking, and 2022-23's unlimited-transfer World Cup week.
- **Defensive contribution composition differs by position**: DEF = CBIT +
  tackles; MID/FWD = CBIT + recoveries + tackles; GKP none. Verified against
  live per-player sums.
- **`entry/{id}/transfers` is served newest-first.** Never assume order.
- **`entry_history.value` includes the bank** (self-consistent in fixtures;
  unverifiable against a live mid-season team until GW1 is played;
  affordability never depends on it, only display).
- **Pre-season quirks**: every event has `is_current: false` (so
  `currentEvent === null` is normal), `cost_change_start` is 0 for everyone
  (live data cannot exercise purchase/sell divergence; fixtures inject it),
  picks 404 for every team, and `bootstrap-static.elements` carries LAST
  season's full totals, which is the pre-season feature base.
- **Selling price** is `purchase + floor((now - purchase)/2)` when the player
  rose, `now` when he fell. `now_cost` is never the sell price.
- **The pre-season payload publishes ZERO for every per-venue strength field.**
  Measured on the live 2026/27 bootstrap on 2026-08-14: `strength` is `null` and
  `strength_attack_home/away` and `strength_defence_home/away` are `0` for all
  twenty clubs. Only `strength_overall_home/away` carry signal, as a 1-5 tier.
  `normalize.js` reads exactly those two and nothing else, so the zeros reach
  nobody - but any future code tempted by the per-venue fields would silently
  divide by zero for the whole of pre-season.
- **`entry/{id}` resolves for a 2026/27 team before GW1 while every scoring
  field is `null`** (`summary_overall_points`, `summary_overall_rank`), and
  `entry/{id}/history` returns `{current: [], past: [], chips: []}` with
  `transfers` an empty array. `started_event` is present and is the honest way
  to tell a late joiner from a manager whose picks simply have not published
  yet - the app does not use it today, so both land on the draft path.
- **The live 2026/27 pool is 587 elements**, against the 320 in the committed
  sample dataset. Anything that reasons about "a live season" from the sample
  is reasoning about a pool 45% smaller; see the plan-time note under Optimizer.

## Cross-season player identity (critical)

- **FPL reassigns `element` ids every season.** Measured: of element ids shared
  by two consecutive seasons, **0.0 to 0.13%** are the same footballer. A join
  on `element` across seasons matches noise (it produced a start-rate
  persistence slope of 0.017 where the truth is about 0.69).
- **`code` is the permanent id**, verified stable across all four held seasons
  (89.7 to 97.3% identical names on shared codes; the residual is
  name-formatting drift, not identity error).
- **The per-gameweek archive (`merged_gw.csv`) does not carry `code`.** The
  identity table comes from each season's `players_raw.csv`
  (`scripts/fetch-history.mjs` downloads it; `js/engine/player-identity.js`
  builds the index). `assertCrossSeasonField` THROWS on any season-scoped key
  (`element`, `id`, `player_id`, ...) rather than warning, because the failure
  mode is a full table of plausible wrong numbers.
- Name matching, where unavoidable (API-Football joins), uses a
  club-constrained ladder requiring a UNIQUE candidate at each rung, with
  accent folding including letters NFD cannot decompose (o-slash, ae,
  eszett...). Unmatched falls back to assumed-fit, never to unavailable;
  ambiguity ("Gabriel" at Arsenal) is never guessed. Match rates 94.6 to
  99.0% per season.

## The measurement instruments (before ANY planner experiment)

Ranked in `experiments/registry.md` Methodology; the short version:

1. **One full-season replay: sanity check only.** One forked chip cascades
   through everything after it (a moved wildcard swung a half-season by 211).
2. **Nine chip-free windows** (3 seasons x 3 splits): better; still one seed,
   and seed alone moves 9-10 of 15 windows by 21-32 points.
3. **Paired trajectories READ AS WINDOWS** (5 sliding windows per season, each
   at 3 seeds, chips off, arm paired against control per trajectory): the
   decider. Counts derive from `KNOWN_SEASONS`; on the current FOUR seasons
   (2025-26 qualified 2026-08-12, registry entry 15) that is 20 window
   observations and 60 paired trajectories.

**`scripts/experiment.mjs` runs instrument 3 in three to four minutes** on eight
workers, writes a markdown report with the statistics and the per-window table,
and fingerprints the engine, scripts and season data before AND after the run so
a tree that moved underneath an experiment is reported as void rather than
reported. `experiments/configs/null-arm.mjs` runs two identical arms and must
report exactly zero on every trajectory (60 on the current four-season
configuration); run it after touching the runner or the replay. There is deliberately no way to compare against a stored baseline:
the control arm is re-measured every time.

**Average the seeds inside a window before counting anything.** Three seeds
through one window are the same thirteen gameweeks with the same fixtures,
prices and injuries; only the search RNG differs. Pairing removes that noise,
which is what it is for, but it does not make three correlated replays into
three observations. Counting them separately triple-counts any effect that
lands in one window. That is not hypothetical: it is the whole difference
between the availability signal reading t 1.51 (27W/15L) and t 1.06 (7W/7L/1T)
on the same 90 replays.

**Check that the instrument can represent what the change does, before
measuring the change.** The availability signal is a minutes signal and was
measured three times, across four sessions, against a replay whose pStart was
pinned at 1.000 for most of every season. Two of those rounds measured nothing.

Never decide on a weaker instrument when a stronger reading exists; never pick
the best cell of a non-monotone sweep (that is fitting noise); always re-measure
the control arm on your own tree.

**Prediction metrics decide nothing.** FIVE separate changes improved log loss /
Brier / calibration / bias and none improved planner points: the trained start
calibrator (cost 160 and 90 points in two leakage-free replays; shipped disabled
via `engineConsumes: []`), the availability signal (7 wins 7 losses on the
deciding instrument), rate shrinkage alone (a wash until paired with the
zero-minutes fix), the ownership-conditioned start prior (+2.9 a window, t 0.37),
and the assist-ratio correction (bias improved 2.3 points a gameweek, planner
LOST 10.4 a window, entry 12). Historical FPL points from the complete planner
are the only accepted arbiter; the base rate for "better metrics, better team"
in this project is zero for five. The sharpened form of the lesson, from entry
12: an aggregate gap sits mostly on the LEVEL, the level cancels out of every
ranking, and only the part of a correction that changes ORDER changes decisions
— so ask what a candidate does to order before running it.

## Optimizer

- **The builder and every comparison share one objective** (`squadObjective`).
  It used to maximize a different quantity than the counterfactual compared
  with, and the counterfactual compared a STORED squad against a FRESH search,
  producing "recommended 131.9" above "with Haaland 134.1" on screen. Both
  sides are now rebuilt in the same call from the same snapshot;
  `optimizer-consistency.test.mjs` asserts forced-inclusion can never beat
  unconstrained (verified: 25 forced builds across 6 player classes, zero
  violations).
- The squad search is a seeded heuristic (greedy construction, 1/2-swap
  descent, swap CHAINS for premium inclusion, a counterfactual challenge pass,
  restarts). Chains matter: fitting a premium needs several coordinated
  downgrades and every intermediate state is worse, so 1-swap search cannot
  cross that valley. Full build ~1.8s; `buildPlan` median ~190ms at horizon 3.
- **The performance budget was measured on a fixture 45% smaller than the live
  season, which hid the production-sized problem** (found 2026-08-14, addressed
  2026-08-15). The committed sample carries 320 players; the live 2026/27
  payload carries 587, and plan time does not scale linearly, so
  `perf-budget.test.mjs` could pass comfortably while the real thing was over
  budget. Its comment claiming the sample was "the same size as a live season"
  is what made that invisible.

  **Current measurements** (2026-08-15, live payload, CPU time, best of three;
  CPU rather than wall because `npm test` runs suites in parallel and wall time
  then measures the machine):

  | path | CPU | wall | budget |
  | --- | ---: | ---: | ---: |
  | sample in-season h5 (the old reference) | 2246 ms | 2158 ms | - |
  | live pre-season opening build h5 | 4460 ms | 3481 ms | 8000 ms |
  | live pre-season opening build h8 | 7785 ms | 5895 ms | 8000 ms |
  | live in-season h5 | 4855 ms | 4024 ms | 5000 ms |
  | live in-season h8 | 8516 ms | 7388 ms | 16000 ms |

  `perf-live-size.test.mjs` now measures a pool expanded to the live count so a
  regression at production size is visible; the opening build carries its own
  budget because a fifteen-man search is a heavier operation than the transfer
  path and inheriting the other number would not be honest. Expand the pool from
  the CHEAPER half of the sample: cloning across the whole price range
  manufactures premiums and makes the search about twice as hard as reality.

  **These numbers are this machine's, and that is a trap the budgets fell into.**
  Every budget above was derived here, all of them passed here, and four of them
  then failed on the GitHub runner (2026-08-15, PR #380): the sample plan at
  6197 ms of CPU against 5000, its wall-clock twin in `invariants.test.mjs` at
  5216 ms, the live-sized opening build at **11114 ms** against 8000, and the
  live-sized plan at 5772 ms. Nothing was slower than designed; the runner is
  slower per core. Pinning cores locally (`taskset -c 0,1`) does NOT reproduce it
  - the whole suite still passes - so a budget cannot be validated by narrowing
  this machine, only by watching CI. The budgets were re-derived from those CI
  observations with the ~1.65x headroom the policy in `perf-budget.test.mjs`
  already described, which is the same thing PR #374 did when it moved 3000 to
  5000.

  The number worth carrying forward is the 11 seconds. On hardware in the
  runner's class, building the opening fifteen costs on the order of eleven
  seconds of CPU. It runs in a Web Worker behind a loading state so nothing
  freezes, but that is what a manager on a slow phone waits in the week before
  GW1. It is a candidate for the post-GW1 optimisation round, alongside chip
  gating, and deliberately not something to tune during a release.

  **No optimisation was made, and the improvement was not one.** The audit
  measured live in-season h5 at 7269 ms; it is now 4855 ms because the B1 fix
  changed the projections the search runs on (start rates are no longer pinned
  at 1.000), not because any planner code got faster.

  B1 moves plan time in BOTH directions, and on the committed fixture it moves
  it up. Measured on the same machine, master against this branch:

  | apps/fpl-planner/data/sample | start rate median | pinned at 1.000 | wall | CPU |
  | --- | ---: | ---: | ---: | ---: |
  | before `seasonEvidence()` | 1.000 | 208 of 320 | 1157 ms | 1376 ms |
  | after | 0.508 | 0 of 320 | 2312 ms | 2468 ms |

  Two thirds of that pool used to be certain starters, which is a strictly
  easier problem than the real one, so roughly double the CPU is the price of
  not projecting every player as an ever-present. This is the direct cause of
  the CI budget failures above: the budget was calibrated against the degenerate
  workload. The stage profile that
  motivated a chip-gating change still stands - `evaluateChips` was 5543 ms of a
  7918 ms plan, two unconditional full squad rebuilds - and gating it is
  deliberately NOT done: it can change which chip clears its bar, and that is a
  measurement to make after GW1 rather than a last-week production tweak. Note
  also that wildcard and free hit are illegal in GW1, so the opening gameweek
  never pays for those two rebuilds at all.
- **A search limit must never be written into game state.** The manual
  pre-season squad hardcoded `freeTransfers: 2` "because the search only
  enumerates two moves"; same bug class as the FT=5 display. The reach of the
  search belongs in on-screen copy, never in state downstream code reads as
  fact.
- `validate.js` keeps its own independent accounting on purpose; routing it
  through the modules it checks would make the verifier tautological.
- **The horizon default is 5** (2026-08-12, registry entry 9). It was 3 for two
  days on evidence that has been withdrawn twice over: the first justification
  was an artefact of the free-transfer bug, the second was measured on a replay
  whose pStart was pinned at 1.000. On the then-15-window instrument, horizon 5 beats 3 by +21.6 a
  window (t 2.32, 11-4-0, positive in all three seasons) and horizon 8 beats 3
  by less, so 5 is an interior optimum. Three constants must move together:
  `planner.js DEFAULT_HORIZON`, `lineup.js DEFAULT_HORIZON` and
  `store.js DEFAULT_SETTINGS.horizon`; tests now assert the EQUALITY rather than
  the literal, and that the default is one of the values Settings offers (a
  default outside `HORIZON_CHOICES` renders a select with nothing selected and
  the browser silently substitutes the first option). It roughly doubles plan
  time, to about 1.1s on the sample dataset, inside a Web Worker.

## Minutes and projections

- **pStart's target is the NEXT FIXTURE, not a season rate.** Validating
  against next-season full-season start rate understates it badly: 90%+
  starters average ~76% of the following SEASON but start **88.2% / 82.9%** of
  the following GW1s (the two clean transitions). The pre-season model's 85.2%
  for a nailed starter is correct against the right target. Do not re-litigate
  it with the wrong one.
- **THE SEASON-STATISTICS ROLLOVER IS A GUARDED SEAM** (found 2026-08-14, fixed
  2026-08-15). A start rate is `starts / matches`: the numerator is a season
  total on `bootstrap-static.elements`, the denominator is the count of finished
  fixtures, and FPL rolls the two over at DIFFERENT moments. Around the first
  gameweek they therefore describe different seasons, and reading them together
  is silently wrong in both directions:

  | payload state | fixtures finished | what it used to produce |
  | --- | --- | --- |
  | last season's totals | 0 | correct: pStart median 0.53 |
  | last season's totals | 1 | pStart median **1.000**, 73% of the pool pinned |
  | totals cleared | 0 | xP median halved, a **20-point** gameweek, a **goalkeeper captain** |

  Neither failure is visible from legality: 1.000 is a legal probability and a
  collapsed projection is a finite number, so the whole suite stayed green
  through both.

  **`seasonEvidence()` in `minutes.js` now classifies the payload** from an
  arithmetic fact about the sport rather than from a date or a gameweek number:
  a player cannot have started more matches than his club has played. It returns
  `previous-season` (measure over `rules.totalEvents`), `current-season`
  (measure over matches played) or `none`, and `teamMatchesPlayed` is that
  classification rather than a fixture count read in isolation. A payload with
  no evidence at all reaches the UI through `dataStatus.evidence` and the plan
  is **withheld** rather than presented, for the same reason a plan built on
  stale injury news is. `scripts/evidence-probe.mjs` prints the classification
  and the two quantities that show whether it landed, against the live proxy or
  a captured payload.

  The regression invariants, in `tests/season-rollover.test.mjs`, are about
  MEANING rather than legality: start rates must VARY (a pinned pool is legal
  and wrong), a legal eleven must project 30-100 points, and the captain must
  not be a goalkeeper, which is what a collapse to appearance points produces.

  **What remains genuinely unobservable** is FPL's own timing: when it clears
  the element totals relative to the first finished fixture. That does not need
  observing, because both orderings are handled and neither needs a code change;
  `GW1-RUNBOOK.md` records which way it actually went.
- **Whoever builds the numerator owns the denominator.** A start rate is starts
  over MATCHES, and on a live payload there is only one kind of match, because
  FPL resets element totals every August. A caller that assembles totals from
  more than one season must declare `evidenceMatches`; `minutes.js` falls back
  to counting this season's matches when the field is absent, which is what
  keeps production behaviour unchanged. The replay did not declare it until
  2026-08-12, so it seeded half of last season into the numerator and none into
  the denominator: **pStart 1.000 at the median AND the 90th percentile of the
  owned pool through gameweek 10, every position prior pinned at 1.000, and 57%
  of the pool still clamped at gameweek 20**. Corrected, median pStart sits at
  0.57-0.61 and the 90th percentile at 0.82-0.86 all season. Worth +1253 points
  over the then-45-trajectory instrument with the starts fix; see
  `experiments/replay-evidence.md`.
- `START_RATE_SHRINK_MATCHES = 6` serves BOTH cross-season (pre-season) and
  within-season evidence. Still an open design question, but it is now a
  MEASURABLE one: `opts.priorSeasonWeight` on the replay is the weight the
  previous season carries into both sides of the rate, so a sweep over it is a
  legitimate experiment rather than a numerator-only distortion. Any
  multi-season feature work must ride on `code` identity.
- **The engine UNDER-projects, by 4 to 15 points a gameweek depending on the
  season** (`projectionBiasExAutosubs` reads -14.6 / -3.9 / -8.2 at the shipped
  horizon; the raw `projectionBias` is 3 to 4 worse because it charges the model
  for auto-substitution recoveries its headline number deliberately does not
  claim). The old near-zero bias was two errors cancelling: pStart pinned at 1
  inflated every projection and the mechanism below deflates it.

  **Where the bias lives depends on which population you ask, and the two
  answers are different.** Measured over 9,727 projected player-gameweeks of
  2024-25, leakage-free:

  | quantity | predicted | observed |
  | --- | ---: | ---: |
  | points per 90, among players who actually started | 3.825 | 3.823 |
  | pStart | 0.532 | 0.565 |
  | xMins | 48.5 | 50.5 |
  | xPoints | 2.054 | 2.209 |
  | top 11 by projection, per gameweek | 52.2 | 57.5 |

  **POOLED over the whole projected pool**, the points-per-90 model is
  calibrated to three decimals and the aggregate bias is minutes: pStart is 3
  to 5 points of probability low in every decile from the second up.

  **In the TOP PROJECTION DECILE**, which is where transfers, captains and
  premium holds are decided, the opposite: expected minutes are within 1%
  (75.9 predicted against 76.8) and POINTS are 7.6% low (4.178 against 4.494).
  A pooled per-90 that averages to zero across a gradient — over-projecting the
  bottom decile, under-projecting the top — is exactly what hides this. Do not
  quote the pooled 3.825-vs-3.823 as proof the rate model is fine for the
  players that matter; it is proof only in aggregate.

  **The mechanism is the shrinkage TARGET, not the shrinkage.** `baseStart` is
  pulled toward the position's league-wide start rate, measured over every
  player with a minute to his name. The pool the planner actually projects is
  the 260 most-owned, whose true start rate is well above that average, so the
  pull is downward for essentially every player it evaluates and never
  disappears: the weight caps out around 0.86, leaving 14% on a target that is
  0.17 too low, which is the -0.033 observed. Removing shrinkage fixes the bias
  (-0.004) and wrecks everything else (log loss 0.64 against 0.55), so the
  answer is a better target rather than less shrinkage. Conditioning the target
  on ownership quartile within position, which is public pre-deadline
  information the pool is already selected on, removes most of it: bias -0.033
  to -0.008 in 2024-25 and -0.019 to +0.003 in 2023-24, with Brier and log loss
  improving in all three seasons and 2022-23 overcorrecting to +0.025.

  The obvious objection is that conditioning on ownership must help when the
  pool is SELECTED on ownership, so it was also scored over every player with
  history rather than the pool. It still wins there (Brier 0.1566 to 0.1542, log
  loss 0.4780 to 0.4696, ECE 0.0338 to 0.0240), and the flat prior's bias there
  is +0.023, the opposite sign from its -0.033 on the pool. A target that is too
  high for fringe players and too low for owned ones is an unconditional target,
  not a wrong one, which is what makes conditioning the fix rather than a tweak.

  **The obvious fix was built, measured and REJECTED** (registry entry 10), and
  the way it failed is the useful part. Conditioning the target on ownership
  quartile is worth +2.9 points a window, t 0.37, seven wins to eight, with one
  season 4-11 against. The argument for it was that under-projection makes the
  engine too timid at its ABSOLUTE thresholds (a hit must beat 4 points, a
  wildcard 12), so correcting it should buy more hits. Hits went DOWN, 6 to 2,
  and projection bias closed by 0.8 points of the 8 it was supposed to close.

  **A shrinkage target only matters in proportion to `1 - w`, and `w` is large
  exactly for the players who make the eleven.** An established starter carries
  19 to 38 matches of evidence and barely feels the prior; the players a better
  target moves are the low-evidence ones, who are not in the team. Repricing the
  squad's fringe does not move the squad's spine.

  **So the open question is relocated, not answered.** The top decile of
  projections is 7.6% low on POINTS while its expected minutes are within 1%
  (4.178 projected on 75.9 minutes against 4.494 on 76.8). Whatever is missing at
  the top of the market is not minutes. The next hypothesis is the per-90 RATE
  shrinkage: an elite player's rate is pulled toward his position's by the same
  empirical-Bayes k, and while a midfielder's expected goals uses a weak k of 3.7
  nineties, bonus uses 19 to 24. Look there before looking at minutes again.
- **Zero-minutes players used to get pStart up to 0.78 from PRICE alone**, and
  unshrunk per-90 rates gave a 2-minute cameo 19.9 projected points. The two
  defects masked each other (each fix alone measured as a wash; together +78
  on the nine windows). Shipped: empirical-Bayes shrinkage (k derived from
  between/within variance, never tuned on seasons) plus
  `NO_HISTORY_PRIOR_MATCHES`. Zero-minutes calibration went from a 2.49x
  overshoot to 0.84x. GW1 is untouched by construction (decay weight is
  exactly 1 with no match played).
- **The 2022-23 archive has NO `starts` column for gameweeks 1 to 15**, and a
  correct one from 16. Not "partly populated": exactly zero, because FPL added
  the field mid-season. Summed per season, `starts` is 8,360 in 2023-24,
  2024-25 and 2025-26 (11 x 2 x 380, exactly) against 5,368 in 2022-23. Left
  alone it inverts the model: no starts means no starters, every minute is read
  as a substitute minute, and the whole division comes out at pStart 0 with
  pAppear near 1. `reconstructStarts` in `backtest.js` fills the gap with the
  eleven highest-minute players per club per fixture, which is 98.66% and 98.64%
  row-accurate against the two seasons that carry the truth and exact on the
  count. It runs only where a gameweek has minutes and no starts at all, so real
  data is never overwritten.
- **2022-23 has no gameweek 7 at all.** The round was postponed after the death
  of Queen Elizabeth II and the fixtures were rescheduled, so the archive has no
  rows and the replay scores it as a blank for all twenty clubs. That is
  correct, not a data defect. It also means that season has 37 scoring
  gameweeks, which is why its totals sit below the other two.
- **2025-26 is a replayable season** (registry entry 15): complete, exact
  points reconstruction including defensive contribution, 534/534 returning
  players on `code`, rules pinned in `historicalRules` (two chips of each per
  half, GW19/GW20 boundary) so a future fixture refresh cannot silently change
  its replay. Its ten byte-duplicate archive rows are dropped at load by
  `buildDataset` (a player plays a fixture once; double gameweeks have distinct
  fixture ids and survive). Its like-for-like projection bias, +2.1 a gameweek,
  is the best-calibrated of the four seasons.
- Historical data: xG/xA/`starts` do NOT exist before 2022-23 (hard floor),
  and **within 2022-23 they exist only from gameweek 16**: the payload change
  that added `starts` mid-season added the expected_* columns in the same
  release, so gameweeks 1-15 carry zeros for all of them. Starts are
  reconstructed (a club fields eleven); xG cannot be, so those minutes are
  excluded from the xG/xA DENOMINATOR instead (`xMinutes` on the accumulator,
  `xNineties` as the rates' own evidence weight in `shrinkRates`). Before that
  fix the replay read Haaland's mid-2022-23 xG/90 as 0.369 against a
  covered-minutes truth of 0.723, and 2022-23's totals seeded 2023-24's replay
  with the same understatement. Worth +387 on the deciding instrument
  (+231 / +156 / +0 by season; 2024-25 is bit-identical, which is the control).
  Predictive returns saturate at ~2 seasons; 2022-23 survives only under
  recency decay (weight 0.016). Do not download older seasons.
- Archive duplicates are DOUBLE GAMEWEEKS (distinct fixture ids, preserve)
  except 10 byte-identical rows in 2025-26 GW1-8 (0.011%, dropped at ingestion
  by `dedupeRows`, which must keep the DGW pairs).
- **Defensive-contribution columns exist from 2025-26 and only from 2025-26**
  (`clearances_blocks_interceptions`, `recoveries`, `tackles`,
  `defensive_contribution`). The replay hardcoded them to zero with a comment
  saying the archive did not carry them, which was true when written and stopped
  being true when the season turned over. Fixed 2026-08-12: they are parsed,
  accumulated and published with a per-90, and a season without the columns
  reports zero exactly as before (the three seasons in use replay bit-identical,
  2209 / 2208 / 2453). It matters for anyone adding 2025-26 as a fourth season:
  its actual points INCLUDE defensive contribution on about one played row in
  eight, so projecting zero would under-project the archetype the rule exists to
  reward.
- **`scripts/validate-history.mjs` checks the archive against facts from outside
  it** and would have caught both 2026-08-12 defects in seconds: a season
  contains 11 x 2 x 380 starts, a row's points rebuild from its own components
  under the scoring table, `players_raw.csv` must exist for `code` joins, and
  duplicates are classified as double gameweeks or as real duplicates. Run it
  after `fetch-history.mjs` and when a season rolls over. It is a script rather
  than a test because the archive is gitignored and machine-local.
- **The scoring table in `tests/fixtures/bootstrap.json` is correct for every
  season in use.** Rebuilding each played row's `total_points` from its own
  components matches at **100.00%** on 2022-23, 2023-24, 2024-25 and 2025-26
  (11,345 / 11,384 / 11,566 / 11,498 rows). That also verifies the two
  thresholds `rules.js` hardcodes, DEF 10 and MID/FWD 12, against 11,498 real
  defensive-contribution awards, and the saves-per-point and goals-conceded
  divisors. A projected-versus-actual gap is therefore never the scoring table.
- The AM (assistant manager) rows in 2024-25 poisoned training: 322 rows, zero
  minutes, points from `mng_*` columns no other season has. They, not model
  weakness, made v1's points model "lose" to its baseline. Non-footballers are
  excluded and season-specific columns are schema-guarded
  (`SEASON_SPECIFIC_COLUMNS` in `scripts/train-model.mjs`).

## Shared infrastructure, discovered during this app's build

- **Gitignored build output is a blind spot of diff review, and it bit this
  app** (2026-08-12). Rising Shows and Gym Tracker generate ~35,000 static
  pages at Netlify DEPLOY time (`npm run build:site` in netlify.toml), each
  carrying a cross-app footer. The footer templates were correctly updated for
  this app, but (a) the machine-local generated pages stayed stale until
  regenerated, (b) the templates hand-duplicated the app list in TWO files
  with a "keep in sync" comment, and (c) no test read them - so the owner
  found a live page advertising an app inventory without this app on it after
  three "production-ready" audits had passed. The audits failed because they
  verified the DIFF and the tested surfaces, never a rendered SIBLING page,
  and generated output is invisible to `git diff` by construction. Fixed by
  `assets/apps-manifest.json` as THE canonical app list, both generators
  rendering from it, and registry-to-render invariants in
  `sync-system/tests/app-naming-consistency.test.mjs` (manifest == apps/
  directories == tested surfaces == generated footers). Adding the NEXT app
  fails tests until the manifest is updated, and the manifest update flows to
  every generated page at the next deploy.


- `assets/css/main.css` paints `button { color:#555 !important }`, a red
  `button:hover` AND a red `input[type=text]:focus` box-shadow. Every
  interactive element needs counter-pins verified by computed style, never by
  eye. `--text-faint` here is `#77869a` because anything darker fails WCAG AA
  on its five surfaces; the lightest surface is the binding one. EVERY NEW
  BUTTON CLASS inherits the generic `--text` pin; a button that should read
  quieter (table sort headers) needs its own explicit pin in the counter-pin
  section or it silently renders full-brightness.
- **main.css also uppercases headings site-wide.** The app's `h1-h4` reset
  (`text-transform: none` on the root wrapper) is what keeps "FPL Planner" and
  every card heading in the case it was written in; before 2026-08-12 the
  landing rendered fully uppercase without anyone noticing, because nobody had
  written a heading whose case mattered. Labels that ARE uppercase (card
  heads, stat keys) set text-transform themselves.
- **Site chrome z-index registry** (from main.css): header 10001, sync modals
  10002-10003. An app-level modal (the player drawer) must sit ABOVE 10003 or
  its top edge renders underneath the fixed header; the drawer overlay uses
  10010. First attempt used 1200 and the drawer title was invisible on every
  viewport, found only by screenshot.
- **In-app sticky bars must be near-opaque.** `backdrop-filter` is skipped by
  headless Chromium (and some engines), so a translucent sticky topbar lets
  content bleed through the bar exactly where screenshots are taken. The
  topbar uses a 97%-opaque background with blur as progressive enhancement.
  On phones the identity+stats+tabs block is too tall to pin, so it goes
  `position: static` under 640px.
- **Modal overlays lock the page through `ui/scroll-lock.js`**, never their own
  way. A `position: fixed` overlay does NOT stop the document behind it from
  scrolling; the shipped drawer scrolled the background until the fixed-body
  lock landed (pin body at `-scrollY`, compensate the vanished scrollbar with
  body padding, restore inline styles + `scrollTo` on release; reference-
  counted so re-entrant opens cannot unlock early). Two adjacent traps found
  while verifying: `focus()` on close scrolls the trigger into view and undoes
  the restored offset (always `focus({ preventScroll: true })` around a lock),
  and Space on a focused close button ACTIVATES it - a probe that "tests
  keyboard scrolling" by pressing Space on a button is testing button
  activation. In-page popup lists (combobox, pre-season search results) are
  not modals: they keep the page scrollable but carry
  `overscroll-behavior: contain` so their boundary never chains a fling into
  the page.
- **The app has two marks, on purpose** (owner-supplied art, 2026-08-12):
  the shield-and-ball at `images/fpl-planner-icon.png` is the favicon (chosen
  because it stays legible at 16px) and the tactics-board at
  `images/fpl-planner-logo.png` is the logo on apps.html (the owner's pick;
  it mushes at tab size). Both were cropped from larger uploads to their
  rounded tiles with transparent corners and palette-quantized (11 KB / 3 KB);
  the originals are deleted, so edits mean re-cropping new art, not tweaking
  a source file.
- **Emphasized sentences are multiple inline nodes, and flex containers wedge
  them apart.** `parts.js emphasize()` splits an engine sentence into text
  fragments and `<strong>` spans; any list item styled `display: flex` with
  `gap` then inserts that gap between EVERY fragment ("Gameweek 13 ." with a
  space before the period). Containers that hold emphasized prose use block
  flow with an absolutely positioned bullet, never flex-with-gap. Bit the
  "why not" evidence bullets on 2026-08-12, visible only in a rendered
  screenshot.
- **UI charts are hand-rolled HTML/SVG** (`ui/charts.js`): single accent hue,
  thin marks, hairline solid grid, hover/focus tooltips, and every charted
  value also printed as text nearby (the history table, the future card's
  per-GW columns, the drawer's per-GW rows), so no number is tooltip-gated.
  SVG lines use `preserveAspectRatio="none"` + `vector-effect:
  non-scaling-stroke`, with dots and labels as HTML overlays so nothing
  distorts when the container resizes.
- Shared-UI scoping is enforced by
  `sync-system/tests/shared-ui-consistency.test.mjs`: app styles on the ROOT
  WRAPPER div, page tokens on the body class, never style shared chrome.
  `fpl-planner` must stay OUT of `LEGACY_BODY_SCOPED`.
- **Account deletion ordering is a safety property** (site-level, in
  `sync-system/app-sync-init.js`): reauthenticate FIRST (fail closed), STOP
  SYNC before deleting (an attached onSnapshot reads a vanishing doc as "cloud
  empty" and re-uploads local data, undoing the delete), then data, local,
  credential LAST. Namespaces come from `getSyncNamespaces()` (derived from
  `APP_SYNC_CONFIG`, never a second list). Two stores live OUTSIDE
  `users/{uid}` and are handled explicitly: the root user doc (Arena trivia
  fields) and the MapTap network identity. Firestore rules forbid the owner
  deleting Arena leaderboard/H2H/daily/chat rows; `privacy.html` says so and
  must keep saying so.
- **`privacy.html` is BINDING for this app**: exactly one analytics event
  (plan calculated: duration + model version; never the team id, squad or
  transfers), the browser never contacts FPL directly, the proxy keys no
  per-browser identifier, and the two deletion controls do exactly what the
  page says. Code changes touching any of those must update the page in the
  same change, and vice versa. Netlify log retention: only the function-logs
  figure is documented upstream (at least 24h, 7 days on some paid plans); no
  figure exists for general access logs, so none is claimed.
- `netlify dev` listens on TWO ports; only the Netlify port (8888, pinned in
  netlify.toml) routes functions. The internal static port (commonly 3999)
  404s every function call, then the direct fallback dies on CORS. The app
  names this failure (`ProxyUnavailableError` in `js/data/api.js`), with a
  regression test that an unknown team id still reads as not-found rather than
  being swallowed by it.
- Headless verification: the plan computes in a Web Worker, so
  `screenshot.sh`'s virtual-time budget expires on the loading screen; use
  `tests/browser/cdp.mjs` with `node --experimental-websocket` and poll for 15
  `.fpl-pp-meta` cards. Fresh repo-relative `--user-data-dir` per run or you
  will screenshot cached CSS (bit us: a contrast fix "did not work" until the
  profile was deleted). Concurrent CDP runs collide on port 9222.
- **Testing PRODUCTION is a different exercise from testing the app**, and three
  traps cost a full run each on 2026-08-15:
  - *Seed nothing.* The E2E suites seed `fplPlannerTeamId` and intercept the
    proxy. A real visitor gets neither, lands on the `#fpl-team-id` onboarding
    form, and a driver that clears storage and waits for a pitch waits forever.
    Type a Team ID and submit `#fpl-onboard-go`. Team `1234567`, the ID used as
    the field's own placeholder, is a real entry.
  - *A deploy preview cannot read FPL data at all.* `originAllowed()` admits
    shevato.com and local dev only, so the proxy 403s the
    `deploy-preview-N--shevato.netlify.app` origin and the app correctly refuses
    to plan. Useful as a free test of the failure UI, useless for testing
    anything behind it: the sandbox can only be exercised on production.
  - *Overlap is not coverage.* Asserting that the action bar's rectangle does
    not intersect the shared back-to-top FAB FAILS while every control is
    perfectly clickable, because the bar's container legitimately extends under
    a control that floats above it. The question is whether any BUTTON is
    covered, which only `document.elementsFromPoint(cx, cy)` at each button's
    own centre can answer. On production, 0 of 6 are.
  - Related sequencing trap: an open combobox swallows the next click, so a
    step that "fails" may simply have been aimed at a picker left open by the
    step before it. Dismiss deliberately and re-query between actions.
- The API-Football key lives in NETLIFY PROJECT ENV as `APIFOOTBALL_KEY`
  (`netlify env:get`), NOT in the repo `.env`. Free tier, 100 requests/day,
  active to 2027. EPL injuries come one season per request with NO pagination,
  so the whole 3-season backfill costs 3 requests.

## Operational state (release state verified 2026-08-15)

- **Release state: SHIPPED.** The GW1 hardening and the team sandbox are on
  production. Merged as PR #380 (`2bd2bd2`) and deployed by Netlify from
  `master` at 2026-08-15 06:55 UTC (deploy `6a800c98310a1400075aaa6b`).

  Verified the only way that means anything, by hashing what the server actually
  returns against the merged tree: **17 of 17 files matched**, including
  `js/app.js`, `js/ui/scenario.js`, `js/ui/sandbox.js`, `js/engine/minutes.js`,
  `js/engine/squad.js`, `js/engine/confidence.js`, `js/engine/planner.js`,
  `js/ui/history.js`, `js/ui/dashboard.js`, `js/ui/preseason.js`,
  `js/ui/player-drawer.js`, `js/ui/store.js`, `js/data/api.js`,
  `css/styles.css` and `index.html`. `js/ui/scenario.js` and `js/ui/sandbox.js`
  now return 200 where they returned 404, which is the quickest confirmation
  that this is the new build and not the old one.

  Everything this file says about the rollover guard, the deadline transition,
  the transfer overlay, the cache behaviour and the sandbox is now true of what
  users are running. Rollback point, if the opening gameweek exposes something
  the suites missed: deploy `6a7ec55690fee400083c64b1` (commit `5666094`, the
  last pre-GW1-work production build), restored with
  `netlify api restoreSiteDeploy --data '{"site_id":"fe5f021f-f41b-4b5a-b553-a03729fe4f6d","deploy_id":"6a7ec55690fee400083c64b1"}'`.

  **Verify before trusting any audit of this app**, because a finding is only
  about what users hit if the bytes match:

  ```sh
  for f in js/app.js js/engine/minutes.js js/engine/squad.js js/data/api.js; do
    printf '%s  branch=%s master=%s prod=%s\n' "$f" \
      "$(md5sum apps/fpl-planner/$f | cut -c1-8)" \
      "$(git show master:apps/fpl-planner/$f | md5sum | cut -c1-8)" \
      "$(curl -s https://shevato.com/apps/fpl-planner/$f | md5sum | cut -c1-8)"
  done
  ```

  (No commit counts here on purpose; `git log --oneline origin/master..` is the
  truth.)
- **Production is serverless/static; nothing must stay running.** The app is a
  static browser bundle; planning runs in a Web Worker; live reads go through
  the Netlify function proxy with Blob caching. The trained artifact is loaded
  and deliberately not consumed (`engineConsumes: []`), the status panel says
  so (`dashboard.js`), and the analytic engine (`planner-1+analytic-1`) is
  what produces every plan.
- **Season-start transition is data-driven, no manual switch:**
  `seasonStarted = events.some(isCurrent || isPrevious || finished)` off the
  live bootstrap; pre-season routes to the draft builder with the full budget,
  and the in-season import path activates by itself when GW1 goes live.
- **Nothing durable is collected by this repo, and nothing needs to be.** All
  FPL reads are on-demand; caches (Netlify Blobs, browser memory,
  localStorage) are temporary by design. Historical evidence comes from the
  vaastav/Fantasy-Premier-League archive, which preserves the per-gameweek
  deadline-relevant columns (value, selected, xG/xA, starts, defcon) and
  **is already tracking 2026-27** (players_raw.csv live as of 2026-08-12).
  Availability records remain retrospectively fetchable per season from
  API-Football (key active to 2027). No collector was built, on purpose: the
  only ephemeral quantities (live chance_of_playing at deadlines) feed a
  signal this project measured and REJECTED.
- **Wake-up triggers, in order of likelihood:** (1) GW1 of 2026-27 goes live
  on 2026-08-21 17:30Z: validate the real import path once (squad, transfer
  history, selling prices, live defcon) - a production-validation trigger, not
  a tuning licence. Four facts about FPL cannot be observed before then and
  each decides a live behaviour: WHEN the element statistics roll over relative
  to the first finished fixture (decides which half of the rollover seam
  fires), whether `picks` is served immediately after the deadline and whether
  its `entry_history` carries `bank`/`value` for a current unscored gameweek
  (if not, the planner believes every manager is broke), whether
  `entry_history.value` tracks daily price moves (decides whether the
  `value_mismatch` warning is a constant false alarm), and what upstream
  actually returns while the game is updating. `GW1-RUNBOOK.md` beside this file is the
  checklist for all four, with the commands and what each answer means; capture
  the bootstrap at 17:25 and 17:35 and keep both; (2) early 2026-27: confirm vaastav's merged_gw.csv is accumulating
  gameweeks - if that archive ever stops, THEN build the minimal collector;
  (3) a fifth complete season, which un-parks the prior-weight family and any
  underpowered question; (4) discovery of the 2023-24 prior-value channel;
  (5) an observed real-use planner failure, which outranks all speculative
  work.

## The team sandbox (added 2026-08-14)

- **A scenario is a SquadState, and that is the entire design.** Editing
  produces the same shape `buildSquadState` produces, so "recommend from THIS
  team" is the ordinary `buildPlan` on a different input rather than a second
  planning path. Anything that tempts a future session into a parallel engine
  here is a mistake: the value to change is the squad state, never the planner.
- **Transfers are the DIFFERENCE between the scenario squad and the imported
  one, never a log of clicks.** Selling a player and buying him back nets to
  zero, which is what FPL does with a transfer reversed before the deadline and
  what keeps a chain (A for B, then B for C) reading as one transfer of A for C.
  A click log would have charged for all three.
- **Legality is decided by APPLYING the edit and asking `validate.js`**, then
  throwing the result away if it fails. That costs one validation per candidate
  when the pitch marks swap targets, and it buys the guarantee that what the UI
  offers and what the commit allows cannot drift apart. The cheap pre-checks in
  `transferBlockedReason` exist only to phrase a refusal in the picker; the
  commit path always runs the full gate.
- **`squadHorizonValue` scores a SQUAD, not a chosen eleven.** Every future
  gameweek inside it is optimized, so an edit that keeps the fifteen and only
  moves the armband or the eleven leaves the horizon EXACTLY unchanged. Leading
  the verdict with that number reported "level over the horizon" to a manager
  who had just cost himself 2.2 points that Saturday. The verdict now leads with
  the gameweek figure whenever no transfer was made. Anything comparing before
  and after must ask which quantity actually moves.
- **Two bugs the browser found that the module tests could not.** The picker
  opened onto an empty box because `combobox` only opens on a keystroke (it now
  exposes `open()`, and the picker focuses and opens on mount), and the picker
  rendered ABOVE the pitch while the button that summoned it sat below the
  bench, so on a phone nothing appeared to happen. It now takes the action
  bar's place. Neither is visible from a passing assertion about state.
- **`.fpl-seg` does not wrap, and a third option in the squad switch pushed the
  whole PAGE sideways at 390px** (measured 392px of control in a 390px
  viewport). Fixed for every `.fpl-seg` under 640px, which also fixes the
  pre-existing horizontal scroll on the Settings horizon control. **Measure
  `scrollWidth` against the DEVICE width, not `window.innerWidth`**: under
  mobile emulation `innerWidth` grows to the expanded layout viewport, so the
  obvious check reports no overflow while the page is visibly scrolling.
- **Pre-season needed its own branch, twice.** With no picks the diff called all
  fifteen players transfers (eleven hits for picking a team) and the money
  ledger reported the full budget as the bank while fifteen players sat in the
  squad. Both now take the fresh-build path, matching `validate.js`'s own
  `isFreshBuild`. Separately, the squad-view switch was gated on HOLDING picks,
  which hid the editable view during the one week it matters most.
- **Benching a captain must reassign BOTH armbands.** Promoting the vice and
  leaving the vice field alone produces one player wearing both, which
  `validate.js` rejects as `captain_vice_same`. `reassignArmbands` is the single
  rule: the vice inherits, then the vacated vice slot is refilled.
- Nothing about the scenario is persisted, synced, or counted: no new storage
  key, and no second analytics event, because `privacy.html` commits this app to
  exactly one. A hypothetical plan is deliberately absent from plan history, so
  the diff between stored versions still describes real recommendations only.

## The gameweek boundaries, and what each one broke (fixed 2026-08-15)

Everything in this section was found by driving the shipped code through
pre-season -> deadline -> matches in progress -> matches finished -> gameweek
finalised against the LIVE 2026/27 payload, one week before GW1. Every one of
them is a SEAM between two data states rather than a bug inside either state,
and the whole suite was green through all of them. They are fixed; what is
recorded here is the shape, because the next seam will look like these.

- **The season-statistics rollover has two failure windows, and neither is
  detectable from legality.** A start rate is `starts / matches`: the numerator
  is a bootstrap season total, the denominator is the finished fixture count,
  and FPL rolls those over at different moments. Last season's totals with one
  fixture played reads as 34 starts over 1 match and pins pStart at 1.000 for
  most of the owned pool; totals already zeroed with nothing played collapses
  every rate to zero, and the planner then recommends a squad projecting 20
  points captaining a goalkeeper. Both keep every probability inside [0,1].
  `seasonEvidence()` in `minutes.js` now classifies the payload from an
  arithmetic fact about the sport (a player cannot have started more matches
  than his club has played) into `previous-season` / `current-season` / `none`,
  the denominator follows the classification, and a payload with NO evidence is
  reported through `dataStatus.evidence` and withheld by the UI rather than
  projected from. Regression coverage asserts start rates VARY and that a legal
  eleven projects a plausible total, not merely that the numbers are finite.
- **The committed sample dataset is itself in the previous-season shape**: its
  element totals are full-season sized (3420 minutes, 38 matches) while it
  declares twelve gameweeks played. Demo mode had therefore been running with
  pStart pinned at 1.000 for a large part of the pool, and correcting the
  denominator moved its median to 0.66. Two optimizer tests were built on those
  pinned projections and had to be repaired; if a sample-derived expectation
  moves again, check this first.
- **A deadline is a lifecycle boundary, not a repaint.** The ticker redrew the
  hero every thirty seconds and never re-read anything, so a tab open across
  17:30 kept offering transfer advice for a locked gameweek, and pre-season
  stayed pre-season after the season started. It now detects the crossing once,
  refetches, discards a bundle whose `seasonStarted` no longer holds, and routes
  to the import path; `visibilitychange` covers the tab that slept through it.
  `countdown()` words the passed case, so the hero prints only its own prefix -
  writing both rendered "Deadline passed Deadline passed".
- **Frozen picks are not the squad the manager owns.**
  `entry/{id}/event/{gw}/picks` is frozen at that gameweek's deadline, and a
  transfer made for the NEXT gameweek appears immediately on
  `entry/{id}/transfers` and nowhere else. `buildSquadState` now overlays the
  transfer rows belonging to the gameweek being planned, in time order so a
  chain collapses to its net effect, moves the bank by the row's own
  `element_out_cost` / `element_in_cost`, and spends the free transfers through
  `transferAccounting` rather than a second copy of the arithmetic. The
  `value_mismatch` warning is only meaningful against the FROZEN squad, so it is
  suppressed once a transfer has been applied: FPL's `entry_history.value`
  describes a squad that no longer exists.
- **The cache is an optimisation and must never be a single point of failure.**
  A transient upstream 404 (FPL returns them while processing a gameweek) used
  to discard a perfectly good cached copy and throw the manager back to
  onboarding; a failed blob WRITE threw away a body already fetched; an
  unreachable store escaped as a platform 500. Now: a 404 with a cached copy
  serves it stale, a 404 with nothing cached is still a real unknown-team answer,
  a write failure is logged and the fresh body still returned, and a store that
  cannot be acquired degrades to an uncached direct fetch.
- **Two different ages, and conflating them pinned the browser cache forever.**
  Cache expiry may only be decided on a clock that shares an origin with the
  timestamp it is compared against, so it now uses a locally recorded
  `receivedAt`. The age SHOWN to the user is the data's age, which is the
  proxy's own `x-fpl-age-seconds` at receipt plus the time held since. Measuring
  either with the other produced an entry that never expired on a slow device
  and fresh data reported as stale on a fast one.
- **The client cache has to honour the deadline window too.** The proxy
  collapses every TTL to two minutes inside six hours of a deadline; the browser
  sits in front of the proxy and short-circuits before it is asked, so leaving
  it on a ten minute TTL meant the shared cache was fresher than the screen in
  the hour that matters most. It reads the deadline out of the bootstrap it
  already holds, so this costs no extra request.
- **The bootstrap is memory-only.** At 2.6 MiB of a roughly 5 MiB per-origin
  budget shared with every other app on the domain, persisting it spent more
  than half the quota to save at most one refetch per session, and the old quota
  handler responded to one failure by deleting every FPL key including the one
  it had just written. Eviction is now oldest-first.
- **A key that is written and never read is not persistence.**
  `fplPlannerSquadSnapshot` was saved on every plan and had no readers, so a
  hand-built pre-season squad was lost on reload during the one week when
  building one by hand is the only thing the app can do. It now stores ids plus
  the team, season and gameweek the ids belong to, is restored on boot when all
  three still apply, and the draft card carries "Edit this squad" and "Start
  over" so the restored fifteen can be changed.
- **`state.busy` is held for the whole of `connectAndPlan`**, so anything called
  from inside it that guards on `busy` silently does nothing. Restoring a squad
  through `planManualSquad` from there produced a permanent loading screen with
  no error; the restore calls `computePlan` directly instead. Check this before
  adding another entry point.
- **The card must not answer a question the engine did not ask.** Pre-season the
  planner takes the draft branch and never evaluates chips, yet the chips card
  reported "no chip clears its bar"; the per-chip row keyed on `bestGw` alone,
  so a recommended wildcard rendered "Wildcard: Hold" directly under "Play your
  Wildcard this gameweek"; and each chip exists twice a season, so one was
  listed as usable now AND not open until GW20. All three are rendered-card
  tests now, because none of them is visible from state.
- **Perf budgets have to be measured at production size, in CPU time.** The
  existing budget measured the 320-player sample and its comment claimed that
  was "the same size as a live season"; the live pool is 587 and plan time does
  not scale linearly. `perf-live-size.test.mjs` expands the sample to the live
  count (drawing the extra players from the CHEAPER half, because cloning across
  the whole price range manufactures premiums and makes the search twice as hard
  as reality). Wall time under `npm test` measures how busy the machine is, so
  the assertions use `process.cpuUsage()`; the opening build carries its own
  measured budget because a fifteen-man search is a heavier operation than the
  transfer path and inheriting the other number would not be honest.

## Browser E2E, and why it exists here now

`apps/fpl-planner/e2e/` follows the trip-planner pattern
(`npm run test:fpl-planner:e2e`): raw CDP through `tests/browser/cdp.mjs`, no
framework and no dependency, real coordinate clicks so hit-testing is exercised,
waits on real application state, and a screenshot written only when a check
fails. Two things are specific to this app:

- **Readiness is fifteen rendered player cards**, not DOMContentLoaded, because
  the plan is computed in a Web Worker.
- **The whole lifecycle is served by INTERCEPTING the proxy.** `payloadsFor()`
  mutates the committed sample into pre-season, deadline-soon, GW1 locked, GW1
  live, GW1 finished or a GW2 transfer window, and the page clock is shifted so
  a deadline crossing needs no waiting. None of those states is reachable from
  `?demo=1`, which is why the interactive scenario shipped with green unit tests
  and was unusable: **every interaction bounced the user back to "Recommended"**
  because the selected view was derived from whether the squad held picks, and
  pre-season it holds none. A DOM test cannot see that; the state was correct
  and the view was wrong.

Suites clear this app's storage between blocks. A squad saved by an earlier
block is otherwise restored on boot, which is the feature working and the test
lying.

## Open questions / next highest-value work

Ranked 2026-08-12, evening, after 2025-26 qualified (entry 15), bonus closed
(entry 16), the defcon denominator landed (entry 17) and the prior-weight sweep
read out (entry 18).

1. **The prior-weight family is PARKED** (entries 18, 20, 21; two
   pre-registered inconclusives). The decay hypothesis was disconfirmed by
   diagnosis: implied K is 1-5 equivalent matches at every m in every season
   pair, flat. The derived small weight then failed its primary (t 0.52 with a
   2023-24 collapse), and the durable discovery is that per-season optimal
   weights genuinely differ (2023-24 wants K~19+, 2025-26 wants K~2-5) through
   a channel start-rate persistence does not see. Reopening requires (a) a
   fifth season, or (b) finding the 2023-24 channel first - candidate suspects
   are xG/xA rate quality and opening-15 construction. The production-path
   contrast (light prior vs none) has now read +14.5 to +15.6 a window at
   t 1.5-1.7, positive in every exposed season, twice - consistent evidence,
   below every registered bar.
2. **Multi-season player-history features**, unblocked by `code` identity and
   the evidence-denominator fixes. One mechanistic feature at a time; each must
   say what decision error it fixes and how it changes ORDER. Prerequisite if
   the training pipeline gets involved: fix `buildTeamHistory`'s name-vs-index
   club join (two features identically zero).
3. **Transfer round-trip churn pricing at the `planner.js` objective level**
   (the searchTransfers version filters rather than decides; measured and
   rejected, see `experiments/transfer-churn.md`). Derive what the planner
   fails to price before constructing an experiment.
4. **The top-decile question is WORKED, not open** (entries 12, 13, 16): both
   measurable components have verdicts (assists REJECT for reranking the wrong
   way; bonus REJECT-CLOSED with the held-out season voting it down). The
   residual (cards over-penalized ~15%) is below the instrument's resolution.
   Any new candidate must first pass the entry-12 order test: a level
   correction cancels out of every ranking and only crosses hit/chip
   thresholds.
5. **Bookmaker odds stay deferred** (owner decision; `odds.js` inert). Every
   correctness round so far has been worth more than any unproven external
   signal.

Known and deliberately unfixed:

- **Historical seasons now replay under the rules they were played by**
  (registry entry 14): per-season chip catalogues with verified wildcard
  windows, one FH/BB/TC each through 2024-25, the 2-transfer bank before
  2024-25, chip weeks not banking before 2024-25, and 2022-23's unlimited
  transfers at GW17 (the World Cup break). `scripts/backtest.mjs
  historicalRules` owns the season table; the engine reads `maxFreeTransfers`,
  `chipPreservesBank` and `unlimitedEvents` off the rules object with defaults
  that ARE the live game, so a payload that never heard of the flags behaves
  identically. Chip-strategy experiments are unblocked. Chips-on totals from
  before this fix were measured with three chips those seasons did not have.
- **Do not run `npm test` while an experiment is running.**
  `tests/perf-budget.test.mjs` budgets full plan generation, and eight worker
  processes saturating the machine push it over. Two failures chased on
  2026-08-12 were entirely that; the same suite passes completely on an idle
  machine. (No literal test count here on purpose: the count moves with every
  added test and a stale number reads as a discrepancy. The 3211-vs-3215
  confusion of 2026-08-12 was exactly this, four regression tests landing
  between two measurements.)

- The counterfactual minutes sentence compares only the DIRECT pair; knock-ons
  can bring in near-zero-minutes players while the sentence says "level".
  (Behaviour change, do it on purpose.)
- `projectMinutes` divides by the LEAGUE's match count, not the player's own
  club's, so a club with a game in hand has its players' start rates slightly
  understated. Real but small, and the replay cannot measure it now that it
  declares `evidenceMatches` on every player.
- `buildTeamHistory` in `scripts/train-model.mjs` keys clubs by NAME and is
  queried with a season-scoped club INDEX, so two of twenty-four declared
  features are identically zero. Reaches no user (`engineConsumes: []`).
