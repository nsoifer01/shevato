# MapTap Rivals - engineering findings

Living document: the current best understanding of how this app behaves and
where it bites. Rewrite sections rather than appending to them.

## The game log stores a day once per rival

`maptapRivalsGames` holds one record per (day, rival) pair. A day played
against 3 rivals is 3 records that repeat the **same** `myScores`; only
`rivalId`, `theirScores` and `id` differ.

Consequences for anything that aggregates *my* side:

- Per-rival stats can iterate the log freely, since each rival sees its own
  records only.
- Anything cross-rival must dedupe by `date` first, or my rounds get counted
  once per rival. `myAvgByContinent` (js/stats.js) takes one qualifying game
  per date, first wins. Without that, a 3-rival day reports 15 rounds instead
  of 5. The averages themselves barely move (the duplicated rows carry
  identical scores), so the skew is invisible without a unit test: the round
  counts, and any weighting derived from them, are what break.

The same shape is why the log's SIZE grows as days x rivals, which is what
broke cloud sync - see the next section.

## The day's geography is stored once per day, not once per row (2026-08-31)

**The incident.** "Sync all rivals" over 9 rivals pulled 383 new games and
then could not persist them. The sync layer refused the write three times,
each attempt larger than the last:

```
Failed to flush writes for maptapRivalsApp:
Error: Refusing to flush maptapRivalsApp: payload ~760810B exceeds 716800B
```

**Root cause.** `cities` - the day's 5 puzzle locations as
`{ lat, lng, name }` - is a property of the DATE. MapTap plays the same five
places for everybody on a given day; the code has always known this
(`mergeMapTapSync` takes `syncCities(mine) || syncCities(theirs)`, either
side will do, and `computePositionHitRecords` builds a one-entry-per-date
`citiesByDate` map). But the log keys on (date, rival), so the array was
stored once per rival per day. Measured on the real shape:

| | inline `cities` | normalised |
| --- | --- | --- |
| bytes per row | ~500 B | ~215 B |
| 9 rivals x 172 days | 691 KB | 343 KB |
| 9 rivals x 365 days | 1468 KB | 729 KB |

57% of everything the app persisted was the same geography written nine
times, and the marginal cost of a tenth rival was another full copy of it.

**The fix.** `KEY.DAYS` (`maptapRivalsDays`) holds `{ 'YYYY-MM-DD': City[5] }`
and the game rows carry no `cities` on disk. The split is entirely at the
storage boundary - `splitGameCities` on the way out, `joinGameCities` on the
way back in - so `state.games` in memory, every renderer, every aggregate and
every exported backup see exactly the shape they always did. That is what
kept a change this wide from touching ten read sites.

Things worth knowing about it:

- **Hydration shares the array by reference** across every row of a day. Safe
  because `cities` is read-only everywhere: `mergeMapTapSync` reassigns with
  a fresh `slice()` rather than mutating in place. It is also what makes a
  1800-row log cheap in memory. If you ever mutate `g.cities[i]`, that
  assumption is what you broke.
- **A row whose geography disagrees with the day keeps its own copy inline.**
  Nothing produces that today, but normalising over a disagreement would
  silently rewrite one of the two, and no fix for a size problem is allowed
  to lose a byte of history. The comparison is made on the values as they
  will be STORED (non-finite coordinates read as `null`, which is what
  `JSON.stringify` writes): the iOS 4.04 payload shape has city names but no
  lat/lng, so freshly synced rows carry `NaN`, and `NaN !== NaN` would have
  reported two identical days as different and left the duplication in place
  for exactly those days.
- **The stored map is read through `Object.entries` into a `Map`.** Dates
  arrive verbatim from a synced payload; reading `obj['__proto__']` back off
  a plain object hands out `Object.prototype`. Same reasoning as
  `mapTapHistoryToRounds`.
- **Migration runs at boot AND on every remote delivery** (`migrateInlineCities`
  in js/app.js). Boot alone is not enough: the pre-migration Firestore
  document wins the first snapshot of a session (remote wins on a fresh local
  revision map), so the fat copy lands back in localStorage right after the
  boot rewrite. Normalising on arrival is what makes the account converge.
  It is idempotent - afterwards no stored row carries `cities`, so the check
  is false and nothing is written.
