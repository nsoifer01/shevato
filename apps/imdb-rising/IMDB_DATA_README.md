# IMDB Rising — data refresh

The Rising Seasons app is powered by `apps/imdb-rising/data.json`, a build
artifact regenerated from IMDb's daily TSV dumps (and optionally enriched
with TMDB posters + overviews). The data file is committed to the repo
so the static site has zero runtime dependencies.

## Automated weekly refresh

The workflow `.github/workflows/refresh-imdb.yml` runs every **Monday at
06:00 UTC** (and on demand via the *Run workflow* button on GitHub):

1. Downloads the three IMDb gzipped TSV dumps.
2. Runs `node apps/imdb-rising/scripts/build-data.js` to regenerate
   `data.json`.
3. If the `TMDB_TOKEN` secret is set, runs the TMDB enrichment script
   and rebuilds so posters and overviews are merged in. The TMDB cache
   is persisted between runs via `actions/cache` so each refresh only
   fetches metadata for newly-discovered series.
4. Runs the test suite.
5. Commits `data.json` back to the branch the workflow ran on, but
   *only if it actually changed*.

If TMDB is unavailable (token missing or rate-limited), the workflow
still produces a valid `data.json` — the UI falls back to a gradient
poster placeholder.

## Required GitHub secrets

| Secret name   | What it is                                             | Where to get it                                              |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `TMDB_TOKEN`  | TMDB v4 read access token (Bearer)                     | <https://www.themoviedb.org/settings/api> → "API Read Access Token" |

Add it under **Settings → Secrets and variables → Actions → New repository secret**.

The workflow also uses the built-in `GITHUB_TOKEN`, which is provided
automatically. No PAT is needed for the auto-push because the workflow
only pushes to its own repository.

## Running the refresh manually

From the repo root:

```sh
# 1. Download the three IMDb dumps (~250 MB).
cd apps/imdb-rising/data
curl -O https://datasets.imdbws.com/title.basics.tsv.gz
curl -O https://datasets.imdbws.com/title.episode.tsv.gz
curl -O https://datasets.imdbws.com/title.ratings.tsv.gz
cd ../../..

# 2. Build data.json from the dumps.
npm run build:imdb-rising

# 3. (Optional) Enrich with posters + overviews.
TMDB_TOKEN='eyJh...' npm run enrich:imdb-rising
npm run build:imdb-rising   # re-run to merge the cache into data.json

# 4. Commit if anything changed.
git diff --stat apps/imdb-rising/data.json
git add apps/imdb-rising/data.json
git commit -m "chore(imdb-rising): manual data refresh"
```

Or trigger the workflow from the CLI:

```sh
gh workflow run refresh-imdb.yml
gh run watch
```

## Schema

`data.json` shape:

```jsonc
{
  "builtAt": "2026-05-08T18:15:23.000Z",
  "minEpisodes": 4,         // build-time threshold
  "minVotes": 100,          // build-time threshold
  "count": 4230,            // total matching seasons
  "shapeCounts": {
    "rising": 356, "consistent": 253, "slow-burn": 622,
    "big-finale": 2490, "rebound": 2088
  },
  "genres": [{"name": "Drama", "count": 2637}, ...],
  "matches": [
    {
      "seriesId": "tt...",
      "title": "...", "year": 2020, "type": "tvSeries",
      "genres": ["Drama", "Crime"],
      "season": 1,
      "episodes": [{"episode": 1, "rating": 7.4, "votes": 1234, "tconst": "tt..."}, ...],
      "firstRating": 7.4, "lastRating": 9.1, "avgRating": 8.2,
      "minVotes": 1234,
      "shapes": ["rising", "slow-burn"],
      // present when TMDB enrichment ran:
      "poster": "/abc.jpg", "overview": "...", "tmdbId": 12345
    }
  ]
}
```

The browser app reads `builtAt` to display "Built [date]" and to flag
the data as stale (with a `console.warn` and UI badge) if it's older
than 30 days.

## Tunables

`build-data.js` accepts two env vars:

| Var            | Default | Effect                                          |
| -------------- | ------- | ----------------------------------------------- |
| `MIN_EPISODES` | `4`     | Skip seasons with fewer rated episodes          |
| `MIN_VOTES`    | `100`   | Every episode must have ≥ this many votes       |

The browser UI applies its own (typically stricter) defaults on top, so
build wide and let users narrow in the UI.

## Repo size considerations

`data.json` is ~6 MB after enrichment. Weekly commits will grow git
history by roughly a few MB/week (most fields are stable; only ratings,
votes, and counts change). If history bloat becomes an issue, options:

- Move to a `data` orphan branch the site fetches from.
- Build at deploy time on Netlify (would need to download IMDb dumps
  during build, ~250 MB each deploy).
- Use Git LFS for `data.json`.

For now, the simple commit-it path is intentional.
