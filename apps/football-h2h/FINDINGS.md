# Football H2H - Engineering findings

Living document: rewrite sections as understanding improves. Started
2026-08-15 during the data-integrity round that fixed audit defects 4-7.

## penaltyWinner has exactly one canonical representation

The stored value is the NUMBER `1`, the NUMBER `2`, the string `'draw'`, or
`null`. History: a long-dead add/edit modal (`saveGame()` and friends,
removed 2026-08-15; its markup had already been deleted from `index.html`)
stored the raw select string `'1'` / `'2'`, and the two stats readers then
disagreed about it: the H2H aggregate read `'1'` as a player-2 win while
`playerStats.matchResult` read it as a draw.

Defense in depth, all three layers tested:

- Write paths (`submitSidebarGame`, the edit modal's `onSave`, and the
  import row normalizer in `match-logic.js`) only ever store canonical
  values; `FootballMatchLogic.normalizePenaltyWinner` is the shared rule.
- `migratePenaltyWinners()` rewrites legacy `'1'` / `'2'` once at load
  (same pattern as `migrateGameDates`).
- Both counters still coerce with `Number()` when comparing, so an
  un-migrated row (e.g. arriving via sync from a device running old code)
  reads identically on every tab.

Known remainder: the legacy table renderer `renderGamesTable()` checks
`game.penaltyWinner === 'player1' / 'player2'`, values NO writer has ever
stored, so drawn-then-decided games get draw styling there. It is a live
path (the sortable column headers call `sortGames()` which re-renders
through it, with different row markup than `renderGamesTableWithData`).
Cosmetic only, left unfixed in the 2026-08-15 round; the real fix is
probably collapsing the two renderers into one.

## Missing-score rows: one skip rule, shared by both counters

`playerStats.toScore` (null / undefined / '' / non-finite => missing) is
the single source of truth. `updateStatisticsWithData` calls it through
`window.FootballPlayerStats.toScore` so a malformed legacy row is skipped
by the aggregate exactly when `matchResult` returns null for it; goals/game
divides by the counted rows only (the NaN Goals/Game defect), while the
Total Games tile still shows every stored row, matching the history table.
The drift guard in `statsAggregates.test.js` enforces the agreement; any
new counter must use the same rule.

Consequence: `js/football-h2h.js` now requires `playerStats.js` to be
loaded first (index.html already did; the vm-harness test contexts must
mirror that order, and `sidebar.js` similarly needs `match-logic.js` for
`nextGameNumber`).

## gameNumber is max(existing) + 1, floored by games.length

`games.length + 1` re-issued numbers after a delete. But pure
max(gameNumber) + 1 is not enough either: rows WITHOUT a gameNumber (old
imports) render their 1-based position in the history table, so
`FootballMatchLogic.nextGameNumber` floors the max at `games.length` to
clear the positional range too. Game `id` (from `Date.now()` on the live
path) is unrelated to `gameNumber`; `nextGameId` exists for ids but has no
live caller since the dead modal path was removed.

## Import validates rows, not just the envelope

`parseImportPayload` drops rows whose scores are not non-negative integers
(numeric strings are coerced) and returns a `rejected` count that the
confirm dialog discloses before anything is applied. Rows are copied, never
mutated, so a cancelled import leaves the caller's parsed JSON intact.
