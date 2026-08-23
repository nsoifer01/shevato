# Football H2H

**A head-to-head football match tracker built for exactly two named humans: log scores (and penalty shootouts), then watch your running record, streaks, and per-player stats update.**

## How it works

Football H2H tracks repeated matches between two players (Player 1 vs Player 2). There is no per-footballer roster; each record is a single game with the two players' goal totals, an optional penalty-shootout winner (for drawn regulation scores), an optional team per player, and a timestamp. Adding a game from the sidebar form appends it to the games list; everything else (records, streaks, the comparison table, the matchup lookup) is derived from that list on the fly.

All state lives in the browser's `localStorage`, and there is no backend or account required. The keys are `footballH2HGames` (the match list), `footballH2HPlayers` (the two player names), and `footballH2HPlayerIcons` (each player's chosen emoji). A silent auto-backup snapshot is also written to `footballH2HAutoBackup` every 10 minutes as a safety net (no restore UI, recover via devtools if ever needed). The page also wires into the shared Shevato sync system, which mirrors the `footballH2H*` keys to Firebase storage when signed in.

## Features

| Feature | What it does |
| ------- | ------------ |
| Add a game | Sidebar form captures each player's goals, an optional team per player, and an optional note; the game is stamped with the sidebar's current game date and saved to the match list. Goal counts are validated in JS as plain digits from 0 to 99 (the inputs' `min`/`max` are only browser hints; `1e2` and `2.0` are rejected), the form opens with focus on the first goals field and Enter saves; the game number is issued as max(existing game numbers) + 1, floored by the list length, so deleting a game below the current maximum never frees its number (deleting the highest-numbered game does free that one number for the next add). |
| Penalty shootouts | When regulation goals are equal (compared numerically, so `02` and `2` match), a penalty-result field appears; the winner (Player 1, Player 2, or a true draw) is stored and counts the drawn match as a win for that player. |
| Game notes | Each game can carry one short free-text note (trimmed, 80 characters max), entered with the game and changeable later; quotes and HTML are stored and shown verbatim; it renders under the date in the history table and on that game's line in the session summary. |
| Default game date | The sidebar's "Game Date" section is a standing setting for the date stamped on newly added games, with a "Set to Today" shortcut; it stays put across adds and defaults to today on load, so it is not a per-add date field. |
| Player names & icons | Rename either player (trimmed, 30 characters max, blank falls back to "Player 1/2") and pick an emoji icon (Sports / Animals / General categories); names and icons flow through every stat label, table header, and dropdown. |
| Teams per match | Each player's team is recorded from per-league dropdowns (e.g. National Teams) or a custom "Other" name (trimmed, 40 characters max), defaulting to "Ultimate Team". |
| H2H Stats tab | Total wins per player plus draws, a current-streak badge, and separate 90-minute-win and penalty-win tallies. |
| General Stats tab | Total games, goals per game, total penalty shootouts, and a team-matchup lookup. |
| Team matchup lookup | Pick a team for either side ("Any" allowed) to see the win/draw/win record across only the games with that team pairing; all time, it ignores the date filter (the heading says so). |
| Player Stats tab | A side-by-side comparison table of per-player derived stats with the better value tinted toward its player. |
| Stats-tab deep links | The active stats tab is mirrored into the URL hash (`#h2h`, `#general`, `#player`) and restored on load, so reloads and shared links reopen the same tab. |
| Comparison-table stats | Total goals, goals/game, highest score (with the match detail), median score, scoring rate, multi-goal-game %, current winning/losing/scoring/scoreless streaks plus longest winning/scoring/scoreless streaks (penalty-aware, with date spans), last-3 and last-5 averages, and a consistency (std-dev) row. |
| Streak badge | Surfaces the live rivalry streak (e.g. "Alex – 3 match winning streak", or "Alex – 2 match losing streak" when nobody is on a winning run) using penalty-aware match results, or "No current streak". |
| Recent form strip | A W/L/D dot strip of each player's last 5 match results. |
| Session summary | Generates a copyable text recap of the (filtered) games: per-player win record, total goals, the session winner, and a line per match in date order. |
| Game history table | Sortable by game #, date, or either player's goals (headers are keyboard-operable with `aria-sort`); each row has a delete button and an edit button that opens an Edit Game modal. On phones (480px and below) the game-number column is hidden and the date wraps so both scores and the actions fit without sideways scrolling. A filter that hides every game says "No games match the current date filter (0 of N games)". |
| Edit a game | The edit modal reopens every field of a saved game, including its date and time, so a mistimed or mistyped entry can be corrected. |
| History pagination | The history table pages at 10, 25, or 50 rows; the chosen page size is remembered in `localStorage` under `gameHistoryPageSize`, and the current page clamps to the last valid page when a filter or delete shrinks the list. |
| Date filtering | Filter the history and stats to All Time, Today, Last 7 Days, Last 30 Days, or a custom from/to range. |
| Undo / redo | Add, edit, and delete actions push to a history stack so the last action can be undone and redone; Clear All Data, an import, and a change made in another tab empty the stack. |
| Export / import | Export all games and player names to a JSON file; import validates the payload shape AND each game row (both scores must be whole numbers 0..99), normalizes each row's penalty winner, assigns a stable id and game number to rows without one, rejects rows that repeat an id, drops unreadable dates (the row is dated by position), trims names / teams / notes, and discloses every skip and repair in the confirmation dialog. A file with no usable games is refused. |
| Clear all data | The trash button in the sidebar header wipes every saved game after a confirmation prompt; unlike a single delete, this is not undoable (the undo stack is emptied). It is also the way out when the stored games cannot be read: the app then shows a notice in the history area and refuses to save until the data is cleared. |
| Cloud sync | Opt-in Firebase sync mirrors the local data across devices; an offline banner shows when sync is unavailable. |
| Multiple tabs | A change saved in one tab (signed in or not) is picked up by every other open tab of the app through `sync-system/tab-sync.js`; the other tabs re-read storage and re-render instead of overwriting it on their next save. |

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

`e2e/audit-2026-08.mjs` is the app's browser regression module (raw CDP, run by `tests/browser/run.mjs` alongside the other apps' e2e files): modal escaping in Chromium, the formerly id-less delete, two tabs on one origin, the numeric draw check, page clamping, undo after a clear, corrupted storage, keyboard reach of the closed sidebar and the sortable headers, axe scans of the General and Player tabs, the open sidebar and the edit modal, the icon picker and history table at 360 / 390, the toast position on phones, and no-overflow checks up to 1280.

