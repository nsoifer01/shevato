# Rising Shows - engineering findings

A living document: best current understanding, not a diary. See the
repo-root `CLAUDE.md` for the convention.

## Data loading architecture (2026-08-15 lazy-extras redesign)

**The app fetches exactly one dataset file at boot: `data-index.json`.**
Nothing else. The old flow ALSO fetched `data/show-modal-extras.json`
(67.5 MB raw, ~21.5 MB wire) "in the background" right after the grid
rendered, which meant ~102 MB raw pushed at every visitor whether or not
they ever opened a modal (TESTING-AUDIT.md defect 30). Measured over a
local no-gzip server (CDP Network events, cache disabled):

| | boot bytes | first modal open |
|---|---|---|
| before | 103,506,487 (extras 64.4 MB + index 32.75 MB + ~1.6 MB code) | 4,495 (detail file) |
| after | 35,978,695 (index + code only) | 10,023 (detail file incl. extras) |

How: `scripts/split-data.js` now reads `data/show-modal-extras.json`
(when present beside `data.json`, which it always is in `build:site`
because `fetch-data.js` runs first) and merges each series' slice -
`cast`, per-season `ov`, per-episode `eps` map - into that series'
`data/detail/<seriesId>.json`. It stamps `extrasInDetail: true` into the
index; `js/app.js` treats that flag as a contract never to fetch the
monolith (`loadExtrasOnce()` early-returns on it). `ensureDetail()`
applies `detail.cast` / `sRec.ov` / `sRec.eps` alongside the episodes,
so a modal renders complete on first open from one ~10 KB fetch.

**Legacy fallback, kept deliberately:** against artifacts split before
the merge existed (index without the flag) or an unsplit `data.json`
served as the index, `loadExtrasOnce()` fetches the whole monolith - on
first modal open only, never at boot. The re-render-in-place logic
(reopen the visible modal via `fromHistory: true` once extras land)
belongs to that path.

**Pipeline contract, unchanged:** artifact NAMES and the release
(`rising-shows-data`: `data.json.gz` + `show-modal-extras.json.gz`) are
untouched. `data.json` and `show-modal-extras.json` are still built and
uploaded exactly as before; `build-show-pages.js` still reads both.
`data-index.json` + `data/detail/*` remain deploy-time build artifacts
(never on the release, never in git). If the extras file is absent when
split-data runs, output is byte-identical to the pre-merge format (no
flag, plain detail files) - pinned by tests.

**Perf budget now counts the dataset.** `tests/browser/suites/perf.mjs`
used to exclude rising-shows dataset URLs from the byte budget as a
workaround; boot data is now intentional and bounded, so the budget is
code + index (52 MB against 35.98 MB measured, ~45% headroom) and an
eager-extras regression (+67 MB) trips it. Clean clone (no dataset)
measures ~1.6 MB and passes.

**Index slimming was considered and rejected** (2026-08-15): no field of
`data-index.json` dominates (largest is `poster` at 8%), and nearly all
27 per-match fields feed the grid/filters/sort. Stripping the few
marginal ones (`confidence`, `driftNote`, `firstRating`/`lastRating`)
would save under 4 MB raw (much less compressed) against real breakage
risk in buildShowAgg's dual-shape contract. The 34 MB raw index is
~4.3 MB brotli in production.

## Shapes and unfinished seasons (2026-08-22)

Every detector treated the last RATED episode as the finale, and
`tagSavedBestForLast` treated the highest-numbered season as the final
one, so a show three episodes into a new season was being told it had a
"big finale" or "saved the best for last". 98 big-finale and 61
bad-finale tags sat on partial 2025-26 seasons; 360 multi-season shows
had a whole-run shape that hinged on one.

A season is now flagged `inProgress` when it is the series' highest
numbered season, it still had an episode RATED this year, and either (a)
`title.episode.tsv` lists an episode numbered after our last rated one
(374 seasons), or (b) IMDb lists no more episodes than we have ratings
for and it has under 60% of the PREVIOUS season's rated episodes (35
more). 409 seasons in total, every one of them a 2026 season. An in-progress season
never receives big-finale, bad-finale or u-shaped, its series is skipped
by both series-level tags, and `deriveShowShapes` takes an optional
4th options arg so the whole-show trajectory is not labelled off it
either (the 3-arg call still means "finished").

