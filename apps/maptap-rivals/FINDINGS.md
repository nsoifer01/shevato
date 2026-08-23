# MapTap Rivals - engineering findings

Living document: the current best understanding of how this app behaves and
where it bites. Rewrite sections rather than appending to them.

## The game log stores a day once per rival

`maptapRivalsGames` holds one record per (day, rival) pair. A day played
against 3 rivals is 3 records that repeat the **same** `myScores` and the
**same** `cities`; only `rivalId`, `theirScores` and `id` differ.

Consequences for anything that aggregates *my* side:

- Per-rival stats can iterate the log freely, since each rival sees its own
  records only.
- Anything cross-rival must dedupe by `date` first, or my rounds get counted
  once per rival. `myAvgByContinent` (js/stats.js) takes one qualifying game
  per date, first wins. Without that, a 3-rival day reports 15 rounds instead
  of 5. The averages themselves barely move (the duplicated rows carry
  identical scores), so the skew is invisible without a unit test: the round
  counts, and any weighting derived from them, are what break.

## Pasting the same day twice updates it (duplicate defect fixed 2026-08-15)

`saveDay()` (js/app.js) now funnels every pasted day through
`upsertPastedGame(games, incoming)`: one record per `(rivalId, date)`. A
repeat paste UPDATES the existing record's four score fields in place instead
of appending a duplicate, the save bar reads "Updated N games" instead of
"Saved", and only newly added games count in the `games_logged` analytics
event (matching the sync path). This brought the paste path in line with the
other two writers, which always deduped on their own: profile sync indexes
existing games by date per rival and the WhatsApp importer skips existing
`(rival, date)` pairs in its preview.

Update semantics worth knowing:

- `id`, `createdAt` and any synced `cities` survive the update, so geo data
  is not lost when a synced day is corrected by hand.
- The `note` is reset to the incoming (empty) one ON PURPOSE: profile sync
  only refreshes scores on games whose note is `'synced from MapTap'`, so a
  hand-pasted correction must shed that marker or the next sync would
  silently clobber it back.
- Duplicates already sitting in a log (written before the fix, or imported
  from a backup) are NOT pruned; the upsert updates the first match and
  leaves the rest. Every aggregate is correctly id-agnostic and still counts
  such a pair as two days; `tests/stats.test.js` ("repeat paste") pins that
  stats-layer behavior, and `myAvgByContinent` plus the predictions
  distribution remain immune by their own date-dedupe.

The upsert is unit-tested through the `window._testExports` seam
(`tests/app-helpers.test.js`) and at browser level (the repeat-paste check in
`tests/browser/suites/apps.mjs` asserts one record with the corrected
scores).

## Geo data exists only on MapTap-synced games

`cities` (5 entries of `{ lat, lng }`) is written by the profile-sync path.
Games created from a manual paste have no `cities` key at all, and older
records may carry totals only (`myScore`/`theirScore`, no per-round array).
Every continent aggregate therefore starts by requiring
`Array.isArray(g.cities) && g.cities.length === N_LOCS` plus a matching
`myScores` array, and the UI hides its whole band or section rather than
render an empty shell.

**Null coordinates became Africa (fixed 2026-08-15).** `Number(null)` and
`Number('')` are `0`, not `NaN`, so a coordinate-less city used to arrive at
the classifier as the valid point (0, 0), land inside Africa's
`lat -35..38 / lng -20..52` box, and be averaged into the Africa chip and its
round count. The fix lives at the coercion, exactly where a `null` becomes a
`0`: `coordNum` (js/stats.js, exported) maps everything except actual numbers
and non-empty numeric strings to `NaN`, and BOTH continent aggregates -
`myAvgByContinent` (js/stats.js) and the per-rival `continentBreakdown`
(js/app.js) - now run `coordNum` on both fields and EXCLUDE any round without
a finite lat AND lng before calling the classifier. Sharing one helper is
what keeps the two views from drifting apart again. A genuine Gulf of Guinea
round at a literal `(0, 0)` still counts as Africa (that is why the fix could
never live inside the bounding-box table).

Behavior consequence, deliberate: `continentBreakdown` used to render
coordinate-less rounds as an `'Unknown'` row (e.g. iOS-fallback games, which
carry `NaN` coords); those rounds are now excluded from the per-rival
breakdown and its round count entirely, matching how the dashboard band
always treated them. `classifyContinent` itself still answers `'Unknown'`
for non-finite input as a contract backstop, and `CONTINENT_META` keeps the
entry for it.