- **Losing the day map costs geography, never games.** The two keys are
  independent revisions under per-key last-write-wins, so one can be dropped
  (see the site-level "sync is per-key LWW" finding). A game row survives
  intact without its geography, the continent band just goes quiet for those
  days, and the next MapTap sync backfills them (`mergeMapTapSync` counts
  that as `backfilled`). The map is grow-only and keyed by an immutable fact,
  which is what makes it safe to carry as a second key at all.

**Normalisation halves it; it does not make it unbounded.** 9 rivals x 365
days is still 729 KB normalised. The other half of the fix is in the sync
layer - see the next section.

## The sync layer stores an oversized value out of line (2026-08-31)

`storage-sync-robust.js` wrote one Firestore document per namespace, and
Firestore caps a document at 1 MiB. Any app whose data grows with use walks
into that, and the old guard (`MAX_FLUSH_BYTES`, 700 KB) turned it into a
hard wall: past that size the app could never sync again.

Raising the cap would have been the same architecture with a later failure
date, so instead a value past `MAX_INLINE_VALUE_CHARS` (128 K) is written as
an ordered run of part documents under `users/<uid>/apps/<ns>/chunks/`, with
a small manifest left inline:

```js
data[key] = { chunked: true, parts: N, rev, updatedAt, hash }
```

Details that matter if you touch it:

- **Parts are written before the manifest.** A peer whose listener fires
  between the two writes must never find a manifest pointing at documents
  that do not exist yet; in that order it simply reads the previous version.
- **The read verdict is taken from the manifest, before any part is
  fetched.** Firestore re-emits the whole document on every listener
  re-attach, and the manifest carries the same `rev`/`updatedAt`/`hash` an
  inline entry would, so `decideRemoteChange` short-circuits identically.
  Without that, every tab focus would refetch a megabyte and re-render every
  view.
- **Reassembly funnels back into `applyRemoteChange`.** Conflict resolution,
  the echo lock, the revision bookkeeping and the `localStorageSync` dispatch
  must not fork per storage format.
- **Splitting never lands inside a surrogate pair.** Firestore stores UTF-8;
  a lone surrogate does not survive the round trip and `JSON.parse` of the
  rejoined string would throw. Every app here stores emoji.
- **No rules deploy was needed.** The recursive
  `match /users/{userId}/{document=**}` in `firestore.rules` already grants
  the owner read/write over everything beneath their own user document.
- **Backward-compatible both ways.** A document written before this exists
  carries no `chunked` flag and reads as a plain inline value; a value that
  shrinks back under the threshold returns to inline storage and its parts
  are deleted.

`MAX_FLUSH_BYTES` stayed at 700 KB deliberately. After chunking no single
entry can reach it, and a flush carrying several keys is split across
commits (`planFlushBatches`) rather than refused - safe precisely because the
write is a `merge: true` of independently revisioned keys.

## A deterministic write rejection is not retried (2026-08-31)

The incident's second half: the flush was refused, `requeueFailedWrites` put
the batch back, and the retry ladder resent it - while "Sync all rivals" kept
appending games to the same key. 760810 B, then ~890928 B, then a silent give
up. Three network round trips spent on a write that could not possibly land,
and each one bigger than the last.

`isPermanentWriteError` (sync-helpers.mjs) now splits the two cases. Our own
`payload-too-large` and Firestore's `invalid-argument` are deterministic: the
batch is dropped, the ladder is not started, and a `syncWriteRejected`
DOM event names the namespace and keys so the failure is not console-only.
Everything else - `unavailable`, `deadline-exceeded`, an unrecognised code -
keeps the retry behaviour it always had, so this cannot turn a recoverable
blip into a permanent one.

## A sync walks BOTH histories, so one-sided days go both ways (2026-08-24)

`mergeMapTapSync` (js/stats.js) is the whole merge, pure and unit-tested; the
DOM half in `syncMapTapForRival` only fetches, calls it, and paints. It walks
the **union** of the two players' MapTap histories.

