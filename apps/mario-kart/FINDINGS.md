# Mario Kart Tracker - engineering findings

Living document: rewrite sections as understanding improves. Started
2026-08-22 from the site-wide audit; the fixes landed on 2026-08-23 and every
section below describes the behaviour as it now stands plus the regression
that pins it. `README.md` beside this file says what the app is; this file
says what we learned about it.

## The game-version toggle used to destroy the page's indexed title

`js/gameVersionManager.js` ran `document.title = 'MK8 Deluxe - Race Tracker'`
on every load, before any user interaction. Google indexes the RENDERED title,
so the page's real `<title>` ("Mario Kart Race Tracker | Mario Kart 8 Deluxe &
Mario Kart World") never reached the index and the search result named neither
the site nor what the page does. Removed 2026-09-04.

The toggle is in-page STATE, not a different page, so it now leaves the title
and the `h1` alone and writes the selected game into `.header-subtitle`
instead. The kart / globe glyph follows the selection through the
`mk8d-mode` / `mkworld-mode` body class the switcher already sets, as CSS
generated content on `.h1-text::before/::after` - so the glyph is not part of
the heading's text (it used to be, making the `h1` read
"(kart) Mario Kart 8 Deluxe Tracker (kart)"), and a no-break space keeps it
attached to the first and last word so it cannot orphan onto its own line when
the heading wraps at 390 px.

The eight help-panel headings were `<h4>` directly under the `h1`, jumping two
outline levels. They are `<h3>` under a `<h2 class="help-panel-heading">What this tracker does</h2>` now;
`.help-section h4` selectors in `layout.css`, `refresh.css` and
`help-styles.css` moved with them.

## Undo/redo is a stack replayed against the live `races` array

`actionHistory` holds deep-copied `{type, data}` entries whose DELETE/EDIT
entries carry an array index. Anything that replaces the log wholesale must
therefore either record an action whose undo restores the same rows at the
same indices, or drop the stack:

- `clearData()` records `CLEAR_DATA` with a snapshot of the log (after
  refreshing the auto-backup, so Restore also works after a reload). Undo
  restores the snapshot; older EDIT/DELETE entries then replay against the
  rows they were recorded on. Before this, Undo after "Delete Everything"
  wrote `[null, null, ..., {race}]` to storage and Stats threw on reload.
- Import, Restore, a game-version switch and a foreign tab's write all call
  `resetActionHistory()`; their new log has nothing in common with the
  stack. The stack is memory-only: `marioKartActionHistory` was never
  written and is no longer listed in the sync config.
- `migrateRaceData` (load path) drops null/non-object rows, so a log left
  sparse by the old bug heals on the next load.

Pinned by `tests/audit-2026-08.test.js` ("D1 ...") and the clear+undo block of
`e2e/audit-2026-08.mjs`.

## One validator for every wholesale replacement of the log