Regression tests: `tests/stats.test.js` (the coercion contract, via a spy
classifier that must never see a non-finite pair) and
`tests/app-helpers.test.js` (the real `continentBreakdown` +
`classifyContinent` through the test seam).

The classifier stub in `tests/stats.test.js` still copies the real Africa box
verbatim so the genuine-(0, 0) case stays honest. Before 2026-08-15 the stub
answered `'Unknown'` for anything it did not like, which made the null case
look handled; a stub that cannot express a defect is worse than no test.

## The continent classifier stays in app.js, injected into stats.js

`js/stats.js` is a pure dual-export module (node `module.exports` +
`window.MapTapStats`) with no DOM and no geography. `classifyContinent` and
its bounding-box table live in `app.js` alongside `CONTINENT_META`, and
`myAvgByContinent(games, classify)` takes the classifier as an argument.

No Antarctica bucket, on purpose (owner call, 2026-08-15). The
`if (lat < -60) return 'Antarctica'` rule and the `'Antarctica'` entry in
`CONTINENT_META` were removed so sub-60S rounds fall through to `'Other'`: a
single polar round (the owner's real data had exactly one, avg 32.0) is noise
as its own chip and reads better folded into "Other". Nothing between the
deleted line and the final `return 'Other'` claims those coordinates, since
the lowest latitude floor left is South America's -56; verified for
(-70, 0), (-70, 170), (-89, -60), (-61, -70) and (-90, 0). Do not add the
bucket back without asking.

Why not move the table into stats.js: the boxes are tuned against real MapTap
rounds and are shared with the per-rival `continentBreakdown` in app.js;
duplicating them would let the two views drift apart, and moving them would
drag a lump of presentation-adjacent geography into the pure module. The
injected form also lets the unit tests use a trivial stub classifier, which
keeps the bucketing tests about bucketing. The real table is unit-tested
directly through the `window._testExports` seam (`tests/app-helpers.test.js`).

Rule ORDER in the table is load-bearing. Iceland's box (63..67, -25..-13)
sits entirely inside Greenland's (>60, -75..-10), so Iceland must be tested
first; until 2026-08-15 the Greenland rule came first, the Iceland rule was
dead code, and every Icelandic round classified as North America (found the
day the seam tests reached the real table). The only other land in Iceland's
box is open sea; East Greenland's coast is west of -25 and still hits the
Greenland rule.

## Dashboard DOM order is the markup order

`index.html` fixes the dashboard order: profile card, network notices,
network card, record banner, `#dash-summary`, `#dash-continents`,
`#todays-card`, `.paste-section`, `.dash-controls` (Rivalries), `#rival-grid`.
Nothing re-parents these at runtime; `#todays-card` and `#dash-continents`
only toggle `hidden`, so the paste panel still sits directly above Rivalries
when the predictions card is hidden.

`renderDashSummary()` owns the whole strip: it calls `renderDashContinents()`
on both paths (including the no-rivals early return), so every existing call
site (initial render, post-save refresh, sync) keeps the band in step without
new wiring.

## Dashboard width budget (why the continent band is a three-tier grid)

Two numbers govern every "make it fill the row" request on this dashboard:

- `.page` is `max-width: 1200px` with `1.25rem` side padding, so the content
  column tops out around 1157-1163px however wide the monitor is. Every
  dashboard block (profile card, network card, `#dash-summary`, the band,
  the predictions card, the rivalry grid) shares those two edges.
- The sitewide `assets/css/main.css` steps the root font by viewport:
  13pt above 1680px, 11pt from 981 to 1680, 12pt from 481 to 980, 11pt at
  480 and below. Everything here is sized in rem, so a wider monitor makes
  the cards BIGGER while the column stays the same. Wide is not roomier.

Measured consequence for the continent chips: one chip needs **14.5rem** to
keep a two-word name ("South America") on one line, so seven of them would
need ~1560px of row, which the column never provides. The band therefore
uses a grid with three tiers: `grid-auto-flow: column` (one row, equal
columns, flush to both edges) between 1160px and 1680px, the
`repeat(auto-fit, minmax(14.5rem, 1fr))` base outside that, and 2-up inside
the existing 480px block. The 1160px bound is measured, not guessed: a
seven-column row overlaps the score at a 1120px viewport and clears from
1140px (1160 is the shipped bound, for slack). In the one-row tier the two
American names wrap to a second line, which makes every card in that row one
text line taller; grid stretches all cards in a row to the same height, so
the row still reads uniform. The owner accepted that wrap on 2026-08-15 as
unavoidable inside 1160-1680.

**The rem-versus-px trap that cost a round.** The first version of this rule
shipped `minmax(12.5rem, 1fr)`, derived by taking a px measurement of the
widest chip and dividing by 16. The root font is only 16px in the 481-980
band; it is 14.667px (11pt) up to 1680 and 17.333px (13pt) above it, so the
tracks came out 26.4px short at 11pt (183.33 vs 209.78) and 30.5px short at
13pt (216.67 vs 247.20), and both American names wrapped almost everywhere -
cards 57.55px or 67.64px tall instead of their natural height. Always divide a chip measurement by the root font
*measured at that viewport*, never by 16. Because the chip is sized entirely
in rem, its natural width is one constant in rem across all three tiers
(measured with a worst-case "100.0" average: 209.78px at 11pt, 228.47px at
12pt, 247.20px at 13pt = 14.30 / 14.28 / 14.26rem), which is exactly why rem
is the right unit here.

Layout the current rule produces (7 continents, chips flush to
`#dash-summary`'s left and right edges at every width, no horizontal
scroll anywhere): 2+2+2+1 at 390-480, 3+3+1 at 768, 4+3 at 1024, 5+2 at 1159,
one row of 7 from 1160 to 1680 (the accepted wrap), and 4+3 above 1680.
Unwrapped card height is per font tier, not one number: 43.11px at 11pt,
46.84px at 12pt, 50.58px at 13pt.

## Paste panel: every writer of pasteState must refresh the save bar (fixed)

`refreshPasteSaveBar()` reads *all* of `pasteState`, so any input that mutates
it has to call the bar, not just the row it changed. A rival row's `input`
listener used to call `refreshPasteRivalRow()` alone, which made the bar a
snapshot of the state as of the last time my own textarea fired `input`. Two
symptoms, both live on production until 2026-08-15:

- Typing *my* score first and a rival's second left "Save day's games" disabled
  under "Paste at least one rival's score to save", even though the row already
  showed a correct `W +380` preview. Touching my own box again fixed it.
  Rival-first, mine-last always worked, which is why it survived so long.
- The mirror case: with the bar enabled, clearing the *rival's* box left the
  button enabled and the summary still claiming "Will save 1 game · 1W" while
  the row chip fell back to its empty dash. Clicking it did nothing, since `saveDay()`
  returns early on an empty target list.

Fixed by adding `refreshPasteSaveBar()` after `refreshPasteRivalRow(rival.id)`
in that listener (`js/app.js`, in `makePasteRivalRow`), the same row-then-bar
pairing `refreshAllPasteResults()` already used.

The other three writers were audited and are fine: `renderPasteSection()`
(prunes deleted rivals' entries, then goes through `refreshPasteMineUI()` and
`refreshAllPasteResults()`), `refreshPasteMineUI()` and `saveDay()`'s clear.
Rival add/delete and a cross-tab `storage` event both land in
`renderDashboard()` and therefore in `renderPasteSection()`. `#paste-date` has
no listener at all and the bar never reads the date, so nothing is needed
there.

Contrast (2026-08-15, was defect 28): `.paste-collapse-hint` uses
`var(--muted)`, not `var(--muted-2)` - the darker step measured 3.63:1 on the
card at 0.72rem (axe serious fail). The a11y browser suite scans this app's
root and fails on any serious violation, so keep hint-sized text off
`--muted-2`.

## One definition of a countable game (dashboard strip vs banner, fixed 2026-08-22)

Every figure that describes MY overall record reads the game log through
`eligibleH2HGames(games, knownRivalIds)` (js/stats.js): a real object with a
string `rivalId` and a valid `YYYY-MM-DD` date, both sides played, and the
rival still on the list. `overallRecord` builds the W-L-T, win %, per-game
and per-day averages on top of it; `periodRecords` applies the same rule for
the Records view. Callers: `renderDashSummary` (the strip), `renderRecordBanner`
(via `periodRecords`), the profile card's "Tracked H2H games" / "Your H2H
avg", and `actualScoresForDay` for the predictions card.

Why it had to be one function: the 2026-08-22 audit seeded a game whose rival
had been deleted (reachable because the rival list and the game log sync under
separate keys) and the strip read `5W · 4L · 1T over 10 games` while the banner
right above it read `5W · 3L · 1T`. The strip filtered on `bothPlayed` alone;
the profile card counted `state.games.length` ("11 games where both players
played" with a rival-only day in the log) and averaged `getMyTotal` over
rival-only rows as zeros (618 instead of 744). Three views, three private
definitions of "a game". Do not add a fourth: new aggregates take the eligible
list.

The History view still lists orphaned rows on purpose (with their delete
button), so a stranded game is visible and removable rather than invisible.

## Dates are local calendar days (UTC+ drift fixed 2026-08-22)

A day in this app is the user's LOCAL calendar day: the day MapTap showed
them, the day on a game row, the day a heatmap cell stands for. The helpers in
js/stats.js ("local calendar dates") are the only place date arithmetic and
formatting happen:

- `todayISO()` / `localDateISO(Date)` read local components.
- `addDaysISO`, `daysBetweenISO`, `dayOfWeekISO` work on the parsed parts
  through `Date.UTC`, so they are timezone-free.
- `formatDate(value, style)` accepts a `YYYY-MM-DD` day OR a full ISO datetime
  (the profile card's `verifiedAt` is `toISOString()` output, MapTap's
  `joinDate` is a datetime too), a Date or an epoch, and returns `''` for
  anything it cannot read. A datetime formats as the local day it falls on.

The trap that motivated this: `Date#toISOString` is always UTC, so a local
midnight east of Greenwich is the previous day. app.js used that in
`addDaysISO`, the calendar heatmap's day walk and the 7-day prediction window,
which for a Berlin user put "Fri 21" before "Today 22" in the day tabs and
ended the heatmap on yesterday (today's game never appeared). Separately, the
old `shortDate` appended `T00:00:00` to whatever it got, so the profile card's
"Last verified" and "joined" rendered empty. `tests/stats.test.js` runs the
helpers in child processes pinned to America/Chicago, UTC, Europe/Berlin and
Pacific/Auckland and requires the same local day from all four (and proves the
legacy expression disagreed).

Rule for new code: never build a Date from a bare `iso + 'T00:00:00'` and then
call `toISOString()`; never `Date.parse` a day string to do arithmetic. Use the
helpers. The only `toISOString()` calls left in app.js produce timestamps
(`verifiedAt`, `exportedAt`), which is what they are for.

## Backup import is validated before it replaces anything (fixed 2026-08-22)

`importData` parses the file, then hands the object to `sanitizeBackup`
(js/stats.js) and only replaces state after the user confirms the cleaned
counts. The contract (documented above the function): every rival and game is
rebuilt as a fresh plain object with only the known fields; a row that cannot
be made safe (no string id, no valid date, no side played, not an object) is
dropped and counted; score arrays must be five finite 0-100 numbers or they are
dropped as a field; scalar totals must be finite 0-1000; `cities` survive only
as five `{lat, lng, name}` entries with `coordNum`-coerced coordinates; a file
that is not `{rivals: [], games: []}` is refused outright with "Nothing was
changed". String ids are accepted verbatim (`__proto__` included: every
consumer keys by Map or null-prototype object).

Before this, a backup containing `null` rows or a game without a date was
persisted as-is and five of the six views threw on every render until a good
file was imported; "Clear games" would not have fixed the rival list.

## WhatsApp exports: formats and day/month inference (rewritten 2026-08-22)

Parsing lives in js/whatsapp.js (pure, unit-tested). The header regexes read
Android (`8/10/26, 21:05 - Name:`) and iPhone (`[8/10/26, 21:05:12] Name:`)
shapes with optional seconds, optional AM/PM (including `a.m.`), `/`, `.` or
`-` separators, 2- or 4-digit years, year-first dates, and the U+200E/U+200F/
U+202F/U+00A0 characters iOS puts around the time. The old importer matched
exactly one shape (24-hour Android, month-first), so a US phone with a 12-hour
clock or any iPhone produced "No WhatsApp messages found".

Day/month order is never assumed. `detectDateOrder` weighs evidence across
the file: a first field above 12 (day-first), a second field above 12
(month-first), a 4-digit first field (year-first), and the month named inside
a MapTap share body ("Aug 10" settles whether 8 is the month). With no evidence
the result is flagged uncertain and the modal shows a month/day vs day/month
select with a warning instead of guessing; contradictory files go with the
majority but stay flagged. The old heuristic compared the body month to a
header "month" that was really a day, which dated DD/MM exports a year off.

`dayBucketDate` decides the calendar day: the body's own date wins over the
header (a 1am share is yesterday's puzzle), the year comes from the header
and steps across New Year in either direction, and a body day the year does
not have (Feb 29 in a common year) yields null. Such shares are counted as
"undated" and reported in the modal, never rolled over to Mar 1. The same
rule protects the paste panel: `parseMapTapScore` exposes `dateParts` and
refuses to stamp a non-existent day.

## Accessibility: the empty-state scan lie (fixed 2026-08-22)

The shared a11y suite scanned this app at its root with fresh storage. That
state has no leaderboard rows, no prediction chips and no matrix cells, so two
critical and several serious violations shipped unnoticed: `aria-sort` on
`th[role=button]` (not allowed on a button), a `.pred-day-tabs` `tablist`
whose children were plain buttons, `aria-label` on a `span.row-note-pill`
(prohibited on a generic element), unlabeled `#history-rival-filter` /
`#history-result-filter`, scrollable wraps that keyboard users could not
focus, and `--muted-2` (#6b7280) at 3.63:1 under every small label it carried.

What changed, and the rule each one leaves behind:

- Sortable headers: `aria-sort` stays on the `<th>` (valid on a column
  header); the control is a real `<button class="lb-sort-btn">` inside it that
  fills the cell. Never put `role=button` + `aria-sort` on the same element.
- The prediction day strip is `role=group` with `aria-pressed` buttons. ARIA
  tabs need tab panels; toggle buttons that select a day are not tabs.
- Icon-only pills use `role=img` + `aria-label`; `aria-label` on a bare span
  is ignored by assistive tech and flagged by axe.
- Every horizontal scroller (`.matrix-wrap`, `.games-table-wrap`,
  `.leaderboard-wrap`) has `tabindex=0`, `role=region` and a label.
- `--muted-2` is now #8e96a8 (5.7:1 on `--surface`, 4.5:1 on `--surface-3`),
  the records toggle's active colour is #a5b4fc (6.6:1 on its soft accent),
  and the leaderboard header text uses `--muted`. Keep hint-sized text on
  those tokens; do not reintroduce a darker step.
- Modals share one `openModal` / `closeModal` pair: focus moves in, Tab and
  Shift+Tab cycle inside the panel, Escape closes the top-most dialog, and
  focus returns to the element that opened it. The delete-rival confirmation
  is a styled modal like delete-game and clear-games; `window.confirm` is
  gone from the rival path.
- Rival pages are reachable by keyboard: the card name is a real link
  (`#rival/<id>`), as is the leaderboard name cell; the card and the row stay
  clickable for pointer users.
- Every control shows a focus ring via a scoped `:focus-visible` rule
  (main.css zeroes outlines on some controls, hence `!important`).
- The suite now also scans two SEEDED MapTap Rivals states and waits for
  rendered rival cards and prediction rows before injecting axe; the app's own
  `e2e/quality.mjs` scans every rendered view. A green scan of an empty page
  is not coverage.

The share toast is `pointer-events: none` by design (it floats over tables).
The Undo toast is the same element with a button, so `.has-action` restores
`pointer-events: auto` and the toast carries `z-index: 2000`; without both the
button rendered but a coordinate click landed on the footer link beneath it.
Hit-test interactive overlays with `elementFromPoint`, never `element.click()`.

## Responsive containment (390-1160, fixed 2026-08-22)

- Horizontal scrollers announce themselves. app.js stamps
  `data-scroll="none|start|middle|end"` on `.view-tabs`, `.pred-day-tabs`,
  `.matrix-wrap`, `.games-table-wrap` and `.leaderboard-wrap` (scroll, resize
  and a MutationObserver on `main`), the tab strips fade the edge with more
  content through a mask, and the bordered wraps paint scroll shadows with the
  `background-attachment: local/scroll` technique. At 390px three of the six
  view tabs used to sit off-screen behind a hidden scrollbar with nothing
  hinting they existed.
- At 480px and below the seven prediction day tabs share the row (`flex: 1`)
  instead of scrolling, and nothing in the predictions card or the card chrome
  drops under ~0.72rem (10.5px at the 11pt phone root). Density comes from
  padding, not from text size.
- The matrix keeps its natural width on phones (`table-layout: auto; width:
  max-content; min-width: 100%`) and scrolls inside its wrap; squeezing the
  fixed-layout table to 390px made cells overlap. The rival chips ellipsize
  their text.
- Long rival names (the audit used 57 characters) wrap inside every card
  (`overflow-wrap: anywhere` on summary values, card names, the rival header,
  drama lines, record rows) and single-line labels (`.continent-scores .col
  .k`, `.lc-avg-them`) ellipsize with the full name in `title`. A long name in
  the "Toughest rival" summary card used to widen the page by up to 53px at
  1024-1160px.
- Touch targets: finish-position rows, name toggles, day links and score
  links get ~2rem hit areas under `(hover: none)` or 768px and below, through
  padding/negative-margin pairs that leave desktop layout unchanged.

The continent band's three-tier grid (section above) is untouched.

## Narrative copy must be mathematically true (2026-08-22)

`streakDrama`: a current win streak EQUAL to the previous best is one win
short of a record, so the line reads "level with your record: win today to
break it" (it said "match your record"); the losing-streak mirror reads "level
with your worst slump". `consistencyLabel` bands σ of the DAILY total at
60/110: the old 10/20 cut-offs were round-score numbers, so every real history
read "Streaky". The trend chart's y-axis floors at 0 (a short history started
it at -50). "Biggest swings" reads totals through `getMyTotal` /
`getTheirTotal`; a game that carries only round arrays rendered
`undefined–undefined`. Copy that counts things goes through `countNoun` ("1
game without geo data"), which avoids verb agreement altogether ("1 game have").

"Leave network" while signed out clears the local cache only; its status line
now says exactly that and tells the user to sign in and leave again to remove
the published profile (`leaveNetworkMessage`). It used to claim "You left the
rival network". A sync attempt without an own username opens the profile card
for editing and focuses the username input (`focusProfileUsername`); the old
message pointed at a Settings field that no longer exists.

## Open: the shared site header sits above every app modal (found 2026-08-23)

`.modal` is `position: fixed; inset: 0; z-index: 100` (css/styles.css, from the
app's first commit); the shared chrome in `assets/css/main.css` gives `#header`
`z-index: 10001`. So while any dialog is open the header strip is neither
dimmed by the backdrop nor covered by it: `document.elementFromPoint(5, 5)`
returns the site `logo`, and a click there NAVIGATES AWAY from the app, taking
the open dialog with it. Below the header the backdrop behaves correctly
(clicking it closes the dialog), and the keyboard focus trap added in the
2026-08-22 pass is unaffected: Tab and Shift+Tab still cycle inside the panel.

No data is lost when it happens (the click is a plain navigation), which is why
it went unnoticed: the 2026-08-22 audit saw a "backdrop click closes" probe
fail and mis-attributed it to the probe. It is NOT a regression from that pass;
the rule predates it and no change in that round touched modal stacking.

Fixing it is a one-line raise of `.modal`'s z-index above the shared header
(and a check that the toast, `z-index: 2000`, still sits sensibly relative to
both). Deliberately left out of the 2026-08-22 quality-pass PR: it is a
pre-existing, non-regressive, site-chrome interaction, and that PR was already
verified end to end. Worth doing as the next small piece of work, together with
a hit-test assertion (`elementFromPoint` at the top-left corner with a dialog
open) in `e2e/quality.mjs`.

## Audit recommendations deliberately not taken (2026-08-22)

- Rival-vs-rival predictions: the matrix already compares rivals on shared
  days and the predictions card ranks everyone on the day's puzzle; a third
  surface would add density, not information.
- Notifications or any "your rival just posted" push: no backend for it, and
  the drama line already says "Ari already posted today, your move".
- Forbidding near-duplicate rival names: two real friends can share a name;
  the modal warns ("You already have a rival named Ari") and the icon/colour
  tell them apart.
- Blocking future or far-past paste dates: both are legitimate (logging a
  missed week, fixing a wrong year); the hint makes the date unmissable
  instead.
- Export carrying the MapTap username/profile: the backup is the game data;
  re-verifying on a new device is one click and keeps the profile snapshot
  honest.

## What the unit tests reach, and what they still cannot

`tests/stats.test.js` and `tests/network.test.js` `require()` the two dual-
export modules directly. `js/app.js` is one big IIFE with no module exports,
but since 2026-08-15 it ends with a `window._testExports` block (rising-shows
`_rsTestExports` precedent) exposing pure helpers for node:
`classifyContinent`, `continentBreakdown`, `computeMatrixCell`,
`mergeMatrixCells`, `matrixCellViewModel`, `rivalSummary`, `upsertPastedGame`.
`tests/app-helpers.test.js` loads app.js with `node:vm` into a sandbox
(document stuck at `readyState: 'loading'` so `init()` never runs, a
never-settling `fetch`, Map-backed localStorage seeded per context so
`rivalSummary` and `streakDrama` see a known game log; `document.baseURI`
must exist because `FIREBASE_CONFIG_URL` is computed at parse time, and
`window.MapTapWhatsApp` must be provided like the other two modules). vm-realm objects fail
`assert.deepEqual` from `node:assert/strict` on prototype identity, so the
harness JSON-projects them (`plain()`) before comparing.

Still outside unit-test reach: the paste panel DOM flow around `saveDay`,
`locationStats` / `carryChoke`, the predictions card assembly, the MapTap sync
merge, the network Firestore calls, and every render path. Since 2026-08-22
the WhatsApp parser (`js/whatsapp.js`), the backup validator and the date
helpers are pure and unit-tested, and `e2e/quality.mjs` covers the rendered
paths the audit found broken (seeded axe at 1280 and 390, keyboard
reachability, modal focus, delete/Undo, paste-date reset, refused imports,
WhatsApp formats, overflow at 390/1100); the `.features/` plans hold the rest.

Where a defect lives in app.js but is *visible through* a pure function's call
contract, the test file states the contract in a comment and stubs the app.js
side faithfully rather than conveniently (see the classifier stub above).
Tests asserting the correct behavior of a still-shipped defect carry
`{ todo: 'KNOWN DEFECT: <summary>' }`; as of 2026-08-15 the maptap suites
carry ZERO todos - all three (null-coordinate Africa bucket, two
`'__proto__'` player-key cases) are fixed and their tests flipped to plain
regressions.

The `'__proto__'` fix pattern: every accumulator keyed by an id that can come
verbatim from untrusted data (rival ids via backup import, dates via a remote
profile payload, network uids via a hand-seeded cache) either builds in a
`Map` and returns through `Object.fromEntries` (stats.js:
`positionHitsForDay`, `accumulatePositionHits`, `finishPositionsForDay`,
`fieldSharesForDay`, `competitionRanksForDay`, `accumulateFinishPositions`,
the `runningRivalPeriodRecords` snapshots, `mapTapHistoryToRounds`) or is
`Object.create(null)` (app.js: the calendar `dayMap`, `netStringMap`, both
network `directory` builders). `Object.fromEntries` defines own data
properties, so `'__proto__'` lands as data and the plain-object return shape
(which `assert.deepEqual` and all callers rely on) is preserved.

## Verifying the dashboard in headless Chrome

The repo's screenshot helper writes its probe into the primary tree's repo
root, so it is the wrong tool inside a worktree. What works: serve the
worktree root (`python3 -m http.server 8082 --directory <worktree>`), put a
seed page under the gitignored `.screenshots/` that writes
`maptapRivalsRivals` / `maptapRivalsGames` / `maptapRivalsMe` into
`localStorage` and then `location.replace()`s to
`/apps/maptap-rivals/index.html#dashboard` (same origin, so the seed sticks),
and point chromium at the seed page.

Second trap (cost an hour on 2026-08-22): a long-lived headless profile
serves a CACHED `index.html` / `app.js` across navigations, so a probe can run
against markup from before your edit (elements "missing", handlers absent).
Send `Network.setCacheDisabled` on every CDP session, or use a fresh
`--user-data-dir` per run.

Probe trap: the paste panel's inputs (`#paste-mine-input`, `#paste-date`) are
static markup, so polling for them says nothing about whether `init()` has run
and attached its listeners. Poll for rendered content instead
(`.paste-rival-row`, `#dash-summary .dash-summary-card`), otherwise the probe
dispatches events into a page with no listeners and reports a phantom bug.
`--dump-dom` prints the top document only, so an iframe probe has to copy its
findings into the parent document to be readable.
