# MapTap Rivals

**A daily MapTap.gg score tracker that pits you against named friends - log each day's scores and watch the win/loss records, streaks, averages, and per-rival head-to-head dashboards build over time.**

## How it works

MapTap.gg has no built-in social layer, so this app *is* the rivalry layer. The data model is two flat lists plus your identity, all kept in `localStorage` (and mirrored to Firestore by the shared sync system the other apps use):

- **Rivals** (`maptapRivalsRivals`) - each named friend you track: `{ id, name, color, icon, createdAt }`, plus an optional MapTap username for auto-sync.
- **Games** (`maptapRivalsGames`) - one record per day you played a given rival: `{ id, rivalId, date, note, myScores[5], theirScores[5], myScore, theirScore }`. Each of MapTap's 5 rounds is a raw 0–100 score; round weights `[1, 1, 2, 3, 3]` roll up to a 0–1000 daily total. Older games stored as totals only (no per-round array) still count toward records and streaks but are skipped from per-round breakdowns.
- **You** - your display name (`maptapRivalsMe`), icon (`maptapRivalsMyIcon`), and optional MapTap profile (`maptapRivalsMyProfile`).
- **Rival network** (`maptapRivalsNetwork`) - the local cache for the opt-in account-backed network: `{ joined, uid, handle, links[], directory{}, materialized[], notices[], updatedAt }`. Every network screen renders from this cache rather than from a live query, so the app looks the same offline. It is deliberately excluded from the cross-device sync key list, since it mirrors Firestore documents that are already per-account.

The matrix selection, its row-sort choice (`maptapRivalsMatrixSort`), and the currently focused rival are persisted under their own keys. Everything else, weekly and monthly records included, is computed on demand from the games list; there are no precomputed stats in storage.

A game belongs to a rival, so every view reads the game log through the rival list and a game whose `rivalId` is no longer there counts nowhere. That state is reachable because cross-device sync carries the rival list and the game log as two independent keys: deleting a rival on one device removes both locally, but another device can still push its own copy of the game log afterwards and win the last-write, leaving games behind an id nobody owns.

## Features

