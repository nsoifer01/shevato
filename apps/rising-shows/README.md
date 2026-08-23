# Rising Shows

Rank whole TV shows by the **shape** of their IMDb episode ratings, not the average. The **Show Finder** aggregates every rated episode of a series into one row per show (total rated episodes, episode-weighted average episode rating, and the gap between that and the show's own IMDb rating), then lets you filter and sort to surface the shows whose seasons kept climbing, stayed consistently great, slow-burned into their back half, built to a big finale, or rebounded after a mid-run dip - plus the hidden gems whose episodes outscore their reputation. Open any show to see its season-by-season trajectory.

## How it works

1. A Node script (`scripts/build-data.js`) streams three gzipped TSV dumps from IMDb, joins episodes with their ratings, runs each season through eleven shape detectors (plus two series-level shapes applied across a show's seasons in a post-pass), and writes `data.json` with every season that passes the vote/episode floor (tagged with every shape it fits - seasons matching no shape are still included with `shapes: []`).
2. Three optional enrichment scripts pull TMDB metadata: `scripts/enrich-tmdb.js` for posters, overviews, and language; `scripts/enrich-providers.js` for US streaming providers (Netflix / Max / Prime / …); `scripts/fetch-season-overviews.js` for per-season plot summaries. The first two cache to `data/tmdb-cache.json` so they survive rebuilds and run daily in the refresh workflow; the third is a one-off that writes a tracked side-file, `data/season-overviews.json`, and is in no workflow. `build-data.js` applies the daily cache FIRST and uses the side-file only to fill gaps (never with its empty/null entries), so a stale snapshot can no longer override fresher text - it used to be the other way round, which pinned 12,149 seasons to July 2026 wording.
3. `index.html` loads `data-index.json` in the browser (see "Payload split" below) and renders the **Show Finder**: one row per show (total rated episodes, episode-weighted average episode rating, the gap vs the show's IMDb rating, votes, total runtime) with show-shape chips, mood presets, search, grid + list views, tri-state genres, decade/year, language, sort, pagination (24 per page), and an active-filter bar. It draws a season-average sparkline per show - single-season shows draw their episode trajectory in a distinct orange. Watched tracking persists to localStorage, and all filter/view state lives in the URL hash so any view is shareable. No extra data or backend: it derives everything client-side from the fields already in `data.json`.
4. The show-shape chips classify each show by the shape of its per-season averages (the same eleven detectors `match.js` runs per episode, now loaded in the browser too, so there is one source of truth), so a "rising" show is one whose seasons kept getting better; a show needs 2+ seasons to carry a cross-season shape. The two categorical season tags (Saved best for last, Shape drift) also surface as chips: a show carries one whenever any of its seasons does, so those chips work for single-season shows too. Open any show to see a detail modal with its season-by-season trajectory. See the feature table below.

`data.json` and `data/show-modal-extras.json` are not tracked in git (they are ~150 MB per refresh and were bloating history). They live as gzipped assets on the rolling [`rising-shows-data` GitHub release](https://github.com/nsoifer01/shevato/releases/tag/rising-shows-data), refreshed daily by GitHub Actions and downloaded at build time by `scripts/fetch-data.js` (locally: `npm run fetch:rising-shows-data`). See [`DATA_README.md`](DATA_README.md) for the auto-refresh details.

### Payload split (what the browser actually downloads)

The browser does **not** fetch `data.json`. It used to, alongside
`show-modal-extras.json`, and both were awaited before the grid could paint a
single card: about **38 MB** of transfer with `cache: 'no-store'` forcing a full
re-download on every visit. On a typical 10 Mbps mobile connection that is
roughly half a minute of blank page, every time.

Measured against the real file, two fields dominate `data.json`: `episodes`
(31.3 MB, 40%) and `overview` (18.2 MB, 24%). Neither is read by the grid, the
filters or the sort - both are modal-only. So `scripts/split-data.js` runs at
build time (wired into `build:site` after the page builders, and after
`fetch-data.js` has downloaded both release assets) and writes:

| File | What it is | Fetched |
|---|---|---|
| `data-index.json` | `data.json` minus `episodes`/`overview`, ~4.3 MB brotli | on load, the only thing first paint waits for, and the ONLY dataset fetch at boot |
| `data/detail/<seriesId>.json` | the stripped fields PLUS that show's slice of the modal extras: cast, per-season overviews (`ov`), per-episode ids/runtimes/titles (`eps`). Breaking Bad: ~10 KB | when a modal opens, memoised |
| `data/show-modal-extras.json` | the extras monolith (~67 MB raw). Input to the split and to `build-show-pages.js`; the app itself no longer fetches it on current deploys | legacy fallback only: on first modal open, never at boot, and only when the index lacks the `extrasInDetail` flag (artifacts split before the merge existed) |

`data-index.json` carries `extrasInDetail: true` whenever the splitter found
the extras file and merged it into the detail files; the app takes that flag
as its contract never to fetch the monolith. Before 2026-08-15 the app
fetched the whole extras file "in the background" right after the grid
rendered, which still pushed ~102 MB raw (~26 MB over the wire) at every
visitor whether or not they ever opened a modal. Measured over a local
no-gzip server: boot transfer went from 103,506,487 bytes to 35,978,695
(index + code, -65%), and a first modal open costs one ~10 KB detail file
instead of the old 4.5 KB file plus the 67 MB monolith riding in the
background.

Critical-path transfer stays ~4.3 MB brotli, and normal HTTP caching applies
so repeat visits cost nothing.

Two things the split has to preserve, both covered by tests in
`tests/finder-lib.test.js`:

- **`buildShowAgg` accepts either shape.** The Node side (`build-show-pages.js`,
  `export-integrations.js`, every unit test) still reads the unsplit
  `data.json` and keeps its per-episode walk. Split records instead carry
  `ratedCount` / `ratingSum`, folded down at build time, plus `epRatings` for
  single-season shows, whose card sparkline is drawn from episodes rather than
  season averages. Verified across the full catalogue: 34,508 rows both ways,
  zero aggregate and zero shape differences.
- **`aboveImdb` is precomputed.** Deciding whether a show's episodes average
  above its IMDb score was the last load-time reader of the episode arrays.
  The answer is identical for every visitor, so it ships as a list of the
  22,995 series that qualify (absent means false).

`data.json` itself is still built, deployed and left untouched, because the
static SEO pages render per-episode tables and curves from it.

## Shapes

| Shape          | Rule                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| Rising         | Each episode's rating ≥ the previous one, with at least one real increase (a perfectly flat season does not count). |
| Consistent     | All episodes ≥ 8.0 with a spread of ≤ 0.5.                                    |
| Slow burn      | Second-half average ≥ first-half average + 0.6.                               |
| Big finale     | Finale beats every other episode by at least one IMDb step (0.1), so it is the season's clear peak. The margin is measured to 0.01, so the same rule holds when the classifier runs over 2-decimal season averages. |
| Rebound        | A real interior dip (≥ 0.4 below the start/end), recovers above the start.    |
| Front-loaded   | First-half average ≥ second-half average + 0.6 (mirror of slow burn).         |
| Declining      | Each episode's rating ≤ the previous one, with first strictly > last.         |
| Bad finale     | Finale is the season's trough AND ≤ season average − 0.5.                     |
| Rollercoaster  | Many large adjacent direction-flips with a wide range (chaotic seasons).      |
| Mid-peak       | Peak sits in the middle half of the season, well above both edges.            |
| U-shaped       | Opener and finale are both season peaks (each strictly above every interior episode), with at least one interior dip ≥ 0.5 below the opener or finale. |
| Saved best for last | Series-level: a show with 3+ seasons whose final, highest-numbered season is also its highest-rated. |
| Shape drift    | Series-level: a show's final season changes its dominant shape from earlier seasons, or extends a ≥ 0.5 cross-season ratings decline. |

A season can match more than one shape - the card shows all of them.

**Seasons that are still airing.** A season the build can see is unfinished
(it still had an episode rated this year AND either IMDb lists an episode after
the last one we have a rating for, or it is much shorter than the season before
it) carries `inProgress` and
is never labelled Big finale, Bad finale, U-shaped or Saved best for last, and
its show is never labelled from it either: there is no finale yet to be good or
bad. The shapes that describe what has aired so far (rising, consistent, slow
burn, front-loaded, declining, rebound, rollercoaster, mid-peak) still apply.
409 of 66,380 seasons carry the flag on the 2026-08-22 build, every one of
them a 2026 season. See FINDINGS.md
for how the rule was derived and what it deliberately does not catch.

## Browser app features

| Feature                  | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Catalogue vs listed      | The dataset carries 34,692 series and a static page is generated for every one of them; the Finder lists 34,615. The 77-show difference is exactly the set of titles IMDb has no SERIES-level rating for, which is the number the gap metric, the show-rating filter and the hidden-gems rule are all measured against, so those shows cannot be scored or sorted here. They stay reachable through the A-Z index, their own static page (which omits an aggregate rating rather than inventing one) and a `#show=` deep link. |
| Show Finder (main view)  | The app's single view: one result per show, aggregated across all of a show's seasons (total rated episodes, episode-weighted average episode rating, the gap vs the show's IMDb rating, votes, and total runtime). A row of **show-shape chips** and **mood presets** (see below), a search box with autocomplete suggestions (matching show title or IMDb ID, with typo-tolerant "Did you mean?" results, picking one opens that show), grid/list view toggle, tri-state genre chips (require / exclude in red / clear), decade buttons and a year range, a language filter, quick vote-threshold chips, gap-direction segments, and advanced numeric thresholds plus a sort dropdown. List view is a sortable table whose column headers are real buttons (the table itself lives in a horizontal scroll region, so every column stays reachable between 641 px and the ~1,130 px the full table needs, with the show name pinned as a sticky first column); grid view shows show cards with a color-coded gap badge. **Every card and row carries the show's dominant shape** as a badge, plus one streaming chip where we know one: the app ranks shows by the shape of their ratings, and until 2026-08 that label was invisible while browsing. Results are paginated (24 per page) with an active-filter chip bar, a "Clear filters" button, and a "Copy link" button. All filters live in the URL hash, so a shared or refreshed link reopens the same view. Click a card or row to open the show modal. |
| Show-shape filter        | Toggle one or more shape chips to filter shows by the **shape of their per-season averages** (not per episode): a "rising" show is one whose season averages keep climbing, "rebound" dips then recovers, "declining" never improves, and so on. Classified by the same eleven detectors `scripts/match.js` runs per episode, loaded in the browser so there's one source of truth, plus two categorical season tags (Saved best for last, Shape drift) that a show carries whenever any of its seasons does. A show needs ≥ 2 seasons to have a cross-season trajectory shape, so single-season shows are excluded while a trajectory-shape filter is active (the two categorical chips still match them). AND across selected shapes. Each chip's count updates as you pick shapes: an inactive chip shows how many current results would remain if you added it, and a shape that would drop results to zero is greyed/disabled rather than hidden so the row stays stable. Selected shapes show as removable chips in the active-filter bar and serialize to the hash (`shape=`). |
| Mood presets             | One-tap "Explore by mood" chips tuned to whole-show stats (Modern prestige, Crowd favorites, Kept climbing, Comeback stories, Marathon-worthy, Outshines its reputation), each with a count of how many shows it yields. Each applies an absolute filter combination - a couple lean on the show-level shapes (Kept climbing = rising over 3+ seasons, Comeback stories = rebound). Two presets carry floors that make their copy true: Kept climbing requires 3 seasons (a two-season "rising" show is one season beating another, close to a coin flip, and 79% of rising shows are two-season shows) and Modern prestige requires 1,000 votes (without it, "prestige" returned 2,073 shows, most with a handful of ratings). Clicking the active preset clears it. The `.mood-collapsible` rail centers and collapses behind an "Explore by mood" toggle pill on mobile. |
| Genre filter (tri-state) | Click a chip to **require** that genre; click again to **exclude** it (red strike); third click clears. AND across required genres. Every genre in the catalogue renders as a chip, alphabetically, in the quick-filters panel (the advanced drawer no longer duplicates them). |
| Decade filter            | "80s / 90s / 00s / 10s / 20s" quick chips set the year range in one tap (synced with the advanced-drawer year inputs); "All" clears it. |
| Language filter          | Multi-select chips for the top original languages (TMDB `original_language`).                      |
| Streaming tags           | Where a show streams, limited to the mainstream services (Netflix, Hulu, Amazon Prime Video, HBO Max / Max, Disney+, Peacock, Paramount+, Apple TV+, Crunchyroll) through the shared `scripts/providers-lib.js` vocabulary. That module is the ONLY definition of which services exist and how their TMDB plan and channel variants collapse to a brand: `build-data.js` normalizes with it, `render-show-page.js` renders the static pages from it, and `index.html` loads it before `app.js` so the browser displays from the same list. The app used to carry its own copy. Result tiles carry **one** chip (the first mainstream service) next to the shape badge; the show modal lists every one of them as a link. There is no provider filter. |
| Hidden gems              | A "💎 Hidden gems" quick-filter chip surfaces highly rated but under-watched shows: episode-weighted average episode rating ≥ 8.5 and under 500 IMDb votes per rated episode. Composes with every other filter, shows as a removable chip in the active-filter bar, and serializes to the hash (`gems=on`). |
| Min seasons filter       | A "Min seasons" numeric input in the advanced "More filters" drawer, mirroring "Min episodes" exactly (live re-filtering, removable active-filter chip, `minSeasons=` hash param, cleared by "Clear filters"). It exists because a trajectory shape like "rising" is satisfied by any two-season show whose second season simply beat its first, which is close to a coin flip; requiring 3+ seasons keeps the shape chips meaning what they claim. |
| Surprise me / Popular pick | Two toolbar buttons for discovery. "🎲 Surprise me" opens a random show from the current filtered results; "🔥 Popular pick" opens a random show from the 50 most-voted of those results. Both flash "No shows match" in the button itself when the filters match nothing (they used to do nothing at all, which reads as a broken button), and neither changes the URL. |
| Search matching          | The search box matches a show's title or its IMDb series ID (`tt…`) only, never episode names. Matching is **diacritic-folded on both sides**, so "Pokemon" finds "Pokémon", "Shogun" finds "Shōgun" and "Elite" finds "Élite" (each of those used to return nothing). Suggestions rank title-prefix hits first, then title substrings, then ID hits, and append typo-tolerant "Did you mean?" results under their own subheader; the matched fragment is highlighted in the real title through an offset map, since folding can change length. |
| Compare shows            | "+ Add to compare" on each show, then a floating button opens an overlay chart of season-trajectories for up to 5 series (persisted in localStorage). When the compared shows differ in length, a **Fit to each run** toggle redraws every show across the full width (axis: Start / 25% / Halfway / 75% / End) so a 2-season show is not squashed into the first few percent by a 37-season one; the default stays absolute season numbers. The overlay's action row carries **Copy compare link** (a `#compare=<ids>` permalink that reopens the same comparison for anyone who follows it; unknown ids in a shared link are skipped rather than throwing). A comparison that arrives in a link is READ-ONLY against storage: the overlay shows it, says so, and names how many shows your own saved comparison still holds, and nothing you do to the shared set (removing a show, adding one, Clear all) is written down. Your own set comes back on the next reload without the link, and "Keep this comparison" is the one action that adopts the shared set as yours, **Share chart image**, **Export to Kometa**, and "Clear all". |
| Export a comparison to Kometa | "Export to Kometa" in the compare overlay downloads a single collection YAML (`rising-shows-compare.yml`) for the 2-5 shows currently compared, built client-side by `scripts/integrations-lib.js` in the same field structure as the pre-built `exports/kometa/<shape>.yml` files. The collection name is generated from the compared titles. Shows with neither a TMDB nor a TVDB id are skipped rather than emitting a null entry. Hidden below 2 compared shows. |
| Season overlay           | In the show modal, all seasons drawn together on one chart with a legend; clicking a legend entry (the swatch or the S-number) hides/restores that season's line. Past 6 seasons the chart opens on a readable shortlist - first, best, worst and latest - with a "Show all N seasons" toggle beside the legend, because 37 lines (The Simpsons) or 77 (Formula 1) is decoration rather than a chart. A caption states what a line is. |
| Best / worst badges      | Inline pill on the highest- and lowest-rated season of each series (skipped when all seasons tie). |
| Clickable shape pills    | The shape pills inside the show modal's season rows and the season detail modal are real buttons (Tab-reachable, Enter/Space activatable), not inert text. Activating one closes the modals and filters the grid to that shape. It also **clears the search box**, because you only ever reach a pill by looking up one specific show and leaving the query in place would AND it with the new shape and hand back that same show. This is a deliberate divergence from the toolbar shape chips, which do preserve the search term: a toolbar chip is a filter you are composing, a pill is a jump-to-similar action. |
| Season overview          | The season detail modal shows that season's own TMDB plot summary (from the daily `enrich-tmdb.js` cache, with the tracked `data/season-overviews.json` snapshot filling gaps; merged into `data.json` at build time), falling back to the show-level overview when the season has none. |
| Cast strip               | The show modal shows a top-billed cast strip, populated from the show's `data/detail/<seriesId>.json` (split-data merges each show's slice of `data/show-modal-extras.json` - cast, per-season overviews, per-episode IMDb IDs / runtimes / titles - into its detail file, so one small fetch on modal open carries everything); the section stays hidden for series with no cast data. |
| Watched tracking         | Per-season watched toggle inside the show modal; persists in localStorage; the show modal shows a per-show watched count. |
| Cross-device sync        | For signed-in users, watched state and the compare set mirror to Firestore through `sync-system/` (namespace `risingSeasonsApp`, legacy `rising-seasons:*` keys kept on purpose so pre-rebrand data carries over). A change made on another device re-loads both sets, re-renders the grid and updates the compare counter, debounced 750 ms. Signed-out users stay fully functional on localStorage alone. |
| Sensitive posters        | Posters for titles carrying the IMDb "Adult" genre render blurred, with a light overlay: a small eye-off badge flags the content in the top-left corner and a prominent centered "Tap to reveal" pill is the action (badge-only on small thumbnails). The blur is deliberately the only obstruction, so the blurred artwork and the always-visible title still give context. Clicking reveals that one poster without opening its modal; the reveal is per-poster and per-session (re-blurs on reload). Applies to every surface: Finder cards and list rows, both the show and season detail modals, related-show rows, and search-suggestion thumbnails. Adult titles are detected by genre on any season; lightweight surfaces (suggestions) fall back to a precomputed adult-series-ID set. Fallback poster tiles (no TMDB image, just the title) are left legible since they show no art. |
| Above-IMDb badge         | Marks seasons whose average episode rating beats the show's overall IMDb score. The show-level pill in the modal reads the same precomputed `aboveImdb` list the grid does, so the two surfaces cannot disagree. |
| One average, everywhere  | "Avg episode" is the episode-weighted mean over every rated episode (`sum(ratings) / count`), rounded to 2 dp, on the card, in the list row, in the modal, in the share card and on the share image, and the same fold decides the Above-IMDb verdict everywhere (all surfaces read one precomputed list). The static pages carry no show-level average in the body; the one they put in `og:image:alt` and `twitter:data2` is the same quantity computed in the page renderer and printed at 1 dp, which can differ from the app's 2 dp figure by a single rounding step. The modal used to compute an unweighted mean of the per-season averages instead, which differed at 1 dp for 2,784 multi-season shows (Master of None: 7.97 on its card, 7.6 in its modal) and flipped the Above-IMDb verdict for 162 of them. |
| Degraded detail          | The per-show detail fetch can fail (offline, a 404, a half-deployed build). The modal then keeps every index-level number - season count, rated episodes, averages, shapes, providers, links - says in plain language that the episode-by-episode data could not be loaded, and offers a **Retry** that really refetches. It used to render "0 episodes", empty charts and a "NaN votes per episode" line with no explanation. |
| More shows like this     | The show modal lists up to 10 shows that share a genre, a compatible original language (English suggests English; other languages match within broad family groups - Romance, European, Asian, Middle Eastern), and a similar popularity (votes/episode within 10x). Ranked by **shared show-shape first**, with the gap between IMDb rating and average episode rating as the tiebreaker inside each tier, so a show that trends the same way outranks a same-genre show that merely has a closer gap. Each row names the shared shape in its meta line. Shows sharing no shape are not excluded, they fill the remaining slots up to the 10-result cap; a show carrying no shape at all falls back to the older genre/language/popularity/gap ranking. The first 4 show; an "N more" toggle expands the rest; click one to open that show. |
| "Watch on" row           | The show modal's provider chips ARE the links: one per mainstream service, each into that streamer's own search for the title, under a "Watch on" label and a plain-language note that a link opens a search rather than promising the title is playable. This replaced a stack of up to five separate "Watch on X" buttons that duplicated the badge row and pushed the show's own content below two screens on a phone. Hidden when no known provider matches. |
| Permalink + outbound links | The show modal links to that show's static SEO page ("Permalink", `/apps/rising-shows/shows/<slug>-<seriesId>/`), to IMDb, and to TVDB when a TVDB ID is known. The season modal links to the season on IMDb and to the season (or the series, as a fallback) on TVDB. |
| Copy link                | A "Copy link" button in the active-filter bar copies the current filtered-view URL to the clipboard whenever any filter is active. |
| Share card               | A "Share card" button in both the show modal and the season detail modal copies a shareable text summary (title, shapes, ratings) to the clipboard. |
| Share chart image        | A "Share chart image" button next to "Share card" in the show modal, and in the compare overlay, composites the on-screen SVG curve plus the title, dominant shape and key stats onto an offscreen canvas and hands back a PNG (1200px wide). Uses `navigator.share({files})` where the browser supports it and falls back to a plain download otherwise, flashing "Shared!" / "Downloaded!" the way the existing copy buttons flash "Copied!". Everything is same-origin so the canvas is never tainted. The show-modal button is hidden for single-season shows, the same gate the overlay chart itself uses; the compare variant captures every legend entry in the colors `renderCompareLegend` assigned. |
| What's new               | A "What's new" chip in the footer opens a changelog modal (built from `changelog.json`) summarizing the latest daily data refresh: totals, shape shifts, shows added/dropped, notable rating swings, and data freshness. |
| Keyboard shortcuts       | `/` focuses the search box, `?` toggles a shortcuts popover (also opened by the `?` button in the toolbar), and `Esc` steps back one level: it dismisses the popover, the changelog or the compare overlay, and inside the show/season modals it does exactly what the header's back arrow does, returning to the view you drilled in from and only closing when there is nowhere left to step back to (the x button and a backdrop click still leave outright). With a modal's ratings curve focused, `←` / `→` step through its episodes. |
| Scroll restoration       | Reloading or returning to the grid restores the previous scroll position (saved per tab in sessionStorage) once the grid has rendered; deep links to a modal or a real anchor win over the saved offset. |

## Static show pages (SEO)

`scripts/build-show-pages.js` (run via `npm run build:rising-shows:pages`, and on
every Netlify deploy through `npm run build:site`) renders one static HTML page per
series under `apps/rising-shows/shows/` plus an A-Z index, 14 hub pages (13 per-shape
plus one gap-ranked "Outshines its reputation" hub), and `sitemap-shows.xml`.
These are gitignored build artifacts, derived from `data.json` (which the build downloads from the `rising-shows-data` release first).

`sitemap-shows.xml` is deliberately curated: it lists only the top 2,000 series by
IMDb vote count (`SITEMAP_LIMIT` in `build-show-pages.js`), not all ~34k, plus the
A-Z index, its 83 paginated per-letter pages (`/shows/letter/<x>/<n>/`, 500 rows
each) and the 14 hubs: 2,098 URLs in total. The letter pages are listed because
they ARE the crawl path to the ~32,500 shows the sitemap omits: `/shows/` alone
links only to the letter roots. Every page is still built
and reachable through the A-Z index for app users, but since 2026-08 the
non-curated pages carry `noindex, follow`: the 2026-05 full-catalogue launch put
~34k templated pages in front of Google, which crawled them and then declined to
index nearly all of them (GSC "Crawled - currently not indexed" ~60k by 2026-08,
with the site's search traffic collapsing in June under the sitewide quality
drag). Curating the sitemap alone did not shrink that backlog because the pages
still self-identified as indexable; the explicit noindex drains it while the
`follow` keeps internal link equity flowing to the curated pages. After the page builders run,
`scripts/stamp-sitemap-index.mjs` (repo root) re-derives the root `sitemap.xml`
index's `<lastmod>` entries from the sub-sitemaps and stamps `sitemap-pages.xml`
from git history. `sitemap-shows.xml` itself carries NO `<lastmod>`: the only
date the builder has is the daily build time, which is not a content date, so
the index entry for it carries none either.

Each page (`scripts/render-show-page.js`) emits:

- `BreadcrumbList` and `TVSeries` JSON-LD, plus one `TVSeason` block per season with
  `aggregateRating` (rating value + vote count), `partOfSeries`, and a `#season-N` URL,
  so search engines can surface per-season rating data.
- A season jump nav (`S1 S2 S3 …`) on shows with 4 or more seasons, linking to each
  `#season-N` anchor.
- Open Graph and Twitter card meta, including `og:image:alt` and `twitter:label`/`data`
  pairs that carry the dominant shape and average episode rating into link previews.
- A dismissible sticky banner CTA pinned to the bottom of the page (title + dominant-shape
  badge + "Explore by shape in the app"), linking into the shape-filtered explorer view
  (`/apps/rising-shows/#shape=<slug>`).

**Shape hubs.** `scripts/render-shape-hub.js` renders one topic landing page per shape at
`apps/rising-shows/shows/shape/<slug>/` (13 of them: `rising`, `consistent`, `slow-burn`,
`big-finale`, `rebound`, `front-loaded`, `declining`, `bad-finale`, `rollercoaster`,
`mid-peak`, `u-shaped`, `saved-best-for-last`, `shape-drift`). A show appears on exactly
one hub, the one matching its **dominant shape**: the first entry of the show's whole-run
trajectory, computed by `computeDominantShape` in `render-show-page.js`, which delegates to
finder-lib's `deriveShowShapes` - the same derivation `buildShowAgg` runs for the browser
Finder, so a page's badge and the app's shape chips cannot disagree. Ranked by IMDb vote
count and capped at the top 100; the `CollectionPage` JSON-LD `ItemList` carries the first 25.

Until 2026-08-08 the dominant shape was instead the first shape tag of the show's single
highest-rated season, which describes the EPISODES inside that one season rather than the
show's trajectory. The two answered different questions and disagreed for 83.5% of the
catalogue (6,497 of the 7,780 shows where both produced a label): Game of Thrones read
"slow burn" on its page and "front-loaded, bad-finale, shape-drift" in the app, Stranger
Things read "big finale" against the app's "bad-finale". Because the same function decides
hub membership, `/shows/shape/big-finale/` was listing 1,915 of 5,411 shows that the app's
own big-finale filter would reject. Expect some hubs to be smaller than before (rebound
and rollercoaster especially): they are no longer padded with shows whose best season
merely happened to have that internal shape. Note that a few shapes can never be dominant,
because `detectShapes` emits trajectory shapes in a fixed order and `rebound` always trails
`slow-burn` and `big-finale`; those hubs fill only from shows where the earlier shapes do
not apply.
Each hub cross-links the others, the A-Z index, and the shape-filtered explorer view
(`/apps/rising-shows/#shape=<slug>`). The per-season shape badges on show pages and the
"See all X shows" link under the recommendations point at these hubs, the A-Z index carries
a "Browse by shape" strip, and all hub URLs are listed in `sitemap-shows.xml`.

Static pages print the same 9 mainstream streaming brands the app does, through
the shared `scripts/providers-lib.js` normalizer: they used to print TMDB's raw
237-string vocabulary, including three spellings of BritBox and a
`"Britbox Apple TV Channel "` with a trailing space. The A-Z index buckets a
title by its first letter with Latin diacritics folded, so "Çilgin Dersane"
files under C rather than "#" (non-Latin scripts stay in "#"; the displayed
title is never folded).

**Gap hub ("Outshines its reputation").** A 14th hub at
`apps/rising-shows/shows/shape/outshines-reputation/`, built by the same
`renderHubPage` shell so it is structurally identical to the shape hubs, but selected and
ranked by **gap** (`avgEpisode - showRating`) rather than by shape membership:
the 100 biggest gaps, floored at 15,000 IMDb votes (`GAP_MIN_VOTES`). The floor exists
because an unfloored gap sort is owned by brigaded titles - the top result was a 451-vote
show averaging 9.9 per episode against a 1.3 series rating - and 15,000 is where the
existing `SITEMAP_LIMIT` curation already cuts off, so nearly every linked page is itself
indexable. A second, symmetric floor (`GAP_MIN_EPISODE_VOTES`, also 15,000) applies to
the show's TOTAL episode votes, because the gap subtracts two ratings and only one of them
was guarded: the old number one, Kaamraj, set a 7.1 episode average on 358 episode votes
against an IMDb 3.6 from 19,239 series votes. With both floors, 36 of the 100 rows change
and the gap range tightens from 3.5-0.8 to 2.7-0.6. Both floors are stated in the page's
own lede. This gives the gap metric, the
app's most distinctive signal, a durable indexable URL; previously it was reachable only
through the in-app Hidden gems chip or the "Outshines its reputation" mood preset. Each
row's stats cell prints the gap itself (`avg episode 8.6 · IMDb 7.9 · +0.7 above IMDb`).

**Sensitive (adult) posters.** Pages for titles carrying the IMDb "Adult" genre blur
the hero poster (and any adult related-show thumbnail) behind a CSS-only click-to-reveal
overlay - a hidden checkbox toggled by the overlay label, since these static pages ship
no app JS. Because a link/search preview image can't be blurred, the `og:image`,
`twitter:image`, and the `TVSeries` JSON-LD `image` are swapped for the neutral site card
(`/images/og-card.png`, 1200x630) for adult titles, so no explicit art leaks into social
or search results.

## One-time setup

To just run the app locally, skip the build entirely and download the
current dataset from the release:

```sh
npm run fetch:rising-shows-data
```

To rebuild the dataset from scratch instead:

1. Download the three dataset files from <https://datasets.imdbws.com/> into `apps/rising-shows/data/`:

   ```sh
   cd apps/rising-shows/data
   curl -O https://datasets.imdbws.com/title.basics.tsv.gz
   curl -O https://datasets.imdbws.com/title.episode.tsv.gz
   curl -O https://datasets.imdbws.com/title.ratings.tsv.gz
   ```

   ~250 MB compressed. The TSVs are git-ignored.

2. From the repo root:

   ```sh
   npm run build:rising-shows
   ```

   ~20 seconds. Writes `apps/rising-shows/data.json` (also git-ignored - it's a build artifact). IMDb republishes the dumps daily, so re-running picks up new ratings.

## Optional: TMDB enrichment

The app uses TMDB for posters, show and per-season plot summaries, original language, and US streaming providers. All of it is optional: `data.json` is valid without any of it.

1. Sign up at <https://www.themoviedb.org/signup>.
2. Generate a v4 read access token at <https://www.themoviedb.org/settings/api>.
3. Run the three enrichment scripts in order, then rebuild so `data.json` picks up the caches:

   ```sh
   # Posters + overviews + original_language (one /find call per series).
   TMDB_TOKEN=eyJh...your_token... npm run enrich:rising-shows

   # US watch providers (one /tv/{id}/watch/providers call per series).
   TMDB_TOKEN=eyJh...your_token... npm run enrich:rising-shows:providers

   # Per-season plot summaries (one /tv/{id}/season/{n} call per season).
   # Reads data.json + tmdb-cache.json, so run it after a first build; it
   # writes data/season-overviews.json rather than touching the shared cache.
   TMDB_TOKEN=eyJh...your_token... node apps/rising-shows/scripts/fetch-season-overviews.js

   # Merge all of it into data.json.
   npm run build:rising-shows
   ```

   All three scripts are incremental: they skip entries that already have the data they fetch, so re-runs only hit TMDB for new or previously-failed series (and seasons). First-run cost is ~15-20 minutes for posters and another ~25-30 for providers (both throttled to ~6 req/s); the season pass walks every season instead of every series, so it is the longest of the three.

The app degrades gracefully without each layer:
- No posters → cards show a gradient placeholder.
- No language → language filter chips just don't render.
- No providers → the tile chip and the show modal's "Watch on" row don't render.
- No season overviews → the season modal falls back to the show-level overview.

## Build tunables

Pass via env vars to `build-data.js`:

| Var            | Default | Meaning                                          |
| -------------- | ------- | ------------------------------------------------ |
| `MIN_EPISODES` | `3`     | Skip seasons with fewer rated episodes           |
| `MIN_VOTES`    | `5`     | Every episode must have at least this many votes |

The default vote floor is deliberately low - IMDb's per-episode vote counts can be tiny for older shows, foreign series, reality TV, and short-run formats, and a high floor at build time wipes them out. The browser UI exposes its own minimum-votes filter and a popularity-sorted view, so building wide and filtering narrow in the UI is the easy path.

## Viewing locally

Serve the directory rather than opening `file://`. Two independent reasons now:
the page loads `data-index.json` via `fetch`, and `js/app.js` is a `type="module"`
script, which the browser refuses to execute from a `file://` origin. The
module failure is the quieter of the two, since the page still renders its
shell and simply never becomes interactive.

```sh
cd apps/rising-shows
python3 -m http.server 8000
# open http://localhost:8000
```

The browser URL preserves your shape/genre/sort/search selection - paste a link to share a specific view.

## Tests

```sh
npm run test:rising-shows        # this app only
npm test                         # the whole repo, run this before any commit
```

Everything runs under `node --test`: no browser, no server, no fixtures on disk
outside `os.tmpdir()`.

| File | What it covers |
| --- | --- |
| `tests/match.test.js` | the eleven shape detectors and `findMatches` (the vote/episode floors, the projection, `seasonYear`), plus the in-progress rule: an unfinished season never gets a finale-dependent shape, a finished short season still does |
| `tests/finder-lib.test.js` | `buildShowAgg` (both the full-record and the split-record input shapes), hash parsing, the filter predicates, and the sort comparator |
| `tests/build-data.test.js` | the IMDb pipeline end to end: rating aggregation, the vote/episode floors, unrated episodes, `\N` season and episode numbers, `seasonYear` / `avgRuntime`, the genre and language tallies, provider normalisation, and the modal side-file split |
| `tests/split-data.test.js` | the payload split: that the emitted `data-index.json` aggregates identically to the unsplit `data.json` through the real `buildShowAgg`, that index + detail rehydrates losslessly, and the `aboveImdb` rules |
| `tests/build-changelog.test.js` | `diffDatasets` / `appendEntry`, plus the CLI's missing-baseline guard |
| `tests/integrations-lib.test.js` | Kometa collection + overlay YAML, MDBList id lists, and the compare-export naming |
| `tests/render-show-page.test.js`, `render-shape-hub.test.js`, `render-curve.test.js`, `render-sitemap.test.js`, `slugify.test.js` | the static page builders, their JSON-LD, and slug/permalink stability |
| `tests/app-features.test.js` | browser helpers reached through a `node:vm` sandbox (see below): the canonical weighted `avgEpisode`, diacritic folding, the related-show gates and ranking, the NaN guards, and the scroll/watched/compare stores |

`build-data.js` and `split-data.js` hardcode their input and output paths off
`__dirname` and take no overrides, so their tests copy the real script into a
throwaway app tree under `os.tmpdir()` and run it there against tiny TSV / JSON
fixtures. The bytes under test are the production bytes; only the tree around
them is a fixture, and the app's real `data.json` is never read or written.

`app-features.test.js` loads `js/app.js` into a `node:vm` context with stubbed
browser globals (DOM, `localStorage`, `sessionStorage`, `location`, `fetch`) and
drives whatever `window._rsTestExports` exposes at the bottom of `app.js`.
Helpers that are not on that list are not reachable from Node, so anything that
needs coverage has to be exported there first. One gotcha: objects and arrays
built INSIDE the vm carry that realm's prototypes, so `assert.deepEqual` (strict)
fails against a test-realm literal even when the contents match. Compare their
contents (`ids.join(',')`, field by field) instead.

## Plex + Kometa + MDBList integrations

Rising Shows ships static Kometa collection YAMLs, season-poster overlay YAMLs, and flat MDBList ID lists under `exports/` - regenerated by `npm run export:rising-shows` and consumable directly from raw GitHub URLs without cloning. There is also a browser builder UI at `/apps/rising-shows/kometa/` and a `scripts/watch-next.js` CLI that queries a live Plex server.

See [`INTEGRATIONS.md`](INTEGRATIONS.md) for end-to-end setup, troubleshooting, and the customization seams.
