# Rising Shows - engineering findings

A living document: best current understanding, not a diary. See the
repo-root `CLAUDE.md` for the convention.

## The modal action row, moved down and then back up (2026-09-07)

The show and season modals now carry **one** action row, in the heading beside
the poster: the primary action (compare / mark as watched) then the ghost
utilities (share card, share chart image, permalink, IMDb, TVDB).

They were there originally. On 2026-08-23 (commit 231a8f1, PR #435) they moved
to a `modal-actions-bottom` row after the content, on the reasoning recorded in
the markup at the time: the utilities "used to sit in two rows above the
overview, which put seven buttons between the title and the first thing a
reader wants". That was part of a measured above-the-fold pass, and the
diagnosis was right about the old layout - **two full-width rows** with a
divider, between the title and the overview.

What it got wrong was the remedy. Measured on the show modal (Breaking Bad,
the panel is the scroll container):

| | desktop 1280x900 | mobile 390x844 |
|---|---|---|
| panel scroll height | 1,992 px | 2,484 px |
| visible at a time | 869 px | 828 px |
| utility row top | 1,929 px | 2,220 px |

So the fix for "these are in the way" was to put them past the cast, the
seasons overlay, the full season list and "More shows like this". A permalink
you reach by scrolling 1,900 px is not a permalink, and the owner asked for
them back on 2026-09-07.

The row works in the heading because it is now **one wrapped row of compact
buttons**, not two full-width rows with a divider. After: every button is in
the viewport on both sizes (desktop 216/264 px, mobile 321/372/424 px), and the
panel got SHORTER (1,948 / 2,294 px) because the separate row and its divider
are gone. The cost is the overview starting lower - 275 -> 322 px on desktop,
374 -> 480 px on mobile - and it is still on the first screen at both sizes.

Two things had to come with the move, or the row reads as six identical
buttons:

- **The accent rules were dead.** `.modal-actions .watch-btn/.compare-btn` gave
  the primary action its accent surface, but the 2026-08-23 change left the
  primary button in `.modal-primary-actions` and deleted the `.modal-actions`
  wrapper around it. The selectors never matched again, and the compare button
  had been rendering as a plain `.btn` (measured `rgb(18,21,29)`, not
  `--accent-soft`) for two weeks. They are re-scoped to
  `.modal-primary-actions`, so `+ Add to compare` leads the row again.
- **Mobile stacking had to go.** The old `.modal-actions` mobile rule made each
  button a full-width 44 px bar. Six of those is 264 px of an 844 px screen,
  which is the problem this move set out to solve. The buttons now wrap two per
  line with `min-height: 44px`, so the tap target survives without the bars.

`.modal-actions`, `.modal-actions-top`, `.modal-actions-bottom` and
`.modal-imdb` are all gone from the CSS; `modal-actions-top` had already been
dead since 2026-08-23.

### The group is a LOCAL variant, and why (same round)

Every rule for this group is scoped to `.modal-primary-actions` / `.outbound-tag`.
The shared `.btn` and `.btn-ghost` primitives dress the toolbar, the pager, the
close button and the provider chips, and the modal action area is the one place
on the site where a primary action, three secondary ones and two outbound
references sit shoulder to shoulder and have to read as three ranks. Restyling
the primitives to fix this one group would have moved every button on the site.

What the local variant changes, all from existing tokens:

- **Secondary buttons are filled, not outlined.** `.btn-ghost` is transparent
  with a `--border-strong` outline, which on the modal panel is literally a
  rectangle drawn on the card. Filling with `--surface-2` and dropping to a
  hairline `--border` inverts it: they become objects sitting on the card.
- **The resting-state depth is a lighter TOP border**, not a shadow. `.btn`
  pins `box-shadow: none !important`, so any shadow would need a second
  `!important`; a 7% white top edge gets the same "lit from above" read for
  free, and is what keeps a flat fill from looking like a disabled input.
- **The primary is dialled back, and no longer gold.** It was a 700-weight
  label inside a 32%-opacity gold border, which beside the calmer secondaries
  read as a warning strip. It is now 600 weight in indigo. See the palette note
  below for why indigo; measured 7.8:1 against its own composited background.
  (Measure any translucent fill by COMPOSITING the button's background over the
  panel first. Comparing the label to the raw `rgba(...)` reports a meaningless
  1.5:1, and the same mistake reported 1.13:1 for the gold version.)
- **One focus language.** Buttons and chips both take
  `box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 1px var(--accent)` rather
  than a ring on one and a glow on the other.
- **No external-link glyph on the chips.** Nothing else in the app marks
  outbound links that way, so inventing the pattern here would be the one
  flashy note in a restrained group. Where the link goes lives in the
  accessible name and the tooltip.

### Every hue in this app already means something (2026-09-07)

The chips carry their source's brand colour: IMDb gold, TVDB green. That forced
the primary action OFF gold, because `--accent` is literally IMDb's yellow (the
palette says so in a comment) and one colour cannot mean both "the action to
take here" and "IMDb".

