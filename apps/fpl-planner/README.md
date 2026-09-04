# FPL Planner

**Enter your Fantasy Premier League Team ID and get one plan for the gameweek: the transfers to make, whether to take a hit or roll, who to captain and vice-captain, whether to play a chip, and the eleven to start. Every recommendation is explained from the numbers that produced it.**

Data comes from the public Fantasy Premier League API. This app is not affiliated with, endorsed by, or connected to the Premier League or Fantasy Premier League.

## How it works

You give the app one number. Everything else is read: your squad, bank, squad value, transfer history, chips played, overall rank, plus the whole player database and fixture list. The engine then rebuilds the state that FPL does not hand out directly, projects points per player per gameweek, and searches for the best legal, affordable plan.

Plans are scored over a rolling horizon, and the default is **5 gameweeks**. It was 3 until 2026-08-12, on evidence measured with a replay that could not represent expected minutes; on the deciding instrument (paired trajectories read as windows, chips off; 15 windows on the three seasons then replayable) horizon 5 beats horizon 3 by 21.6 points a window with a t of 2.32, winning 11 windows to 4 and gaining in every season then measurable. Horizon 8 also beats 3 but by less, so 5 is an interior optimum rather than "longer is better". Full-season replays WITH chips read +66 for horizon 5 while losing two seasons of three, which is the weakest instrument in the project and is reported rather than acted on. The tables live next to `DEFAULT_HORIZON` in `js/engine/planner.js` and in `experiments/registry.md` entry 9. Settings offers 3, 5 or 8.

### The FPL API, and what it does and does not give you

- It is fully public: **no key, no account, no credentials**.
- It sends **no CORS headers**, so a browser on shevato.com cannot call it. Every read goes through `netlify/functions/fpl.mjs`.
- It does **not** publish selling prices. `now_cost` is the wrong number to spend against: FPL takes half the profit on any player who has risen since you bought him. Purchase prices are reconstructed from `entry/{id}/transfers` and the sell-on rule is applied on top (`js/engine/squad.js`).
- Its `entry_history.value` is a **snapshot frozen at that gameweek's deadline**, not a live total: it does not move when prices do, so one overnight change is enough to make it disagree with what the squad is actually worth. SQUAD VALUE in the header is therefore the reconstructed total (the fifteen at their selling prices, plus the bank). A disagreement is reported rather than absorbed, but only the part of it that price movement since the deadline cannot account for: the check rolls every price back with `cost_change_event` before comparing, so an ordinary overnight move is silent and a reconstruction that genuinely fails to add up is not. The frozen figure is used for display in one case only: an in-season payload that arrives with no picks, where there is nothing to reconstruct from.
- It does **not** publish your free transfer count. That is replayed from `entry/{id}/history` by `js/engine/transfer-state.js`, the ONE module allowed to know the transfer arithmetic: unlimited before the GW1 deadline (a state, not a number), then 1 per gameweek, rolling to a cap of 5, with wildcard and free hit weeks preserving the banked count. Every other module (planner, transfer search, chips, replay, UI wording) consumes it rather than re-deriving it; the off-by-one that lived in the scattered copies contaminated every replay until 2026-08-11.
- Two rules genuinely are not in the payload and are the only hardcoded ones, both in `js/engine/rules.js` with a comment saying so: the defensive-contribution thresholds (10 actions for a defender, 12 for a midfielder or forward) and the 4-point transfer hit. Everything else, including the scoring table, squad size, budget, club limit, sell-on fee, free-transfer cap, position limits, chip windows and the season label, is read from `bootstrap-static`.

### Pre-season

The 2026/27 season has not started. No event carries `is_current`, and `entry/{id}/event/{gw}/picks` returns 404 for every gameweek, so **no real squad can be imported yet**. That is a normal state, not an error: `buildGameState` reports `seasonStarted: false` and `currentEvent: null`, `buildSquadState` returns a `source: 'draft'` squad state with the full 100.0m budget, and the app routes to the pre-season squad builder. When GW1 goes live the normal import path takes over with no code change.

A pre-season squad exists in two encodings: the optimizer's draft (`source: 'draft'`, no picks, the budget in the bank) and a typed or snapshot-restored squad (`source: 'manual'`, the fifteen held as picks with the change in the bank). Everything that shows pre-season money reads it through `openingSquadMoney` in `engine/squad.js`, and every "is this a draft?" question outside the transfer search treats both sources as the opening squad, so the two encodings can never tell different stories on screen (FINDINGS, "The two pre-season encodings").

To exercise the in-season experience today, load the app with **`?demo=1`**. See "Sample data" below.

## Layout

