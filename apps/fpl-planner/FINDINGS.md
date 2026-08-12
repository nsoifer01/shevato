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

- `assets/css/main.css` paints `button { color:#555 !important }`, a red
  `button:hover` AND a red `input[type=text]:focus` box-shadow. Every
  interactive element needs counter-pins verified by computed style, never by
  eye. `--text-faint` here is `#77869a` because anything darker fails WCAG AA
  on its five surfaces; the lightest surface is the binding one.
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
- The API-Football key lives in NETLIFY PROJECT ENV as `APIFOOTBALL_KEY`
  (`netlify env:get`), NOT in the repo `.env`. Free tier, 100 requests/day,
  active to 2027. EPL injuries come one season per request with NO pagination,
  so the whole 3-season backfill costs 3 requests.

## Operational state (recorded at the 2026-08-12 pause)

- **The app is release-ready but UNRELEASED.** `apps/fpl-planner` exists only
  on `feature/fpl-planner` (13 commits, never pushed); `origin/master`, which
  is what shevato.com deploys, has no FPL Planner. Releasing is push -> PR ->
  owner merge, and is an owner decision. Until then there is NO deployed
  production path to verify, and "production" claims in this file describe the
  intended architecture.
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
- **Wake-up triggers, in order of likelihood:** (1) GW1 of 2026-27 goes live:
  validate the real import path once (squad, transfer history, selling
  prices, live defcon) - a production-validation trigger, not a tuning
  licence; (2) early 2026-27: confirm vaastav's merged_gw.csv is accumulating
  gameweeks - if that archive ever stops, THEN build the minimal collector;
  (3) a fifth complete season, which un-parks the prior-weight family and any
  underpowered question; (4) discovery of the 2023-24 prior-value channel;
  (5) an observed real-use planner failure, which outranks all speculative
  work.

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