Picking its replacement is not a taste question in this app, because the
palette is nearly fully assigned. Auditing every colour in `styles.css` first:

| hue | already means |
|---|---|
| `--accent` #f5c518 gold | IMDb (and, until now, the primary action) |
| `--good` #34d39e green | added / watched state, and now the TVDB chip |
| `rgba(56,189,248)` cyan | provider chips: where to watch |
| `#c084fc` purple | a SPECIAL EPISODE, in the season modal - the very modal that carries this row |
| `--warn` #fb923c orange | staleness |
| `--danger` #f87171 red | destructive / negative gap |

Indigo was the only unassigned hue, so it is now "the action", declared as
`--act-*` custom properties on `.modal-primary-actions` rather than as global
tokens: it means "primary action in this group", not something site-wide.

Two things fall out of that audit and are worth keeping:

- **The chips drive their own states through `--tag-*` custom properties.** The
  base `.outbound-tag` rules are written once and read the variant's colour, so
  hover, press and the focus ring all follow the chip's own hue. That is what
  avoids a gold focus ring landing on a green chip while keeping ONE focus
  language. An unrecognised source falls back to neutral.
- **TVDB uses its own `#6cd491`, not `--good` `#34d39e`.** `--good` is the
  colour the compare button turns when a show is already added, and the watch
  button turns when a season is marked watched; painting a stateless link in
  the state colour would say "this is done". The residual cost is that an
  added-state compare button and the TVDB chip are both green in the same row.
  That was accepted knowingly on 2026-09-07, not overlooked.

### Three tiers, not one row of equals (same round)

Six same-sized buttons on one row say all six are equally worth doing. The row
is now read top to bottom as primary, actions, references:

- **The primary action holds its own line.** Not by stretching it:
  `flex-basis: 100%` on the button makes it a full-width bar. The line break is
  a separate zero-height full-width flex item (`.action-row-break`), which ends
  the line without touching the button's own width.
- **IMDb and TVDB are pills, not buttons** (`.outbound-tag`): same geometry as
  the provider chips so the modal keeps one vocabulary for "small labelled
  thing you can click", each in its source's brand colour (see the palette note
  below). Measured 8.83:1 and 7.92:1 composited, 30 px tall on desktop and
  36 px on a phone.
- **The lines split by verb.** Line one is what the modal DOES (compare, share
  card, share chart image); line two is where it GOES (permalink, then the two
  outbound chips). The four buttons do not fit one line in this column - they
  need 591 px of a 532 px heading column at 1280 - and the only ways to force
  it are shrinking the group ~11% below the site's control scale, or moving the
  row out of the heading to span the panel. Splitting by verb costs neither,
  and the owner picked it over both on 2026-09-07.

A pill shows only the site name, so **the accessible name carries what the href
actually points at** - "Season 1 on IMDb", "This series on TVDB" - set by
`setOutboundLabel`, which writes both `aria-label` and `title`. Every name
contains the pill's visible word, which is what WCAG's label-in-name asks for:
a speech user saying "IMDb" has to be able to hit it. The season modal used to
put that distinction in the visible text ("View season on TVDB →"), which is
why the JS writes it rather than the markup.

