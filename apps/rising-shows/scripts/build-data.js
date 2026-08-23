#!/usr/bin/env node
'use strict';

// Build a list of TV seasons whose episode IMDb ratings fit one or more
// "shape" patterns (rising, consistent, slow-burn, big-finale, rebound).
// Reads three gzipped TSVs from IMDb's free non-commercial datasets and,
// optionally, a tmdb-cache.json produced by enrich-tmdb.js.
//
// See ../README.md for download instructions.
//
// Inputs (place in apps/rising-shows/data/):
//   title.basics.tsv.gz
//   title.episode.tsv.gz
//   title.ratings.tsv.gz
// Optional:
//   tmdb-cache.json  — produced by `npm run enrich:rising-shows`
//
// Output: apps/rising-shows/data.json
//
// Tunables (env vars):
//   MIN_EPISODES     (default 3)  — minimum rated episodes per season
//   MIN_VOTES        (default 5)  — every episode must have at least this many votes.
//                                   Set low so reality, foreign, and short-run shows are
//                                   not filtered out at build time. The browser UI exposes
//                                   its own (stricter) vote and popularity filters on top.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const crypto = require('crypto');

const { findMatches } = require('./match.js');
// Provider brand normalization is shared with the static show pages (and the
// browser app's mainstream list) so no surface can spell a service differently.
const { normalizeProvider } = require('./providers-lib.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(__dirname, '..', 'data.json');
const TMDB_CACHE = path.join(DATA_DIR, 'tmdb-cache.json');
// Side-file produced by `fetch-season-overviews.js` — kept separate from
// tmdb-cache.json so the season-overview backfill can run alongside the
// main enrich script without racing on cache writes.
const SEASON_OVERVIEWS_FILE = path.join(DATA_DIR, 'season-overviews.json');

// Default 3 (was 4) so short-season formats like BBC Sherlock (3 eps/season)
// are included. Most shape detectors require >= 4 episodes internally, so
// short seasons will be emitted as shape-less rows under the parent show
// rather than appearing as their own pattern hits.
const MIN_EPISODES = parseInt(process.env.MIN_EPISODES || '3', 10);
const MIN_VOTES = parseInt(process.env.MIN_VOTES || '5', 10);
const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

function openTsv(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing dataset file: ${filePath}\n` +
      `Download from https://datasets.imdbws.com/ — see apps/rising-shows/README.md`,
    );
  }
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

async function loadRatings() {
  const ratings = new Map();
  const rl = openTsv('title.ratings.tsv.gz');
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const tconst = line.slice(0, tab1);
    const rating = parseFloat(line.slice(tab1 + 1, tab2));
    const votes = parseInt(line.slice(tab2 + 1), 10);
    if (Number.isFinite(rating) && Number.isFinite(votes)) {
      ratings.set(tconst, { rating, votes });
    }
  }
  return ratings;
}

async function loadSeries(ratings) {
  // Single pass: collect series basics AND episode titles + air years.
  // We skip unrated episodes because they can never appear in our matches —
  // that keeps the maps roughly bounded to the size of the ratings map
  // (~1.5M entries) instead of every tvEpisode ever (~6M+).
  const series = new Map();
  const episodeTitles = new Map();
  const episodeYears = new Map();
  const episodeRuntimes = new Map();
  const rl = openTsv('title.basics.tsv.gz');
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const cols = line.split('\t');
    // tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtimeMinutes, genres
    const tconst = cols[0];
    const titleType = cols[1];

    if (titleType === 'tvEpisode') {
      if (!ratings.has(tconst)) continue;
      const primaryTitle = cols[2];
      if (primaryTitle && primaryTitle !== '\\N') {
        episodeTitles.set(tconst, primaryTitle);
      }
      const startYear = cols[5];
      if (startYear && startYear !== '\\N') {
        const y = parseInt(startYear, 10);
        if (Number.isFinite(y)) episodeYears.set(tconst, y);
      }
      // IMDb runtimeMinutes is integer or "\N". We only store positive
      // finite values so downstream code can `if (runtime)` cheaply.
      const runtimeRaw = cols[7];
      if (runtimeRaw && runtimeRaw !== '\\N') {
        const rt = parseInt(runtimeRaw, 10);
        if (Number.isFinite(rt) && rt > 0) episodeRuntimes.set(tconst, rt);
      }
      continue;
    }

    if (!SERIES_TYPES.has(titleType)) continue;
    const startYear = cols[5];
    const genresRaw = cols[8];
    const genres = (!genresRaw || genresRaw === '\\N') ? [] : genresRaw.split(',');
    series.set(tconst, {
      title: cols[2],
      year: startYear === '\\N' ? null : parseInt(startYear, 10),
      type: titleType,
      genres,
    });
  }
  return { series, episodeTitles, episodeYears, episodeRuntimes };
}