The recency test is anchored on the season's LATEST rated episode, not on
`seasonYear`, which is its earliest. Anchoring on the earliest was this
rule's one real defect, found in the pre-merge closeout: a 2025 season
that finished in 2025 satisfies `seasonYear >= buildYear - 1` for the
whole of 2026, so any such season with an unrated tail (most of them,
since nobody rates the finale of an obscure show) was called "still
airing" all year. That was 223 demonstrably finished seasons of the 747
then flagged, 102 of which lost a label they had earned. Switching to the
latest rated year drops all 223 and keeps 51 of the 51 flagged seasons
whose own episodes clear 50 votes. The residual cost is one well-rated
season (Cooper & Fry S1, 4 rated of 8 listed, last rated episode 2025)
that is probably still airing and is no longer flagged: a season whose
newer episodes have no ratings yet is invisible to this rule. Rule (b)
gained its listed-count guard in the same pass, because a rated count on
its own reads a sparsely-rated long season as a short one (MasterChef
Australia S18: 17 rated of 60 listed).

Signals that were tried and rejected:

- **The listed-episode tail alone.** 5,960 seasons have one, going back
  to 1932; without the recency guard it means "IMDb knows about an
  episode we have no rating for", not "still airing".
- **Comparing to the median season length.** It flags shows that simply
  ended shorter (Criminal Minds S19, King of the Hill S15). Comparing to
  the PREVIOUS season flags neither and still catches Jujutsu Kaisen S3.
- **Finale votes far below the season median.** It flags 85 more seasons
  but misfires on complete seasons whose finale is merely newer (My Hero
  Academia S8, One Punch Man S3), which would strip labels from seasons
  that really did end.

Residual false negatives, by design and measured: a season IMDb lists
only up to the episode that has aired, when that is already >= 60% as
long as the previous season, stays unflagged; and so does a season whose
2026 episodes have not been rated yet (its latest rated year is still
2025). The second is the price of the precision fix above and costs one
well-rated season on this build.

Two related detector fixes shipped with it. `isBigFinale` rounded its
margin to 1 dp, which is right for 1-dp episode ratings but made the
effective threshold 0.05 when `deriveShowShapes` feeds it 2-dp season
averages (79 of 652 show-level big-finale shows led by under 0.1); it
now rounds at 4 dp. `isRising` accepted a perfectly flat curve while
`isDeclining` never did; it now needs one real increase, which is what
the chip's "kept climbing" copy claims (299 flat seasons, 58 shows).

Catalogue effect, measured by running master's classifier and this one
over the identical episode data (so the two differ only by these rules):

| shape | seasons before | after | show-level before | after |
|---|---|---|---|---|
| big-finale | 12,167 | 12,097 | 652 | 551 |
| bad-finale | 4,690 | 4,652 | 423 | 411 |
| u-shaped | 3,104 | 3,071 | 387 | 374 |
| rising | 2,905 | 2,606 | 3,238 | 3,180 |
| shape-drift | 1,654 | 1,599 | 1,654 | 1,599 |
| saved-best-for-last | 1,555 | 1,514 | 1,554 | 1,513 |
| consistent, declining, front-loaded, mid-peak, rebound, rollercoaster, slow-burn | unchanged | unchanged | unchanged | unchanged |

161 shows change dominant shape and 229 change their shape set at all.
The show-level big-finale drop is mostly not the in-progress rule: 79 of
the 101 are the 2 dp margin fix below.

## One definition of "avg episode" (2026-08-22)

The show modal computed an unweighted mean of the per-season averages
while `buildShowAgg` (cards, list rows, static pages, related-show meta)
used the episode-weighted mean, so a 3-episode season counted as much as
a 24-episode one. The two disagreed at 1 dp for 2,784 of 10,592
multi-season shows and flipped the Above-IMDb verdict for 162 (Master of
None read 7.97 on its card and 7.6 in its modal, 8.0 on its page).

`weightedAvgEpisode` / `seasonRatedFold` in `js/app.js` are now the only
implementation on the browser side, feeding the modal stats, the share
card, the share image and `computeShowRelated`. They fold
`ratedCount`/`ratingSum` when present (build-time truth that survives a
failed detail fetch) and per-episode ratings otherwise, skipping unrated
episodes. The modal's Above-IMDb pill reads the precomputed `aboveImdb`
list rather than recomparing, so rounding can never split the two
surfaces. Precision is 2 dp everywhere.

## Related shows: gates before ranking (2026-08-22)

