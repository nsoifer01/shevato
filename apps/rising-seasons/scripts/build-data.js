#!/usr/bin/env node
'use strict';

// Build a list of TV seasons whose episode IMDb ratings fit one or more
// "shape" patterns (rising, consistent, slow-burn, big-finale, rebound).
// Reads three gzipped TSVs from IMDb's free non-commercial datasets and,
// optionally, a tmdb-cache.json produced by enrich-tmdb.js.
//
// See ../README.md for download instructions.
//
// Inputs (place in apps/rising-seasons/data/):
//   title.basics.tsv.gz
//   title.episode.tsv.gz
//   title.ratings.tsv.gz
// Optional:
//   tmdb-cache.json  — produced by `npm run enrich:rising-seasons`
//
// Output: apps/rising-seasons/data.json
//
// Tunables (env vars):
//   MIN_EPISODES     (default 4)   — minimum rated episodes per season
//   MIN_VOTES        (default 100) — every episode must have at least this many votes
//   RELAX_GENRES     (default "Reality-TV,Game-Show,Talk-Show") — comma-list of
//                                    IMDb genres whose series get the lower floor below
//   RELAX_MIN_VOTES  (default 10)  — per-episode vote floor for the relaxed-genre series.
//                                    Reality/competition episodes typically draw 10-50
//                                    IMDb votes, so the standard 100 wipes them out.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const { findMatches } = require('./match.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(__dirname, '..', 'data.json');
const TMDB_CACHE = path.join(DATA_DIR, 'tmdb-cache.json');

// Default 3 (was 4) so short-season formats like BBC Sherlock (3 eps/season)
// are included. Most shape detectors require >= 4 episodes internally, so
// short seasons will be emitted as shape-less rows under the parent show
// rather than appearing as their own pattern hits.
const MIN_EPISODES = parseInt(process.env.MIN_EPISODES || '3', 10);
const MIN_VOTES = parseInt(process.env.MIN_VOTES || '100', 10);
const RELAX_GENRES = (process.env.RELAX_GENRES ?? 'Reality-TV,Game-Show,Talk-Show')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RELAX_MIN_VOTES = parseInt(process.env.RELAX_MIN_VOTES || '10', 10);
const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

function openTsv(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing dataset file: ${filePath}\n` +
      `Download from https://datasets.imdbws.com/ — see apps/rising-seasons/README.md`,
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
    const r = ratings.get(tconst);
    if (!r) continue;
    const season = parseInt(seasonRaw, 10);
    const episode = parseInt(episodeRaw, 10);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
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
  return result;
}

// TMDB returns each plan as a separate provider ("Netflix" / "Netflix
// Standard with Ads", "Peacock Premium" / "Peacock Premium Plus", channel
// variants like "HBO Max Amazon Channel"). Users care about the brand, so
// collapse to the parent. Anything we don't recognize passes through.
function normalizeProvider(name) {
  if (/^Netflix/i.test(name)) return 'Netflix';
  if (/^Amazon Prime Video/i.test(name)) return 'Amazon Prime Video';
  if (/^HBO Max/i.test(name)) return 'HBO Max';
  if (/^Max\b/i.test(name)) return 'HBO Max';
  if (/^Peacock/i.test(name)) return 'Peacock';
  if (/^Hulu/i.test(name)) return 'Hulu';
  if (/^Disney( Plus|\+)/i.test(name)) return 'Disney+';
  if (/^Apple TV/i.test(name)) return 'Apple TV+';
  if (/^Paramount( Plus|\+)/i.test(name)) return 'Paramount+';
  if (/^Crunchyroll/i.test(name)) return 'Crunchyroll';
  if (/^Starz/i.test(name)) return 'Starz';
  if (/^Showtime/i.test(name)) return 'Showtime';
  if (/^AMC\+/i.test(name) || /^AMC Plus/i.test(name)) return 'AMC+';
  return name;
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
  const episodes = await loadEpisodes(series, ratings, episodeTitles, episodeYears, episodeRuntimes);
  console.log(`${episodes.size.toLocaleString()} series have rated episodes`);

  process.stdout.write('Detecting shape matches... ');
  const matches = findMatches(series, episodes, {
    minEpisodes: MIN_EPISODES,
    minVotes: MIN_VOTES,
    relaxedGenres: new Set(RELAX_GENRES),
    relaxedMinVotes: RELAX_MIN_VOTES,
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
        if (t.original_language) m.language = t.original_language;
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
    console.log('(No TMDB cache present — run `npm run enrich:rising-seasons` to add posters/overviews.)');
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

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    builtAt: new Date().toISOString(),
    minEpisodes: MIN_EPISODES,
    minVotes: MIN_VOTES,
    relaxedGenres: RELAX_GENRES,
    relaxedMinVotes: RELAX_MIN_VOTES,
    count: matches.length,
    shapeCounts,
    genres,
    languages,
    providers,
    matches,
  }));
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Wrote ${OUT_FILE} in ${seconds}s`);
})();
