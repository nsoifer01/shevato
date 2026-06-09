# Rising Seasons

Find TV shows by the **shape** of their IMDb episode ratings, not the average. Browse seasons that rise, stay consistently great, slow-burn into the back half, build to a big finale, or rebound after a mid-season dip.

## How it works

1. A Node script (`scripts/build-data.js`) streams three gzipped TSV dumps from IMDb, joins episodes with their ratings, runs each season through eleven shape detectors (plus two series-level shapes applied across a show's seasons in a post-pass), and writes `data.json` with every season that passes the vote/episode floor (tagged with every shape it fits — seasons matching no shape are still included with `shapes: []`).
2. Two optional enrichment scripts pull TMDB metadata: `scripts/enrich-tmdb.js` for posters, overviews, and language; `scripts/enrich-providers.js` for US streaming providers (Netflix / Max / Prime / …). Both cache to `data/tmdb-cache.json` so they survive rebuilds.
3. `index.html` loads `data.json` in the browser and renders shape chips, filters, an SVG curve per season, and a per-season detail modal. The browser app supports grid + list views, watched tracking (localStorage), pagination via IntersectionObserver, and shareable URL state.

`data.json` is committed to the repo and refreshed weekly by GitHub Actions — no manual updates needed. See [`DATA_README.md`](DATA_README.md) for the auto-refresh details.

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

A season can match more than one shape — the card shows all of them.

## Browser app features

| Feature                  | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Show Finder              | A top-level mode (toggle "Seasons" / "Show Finder" under the hero) that swaps the season grid for one result per show, aggregated across all of a show's seasons (total rated episodes, episode-weighted average episode rating, the gap vs the show's IMDb rating, votes, and total runtime). Mirrors the Seasons UI: a title search, grid/list view toggle, tri-state genre chips (require / exclude in red / clear), decade buttons and a year range, a language filter, quick vote-threshold chips, gap-direction segments, and advanced numeric thresholds plus a sort dropdown. List view is a sortable table with clickable column headers; grid view shows show cards with a color-coded gap badge. Results are paginated (24 per page) with an active-filter chip bar, a "Clear filters" button, and a "Copy link" button. The mode and all finder filters live in the URL hash (`view=finder&...`), so a shared or refreshed finder link reopens the finder with its filters; a base URL or "Clear filters" returns to the Seasons view. Click a card or row to open the show modal. |
| Shape filter             | Toggle one or more shape chips; AND across selected shapes.                                        |
| Mood presets             | One-tap "Explore by mood" chips that apply a curated filter combination, including shape-anchored picks (Best rebounders, Unmissable finales, Hidden slow-burns, Worst endings). The rail shows the first 6 moods; the rest sit behind a "More moods +N" toggle (an active mood is never hidden). On mobile the whole strip is additionally collapsed behind a toggle pill. |
| Genre filter (tri-state) | Click a chip to **require** that genre; click again to **exclude** it (red strike); third click clears. AND across required genres. The top 8 genres live as chips in the quick-filters panel (the advanced drawer no longer duplicates them). |
| Decade filter            | "80s / 90s / 00s / 10s / 20s" quick chips set the year range in one tap (synced with the advanced-drawer year inputs); "All" clears it. |
| Language filter          | Multi-select chips for the top original languages (TMDB `original_language`).                      |
| Streaming filter         | Multi-select chips for top US watch providers (Netflix, HBO Max, Prime …).                         |
| Hidden gems toggle       | Surfaces seasons with avg ≥ 8.5 *and* fewer than 500 votes per episode.                             |
| Surprise me / Popular pick | "Surprise me" jumps to a random season matching the active filters; "Popular pick" draws that random pick from the 50 most-watched matches. |
| Episode-title search     | Searching ≥3 chars also matches against episode names — "Gray Matter" → Breaking Bad.              |
| Compare shows            | "+ Add to compare" on each show, then a floating button opens an overlay chart of season-trajectories for up to 5 series (persisted in localStorage). |
| Season overlay           | In the show modal, all seasons drawn together on one chart with a legend; clicking a legend entry (the swatch or the S-number) hides/restores that season's line. |
| Best / worst badges      | Inline pill on the highest- and lowest-rated season of each series (skipped when all seasons tie). |
| Watched tracking         | Per-season toggle; persists in localStorage; "watched / unwatched" filters and stats.              |
| Above-IMDb badge         | Marks seasons whose average episode rating beats the show's overall IMDb score.                    |
| Sort options             | Popularity, season length, rating climb (last vs first), finale rating, season average, most recent, and most volatile (episode-to-episode standard deviation). |
| More seasons like this   | The season detail modal lists up to 10 related seasons (sharing a shape **and** a genre, a compatible original language, similar average, votes/episode within 10x, different series), ranked by a likeness score (shared shapes, then rating closeness, then votes). English seasons only suggest English; other languages match within broad family groups (Romance, European, Asian, Middle Eastern), so a Korean season can surface Japanese shows. The first 4 show; a "6 more" toggle expands the rest. Click one to open it. The section is shown whenever at least one match exists. |
| More shows like this     | The show modal lists up to 10 shows that share a genre, a compatible original language (same family-group rule as above), and a similar popularity (votes/episode within 10x), with the closest gap between their IMDb rating and their average episode rating. Same 4 + "N more" pattern; click one to open that show. |
| Copy link                | A "Copy link" button in the active-filter bar copies the current filtered-view URL to the clipboard whenever any filter is active. |
| Scroll restoration       | Reloading or returning to the grid restores the previous scroll position (saved per tab in sessionStorage) once the grid has rendered; deep links to a modal or a real anchor win over the saved offset. |