One shared genre string used to be enough to qualify, and a shared shape
outranked everything else. That is how Survivor recommended Thomas &
Friends, King the Land (a Korean romance) recommended four anime, and
Would I Lie to You? recommended CoComelon Lane and a 101-vote web
series: they shared "saved best for last" and one genre word.

Three gates now run before ranking: animation matches animation (the
`Animation` genre), unscripted matches unscripted (`Reality-TV`,
`Game-Show`, `Talk-Show`, `News`), and series votes must be within 20x
either way. Ranking is genre overlap (capped at 3) first, then shared
shapes, then the gap distance, then popularity; the row still names the
shared shape.

Measured over a 608-show sample spanning the popularity range: no show
lost coverage (0 dropped below 4 results, the "N more" threshold), 583
of 608 changed their top four. Breaking Bad now leads with Mr. Robot,
The Wire, Ozark and Fargo; Would I Lie to You? with Mock the Week and
Have I Got News for You; Survivor with Australian Survivor and Naked and
Afraid XL. The evaluation harness lives in the session scratchpad and is
reproducible by loading `js/app.js` in the same vm sandbox the tests use
and running `computeShowRelated` over the real `data-index.json`.

## Accessibility patterns worth keeping (2026-08-22)

- **A `<th role="button">` is not a sortable header.** The role replaced
  the column-header semantics that `aria-sort` hangs off (9 critical axe
  violations). The pattern that works: `<th scope="col" aria-sort=...>`
  containing a real `<button>`.
- **Sorting rebuilds the table, so restore focus.** Activating a header
  destroyed the element the user was standing on and dropped focus to
  `<body>`; `handleFinderHeaderActivate` now re-focuses the same
  column's button after the render.
- **A control inside a control.** The show modal's season rows were
  `<li role="button">` containing the season's shape-pill buttons (30
  serious violations). The season number is now the real button, the
  `<li>` keeps a plain click handler for the convenience of clicking the
  row, and the pills are siblings.
- **`--muted-2` was below AA.** #6f7785 measures 3.77:1 on `--surface-2`
  and 3.26:1 on `--surface-3`; it is now #8b93a3 (5.52 / 4.76).
- axe (WCAG 2 A + AA) is clean across finder, list view, advanced
  drawer, show modal, season modal, compare overlay, changelog and the
  shortcuts popover at 1280 and 390.

## Layout gotchas (2026-08-22)

- **`overflow: hidden` on a table cancels `position: sticky` inside it.**
  The list view's horizontal scroller needed the rounding moved from the
  table to the wrapper before the sticky show-name column would stick.
- **The list table needs ~1,120 px** and the page pins
  `overflow-x: hidden`, so between 641 px (where the stacked mobile
  layout ends) and ~1,130 px the extra columns were not merely off
  screen, they were unreachable. It now lives in a focusable
  `.finder-table-scroll` region.
- **Above-the-fold budget.** The first show card started 920 px down at
  1280x900 and 1,099 px down at 390x844. After trimming the hero, making
  the 13-chip shape strip a single swipeable rail under 900 px, tightening
  the mood rail and moving the Kometa CTA below the grid: 720 px and
  644 px. Re-measure with the probe in the session scratchpad if this
  area is touched again.

## Two legitimate series counts (2026-08-23)

34,692 and 34,615 both describe the same build and neither is stale. 34,692 is
the number of distinct series in `data.json` / `data-index.json`, and the number
of static pages generated. 34,615 is what the Finder lists, because
`buildShowAgg` (finder-lib.js) drops a series with no numeric `seriesRating`.
Verified on the 2026-08-22 build: exactly 77 series, and the cause is the same
for all 77 (no season record carries a `seriesRating`; none of them is missing
votes or episodes instead). They are not lost anywhere else: 20 of 20 sampled
have their static page on disk, the A-Z letter pages link them, their pages
carry `noindex, follow` like every other non-curated page and correctly OMIT
the `aggregateRating` from the TVSeries JSON-LD rather than emitting a null.

Keeping them out of the grid is deliberate: the gap (`avgEpisode - showRating`)
is the Finder's headline metric and the show-rating filter, the gap-direction
segments and the hidden-gems rule all read `showRating`. A row with a blank in
that column cannot be sorted or filtered on the thing the app exists for.

## Shared compare links are read-only against storage (2026-08-23)

