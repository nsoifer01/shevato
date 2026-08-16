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
