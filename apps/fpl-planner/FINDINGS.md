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
- **Transfer search performance: the exact bench-ordering was the whole cost,
  and it was restructured bit-identically** (2026-08-17). The
  `TRANSFER_SEARCH_BUDGET_CPU_MS` invariant (1500 ms CPU) started flaking on
  GitHub runners at ~1520-1550 ms on back-to-back CI attempts while master
  passed, and profiling showed why: the search had grown ~4x since the budget
  was sized (~100 ms then, ~416 ms local by 2026-08-17), because the exact
  shortlist re-rank runs ~100 exact `optimizeLineup` calls per search, those
  consider ~50k elevens, and every considered eleven ran `orderBench` exact:
  6 bench permutations x `expectedRecovery`, each re-walking ~64 absence
  states and calling an allocating `simulateSubs` ~3.4M times per search.
  The fix (in `lineup.js`): evaluate all 6 permutations in ONE shared pass
  over the absence states; deduplicate `simulateSubs` by the ordered sequence
  of playing bench players (a compacted all-playing sequence walks the same
  branches as the masked original); reuse scratch buffers; memoize the
  rules-derived structures (`fixed`/`outfield`/`posIndex`/`minPlay`/`maxPlay`
  per rules object in a WeakMap) and `legalFormations` per (rules,
  headcounts). Result: ~209 ms local median, est. ~750 ms on a GitHub runner.
  - **Bit-identity was the acceptance test, so this is NOT a registry
    experiment**: per permutation, additions still accumulate in the exact
    (state, mask-ascending) order and each permutation's combination
    probabilities multiply in the original per-slot order, because float
    arithmetic is not commutative under reordering. Proven by a differential
    harness importing both engines (working tree vs origin/master) into one
    process: `searchTransfers` at horizons 1-5 and 400 seeded random squads
    through `optimizeLineup` (exact and fast), all SHA-identical JSON.
  - The memoized structures are cached by rules-object identity and shared
    between calls; consumers must treat them as read-only, and anything that
    mutates a rules object in place instead of building a new one will get
    stale derived data.
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


- **A dynamic `import()` one directory level short shipped a production 404,
  and every test passed** (2026-08-17). `js/ui/settings.js` reached the sync
  layer through `import('../../../sync-system/storage-sync-robust.js')`. That
  file sits at `apps/fpl-planner/js/ui/`, so three levels up is `/apps/` and
  the browser requested `/apps/sync-system/storage-sync-robust.js` - a 404. The
  canonical module is at the REPO ROOT (`/sync-system/`), which needs four.
  Two things made it survive from the app's first commit to production:
  (a) a **dynamic** import is not fetched at page load, so the app booted
  perfectly and the break was reachable only through Settings -> "Delete all
  FPL Planner data", and (b) the unit-test resolution hook
  (`tests/helpers/sync-module-hook.mjs`) matched the specifier with
  `endsWith('sync-system/storage-sync-robust.js')`, which is true at ANY depth,
  so the stub answered a path the browser could never load. The user-visible
  symptom was honest but misleading: the deletion UI correctly reported that
  the account copy could not be deleted, naming the import failure as the
  reason. Fixed by the fourth `../`; the hook now resolves the specifier
  against `parentURL` and refuses to substitute the stub for a path that does
  not exist on disk, and `tests/static/module-imports.test.mjs` asserts that
  every relative module specifier in shipped JS resolves to a real, git-tracked
  file. Rule: **HTML `src` and JS `import` live at different depths in the same
  app** - `index.html` uses `../../sync-system/`, anything under `js/ui/` needs
  `../../../../sync-system/`. Gym Tracker's equivalent call in
  `apps/gym-tracker/js/views/settings-view.js` had it right and is the reference.
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

## Operational state (release state verified 2026-08-21)

- **The GW1 live-season hardening is NOT yet deployed.** It sits on
  `fix/fpl-live-gameweek-state`. Production is serving the pre-incident code,
  which means a payload FPL clears mid-season still poisons projections there.
  The deployed build is otherwise correct: the GW1 pre-season work, the sandbox
  and the two pre-season encodings all shipped and were verified byte-for-byte
  against the served files on 2026-08-21 (60 of 60 identical).