## Share chart image copies, it does not download (2026-09-07)

`deliverChartImage` tried the native share sheet first and fell back to a file
download. On a desktop that means a PNG in the downloads folder, or a Windows
share sheet asking which app to hand it to, when what people want is to paste
the chart into a message. Its neighbour "Share card" has always copied. So the
order is now clipboard, then share sheet, then download.

`copyImageToClipboard` resolves to `null` rather than throwing for every reason
the write can fail, because all of them are ordinary and all of them have a
working fallback: no secure context, no user gesture, an unfocused document
(`NotAllowedError`), no `ClipboardItem` constructor, or Safari refusing an item
built from an already-resolved blob. Only a build failure reaches the user as
"Image failed".

The confirmation is a lookup (`CHART_IMAGE_FLASH`), not a two-way branch. The
old label was `how === 'shared' ? 'Shared!' : 'Downloaded!'`, which would have
told a clipboard copy it had been downloaded.

**A trap worth remembering, found writing the tests for this.** The test helper
was `try { return fn(...) } finally { restore() }` with an async `fn`. That
returns the promise immediately, so `finally` restored every stub BEFORE the
awaited body ran, and the delivery chain hit Node's real `URL.createObjectURL`
with a stub blob. `await fn(...)` inside the try is the fix. A stub-restoring
helper around async code has to await, or it un-stubs mid-test.

## A saved scroll offset belongs to ONE view (2026-09-07)

## A saved scroll offset belongs to ONE view (2026-09-07)

`ScrollMemory` exists because the grid renders only after the index is fetched,
so at the moment the browser would natively restore scroll the document is
still skeletons and short: native `auto` restoration clamps a bottom-of-page
offset to that short height and strands a refresh in the middle. We take it
over with `history.scrollRestoration = 'manual'` and a sessionStorage offset.

What that missed is that an offset is only meaningful in the view it was taken
in, and sessionStorage outlives a navigation to another page. The route that
exposed it is entirely inside the app's own SEO surface:

1. read the "What a rating shape is" section at the very bottom of the app
   (~5,300 px down, so that is the saved offset);
2. follow one of its shape links to `shows/shape/declining/`;
3. come back through that hub's "Filter Declining shows in the explorer →"
   CTA, which links to `/apps/rising-shows/#shape=declining`.

The filter applied correctly and the visitor landed at 5,337 px with the count
line 4,606 px above the viewport and **zero** cards on screen. Measured, not
inferred - the whole flow reproduces headlessly by clicking the two real links
in one tab. `#shape=declining` is finder state rather than an element id, so
the existing "a real anchor wins" guard never fired.

Two things fix it, and both are needed:

- **The offset carries the view it was taken in** (`rising-seasons:scrollView`,
  written and cleared with the offset). `viewKeyFromHash` sorts the hash's
  params so `#sort=gap&gapDir=up` and `#gapDir=up&sort=gap` are one view, and
  a bare hash is `''`. Restoration is declined when the recorded view is not
  the current one. An offset with NO recorded view (a tab that stored one
  before this key existed) restores as it always did.
- **A fresh navigation into a non-default view lands on the count line.**
  The view key alone is not enough: a visitor already on `#shape=declining`
  who reads the same explainer and takes the same CTA comes back to the *same*
  view key and would be restored to the bottom again. Navigation Timing
  separates the cases - `navigate` is a link click or a typed URL, `reload`
  and `back_forward` are returns to a position the visitor already had, which
  stays ScrollMemory's to hand back.

Priority order lives in `settleInitialScroll`: a real element anchor, then a
fresh navigation into a filtered view, then the saved offset. "Filtered" is
`serializeFinderQuery(finderState).toString() !== ''` - the same serializer the
hash is written with, which omits every default, so there is no second
definition of what counts as a non-default view. The landing target is the
count line at `-70 px`, the same one paging has always used, which is what puts
the header clear and the first row of cards on screen.