Before 2026-08-24 it walked the rival's dates only (`for (const date of
Object.keys(theirsByDate))`, with `if (!theirs) continue`). Days the rival
played and the user didn't were recorded; days the **user** played and the
rival didn't produced no row at all. Nothing downstream was wrong - the log
simply never learned that the user had played. What the owner saw:

- Today's predictions read `PRE-GAME` with my Actual column blank, i.e. "you
  haven't played yet", on a day I had played and no rival had.
- The day was missing from History and from every rival's games table.
- `myProfileRounds()` derives my per-round history from the game log, so a
  solo day also fed nothing to the predictor.

The three rules the merge holds to, in both directions:

1. A day only one side played stores only that side. Never write a 0 for the
   absent player - `iPlayed`/`theyPlayed` key off the field being *present*,
   and a zero would read as a 900-0 blowout in every record.
2. A one-sided row upgrades **in place** when the other side's history catches
   up. The row keeps its id, so a rival playing at 8pm turns this morning's
   me-only row into a head-to-head rather than adding a second row for the day.
3. A side already stored is never cleared by a pull that lacks it. MapTap
   gains days, it never loses them, so an absent side means "no news", not
   "didn't play". Rows the user typed (any note but `synced from MapTap`) keep
   their scores entirely; they still get `cities` backfilled, which is additive.

**Cost, and why it is accepted.** A me-only day is written once per rival, so
N rivals means N near-identical rows for that day (my score, no rival score).
That is the same shape the log already had - a day three rivals played and I
did not was already three rows - and every cross-rival aggregate already
dedupes by `date` for exactly this reason (see the section above). It does
mean the log grows faster for someone who plays far more often than their
rivals do; `maptapRivalsGames` syncs as a single Firestore document, so that
is the number to watch if sync ever starts failing.

**Trap found while doing it.** Both sides are indexed by date, and dates come
verbatim from a remote payload. `theirsByDate['__proto__']` on an object with
no such own key returns `Object.prototype` - a *truthy* "day" with no `scores`
on it, which crashed the walk on `.slice()`. The merge converts both payloads
to `Map`s up front. The pre-2026-08-24 loop had the same latent crash on the
`mine` side; nothing had ever fed it that date.

## "Sync all rivals" reports the run; the per-rival pills cannot (2026-08-24)

Each rival card gets its own status pill (`setRivalSyncStatus`) that clears
itself after 5 seconds. Over a five-rival run that is useless as a report: the
first pills have faded before the last rival finishes, and "nothing was stale"
looks identical to "nothing happened".

So `syncMapTapForRival` now RESOLVES to its outcome - `{ ok, added, updated,
backfilled }`, `{ ok: false, error }`, or `{ skipped: true }` when that rival
was already mid-sync from its own button and nothing was attempted - and
`syncAllRivals` totals them through `syncAllSummary` (pure, exported via
`window._testExports`). Two states render on the profile card, which is where
the button is:

- while running: `Syncing 2/5…` on the button, `Synced 2 of 5 rivals · now
  Bex…` under it. The counter is repainted BETWEEN rivals, so it always reads
  "how many are finished", never "how many have been started".
- after: `✓ Synced all · 5 rivals synced · 12 new games · 2 already up to
  date`, warn-tinted if some rival failed, err-tinted if all did. Two rules
  keep it from over-claiming: the counts describe what SYNCED, not what was
  attempted (a run where every rival failed opens with "2 rivals failed", not
  "2 rivals synced"), and a run with any failure in it spells the up-to-date
  count out instead of saying "all already up to date", which would read as a
  clean bill of health.

It deliberately does NOT self-clear: it is the only place the run's totals
exist, and the state is in-memory, so a reload drops it. The line is a
`.profile-status-line`, which is one of the few children the compact
(collapsed) card keeps visible - `.profile-info`, `.profile-hint` and
`.profile-meta-line` are the ones `.is-compact` hides.

Still native `alert()`: the "no rivals have a MapTap username yet" path. It is
close to unreachable, since the button is disabled at zero targets.

Known limitation, unchanged by this round: `renderProfileCard` rebuilds its
whole action row, and a sync-all run renders it twice per rival, so a keyboard
user who presses Enter on the button loses focus to `<body>` on the first
render and never hears the progress line. Restoring focus is not enough on its
own - the button carries `disabled` while the run is in flight, and a disabled
button cannot hold focus - so the fix is `aria-disabled` plus a no-op handler,
which is a bigger change than this round asked for.

**Harness trap.** The app POSTs `application/json` to `getPublicProfile`, so
the browser preflights it. A CDP `Fetch.fulfillRequest` stub that answers only
the POST, with `Access-Control-Allow-Origin` but no
`Access-Control-Allow-Headers: Content-Type`, fails CORS on the OPTIONS and
every rival reports a failure that is purely the harness's. Answer the
OPTIONS with 204 and both headers. Second trap: locally fulfilled responses
land in about a millisecond, so the progress states flash past unobservably -
`e2e/quality.mjs` wraps `window.fetch` in a delay and records the label
sequence with a `MutationObserver` rather than trying to sample at the right
moment.

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
  from a backup) are NOT pruned, on purpose: the app never silently deletes
  rows the user can see and delete themselves. The upsert updates the first
  match and leaves the rest. Measured behaviour of such a pair (two records,
  same rival, same date): `overallRecord` reports `games: 2, wins: 2, days: 1`
  - the W-L-T tally counts both records, the DAY-based figures dedupe by date
  (`myAvgByDay`, the heatmap, `myAvgByContinent`, the predictions
  distribution). That split is deliberate, not a rounding accident: a day is a
  calendar fact, a game row is a stored record. `tests/stats.test.js`
  ("repeat paste") pins the stats-layer behaviour.

The upsert is unit-tested through the `window._testExports` seam
(`tests/app-helpers.test.js`) and at browser level (the repeat-paste check in
`tests/browser/suites/apps.mjs` asserts one record with the corrected
scores).

## Geo data exists only on MapTap-synced games

`cities` (5 entries of `{ lat, lng, name }`) is written by the profile-sync
path. In memory it hangs off the game; on disk it lives once per date in
`maptapRivalsDays` and is re-attached on load (see "The day's geography is
stored once per day"). Games created from a manual paste have no `cities` at
all, and older records may carry totals only (`myScore`/`theirScore`, no
per-round array).
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

## Dialogs live above the shared site chrome (fixed 2026-08-23)

The site's stacking ladder, and where this app sits on it:

| z-index | what | where |
|---|---|---|
| 9000 | back-to-top button | `assets/css/back-to-top.css` |
| 10001 | fixed `#header` | `assets/css/main.css` |
| 10002-10004 | skip link, slide-out `#menu`, sign-in / sign-out / delete-account dialogs | `main.css`, `firebase-auth.css` |
| **10010** | **every `.modal` in this app** | `css/styles.css` |
| **10020** | **`.share-toast`** | `css/styles.css` |
| 10100 | offline banner | `assets/css/sync-status.css` |