- **Earlier release state, still true of what shipped: SHIPPED.** The GW1 hardening, the team sandbox (PR #380,
  `2bd2bd2`, deployed 2026-08-15) and the sandbox interaction rework (PR #399,
  merged as `91d5e23`) are all on production. The current production build is
  Netlify deploy `6a8200c6d0a44e0008bfd662`, published from `master` at
  2026-08-16 18:27 UTC.

  Verified the only way that means anything, by hashing what the server
  actually returns against the merged tree. The #380 verification matched 17
  of 17 files; after #399 the four files that round touched were re-verified
  on production (`js/ui/sandbox.js`, `js/app.js`, `css/styles.css`,
  `js/ui/scenario.js`, all md5-identical to `origin/master`) and the live
  site then passed a 40/40 behavioural check of the reworked scenario
  workflow at 1280 and 390 (zero app-caused scroll, card DOM preserved on
  selection, dock and picker pinned in-viewport, stale planner answers
  discarded, no console errors).

  Everything this file says about the rollover guard, the deadline transition,
  the transfer overlay, the cache behaviour and the sandbox interaction
  architecture is now true of what users are running. Rollback point, if the
  opening gameweek exposes something the suites missed: deploy
  `6a816a845083eb000852c084` (commit `5b97e9a`, the last production build
  before the interaction rework), restored with
  `netlify api restoreSiteDeploy --data '{"site_id":"fe5f021f-f41b-4b5a-b553-a03729fe4f6d","deploy_id":"6a816a845083eb000852c084"}'`.
  That build still contains all of the GW1 hardening; rolling back further,
  to before PR #380 (`6a7ec55690fee400083c64b1`, commit `5666094`), would
  also surrender the rollover guard and the sandbox itself.

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
  originally rendered ABOVE the pitch while the button that summoned it sat
  below the bench, so on a phone nothing appeared to happen. Since the
  2026-08-16 rework it renders in the pinned action dock, exactly where the
  press happened. Neither bug is visible from a passing assertion about state.
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

## The sandbox interaction architecture (rework of 2026-08-16)

The scenario shipped correct and felt broken: every click flickered, the page
jumped, and the workflow read as the app rebuilding itself. The engine was
untouched by the fix; every root cause was in how the frontend rendered. The
rules below are what future work must preserve, with the measurements that
motivated them (probe: scrollY captured at the click event vs settled,
document-absolute element positions, MutationObserver node counts).

- **Root cause 1, the flicker: every sandbox action called `renderApp()`,
  which rebuilt the ENTIRE app DOM** (topbar, hero, every dashboard card, the
  pitch, the sandbox) via `mount(appEl, ...)`. A full subtree replacement
  repaints everything the user is looking at, throws keyboard focus to
  `<body>` (measured: focus on BODY after every single action), and defeats
  the browser's scroll anchoring. It is also invisible to CLS: freshly
  inserted nodes do not count as "shifted", so the layout-shift metric read
  0.000 throughout. THE RULE: scenario interactions never call `renderApp()`.
  They flow through `createSandboxView().update(props)`, which diffs on object
  identity (exact, because every scenario edit returns a new object) and
  rewrites only the slots whose inputs changed. A selection click toggles
  classes on the EXISTING cards; node identity is asserted by unit test and
  by the E2E probe-mark check. `renderApp()` remains for genuine view-level
  navigation (tab switches, a new plan), where scroll-to-top is intended.
