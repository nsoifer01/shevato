# Rising Shows

Rank whole TV shows by the **shape** of their IMDb episode ratings, not the average. The **Show Finder** aggregates every rated episode of a series into one row per show (total rated episodes, episode-weighted average episode rating, and the gap between that and the show's own IMDb rating), then lets you filter and sort to surface the shows whose seasons kept climbing, stayed consistently great, slow-burned into their back half, built to a big finale, or rebounded after a mid-run dip - plus the hidden gems whose episodes outscore their reputation. Open any show to see its season-by-season trajectory.

## How it works

1. A Node script (`scripts/build-data.js`) streams three gzipped TSV dumps from IMDb, joins episodes with their ratings, runs each season through eleven shape detectors (plus two series-level shapes applied across a show's seasons in a post-pass), and writes `data.json` with every season that passes the vote/episode floor (tagged with every shape it fits - seasons matching no shape are still included with `shapes: []`).
2. Three optional enrichment scripts pull TMDB metadata: `scripts/enrich-tmdb.js` for posters, overviews, and language; `scripts/enrich-providers.js` for US streaming providers (Netflix / Max / Prime / …); `scripts/fetch-season-overviews.js` for per-season plot summaries. The first two cache to `data/tmdb-cache.json` so they survive rebuilds; the third writes a side-file, `data/season-overviews.json`, that `build-data.js` merges onto each season.
3. `index.html` loads `data.json` in the browser and renders the **Show Finder**: one row per show (total rated episodes, episode-weighted average episode rating, the gap vs the show's IMDb rating, votes, total runtime) with show-shape chips, mood presets, search, grid + list views, tri-state genres, decade/year, language, sort, pagination (24 per page), and an active-filter bar. It draws a season-average sparkline per show - single-season shows draw their episode trajectory in a distinct orange. Watched tracking persists to localStorage, and all filter/view state lives in the URL hash so any view is shareable. No extra data or backend: it derives everything client-side from the fields already in `data.json`.
4. The show-shape chips classify each show by the shape of its per-season averages (the same eleven detectors `match.js` runs per episode, now loaded in the browser too, so there is one source of truth), so a "rising" show is one whose seasons kept getting better; a show needs 2+ seasons to carry a cross-season shape. The two categorical season tags (Saved best for last, Shape drift) also surface as chips: a show carries one whenever any of its seasons does, so those chips work for single-season shows too. Open any show to see a detail modal with its season-by-season trajectory. See the feature table below.

`data.json` and `data/show-modal-extras.json` are not tracked in git (they are ~150 MB per refresh and were bloating history). They live as gzipped assets on the rolling [`rising-shows-data` GitHub release](https://github.com/nsoifer01/shevato/releases/tag/rising-shows-data), refreshed daily by GitHub Actions and downloaded at build time by `scripts/fetch-data.js` (locally: `npm run fetch:rising-shows-data`). See [`DATA_README.md`](DATA_README.md) for the auto-refresh details.

## Shapes

| Shape          | Rule                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| Rising         | Each episode's rating ≥ the previous one (non-decreasing).                    |
| Consistent     | All episodes ≥ 8.0 with a spread of ≤ 0.5.                                    |
| Slow burn      | Second-half average ≥ first-half average + 0.6.                               |
| Big finale     | Finale beats every other episode by at least one IMDb step (0.1), so it is the season's clear peak. |
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

## Browser app features

| Feature                  | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Show Finder (main view)  | The app's single view: one result per show, aggregated across all of a show's seasons (total rated episodes, episode-weighted average episode rating, the gap vs the show's IMDb rating, votes, and total runtime). A row of **show-shape chips** and **mood presets** (see below), a search box with autocomplete suggestions (matching show title or IMDb ID, with typo-tolerant "Did you mean?" results, picking one opens that show), grid/list view toggle, tri-state genre chips (require / exclude in red / clear), decade buttons and a year range, a language filter, quick vote-threshold chips, gap-direction segments, and advanced numeric thresholds plus a sort dropdown. List view is a sortable table with clickable column headers; grid view shows show cards with a color-coded gap badge. Results are paginated (24 per page) with an active-filter chip bar, a "Clear filters" button, and a "Copy link" button. All filters live in the URL hash, so a shared or refreshed link reopens the same view. Click a card or row to open the show modal. |
| Show-shape filter        | Toggle one or more shape chips to filter shows by the **shape of their per-season averages** (not per episode): a "rising" show is one whose season averages keep climbing, "rebound" dips then recovers, "declining" never improves, and so on. Classified by the same eleven detectors `scripts/match.js` runs per episode, loaded in the browser so there's one source of truth, plus two categorical season tags (Saved best for last, Shape drift) that a show carries whenever any of its seasons does. A show needs ≥ 2 seasons to have a cross-season trajectory shape, so single-season shows are excluded while a trajectory-shape filter is active (the two categorical chips still match them). AND across selected shapes. Each chip's count updates as you pick shapes: an inactive chip shows how many current results would remain if you added it, and a shape that would drop results to zero is greyed/disabled rather than hidden so the row stays stable. Selected shapes show as removable chips in the active-filter bar and serialize to the hash (`shape=`). |
| Mood presets             | One-tap "Explore by mood" chips tuned to whole-show stats (Modern prestige, Crowd favorites, Kept climbing, Comeback stories, Marathon-worthy, Outshines its reputation), each with a count of how many shows it yields. Each applies an absolute filter combination - a couple lean on the show-level shapes (Kept climbing = rising, Comeback stories = rebound). Clicking the active preset clears it. The `.mood-collapsible` rail centers and collapses behind an "Explore by mood" toggle pill on mobile. |
| Genre filter (tri-state) | Click a chip to **require** that genre; click again to **exclude** it (red strike); third click clears. AND across required genres. Every genre in the catalogue renders as a chip, alphabetically, in the quick-filters panel (the advanced drawer no longer duplicates them). |
| Decade filter            | "80s / 90s / 00s / 10s / 20s" quick chips set the year range in one tap (synced with the advanced-drawer year inputs); "All" clears it. |
| Language filter          | Multi-select chips for the top original languages (TMDB `original_language`).                      |
| Streaming tags           | Where a show streams surfaces as display-only tags on cards and list rows and as badges in the show modal, limited to the mainstream services (Netflix, Hulu, Amazon Prime Video, HBO Max / Max, Disney+, Peacock, Paramount+, Apple TV+, Crunchyroll). There is no provider filter. |
| Hidden gems              | A "💎 Hidden gems" quick-filter chip surfaces highly rated but under-watched shows: episode-weighted average episode rating ≥ 8.5 and under 500 IMDb votes per rated episode. Composes with every other filter, shows as a removable chip in the active-filter bar, and serializes to the hash (`gems=on`). |
| Min seasons filter       | A "Min seasons" numeric input in the advanced "More filters" drawer, mirroring "Min episodes" exactly (live re-filtering, removable active-filter chip, `minSeasons=` hash param, cleared by "Clear filters"). It exists because a trajectory shape like "rising" is satisfied by any two-season show whose second season simply beat its first, which is close to a coin flip; requiring 3+ seasons keeps the shape chips meaning what they claim. |
| Surprise me / Popular pick | Two toolbar buttons for discovery. "🎲 Surprise me" opens a random show from the current filtered results; "🔥 Popular pick" opens a random show from the 50 most-voted of those results. Both do nothing when no shows match, and neither changes the URL. |
| Search matching          | The search box matches a show's title or its IMDb series ID (`tt…`) only, never episode names. Suggestions rank title-prefix hits first, then title substrings, then ID hits, and append typo-tolerant "Did you mean?" results under their own subheader. |
| Compare shows            | "+ Add to compare" on each show, then a floating button opens an overlay chart of season-trajectories for up to 5 series (persisted in localStorage). The overlay's action row carries four controls: **Copy compare link** (a `#compare=<ids>` permalink that reopens the same comparison for anyone who follows it; unknown ids in a shared link are skipped rather than throwing, and opening someone else's link does not overwrite your own stored set until you edit it), **Share chart image**, **Export to Kometa**, and "Clear all". |
| Export a comparison to Kometa | "Export to Kometa" in the compare overlay downloads a single collection YAML (`rising-shows-compare.yml`) for the 2-5 shows currently compared, built client-side by `scripts/integrations-lib.js` in the same field structure as the pre-built `exports/kometa/<shape>.yml` files. The collection name is generated from the compared titles. Shows with neither a TMDB nor a TVDB id are skipped rather than emitting a null entry. Hidden below 2 compared shows. |
| Season overlay           | In the show modal, all seasons drawn together on one chart with a legend; clicking a legend entry (the swatch or the S-number) hides/restores that season's line. |
| Best / worst badges      | Inline pill on the highest- and lowest-rated season of each series (skipped when all seasons tie). |
| Clickable shape pills    | The shape pills inside the show modal's season rows and the season detail modal are real buttons (Tab-reachable, Enter/Space activatable), not inert text. Activating one closes the modals and filters the grid to that shape. It also **clears the search box**, because you only ever reach a pill by looking up one specific show and leaving the query in place would AND it with the new shape and hand back that same show. This is a deliberate divergence from the toolbar shape chips, which do preserve the search term: a toolbar chip is a filter you are composing, a pill is a jump-to-similar action. |
| Season overview          | The season detail modal shows that season's own TMDB plot summary (from `scripts/fetch-season-overviews.js`, merged into `data.json` at build time), falling back to the show-level overview when the season has none. |
| Cast strip               | The show modal shows a top-billed cast strip, populated from `data/show-modal-extras.json` (the side-file holding cast, per-season overviews, and per-episode IMDb IDs / runtimes / titles, kept out of `data.json` so it stays under GitHub's file-size cap); the section stays hidden for series with no cast data. |
| Watched tracking         | Per-season watched toggle inside the show modal; persists in localStorage; the show modal shows a per-show watched count. |
| Cross-device sync        | For signed-in users, watched state and the compare set mirror to Firestore through `sync-system/` (namespace `risingSeasonsApp`, legacy `rising-seasons:*` keys kept on purpose so pre-rebrand data carries over). A change made on another device re-loads both sets, re-renders the grid and updates the compare counter, debounced 750 ms. Signed-out users stay fully functional on localStorage alone. |
| Sensitive posters        | Posters for titles carrying the IMDb "Adult" genre render blurred, with a light overlay: a small eye-off badge flags the content in the top-left corner and a prominent centered "Tap to reveal" pill is the action (badge-only on small thumbnails). The blur is deliberately the only obstruction, so the blurred artwork and the always-visible title still give context. Clicking reveals that one poster without opening its modal; the reveal is per-poster and per-session (re-blurs on reload). Applies to every surface: Finder cards and list rows, both the show and season detail modals, related-show rows, and search-suggestion thumbnails. Adult titles are detected by genre on any season; lightweight surfaces (suggestions) fall back to a precomputed adult-series-ID set. Fallback poster tiles (no TMDB image, just the title) are left legible since they show no art. |
| Above-IMDb badge         | Marks seasons whose average episode rating beats the show's overall IMDb score.                    |
| More shows like this     | The show modal lists up to 10 shows that share a genre, a compatible original language (English suggests English; other languages match within broad family groups - Romance, European, Asian, Middle Eastern), and a similar popularity (votes/episode within 10x). Ranked by **shared show-shape first**, with the gap between IMDb rating and average episode rating as the tiebreaker inside each tier, so a show that trends the same way outranks a same-genre show that merely has a closer gap. Each row names the shared shape in its meta line. Shows sharing no shape are not excluded, they fill the remaining slots up to the 10-result cap; a show carrying no shape at all falls back to the older genre/language/popularity/gap ranking. The first 4 show; an "N more" toggle expands the rest; click one to open that show. |
| "Watch on …" button      | When a show streams on the mainstream services, the show modal renders **one deep link per provider** (Netflix, Hulu, Prime Video, Max, Disney+, Peacock, Paramount+, Apple TV+, Crunchyroll), each into that streamer's own search for the title, so the set of links always matches the set of provider badges. Hidden when no known provider matches. |
| Permalink + outbound links | The show modal links to that show's static SEO page ("Permalink", `/apps/rising-shows/shows/<slug>-<seriesId>/`), to IMDb, and to TVDB when a TVDB ID is known. The season modal links to the season on IMDb and to the season (or the series, as a fallback) on TVDB. |
| Copy link                | A "Copy link" button in the active-filter bar copies the current filtered-view URL to the clipboard whenever any filter is active. |
| Share card               | A "Share card" button in both the show modal and the season detail modal copies a shareable text summary (title, shapes, ratings) to the clipboard. |
| Share chart image        | A "Share chart image" button next to "Share card" in the show modal, and in the compare overlay, composites the on-screen SVG curve plus the title, dominant shape and key stats onto an offscreen canvas and hands back a PNG (1200px wide). Uses `navigator.share({files})` where the browser supports it and falls back to a plain download otherwise, flashing "Shared!" / "Downloaded!" the way the existing copy buttons flash "Copied!". Everything is same-origin so the canvas is never tainted. The show-modal button is hidden for single-season shows, the same gate the overlay chart itself uses; the compare variant captures every legend entry in the colors `renderCompareLegend` assigned. |
| What's new               | A "What's new" chip in the footer opens a changelog modal (built from `changelog.json`) summarizing the latest daily data refresh: totals, shape shifts, shows added/dropped, notable rating swings, and data freshness. |
| Keyboard shortcuts       | `/` focuses the search box, `?` toggles a shortcuts popover (also opened by the `?` button in the toolbar), and `Esc` closes the topmost open thing (popover, changelog, compare overlay, season modal, show modal, advanced drawer). With a modal's ratings curve focused, `←` / `→` step through its episodes. |
| Scroll restoration       | Reloading or returning to the grid restores the previous scroll position (saved per tab in sessionStorage) once the grid has rendered; deep links to a modal or a real anchor win over the saved offset. |

## Static show pages (SEO)

`scripts/build-show-pages.js` (run via `npm run build:rising-shows:pages`, and on
every Netlify deploy through `npm run build:site`) renders one static HTML page per
series under `apps/rising-shows/shows/` plus an A-Z index, 14 hub pages (13 per-shape
plus one gap-ranked "Outshines its reputation" hub), and `sitemap-shows.xml`.
These are gitignored build artifacts, derived from `data.json` (which the build downloads from the `rising-shows-data` release first).

`sitemap-shows.xml` is deliberately curated: it lists only the top 2,000 series by
IMDb vote count (`SITEMAP_LIMIT` in `build-show-pages.js`), not all ~34k, plus the
A-Z index and the 14 hubs (2,015 URLs in total). Every page is still built
and reachable through the A-Z index for app users, but since 2026-08 the
non-curated pages carry `noindex, follow`: the 2026-05 full-catalogue launch put
~34k templated pages in front of Google, which crawled them and then declined to
index nearly all of them (GSC "Crawled - currently not indexed" ~60k by 2026-08,
with the site's search traffic collapsing in June under the sitewide quality
drag). Curating the sitemap alone did not shrink that backlog because the pages
still self-identified as indexable; the explicit noindex drains it while the
`follow` keeps internal link equity flowing to the curated pages. After the page builders run,
`scripts/stamp-sitemap-index.mjs` (repo root) re-stamps the root `sitemap.xml`
index's `<lastmod>` entries from the freshly generated sub-sitemaps.

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

**Gap hub ("Outshines its reputation").** A 14th hub at
`apps/rising-shows/shows/shape/outshines-reputation/`, built by the same
`renderHubPage` shell so it is structurally identical to the shape hubs, but selected and
ranked by **gap** (`avgEpisode - showRating`) rather than by shape membership:
the 100 biggest gaps, floored at 15,000 IMDb votes (`GAP_MIN_VOTES`). The floor exists
because an unfloored gap sort is owned by brigaded titles - the top result was a 451-vote
show averaging 9.9 per episode against a 1.3 series rating - and 15,000 is where the
existing `SITEMAP_LIMIT` curation already cuts off, so nearly every linked page is itself
indexable. The floor is stated in the page's own lede. This gives the gap metric, the
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
- No providers → provider tags, the show-modal badges, and the "Watch on …" button don't render.
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
the page loads `data.json` via `fetch`, and `js/app.js` is a `type="module"`
script, which the browser refuses to execute from a `file://` origin. The
module failure is the quieter of the two, since the page still renders its
shell and simply never becomes interactive.

```sh
cd apps/rising-shows
python3 -m http.server 8000
# open http://localhost:8000
```

The browser URL preserves your shape/genre/sort/search selection - paste a link to share a specific view.

## Running tests

```sh
npm run test:rising-shows
```

## Plex + Kometa + MDBList integrations

Rising Shows ships static Kometa collection YAMLs, season-poster overlay YAMLs, and flat MDBList ID lists under `exports/` - regenerated by `npm run export:rising-shows` and consumable directly from raw GitHub URLs without cloning. There is also a browser builder UI at `/apps/rising-shows/kometa/` and a `scripts/watch-next.js` CLI that queries a live Plex server.

See [`INTEGRATIONS.md`](INTEGRATIONS.md) for end-to-end setup, troubleshooting, and the customization seams.