| Feature | What it does |
| ------- | ------------ |
| Add/edit rivals | Create a named rival with an accent color and icon (and an optional MapTap username); edit or delete from a modal. |
| Paste daily scores | A collapsible entry panel: paste your MapTap result, and a row per rival shows a live win/loss/tie preview against your score before you save the day's games. One record per rival per date: saving a day that already has a record for that rival updates it in place (the save bar reads "Updated" instead of "Saved"), so re-pasting corrects a day rather than double-counting it. |
| MapTap profile auto-sync | Link your MapTap profile (and a rival's username) to pull game history automatically from the public MapTap profile endpoint instead of pasting. |
| Rival network (opt-in) | Sign in, verify your MapTap profile, and publish a handle claim so other members can find you. Joining publishes only your handle, display name, icon, and the handles of the rivals you track, readable only by rivals you are connected to; scores, games and notes are never published, and leaving deletes all of it. Requires a registered (non-anonymous) account. |
| Mutual rival connections | Adding a rival whose MapTap handle belongs to another member connects you both at once: a single pair document is created, your card shows a "Connected" chip, and the other person gets the rival added to their own list with a dismissible "added you as a rival" notice. No second person has to search for anyone. Deleting a connected rival tears the pair down. |
| Rival discovery ("Their rivals") | A connected rival's dashboard lists the people they track, minus you and minus anyone you already have, each one tap from becoming your own rival. Discovering someone who is also a member connects you to them immediately. |
| Dashboard | A rival grid of summary cards (record, streak, averages) in alphabetical order, with an at-a-glance summary strip, a current-form banner, and a "today's predictions" card when the day's puzzle data is available. Under the summary strip sits a "My average by continent" band: one chip per continent with my own raw 0-100 round average and the round count, across every rival at once, ordered by rounds descending then name A-Z. It counts each day once however many rivals it was logged against, ignores rounds with no usable coordinates, and stays hidden entirely until at least one synced game carries geo data. The paste panel sits between the predictions card and the rivalry grid, so the auto-sync profile card at the top stays the recommended entry path. |
| Predictions accuracy | Each row of the predictions card carries the share of the field the player beats on an average day ("avg 78%", the mean of `(N - rank) / (N - 1)` over every past day at least two tracked players logged a score, so first is always 100% and last always 0% whatever the field size, ties sharing fractional rank credit and solo days excluded, with the raw average finish and day count in the tooltip) plus a "Spot-on" badge giving the share of days they finished exactly where the predictor put them ("Spot-on 83%", with the raw "5 of 6 past days" count in the tooltip). Clicking a player's name expands a "Daily finishes" distribution: one bar per finishing position (1st, 2nd, ... up to the biggest field they competed in, zero-count rows included) with the percent of days and the raw count, ties bucketed at the top of the span they tie across (competition ranking, so two players tied for the best total both finished 1st); a position held on fewer than 5 days names those exact dates in its row tooltip. Rows are tinted by position quality on the shared green-to-red ramp (1st green, last red), and clicking a row with at least one day opens the History tab filtered to exactly those days, marked by a dismissible chip ("Alice · 2nd · 2 days"). |
| Per-rival dashboard | A focused head-to-head view: stat cards, score-over-time and win-distribution and score-differential charts (Chart.js), recent-games table with pagination, and narrative callouts. |
| Outbound maptap.gg links | In the history and recent-games tables, dates link to that day's puzzle page (`maptap.gg/history/...`) and score numbers link to the player's profile (`maptap.gg/u/...`) when that player has a linked username. |
| Round-by-round breakdown | Per-round (location) stats, win-rate-per-round chart, a last-10-games round heatmap, carry/choke insights, and a calendar heatmap of game history. |
| Continent breakdown | Per-continent stats for games that carry synced geo data. Rounds without usable coordinates are excluded, never bucketed. There is no Antarctica bucket: rounds below 60°S count as "Other". |
| Win/loss/tie + streaks | Computes wins, losses, ties, win %, current and longest streaks, biggest win/loss margins, and best/worst scores per rival. |
| Leaderboard | A sortable table listing every rival alphabetically by default, re-rankable by win %, games, W/L/T, a blended rivalry score, average margin, current streak, and recent form. |
| Confusion matrix | A cross-participant grid comparing you against each selected rival, and rival-vs-rival on days you played both, with selectable metrics. A "Sort rows" select orders the grid by name (A-Z), win rate, or average score, and the choice is remembered between visits. |
| Weekly / monthly records | The game log bucketed automatically into ISO calendar weeks (Monday to Sunday) and calendar months: overall W-L-T, win %, games played, and a per-rival split for each period, newest first, with the current period marked. Weekly cards carry their ISO week number next to the date range ("#32"). Each rival row also carries the running count of periods won-lost(-tied) against them up to that period, e.g. "Gal (3-5-1)". Win percentages read green above 50, red below, neutral at exactly 50. The split sorts by win % (best first) or by name, and the period cards paginate 6 to a page. A dashboard banner shows this week's and this month's record. Only rivals still on your list are counted, so a game left behind by a deleted rival never shows up as a phantom row or inflates a period's total. No setup, nothing to maintain. |
| Full game history | Every game across all rivals in one table, filterable by rival and result (win/loss/tie), with pagination. |
| Share a result card | Every head-to-head row in the recent-games and full-history tables has a share button that copies an emoji result card to the clipboard: the score line with the margin, a row of per-round win/loss/tie squares per player (when the game carries per-round scores), a streak line if that result sat on a run of 2 or more, and the app link. A floating toast confirms the copy. |
| Delete a single game | Each row in those tables also carries a delete button, with a "Delete game?" confirmation naming the date, rival, and both scores before it commits. |
| Linkable views | Every view lives at its own URL hash (`#dashboard`, `#leaderboard`, `#rival/<id>`, `#matrix/<subtab>`, `#records`, `#history`), updated silently as you navigate and honored on load and on back/forward, so a view or a rival's dashboard can be bookmarked or sent to someone. A link to a rival you don't have falls back to the dashboard. |
| WhatsApp import | Import paired games from a WhatsApp chat `.txt` export by mapping chat senders to rivals, with a preview before committing. |
| Export / import / clear | Download a JSON backup, import one, or clear all logged games (rivals and settings are kept). |

## Viewing locally

It's a static app - no build step. The app reads and writes `localStorage` and uses `fetch` for profile/puzzle sync, so serve the directory rather than opening `file://`:

```sh
cd apps/maptap-rivals
python3 -m http.server 8000
# open http://localhost:8000
```

## Running tests

The scoring and stats core (weighted daily totals, the predicted-total reconciliation that keeps the predictions card's total equal to the sum of its per-round chips, side-presence, the MapTap paste parser, results, streaks, averages, trend/projection, the composite rivalry score, ISO week / calendar month bucketing for the Records view, the running per-rival period tally behind each rival row's "(won-lost-tied)" figure, the predicted-position accuracy ranking behind the predictions card's "Spot-on" badge, the fractional daily finishing positions and the field-share percentages behind its "avg" figure, the integer competition ranks and per-position day counts and dates behind its expandable "Daily finishes" distribution, my own per-continent round averages behind the dashboard's "My average by continent" band (deduped by date so a day logged against several rivals contributes its 5 rounds once, with the continent classifier injected by the caller), and the name / win-% comparators the rival lists sort with) lives in `js/stats.js` as a pure module so it can be unit-tested without a DOM or Firebase. `app.js` loads that module and binds its functions, so the tests exercise the same code the app runs.

```sh
npm run test:maptap
```

The rival network's decidable core (pair-document ids, handle canonicalization, the published payload, the reconcile that decides which connections still need a local rival, and the discovery filtering) lives in `js/network.js` on the same terms: a pure dual-export module with no Firebase imports, unit-tested in `tests/network.test.js`.

A third suite, `tests/app-helpers.test.js`, reaches inside `js/app.js` itself: the IIFE ends with a `window._testExports` block exposing its pure helpers (`classifyContinent` and its bounding boxes, the per-rival `continentBreakdown`, the matrix cell builders, `rivalSummary`, and `upsertPastedGame`, the per-rival/per-date save guard), and the suite loads the file with `node:vm` into a stubbed-browser sandbox (never-settling `fetch`, Map-backed `localStorage` seeded per test, `init()` never runs). The rest of app.js (the paste panel DOM flow, the WhatsApp importer, import/export, sync, rendering) remains out of unit-test reach and is covered by browser probes and the `.features/` plans.

All three suites are also part of the repo-wide `npm test` target.

Tests marked `{ todo: 'KNOWN DEFECT: ...' }` assert the behavior the app *should* have while a defect is still shipped; `node --test` reports them as expected failures (the run still exits 0), and each flips to a plain passing test when fixed. As of 2026-08-15 this app's suites carry no todos. `FINDINGS.md` lists what stays uncovered and the history of fixed defects.

## Deploying the network rules

The rival network needs three Firestore collections (`maptapRivalsHandles`, `maptapRivalsNetwork`, `maptapRivalsLinks`) whose security rules live in the repo-root `firestore.rules`. They are not deployed automatically. Until someone runs:

```sh
firebase deploy --only firestore:rules
```

every join and connection attempt fails with a permission error. That is handled gracefully (a status line at most, local rivals and games untouched, nothing crashes), but the feature does not work for anyone until the rules are live.