## Static show pages (SEO)

`scripts/build-show-pages.js` (run via `npm run build:rising-seasons:pages`, and on
every Netlify deploy through `npm run build:site`) renders one static HTML page per
series under `apps/rising-seasons/shows/` plus an A-Z index and `sitemap-shows.xml`.
These are gitignored build artifacts, derived from the committed `data.json`.

Each page (`scripts/render-show-page.js`) emits:

- `BreadcrumbList` and `TVSeries` JSON-LD, plus one `TVSeason` block per season with
  `aggregateRating` (rating value + vote count), `partOfSeries`, and a `#season-N` URL,
  so search engines can surface per-season rating data.
- A season jump nav (`S1 S2 S3 …`) on shows with 4 or more seasons, linking to each
  `#season-N` anchor.
- Open Graph and Twitter card meta, including `og:image:alt` and `twitter:label`/`data`
  pairs that carry the dominant shape and average episode rating into link previews.

## One-time setup

1. Download the three dataset files from <https://datasets.imdbws.com/> into `apps/rising-seasons/data/`:

   ```sh
   cd apps/rising-seasons/data
   curl -O https://datasets.imdbws.com/title.basics.tsv.gz
   curl -O https://datasets.imdbws.com/title.episode.tsv.gz
   curl -O https://datasets.imdbws.com/title.ratings.tsv.gz
   ```

   ~250 MB compressed. The TSVs are git-ignored.

2. From the repo root:

   ```sh
   npm run build:rising-seasons
   ```

   ~20 seconds. Writes `apps/rising-seasons/data.json` (also git-ignored — it's a build artifact). IMDb republishes the dumps daily, so re-running picks up new ratings.

## Optional: TMDB enrichment

The app uses TMDB for posters, plot summaries, original language, and US streaming providers. All of it is optional — `data.json` is valid without any of it.

1. Sign up at <https://www.themoviedb.org/signup>.
2. Generate a v4 read access token at <https://www.themoviedb.org/settings/api>.
3. Run the two enrichment scripts in order, then rebuild so `data.json` picks up the cache:

   ```sh
   # Posters + overviews + original_language (one /find call per series).
   TMDB_TOKEN=eyJh...your_token... npm run enrich:rising-seasons

   # US watch providers (one /tv/{id}/watch/providers call per series).
   TMDB_TOKEN=eyJh...your_token... npm run enrich:rising-seasons:providers

   # Merge both into data.json.
   npm run build:rising-seasons
   ```

   Both scripts are incremental: they skip cache entries that already have the data they fetch, so re-runs only hit TMDB for new or previously-failed series. First-run cost is ~15-20 minutes for posters and another ~25-30 for providers (both throttled to ~6 req/s).

The app degrades gracefully without each layer:
- No posters → cards show a gradient placeholder.
- No language → language filter chips just don't render.
- No providers → streaming filter and show-modal badges don't render.

## Build tunables

Pass via env vars to `build-data.js`:

| Var            | Default | Meaning                                          |
| -------------- | ------- | ------------------------------------------------ |
| `MIN_EPISODES` | `3`     | Skip seasons with fewer rated episodes           |
| `MIN_VOTES`    | `5`     | Every episode must have at least this many votes |

The default vote floor is deliberately low — IMDb's per-episode vote counts can be tiny for older shows, foreign series, reality TV, and short-run formats, and a high floor at build time wipes them out. The browser UI exposes its own minimum-votes filter and a popularity-sorted view, so building wide and filtering narrow in the UI is the easy path.

## Viewing locally

The page loads `data.json` via `fetch`, so serve the directory rather than opening `file://`:

```sh
cd apps/rising-seasons
python3 -m http.server 8000
# open http://localhost:8000
```

The browser URL preserves your shape/genre/sort/search selection — paste a link to share a specific view.

## Running tests

```sh
npm run test:rising-seasons
```

## Plex + Kometa + MDBList integrations

Rising Seasons ships static Kometa collection YAMLs, season-poster overlay YAMLs, and flat MDBList ID lists under `exports/` — regenerated by `npm run export:rising-seasons` and consumable directly from raw GitHub URLs without cloning. There is also a browser builder UI at `/apps/rising-seasons/kometa/` and a `scripts/watch-next.js` CLI that queries a live Plex server.

See [`INTEGRATIONS.md`](INTEGRATIONS.md) for end-to-end setup, troubleshooting, and the customization seams.