`applyPendingCompareIds` deliberately did not call `Compare.save()`, on the
reasoning that a link someone else sent should not overwrite the visitor's own
comparison. That held only until their FIRST edit: `add` / `remove` / `clear`
each call `save()`, which wrote whatever was in memory, i.e. the imported set.
Removing one show from a friend's link (the most natural first move) silently
replaced a set the visitor may have spent real time building, with no warning
and no undo. Confirmed in the browser before the fix.

Now `Compare.imported` is set when a link arrives AND the visitor already has a
different stored set. While it is on, `save()` is a no-op, so every edit is
in-memory only, the overlay carries a note saying so and naming how many shows
their own comparison still holds, and "Keep this comparison"
(`Compare.keepImported()`) is the single explicit action that adopts it. A
visitor with no stored set is not put in that mode, so a first-time follower of
a link keeps their edits as usual. Pinned by three tests in
`tests/app-features.test.js`.

## Escape steps back, it does not dump the stack (2026-08-23)

Only one modal is on screen at a time: drilling from a show into a season
CLOSES the show modal and opens the season one, with `modalViewHistory`
remembering the step. Escape used to read as "close the topmost thing", which
dropped a reader who had drilled in two levels all the way back to the grid,
while the back arrow sitting in the same corner offered to return to the show.
Escape now performs exactly the back arrow's step and only closes when the
history is empty, so a deep link to a season still closes straight out. The x
button and a backdrop click still leave outright, which is what makes the two
affordances distinct rather than redundant.

`goBackModalView` passes the original opener through as `opts.restoreFocus`.
Without it, stepping back re-opens a modal at a moment when `document.
activeElement` is `<body>` (the previous modal is mid-close), so the eventual
close dropped keyboard focus on the body instead of the card the reader started
from. That bug predates the Escape change for the back arrow; the Escape change
just made it the common path.

## One provider vocabulary, and the global that nearly broke it (2026-08-23)

`scripts/providers-lib.js` is the single definition of the streaming vocabulary:
`normalizeProvider` (plan and channel variants to a brand), the mainstream
`MAINSTREAM_PROVIDERS` set, `normalizeProviders` (the display list: normalized,
filtered, de-duplicated, in order) and `isMainstreamProvider`. Consumers are
`build-data.js`, `render-show-page.js` and `js/app.js`, which reaches it through
`window.RisingShowsProviders` because `index.html` loads it before `app.js`.
Until this round the app held its own copy of the list and the renderer its own
copy of the filter, so the surface this round set out to make consistent had
three editable definitions. Verified over all 34,692 series: the app's display
list and the string on the static page agree for every one, 11,188 rows each.

**The app has no local fallback on purpose.** A fallback list would be the
second definition again. If the script fails to load, provider chips and the
modal's Watch on row do not render and nothing else changes.

**These are classic scripts sharing one global scope.** `providers-lib.js` first
shipped with a top-level `const API`, which `finder-lib.js` also declares, so
the file died at parse time with "Identifier 'API' has already been declared"
and `window.RisingShowsProviders` never existed: every provider chip vanished
silently, and only the browser suite's "no JS errors" check caught it. The file
is now wrapped in an IIFE so it leaks nothing. `integrations-lib.js` avoids the
same trap by being `type="module"`. Any new classic script here must do one or
the other.

## Keyboard focus in a scroll-snap rail (2026-08-23)

The mobile shape strip is `overflow-x: auto` with `scroll-snap-type: x` and
`scroll-snap-align: start` on each chip. A snap container REJECTS a scroll
position between two snap points, which is why both the browser's own focus
scrolling and `scrollIntoView({inline: 'nearest'})` left the widest chip
("Saved best for last", 225 px in a 353 px strip) cropped by 30 px: measured
directly, `scrollLeft += 41` read back unchanged. Scrolling so the focused
chip's own start edge meets the scrollport IS its snap point, so it sticks, and
it is what a chip rail should do anyway.

Two details that cost time: the adjustment has to run a frame later, because the
browser performs its own focus scroll AFTER the focusin handler and simply
overwrites an earlier one; and the target is the scrollport, which for a scroll
container is the padding box, so the strip's padding must not be added to it.
`chipScrollDelta` is a pure function for that arithmetic and is unit tested;
the browser suite tabs the whole strip at 390 px and asserts nothing is cropped.

## Rounding a one-decimal average (2026-08-23)