`sanitizeRaceData()` in `dataManager.js` is used by import and by Restore
(and its per-race `healRace` by the load path). Repairs that cannot change a
result are applied and listed in the success toast ("repaired: healed a 24:MM
midnight time x2, ..."): legacy `slav/mike/nikita` keys, `24:MM:SS` stamps,
empty entries, unreadable timestamps/course tags (dropped), over-long course
names (80 chars), whole-number text positions. Anything that would change a
result rejects the whole payload with a message naming the race: a date that
is not a real `YYYY-MM-DD` day, a non-integer, out-of-range or duplicate
position. Nothing is persisted before the validator says ok. Player names
from a file go through `sanitizePlayerNames` (strings only, trimmed, 40
chars) and symbols must be short strings. Import error messages never carry
engine text (the old `Cannot read properties of null` / raw SyntaxError).
A real 2024-shape export with legacy keys and a `24:` stamp is a test
fixture; keep it importing.

## Renderers escape every stored string

`window.escapeHtml` (shared `assets/js/escape-html.js`) is applied at every
innerHTML sink that interpolates a name, symbol, timestamp, date or course:
the two H2H tables in `statistics.js` (`h2hEsc`/`h2hName`, including the
`data-vs` attribute the phone layout reads), the history table and mobile
cards, the sort headers and stat cards in `main.js`, the edit/delete modal
labels, meta line and `value` attributes in `dataManager.js`, the Trends
summary line, the sidebar race form and Manage Players. Player names are
capped at 40 characters at the manager and the input. Tooltips and icon
chips already used `textContent`. Regression: `audit-2026-08.test.js`
("D3 ...") renders through the real functions with
`<img src=x onerror=...> "Bob" & 'Cara'` and asserts the escaped text
round-trips; the e2e walks every view plus both modals and asserts no `<img>`
is created and `window.__pwn` stays unset.

## Modals go through `presentModal` (modalUtils.js)

Edit, delete, clear, restore and `createModal` all mount through one helper:
`role="dialog"`, `aria-modal`, `aria-labelledby` on the `.modal-title`, one
document keydown listener removed on every close path (Escape, buttons,
backdrop; the old copies removed it only on the Escape path, so each
cancelled modal left a listener that threw `NotFoundError` on the next
Escape), a Tab/Shift+Tab trap, initial focus on a sensible control (date
field; Cancel for destructive confirms) and focus restored to the opener.
Callers escape their strings before passing `html`. Under `node:vm` the unit
tests stub `presentModal` and drive the button handlers directly; the e2e
covers the real lifecycle.

## Two tabs: `ShevatoTabSync` re-reads, never writes

`index.html` loads `sync-system/tab-sync.js` before the app scripts and
`main.js` watches every `marioKart*` key. The handler (debounced 120 ms)
re-initialises the name and symbol managers, calls `loadSavedData()`,
resets the undo stack and re-renders. It never writes (the helper blocks and
logs writes from inside a handler), so an add in A, an add in B and a delete
in B all end up in storage and on both screens, and A's next add cannot
resurrect what B deleted. The cloud path (`localStorageSync` events with
`source: 'remote'`) keeps its own 750 ms refresh. Pinned by the two-page
block of the e2e.

## Player names, symbols and count are per game version

`PlayerNameManager`, `PlayerSymbolManager` and the count in `loadSavedData`
resolve their key through `getStorageKey` at every access, so MK World uses
`marioKartWorldPlayerNames` / `...Symbols` / `...Count` and the sync key list
in `sync-system/app-sync-init.js` is now true. The base MK8D key is a
read-only fallback when the World key is absent, so an existing roster
carries over the first time MK World is opened and diverges at the first
write there. `switchGameVersion` re-initialises all three, resets the undo
stack, regenerates the sidebar race form (clears stale inputs, applies
`max=24`) and refreshes icons. Manage Players reads the in-memory count via
`window.getPlayerCount()` instead of storage, which is what showed "3"
selected beside a four-wide form. `sidebarOpen` is no longer written or
synced (device-local UI state that was flipping the other device's sidebar).

Decreasing the count used to throw `ReferenceError: allPlayers is not
defined` (a local of `rosterForCount` referenced from `updatePlayerCount`),
aborting before the form/bars/toast updated; fixed, pinned by "D2 ...".
The roster union (`rosterForCount`) still keeps removed players' recorded
results visible in history and stats.

## Dates: the rolling filters are local calendar windows

"Last 7 Days" is today plus the six previous LOCAL calendar days, "Last 30
Days" today plus 29, compared as `YYYY-MM-DD` strings
(`localDateDaysAgo` in `dateFilter.js`). The old code parsed `race.date`
with `new Date('YYYY-MM-DD')` (UTC midnight) and compared it with
`now - 7*24h`, losing the oldest day after 19:00 CDT. `dateFilter.test.js`
now pins `TZ=America/Chicago` (under UTC the bug could not show, which is
how the suite used to protect it) and checks 00:30 and 20:30 on the same day
give the same window.

## History order and sort indicator

`orderRacesForDisplay` in `main.js` is the only place rows are ordered: with
no sort column the table is chronological newest-first (an edited date moves
to where it belongs); with one, rows follow that column in the chosen
direction, so "↑"/`aria-sort="ascending"` means ascending (the old code
sorted ascending and then reversed the list). "Race #" still numbers by
insertion order. Absent positions (null or a missing key after the roster
widened) render "-" via `isFinitePosition`, never "undefined", and sink to
the bottom when sorting by a player column. After a sort the re-rendered
header keeps keyboard focus (`data-sort` attribute).

## Positions are whole numbers everywhere

The sidebar form, the edit modal and `addRace` reject anything but
`/^\d+$/` with "Positions must be whole numbers"; inputs carry `step="1"`
and `inputmode="numeric"`. `parseInt` used to turn "1.5" and "1e1" into 1
silently, and the validator now rejects a stored 2.5 on import.

## Layout facts

- The mobile sidebar is 280 px wide and the race-form position picker
  206 px. The grid uses `repeat(4, minmax(0, 1fr))` (a plain `1fr` track is
  floored at the button's min-content width, which is how 4 x 53 px clipped
  positions 4/8/12 at 390) and the 3-column rule applies up to 430 px. The
  e2e asserts every button's box sits inside the picker at 360/390/412 and
  taps position 4 by coordinates.
- H2H on phones (<= 768 px): the same table markup renders as stacked
  cards, one per player, each opponent cell a labelled line whose label is
  the escaped `data-vs` attribute; no sideways scroll, no truncated streak
  text.
- The fixed sidebar toggle slides off-screen while scrolling down (class
  `scrolled-away`, <= 900 px) and returns on the first scroll up, so it never
  covers the pagination "previous" button.
- Touch targets: sidebar close/trash 40 px, pagination buttons 40 px (scoped
  override of the shared CSS), course clear 28/32 px (inside a 40 px tall
  field). Contrast: `.sidebar-section-title` uses `--mk-muted` (was
  `--mk-muted-2`, 4.04:1); the Trends summary uses `.trends-summary` (was an
  inline #718096 on #2d3748, 2.98:1).
- Toasts sit bottom-centre with `role="status"`, one at a time (`.mk-toast`).
- Every empty state and the first-run Help view carry an "Add your first
  race" button (`startAddRace()` opens the sidebar and the form).
- The tablist handles Left/Right/Home/End; `label.player-name-label` no
  longer carries `role="button"`/`tabindex` (it has no handler).

## Still open

- Pagination does not clamp `currentPage` when the item count shrinks
  (shared `assets/js/pagination.js`, owned by the football-h2h round).
- DST edits keep the original zone suffix ("CDT") on a November timestamp;
  cosmetic, the stamp is parsed by wall-clock only.
- Stats cards use a 3-column grid, so a fourth player sits alone on a
  second row; mobile race cards are tall (about 360 px each, 10 per page).

## The cloud-sync refresh has to drop the undo stack too

The cross-tab handler always called `resetActionHistory()` after
`loadSavedData()`, for the documented reason: `races` is replaced wholesale and
the stack describes the OLD array. The `localStorageSync` (cloud) handler did
not. Undo after a remote sync therefore popped whichever race was last in the
OTHER device's log and wrote the result back, and per-key last-writer-wins
propagated that deletion everywhere: pressing Undo deleted someone else's race.
Both handlers now reset the stack. Pinned by `tests/syncHandlers.test.js`,
which asserts the shape of both callbacks (main.js registers them inside DOM
bootstrap, so the listener itself needs the whole page to drive).

## REJECTED: "the stat counts render black on a dark card"

A 2026-09-03 audit reported `theme.css` `body.theme .stat-count { color:
#000000 !important }` as a contrast defect beating `stats.css`'s `#e2e8f0`,
and it looked convincing in source. It is wrong, and the measurement is worth
keeping so it is not re-raised.

`.stat-item` does not composite to a dark surface. Compositing every ancestor
background in a real render at 1280 gives `rgb(166, 172, 183)`, a light grey
card. Against that:

| colour | composited background | ratio |
|---|---|---|
| `#000000` (shipped) | `rgb(166,172,183)` | 9.21:1, passes AA |
| `#e2e8f0` (the "fix") | `rgb(166,172,183)` | 1.85:1, fails |

Removing the black pin made the counts nearly invisible. Reverted. Measure the
COMPOSITED backdrop (walk the ancestors and blend, including translucent
layers), never the element's own `backgroundColor`, which here is
`rgba(255,255,255,0.1)` and tells you nothing.
