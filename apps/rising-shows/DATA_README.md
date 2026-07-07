# Rising Shows — data refresh

The Rising Shows app is powered by `apps/rising-shows/data.json`, a build
artifact regenerated from IMDb's daily TSV dumps (and optionally enriched
with TMDB posters, plot overviews, original language, and US watch
providers).

`data.json` and its side-file `data/show-modal-extras.json` are **not
tracked in git**. Each refresh produces a ~150 MB pair that was bloating
git history (1.5 GB+ of old blobs) and slowing every push. Instead they
live as gzipped assets on the rolling GitHub release
[`rising-shows-data`](https://github.com/nsoifer01/shevato/releases/tag/rising-shows-data):
the refresh workflow replaces the assets in place, and
`scripts/fetch-data.js` downloads them wherever a working copy needs
them (the Netlify build runs it as the first step of `npm run
build:site`; locally run `npm run fetch:rising-shows-data` after a
fresh clone).

## Automated daily refresh

The workflow `.github/workflows/refresh-rising-shows.yml` runs daily at
**06:00 UTC** (and on demand via the *Run workflow* button on GitHub):

1. Downloads the three IMDb gzipped TSV dumps.
2. Runs `node apps/rising-shows/scripts/build-data.js` to regenerate
   `data.json`.
3. If the `TMDB_TOKEN` secret is set, runs both TMDB enrichment scripts
   in sequence — `enrich-tmdb.js` (posters / overviews / language) then
   `enrich-providers.js` (US watch providers) — and rebuilds so the new
   fields are merged in. The TMDB cache is persisted between runs via
   `actions/cache` so each refresh only fetches metadata for newly-
   discovered series.
4. Runs the test suite.
5. If the data actually changed (byte-compare against the previous
   release assets), gzips `data.json` + `data/show-modal-extras.json`
   and uploads them to the `rising-shows-data` release with
   `gh release upload --clobber`.
6. Commits the small derived files (`changelog.json`, `exports/`) via
   an auto-merged bot PR. That merge is what triggers the Netlify
   deploy, whose build downloads the fresh assets.

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
cd apps/rising-shows/data
curl -O https://datasets.imdbws.com/title.basics.tsv.gz
curl -O https://datasets.imdbws.com/title.episode.tsv.gz
curl -O https://datasets.imdbws.com/title.ratings.tsv.gz
cd ../../..

# 2. Build data.json from the dumps.
npm run build:rising-shows

# 3. (Optional) Enrich with TMDB metadata. Both scripts are incremental —
#    they only fetch series missing the data each one provides.
TMDB_TOKEN='eyJh...' npm run enrich:rising-shows             # posters / overviews / language
TMDB_TOKEN='eyJh...' npm run enrich:rising-shows:providers   # US watch providers
npm run build:rising-shows   # re-run to merge the cache into data.json

# 4. Publish if anything changed. The data files are gitignored, so a
#    manual refresh is published the same way the workflow does it:
gzip -9 -c apps/rising-shows/data.json > /tmp/data.json.gz
gzip -9 -c apps/rising-shows/data/show-modal-extras.json > /tmp/show-modal-extras.json.gz
gh release upload rising-shows-data /tmp/data.json.gz /tmp/show-modal-extras.json.gz --clobber
#    ...then trigger a deploy by committing the derived changelog/exports
#    changes (or just let the next daily workflow run pick everything up).
```

Or trigger the workflow from the CLI:

```sh
gh workflow run refresh-rising-shows.yml
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
      "episodes": [{"episode": 1, "rating": 7.4, "votes": 1234}, ...],
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
- `episodes[]` carries only the fields the grid needs to filter, sort, and draw curves. Episode titles, IMDb deep-link IDs, and runtimes live in `data/show-modal-extras.json` (see below). Per-episode `year` is intentionally dropped from the projection — the UI doesn't read it.
- `seriesRating` / `seriesVotes` are the show-level IMDb score (not the average of episode ratings).
- `language` is a TMDB-supplied ISO 639-1 code (e.g. `en`, `ja`, `ko`). Missing for series TMDB couldn't match.
- `providers` is a deduped, brand-normalized list of US streaming providers (Netflix Standard with Ads → "Netflix", Peacock Premium Plus → "Peacock", etc.). Missing for series with no US streaming availability or before `enrich-providers.js` has run.
- `languages` and `providers` aggregates at the root are popularity-ranked vocabularies built per unique series (not per season) so a long-running show doesn't dominate the count.

The browser app reads `builtAt` to display "Built [date]" and to flag
the data as stale (with a `console.warn` and UI badge) if it's older
than 30 days.

## `data/show-modal-extras.json`

A side-file (published to the same release, not committed) that
originally existed to keep `data.json` under GitHub's hard 100 MiB
per-file cap, and still keeps the initial browser payload smaller.
`build-data.js` writes both files in one pass:
anything the grid needs to filter, sort, and draw curves stays in
`data.json`; enrichment that's only read once a modal (or static show
page) opens moves here, keyed by series ID:

