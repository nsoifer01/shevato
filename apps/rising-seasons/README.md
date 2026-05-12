# Rising Seasons

Find TV shows by the **shape** of their IMDb episode ratings, not the average. Browse seasons that rise, stay consistently great, slow-burn into the back half, build to a big finale, or rebound after a mid-season dip.

## How it works

1. A Node script (`scripts/build-data.js`) streams three gzipped TSV dumps from IMDb, joins episodes with their ratings, runs each season through ten shape detectors, and writes `data.json` with every season that passes the vote/episode floor (tagged with every shape it fits — seasons matching no shape are still included with `shapes: []`).
2. Two optional enrichment scripts pull TMDB metadata: `scripts/enrich-tmdb.js` for posters, overviews, and language; `scripts/enrich-providers.js` for US streaming providers (Netflix / Max / Prime / …). Both cache to `data/tmdb-cache.json` so they survive rebuilds.
3. `index.html` loads `data.json` in the browser and renders shape chips, filters, an SVG curve per season, and a per-season detail modal. The browser app supports grid + list views, watched tracking (localStorage), pagination via IntersectionObserver, and shareable URL state.

`data.json` is committed to the repo and refreshed weekly by GitHub Actions — no manual updates needed. See [`DATA_README.md`](DATA_README.md) for the auto-refresh details.

## Shapes

| Shape          | Rule                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| Rising         | Each episode's rating ≥ the previous one (non-decreasing).                    |
| Consistent     | All episodes ≥ 8.0 with a spread of ≤ 0.5.                                    |
| Slow burn      | Second-half average ≥ first-half average + 0.6.                               |
| Big finale     | Finale is the season's peak AND ≥ season average + 0.5.                       |
| Rebound        | A real interior dip (≥ 0.4 below the start/end), recovers above the start.    |
| Front-loaded   | First-half average ≥ second-half average + 0.6 (mirror of slow burn).         |
| Declining      | Each episode's rating ≤ the previous one, with first strictly > last.         |
| Bad finale     | Finale is the season's trough AND ≤ season average − 0.5.                     |
| Rollercoaster  | Many large adjacent direction-flips with a wide range (chaotic seasons).      |
| Mid-peak       | Peak sits in the middle half of the season, well above both edges.            |

A season can match more than one shape — the card shows all of them.

## Browser app features

| Feature                  | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Shape filter             | Toggle one or more shape chips; AND across selected shapes.                                        |
| Genre filter (tri-state) | Click a chip to **require** that genre; click again to **exclude** it (red strike); third click clears. AND across required genres. |
| Language filter          | Multi-select chips for the top original languages (TMDB `original_language`).                      |
| Streaming filter         | Multi-select chips for top US watch providers (Netflix, HBO Max, Prime …).                         |
| Hidden gems toggle       | Surfaces seasons with avg ≥ 8.0 *and* fewer than 1,000 votes per episode.                          |
| Episode-title search     | Searching ≥3 chars also matches against episode names — "Gray Matter" → Breaking Bad.              |
| Compare shows            | "+ Add to compare" on each show, then a floating button opens an overlay chart of season-trajectories for up to 5 series (persisted in localStorage). |
| Season overlay           | In the show modal, all seasons drawn together on one chart with a legend.                          |
| Best / worst badges      | Inline pill on the highest- and lowest-rated season of each series (skipped when all seasons tie). |
| Watched tracking         | Per-season toggle; persists in localStorage; "watched / unwatched" filters and stats.              |
| Above-IMDb badge         | Marks seasons whose average episode rating beats the show's overall IMDb score.                    |

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

| Var               | Default                              | Meaning                                                                                            |
| ----------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `MIN_EPISODES`    | `3`                                  | Skip seasons with fewer rated episodes                                                             |
| `MIN_VOTES`       | `100`                                | Every episode must have at least this many votes                                                   |
| `RELAX_GENRES`    | `Reality-TV,Game-Show,Talk-Show`     | Series tagged with any of these genres use the lower floor below                                   |
| `RELAX_MIN_VOTES` | `10`                                 | Per-episode vote floor for relaxed-genre series (reality episodes rarely clear 100 votes on IMDb)  |

The browser UI applies its own (stricter) defaults on top, so building wide and filtering narrow in the UI is the easy path.

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
