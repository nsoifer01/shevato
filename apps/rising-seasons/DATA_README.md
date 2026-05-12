# Rising Seasons — data refresh

The Rising Seasons app is powered by `apps/rising-seasons/data.json`, a build
artifact regenerated from IMDb's daily TSV dumps (and optionally enriched
with TMDB posters, plot overviews, original language, and US watch
providers). The data file is committed to the repo so the static site
has zero runtime dependencies.

## Automated weekly refresh

The workflow `.github/workflows/refresh-imdb.yml` runs every **Monday at
06:00 UTC** (and on demand via the *Run workflow* button on GitHub):

1. Downloads the three IMDb gzipped TSV dumps.
2. Runs `node apps/rising-seasons/scripts/build-data.js` to regenerate
   `data.json`.
3. If the `TMDB_TOKEN` secret is set, runs both TMDB enrichment scripts
   in sequence — `enrich-tmdb.js` (posters / overviews / language) then
   `enrich-providers.js` (US watch providers) — and rebuilds so the new
   fields are merged in. The TMDB cache is persisted between runs via
   `actions/cache` so each refresh only fetches metadata for newly-
   discovered series.
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
cd apps/rising-seasons/data
curl -O https://datasets.imdbws.com/title.basics.tsv.gz
curl -O https://datasets.imdbws.com/title.episode.tsv.gz
curl -O https://datasets.imdbws.com/title.ratings.tsv.gz
cd ../../..

# 2. Build data.json from the dumps.
npm run build:rising-seasons

# 3. (Optional) Enrich with TMDB metadata. Both scripts are incremental —
#    they only fetch series missing the data each one provides.
TMDB_TOKEN='eyJh...' npm run enrich:rising-seasons             # posters / overviews / language
TMDB_TOKEN='eyJh...' npm run enrich:rising-seasons:providers   # US watch providers
npm run build:rising-seasons   # re-run to merge the cache into data.json

# 4. Commit if anything changed.
git diff --stat apps/rising-seasons/data.json
git add apps/rising-seasons/data.json
git commit -m "chore(rising-seasons): manual data refresh"
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
  "builtAt": "2026-05-11T18:24:00.000Z",
  "minEpisodes": 3,                                       // build-time threshold
  "minVotes": 100,                                        // build-time threshold
  "relaxedGenres": ["Reality-TV", "Game-Show", "Talk-Show"], // genres that get the lower floor below
  "relaxedMinVotes": 10,                                  // per-episode vote floor for relaxed-genre series
  "count": 16510,                                         // total matching seasons
  "shapeCounts": {
    "rollercoaster": 3551, "big-finale": 2999, "rebound": 2783,
    "mid-peak": 1105, "bad-finale": 1041, "slow-burn": 873,
    "rising": 603, "front-loaded": 540, "consistent": 461, "declining": 211
  },
  "genres": [{"name": "Drama", "count": 6880}, ...],
  "languages": [{"code": "en", "count": 5015}, {"code": "ja", "count": 455}, ...],
  "providers": [{"name": "Netflix", "count": 1566}, {"name": "Hulu", "count": 735}, ...],
  "matches": [
    {
      "seriesId": "tt...",
      "title": "...", "year": 2020, "seasonYear": 2021, "type": "tvSeries",
      "genres": ["Drama", "Crime"],
      "season": 1,
      "episodes": [{"episode": 1, "rating": 7.4, "votes": 1234, "name": "Pilot"}, ...],
      "firstRating": 7.4, "lastRating": 9.1, "avgRating": 8.2,
      "minVotes": 1234,
      "shapes": ["rising", "slow-burn"],
      "seriesRating": 8.6, "seriesVotes": 124500,
      // present when TMDB enrich-tmdb.js ran:
      "poster": "/abc.jpg", "overview": "...", "tmdbId": 12345,
      "language": "en",
      // present when TMDB enrich-providers.js ran AND the series has US streaming:
      "providers": ["Netflix", "Hulu"]
    }
  ]
}
```

Notes on individual fields:

- `year` is the show's start year; `seasonYear` is the air year of the earliest-aired episode in this specific season. The UI prefers `seasonYear` everywhere a single season is rendered and falls back to `year` if absent.
- `episodes[].name` is present when IMDb has an episode title for it. Per-episode `tconst` and `year` are intentionally dropped from the projection to keep `data.json` small — the UI doesn't read them.
- `seriesRating` / `seriesVotes` are the show-level IMDb score (not the average of episode ratings).
- `language` is a TMDB-supplied ISO 639-1 code (e.g. `en`, `ja`, `ko`). Missing for series TMDB couldn't match.
- `providers` is a deduped, brand-normalized list of US streaming providers (Netflix Standard with Ads → "Netflix", Peacock Premium Plus → "Peacock", etc.). Missing for series with no US streaming availability or before `enrich-providers.js` has run.
- `languages` and `providers` aggregates at the root are popularity-ranked vocabularies built per unique series (not per season) so a long-running show doesn't dominate the count.

The browser app reads `builtAt` to display "Built [date]" and to flag
the data as stale (with a `console.warn` and UI badge) if it's older
than 30 days.

## Tunables

`build-data.js` accepts these env vars:

| Var               | Default                              | Effect                                                                                            |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `MIN_EPISODES`    | `3`                                  | Skip seasons with fewer rated episodes                                                            |
| `MIN_VOTES`       | `100`                                | Every episode must have ≥ this many votes                                                         |
| `RELAX_GENRES`    | `Reality-TV,Game-Show,Talk-Show`     | Series tagged with any of these IMDb genres use the relaxed floor below                           |
| `RELAX_MIN_VOTES` | `10`                                 | Per-episode vote floor for relaxed-genre series (reality episodes rarely clear 100 votes on IMDb) |

The browser UI applies its own (typically stricter) defaults on top, so
build wide and let users narrow in the UI.

## Repo size considerations

`data.json` is ~26 MB after both enrichment passes (posters + providers).
Weekly commits will grow git history by roughly a few MB/week (most fields
are stable; only ratings, votes, and counts change). If history bloat
becomes an issue, options:

- Move to a `data` orphan branch the site fetches from.
- Build at deploy time on Netlify (would need to download IMDb dumps
  during build, ~250 MB each deploy).
- Use Git LFS for `data.json`.

For now, the simple commit-it path is intentional.