```
apps/fpl-planner/
  README.md              this file: what the app is and how it works
  FINDINGS.md            accumulated engineering knowledge; read before working here
  index.html             app shell (SEO head, shared chrome, root wrapper)
  css/styles.css         all app styling, scoped to .fpl-planner-app
  js/
    app.js               UI orchestration: boot, load, run, render, persist
    worker.js            plan computation worker (and "why not" answers)
    ui/dom.js            element helpers, card and disclosure shells
    ui/format.js         display formatting (points, money, relative time, countdown)
    ui/plan-model.js     pure readers over a PlanBundle, plus the worker wire shape
    ui/store.js          the four localStorage keys, team-id validation, plan versions
    ui/plan-runner.js    worker lifecycle with an inline fallback
    ui/parts.js          banners, the sample-data label, staged loading
    ui/dashboard.js      hero, transfers, chips, pitch card, why, future, alternatives, status
    ui/pitch.js          formation rows, bench order, player cards
    ui/charts.js         SVG/HTML column chart, trend line and sparkline (no libraries;
                         every charted number also appears as text nearby)
    ui/squad-table.js    the squad as a sortable table, the pitch's alternate view
    ui/player-drawer.js  modal player drawer: projections, minutes, points breakdown,
                         season totals, all read from the plan's own inputs
    ui/scroll-lock.js    reference-counted page scroll lock for modal overlays;
                         any future modal locks through it, never its own way
    ui/combobox.js       searchable, keyboard-accessible player picker
    ui/scenario.js       the editable copy of a squad: edits, money, legality,
                         and the SquadState the planner is re-asked with
    ui/sandbox.js        the editable team view (select-then-act, the action
                         dock, the picker, the before/after strip); a
                         persistent view updated in place, draws and
                         dispatches only
    ui/plan-diff.js      "what changed" between two stored plan versions
    ui/history.js        gameweek history, season-at-a-glance charts, saved plan versions
    ui/settings.js       planner settings and the two deletion actions
    ui/preseason.js      pre-season routing, assisted manual squad entry
    data/api.js          browser FPL client (proxy, caching, freshness, dedupe)
    data/model.js        loads the trained-model artifact, honours engineConsumes
    data/sample.js       ?demo=1 sample dataset loader
    data/opening-baseline.js  fetches the shipped opening-season baseline
    engine/
      rules.js           rules, scoring table and chip catalogue from bootstrap
      normalize.js       bootstrap + fixtures -> Player / Team / Fixture / Event
      lifecycle.js       THE gameweek and fixture phase model (provisional vs final)
      baseline.js        payload completeness, the kept last-good season totals,
                         and which baseline (kept or shipped) stands in
      readiness.js       what the data licenses: display / lineup / transfers / chips
      live.js            event/{gw}/live -> actual points, reconciled to FPL's total
      transfer-state.js  THE free-transfer state machine (pre-season, rolling, chips)
      squad.js           entry data -> SquadState (prices, bank, FTs, chips)
      strength.js        team attack and defence ratings
      fixtures.js        Poisson fixture model
      minutes.js         pAppear / pStart / xMins
      projections.js     position-specific expected points
      ml.js              ridge / poisson / logistic regression, calibration, metrics
      lineup.js          optimal XI and bench order

**The one expected-points number, and its named parts.** `plan.xPointsGw` is
"expected final FPL points this gameweek": what the manager should expect to
score. `planner.js` `gameweekPoints()` is the only place it is computed:

    xPointsGw = xPointsXi                       the eleven that starts
              + xPointsAutosubs                 legal auto-substitutions,
                                                zero under Bench Boost
              + m * xPointsCaptaincy            m = 2 under Triple Captain else
                                                1; each copy is the captain when
                                                he plays and the VICE when he
                                                does not
              + xPointsBenchPaid                Bench Boost only

Each component is carried on the plan under those names, so nothing downstream
re-derives "expected points" a second way. `xPointsNet` is the same number less
the hit. `xPointsHorizon` and `objective` are a DIFFERENT quantity - the
discounted ranking objective - and deliberately contain neither
auto-substitutions nor vice succession; see the note in `gameweekPoints`.
      captain.js         captain and vice-captain
      transfers.js       transfer search, hits, roll value
      squad-builder.js   full 15-man build (wildcard, free hit, pre-season)
      chips.js           chip evaluation across the season
      planner.js         multi-gameweek rolling horizon, top-level entry point
      explain.js         model-derived explanations
      counterfactual.js  "why not this player": forced-inclusion re-optimization
      confidence.js      HIGH / MODERATE / LOW band, derived from engine state
      odds.js            bookmaker-odds abstraction (inert, nothing imports it)
      validate.js        the single legality gate
      backtest.js        historical replay harness
      experiment.js      paired-trajectory plan, statistics and report
      player-identity.js canonical cross-season identity (`code`), and the
                         refusal to key a cross-season join on `element`
  models/                versioned model artifacts (JSON)
  data/sample/           trimmed sample dataset for ?demo=1
  data/opening-baseline.json  last complete pre-wipe season totals, with provenance
  experiments/           registry.md (every experiment + verdict), leaderboard.md,
                         one write-up per experiment; the registry's Methodology
                         section ranks the measurement instruments and is required
                         reading before running a new experiment
    configs/             one file per runnable experiment, including null-arm.mjs
                         (the runner's own control) and baseline.mjs
  scripts/               fetch-history, fetch-availability, validate-history,
                         train-model, evaluate-model, backtest, experiment
                         (+ its worker), evidence-probe (health invariants
                         against the live payload), derive-gw1-fixtures
                         (sanitized lifecycle fixtures from captured payloads)
  e2e/                   browser suites (raw CDP): the interactive scenario
                         workflow and the gameweek lifecycle boundaries
  GW1-RUNBOOK.md         the live checks to run around the opening deadline
  tests/                 *.test.mjs plus committed fixtures/
netlify/functions/fpl.mjs           the FPL read proxy
netlify/functions/lib/fpl-cache.mjs its allowlist, TTL policy and cache pipeline
```

