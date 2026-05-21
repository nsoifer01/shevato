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
  "minVotes": 5,                                          // build-time threshold
  "count": 64877,                                         // total matching seasons
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

## `changelog.json`

A second build artifact, `apps/rising-seasons/changelog.json`, holds a
rolling 30-day summary of what changed in each refresh. It powers the
"What's new" chip in the footer.

Generated by `apps/rising-seasons/scripts/build-changelog.js`, which
runs in the daily refresh workflow right after `build-data.js` and
diffs the previous `data.json` (from `HEAD`) against the newly-built
one. Locally you can re-run it the same way:

```sh
node apps/rising-seasons/scripts/build-changelog.js
```

Or against explicit before/after files (useful for seeding history
from past commits):

```sh
node apps/rising-seasons/scripts/build-changelog.js \
  --prev /tmp/prev-data.json --new apps/rising-seasons/data.json
```

Shape:

```jsonc
{
  "updates": [
    {
      "builtAt": "2026-05-14T08:24:59.670Z",
      "totals": { "seasons": 16545, "delta": 9 },
      "shapeCounts": { "rising": 596, "big-finale": 4040, /* … */ },
      "shapeDeltas": { "big-finale": 1034, "saved-best-for-last": 434 },
      "added":   [{ "seriesId": "tt...", "title": "Family Guy", "season": 24, "seasonYear": 2026 }],
      "removed": [{ "seriesId": "tt...", "title": "NCIS",       "season": 23, "seasonYear": 2025 }],
      "ratingSwings": [{ "seriesId": "...", "title": "...", "season": 2, "from": 8.10, "to": 8.55, "delta": 0.45 }],
      "modifiedCounts": { "seriesVotes": 11552, "avgRating": 576, "shapes": 2182 }
    }
    // … newest first, capped at 30 entries
  ]
}
```

Notes:

- Entries are de-duplicated by `builtAt`. Re-running the script on the
  same `data.json` overwrites the existing entry rather than creating
  a duplicate.
- `ratingSwings` is capped at the top 10 swings with `|Δ| ≥ 0.2`.
- `added` / `removed` are listed in full (typically <50 per refresh).

## Tunables

`build-data.js` accepts these env vars:

| Var            | Default | Effect                                    |
| -------------- | ------- | ----------------------------------------- |
| `MIN_EPISODES` | `3`     | Skip seasons with fewer rated episodes    |
| `MIN_VOTES`    | `5`     | Every episode must have ≥ this many votes |

The vote floor is deliberately low so older shows, foreign series, reality
TV, and short-run formats are not filtered out at build time. The browser
UI exposes its own minimum-votes filter and popularity sort, so build wide
and let users narrow in the UI.

## Repo size considerations

`data.json` is ~85 MB after both enrichment passes (posters + providers).
Weekly commits will grow git history by roughly a few MB/week (most fields
are stable; only ratings, votes, and counts change). If history bloat
becomes an issue, options:

- Move to a `data` orphan branch the site fetches from.
- Build at deploy time on Netlify (would need to download IMDb dumps
  during build, ~250 MB each deploy).
- Use Git LFS for `data.json`.

For now, the simple commit-it path is intentional.
