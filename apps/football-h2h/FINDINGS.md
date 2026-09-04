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

`renderGamesTableLegacy()` was dead code from the 2026-08-15 round until it
was deleted on 2026-08-23 (with it went the app's only Font Awesome usage;
the stylesheet link in `index.html` is still loaded and harmless).

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
max(gameNumber) + 1 is not enough either: rows WITHOUT a gameNumber used to
render their 1-based position in the history table, so
`FootballMatchLogic.nextGameNumber` floors the max at `games.length` to
clear the positional range too. The protection only covers numbers BELOW the
current max: deleting the highest-numbered game frees its number, and the
next add receives it again (verified 2026-08-22: delete #3 of 1..3, add, the
new game is #3). Since 2026-08-23 every row carries a gameNumber after load
(`assignIds`, below), so the positional fallback in the renderer is only a
belt-and-braces path. "Game #" sorts by `gameNumber` (id fallback) through
the one comparator in `match-logic.js`; the two inline sorters that sorted
by `id` were replaced by calls to `FootballMatchLogic.sortGames`.

## One rule per value, enforced in match-logic.js

Every write path (sidebar add, edit modal, import, load-time heal) goes
through the same helpers, so the browser attributes (`min`/`max`,
`maxlength`) are hints only:

- `parseGoals`: plain digits, 0..99. `1e2`, `2.0`, negatives and a 21-digit
  value are rejected (the last one used to render `1e+21`). `02` is 2.
- `isDraw(a, b)`: numeric comparison of the parsed values, used by BOTH the
  penalty-field visibility checks (sidebar, edit modal, and the fallback
  inside `createFormModal`) and the submit rules. The visibility checks
  used to compare raw strings, so `02` vs `2` demanded a shootout result in
  a hidden field. The sidebar check is bound to `input`, not `change`.
- `cleanPlayerName` (trim, 30 chars, default on blank), `cleanTeamName`
  (trim, 40), `cleanNote` (trim, 80, undefined on blank). Whitespace-only
  names used to be stored and blank every label; `  Spurs  ` and `Spurs`
  were two matchup teams; an unbroken 120-char name broke the icon grid.
- `assignIds(games)`: every row gets a finite numeric id (existing ids kept,
  repeated ids re-keyed) and a gameNumber. Runs in `loadGames` (written
  back once, like the date / penalty migrations) and at the end of
  `parseImportPayload`.

## Import validates rows, not just the envelope

`parseImportPayload` drops rows whose scores fail `parseGoals` and rows
whose id repeats an earlier row's, and returns `rejected` plus
`repairs: { dates, ids, duplicates }`. An unparseable `dateTime` is removed
so `migrateGameDates` stamps one, and the confirm dialog discloses the
count ("1 row has an unreadable date and will be dated by position"). A
file with zero usable games is refused outright ("Nothing to Import"): it
used to replace the whole list and reset both names behind a confirm that
merely said "0 games". Rows are copied, never mutated, so a cancelled import
leaves the caller's parsed JSON intact. `importMigration.test.js` carries a
real older-shape export (no players block, no ids, no gameNumbers, string
penalty winners, an undated row) and asserts it imports intact.

## The modal layer escapes in the renderer

`createFormModal` renders every field through `renderFormFieldsHtml`
(exposed on `window` for the node tests), and every value, label, option
text, placeholder and attribute goes through the shared `escapeHtml`
(`assets/js/escape-html.js`, which escapes `"` and `'` as well as `<>&`).
`createModal` escapes icon, title and button text; `showToast` sets the
message with `textContent`; the delete confirm escapes the player names in
its HTML `message`; the "Other" team input that replaces the select in the
edit modal is built with `createElement` and `.value`. History: until
2026-08-23 the modal layer interpolated stored strings raw, so a `"` in a
note or custom team truncated the field on every Edit and a no-op Save
stored the truncated value, and stored HTML in a note / team / player name
executed when the edit or delete modal opened. Import and cloud sync deliver
strings this page never typed, so the renderer is the only boundary that
holds. Regression: `modalRenderer.test.js` renders through the real
renderer with hostile and quoted strings (no element created, value attribute
round-trips, the edit save path keeps the text on a second edit) and
`e2e/audit-2026-08.mjs` repeats it in Chromium. The vm harness now loads the
REAL `escape-html.js`; the old pass-through stub is why no test could fail.

## Cross-tab refresh through sync-system/tab-sync.js

`index.html` loads `../../sync-system/tab-sync.js` before the app scripts
and `football-h2h.js` watches the three `footballH2H*` keys. A foreign
change discards the in-memory undo stack (it belongs to data this tab never
saw) and re-runs `initializeAppData` (re-read + re-render). The handler
never writes: `loadGames` skips its migration write-back while
`ShevatoTabSync.inHandler` is true. Before this, two tabs each held their
own array and `saveGames()` wrote the whole thing, so the later writer
dropped the other tab's additions. The `localStorageSync` listener for
`source: 'remote'` deliveries is unchanged; storage events also fire when
the sync layer writes a remote change in another tab, so that path now
refreshes every open tab. Pinned by the two-page check in
`e2e/audit-2026-08.mjs` (add in A, add in B, delete in B, write in A).

## Unreadable storage is reported, never overwritten

`loadGames` parses inside try/catch and requires an array. On failure it
sets `gamesLoadError`, renders a notice in the `#noGames` slot ("Your saved
games could not be read...") and `saveGames()` refuses to write (returns
false, shows an error toast) until Clear All Data, which passes
`force=true` because replacing the blob is exactly what the user confirmed.
`loadPlayers` / `loadPlayerIcons` fall back to defaults on bad JSON or the
wrong shape. Before this both init paths threw uncaught `SyntaxError`s and
the next Add replaced the unreadable blob with a one-game list.

## Undo stack resets on clear, import and cross-tab refresh

`resetActionHistory()` (sidebar.js) empties the stack and disables the
buttons. Clear All Data and the import apply step call it; so does the
tab-sync handler. The stack used to survive a clear, so "Undo: delete game"
pushed a deleted game into the emptied list.

## Pagination clamps the page

`assets/js/pagination.js` `getPaginatedItems` clamps `currentPage` to
`[1, max(1, totalPages)]` whenever the item count changes. Shared with
mario-kart; tested from `apps/football-h2h/tests/pagination.test.js` (the
file had no tests). Before: page 5 of 250, then a filter leaving 6 rows,
rendered zero rows under "Showing 201-6 of 6".

## Mobile, keyboard and a11y decisions (2026-08-23)

- Modals above the sidebar: `#iconSelectorModal` and `.modal-overlay` are
  z-index 1005 (sidebar 1001), scoped under `body.football-h2h-tracker` in
  `refresh.css`. The picker used to open three-quarters under the 280px
  sidebar on phones. The picker body scrolls; a hit-test must
  `scrollIntoView` each icon first.
- History table at <=480px: `min-width: 0`, fixed layout, game-number column
  hidden, date wraps, "(penalties)" is a `<small class="pen-label">` block
  under the score. Scores and actions fit 360 and 390 with no horizontal
  scrolling (asserted by geometry in the e2e).
- The closed sidebar carries `inert` (set in the markup and toggled by
  `openSidebar` / `closeSidebar`), so Tab from the toggle skips it.
  `closeSidebar` moves focus to the toggle BEFORE setting inert.
- Sortable headers: `data-sort`, `tabindex="0"`, `aria-sort` (maintained by
  `updateSortIndicators`), Enter / Space handled by a keydown listener
  installed on DOMContentLoaded. Matchup selects are named by `label for`.
- Contrast: `.sidebar-section-title` and the player-settings `h4` use
  `--fh-muted` (#a4adbd), not `--fh-muted-2` (#6f7785, 4.04:1 on the panel).
- Focus: opening Add Game focuses `#sidebar-player1-goals`; Enter in any
  field submits (keydown on `#sidebar-game-inputs`, selects excluded);
  after Save focus goes to `#sidebar-add-game-btn` (the form is torn down).
- Toasts on <=768px sit at the bottom of the viewport (they covered the app
  title and, with the sidebar open, its clear / close buttons).
- Empty states: unreadable storage, "No games match the current date filter
  (0 of N games)", and the first-run message are three different texts in
  the same `#noGames` slot. The Team Matchup heading says "(all time,
  ignores the date filter)" because the lookup reads `window.games`.
- Session Summary lists matches chronologically (`sortGames(..., 'date',
  'asc')`), matching the table and every stat.

## Probe-authoring note

`cdp.evaluate` wraps the expression in parentheses, so a multi-statement
string like `a(); b()` is a silent syntax error (an eval error object comes
back and the page does not change). Wrap in an IIFE. Three of the 2026-08-22
audit's first-pass mobile/keyboard probes were invalidated by this.

## Edit and delete must re-resolve the row, not trust the captured object

`games` is REPLACED wholesale whenever storage is re-read: a second tab
writing, a remote sync delivery, the 10-minute auto-backup, the 1 s
`syncSystemReady` refresh. Both dialogs captured the row OBJECT when they
opened and looked it up by identity at commit time.

- `editGame` did `games.indexOf(game)` and its `if (gameIndex !== -1)` had no
  else, so Save silently did nothing while the dialog closed as if it worked.
- `deleteGame` did `games.filter(m => m !== game)`, which removed nothing, yet
  still pushed an undo entry and still toasted "Game deleted". The row stayed
  on screen, and pressing Undo then ADDED it back, giving two rows with one id.

Both now re-resolve by id at commit time and say so when the row is gone. The
regression tests replace the whole array between opening the dialog and saving.

## `saveGames()` results have to be checked

`saveGames` wrote `localStorage.setItem` unguarded, so a quota error escaped
mid-handler with the in-memory list already changed and nothing shown to the
user. It now catches and reports. Separately, `submitSidebarGame` ignored the
return value entirely, so adding a game while the stored blob was unreadable
produced the error toast AND "Game added successfully!" one after the other,
and the game was gone on reload; it now rolls the push back and stops.

## Dialogs and toasts had no semantics

The focus trap and the Escape handler were correct, but nothing told assistive
technology a dialog had opened: `createModal` built `div.modal-overlay >
div.modal-dialog` with no role, no `aria-modal` and no accessible name, and the
toasts had no live region. This was the only app in the repo with zero
`aria-modal` attributes. `createModal` now sets `role` (`alertdialog` for
`createErrorModal`), `aria-modal` and `aria-labelledby` against a per-dialog
title id; toasts are `role=status`/`aria-live=polite`, or `alert`/`assertive`
for errors; `#iconSelectorModal` carries the same attributes and its close
button has a label.