Every module under `js/engine/` is a pure ES module with no DOM access, so `node --test` imports it directly. Only `app.js`, `worker.js`, `ui/*` and `data/*` touch browser APIs. `apps/fpl-planner/package.json` sets `"type": "module"` so the `.js` engine files are ESM under Node as well as in the browser.

## Conventions that matter

- **All money is integer tenths of a million.** `now_cost: 155` is 15.5m. Nothing stores money as a float; formatting happens only at the UI edge (`formatMoney`).
- Position ids are `1 GKP, 2 DEF, 3 MID, 4 FWD`. Players cross module boundaries as numeric FPL element ids, never names.
- **An element id identifies a player only WITHIN one season.** FPL reassigns them every year: of the element ids present in two consecutive seasons of the archive, 0.0% to 0.13% are the same footballer. Anything that spans a season boundary must key on `code`, which is permanent, through `js/engine/player-identity.js`. It throws rather than falling back to an id, because the failure mode is silent: a wrong join returns a full table of plausible numbers. See `experiments/cross-season-identity.md`.
- Probabilities are 0..1 floats. Times are ISO 8601 UTC.
- Zero npm dependencies. No bundler, no TypeScript, no build step.

## The data layer

`netlify/functions/fpl.mjs` fronts an anchored allowlist of read-only endpoints (`bootstrap-static`, `fixtures`, `entry/<id>`, `entry/<id>/history`, `entry/<id>/transfers`, `entry/<id>/event/<gw>/picks`, `element-summary/<id>`, `event/<gw>/live`). Anything else is refused with 400 before it can reach upstream, and requests from an origin other than shevato.com or local dev are refused with 403.

Responses are cached in Netlify Blobs, so a thousand visitors cost roughly one upstream fetch per TTL window: 10 minutes for the bootstrap, 30 for fixtures, 5 for entry endpoints, 15 for a player summary and 1 for live scores. Inside the six hours before a deadline every TTL collapses to 2 minutes, because that is when prices and injury news move. If upstream fails, the last cached copy is served with `x-fpl-stale: true` and its age in seconds; only when there is no cached copy at all does the function return 503. An unknown team id passes through as a 404 and is never cached.

`js/data/api.js` wraps that with a memory and `localStorage` cache under the `fpl-planner:cache:` prefix, per-endpoint TTLs, and single-flight de-duplication so a dashboard asking four components for the bootstrap downloads it once. Those cache keys are deliberately **not** in the app's sync namespace: they are large, identical for every user and fully derivable.

The browser cache mirrors the proxy's deadline policy: inside the six hours
before a deadline its TTLs collapse to two minutes as well, read from the
deadline in the bootstrap it already holds, so a stale local copy cannot mask a
fresher shared one in the hour that matters. Freshness is measured from a
locally recorded receipt time rather than by subtracting a server timestamp from
the device clock, so a device with a wrong clock neither pins the cache forever
nor expires good data instantly; the age SHOWN is still the data's age. A
transient 5xx or aborted request is retried once with jitter, inside the same
timeout budget. The bootstrap is held in memory only, because at 2.6 MB it is
over half the origin's localStorage budget and every other app on the domain
shares it; when a write does fail, the oldest cached endpoint is evicted rather
than the whole cache.

## The trained model, and why nothing from it is used

`scripts/train-model.mjs` writes a versioned artifact into `models/` and records
it in `models/index.json`. **Superseded artifacts stay in `models/` and stay
registered in the index on purpose.** Only the highest version is ever loaded,
so `models/fpl-planner-v1.json` never reaches the engine, but it is the evidence
behind the REJECT verdict recorded in `experiments/registry.md` section 2 and
the comparison baseline `scripts/evaluate-model.mjs --model` takes: deleting it
would make that verdict un-retestable. It is retained history, not a stale file.

`js/data/model.js` loads that index at boot, takes the
highest version in it, and passes on only the parts the artifact names in its own
`engineConsumes` list, as `options.model` into `buildPlan` and from there into the
worker where planning actually runs. A retrain is a file drop: append to the
index, ship the JSON, no code edit and no version string to update.

**The current artifact names nothing, so every plan runs on the analytic priors
in `js/engine/projections.js`.** `models/fpl-planner-v2.json` declares
`engineConsumes: []`, and its `engineConsumesDisabledBecause` field carries the
measurement behind that. The short version: its start calibrator is better than
its own statistical baseline (test log loss 0.3006 against 0.3135, expected
calibration error 0.0447 improved to 0.0221) and it costs FPL points. Two
leakage-free full-season replays, each run with a model trained excluding the
season being replayed, then that season replayed with and without it:

