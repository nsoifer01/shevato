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
numbered season AND either (a) `title.episode.tsv` lists an episode
numbered after our last rated one and `seasonYear >= buildYear - 1`
(707 seasons), or (b) it is a current-year season with fewer than 60% of
the PREVIOUS season's rated episodes (40 more). An in-progress season
never receives big-finale, bad-finale or u-shaped, its series is skipped
by both series-level tags, and `deriveShowShapes` takes an optional
4th options arg so the whole-show trajectory is not labelled off it
either (the 3-arg call still means "finished").

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

Residual false negative, by design: a season IMDb lists only up to the
episode that has aired, when that is already >= 60% as long as the
previous season, stays unflagged. Hand-check of 120 seasons found 0
false positives among 45 flagged ones carrying a finale tag and 0 false
negatives among 30 recent last seasons.

Two related detector fixes shipped with it. `isBigFinale` rounded its
margin to 1 dp, which is right for 1-dp episode ratings but made the
effective threshold 0.05 when `deriveShowShapes` feeds it 2-dp season
averages (79 of 652 show-level big-finale shows led by under 0.1); it
now rounds at 4 dp. `isRising` accepted a perfectly flat curve while
`isDeclining` never did; it now needs one real increase, which is what
the chip's "kept climbing" copy claims (299 flat seasons, 58 shows).

Catalogue effect, measured with two full builds from identical TSVs:
big-finale -114 seasons, bad-finale -67, u-shaped -60, rising -299,
shape-drift -88, saved-best-for-last -61, every other shape unchanged;
197 shows changed dominant shape, 286 changed their shape set at all.

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
- **The vm test harness (`tests/app-features.test.js`) reaches only what
  `window._rsTestExports` lists** at the bottom of `js/app.js`. Watched
  and Compare were unreachable until exported there (2026-08-15); their
  localStorage contract (`rising-seasons:watched` / `:compare`, legacy
  namespace kept on purpose for pre-rebrand sync data) is now pinned.

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
