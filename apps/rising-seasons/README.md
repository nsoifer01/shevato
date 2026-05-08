# Rising Seasons

Find TV shows by the **shape** of their IMDb episode ratings, not the average. Browse seasons that rise, stay consistently great, slow-burn into the back half, build to a big finale, or rebound after a mid-season dip.

## How it works

1. A Node script (`scripts/build-data.js`) streams three gzipped TSV dumps from IMDb, joins episodes with their ratings, runs each season through five shape detectors, and writes `data.json` with all matching seasons (tagged with every shape they fit).
2. An optional second script (`scripts/enrich-tmdb.js`) fetches posters + plot overviews from TMDB and caches them so they survive rebuilds.
3. `index.html` loads `data.json` in the browser and renders shape chips, filters, an SVG curve per season, and a per-season detail modal. The browser app supports grid + list views, watched tracking (localStorage), pagination via IntersectionObserver, and shareable URL state.

`data.json` is committed to the repo and refreshed weekly by GitHub Actions — no manual updates needed. See [`DATA_README.md`](DATA_README.md) for the auto-refresh details.

## Shapes

| Shape       | Rule                                                                |
| ----------- | ------------------------------------------------------------------- |
| Rising      | Each episode's rating ≥ the previous one (non-decreasing).          |
| Consistent  | All episodes ≥ 8.0 with a spread of ≤ 0.5.                          |
| Slow burn   | Second-half average ≥ first-half average + 0.6.                     |
| Big finale  | Finale is the season's peak AND ≥ season average + 0.5.             |
| Rebound     | A real interior dip (≥ 0.4 below the start/end), recovers above the start. |

A season can match more than one shape — the card shows all of them.

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

## Optional: poster + overview enrichment

To add posters and plot summaries to each card, get a free TMDB v4 read access token:

1. Sign up at <https://www.themoviedb.org/signup>.
2. Generate a v4 read access token at <https://www.themoviedb.org/settings/api>.
3. Run the enrichment, then rebuild so `data.json` picks up the cache:

   ```sh
   TMDB_TOKEN=eyJh...your_token... npm run enrich:rising-seasons
   npm run build:rising-seasons
   ```

   First run takes a few minutes (one HTTP request per unique series, throttled to ~10/s). Subsequent runs reuse `data/tmdb-cache.json` and only fetch new series.

The app degrades gracefully without the cache — cards just show a gradient placeholder instead of a poster.

## Build tunables

Pass via env vars to `build-data.js`:

| Var            | Default | Meaning                                           |
| -------------- | ------- | ------------------------------------------------- |
| `MIN_EPISODES` | `4`     | Skip seasons with fewer rated episodes            |
| `MIN_VOTES`    | `100`   | Every episode must have at least this many votes  |

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
