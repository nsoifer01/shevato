# MapTap Rivals

**A daily MapTap.gg score tracker that pits you against named friends — log each day's scores and watch the win/loss records, streaks, averages, and per-rival head-to-head dashboards build over time.**

## How it works

MapTap.gg has no built-in social layer, so this app *is* the rivalry layer. The data model is two flat lists plus your identity, all kept in `localStorage` (and mirrored to Firestore by the shared sync system the other apps use):

- **Rivals** (`maptapRivalsRivals`) — each named friend you track: `{ id, name, color, icon, createdAt }`, plus an optional MapTap username for auto-sync.
- **Games** (`maptapRivalsGames`) — one record per day you played a given rival: `{ id, rivalId, date, note, myScores[5], theirScores[5], myScore, theirScore }`. Each of MapTap's 5 rounds is a raw 0–100 score; round weights `[1, 1, 2, 3, 3]` roll up to a 0–1000 daily total. Older games stored as totals only (no per-round array) still count toward records and streaks but are skipped from per-round breakdowns.
- **You** — your display name (`maptapRivalsMe`), icon (`maptapRivalsMyIcon`), and optional MapTap profile (`maptapRivalsMyProfile`).

Seasons, the matrix selection, and the currently focused rival are persisted under their own keys. Everything is computed on demand from the games list — there are no precomputed stats in storage.

## Features

| Feature | What it does |
| ------- | ------------ |
| Add/edit rivals | Create a named rival with an accent color and icon (and an optional MapTap username); edit or delete from a modal. |
| Paste daily scores | A collapsible entry panel: paste your MapTap result, and a row per rival shows a live win/loss/tie preview against your score before you save the day's games. |
| MapTap profile auto-sync | Link your MapTap profile (and a rival's username) to pull game history automatically from the public MapTap profile endpoint instead of pasting. |
| Dashboard | A rival grid of summary cards (record, streak, averages) with an at-a-glance summary strip and a "today's predictions" card when the day's puzzle data is available. |
| Per-rival dashboard | A focused head-to-head view: stat cards, score-over-time and win-distribution and score-differential charts (Chart.js), recent-games table with pagination, and narrative callouts. |
| Outbound maptap.gg links | In the history and recent-games tables, dates link to that day's puzzle page (`maptap.gg/history/...`) and score numbers link to the player's profile (`maptap.gg/u/...`) when that player has a linked username. |
| Round-by-round breakdown | Per-round (location) stats, win-rate-per-round chart, a last-10-games round heatmap, carry/choke insights, and a calendar heatmap of game history. |
| Continent breakdown | Per-continent stats for games that carry synced geo data. |
| Win/loss/tie + streaks | Computes wins, losses, ties, win %, current and longest streaks, biggest win/loss margins, and best/worst scores per rival. |
| Leaderboard | A sortable table ranking every rival by win %, games, W/L/T, a blended rivalry score, average margin, current streak, and recent form. |
| Confusion matrix | A cross-participant grid comparing you against each selected rival, and rival-vs-rival on days you played both, with selectable metrics. |
| Rivalry seasons | Time-boxed challenges with a goal (win %, total wins, or minimum games) scoped to all rivals or one, tracked against progress. |
| Full game history | Every game across all rivals in one table, filterable by rival and result (win/loss/tie), with pagination. |
| WhatsApp import | Import paired games from a WhatsApp chat `.txt` export by mapping chat senders to rivals, with a preview before committing. |
| Export / import / clear | Download a JSON backup, import one, or clear all logged games (rivals and settings are kept). |

## Viewing locally

It's a static app — no build step. The app reads and writes `localStorage` and uses `fetch` for profile/puzzle sync, so serve the directory rather than opening `file://`:

```sh
cd apps/maptap-rivals
python3 -m http.server 8000
# open http://localhost:8000
```

## Running tests

The scoring and stats core (weighted daily totals, the predicted-total reconciliation that keeps the predictions card's total equal to the sum of its per-round chips, side-presence, the MapTap paste parser, results, streaks, averages, trend/projection, and the composite rivalry score) lives in `js/stats.js` as a pure module so it can be unit-tested without a DOM or Firebase. `app.js` loads that module and binds its functions, so the tests exercise the same code the app runs.

```sh
npm run test:maptap
```

The suite (`tests/stats.test.js`) is also part of the repo-wide `npm test` target.
