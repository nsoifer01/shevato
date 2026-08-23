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
  a 125-vote show whose fans rate every episode 10.0 no longer earns it.
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
  failed shows "Episode details could not be loaded. Retry"; season rows fall
  back to the index's `episodeCount` via `seasonEpisodeCount()` instead of
  printing "0 eps" (the three share-card builders use it too). Retry works
  because `ensureDetail` already evicts failed fetches. Pinned by a browser
  check that 404s `data/detail/*` with the cache disabled.
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