- **Root cause 2, the jumping: in-flow content above or at the interaction
  point changed height.** Three concrete cases, all measured: entering swap
  mode grew EVERY card by a blocked-reason line (+33px per card, bench pushed
  +133px); the first transfer mounted the moves disclosure above the pitch and
  moved the whole pitch 133px; on a phone the verdict wrapping one line longer
  moved it 22px. THE RULE: everything rendered ABOVE the pitch (flag, summary
  strip, formation note) keeps a stable height through every edit; reactions
  to an edit (verdict, moves list, refusal messages) render BELOW the pitch,
  next to the dock where the edit was made; swap-mode refusals mark cards with
  classes only (the sentence appears in the dock on press, and stays
  pre-phrased in the card's aria-label for screen readers).
- **Root cause 3, "nothing happened" / forced scrolling: the action bar and
  picker lived below the bench and the picker `scrollIntoView`-ed itself**
  (+192px of forced page scroll per open, more on a phone). THE RULE: one
  action dock, a single stable slot after the bench that PINS near the
  viewport bottom (`position: sticky; bottom`) while a selection or the picker
  is live. The picker renders into it, its option list opens UPWARD anchored
  to the picker box (not the input, or the list covers the picker's own
  header), and nothing in the sandbox ever calls `scrollIntoView` or
  `scrollTo`. After the rework the app-caused scroll delta is 0px for every
  interaction on desktop and mobile, with the dock and picker fully inside
  the viewport.
- **Root cause 4, a stale async overwrite: "Ask the planner from this team"
  stored whatever the worker returned**, so an answer computed for a squad the
  user had already edited away rendered as if it described the newer one. THE
  RULE: capture the scenario object the question was asked about and compare
  by identity when the answer lands; discard on mismatch. The busy state never
  replaces the sandbox, only the answer slot below it. Pinned by the E2E
  stability block (edit mid-ask, assert the stale card never renders and the
  edit survives).
- **The open picker is a cached node keyed on the picker request object**, so
  an unrelated update (the expected-points toggle) cannot rebuild it and eat
  the user's typed search. The flip side: any action that changes the squad
  under an open picker must CLOSE it (`undo`, `reset`, `copy-recommended` do),
  because a cached candidate list priced against a squad that no longer exists
  would offer wrong affordability.
- **Selection is kept across captain/vice edits** (the armband appearing on the
  selected card is the feedback, and the player's remaining actions stay one
  press away); it clears on completed swaps and transfers. A completed
  transfer flashes and focuses the incoming card, so "what changed" is visible
  on the pitch itself. Focus never falls to `<body>`: a rebuilt dock refocuses
  the same-labelled button, and a vanished control hands focus to the card the
  action was about, always with `preventScroll`.
- **Cost per interaction, before vs after:** a selection click ran
  `scenarioSummary` (two `squadHorizonValue` lineup optimizations) plus a
  whole-app rebuild, 3.3-7.5ms of synchronous work on the 320-player sample
  and strictly worse at live size; it is now 0.4-0.6ms and touches 3 nodes.
  `scenarioSummary` runs only when the scenario/projections actually changed.
  Ordinary edits still run NO planner work; the worker is involved only for
  the explicit "Ask the planner from this team".
- **The regression net:** `tests/ui-sandbox.test.mjs` pins node identity,
  slot behaviour, dock content and toolbar state under the mini DOM;
  `apps/fpl-planner/e2e/scenario.mjs` carries a stability block (desktop AND
  390px mobile) asserting zero app-caused scroll, card-DOM preservation,
  dock/picker inside the viewport, unclipped buttons via
  `elementsFromPoint`, typed-search survival, pitch position unchanged
  through a completed transfer, the stale-answer discard, and no horizontal
  overflow.

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

## The two pre-season encodings (fixed 2026-08-20, the day before GW1)

- **Before GW1 the same fifteen exists in two SquadState encodings, and any
  screen that assumes one of them is nonsense for the other.** A DRAFT
  (optimizer-built) holds no picks: the whole budget sits in `bankTenths` and
  the plan's `moneyOutTenths` is what the fifteen costs. A MANUAL squad (typed
  in, or restored from `fplPlannerSquadSnapshot` on a reload) holds the
  fifteen as picks with only the change in the bank. Both are correct for the
  engine. On production, reloading a saved opening squad produced: "It costs
  £0.0m of the £0.0m budget" (draftCard read `bankBeforeTenths` as the
  budget), a "Roll your transfer / bank this week's transfer, 1 free transfer"
  hero directly under a header saying transfers are unlimited (every is-this-a-
  draft predicate tested `source === 'draft'` only), "Plan unchanged. Your
  bank fell from £100.0m to £0.0m" (the version differ compared bank across
  the two conventions), and a CHIPS card that appeared only after the reload.
  The plan itself (squad, captain, XI, 53.1 xP) was correct throughout; every
  defect was presentation reading engine encoding as user truth.