```jsonc
{
  "tt0944947": {
    "cast": [{"id": 22970, "name": "Peter Dinklage", "character": "...", "profile_path": "/....jpg"}, ...],
    "seasons": {
      "1": {
        "ov": "Season 1 plot overview...",
        "eps": {
          "1": {"tt": "tt1480055", "rt": 62, "n": "Winter Is Coming"}   // IMDb id, runtime (min), episode title
        }
      }
    }
  }
}
```

Consumers merge it back onto each match so downstream code is agnostic
to the split: `js/app.js` fetches it in parallel with `data.json` at
load, and `scripts/build-show-pages.js` reads it when rendering static
show pages. The file is optional for both — if it's missing, the app
still works, just without cast strips, season overviews, episode
titles, runtimes, or IMDb episode deep-links.

`build-data.js` logs both file sizes on every build and fails hard if
either reaches 100 MiB, so the refresh workflow dies at the build step
with an actionable message instead of at `git push`. If that fires,
move more per-match fields into the side-file (or shard it).

## `changelog.json`

A second build artifact, `apps/rising-shows/changelog.json`, holds a
rolling 30-day summary of what changed in each refresh. It powers the
"What's new" chip in the footer.

Generated by `apps/rising-shows/scripts/build-changelog.js`, which
runs in the daily refresh workflow right after `build-data.js` and
diffs the previous `data.json` (downloaded from the
`rising-shows-data` release) against the newly-built one, via
`--prev`. Locally you can re-run it the same way:

```sh
node apps/rising-shows/scripts/build-changelog.js
```

Or against explicit before/after files (useful for seeding history
from past commits):

```sh
node apps/rising-shows/scripts/build-changelog.js \
  --prev /tmp/prev-data.json --new apps/rising-shows/data.json
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

`data.json` is ~77 MB and `data/show-modal-extras.json` ~68 MB after
both enrichment passes (posters + providers). Until 2026-07 both were
committed on every refresh, which grew git history past 1.5 GB (each
version compresses to ~30 MB in the pack and does not delta against
its predecessor) and made pushes painfully slow. They now live on the
rolling `rising-shows-data` GitHub release instead (assets replaced in
place by the workflow, downloaded at build time by
`scripts/fetch-data.js`), so a refresh adds nothing to git history.

The two-file split predates the move (data.json crossed GitHub's hard
100 MiB per-file cap on 2026-07-05) and is kept because it also splits
the browser payload: the grid only needs `data.json` up front. Release
assets have a 2 GiB per-file limit, so the cap is no longer a concern,
but `build-data.js` still logs both file sizes on every build.

Old history still carries the pre-migration blobs; shrinking that
requires a one-off `git filter-repo` rewrite and force-push, which is
deliberately left as a separate, coordinated operation.
