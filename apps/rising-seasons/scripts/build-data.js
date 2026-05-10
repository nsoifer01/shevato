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
//   MIN_EPISODES (default 4)   — minimum rated episodes per season
//   MIN_VOTES    (default 100) — every episode must have at least this many votes

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const { findMatches } = require('./match.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(__dirname, '..', 'data.json');
const TMDB_CACHE = path.join(DATA_DIR, 'tmdb-cache.json');

const MIN_EPISODES = parseInt(process.env.MIN_EPISODES || '4', 10);
const MIN_VOTES = parseInt(process.env.MIN_VOTES || '100', 10);
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

async function loadSeries() {
  const series = new Map();
  const rl = openTsv('title.basics.tsv.gz');
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const cols = line.split('\t');
    // tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtimeMinutes, genres
    const titleType = cols[1];
    if (!SERIES_TYPES.has(titleType)) continue;
    const startYear = cols[5];
    const genresRaw = cols[8];
    const genres = (!genresRaw || genresRaw === '\\N') ? [] : genresRaw.split(',');
    series.set(cols[0], {
      title: cols[2],
      year: startYear === '\\N' ? null : parseInt(startYear, 10),
      type: titleType,
      genres,
    });
  }
  return series;
}

async function loadEpisodes(series, ratings) {
  // Map<seriesId, Map<seasonNumber, Array<{episode, tconst, rating, votes}>>>
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
    arr.push({ episode, tconst, rating: r.rating, votes: r.votes });
  }
  return result;
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

  process.stdout.write('Loading series basics... ');
  const series = await loadSeries();
  console.log(`${series.size.toLocaleString()} TV series + mini-series`);

  process.stdout.write('Loading episodes... ');
  const episodes = await loadEpisodes(series, ratings);
  console.log(`${episodes.size.toLocaleString()} series have rated episodes`);

  process.stdout.write('Detecting shape matches... ');
  const matches = findMatches(series, episodes, {
    minEpisodes: MIN_EPISODES,
    minVotes: MIN_VOTES,
  });
  console.log(`${matches.length.toLocaleString()} matching seasons`);

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

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    builtAt: new Date().toISOString(),
    minEpisodes: MIN_EPISODES,
    minVotes: MIN_VOTES,
    count: matches.length,
    shapeCounts,
    genres,
    matches,
  }));
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Wrote ${OUT_FILE} in ${seconds}s`);
})();