| Season replayed | Model trained on | planner | greedy-xp | hold |
| --- | --- | --- | --- | --- |
| 2024-25 | 2022-23, 2023-24 | 2371 to 2211 (-160) | 2284 to 2215 (-69) | 2006 to 1953 (-53) |
| 2023-24 | 2022-23, 2024-25, 2025-26 | 1943 to 1853 (-90) | 1947 to 1892 (-55) | 1928 to 1944 (+16) |

Both seasons, both decision-making strategies, same direction. In 2024-25 the
planner's edge over greedy collapsed from +87 to -4 and projection bias went from
+0.33 to +2.6 points per gameweek. A better log loss is not a better team, and a
better log loss on its own is not grounds to switch this back on.

**Those totals are dead numbers.** Like everything measured before 2026-08-12
they came off a replay whose expected-minutes model was degenerate
(`experiments/replay-evidence.md`), so do not compare a new run against them. The
verdict is not in doubt: the artifact lost in both seasons under all three
decision rules including `hold`, which makes no transfers, and a defect in the
transfer path cannot be what produced a loss there. Re-testing it means
re-measuring both arms.

The calibrator stays in the artifact so the decision can be re-tested.
`scripts/backtest.mjs --model <path>` is the way: it applies the artifact
directly, ignoring `engineConsumes` so the runtime switch cannot mute the
experiment, and it refuses to run when that artifact's `seasons` list includes
the season being replayed, printing the `train-model.mjs` command that would
produce a clean one. `js/engine/backtest.js` passes no model on any normal run,
so the default replay stays leakage-free.

The points model was never consumed either, for a different reason recorded in
`pointsModelNotConsumedBecause`: it was measured against a points-per-game
baseline rather than against this engine's component-built projection, so
clearing that bar is not evidence it would improve anything here.

A missing, unreachable or malformed artifact is not an error either. The model
and data status panel reports the version that actually produced the plan
(`planner-1+analytic-1` today) and, on the "Trained model" row, which of three
states it is in: loaded and used, loaded and deliberately not used, or not loaded
with the reason why.

## The team sandbox

"Your team" carries three views of the same fifteen, and keeping them distinct
is the feature's whole safety property:

- **Current team**, the squad FPL says the manager owns.
- **My scenario**, an editable copy.
- **Recommended**, what the planner would do.

The scenario is where a manager answers his own questions. Selecting a player
offers what can be done to him in the **action dock**: a control surface that
lives in the flow after the bench and pins near the bottom of the viewport
while a selection or the picker is live, so the actions are visible wherever
on the pitch the press happened. Swap him with a substitute, transfer him out,
give him the armband, move him up the bench, or open the existing player
drawer. Transfers open a ranked picker in the same dock, of same-position
replacements carrying club, price and projection, with unaffordable or
club-limited options left visible and annotated rather than hidden; its option
list opens upward so it never leaves the screen. "Show expected points" adds
start probability, expected minutes and the per-gameweek shape to every card.
Undo steps back one edit at a time (offered both in the toolbar and beside the
dock right after an edit) and "Reset to my team" returns to the import.

The view renders through `createSandboxView` in `js/ui/sandbox.js`: one stable
DOM skeleton, updated in place by diffing props on object identity (every
scenario edit returns a new object, so `!==` is exact). A selection click
toggles classes on existing cards; only a real edit rebuilds the pitch; the
whole app is never re-rendered for a sandbox interaction. FINDINGS.md records
why that discipline exists and the measurements behind it.

**The flow is `imported SquadState -> Scenario -> SquadState -> buildPlan`**, and
only the first arrow copies. `js/ui/scenario.js` owns that value and no rules:
free transfers and hits come from `transfer-state.js`, selling prices from the
imported pick or `rules.js`, and legality from `validate.js` — the same gate
every recommendation passes, which is why a refused edit is explained in the
validator's own words instead of arriving as a disabled button. "Ask the planner
from this team" hands the edited squad to the ordinary `buildPlan`, so a
hypothetical needs no second engine; its answer is held apart from the real one,
is labelled as being about the edited team, and is never written to plan history
or counted by analytics.

Two quantities are reported and they measure different things. **This gameweek**
is the eleven and the armband the manager actually chose. **Squad, next N GWs**
scores the fifteen with the best eleven each week, because today's lineup does
not bind next week's — so a change that only moves the armband leaves it
identical by construction, and the verdict line leads with the gameweek number
whenever no transfer was made.

Before the first deadline there is no squad to import, so the scenario is seeded
from the opening fifteen the optimizer built and the "Current team" tab is not
offered. A change there is a build rather than a transfer: it costs no hit and
the bank is simply the budget less the fifteen, which is the same distinction
`validate.js` draws with `isFreshBuild`.

## Why the app cannot make your transfers for you

The app recommends; Fantasy Premier League is where a plan becomes real, and
the manager applies it there by hand. Nothing here can bridge that: FPL's write
endpoints need the manager's own login, this app has no account system for
third-party credentials, and the proxy is a read-only allowlist that would have
to be widened to a POST for a password it must never hold.

A bookmarklet was built to close that gap in September 2026 and removed on
2026-09-03 when it turned out it could not work. FINDINGS, "The write path, and
why there is not one", records what was tried, what FPL's authentication
actually looks like now, and what would have to change before it is worth
attempting again. Do not rebuild it without reading that first.