Regressions to keep in mind when touching this: a refresh at the bottom of a
filtered view must still come back to the bottom, Back out of a show page must
return to where the visitor was, and a fresh visit to the unfiltered app in a
tab that holds a filtered-view offset must sit at the top. All three are
covered in `tests/app-features.test.js` alongside the two CTA flows.

## Shape hub copy is search-facing, and separate from the internal labels

The 14 hub pages under `shows/shape/` are the highest search-intent pages on
the domain, and until 2026-09-04 they took their title, heading and description
straight from the internal shape label: "Best Bad finale TV shows", "Best
Mid-peak TV shows". Nobody searches that. `HUB_SEO` in
`scripts/render-shape-hub.js` now holds the phrasing people actually use
("TV Shows With a Bad Final Season", "TV shows that ended badly"), with the
target query recorded alongside each entry as `intent` so a later edit can tell
whether the wording still aims at it. Membership, ranking and data are
untouched - only how the page describes itself.

Two entries are deliberately worded apart rather than merged: `big-finale`
(the run builds to a peak final season) and `saved-best-for-last` (the final
season is the highest-rated on a show with no overall trajectory) are close
enough that one phrasing would have had two of our own pages competing for it.

A shape added to `SHAPE_SLUGS` without a `HUB_SEO` entry falls back to the old
"Best <label> TV shows" template, and `render-shape-hub.test.js` fails on
exactly that fallback - so the failure means "this shape has no copy", not
"the page is broken".

The hubs were also reachable from one page only (the A-Z index, three clicks
deep). The app landing page now lists all 14 in its `.app-about` block, which
is where their internal links come from; `tests/static/internal-links.test.mjs`
allowlists them by slug, since the pages are generated at deploy and gitignored.

## Data loading architecture (2026-08-15 lazy-extras redesign)

**The app fetches exactly one dataset file at boot.** Nothing else. (That
file was `data-index.json` when this was written; since the 2026-09-08 F08
split it is `shows-index.json` - see "The browser stopped downloading the
season catalogue" below. Everything about the extras redesign here still
holds.) The old flow ALSO fetched `data/show-modal-extras.json`
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
code + index and an eager-extras regression (+67 MB) trips it. Clean clone
(no dataset) measures ~1.6 MB and passes. The budget was 52 MB against the
35.98 MB season index; after the F08 split it is 26 MB against ~18.25 MB, so
a revert to the season index (+17 MB) also trips it - leaving the old ceiling
would have let the whole saving be handed back unnoticed.

**Index slimming was considered and rejected** (2026-08-15; SUPERSEDED
2026-09-08 - the answer was not to slim the season file but to stop sending
it, see the F08 entry below): no field of `data-index.json` dominates
(largest is `poster` at 8%), and nearly all 27 per-match fields feed the
grid/filters/sort. Stripping the few
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

## The daily refresh was gated on the WHOLE repo's tests

`refresh-rising-shows.yml` ran `npm test` before uploading the release asset,
so a failing test in ANY other app stopped the data refresh. That
is what happened on 2026-08-23 and again on 08-28 through 08-31: an fpl-planner
test failed, the job stopped before the upload, and the live site served
2026-08-27 data until 09-01 with nothing on the page saying so (the staleness
badge only fires at 30 days). The changelog shows it plainly: entries jump from
08-27 to 09-01, then catch four days up at once.

The step now runs `npm run test:rising-shows && npm run test:static`. What it
actually needs to protect is the artifacts this job commits (the changelog, the
Kometa and MDBList exports, the split index) plus the site-wide static
invariants the generated pages feed. The rest of the estate is gated on every
PR and every push to master, which is where it belongs.

## The shipped dataset is checked now, in the only place it can be

Two facts had to meet before this was worth writing down. First, every test
under `tests/` builds its own small fixture and asserts against that, which is
correct for testing build logic and means the 66,000-record file the site
actually serves was validated by nothing. Second, nothing downstream covered
it either: the bot PR's `tests` and `browser tests` runs skip every
data-dependent check, because the dataset is gitignored and a runner never has
it. (Those runs execute now, since 2026-09-08 - see "The daily refresh could
not merge itself" below - which changes nothing about this: what they cover is
the rest of the estate against the changelog and the exports the bot commits,
never the dataset.)