async function loadEpisodes(series, ratings, episodeTitles, episodeYears, episodeRuntimes) {
  // Map<seriesId, Map<seasonNumber, Array<{episode, tconst, rating, votes, name}>>>
  const result = new Map();
  // Map<seriesId, Map<seasonNumber, highest episode number IMDb LISTS>> - built
  // from the same pass, counting rated and unrated episodes alike. It is the
  // only evidence in the free TSVs that a season has episodes after the last
  // one we can score, which is how match.js's tagInProgress spots a season
  // that is still airing. Roughly 376k entries for the full dump.
  const listedMaxEp = new Map();
  const rl = openTsv('title.episode.tsv.gz');
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const cols = line.split('\t');
    const tconst = cols[0];
    const parentTconst = cols[1];
    if (!series.has(parentTconst)) continue;
    const seasonRaw = cols[2];
    const episodeRaw = cols[3];
    if (seasonRaw === '\\N' || episodeRaw === '\\N') continue;
    const season = parseInt(seasonRaw, 10);
    const episode = parseInt(episodeRaw, 10);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;

    let listedSeasons = listedMaxEp.get(parentTconst);
    if (!listedSeasons) {
      listedSeasons = new Map();
      listedMaxEp.set(parentTconst, listedSeasons);
    }
    const listedSoFar = listedSeasons.get(season);
    if (listedSoFar === undefined || episode > listedSoFar) listedSeasons.set(season, episode);

    const r = ratings.get(tconst);
    if (!r) continue;
    let bySeason = result.get(parentTconst);
    if (!bySeason) {
      bySeason = new Map();
      result.set(parentTconst, bySeason);
    }
    let arr = bySeason.get(season);
    if (!arr) {
      arr = [];
      bySeason.set(season, arr);
    }
    const ep = { episode, tconst, rating: r.rating, votes: r.votes };
    const name = episodeTitles && episodeTitles.get(tconst);
    if (name) ep.name = name;
    const year = episodeYears && episodeYears.get(tconst);
    // Year is build-internal — match.js consumes it to compute the
    // per-season `seasonYear` and then drops it from the projection.
    if (year) ep.year = year;
    const runtime = episodeRuntimes && episodeRuntimes.get(tconst);
    if (runtime) ep.runtime = runtime;
    arr.push(ep);
  }
  return { bySeries: result, listedMaxEp };
}

function loadTmdbCache() {
  if (!fs.existsSync(TMDB_CACHE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TMDB_CACHE, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse ${TMDB_CACHE}: ${err.message}`);
    return null;
  }
}

function loadSeasonOverviews() {
  if (!fs.existsSync(SEASON_OVERVIEWS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SEASON_OVERVIEWS_FILE, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse ${SEASON_OVERVIEWS_FILE}: ${err.message}`);
    return null;
  }
}