App styles must not restyle shared chrome, so the app layer rises rather than
the header dropping; 10010 is the number fpl-planner's player drawer already
uses for the same reason, which keeps one ladder across the site. The five
dialogs (`rival-modal`, `delete-rival-modal`, `delete-game-modal`,
`clear-games-modal`, `wa-modal`) all hang off `.modal`, and both `.modal` and
`#header` are children of `<body>` with no stacking context in between, so the
comparison is direct.

Until 2026-08-23 `.modal` was `z-index: 100` (from the app's first commit,
`0bf855c`). The header strip therefore stayed lit above the backdrop and
`document.elementFromPoint(5, 5)` returned the site `logo`: a click at the top
of the screen NAVIGATED AWAY from the app with the dialog still open. No data
was lost, which is why it survived so long; the 2026-08-22 audit saw a
"backdrop click closes" probe fail up there and mis-attributed it to the probe.

The `.share-toast` correction shipped with it: the base rule said 9999 and a
later rule added in the 2026-08-22 pass re-declared it as 2000, silently
LOWERING the toast under the header. It went unnoticed because the toast sits
at the bottom of the viewport. There is now one declaration (10020, on the base
rule) and the later block carries only the `pointer-events: auto` that
actionable toasts need; do not re-declare the z-index there.

### A route change closes open dialogs (fixed 2026-08-23)