So the refresh job is the only place the real data exists, and
`scripts/validate-dataset.js` now runs there, gating the RELEASE UPLOAD rather
than the whole job: a dataset that fails must not replace the asset, and the
previous one staying live is the safe outcome.

What it checks, and why each one is about the DATA rather than the code:

- **The catalogue did not collapse.** A floor of 20,000 records against a real
  66,380, so ordinary churn never trips it and a truncated build or an empty
  parse always does. This is the failure that matters most, because a
  half-empty data.json still renders.
- **Every record can be rendered:** an id, a title, an episode list, and
  ratings inside 1-10 and finite, including inside the episode list the season
  page draws.
- **No duplicate `(seriesId, season)`.**
- **A shape agrees with its own ratings.** A season tagged `rising` that ends
  lower than it started, or `declining` that ends higher, is refused. This is
  the check worth having: a classifier regression ships silently otherwise,
  since the finder still renders, the counts still add up, and "rising" simply
  stops meaning rising. Only the two directional shapes are checkable this way
  without re-deriving the classifier, which would be a mirror of the thing
  under test.
- **The header's `count` and `shapeCounts` match the records.**

Verified by breaking real data on purpose: a 500-record slice is refused as
truncated, and ONE flipped record among 30,000 genuine ones is caught by the
shape check. `tests/validate-dataset.test.js` covers the validator itself, on
the principle that a checker nobody checks is worse than no checker because it
reads like coverage.

## The daily refresh could not merge itself, and the reason on file was wrong (2026-09-08)

The refresh opened PR #515 at 10:37 and it sat there. GitHub showed "4
workflows awaiting approval" and the four required checks - `lint`, `test`,
`browser`, `rules` - never reported.

**Two separate faults, and the older entry here named neither correctly.**

**1. The merge stopped being possible on 2026-09-07.** `master` gained classic
branch protection requiring those four contexts, strictly. The workflow's
"open a PR and merge it in the same breath" path predates that: it called
`gh pr merge` about three seconds after `gh pr create`, and GitHub refuses to
merge a pull request whose required checks have not reported. #486 (09-06)
merged seven seconds after it opened; #501 (09-07) took eight hours and a human;
#515 did not merge at all. Whatever token was used, that path could not work
again.

**2. The runs were HELD, not suppressed.** The entry that used to sit here said
GitHub "does not start workflow runs from `GITHUB_TOKEN` events", so a bot PR
could never have CI and a PAT was the only way out. That is the documented rule
for most `GITHUB_TOKEN`-created events and it is not what this repository does.
Measured on #515:

```
34216452343 tests           event=pull_request  status=completed  conclusion=action_required
34216452437 lint            event=pull_request  status=completed  conclusion=action_required
34216452444 arena emulator  event=pull_request  status=completed  conclusion=action_required
34216452547 browser tests   event=pull_request  status=completed  conclusion=action_required
```

The runs exist, against the bot branch, with `head_sha` equal to the pull
request head. `action_required` is the maintainer-approval hold, which is
exactly what the "awaiting approval" banner reports, and it is releasable:

```
POST /repos/nsoifer01/shevato/actions/runs/34216452343/approve
```

released `tests`, which ran as attempt 2 and concluded **success**. So the hold
was the whole problem and an API call was the whole fix.

Where the hold comes from: the repository's Actions setting
`fork-pr-contributor-approval.approval_policy` is `first_time_contributors`.
`github-actions[bot]` never accrues contributor status here, because these
commits are authored as `shevato-bot <actions@users.noreply.github.com>`, an
identity linked to no GitHub account. So every bot pull request is held as a
first-time contributor's, every day, forever. Loosening that setting would
loosen it for real outside contributors on a public repository, which is not a
trade worth making for this.

