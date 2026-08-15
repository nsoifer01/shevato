# Football H2H

**A head-to-head football match tracker built for exactly two named humans: log scores (and penalty shootouts), then watch your running record, streaks, and per-player stats update.**

## How it works

Football H2H tracks repeated matches between two players (Player 1 vs Player 2). There is no per-footballer roster; each record is a single game with the two players' goal totals, an optional penalty-shootout winner (for drawn regulation scores), an optional team per player, and a timestamp. Adding a game from the sidebar form appends it to the games list; everything else (records, streaks, the comparison table, the matchup lookup) is derived from that list on the fly.

All state lives in the browser's `localStorage`, and there is no backend or account required. The keys are `footballH2HGames` (the match list), `footballH2HPlayers` (the two player names), and `footballH2HPlayerIcons` (each player's chosen emoji). A silent auto-backup snapshot is also written to `footballH2HAutoBackup` every 10 minutes as a safety net (no restore UI, recover via devtools if ever needed). The page also wires into the shared Shevato sync system, which mirrors the `footballH2H*` keys to Firebase storage when signed in.

## Features

| Feature | What it does |
| ------- | ------------ |
| Add a game | Sidebar form captures each player's goals, an optional team per player, and an optional note; the game is stamped with the sidebar's current game date and saved to the match list. |
| Penalty shootouts | When regulation goals are equal, a penalty-result field appears; the winner (Player 1, Player 2, or a true draw) is stored and counts the drawn match as a win for that player. |
| Game notes | Each game can carry one short free-text note (80 characters max), entered with the game and changeable later; it renders under the date in the history table and on that game's line in the session summary. |
| Default game date | The sidebar's "Game Date" section is a standing setting for the date stamped on newly added games, with a "Set to Today" shortcut; it stays put across adds and defaults to today on load, so it is not a per-add date field. |
| Player names & icons | Rename either player and pick an emoji icon (Sports / Animals / General categories); names and icons flow through every stat label, table header, and dropdown. |
| Teams per match | Each player's team is recorded from per-league dropdowns (e.g. National Teams) or a custom "Other" name, defaulting to "Ultimate Team". |
| H2H Stats tab | Total wins per player plus draws, a current-streak badge, and separate 90-minute-win and penalty-win tallies. |
| General Stats tab | Total games, goals per game, total penalty shootouts, and a team-matchup lookup. |
| Team matchup lookup | Pick a team for either side ("Any" allowed) to see the win/draw/win record across only the games with that team pairing. |
| Player Stats tab | A side-by-side comparison table of per-player derived stats with the better value tinted toward its player. |
| Stats-tab deep links | The active stats tab is mirrored into the URL hash (`#h2h`, `#general`, `#player`) and restored on load, so reloads and shared links reopen the same tab. |
| Comparison-table stats | Total goals, goals/game, highest score (with the match detail), median score, scoring rate, multi-goal-game %, current winning/losing/scoring/scoreless streaks plus longest winning/scoring/scoreless streaks (penalty-aware, with date spans), last-3 and last-5 averages, and a consistency (std-dev) row. |
| Streak badge | Surfaces the live rivalry streak (e.g. "Alex – 3 match winning streak", or "Alex – 2 match losing streak" when nobody is on a winning run) using penalty-aware match results, or "No current streak". |
| Recent form strip | A W/L/D dot strip of each player's last 5 match results. |
| Session summary | Generates a copyable text recap of the (filtered) games: per-player win record, total goals, the session winner, and a line per match. |
| Game history table | Sortable by game #, date, or either player's goals; each row has a delete button and an edit button that opens an Edit Game modal. |
| Edit a game | The edit modal reopens every field of a saved game, including its date and time, so a mistimed or mistyped entry can be corrected. |
| History pagination | The history table pages at 10, 25, or 50 rows; the chosen page size is remembered in `localStorage` under `gameHistoryPageSize`. |
| Date filtering | Filter the history and stats to All Time, Today, Last 7 Days, Last 30 Days, or a custom from/to range. |
| Undo / redo | Add, edit, and delete actions push to a history stack so the last action can be undone and redone. |
| Export / import | Export all games and player names to a JSON file; import validates the payload shape before loading it back. |
| Clear all data | The trash button in the sidebar header wipes every saved game after a confirmation prompt; unlike a single delete, this is not undoable. |
| Cloud sync | Opt-in Firebase sync mirrors the local data across devices; an offline banner shows when sync is unavailable. |

## Viewing locally

The app is fully static and persists to `localStorage`, so any static file server works:

```sh
cd apps/football-h2h
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly over `file://` works for the core tracker, but the shared header/footer includes and the Firebase sync layer expect to be served over HTTP.

## Running tests

```sh
npm run test:football          # or: node --test apps/football-h2h/tests/
```

No browser and no server: everything runs under `node --test`.

### What is covered

| File | Covers |
| ---- | ------ |
| `matchLogic.test.js` | The pure helpers in `js/match-logic.js`: table sorting (including zero and negative goal counts), sequential ID assignment, import-payload (envelope) validation. |
| `playerStats.test.js` | `js/playerStats.js`: per-player stats, penalty-aware match results, streak and run detection, comparison-table formatters. |
| `sidebarAddGame.test.js` | `submitSidebarGame()`: goal validation (0 is a real score), the draw-requires-a-penalty-result rule, blank custom-team rejection, and the exact record written (id, gameNumber, date stamp, note, undo entry). |
| `statsAggregates.test.js` | `updateStatisticsWithData()`: wins, 90-minute wins, penalty wins, draws, shootout count, goals per game. Ends with a drift guard asserting these counters agree with `playerStats.matchResult` over the same fixtures, because the same win/draw rule is implemented twice. |
| `undoRedo.test.js` | `addToHistory` / `undoLastAction` / `redoLastAction`: add, edit and delete round trips, persistence, the 50-action cap, and redo truncation after a new action. |
| `dateFilters.test.js` | `setDateFilter` / `applyCustomDateFilter` / `getFilteredGames` for all / today / week / month / custom, with the clock pinned inside the sandbox. |
| `importMigration.test.js` | `migrateGameDates()`, `loadGames()` and the import apply-step after the user confirms (replace-not-merge, player names, migration of undated rows, cancel and error paths). |

### How the classic scripts are loaded

`js/match-logic.js` and `js/playerStats.js` are UMD, so tests `require()` them directly. `js/sidebar.js` and `js/football-h2h.js` are plain `<script>` files with no exports, so they are loaded into a `node:vm` sandbox with a stub `document` / `localStorage` by the shared helper `tests/vm-harness.js` (same approach as `apps/mario-kart/tests/`). In that sandbox `window` is aliased to `globalThis` as in a browser; top-level `let` bindings (`games`, `currentDateFilter`, `actionHistory`) are invisible as context properties and are reached with `runIn()`, and values built inside the sandbox go through `toHost()` before `assert.deepEqual`.

Two things the suite pins on purpose rather than asserting the intuitive reading: "Last 7 Days" / "Last 30 Days" are rolling windows measured as `now - 7*24h` / `now - 30*24h`, not calendar days; and `migrateGameDates` stamps undated games by array position, so it can interleave with games that already have a date. Tests for confirmed defects assert the CORRECT behaviour and carry `{ todo: 'KNOWN DEFECT: ...' }`, so the run stays green while the bug stays documented.