(async () => {
  const t0 = Date.now();

  process.stdout.write('Loading ratings... ');
  const ratings = await loadRatings();
  console.log(`${ratings.size.toLocaleString()} rated titles`);

  process.stdout.write('Loading series basics + episode titles + air years + runtimes... ');
  const { series, episodeTitles, episodeYears, episodeRuntimes } = await loadSeries(ratings);
  console.log(
    `${series.size.toLocaleString()} TV series + mini-series, ` +
    `${episodeTitles.size.toLocaleString()} episode titles, ` +
    `${episodeYears.size.toLocaleString()} episode air years, ` +
    `${episodeRuntimes.size.toLocaleString()} episode runtimes`,
  );

  process.stdout.write('Loading episodes... ');
  const { bySeries: episodes, listedMaxEp } = await loadEpisodes(
    series, ratings, episodeTitles, episodeYears, episodeRuntimes,
  );
  console.log(`${episodes.size.toLocaleString()} series have rated episodes`);

  process.stdout.write('Detecting shape matches... ');
  const builtAt = new Date().toISOString();
  const matches = findMatches(series, episodes, {
    minEpisodes: MIN_EPISODES,
    minVotes: MIN_VOTES,
    // Both feed tagInProgress, which decides whether a season's last rated
    // episode is really its finale before anything is classified.
    listedMaxEp,
    buildYear: new Date(builtAt).getUTCFullYear(),
  });
  const shapedCount = matches.reduce((n, m) => n + (m.shapes.length > 0 ? 1 : 0), 0);
  console.log(`${matches.length.toLocaleString()} seasons (${shapedCount.toLocaleString()} with at least one shape)`);

  // Tally per-shape counts for the build summary.
  const shapeCounts = {};
  for (const m of matches) {
    for (const s of m.shapes) {
      shapeCounts[s] = (shapeCounts[s] || 0) + 1;
    }
  }
  for (const [shape, count] of Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${shape.padEnd(12)} ${count.toLocaleString()}`);
  }

  // Attach the series-level IMDb rating (the show's overall score on IMDb,
  // not the average of episode ratings). Available for free in the same
  // ratings TSV we already loaded — series have their own tconst entry.
  for (const m of matches) {
    const r = ratings.get(m.seriesId);
    if (r) {
      m.seriesRating = r.rating;
      m.seriesVotes = r.votes;
    }
  }

  // Optional TMDB enrichment.
  const tmdb = loadTmdbCache();
  if (tmdb) {
    let enriched = 0;
    for (const m of matches) {
      const t = tmdb[m.seriesId];
      if (t) {
        m.poster = t.poster_path || null;
        m.overview = t.overview || null;
        m.tmdbId = t.id || null;
        if (Number.isFinite(t.tvdbId)) m.tvdbId = t.tvdbId;
        if (t.seasonTvdbIds) {
          const sv = t.seasonTvdbIds[m.season];
          if (Number.isFinite(sv)) m.seasonTvdbId = sv;
        }
        if (t.seasonOverviews) {
          const so = t.seasonOverviews[m.season];
          if (typeof so === 'string' && so.length > 0) m.seasonOverview = so;
        }
        if (t.original_language) m.language = t.original_language;
        if (Array.isArray(t.cast) && t.cast.length) m.cast = t.cast;
        if (Array.isArray(t.providers) && t.providers.length) {
          const seen = new Set();
          const norm = [];
          for (const p of t.providers) {
            const key = normalizeProvider(p.name);
            if (seen.has(key)) continue;
            seen.add(key);
            norm.push(key);
          }
          if (norm.length) m.providers = norm;
        }
        enriched++;
      }
    }
    console.log(`Enriched ${enriched.toLocaleString()} of ${matches.length.toLocaleString()} matches with TMDB metadata`);
  } else {
    console.log('(No TMDB cache present — run `npm run enrich:rising-shows` to add posters/overviews.)');
  }

  // Per-season overviews from the parallel side-file. Runs as its own pass so
  // it works whether or not the main TMDB cache exists.
  //
  // GAP FILLER ONLY. data/season-overviews.json is a one-off snapshot written
  // by the orphaned fetch-season-overviews.js (in no workflow since 2026-07-04)
  // while enrich-tmdb.js refreshes seasonOverviews inside tmdb-cache.json every
  // day. The side-file used to be applied last, on the theory that it was the
  // fresher of the two, so a July snapshot overwrote today's text for ~12k
  // seasons and its ''/null entries counted for nothing. Now the cache wins and
  // the side-file only supplies seasons the cache has no text for - and never
  // an empty string.
  const sideOverviews = loadSeasonOverviews();
  if (sideOverviews) {
    let filled = 0;
    let skipped = 0;
    for (const m of matches) {
      const ovMap = sideOverviews[m.seriesId];
      if (!ovMap) continue;
      const so = ovMap[String(m.season)];
      if (typeof so !== 'string' || so.length === 0) continue;
      if (typeof m.seasonOverview === 'string' && m.seasonOverview.length > 0) { skipped++; continue; }
      m.seasonOverview = so;
      filled++;
    }
    console.log(`Filled ${filled.toLocaleString()} per-season overview gaps from season-overviews.json (${skipped.toLocaleString()} already covered by the TMDB cache)`);
  }

  // Sort by minimum vote count desc — most-watched matches first.
  matches.sort((a, b) => b.minVotes - a.minVotes);

  // Build the genre vocabulary in popularity order so the UI can render chips.
  const genreCounts = new Map();
  for (const m of matches) {
    for (const g of m.genres) {
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
  }
  const genres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Same for languages — counted per unique series (not per season) so a
  // long-running English show doesn't dominate the chip count by virtue of
  // having more seasons than a foreign-language show.
  const languageCounts = new Map();
  const seenSeries = new Set();
  for (const m of matches) {
    if (seenSeries.has(m.seriesId)) continue;
    seenSeries.add(m.seriesId);
    if (!m.language) continue;
    languageCounts.set(m.language, (languageCounts.get(m.language) || 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, count }));

  // Same: providers counted per unique series. A series streamed on Netflix +
  // Hulu contributes one count to each. Skip series with no provider info.
  const providerCounts = new Map();
  const seenForProviders = new Set();
  for (const m of matches) {
    if (seenForProviders.has(m.seriesId)) continue;
    seenForProviders.add(m.seriesId);
    if (!m.providers) continue;
    for (const p of m.providers) {
      providerCounts.set(p, (providerCounts.get(p) || 0) + 1);
    }
  }
  const providers = [...providerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Split modal-only enrichment out into a side-file so data.json stays under
  // GitHub's 100 MB file-size cap. The browser app fetches both files in
  // parallel from load() and merges show-modal-extras.json onto each match
  // before the user opens any modal — see apps/rising-shows/js/app.js.
  // Episode titles moved here 2026-07-05 when data.json itself crossed the
  // cap (names alone were ~23 MiB); they are modal/tooltip-only in the UI.
  const modalExtras = {}; // seriesId -> { cast, seasons: { seasonNum -> { ov, eps: { epNum -> { tt, rt, n } } } } }
  const seenCastSeries = new Set();
  for (const m of matches) {
    const sid = m.seriesId;
    if (m.cast && m.cast.length) {
      if (!seenCastSeries.has(sid)) {
        if (!modalExtras[sid]) modalExtras[sid] = { cast: null, seasons: {} };
        modalExtras[sid].cast = m.cast;
        seenCastSeries.add(sid);
      }
      delete m.cast;
    }
    if (m.seasonOverview) {
      if (!modalExtras[sid]) modalExtras[sid] = { cast: null, seasons: {} };
      const key = String(m.season);
      if (!modalExtras[sid].seasons[key]) modalExtras[sid].seasons[key] = { ov: null, eps: {} };
      modalExtras[sid].seasons[key].ov = m.seasonOverview;
      delete m.seasonOverview;
    }
    if (Array.isArray(m.episodes)) {
      for (const ep of m.episodes) {
        if (!ep.tt && ep.runtime === undefined && !ep.name) continue;
        if (!modalExtras[sid]) modalExtras[sid] = { cast: null, seasons: {} };
        const key = String(m.season);
        if (!modalExtras[sid].seasons[key]) modalExtras[sid].seasons[key] = { ov: null, eps: {} };
        const rec = {};
        if (ep.tt) { rec.tt = ep.tt; delete ep.tt; }
        if (ep.runtime !== undefined) { rec.rt = ep.runtime; delete ep.runtime; }
        if (ep.name) { rec.n = ep.name; delete ep.name; }
        modalExtras[sid].seasons[key].eps[String(ep.episode)] = rec;
      }
    }
  }
  // Drop top-level entries that ended up empty (no cast and no season records).
  for (const sid of Object.keys(modalExtras)) {
    const e = modalExtras[sid];
    if (!e.cast && Object.keys(e.seasons).length === 0) delete modalExtras[sid];
  }

  // Everything in data.json EXCEPT builtAt and the hash itself. Two builds of
  // the same IMDb dump produce the same bytes here (Map iteration follows
  // insertion order, Array#sort is stable), so `contentHash` is identical when
  // nothing changed and differs as soon as any rating, vote, shape or piece of
  // enrichment does. The refresh workflow's "unchanged" gates compare it
  // instead of diffing whole files, which builtAt made impossible.
  const content = {
    minEpisodes: MIN_EPISODES,
    minVotes: MIN_VOTES,
    count: matches.length,
    shapeCounts,
    genres,
    languages,
    providers,
    matches,
  };
  const contentJson = JSON.stringify(content);
  const contentHash = crypto.createHash('sha256').update(contentJson).digest('hex').slice(0, 16);
  // Written by hand rather than through a second JSON.stringify of an 80 MB
  // object: the header keys go first, then the already-serialized body minus
  // its opening brace.
  fs.writeFileSync(OUT_FILE, `{"builtAt":${JSON.stringify(builtAt)},"contentHash":"${contentHash}",${contentJson.slice(1)}`);
  console.log(`contentHash ${contentHash} (over everything but builtAt)`);
  const EXTRAS_FILE = path.join(DATA_DIR, 'show-modal-extras.json');
  fs.writeFileSync(EXTRAS_FILE, JSON.stringify(modalExtras));
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Wrote ${OUT_FILE} in ${seconds}s`);
  console.log(`Wrote ${EXTRAS_FILE} (${Object.keys(modalExtras).length.toLocaleString()} shows with modal extras)`);

  // Both output files are committed to GitHub, which hard-rejects any file
  // of 100 MiB or more at push time. Fail the build here instead so the
  // refresh workflow dies with an actionable message at the build step,
  // not with a cryptic pre-receive error at the push step. If this fires,
  // move more per-match fields into show-modal-extras.json (or shard it).
  const GITHUB_FILE_CAP = 100 * 1024 * 1024;
  const SIZE_WARN = 90 * 1024 * 1024;
  for (const f of [OUT_FILE, EXTRAS_FILE]) {
    const bytes = fs.statSync(f).size;
    const mib = (bytes / 1048576).toFixed(1);
    console.log(`  ${path.basename(f)}: ${mib} MiB`);
    if (bytes >= GITHUB_FILE_CAP) {
      console.error(`ERROR: ${f} is ${mib} MiB — at or over GitHub's 100 MiB file cap; the refresh push would be rejected. Move more per-match fields into the side-file split in build-data.js.`);
      process.exit(1);
    }
    if (bytes >= SIZE_WARN) {
      console.warn(`WARNING: ${f} is ${mib} MiB — within 10 MiB of GitHub's 100 MiB file cap.`);
    }
  }

  // Update changelog.json so the "What's new" footer chip stays in sync. The
  // footer guards the chip on `latest.builtAt === dataset.builtAt`, so writing
  // a new data.json without also writing a matching changelog entry silently
  // hides the chip. data.json no longer lives in git, so build-changelog's
  // HEAD fallback finds no baseline here: it only writes an initial entry
  // when the changelog is empty and skips otherwise (the refresh workflow
  // writes the real entry via --prev against the release baseline).
  // Skip when explicitly opted out (e.g., test fixtures, dry runs).
  if (process.env.SKIP_CHANGELOG !== '1') {
    try {
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath,
        [path.join(__dirname, 'build-changelog.js')],
        { stdio: 'inherit', cwd: path.join(__dirname, '..', '..', '..') });
    } catch (err) {
      console.warn(`build-changelog step failed: ${err.message}`);
    }
  }
})();