Raising the dialog layer exposed a second, older defect. `applyUrlHash` is the
single route entry point (init and the `hashchange` listener both call it), and
it re-rendered the view UNDER whatever dialog was open. Reach it with browser
Back/Forward, a hand-edited URL, or a restored tab: the rival editor would sit
over a different rival's page still holding the FIRST rival's name, colour and
icon, and Save would write to the rival the user was no longer looking at.

Invisible before the stacking fix, because a dialog at z-index 100 did not
block the page beneath it - you could simply click past it. It also silently
broke the audit's own network probe, whose delete sequence had been passing
only because a stale dialog let clicks through to the page.

`applyUrlHash` now calls `closeAllModals()` first, which routes each open
dialog out through its OWN closer (`modalCloser(id)`), not bare `closeModal`,
so editing state, the WhatsApp draft and any pending delete are cleared too.
Add a dialog and `tests/stacking.test.js` fails until `modalCloser` has a
branch for it.

Two layers of regression cover this:

- `e2e/quality.mjs` pins the behaviour by hit-testing, not by screenshot: for
  each of the five dialog types it asserts `modalZ > headerZ`, that
  `elementFromPoint` at the header strip AND at the logo's own centre lands
  inside the modal, that no `#header` descendant is reachable, and that the
  panel wins over its own backdrop, at 1280 and at 390. A real coordinate
  click over the logo must leave `location` unchanged. Computed z-index alone
  would not catch an ancestor stacking context swallowing the raise, which is
  the failure mode worth guarding.
- `tests/stacking.test.js` is the cheap half, so a regression also fails in
  `npm test` on every PR rather than only in the slower browser job. It parses
  the SHIPPED stylesheets (app, `main.css`, `sync-status.css`) instead of a
  hardcoded table, so raising `#header` in the shared chrome fails here too;
  it asserts `.share-toast` declares its z-index exactly once; and it pins the
  `closeAllModals()` call and a closer per dialog id. Every guard here was
  proven to fail against the pre-fix code before being kept.

## "Path to parity" counts future wins, not rewritten history (fixed 2026-08-23)

The rival page's parity card used to report `ceil((losses - wins) / 2)` and
call the result "flipped results to reach parity". The arithmetic answers a
real question - how many PAST losses would have to be rewritten as wins for
the record to even out - but that is not a thing a player can do, and nobody
reads it that way. At 26W/128L/1T it said **"Need 51 flipped results"** when
the honest answer is **"win your next 102"**.

The halving is the whole bug: rewriting a past loss moves the gap by TWO (one
off the losses, one onto the wins), while a future win moves it by ONE. So the
old figure was exactly half the distance a player actually faces.

`parityOutlook(record)` in js/stats.js is now the single source for this, and
it is total rather than only defined when behind:

| Record | Card |
|---|---|
| 26W · 128L · 1T | Path to parity - "Need 102 more wins to even the record" |
| 9W · 10L | Path to parity - "Need 1 more win to even the record" |
| 64W · 64L · 3T | Record balance - "The record is even" |
| 0W · 0L | Record balance - "No decided games yet" |
| 12W · 5L · 2T | Record balance - "Ahead by 7 wins" |

Notes that matter:

- **Ties never move the distance.** A tie is neither a win nor a loss, so it
  cannot close the gap; it is still printed in the record line so the sub-text
  adds up to the games played. `4W/9L` needs 3 more wins whether there are 0
  ties or 100.
- **Never a negative or fractional ask.** `winsNeeded` is `max(0, losses -
  wins)` over floored, non-negative counts, and the tests sweep every
  0-20 x 0-20 record asserting `wins + winsNeeded === max(wins, losses)`.