- **The fix is one adapter plus one predicate.** `openingSquadMoney` in
  `engine/squad.js` is the single pre-season money derivation (budget from
  rules, remaining = the plan's closing bank, spend = the difference; valid
  for both encodings because a pre-season squad's value IS the budget), used
  by draftCard and the explain draft_spend bullet. "Draft" to the UI and to
  the explanation layer now means `source === 'draft' || source === 'manual'`
  (manual only exists pre-season); the SEARCH keeps the narrow predicate,
  because a draft searches for a fifteen and a manual squad must keep the
  user's. `inputFingerprint` and `planInputs` record a draft as the squad the
  plan settled on, so a built draft and its restored twin carry the SAME
  fingerprint (no phantom version per reload), and `budgetReasons` stays
  silent on bank when either version has no finite free-transfer count (the
  pre-season marker; also covers versions stored before this fix).
  `planHeadline` checks the chip before the opening-squad frame: a manual GW1
  squad can legally play Bench Boost, a built draft never carries a chip.
- **Why five audits missed it: every prior check asserted persistence, never
  the story.** The E2E reload test (lifecycle section 7) asserted the same 15
  names came back, the "saved on an earlier visit" note, and the edit buttons,
  all of which pass with the broken money copy on screen. The typed-squad
  variant had shipped broken since the first release (b64e649, 2026-08-12) and
  the restore path since 2026-08-15 (8f46685); no commit after the 2026-08-16
  audit touched any of it. That audit was scoped to the scenario interaction
  rework, and the runbook's "a squad built or typed here survives a browser
  reload" is likewise a survival check. Section 7 now also asserts the STORY:
  hero headline, no roll copy in the hero, real budget figures, no bank-moved
  notice, unlimited-transfers wording, and that the reload renders the exact
  card set the build rendered. Five unit tests pin the layers underneath
  (headline wiring, spend bullet, fingerprint equality, planInputs
  convention, differ silence). All were proven to fail on the pre-fix code.
- **Probe-harness trap that muddied the diagnosis: snap chromium silently
  remaps a `/tmp` `--user-data-dir` into its private namespace and shared it
  across "fresh" profiles**, so later probe runs carried the earlier run's
  localStorage and the restore bug looked like a same-visit flip. Same family
  as the known snap `/tmp` screenshot gotcha: give probes a repo-relative
  profile dir, one per run.
- **Second member of the class, found by the post-merge production sweep
  (fixed 2026-08-20 evening): manual picks are a ROSTER, not a LINEUP.**
  `manualSquadState` assigns slots in the order the fifteen arrived
  (position-ordered from a restored snapshot, goalkeepers first), every
  multiplier 1, nobody flagged captain. Two consumers read those slots as
  FPL-assigned lineup slots: `createScenario`'s "current" seed and
  `pitchViewModel`'s "Current team" view. On production, a restored squad
  that opened "My scenario" was greeted with "This team is not legal yet:
  that would field 2 GKP" about a squad it never edited, with slot-1 Raya
  auto-captained; the "Current team" pitch tab showed the same arrangement.
  Pre-existing (identical code on the pre-#424 deploy), reachable since the
  sandbox shipped; the scenario E2E suite missed it because its pre-season
  state is the DRAFT (no picks), which seeds from the plan. The fix is
  `picksCarryLineup` in `engine/squad.js` (false for `source === 'manual'`):
  the sandbox seeds from the plan (origin 'recommended', whose banner copy
  already fits) and no "Current team" view is offered before a real lineup
  exists. Pinned by a unit test reproducing the literal symptom (2 GKP in
  the seeded eleven) and two lifecycle checks, all failing pre-fix.
- **Third member, found by auditing the STATE MODEL forwards instead of a
  symptom backwards: the scenario comparison's "before" eleven.**
  `comparison()` in `ui/scenario.js` built its baseline from the same roster
  slots (2 GKP, no captain), so an UNTOUCHED restored squad's sandbox strip
  read "This gameweek 42.7 -> 54.1" - a phantom gain over a fabricated
  eleven. For squads whose picks carry no lineup the baseline is now the
  scenario's own seed (the plan's arrangement of the same fifteen): untouched
  compares level, an edit reads as the edit's own effect. The full sweep that
  found it enumerated every SquadState representation (draft, manual,
  imported picks, scenario, planner-internal projected) and every consumer of
  every field whose meaning differs between them; the ONLY raw readers of
  pick slots/captain flags in the app are createScenario, pitchViewModel and
  comparison (all now guarded by `picksCarryLineup`) plus
  `projectedSquadState`, whose roster-style picks are engine-internal
  (membership, selling prices and transfer state only; each future gameweek's
  eleven is re-optimized, never read from those slots).

## The first live gameweek, and the five assumptions it broke (2026-08-21)

The 2026/27 opening gameweek broke the planner in production while 949 unit
tests and 148 browser assertions stayed green. Everything below is measured
against payloads captured off the live proxy that evening and now committed,
trimmed and sanitized, under `tests/fixtures/gw1-2026/`.

- **The trigger was one field, rewritten under a running app.** At 18:04 UTC,
  the moment GW1 went current and before a ball was kicked, FPL cleared every
  element total. Raya went from `starts: 37, minutes: 3330` to `starts: 1,
  minutes: 90`. Nothing in the app could notice, because a payload was whatever
  the last fetch said it was.
- **The chain, end to end, reproduced on the real payloads.** `seasonEvidence`
  read "no fixture has finished, so these totals are last season's" - true every
  previous August, false the instant the totals are wiped - and kept a 38
  gameweek denominator. `observedStartRate = 1/38 = 0.026` became `pStart 0.026`
  became `xMins 2.4` became `xPoints 0.08`, and the best eleven in the game fell
  from 49.2 to 33.4. The optimizer saw eleven replaceable players and
  recommended a Wildcard.
- **The discriminator was `hasHistory = player.minutes > 0`** (`minutes.js`). A
  player who had just played carried an observed rate of one-in-thirty-eight; a
  player who had never played fell through to the price-informed prior and
  scored 3.17. **Having played was punished, by a factor of 35.** Arsenal
  collapsed only because they were the first club to play; every club would have
  hit it in turn. This is the generic statement, and it is now a test.
- **`finished` is not the end of a match.** FPL sets `finished_provisional` at
  full time and leaves `finished` false until bonus and stat corrections land.
  The opening match was STILL unsigned eleven hours after the whistle (captured
  at 04:58 UTC the next morning). `normalizeFixture` was DISCARDING
  `finished_provisional`, so `matchesPlayedByTeam` returned zero for every club
  while twenty-two players carried ninety minutes each. Both now count a
  provisional full time.
- **Clubs are not level, and the pool is not comparable until they are.** Two of
  twenty clubs had played. Any question of the form "have the matches happened"
  had no single answer, and `clubsLevel` now says so explicitly.
- **The probe went from PROBLEM to OK while the defect was unchanged.** It ended
  in `30 < xP < 100`. The broken pipeline read 14.5 (failed), then drifted to
  31.5 as minutes accumulated (passed). An absolute threshold cannot separate
  healthy from wrong-by-a-factor because both sides of it contain both. Health
  is now named invariants plus change detection against a recorded reading.
- **Why five audits missed it: every test asserted a state the app was designed
  for.** Pre-season, a finished gameweek, a rolled-over season. The state that
  occurred - totals cleared, minutes accruing, no finished fixture - was in
  none of them, and it exists only during the very first match of a season.

### What the repair actually changed

- **A payload is no longer automatically the truth.** `engine/baseline.js`
  scores every payload, keeps the last good one, and stands it in for cleared
  totals. Completeness is measured PER ACTIVE PLAYER (16.8 starts each before
  the wipe, 1.0 after) rather than as a league aggregate, because an aggregate
  silently encodes the pool size and rejected every hand-built test world - the
  first version of this check broke thirteen engine tests and was wrong, not the
  tests. The baseline retires once every club has played three matches, so one
  bad August payload cannot freeze the app on last season.
- **Restored, not merely refused - and since 2026-08-22, the rates too.** With
  the kept baseline applied to the exact payload that broke production, Raya
  goes from 0.08 xP back to 5.40 and the best eleven from 33.4 to 58.2. The
  first version of the snapshot restored starts and minutes ONLY, which are the
  DENOMINATORS of every rate; FPL clears the numerators (`expected_goals`,
  `expected_assists`, `expected_goals_conceded`, `bps`, saves, goals, assists,
  clean sheets, the defcon parts) in the same wipe, so `underlyingRates` divided
  one match of attacking output by a season of minutes. Measured on the
  2026-08-22 production payload: best forward in the pool 1.9 xP (Haaland 1.7,
  xG 0.0028 a match), best midfielder 2.7, top defenders 4.8-5.5 with
  xCleanSheet 0.83; the plan was 5-4-1, captain Virgil, vice Lacroix, transfer
  Gabriel -> Virgil, readiness `transfers`, confidence HIGH. The snapshot is now
  version 2 and carries every numerator whose denominator it restores
  (`RATE_FIELDS`), the blend is `baseline + this season` over `baseline matches +
  this club's matches` so numerators and denominators fade together, and every
  per-90 division reads its denominator through `rateMinutesOf`. Same payload
  after the fix: best FWD 5.1, best MID 6.5, best DEF 4.6, formation 3-5-2,
  captain B.Fernandes, vice Enzo, "Roll your transfer". Pinned by
  `season-lifecycle.test.mjs` ("with the baseline in force the plan attacks",
  "the 2026-08-22 production payload ... projects a football-shaped pool", "a
  legacy minutes-only snapshot is read honestly") on the committed
  `tests/fixtures/gw1-2026/live-2026-08-22.json`.
- **Recommendations are a ladder, not a boolean** (`engine/readiness.js`).
  Display, lineup, transfers, chips. `planner.js` consults it before proposing
  anything: chips are not evaluated without a chip-grade licence and transfer
  candidates are not built without a transfer-grade one, so a refusal degrades
  to holding the squad. On the captured payload with no baseline the level is
  `display` and every recommendation is blocked; with a baseline it is
  `transfers` and chips remain blocked because the clubs are uneven and the
  gameweek is unsettled. The Wildcard is unreachable in both.
- **Confidence gained a fourth band that is not the bottom of the scale.**
  "Moderate confidence" over "100% of this gameweek's projected points sits on
  players whose minutes are unclear" was a sentence about broken inputs under a
  band about model uncertainty. `unusable` states the former.
- **Live points exist at all.** `event/{gw}/live` was wired into `data/api.js`
  and called from nowhere. The squad's actual score reconciles to FPL's
  published number (14 = 6 + 5 + 3 on the captured squad) and is checked rather
  than trusted.
- **Three renderings for three states.** A dash for a player whose match has not
  kicked off, a zero for one whose match finished without him, a tinted figure
  for one who played. The first version derived the number from the player's
  minutes and the caption from his club's fixture, which produced a card reading
  "6 yet to play"; both now come from one `liveState()`. Found by looking at a
  screenshot, not by a DOM assertion, which had passed.
- **`OUT` meant transfer, not availability.** `pitch.js` and `squad-table.js`
  both rendered it, so a Wildcard put eleven OUT badges over the team the
  manager owns. Now SELL and BUY. On the bench the ribbon also sat at
  `top:-8px/left:-6px` against `.fpl-bench-num` at `top:-7px/left:-6px`, exactly
  overlapping; it moved to the bottom-left.
- **The drawer labelled seasons from the misclassification.** "LAST SEASON: 6
  points, 90 minutes, 1 start" was this season's opening match. The heading now
  reads the baseline source and whether the season has started, and
  `normalizePlayer` keeps `seasonStarts`/`seasonMinutes`/`seasonPoints` separate
  from the evidence totals a baseline may overlay.
- **The History glance tiles contradicted their own screen (runbook pass 3,
  2026-08-22).** With GW1 in play and nothing finalised, "Overall rank" read
  "-" while the live row directly below printed 3,847,330, and "Total points
  14" sat under a sentence saying "these totals do not include it yet". Both
  came from `seasonSummary` keeping the live row out of `latest` (correct: a
  live gameweek must not be averaged or treated as the season's standing) and
  the tiles reading ONLY `latest`. `glanceFacts()` now falls back to the live
  row's published rank and running total when no gameweek is finalised, each
  labelled "Gameweek N so far, provisional"; a rank FPL has not published stays
  "-", and the sentence says the figures below are provisional rather than
  excluded. Once a gameweek is finalised the tiles describe it and the live one
  is excluded exactly as before. The e2e probe for the tile had been stripping
  every "s" from the text (`/\s+/` inside a template literal is `/s+/`), which
  is why its loose regex never noticed.

### A consequence worth knowing: the first weeks without a baseline

Simulating the finalisation states FPL has not reached yet, on the real FT+11h
payload, shows the repair working through all of them **for anyone who has a
baseline** - phases progress `in-progress` to `finalising` to `complete`,
`settled` flips only at the last, evidence stays `previous-season`, readiness
stays `transfers`, and the plan reads 44.5 to 47.6 xP. The total was never the
tell: it stayed a football score all through the collapse, which is why a
best-eleven range cannot be the health check and `projection_inverted` (best
forward AND best midfielder below the best defender) had to be added to
readiness. With the version 2 baseline the same states captain a midfielder.

For a manager whose FIRST EVER visit is after the rollover there is no baseline
to keep, and one gameweek of this season is genuinely not enough: the underlying
projection reads 22 to 27 xP even once every club has played once and the pool
is level again. So that manager is refused - `partial-season`, readiness
`display` - until `baselineIsSuperseded` opens at three matches per club.

That is the honest answer rather than a gap: the numbers really are unusable,
and the app says so instead of showing them. But it means a brand-new user in
the opening fortnight of a season sees no plan, and it is worth deciding
deliberately rather than discovering it. The two ways out, if that is judged too
harsh, are a heavier price prior for the early weeks or shipping a committed
opening-season baseline; both are model changes and neither belongs in an
incident fix.

The refusal message follows the actual state: while the clubs are uneven it
says so, and once a gameweek has completed it says the season is only N matches
old. Telling someone whose gameweek has finished that "the clubs have not played
the same number of games" is simply wrong, and it was.

### The legacy snapshot, and why it is not simply thrown away

Every browser that met the 2026-08-21 fix holds a version 1 (minutes-only)
snapshot under `fplPlannerSeasonBaseline.v1`. Deleting it on sight would put
those managers back on a payload with no evidence at all, so it is still read:
the minutes serve the minutes model, `rateMinutes` restricts every rate to this
season's own minutes (so a cleared numerator is never divided by a restored
denominator), the shrinkage layer resolves those rates to the position priors,
and readiness blocks transfers with `baseline_rates_missing`. If the resulting
pool is still inverted, `projection_inverted` withholds the lineup too - which
is what happens on the 2026-08-22 payload, and the test asserts exactly that
rather than a fixed level. `saveSnapshotIfBetter` replaces a version 1 snapshot
with the next complete payload regardless of season label, which is the upgrade
path.

### The trap that is still open

Withholding is not a repair of the projections underneath. With one match of
evidence and no baseline, the minutes model still ranks a player who has just
played below one who never has - the refusal is what makes it safe, not the
arithmetic. `season-rollover.test.mjs` asserts the two together: either the
payload is refused, or the asymmetry is gone. Whoever later makes this state
usable - a heavier price prior, a longer-lived baseline - fails that test until
the asymmetry is fixed too, which is the order the changes have to happen in.

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

## Test-estate rules (hardened 2026-08-15)

An audit pass over the tests themselves, fixing the assertions that could not
fail and pinning the surfaces that had none. The rules worth keeping:

- **Performance budgets are CPU time with ONE owner.**
  `perf-live-size.test.mjs` owns the full-plan ceiling (`FULL_PLAN_BUDGET_MS`),
  `invariants.test.mjs` mirrors it (keep the two equal), and
  `perf-budget.test.mjs` deliberately asserts NO full-plan ceiling: the same
  number on its smaller pool was strictly dominated (320 players cannot breach
  a ceiling 587 are held under) and a duplicated budget constant is exactly
  what drifted in PR #374. The invariants budget was also the suite's last
  wall-clock timing assertion, and it flaked when the machine was busy, never
  when the planner was slow; it measures `process.cpuUsage()` now.
- **A count quoted from the docs must be derived from the source of truth.**
  `experiment.test.mjs` asserted `3 * windows * seeds = 45` after the fourth
  season qualified: a frozen fact that could never fail. It now derives the
  season count from `scripts/backtest.mjs KNOWN_SEASONS` and asserts the
  current 60, so it fails ON PURPOSE when the season list moves, which is the
  prompt to update the counts in README, this file and the registry.
- **The e2e lifecycle fixture no longer bakes a passed deadline into GW1.**
  Until 2026-08-22 `deadlineOffsetMs` put the PLAN gameweek's deadline 30
  minutes in the past for every GW1 state, so every one of those screens said
  "Deadline passed" for GW2 and any actionability assertion there was measuring
  the harness. GW1's own deadline is now the one in the past and GW2's is days
  ahead, which is the real shape of a transfer window; `lifecycle.mjs` asserts
  it (block 7b).
- **A silent skip is a coverage change nobody approved.** The archive-gated
  tests (`player-identity.test.mjs`, 4; `train-dedupe.test.mjs`, 1) each carry
  a guard that scans the file's own source for the gated-skip count and asserts
  the exact skip set for the machine's archive state: zero skips with the
  archive present, exactly the pinned number without it. One further skip is
  deliberate and self-reporting: `optimizer-consistency.test.mjs` skips a
  forced-inclusion class when the sample squad does not exercise it
  (data-dependent, worded in the skip message).
- **Fixtures never read the wall clock.** `pending-transfers.test.mjs` and
  `season-rollover.test.mjs` used `new Date()` for `fetchedAt`; both pin the
  sample's own capture time now, like every other file.
- **`installDom()` at module scope must return its teardown** and register it
  with `after()` (the ui-combobox pattern): a leaked fake `document` reaches
  whatever the runner loads next in the same process. ui-pitch-markers,
  ui-manual-entry and ui-sandbox now do.
- **Module-scope state gets a fresh copy per test via a query-string dynamic
  import** (`import('.../scroll-lock.js?fresh=N')` in
  `ui-scroll-lock.test.mjs`): each specifier is a distinct module registry
  entry, so reference-counting tests cannot leak state into each other.
- **The proxy handler is drivable end to end by stubbing the GLOBAL fetch**
  (`netlify/functions/tests/fpl.test.mjs`): outside a Netlify Blobs context
  `fplStore()` throws, so every such request exercises the memoryStore
  fallback, and the four `x-fpl-*` response headers and the labelled 503 are
  pinned through the real default export. The handler's own catch around
  `serveFpl` is NOT reachable by injection (every constructible failure is
  already caught inside `serveFpl`); it shields future defects and is
  documented as such in the test file.
- **The availability env gate is pinned** (`availability-env-gate.test.mjs`):
  OFF unless `FPL_AVAILABILITY` is exactly `1` or `true`, and the suite fails
  loudly if the variable is exported in the environment running it, because
  every replay-driven test would otherwise measure the rejected arm silently.
- New rendered coverage, all under the mini DOM: the squad table's row model
  and sort (`ui-squad-table.test.mjs`), the charts including the "every charted
  number also appears as text" contract (`ui-charts.test.mjs`), the drawer's
  season-totals caption over the whole evidence enum
  (`ui-player-drawer.test.mjs`), and the dashboard cards that had none - hero
  (including exactly ONE "Deadline passed"), transfers in both shapes, why /
  why-not / renderWhyNot, future, alternatives, chip ledger arithmetic, status
  panel and the withheld view (`ui-dashboard.test.mjs`).
- E2E lifecycle assertion repairs, all verified 3x stable at 95/95: the
  "Check for changes" check was a ternary whose branches were identical (now
  `after && !before`), "says so exactly once" passed at zero occurrences (now
  `=== 1`), the made-transfer check built a regex from unescaped `web_name`
  values and was purely negative (names are escaped and a positive companion
  asserts a recommendation actually rendered), and the scenario captain reader
  ran the same `.find()` three times behind an always-true guard (now the
  vice reader's shape).

- **The e2e lifecycle fixture pins the PLAN gameweek's deadline to 30
  minutes ago for every GW1 state** (`deadlineOffsetMs = -30 min` on
  `planGw`), so those screens always say "Deadline passed" for GW2 and present
  a plan as actionable until the 30-second tick. Any assertion about
  actionability in those states is measuring the harness, not the app.

## What the 2026-08-22 site-wide audit found, and what pins each fix

Every defect below was confirmed in the browser against the production payload
or the e2e fixtures, then fixed with a regression that fails on the old code.

- **The baseline collapse (P1)** is the section above ("Restored, not merely
  refused"), plus `projection_inverted` in `readiness.js`.
- **A null or empty `entry/{id}/history` in-season** read as "no chips used,
  1 FT" and recommended a Wildcard to a manager who had already played his,
  because a 200 with a `null` body is a successful fetch. `historyIsMissing()`
  now names the state, `buildSquadState` offers NO chip on it and raises a
  `history_missing` warning, and readiness caps the ladder at `lineup`. The
  banner is titled by what it is rather than as a price mismatch
  (`squadWarningsBanner`). Pinned by `squad.test.mjs` ("a missing or empty
  season history in-season is flagged, and no chip is offered on it", "an empty
  history before the season starts is not degenerate"),
  `season-lifecycle.test.mjs` ("a missing season history holds the ladder at
  lineup") and the e2e block "a null season history is named on screen".
- **A pick the player list does not carry** produced
  `Cannot read properties of undefined (reading 'position')` behind the generic
  failure screen. `buildSquadState` throws `UnknownPlayerError` naming the ids,
  and `friendlyFailure` maps it (and the validator's own refusal string) to a
  sentence. Pinned by `squad.test.mjs` and the e2e "an unknown pick id is
  refused in a sentence".
- **Disconnect and Delete all left `fpl-planner:cache:entry/*`** (squad, bank,
  history, keyed by team id). Both now clear them, in storage and in memory
  (`entryCacheKeys()`, `fplApi.clearCache({ prefix: 'entry/' })`). Pinned by
  `ui-deletion.test.mjs` (the seed carries three entry-cache keys and a public
  one; the public one must survive) and the e2e "Delete all removes every
  fpl-planner:cache:entry/* key". **privacy.html needs the matching sentence.**
- **Wrong-typed settings** (`{"horizon":"x","risk":42}`, reachable by sync from
  an older version) hit the generic load-failure screen. `sanitizeSettings`
  validates each field against its closed set. Pinned by `ui-store.test.mjs`.
- **Every source `x-fpl-stale: true` under six hours was invisible**: the banner
  keyed off `data_age` alone. `staleSourcesBanner` renders the stale names while
  the plan still shows; past six hours the plan is withheld exactly as before.
  Pinned by `ui-dashboard.test.mjs` and the e2e stale block.
- **An empty fixture list** rendered "Roll your transfer" with a captain reading
  "No fixture, 0.0 xP". `assessData` now withholds the plan with a reason
  (`fixturesMissing`), judging the planner's own source list as well as the
  fetch layer's. Pinned by `ui-plan-model.test.mjs` and an e2e block.
- **An empty `picks` array in-season** rendered the pre-season "Build this
  opening 15" headline; `buildSquadState` raises `empty_picks` and the banner
  says the plan is a fresh build rather than advice about the owned team.
- **The History chart drew the best gameweek shorter than lower ones**: the
  caption was a flex sibling of the track, so a captioned column lost the
  caption's height. The cap now sits INSIDE the track, positioned on top of its
  own fill. Pinned by `ui-charts.test.mjs` (geometry: caps inside the track,
  fill heights monotone in value) and by a rendered-geometry e2e check.
- **Manual entry called a squad "legal so far" that could not be completed**:
  `squadLegality` computes the cheapest legal fill for the positions still short
  and says so when it exceeds the bank. Pinned by `ui-manual-entry.test.mjs`.
- **Swap mode had no exit**: the action bar carries a Cancel button and Escape
  backs out of a swap, an open picker or a selection.
- **A plan computed past its own deadline** read as actionable until the 30
  second tick. `computePlan` now schedules `reactToDeadline` on the next turn -
  inline it did nothing, because the caller still holds the busy flag
  `reactToDeadline` refuses to run under.
- **Live scores never refreshed by themselves** during a gameweek in play; the
  ticker now re-reads the live endpoint on its own TTL while the tab is visible.
- **a11y and mobile**: the History tables and the manual-entry results list are
  focusable scroll regions (`tabindex="0"`, `role="region"`); `.fpl-note > b`,
  the dimmed scenario cards and the transfer picker's heading (which inherits
  the site's `button { color:#555 !important }`) are pinned to readable tones;
  the deadline pill wraps as two phrases rather than three lines at 360; names
  in the five-wide and bench rows wrap instead of truncating; the sticky app
  header sits below the site's fixed 3.25rem header instead of under it.

Two things the audit reported that are NOT app defects, both proved by probe:

- **The axe contrast readings on the plan view** (86 to 139 serious nodes)
  come from scanning while `.fpl-view.is-active` is still fading in: axe
  composites ancestor opacity into every measurement. Waiting for opacity to
  reach 1 gives a clean scan on the same page. Any axe check in this app must
  wait for the fade (`settled()` in `e2e/audit-2026-08.mjs`).
- **The 1px document overflow at 390** is the site's shared `<header>`, which
  renders 391px wide in a 390px viewport on every page. The app root itself
  measures 390/390, which is what the app's own assertions check.

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