IMDb ratings carry one decimal, so a show's episode sum is exactly a multiple of
0.1 and its mean can land exactly on a .005 boundary. A double cannot represent
8.185, so which way `Math.round(x * 100) / 100` goes depends on the last bit,
which depends on the order the sum was accumulated in. The app folds per-season
`ratingSum` values from the index; the static page folds raw episode ratings
from data.json. Same total, different order, different answer: 545 shows read
0.01 apart between page and app, 7 of them differing in the tenth that the page
actually prints (The Boys: 8.18 against 8.19).

All three folds (finder-lib's `buildShowAgg`, app.js's `weightedAvgEpisode`,
render-show-page's `computeOverallAvgRating`) now go through integer tenths -
`Math.round(sum * 10)` is exact for this data - so the result cannot depend on
accumulation order. Verified: 0 shows differ at 2 dp, and all 32,325 pages that
print the number agree with the app.

## Highlight badges: one rule, two levels (2026-08-23)

The show modal marks a show's best and worst season; the season modal now marks
a season's best, worst and most-rated episode, and both levels also mark the
most-rated season. All of it runs through one helper, `pickHighlights(items)`
in `js/app.js`, because the questions are identical and two copies would drift
the way the provider list did.

What the helper refuses to answer matters more than what it computes:

- **Fewer than two rated items: no best, no worst.** A single-season show and a
  single-episode season have no contest. This was already the rule for the
  season badges and now covers episodes too.
- **All ratings equal: no best and no worst.** Otherwise the same entry gets
  badged both. Real case: Another Self season 2, where all eight episodes sit
  at 9.6 - it correctly shows only a most-rated badge.
- **Votes missing, all equal, or zero: no most-rated badge.**
- **Ties keep the earlier entry.** Both callers pass ascending season/episode
  order, so the first of two equal peaks wins deterministically instead of
  depending on which one a sort left last.

Most rated is popularity, not quality, so it is an independent badge rather
than part of the best-or-worst either-or: Breaking Bad season 5 is both, and
Ozymandias (506k ratings) is the most-rated episode of a season whose best is
Felina. It is coloured `--warn` for that reason - not the yellow of best, the
red of worst, or the green of watched.

**There is no per-season vote total in the payload.** `minVotes` on an index
record is the LOWEST episode vote count in that season, a build-time floor used
for filtering, not a sum. The most-rated season is therefore folded from the
per-episode data the modal has already loaded (`seasonVoteTotal`), which means
it is the one badge that a failed detail fetch removes. Best and worst survive,
because they come from the index-backed averages in `buildBestSeasonMap`. This
is deliberate: no pipeline change, and the degraded modal stays honest.

**Every `.modal-episodes li` is its own grid, not a row of a shared one.** A
flag column appended at the END of a flagged row therefore pushed that row's
rating and vote count left while unflagged rows kept theirs at the edge, and
the numbers went visibly ragged down the list. Two things fix it together: the
flag column sits BEFORE the ratings, and the cell is emitted on every row of a
flagged season (empty cells collapse to zero width). The `has-flags` class on
the `<ul>` is what turns the fourth column on, so a season with nothing to flag
keeps the old three-column layout with no dead gutter - and it has to be
toggled off again, since the list element is reused across seasons. Verified at
1280 and 390: rating right edges identical on flagged and unflagged rows
(955.1 px and 345.5 px respectively).

On phones the flag labels wrap to two lines inside a 3.3rem cap rather than
squeezing the title further; the ratings stack beside them is already three
lines tall, so the rows do not grow.

## Gotchas

- **A missing numeric guard NaN-poisons whole-series folds.** Defect 15:
  `split-data.js` summed `e.rating` for the `aboveImdb` fold without a
  `typeof === 'number'` guard, so ONE unrated episode made the sum NaN
  and silently dropped the series from the badge list (`NaN > x` is
  false). Fixed 2026-08-15 with the same rated-only guard every sibling
  fold (`ratedCount`/`ratingSum`, `buildShowAgg`) already used;
  regression-pinned in `tests/split-data.test.js`. Any new fold over
  episode ratings must skip unrated episodes.
- **`data-index.json` and `data/detail/` only exist after split-data
  runs.** `npm run fetch:rising-shows-data` downloads `data.json` +
  extras but does NOT produce the index; run
  `npm run build:rising-shows:split` (or `build:site`) before serving
  the app locally, or the finder shows its data-missing message.
- **The extras monolith's season keys align with `matches` seasons**
  because `build-data.js` writes both in one pass; split-data merges by
  `String(m.season)` lookup and silently skips extras for series/seasons
  not in `data.json` (e.g. shows that fell below the vote floor).
- **A `\d` inside a browser-suite template literal is just `d`.** The checks
  in `tests/browser/suites/*.mjs` build their expressions as template
  literals, so a regex written `/[^\d]/` reaches the page as `/[^d]/` and
  quietly matches the wrong thing - `parseInt` then returns NaN and the check
  fails for a reason that has nothing to do with the app. Source must carry
  `\\d` (as the existing `([\\d,]+)\\s+shows?` check does). Cost one
  debug cycle on the badge checks, 2026-08-23.
- **The vm test harness (`tests/app-features.test.js`) reaches only what
  `window._rsTestExports` lists** at the bottom of `js/app.js`. Watched
  and Compare were unreachable until exported there (2026-08-15); their
  localStorage contract (`rising-seasons:watched` / `:compare`, legacy
  namespace kept on purpose for pre-rebrand sync data) is now pinned.

## What the 2026-08-22 audit found, and how it is pinned now

Every defect below is fixed; each bullet names the regression that would catch
it coming back. Browser checks live in `e2e/audit-2026-08.mjs` (run by
`tests/browser/run.mjs`), unit checks in `tests/`.

- **The finder used to overwrite user input when the index landed.** `load()`
  runs `applyStateFromURL()` after the ~34 MB fetch, so anything typed into
  `#finderSearch` during a 10-17 s throttled boot was wiped. It now reads the
  live input value first and merges it into `finderState` when the hash carries
  no `q=`, then writes the hash. The box also reports itself: the count line is
  the `aria-live` region and shows "Loading show index (N of M MB)...", and the
  input carries `aria-busy` until the data is in. Content-Length is the
  compressed size on a real deploy, so the "of M MB" half only appears when the
  body arrived uncompressed. Pinned by the throttled-load checks (3 MB/s with
  `Network.emulateNetworkConditions`, typing mid-load).
- **Rating sorts have a documented vote floor.** The dataset floor is 5 votes
  per episode, so `sort=avgEpisode` / `sort=showRating` opened on 7-vote titles
  at 10.0. `RATING_SORT_VOTE_FLOOR = 1000` in `scripts/finder-lib.js` now banks
  sub-floor rows below every row at or above it (both directions), only while
  the votes filter is at "Any"; the result count is untouched and the
  active-filter bar carries a "Ranking: 1,000+ votes first" note. The
  "Above IMDb" badge has the same 1,000-vote floor (`ABOVE_IMDB_MIN_VOTES`), so
  a 125-vote show whose fans rate every episode 10.0 no longer earns it; the
  modal pill reads PR #435's precomputed `aboveImdb` list and then applies that
  floor, so the pill and the grid badge cannot disagree.
  `filterAndSortRows` uses the same comparator, so a rating-sorted Kometa preset
  matches the Finder. Pinned by `tests/finder-lib.test.js` (floor active/inactive,
  both directions, export path) and a browser check on the first page.
- **Edge dataset shapes reach the error panel.** `validateDataset` runs inside
  `load()`'s try/catch: a non-array `matches` errors, records missing
  id/title/season are dropped with a console count, and an empty result errors.
  `[]` and null titles used to throw past the catch and leave eight skeletons up
  forever. Pinned by `tests/app-features.test.js` and two intercepted-index
  browser checks.
- **Detail-file failure is visible.** A modal whose `data/detail/<id>.json`
  failed says so and offers a Retry that really refetches (`ensureDetail`
  evicts failed fetches, so it is a real request). Both rounds of 2026-08 work
  built this: the audit's dynamic line and PR #435's static `#modalDetailError`
  / `#showModalDetailError` boxes. The merge keeps ONE of them, the static
  boxes, and `showDetailError` / `clearDetailError` add and remove a
  `modal-detail-error` marker class so the audit's D7 browser check (which asks
  whether a notice is up, and whether Retry cleared it) still addresses it.
  Season counts come from the index either way: `seasonRatedFold(m).count`
  falling back to `seasonEpisodeCount(m)`, so no row reads "0 eps" and no
  subtitle reads "0 episodes". Pinned by a browser check that 404s
  `data/detail/*` with the cache disabled.
