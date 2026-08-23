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
`rivalSummary` sees a known game log; `document.baseURI` must exist because
`FIREBASE_CONFIG_URL` is computed at parse time). vm-realm objects fail
`assert.deepEqual` from `node:assert/strict` on prototype identity, so the
harness JSON-projects them (`plain()`) before comparing.

Still outside unit-test reach, covered only by browser probes and the
`.features/` human plan: the paste panel DOM flow around `saveDay`,
`locationStats` / `carryChoke`, the predictions card assembly, the WhatsApp
importer (including `dayBucketDate`'s year compensation), export/import, the
MapTap sync merge, the network Firestore calls, and every render path.

**One sanitiser guards every entry path (fixed 2026-08-22).** `importData`
used to check only `Array.isArray(parsed.rivals)` / `Array.isArray(parsed.games)`,
assign them verbatim, persist, and only then render, so a junk backup was
already in storage when the render threw and the `catch` labelled it "Could
not parse backup file" - every view, and through `applyUrlHash` every
subsequent page load, stayed broken until storage was cleared. Now a pure
`sanitizeBackup(parsed)` (exported through `_testExports`) runs BEFORE
anything is written, by all three readers of stored lists: `importData`, the
module-level boot (`state.rivals` / `state.games`) and the cross-tab
`onExternalStorage` handler. It returns `{ data, rejected[], repaired[] }`:

- rejects non-objects, rivals without a name, duplicate rival ids, games
  without a `rivalId`, dates that are not a real calendar day (`2026-02-30`
  parses in JS and used to roll to Mar 2), round arrays that are not five
  numbers in 0-100, and non-numeric `myScore`/`theirScore`;
- repairs what is safe: assigns ids where missing, coerces numeric strings,
  fills colour/icon/createdAt, derives a missing total from the rounds;
- keeps legitimate legacy shapes untouched - a totals-only record
  (`myScore`/`theirScore`, no arrays) and a rival-only synced day both
  round-trip byte-for-byte, and a clean export reports zero repairs.

The import dialog is honest about the outcome: the confirm names how many
entries will be skipped and the result reads "Imported N rivals, M games.
Skipped K invalid entries: <reasons>." A file where nothing survives is
refused outright and current data is left alone. At boot, a corrupted
`maptapRivalsGames` (`{"a":1}`, null entries) no longer crashes rendering:
the surviving entries load and a toast says how many were skipped.

Two NaN paths were closed at the same time, because sanitising new writes
does not clean logs already on disk: `weightedTotal` treats a non-finite
slot as 0, and `average`/`stdDev` filter non-finite values, so one bad
record can no longer blank the dashboard "Avg score" or print a literal
"NaN" in the rival view and leaderboard. Renderers that format a number
(`rivalryScore`, avg delta, the profile card's MapTap figures) guard with
`Number.isFinite` as a second line of defence; `renderProfileCard` no longer
throws when a stored snapshot has no `avgScore`.

Regressions: `tests/app-helpers.test.js` (sanitizeBackup junk / `__proto__` /
legacy / round-trip / stringy-number cases, plus a boot test that seeds a
corrupted log), `tests/stats.test.js` (the NaN contract) and
`apps/maptap-rivals/e2e/audit-2026-08.mjs` (the real `#import-file` input
with fixtures written under `.screenshots/`).

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

Probe trap: the paste panel's inputs (`#paste-mine-input`, `#paste-date`) are
static markup, so polling for them says nothing about whether `init()` has run
and attached its listeners. Poll for rendered content instead
(`.paste-rival-row`, `#dash-summary .dash-summary-card`), otherwise the probe
dispatches events into a page with no listeners and reports a phantom bug.
`--dump-dom` prints the top document only, so an iframe probe has to copy its
findings into the parent document to be readable.

Three more probe gotchas from the 2026-08-22 audit:

- File inputs: `DOM.setFileInputFiles` on `#import-file` / `#wa-import-file`
  does not fire `change` on its own, and the snap Chromium cannot read files
  under `/tmp` (`files.length` stays 0, no error). Write fixtures under the
  gitignored `.screenshots/` and dispatch `new Event('change',
  {bubbles:true})` after setting the files.
- Hash URLs and `seedAndReload`: `Page.navigate` to a URL that differs only
  in the fragment is a same-document navigation, so `seedAndReload(s, APP +
  '#rival/r1', ...)` never reloads and the view keeps the pre-seed state.
  Seed on the bare app URL, then `goto` the hash.
- The MapTap profile endpoint is a CORS-preflighted POST
  (`MAPTAP_PROFILE_URL`, body `{data:{nickname}}`, JSON content type):
  `Fetch.fulfillRequest` stubs must also answer the OPTIONS preflight with
  `Access-Control-Allow-Headers: content-type` or every stubbed verify
  reports "Failed to fetch". The real endpoint answers localhost origins, so
  an un-intercepted probe hits production data (read-only).

Two more, learned while writing `e2e/audit-2026-08.mjs`:

- **The paste panel is a collapsed `<details>`.** Chromium keeps reporting the
  last-known geometry for content inside a closed one
  (`content-visibility: hidden`), so `#paste-save-all`'s rect looks plausible
  while `elementsFromPoint` at its centre returns the site footer that is
  actually painted there. A coordinate click then does nothing and
  `element.click()` "works", which reads as an app bug and is not one: open
  the panel (`.paste-collapse-summary`) before typing or clicking.
- **`scrollIntoView` is a no-op on these pages** (the site chrome sizes
  `<html>` to the viewport), so `clickSel`, which scrolls and reads the rect
  in one evaluate, clicks stale coordinates for anything below the fold.
  Scroll with `window.scrollTo(0, rect.top + scrollY - innerHeight/2)`, settle,
  then click.
- Pages in one browser share an origin and therefore one `localStorage`:
  clear the `maptapRivals*` keys before each seeded block or the previous
  block's games leak into the next one's assertions.

## Orphan games count nowhere (fixed 2026-08-22)

A game whose `rivalId` has no rival is reachable through per-key sync: two
devices carry the rival list and the game log as independent keys, so a
delete on one can be half-undone by the other. Until 2026-08-22 only
`periodRecords` (Records, via `liveRivalIds()`) and the Leaderboard ignored
those games, while `renderDashSummary`, the record banner and `renderHistory`
counted them - the dashboard said "across 2 rivals / over 4 games" with two
ghosts included, and History showed rows with an empty rival cell that the
filter could neither isolate nor exclude.

One selector now decides it everywhere: `liveGames(games, rivals)` (exported
through `_testExports`), used by the dashboard summary, the record banner's
period records, History and both predictions-accuracy passes. Its twin
`orphanGames()` feeds a notice at the top of History - "N games without a
rival ... not counted anywhere until you reassign or delete them" - with a
rival picker plus Reassign and a confirmed Delete. Nothing is auto-pruned:
the owner decides, which is the rule the sync design already implies.

Regressions: `tests/app-helpers.test.js` (`liveGames` / `orphanGames`) and
the D2 block in `e2e/audit-2026-08.mjs` (summary counts, History rows, the
notice, and a Reassign that persists).

## Every ISO date walk goes through `localISO` (fixed 2026-08-22)

`toISOString()` on a local-midnight `Date` reports the UTC date, which in any
UTC+ zone is the previous day. `todayISO` compensated for the offset;
`addDaysISO` and the heatmap walk did not, so in Asia/Jerusalem or
Pacific/Kiritimati the same seed rendered a blank leading week and stopped at
yesterday while the paste date, predictions and "Today" said today.

`localISO(date)` is now the single serialiser and `todayISO`, `addDaysISO`
and the heatmap all call it. The week walk itself moved into a pure
`buildHeatmapWeeks(firstGameISO, today)` (exported), unit-tested under
`TZ=America/Chicago`, `Asia/Jerusalem` and `Pacific/Kiritimati`: the first
column is always a full Sunday-started week and the last day is always today.

Two more heatmap fixes ride along:

- Dates are filtered through `isValidISODate` before the walk. A record
  whose `date` does not parse used to throw `RangeError` inside
  `toISOString` and abort the rest of `renderRival`; the section now skips
  those records (and hides itself when none are left).
- On narrow viewports (wrap under 520px) the grid shows the last
  `HEATMAP_MOBILE_WEEKS` (26) columns instead of up to 80, which keeps cells
  above 10px, and tapping a cell writes its day summary into a live region
  under the grid - hover tooltips do not exist on touch screens.

## What else the 2026-08-22 audit round changed

- **Signed-out "Join rival network" was silent** (`joinNetwork()` returned
  early when the user was not registered). The button is no longer disabled:
  it opens the shared sign-in modal via `window.authUI.showAuthModal()`, and
  falls back to a status line when that global is not loaded. Unverified but
  signed-in users get "Verify your MapTap profile (the card above) before
  joining" instead of nothing.
- **Accessibility with data present.** The a11y browser suite scans this app
  with EMPTY storage, which is why it read zero while seeded views carried
  serious and critical violations. Fixed at the source: `.pred-day-tabs` is
  `role="group"` (its children are toggle buttons with `aria-pressed`, never
  tabs owning panels); the nine sortable leaderboard `<th>`s dropped
  `role="button"` and kept `aria-sort` (which is not allowed on a button);
  both History filter selects carry an `aria-label`; `.row-note-pill` is
  `role="img"` so its `aria-label` is legal; `#matrix-wrap` is focusable with
  a label so a keyboard can reach its scroll. Contrast was fixed at the token
  rather than at 38 call sites: `--muted-2` went `#6b7280` (3.63:1) to
  `#8a91a6` (5.59:1 on `--surface`, 4.99:1 on `--surface-2`), which keeps the
  muted/muted-2 hierarchy intact, and the active Records unit button uses
  `#a5b4fc` (6.6:1) instead of `--accent-2` (4.4:1). The e2e suite now runs
  seeded axe scans over all six views at 1280 and 390.
- **Focus.** The rival modal and my-icon flyout restore focus to their
  opener, and Tab/Shift+Tab are trapped inside whichever modal is open
  (`trapFocusIn`, wired once in the document keydown handler). The view tabs
  have a real `:focus-visible` ring: the UA default computed to
  `auto 1px rgb(16,16,16)` and was invisible on this background.
- **Name collisions** are hinted, never blocked (ids keep the data right, so
  this is a clarity problem): `rivalNameHint()` warns in the modal when a
  name duplicates an existing rival case-insensitively or equals my own name,
  and the settings strip warns when my name matches a rival's.
- **Dates in the paste panel.** `parseMapTapScore` no longer stamps the
  current year unconditionally: a share dated more than a day ahead of today
  belongs to last year ("Dec 31" pasted on Jan 1), and a day that does not
  exist in its month ("Feb 30", which used to roll to Mar 2) yields no date
  at all. A future `#paste-date` is called out in the save bar before saving.
- **WhatsApp import** understands every export shape in the wild, not just
  US-locale Android 24h: one `WA_HEADER_RE` covers the iOS bracket form with
  seconds, AM/PM (including the U+202F and U+00A0 separators current Android
  writes) and DD/MM headers. Day/month order is decided per file - any first
  number above 12 means DD/MM, any second above 12 means MM/DD - and when a
  file settles neither, US order is assumed, `ambiguousOrder` is set, and the
  modal offers a checkbox that re-parses the kept raw text. `parseWhatsAppText`
  and `dayBucketDate` are exported and unit-tested against all six audit
  fixtures.
- **Phones.** The matrix table gets a computed `min-width` so the wrap
  scrolls instead of squeezing cells to 40px of overlapping text; touch
  targets under a coarse pointer grow (swatches, modal close, my-icon,
  settings buttons, pager); the tab strip fades its right edge while more
  tabs sit off-screen (`is-scrollable` / `is-scroll-end`, toggled on scroll
  and resize).

Still open from that audit, deliberately: the backup export still omits the
verified MapTap profile and the matrix preferences (a restore on another
device lands unverified); "Sync all rivals" still uses native `alert()`
while every other confirmation is a styled modal; predictions still show
"avg 0%" for a single-loss rival and Reveal buttons to users with no
verified profile; the leaderboard and History still hide their right-hand
columns behind an unhinted horizontal scroll on phones.