**No PAT. No GitHub App. No new secret.** `GITHUB_TOKEN` with `actions: write`
can call `/approve`, verified by running it from a workflow rather than
reasoning about it: a probe job with that one permission released all three
remaining held runs on #515 (`browser tests`, `lint`, `arena emulator`) and
they ran. The `secrets.BOT_PAT || secrets.GITHUB_TOKEN` scaffolding that was
waiting for a token that never needed to exist is gone.

**What replaced the old merge step.** `scripts/bot-pr-autopilot.mjs`, run by
the refresh job and dispatchable by hand through
`.github/workflows/bot-pr-autopilot.yml`. It releases the hold on the runs for
the pull request's own head commit, arms GitHub's **auto-merge**, and watches.
Branch protection decides the merge; nothing here bypasses a check, and a red
check leaves the pull request open. It re-releases on every tick because the
hold is re-applied to every new head commit, which a strict base branch
produces whenever the branch has to be updated.

**It deletes the merged branch too, because GitHub does not.** "Automatically
delete head branches" is ON for this repository, and it fires for a human:
#517's branch was gone the moment auto-merge merged it. It did NOT fire for
#518, whose auto-merge was armed by `github-actions[bot]` - that branch was
still on the remote minutes after the merge. Both measured on 2026-09-08.
Relying on the setting would have stranded one timestamped
`bot/refresh-rising-shows-*` branch every day, which is precisely the
accumulation the timestamped names make expensive.

**One open refresh pull request at a time, enforced.** Two of them cannot both
merge: both rewrite `changelog.json` and the exports, so the second is
guaranteed a conflict, and the loser's changelog entry is lost because the next
build appends to `master`'s changelog while diffing against a release baseline
that has already moved. So the refresh reconciles before it builds: it drives
any open bot pull request to a conclusion first, and if one cannot merge it
fails there, in the first minute, before an IMDb download or a release upload.

**The near-miss worth keeping.** This cannot be filtered away from inside the
workflows: `on.pull_request.branches-ignore` matches the pull request's BASE
branch, which is `master` here, not its head. Excluding `bot/**` there looks
right, reads right in review, and does nothing.

**A third fault sat behind these two, and #515 found it first.** Once the hold
was released, `rules` went red: #514's Scope step ran `grep` under Actions'
`bash -e`, and a `grep` that matches nothing exits 1, which is exactly the skip
decision. Every change with no emulator inputs got a red required check. The
refresh's pull request was the first one to take that path, because the two
that merged in the window between #514 and it both happened to touch an input.
Fixed in #516; recorded in `apps/arena/FINDINGS.md`. Worth remembering here
because it is the shape this automation will keep hitting: the bot's pull
request is the repo's most reliable prober of the paths humans rarely walk.

## The release pin was generated and then never committed (2026-09-08)

The 2026-09-05 F13 work built the whole immutable-release mechanism: each
refresh uploads `data-<releaseId>.json.gz` alongside the rolling name, writes
`apps/rising-shows/data-release.json` naming that release with the SHA-256 of
both files, and `fetch-data.js` resolves the pin from the build's own commit and
refuses a file whose digest does not match.

`apps/rising-shows/data-release.json` was not in the refresh commit's `git add`
list. It is not tracked, it has never been on `master`, and `git diff` cannot
even see it because it is untracked, so the guard in front of the commit could
not notice either. Every build therefore took `fetch-data.js`'s documented
compatibility fallback to the ROLLING asset names, and the property the whole
exercise was for - a deploy resolves the dataset its own commit approved - was
false the entire time. The sentence "nothing deploys until this PR merges" was
back to being true of the derived files and false of the data.

It is in the `git add` list now, and `tests/static/bot-pr-autopilot.test.mjs`
fails if it leaves again. The hole closes for good the first time one of these
pull requests merges: until `master` carries a pin, a build has nothing to
resolve and still falls back.


## The boot fold was doing the same work twice (2026-09-05 F08)

`load()` ran `normalizeSearch` over every one of ~66,380 SEASON records to
derive `titleSearch` - a measured 110 ms of a ~420 ms main-thread boot task on
a desktop, so roughly half a second of a mid-range phone's startup. The only
consumer of the result is `buildSeriesIndex`, which keys by SERIES: nearly half
of that work was folding the same title again for another season of the same
show. It now happens once per series, where the answer is used. Measured: 110 ms
to 63 ms, with no change to the payload and none to search behaviour.