## The gameweek lifecycle

A gameweek is not "before" or "after". `js/engine/lifecycle.js` derives a phase
from the payload itself, because every consumer that guessed one from
`fixture.finished` guessed differently:

| Phase | What it means |
| --- | --- |
| `preseason` | no event current, deadline ahead |
| `pre-deadline` | in-season, squad still editable |
| `deadline-passed` | locked, nothing kicked off |
| `in-progress` | at least one fixture live |
| `provisional` | every started fixture at full time, none signed off |
| `finalising` | fixtures final, event not `data_checked` |
| `complete` | event `finished` AND `data_checked` |

Each fixture carries its own phase too: `upcoming`, `live`, `provisional`,
`final`. The distinction that matters is the third one. **FPL leaves `finished`
false from the final whistle until bonus and stat corrections are applied** - the
opening match of 2026/27 was still unsigned eleven hours later - and
`normalizeFixture` used to discard
`finished_provisional` entirely, so the app could not tell a match being played
from a match that was over. Every count of matches played now counts a
provisional full time, because a match that has been played has been played.

Clubs do not move through a gameweek together, either. `clubsLevel` says whether
every club has played the same number of matches; until it is true, players are
not comparable across the league.

## Which season the numbers describe

`bootstrap-static.elements` carries season totals and the fixture list carries
the matches played, and Fantasy Premier League rolls those two over at different
moments. Around the first gameweek they routinely describe different seasons,
and reading them together is silently wrong in both directions: last season's
totals against one played match make every regular look like a certain starter,
while totals already cleared to zero make every player look like he never plays.
Neither is visible from the numbers themselves, because both stay inside every
legal range.

`seasonEvidence()` in `js/engine/minutes.js` decides which season the totals
belong to from arithmetic facts about football rather than from a date: a player
cannot have started more matches than his club has played, and a payload where
almost nobody carries a minute is not a season. It returns `previous-season`,
`current-season`, `partial-season` or `none`, and only the first two are usable.

### The baseline, and why a wiped payload cannot destroy it

At 18:04 UTC on 2026-08-21, the moment GW1 went current, FPL cleared every
element total. Raya went from `starts: 37, minutes: 3330` to `starts: 1,
minutes: 90` while the app was running, and the old code had no way to notice
because a payload was whatever the last fetch said it was.

`js/engine/baseline.js` separates "the newest payload" from "the best evidence":

1. every payload is scored by `assessBaseline()` before it is believed;
2. the last one that scored well is kept in `localStorage`;
3. a payload that fails does not replace it, and the kept baseline supplies the
   season totals until this season has enough matches of its own.

**And the app ships a baseline of its own, because step 2 could not save
anybody in 2026.** The guard above reached production 22 hours after FPL wiped
the totals, and `snapshotFrom` only ever snapshots a COMPLETE payload, so no
browser ever kept one and every visitor was refused a plan for the opening
month. `data/opening-baseline.json` is the last complete payload before that
wipe, derived by `scripts/build-opening-baseline.mjs` and committed with its
provenance (source file, sha256, capture time). `resolveBaseline` picks, in
order: a kept snapshot that carries its rate numerators, then the shipped
asset, then a minutes-only kept snapshot, then nothing. The shipped asset is
only fetched when the season has rolled over and is not yet a season of its
own, may only be applied to the season it was captured in (`appliesToSeason`
AND the opening deadline both have to match), and retires with every other
baseline at three matches per club.

Completeness is measured **per active player**, not as a league aggregate:
16.8 starts each over 400 players before the wipe against 1.0 each over 22
after. A league aggregate silently encodes the pool size and fails on any pool
smaller than a real league.

**The snapshot carries every numerator whose denominator it restores** (version
2, `RATE_FIELDS` in `engine/baseline.js`). Version 1 kept `{starts, minutes}`
only, which are the DIVISORS of every rate the engine computes, while FPL
clears the dividends (`expected_goals`, `expected_assists`,
`expected_goals_conceded`, `bps`, saves, goals, assists, clean sheets, the
defensive-contribution parts) in the same wipe. One match of attacking output
over a season of minutes is how the planner came to field five defenders and
captain one of them on 2026-08-22.

**The blend fades the baseline out of numerators and denominators together.**
`normalizePlayer` sets the evidence totals to `baseline + this season`, and the
denominators to match: `evidenceMatches` is the baseline's season plus the
matches this player's club has played, and every per-90 rate is read over the
blended minutes. The two therefore grow at the same pace, and
`baselineIsSuperseded` retires the snapshot outright once every club has played
three matches.

**A version 1 snapshot already in a user's localStorage is read, but not
divided.** Its minutes still serve the minutes model; `rateMinutes` restricts
every rate to THIS season's minutes, so a cleared numerator is never divided by
a restored denominator, the shrinkage layer resolves those rates to the position
priors, and `readiness` blocks transfers with `baseline_rates_missing` and says
so. The next complete payload replaces it with a version 2 snapshot.

The baseline is retired by `baselineIsSuperseded()` once every club has played
three matches, so one bad August payload cannot freeze the app on last season.
`gameState.baselineSource` says which is in force, and the UI says so too.