- **The title changes with the state.** "Path to parity" only describes the
  behind case; even and ahead render under "Record balance". A single title
  would have to lie in two states out of three.
- **This is W/L parity, not a 50% win rate.** They differ once ties exist: at
  26W/128L/1T, 102 more wins gives 128W/128L/1T (even record, 49.8% overall),
  and 103 gives exactly 50.0%. The card is about the record, and says so.

The figure appeared in exactly one place; there is no second copy to keep in
step. `tests/stats.test.js` covers the five reported cases plus junk input,
and `e2e/quality.mjs` pins the rendered card - text, tone class and that it
fits its column without clipping - at 1280 and 390 for behind, even and ahead.
Both were proven to fail against the old halved figure before being kept.

## Deliberate behaviour, not open defects

Collected so a future audit does not re-file them. Each was verified, judged
and kept as-is:

- **Duplicate `(rival, date)` rows are never auto-pruned.** See the paste
  section above for the measured split (two games, one day). The app does not
  silently delete rows a user can see and delete themselves; the same rule is
  why History still lists orphaned games.
- **A stale rival id in the saved matrix selection is left alone.**
  `confirmDeleteRival` prunes the deleted id from `state.matrixSelection`, but
  only on the device that did the delete: the rival list and the selection sync
  under separate keys, so another device can boot with a selection naming a
  rival that is gone. `matrixRivals()` filters the selection THROUGH
  `state.rivals` rather than trusting it, so the stale id is inert. Pruning it
  on load would let one device's delete quietly rewrite another's saved view.
  Pinned in `e2e/quality.mjs`.
- **Orphaned games (rival deleted elsewhere) stay in History.** They are
  excluded from every aggregate by `eligibleH2HGames` and shown in History
  with their delete button, so a stranded row is visible and removable rather
  than invisible. Auto-pruning would let one device's delete destroy another
  device's data under per-key last-writer-wins sync.
- **Rival deletion has Undo, not a recycle bin.** `confirmDeleteRival` keeps an
  in-memory `state.lastDeletedRival` snapshot (rival, its games, its index in
  the list); the toast offers Undo for 8s and `undoDeleteRival` splices the
  rival back at its original index, re-appends the games and re-links the
  network pair. The snapshot is memory-only, so it does not survive a reload.
  A persistent trash would be a second storage key to sync, reconcile and
  garbage-collect for an action that already asks for confirmation and shows
  the rival's name and game count before it happens.
- **The shared auth modal stays light-themed.** `assets/css/firebase-auth.css`
  pins `color-scheme: light` for a Chrome-autofill reason; theme it
  accent-only, scoped, and never darken it.

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

Since 2026-08-24 `_testExports` also carries `syncAllSummary`, and the MapTap
sync merge itself moved into `js/stats.js` as `mergeMapTapSync` (pure, `makeId`
and `now` injected the way `sanitizeBackup` takes `makeId`), so both halves of
the sync round are covered in `npm test` rather than only in a browser.

Still outside unit-test reach: the paste panel DOM flow around `saveDay`,
`locationStats` / `carryChoke`, the predictions card assembly, the fetch half
of the sync (`syncMapTapForRival`), the network Firestore calls, and every
render path. Since 2026-08-22 the WhatsApp parser (`js/whatsapp.js`), the
backup validator and the date helpers are pure and unit-tested, and
`e2e/quality.mjs` covers the rendered paths the audit found broken (seeded
axe at 1280 and 390, keyboard reachability, modal focus, delete/Undo,
paste-date reset, refused imports,
WhatsApp formats, overflow at 390/1100, and since 2026-08-23 the dialog
stacking block); the `.features/` plans hold the rest.

Two gaps the 2026-08-23 pass closed, both in `e2e/quality.mjs`:

- **Every breakpoint, not just the ends.** The overflow sweep runs six views at
  390, 480, 768, 1024, 1159, 1160 and 1280, so the 1159/1160 pair that brackets
  the continent band's grid switch is checked from both sides.