The folding functions moved from `js/app.js` into `scripts/finder-lib.js` while
doing it. Not copied - a second implementation would be a second search
behaviour waiting to diverge, and this file is the one place the runtime finder
and the build are meant to agree.

**Stamping the folded title into the index at build time was measured and
rejected.** It saved 107 ms of CPU and cost 0.27 MB of production-quality
brotli (3.17 -> 3.44 MB) on a file every visitor downloads, which on a phone
connection is a wash at best. The numbers are here so the next person does not
have to re-derive them before deciding.

## The browser stopped downloading the season catalogue (2026-09-08, F08 closed)

The rest of F08 - the part the entry above called a multi-day refactor - is
done. The browser no longer fetches a season-level file at all.

**The shape of it.** `scripts/split-data.js` now writes `shows-index.json`: one
record per show, already through `buildShowAgg`. The season records did not
disappear, they moved into `data/detail/<seriesId>.json`, which the modal
already fetched, so a show's seasons arrive with the modal that wants them.
`data-index.json` is unchanged and still published; nothing in the browser
fetches it.

**Measured, same methodology as the audit** (Netlify compresses with brotli
q3 - calibrated by reproducing the live 5,912,963-byte response exactly, and
q11 flatters the numbers by 40%):

| | season index (before) | show index (after) |
|---|---|---|
| encoded transfer | 5.88 MB | 3.43 MB |
| raw | 34.44 MB | 16.62 MB |
| JSON.parse (node) | 168 ms | 88 ms |
| boot `buildShowAgg` | ~250 ms | gone (build-time) |
| records | 66,380 seasons | 34,615 shows |

And in a real browser, with only `js/app.js` swapped between the two runs so
nothing else can account for the difference (headless Chrome, 390x844, cache
disabled, served over a local server compressing at the same brotli q3):

| | before | after |
|---|---:|---:|
| boot download, desktop | 5.88 MB / 198 ms | 3.45 MB / 136 ms |
| longest main-thread task, desktop | 488 ms | 317 ms |
| time to first card, desktop | 952 ms | 933 ms |
| boot download, Fast-3G + 4x CPU | 29,849 ms | 17,671 ms |
| **time to first card, Fast-3G + 4x CPU** | **36,503 ms** | **23,992 ms** |
| longest main-thread task, Fast-3G + 4x CPU | 2,005 ms | 1,665 ms |

The desktop time-to-first-card is unchanged, and that is the honest result: on
localhost the download is instant either way, so all that is left is CPU, and
saving ~250 ms of fold inside a ~950 ms boot is inside the run-to-run noise.
The number that matters is the throttled one - **12.5 seconds sooner to the
first useful result on a mid-range phone** - because that is the visitor the
audit was about. A modal open still costs exactly one ~12 KB partition.

Two traps in measuring this, both of which produced confident wrong numbers
first:
- the repo's python static server sends everything UNCOMPRESSED, so a throttled
  run measures 34 MB against 16 MB rather than 5.9 against 3.4, and the
  before/after gap comes out nearly twice as large as it really is;
- a static server that caches file bodies by path serves the FIRST `app.js` it
  read for the whole session, so the "before" run silently re-measures the
  "after" code. Both runs reported the same file and nearly identical timings,
  which is what gave it away.

**The ten readers, and where each one went.** Whole-catalogue scans became
show-index reads: `buildSeriesIndex`, `buildBestSeasonMap` (badges precomputed),
`buildAboveImdbMap` (a flag), `indexShowAgg`'s provider chip (a field),
`applyPendingCompareIds`, `validateDataset`, `computeShowRelated`. Per-show
lookups became `seasonsFor(id)` after `ensureDetail`: the show modal, Compare,
the two share cards, the season permalink, the changelog jump. `dataset.matches`
no longer exists in `js/app.js`, and a test asserts that, because a single
surviving whole-catalogue scan over a now-partial list is a silent wrong answer
rather than an error.