Data species are kept apart in `normalizePlayer`: `starts`/`minutes` are the
evidence totals a baseline may overlay, while `seasonStarts`/`seasonMinutes`/
`seasonPoints` are this season's own and are never overlaid. Conflating them is
what let the player drawer label one match of a new season "Last season".

## What the data is good enough to recommend

`evidence.usable` was a single boolean the UI checked at render time, so showing
a rough projection and betting a Wildcard cleared exactly the same bar. On
2026-08-21 the app recommended playing a Wildcard - eleven changes - on
projections that had collapsed, under a caption reading "100% of this gameweek's
projected points sits on players whose minutes are unclear".

`js/engine/readiness.js` makes it a ladder, and `planner.js` consults it
**before proposing anything**:

| Level | Licenses |
| --- | --- |
| `display` | the squad, live points, fixtures |
| `lineup` | ordering an eleven the manager already owns |
| `transfers` | spending money and free transfers |
| `chips` | spending a once-or-twice-a-season asset |

Chips are not evaluated at all without a chip-grade licence, and transfer
candidates are not built without a transfer-grade one, so a refusal degrades to
holding the squad rather than to a blank screen. Every refusal carries a code
and a sentence. The pool is also checked for shape - a collapsed spread, start
rates pinned at one, a best eleven that is not a football score, and the best
forwards and midfielders projecting BELOW the best defender (`projection_inverted`,
the 2026-08-22 shape, which every aggregate check passed) - and those checks
apply only to a real-sized pool, because they are claims about a league.

Two further blocks are about the manager's own records rather than the pool:
`baseline_rates_missing` (a minutes-only snapshot is standing in, so rates are
position averages) and `history_missing` (`entry/{id}/history` came back null or
with no gameweek rows in-season, so the chips already played and the banked free
transfers are unknown). Both cap the ladder at `lineup`, and `buildSquadState`
offers no chip at all when the history is degenerate: a 200 with a `null` body
is a successful fetch, which is how a Wildcard came to be recommended to a
manager who had already played his.

Confidence follows: `assessConfidence` returns a fourth band, `unusable`, which
is **not** the bottom of the same scale. The three ordinary bands grade how sure
a sound projection is; this one says the inputs failed, and reads
"Recommendations paused" with the reason.

## Live points during a gameweek

`event/{gw}/live` was wired into the API layer and called from nowhere, so the
app had no per-player points at all. `js/engine/live.js` now consumes it, and
the Current team pitch shows what each player has ACTUALLY scored above what he
is expected to score next gameweek. The two never share a field or a label.

The arithmetic is FPL's: `picks[].multiplier` already encodes the armband and
the bench, a player's score is `live.elements[].stats.total_points`, and
automatic substitutions are applied by FPL at gameweek end rather than live. The
team total is checked against `entry_history.points` rather than trusted, and
`reconciles` reports the answer.

Three renderings, because three states are genuinely different: a dash for a
player whose match has not kicked off (he has no score), a zero for one whose
match finished without him (that IS his score), and a tinted figure for one who
played, captioned `live`, `bonus pending` or final.

While the gameweek is `in-progress` and the tab is visible, the 30 second ticker
also re-reads `event/{gw}/live` (`refreshLive` in `app.js`). The data layer's
own 60 second TTL bounds the requests, and the view is re-rendered only when a
score actually moved, so an open disclosure is not closed for nothing. Before
this the endpoint was read at boot and again only on "Check for changes", so a
manager watching a match saw frozen scores under a freshness line that kept
ticking.

## The squad you own, not the squad you fielded

`entry/{id}/event/{gw}/picks` is frozen at that gameweek's deadline. A transfer
made for the next gameweek shows up immediately on `entry/{id}/transfers` and
nowhere else, so the picks alone describe a squad the manager no longer has.
`buildSquadState` overlays the transfers belonging to the gameweek being
planned: the players change, the bank moves by the prices in the transfer rows,
and the free transfers already spent come off the count through
`transfer-state.js`. Without it the planner recommends a move that has already
been made and understates a hit by four points for every free transfer already
used.

## Answering "why", "why not" and "how sure"

Three layers sit on top of the plan, all fed by engine numbers rather than
written alongside them (a test asserts the number in a sentence equals the
number in the model):

- **Why not this player?** (`js/engine/counterfactual.js`) re-runs the SAME
  optimizer with the player forced in and compares like for like. Pre-season the
  baseline is rebuilt unconstrained in the same call, from the same snapshot,
  with identical options, because a stored squad compared against a fresh search
  once produced the contradiction "best squad 131.9" above "best squad with
  Haaland 134.1". `tests/optimizer-consistency.test.mjs` now asserts a forced
  build can never beat the unconstrained one. In season it evaluates the best
  1-and-2-transfer routes instead. "Cannot fit" is only ever a claim about the
  game (unavailable, budget-impossible, club limit, unfillable position), never
  about the search.
- **Confidence** (`js/engine/confidence.js`) renders HIGH / MODERATE / LOW with
  the reasons, derived from minutes uncertainty, injury flags, data freshness,
  horizon distance and how close the runner-up plan is. Never an invented
  percentage.