### What is covered

| File | Covers |
| ---- | ------ |
| `matchLogic.test.js` | The pure helpers in `js/match-logic.js`: table sorting (Game # by the displayed number, zero and negative goal counts), sequential ID and game-number assignment (`nextGameId` / `nextGameNumber` / `assignIds`), `parseGoals` / `isDraw`, the text limits, penalty-winner normalization, and import-payload validation (envelope AND per-game rows: score checks, coercion, id assignment, duplicate ids, unreadable dates, rejected-row counting). |
| `modalRenderer.test.js` | The modal renderer (`renderFormFieldsHtml` in `js/modalUtils.js`) with the real `escapeHtml`: hostile and quoted values create no element and round-trip through the value attribute; the edit save path keeps a quoted note / team across two edits; the delete confirm escapes player names. |
| `pagination.test.js` | `assets/js/pagination.js` (shared with mario-kart): the current page clamps when the item count shrinks. |
| `textAndSummary.test.js` | `updatePlayerName` trimming / capping / blank fallback, and the session summary's chronological ordering. |
| `playerStats.test.js` | `js/playerStats.js`: per-player stats, penalty-aware match results (including tolerance for legacy string penalty winners), streak and run detection, comparison-table formatters. |
| `sidebarAddGame.test.js` | `submitSidebarGame()`: goal validation (0 is a real score; negative, non-integer, scientific-notation and over-99 values are rejected), the draw-requires-a-penalty-result rule (and that `02` vs `2` shows the field), blank custom-team rejection and trimming, gameNumber uniqueness after a delete, and the exact record written (id, gameNumber, date stamp, note, undo entry). |
| `editGame.test.js` | The Edit Game modal's `onSave` in `editGame()`: the same non-negative-integer goal rule as the add path, numeric penalty-winner storage, and that a rejected edit leaves the stored game untouched. |
| `statsAggregates.test.js` | `updateStatisticsWithData()`: wins, 90-minute wins, penalty wins, draws, shootout count, goals per game, and that rows with missing scores are skipped rather than NaN-poisoning the counters. Ends with a drift guard asserting these counters agree with `playerStats.matchResult` over the same fixtures (including legacy string penalty winners and missing-score rows), because the same win/draw rule is implemented twice. |
| `undoRedo.test.js` | `addToHistory` / `undoLastAction` / `redoLastAction`: add, edit and delete round trips, persistence, the 50-action cap, redo truncation after a new action, and that Clear All Data and import empty the stack. |
| `dateFilters.test.js` | `setDateFilter` / `applyCustomDateFilter` / `getFilteredGames` for all / today / week / month / custom, with the clock pinned inside the sandbox. |
| `importMigration.test.js` | `migrateGameDates()`, `migratePenaltyWinners()`, `loadGames()` (legacy heal, corrupted JSON / wrong shape leave the blob untouched and block saves) and the import apply-step after the user confirms (replace-not-merge, player names, migration of undated rows, an older-shape export fixture, invalid-row / repair disclosure, the empty-file refusal, delete targeting exactly one formerly id-less row, cancel and error paths). |

### How the classic scripts are loaded

`js/match-logic.js` and `js/playerStats.js` are UMD, so tests `require()` them directly. `js/sidebar.js`, `js/modalUtils.js` and `js/football-h2h.js` are plain `<script>` files with no exports, so they are loaded into a `node:vm` sandbox with a stub `document` / `localStorage` by the shared helper `tests/vm-harness.js` (same approach as `apps/mario-kart/tests/`). The sandbox runs the real `assets/js/escape-html.js`, never a stub. In that sandbox `window` is aliased to `globalThis` as in a browser; top-level `let` bindings (`games`, `currentDateFilter`, `actionHistory`) are invisible as context properties and are reached with `runIn()`, and values built inside the sandbox go through `toHost()` before `assert.deepEqual`.

Two things the suite pins on purpose rather than asserting the intuitive reading: "Last 7 Days" / "Last 30 Days" are rolling windows measured as `now - 7*24h` / `now - 30*24h`, not calendar days; and `migrateGameDates` stamps undated games by array position, so it can interleave with games that already have a date. The four `{ todo: 'KNOWN DEFECT: ...' }` quarantines from the 2026-08 testing audit (negative goals, gameNumber collision, NaN goals/game, penalty-winner drift) were all fixed on 2026-08-15 and their tests now assert the corrected behaviour as plain regressions.