**What was measured and rejected.**
- Short keys (`t`/`y`/`p` for `title`/`year`/`poster`): 0.06 MB of brotli and
  1 ms of parse, for an unreadable build artifact.
- `seasonAvgs` as `[season, year, avg]` triples: 0.07 MB encoded, and the
  sparkline reads the object fields directly.
- Moving `poster` out of the boot payload: 0.83 MB encoded, but posters render
  with the card, so this trades transfer for cards that fill in afterwards.
  Not taken without a reason to change what first paint looks like.
- `tmdbId`/`tvdbId` were DROPPED from the show record (0.43 MB encoded): every
  reader of them turned out to take `seasons[0]`, a season record.

**The trap that cost the most time.** `meanSeasonVotes` was rounded to an
integer at first. `computeShowRelated` bands candidates at `anchor / 10` and
`anchor * 10`, so half a vote of rounding moves the band edge and changes which
shows are recommended - it re-banded 19% of the catalogue and the parity test
caught it on real data. The exact quotient ships; a double round-trips through
JSON exactly.

**Failure behaviour changed, deliberately.** The season table is in the
partition now, so a detail fetch that 404s no longer costs only the episode
curves. `seasonAvgs` therefore carries `episodeCount` (~0.15 MB encoded) so a
show whose partition is unreachable still opens with true season numbers, an
explicit notice and a Retry - the 2026-08-22 D7 guarantee, kept. A detail file
written BEFORE this split (a stale CDN or service-worker entry, a rollback) has
no `records` key and is treated as a miss for the same reason.

**What it costs, stated rather than skipped.** The season records now exist
twice on the CDN: in `data-index.json`, which nothing in the browser fetches,
and in the detail files, which is where they are actually read. The detail
directory grew 192 -> 216 MB (+17%), so the mean detail file is 9.2 KB instead
of 7.7 KB and a modal open costs about 1.5 KB more. That is the trade: ~1.5 KB
on the opens a visitor chooses, against 2.8 MB removed from every boot whether
they open anything or not.

`data-index.json` is kept for two reasons, neither of them "a consumer we did
not want to migrate": it is the season-level dataset artifact, and it is the
input the full-catalogue parity test checks the show index against. It is not a
documented public download and nothing links it. Un-publishing it would save 34
MB of CDN storage and zero user-facing bytes, which is an owner decision about
a URL that has been live for a while rather than part of this change.

**The Kometa builder got its own slice.** That page reads eight per-season
fields and used to read them out of `data-index.json`, which was defensible
only while the Finder fetched the same file and warmed the cache. It now reads
`data/kometa-index.json`: 1.83 MB encoded instead of 5.88 MB.

**One latent difference, measured to be a no-op today.** The old
`buildSeriesIndex` back-filled the suggestion list's `poster`, `year` and
`seriesVotes` from LATER seasons when the first season lacked them
(`if (!entry.poster && m.poster) ...`, and `max` for votes). `buildShowAgg`
takes all three from the first season it sees and always did, so the GRID never
had that back-fill - the two surfaces disagreed in that edge case, and the
suggestion list now agrees with the card. On the current catalogue the
difference is empty: the full-catalogue suggestion-index parity test compares
every show's poster, year and votes against the back-filling implementation and
they match for all 34,615. It is written down because the next dataset could
contain a show where they do not, and then the answer is to give buildShowAgg
the back-fill (which moves the card too), not to re-introduce a second rule.

**Parity is asserted over the whole catalogue**, in
`tests/shows-index-parity.test.js`: every one of the 34,615 shipped show
records is compared field-for-field against what the pre-split boot fold
produces from the same season file, plus the suggestion index over the whole
catalogue and `computeShowRelated` over a 400-show spread (identical results,
identical order). A 0.01 change to one show's `gap` fails it. The pre-split
`computeShowRelated` is transcribed into that file as the reference, and it
reads `RELATED_VOTES_BAND` from `app.js` rather than carrying a copy - the copy
had already drifted to 40 against the app's 20 and made the "reference"
disagree with the app it was meant to reference.