- **Esc steps back one modal level.** From a season opened out of a show modal,
  Esc now calls `goBackModalView()` when `modalViewHistory` is non-empty and
  only closes at the last level; the shortcut legend says so.
- **The pager focus ring paints.** `.pager .page-btn:focus-visible` needed its
  own `!important` to beat the base rule's `box-shadow: none !important` (which
  exists to beat main.css). Pinned by a browser check that Tabs onto a page
  button and reads the computed shadow.
- **Season rows are a clean list.** `#showModalSeasons` children are plain
  `<li>`s again; the keyboard entry point is a real `<button class="ss-num">`
  (styled back to a plain label: main.css paints every button an inset 1px #555
  ring and a 3.25rem line-height, so `.ss-num` counter-pins colour, height,
  line-height and box-shadow). Clicking anywhere in the row still opens the
  season. That cleared axe `list` and `nested-interactive`; seeded axe scans of
  the finder, both modals and the Kometa builder at 1280 and 390 are part of the
  e2e suite and must stay at zero serious/critical.
- **Search terms are trimmed on both sides of the hash.** `parseFinderQuery`
  trims, and `writeFinderStateToURL` now delegates to `serializeFinderQuery` in
  finder-lib, so app, export pipeline and tests share one serialisation.
- **Contrast:** `.footer-meta` was 4.41:1; it uses `--footer-meta-ink`
  (#858d9c, 5.96:1). On the Kometa page `--muted-2` was under 4.5:1 for
  `.kometa-help`, `.kometa-shape-count` and YAML comments, `<small>`/`<strong>`
  inherited main.css greys, and in-text links were colour-only; all scoped fixes
  under `body.rising-shows-app`.
- **Scripts are `--help` safe now.** `split-data.js`, `export-integrations.js`
  and `build-show-pages.js` print usage and exit 0 for `--help`/`-h`, and exit 2
  on an unknown argument, before any file work. They used to run their full job
  on any argument: `--help` rewrote data-index.json plus 34k detail files, the
  tracked `exports/` tree, and the 34k generated pages respectively. Pinned by
  `tests/script-args.test.js`, which spawns each script in a throwaway app tree
  that HAS a data.json and asserts the tree is byte-identical afterwards.

## More gotchas (2026-08-22)

- **Detail fetches are served from HTTP cache, so failure injection must
  disable the cache.** `interceptNetwork` on `data/detail/*` did not fire for
  a show opened earlier in the same profile; use a fresh profile or
  `Network.setCacheDisabled`.
- **Script focus is not `:focus-visible` in headless Chromium.** Calling
  `el.focus()` after a navigation leaves `matches(':focus-visible')` false, so a
  focus-ring check must move focus with real Tab / Shift+Tab keys first.
- **`cdp.evaluate` returns the string when the expression is already
  `JSON.stringify(...)`.** The e2e file wraps it and re-parses; calling
  `.then(JSON.parse)` on the raw helper throws on "[object Object]".
- **A collapsed `<details>` still reports a laid-out height** for its content in
  this Chromium (content-visibility), so "is the rail collapsed" must use
  `checkVisibility()`, not `getBoundingClientRect().height === 0`.
- **The sitewide back-to-top FAB becomes the modal's scroll-to-top in modal
  mode** (`assets/js/back-to-top.js` moves it into the panel; app.js keeps it
  out of `inert`). The modal close button is now `position: sticky` on phones,
  so it is no longer the only way back to it.

## What's new: signal vs noise (2026-08-22)

A daily refresh is mostly long tail. The 2026-08-22 entry added 21
seasons, 19 of them with under 1,000 ratings (four under 50), and all
ten of its "notable rating swings" were titles with 16 to 363 votes
moving on a handful of new ratings; two adult titles appeared in the
added/removed lists. The changelog data is unchanged (the pipeline still
records everything); the modal now ranks each list by series votes,
shows what clears 1,000 votes (falling back to the three best-known when
nothing does), never shows adult titles, and closes each list with
"and N more with few ratings".

## Provider vocabulary (2026-08-22)

TMDB hands back 237 distinct US provider strings, including three
spellings of BritBox and a `"Britbox Apple TV Channel "` with a trailing
space. `scripts/providers-lib.js` is now the single normalizer, shared by
`build-data.js` (as before) and by the static page renderer (which used
to print the raw vocabulary). Both surfaces show the same 9 mainstream
brands; 5,675 pages lost a "Streaming (US)" row that had listed only
aggregators and FAST tiers.