- **What changed?** (`js/ui/plan-diff.js`) diffs the stored plan versions when a
  resync moves the recommendation, and cites the field that moved ("Player A is
  now flagged injured"). Computed, never narrated.

## Measuring a change to the engine

`scripts/backtest.mjs` replays one season. That is a sanity check, not evidence:
a single trajectory forks on one chip decision and diverges by hundreds of
points. The instrument that decides is **paired trajectories read as windows**
(five sliding chip-free windows per season, each replayed at three seeds, seeds
averaged within a window before inference; on the current four replayable
seasons that is 20 windows and 60 trajectories), and `scripts/experiment.mjs`
runs it on eight worker processes in about six minutes for a two-arm
comparison:

```sh
node apps/fpl-planner/scripts/experiment.mjs \
  --config apps/fpl-planner/experiments/configs/availability.mjs
```

A config names the arms; one of them must be called `control`. An arm may carry
`env` (applied around its own cells), `opts` (merged into the replay options) or
`strategy` (so "planner against greedy on the same trajectories" is the same
kind of measurement as everything else). The runner:

- re-measures the control arm every time, and offers no way to compare against a
  stored baseline, because four separate experiments in this project have been
  invalidated by a baseline that moved;
- fingerprints `js/engine`, `scripts/` and the season data before the run and
  again after it, and refuses to report a run whose tree changed underneath it;
- averages the seeds inside a window before counting, because three seeds
  through one window are the same thirteen gameweeks with a different search RNG
  and counting them separately triple-counts any effect that lands in one
  window;
- writes a markdown report with the per-window table, the win/loss/tie split,
  the standard error, a t statistic, a sign test and the caveat that overlapping
  windows make the standard error optimistic;
- computes no verdict. That is a human decision, recorded in
  `experiments/registry.md`.

`experiments/configs/null-arm.mjs` runs two IDENTICAL arms and must report
exactly zero on every trajectory (60 on the current configuration). Run it after touching the runner, the
worker or the replay harness. `--rerender <results.json>` recomputes the
statistics and the report from a finished run's stored cells, which is how a
change to the statistics is applied without re-running the replays.

Before measuring anything on a freshly downloaded archive, check it against
facts that do not come from the app:

```sh
node apps/fpl-planner/scripts/validate-history.mjs
```

A season contains 11 x 2 x 380 starts; a row's points rebuild from its own
components under the scoring table; `players_raw.csv` has to exist or a
cross-season join has no `code` to key on; a repeated player-gameweek is a
double gameweek when the fixture ids differ and a duplicate when they do not.
Both data defects found on 2026-08-12 would have shown up here in seconds.

## The availability signal (off by default)

`scripts/fetch-availability.mjs` pulls historical EPL injury and doubt records
from API-Football (the key lives in Netlify env as `APIFOOTBALL_KEY`, free tier,
one request per season, no pagination) and the replay can consume them behind
`FPL_AVAILABILITY=1`. It ships OFF: the signal is retrospective by construction
(a record's fixture date is a kickoff, which is after the deadline, so only
earlier gameweeks may inform a prediction), which means it flags a player the
week AFTER he goes down and clears him the week AFTER he returns.

Its prediction metrics improve on all three seasons and its planner points do
not. Settled on 2026-08-12 on a corrected instrument: **+11.4 points a window
with a standard error of 10.8, seven wins and seven losses, sign test p = 1.00**,
and the whole aggregate is one window (2023-24 gw20-32). A REJECT in
`experiments/registry.md`, reopened only by a pre-deadline source of team news or
an expected return date. With the flag unset the replay is bit-identical to not
having the feature.

## Sample data (`?demo=1`)

`data/sample/` holds a synthetic in-season snapshot (about 120 KB): 320 players across all 20 clubs, all 380 fixtures with 12 gameweeks played, a 15-man squad whose purchase prices differ from current prices, a bank, 2 rolled free transfers, a wildcard and a bench boost already spent, an injured player in the squad, and a blank gameweek at GW16 with the matching double at GW17.

It exists because the in-season experience cannot be tested against live data until the season starts. **It is never a silent fallback.** It loads only when the URL asks for it, `api.useSampleData()` refuses any bundle not labelled `sample: true`, and the flag travels all the way to the data-status panel.

Players and fixtures are stored as a column table (field names once, one row per record) purely for size; `expandTable()` in `js/data/sample.js` restores the exact upstream shape before anything else sees it.

## Storage, sync and removal

Four keys, all in the `fplPlannerApp` sync namespace registered in
`sync-system/app-sync-init.js`: `fplPlannerTeamId`, `fplPlannerSettings`,
`fplPlannerPlanHistory` (per gameweek, capped at 5 versions and 8 gameweeks) and
`fplPlannerSquadSnapshot`. The bulk FPL data is NOT synced: it is large, public
and identical for every user, so `js/data/api.js` caches it under the unsynced
`fpl-planner:cache:` prefix. Signed out, everything works from localStorage.

Settings offers two removals, and says plainly that it cannot do the third:

- **Disconnect your FPL team** clears the team id and the squad snapshot. Both
  go through `localStorage.removeItem`, which the sync layer turns into a
  tombstone, so the cloud copy of those two keys goes with them. Plans and
  settings are untouched, and reconnecting the same team id restores everything.
- **Delete all FPL Planner data** clears all four keys and, when signed in,
  calls `eraseCloudData('fplPlannerApp')` to delete the whole Firestore
  document. It asks for confirmation first.
- Both also drop `fpl-planner:cache:entry/*`, the unsynced cache entries that
  hold this manager's squad, bank, history and transfers under a key containing
  his team id (`entryCacheKeys()` plus `fplApi.clearCache({ prefix: 'entry/' })`,
  which clears the in-memory copies too). The public bulk cache is kept: it is
  identical for every user and says nothing about anyone. Until 2026-08-22 both
  buttons left the entry keys behind.
- **Deleting the Shevato account** is not offered here, because the account
  spans every app on the site.

Both say which copies they actually removed, and say so differently when signed
out. `privacy.html` describes this behaviour, so the two have to stay in step.

## Viewing locally

It is a static app, but the FPL API cannot be read from a browser without the proxy, so how you serve it decides what data you get:

```sh
# Full experience, including live FPL data: runs the Netlify function too.
netlify dev
# open http://localhost:8888/apps/fpl-planner/        (netlify.toml pins 8888)

# Plain static server: the proxy does not exist, and a direct call to FPL is
# blocked by CORS. Use the sample dataset.
python3 -m http.server 8082
# open http://localhost:8082/apps/fpl-planner/?demo=1
```

**The two-port trap:** `netlify dev` listens twice, on the Netlify proxy (8888)
and on an internal static file server (commonly 3999). Only the proxy routes
`/.netlify/functions/*`. Open the internal port and every data call 404s, then
the direct fallback dies on CORS. The app detects that exact combination and
says which port to use (`ProxyUnavailableError` in `js/data/api.js`) instead of
showing a generic network error.

## Running tests

```sh
npm run test:fpl-planner          # apps/fpl-planner/tests/
node --test netlify/functions/tests/fpl.test.mjs
npm test                          # everything, from the repo root
npm run test:fpl-planner:e2e      # the browser suites in e2e/
```

`e2e/` drives a real headless browser through the interactive scenario workflow
and through the gameweek boundaries (pre-season, the deadline crossing, a
gameweek in play, a transfer made between gameweeks) by intercepting the proxy
and shifting the page clock. It exists because the states that matter most are
not reachable from `?demo=1`, and because the interactive squad editor shipped
with green unit tests while being unusable in a browser.

Engine tests never touch the network. They run against committed fixtures in `tests/fixtures/`, documented in `tests/fixtures/README.md`, which deliberately include an injured player, a doubtful player, promoted-club players with no Premier League minutes, real price movement, a blank gameweek and a double gameweek.

`tests/fixtures/gw1-2026/` is different: it is the real 2026/27 opening gameweek,
captured off the live proxy on 2026-08-21 and trimmed to a base plus one delta
per lifecycle state (pre-season, the totals cleared at the rollover, a match in
play, full time with bonus outstanding), plus a squad and its live scores. It is
sanitized of any real entry identity and regenerated by
`scripts/derive-gw1-fixtures.mjs`. `tests/season-lifecycle.test.mjs` pins the
live incident to it.

### The health probe

```sh
node apps/fpl-planner/scripts/evidence-probe.mjs             # live proxy
node apps/fpl-planner/scripts/evidence-probe.mjs --bootstrap FILE --fixtures FILE
node apps/fpl-planner/scripts/evidence-probe.mjs --record    # save this reading
node apps/fpl-planner/scripts/evidence-probe.mjs --json
```

It reports the lifecycle phase, the evidence classification, the baseline
assessment and the readiness level, then judges a set of NAMED INVARIANTS and
exits non-zero if any fails. It used to end in a bare "is the projected total
between 30 and 100", which passed a broken pipeline at 31.5 the same day it
failed the same pipeline at 14.5. Absolute thresholds cannot separate healthy
from wrong-by-a-factor, so the invariants include change detection: `--record`
stores a reading, and a later run fails if the best eleven has moved more than
25% without the classification changing.

The historical replay is NOT covered by that: it runs on a gitignored archive
that only exists on a machine that has downloaded it. `tests/backtest.test.mjs`
and `tests/replay-evidence.test.mjs` generate synthetic seasons in the archive's
own CSV shape and drive the identical code path, so the suite stays hermetic
while still walking the replay end to end. The few tests that DO want the real
archive (`tests/player-identity.test.mjs`, `tests/train-dedupe.test.mjs`) skip
without it, and each of those files carries a guard test asserting the exact
skip set for the machine's archive state, so a silently changed skip count
fails instead of vanishing.

Performance budgets are asserted in CPU time (`process.cpuUsage()`), never
wall time, because `npm test` runs suites in parallel and wall time then
measures the machine rather than the planner. The full-plan ceiling has one
owner, `tests/perf-live-size.test.mjs`, mirrored by `tests/invariants.test.mjs`;
`tests/perf-budget.test.mjs` keeps the fast fixture-sized measurement without a
ceiling of its own, because a ceiling on the smaller pool is strictly dominated
by the same number on the live-sized one.