- **A positive-UTC RENDERED page.** A second page runs under CDP's
  `Emulation.setTimezoneOverride` at `Pacific/Auckland` (UTC+12) and asserts
  the day tabs start at Today, the summary counts today's game, and the
  heatmap ends on the browser's own local day. Use the CDP override, NOT the
  `TZ` env var: snap-confined Chromium ignores `TZ`, so the audit's Berlin
  probe silently ran in the host zone and only its own precondition check
  noticed. The probe asserts the zone took effect before trusting anything
  else. The helpers themselves stay pinned by the four-zone child-process test
  in `tests/stats.test.js`, which is date- and host-independent.

`e2e/quality.mjs` is 126 checks and is PINNED in `tests/browser/run.mjs`
(`EXPECTED_CHECKS`), the only app-owned suite that is. Two reasons it needs the
pin: a suite that returns early "passes" everything it did run, and since
2026-08-23 an axe scan that exceeds the driver's 45s send timeout records its
own FAIL instead of unwinding to the outer catch. Containing the throw keeps
one slow scan from dropping the other 50-odd checks (it turned a run into
19-of-71 on a loaded machine), but it also means a shrunken run would look
green without the pin. Change the number in the same commit as the checks.

Two separate causes were behind the aborts this suite kept hitting, and only
one of them was environmental:

- **Contention.** Several Chromium instances from other checkouts on the same
  box slow every CDP round trip. Do not raise the shared 45s timeout in
  `tests/browser/cdp.mjs` to chase it: that value bounds every suite in the
  repo and a real hang should still fail. Two runs of `tests/browser/run.mjs`
  at once also share CDP 9222 and poison each other; wait one out.
- **`goto()` on a fragment-only URL, which was the real one.** `Page.navigate`
  to a URL differing only in the hash is a SAME-DOCUMENT navigation, so
  `Page.loadEventFired` never arrives and `goto` waits out its full 20s guard.
  At ~16 view changes that is over five minutes of dead wait, and a session
  kept alive that long starts timing out its own `Runtime.evaluate` calls -
  which is why the aborts moved around and looked random. The suite now uses a
  local `hashTo()` that assigns `location.hash` in-page. Faster, and it drives
  the REAL `hashchange` route rather than a synthetic navigation, so it also
  exercises the dialog-closing fix above. Reserve `goto()` for genuine
  cross-document loads (the seed page, the first app load).

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
`{ todo: 'KNOWN DEFECT: <summary>' }`; as of 2026-08-23 the maptap suites
carry ZERO todos and ZERO skips. The three that once existed (null-coordinate
Africa bucket, two `'__proto__'` player-key cases) were fixed on 2026-08-15
and their tests flipped to plain regressions, and nothing has been added
since: there is no shipped defect this suite is asserting around.

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

## The heatmap walk broke in DST-at-midnight zones

`buildHeatmapWeeks` was the last date walk still using a local `Date` and
`setDate()`. In every zone whose DST change happens AT midnight
(America/Santiago, America/Havana, Asia/Beirut, Atlantic/Azores, Africa/Cairo)
the cursor lands on 01:00 on the spring-forward day and stays an hour ahead for
the rest of the year, so `cur <= end` is false on the last day and TODAY never
gets a cell. Measured over a year of weekly samples: Santiago failed 51 of 52,
Havana 25, Beirut 22, Azores 22, Cairo 19. The existing timezone tests all pin
zones whose DST changes at 02:00 or 03:00 (Chicago, Jerusalem, Kiritimati,
Berlin, Auckland), which is why they passed.

It now snaps to Sunday with `dayOfWeekISO` and walks with `addDaysISO`, both
timezone-free, matching the rule the rest of the app already follows. All 16
sampled zones now report 0 of 52 failures.

## "10 August 2026" was filed on August 20

`parseMapTapScore` tries the Month-Day regex before Day-Month, and its day
group `(\d{1,2})` was unbounded on the right, so a Day-Month-YEAR line bound
the month's day to the first two digits of the year. MapTap's own share writes
"Aug 10", which is why every canonical fixture passed; the WhatsApp importer
feeds arbitrary chat lines to the same function. The day group is now bounded
on both sides with `(?!\d)`.
