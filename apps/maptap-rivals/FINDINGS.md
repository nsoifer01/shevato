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

## Known defect: pasting the same day twice stores it twice

`saveDay()` (js/app.js:2408) pushes one new game per rival with a fresh
`uid()` and no check for an existing record on that `(date, rivalId)`. Paste
the same day again (double click, reload mid-entry, or simply not remembering)
and the log holds two identical records. The other two write paths do dedupe:
profile sync indexes existing games by date per rival (js/app.js:6420) and the
WhatsApp importer builds an `existingByRivalDate` set and reports duplicates
in its preview (js/app.js:6813). The paste path is the odd one out, not a
deliberate design.

Nothing downstream can undo it. A game record carries no notion of "already
counted", and every aggregate is correctly id-agnostic, so the duplicate is a
second real day to all of them. Measured blast radius, all pinned in
`tests/stats.test.js` under "repeat paste":

- `periodRecords` counts the day twice in the week/month total AND in the
  per-rival split (a real 1-1 week reads 2-1, 66.7%).
- `runningRivalPeriodRecords` can flip which way a period went: one win
  duplicated against two losses turns a lost week into a 2-2 tied one, so the
  rival row's "(won-lost-tied)" gains a tie nobody earned.
- `streaks` reads a single win as W2, and `longestMine` inflates with it.
- `rivalryScoreFromGames` doubles (volume confidence is `min(1, n / 10)`, so
  the duplicate buys a real confidence step: 10 becomes 20).
- `myAvgByContinent` is immune: it already takes one qualifying game per date.
- The predictions distribution is immune too, but only because
  `computeFinishPositionRecords` (js/app.js:1632) folds the log into a Map
  keyed by date then rival id before calling `accumulateFinishPositions`.

The guard belongs in `saveDay`, so none of those tests are marked todo: they
document what the stats layer reports for the input it is handed.

## Geo data exists only on MapTap-synced games

`cities` (5 entries of `{ lat, lng }`) is written by the profile-sync path.
Games created from a manual paste have no `cities` key at all, and older
records may carry totals only (`myScore`/`theirScore`, no per-round array).
Every continent aggregate therefore starts by requiring
`Array.isArray(g.cities) && g.cities.length === N_LOCS` plus a matching
`myScores` array, and the UI hides its whole band or section rather than
render an empty shell.

**Known defect, null coordinates become Africa.** `myAvgByContinent` classifies
with `classify(Number(c.lat), Number(c.lng))` (js/stats.js:726) and
`classifyContinent` rejects coordinates with `Number.isFinite`
(js/app.js:6153). `Number(null)` and `Number('')` are `0`, not `NaN`, so a
coordinate-less city arrives as the valid point (0, 0), lands inside Africa's
`lat -35..38 / lng -20..52` box (js/app.js:6168), and is averaged into the
Africa chip and its round count instead of being dropped as `'Unknown'`.
`{}` and `'nope'` DO coerce to `NaN` and are dropped, which is why the shape
of the bad data decides whether the round disappears or lies.

The fix belongs at the coercion, not at the classifier: once a `null` has
become `0` no bounding-box table can tell it from a genuine Gulf of Guinea
round (pinned by a test asserting the two produce an identical band). Both
writers the app owns are safe today (`roundsFromRoundData` runs `Number()`
over the raw fields and `roundsFromRounds` writes `NaN` outright), so this
needs hand-built or imported `cities` to surface. Regression test:
`tests/stats.test.js`, marked `{ todo: 'KNOWN DEFECT: ...' }` so it flips to a
pass the moment the coercion is fixed.

The classifier stub in `tests/stats.test.js` copies the real Africa box
verbatim for exactly this reason. Before 2026-08-15 the stub answered
`'Unknown'` for anything it did not like, which made the null case look
handled; a stub that cannot express the defect is worse than no test.

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
keeps the bucketing tests about bucketing.

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

## What the unit tests reach, and what they structurally cannot

`tests/stats.test.js` and `tests/network.test.js` `require()` the two dual-
export modules directly. `js/app.js` is one big IIFE with no exports, so
NOTHING in it can be loaded from node, at any effort, without changing
production code. Everything below is therefore outside unit-test reach and is
covered only by browser probes and the `.features/` human plan: the paste
panel and `saveDay`, `classifyContinent` and its bounding boxes, the per-rival
`continentBreakdown`, `locationStats` / `carryChoke`, the predictions card
assembly, the WhatsApp importer (including `dayBucketDate`'s year
compensation), export/import, the MapTap sync merge, the network Firestore
calls, and every render path.

Where a defect lives in app.js but is *visible through* a pure function's call
contract, the test file states the contract in a comment and stubs the app.js
side faithfully rather than conveniently (see the classifier stub above). Tests
that assert the CORRECT behavior of a defect that is still shipped carry
`{ todo: 'KNOWN DEFECT: <summary>' }`: `node --test` reports a failing todo as
expected and keeps the exit code at 0, so the defect ledger lives in the suite
without breaking CI. Three are open today (2026-08-15): the null-coordinate
Africa bucket, and two `'__proto__'` player-key cases below.

`positionHitsForDay` and `accumulateFinishPositions` accumulate into plain
`{}` objects keyed by rival id. `uid()` (js/app.js:191) can never produce
`'__proto__'`, but `importData` (js/app.js:7038) assigns `state.rivals` and
`state.games` verbatim from a user-supplied backup with no id validation, so a
hand-edited backup can. `out['__proto__'] = <boolean>` is silently discarded
and `out['__proto__'] = <object>` sets the accumulator's prototype: the player
vanishes from the figures, and in `accumulateFinishPositions` the day's field
size collapses to 1, so every OTHER player's share divides by zero and comes
out `-Infinity`. Low severity, cross-player blast radius; fix with
`Object.create(null)` or a Map.

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
