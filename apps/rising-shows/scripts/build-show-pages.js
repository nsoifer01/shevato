#!/usr/bin/env node
'use strict';

// Generate static per-show HTML pages, an A-Z browse index, and a
// sitemap from apps/rising-shows/data.json. Runs at Netlify build
// time, so the generated files don't live in git — they're a pure
// derivation of the committed data.json.

const fs = require('fs');
const path = require('path');

const { showPath } = require('./slugify.js');
const { renderShowPage, computeDominantShape } = require('./render-show-page.js');
const { renderShowsIndex } = require('./render-shows-index.js');
const { renderShapeHub, selectHubShows, SHAPE_SLUGS } = require('./render-shape-hub.js');
const { renderShowsSitemap, selectSitemapSeries } = require('./render-sitemap.js');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const EXTRAS_FILE = path.join(ROOT, 'data', 'show-modal-extras.json');
const SHOWS_DIR = path.join(ROOT, 'shows');
const SITEMAP_FILE = path.join(ROOT, 'sitemap-shows.xml');

// Only the most-voted shows go into the sitemap (all pages are still
// built). At 2,000 the cutoff sits around 15k IMDb votes, i.e. shows
// with real search demand. See renderShowsSitemap for the rationale.
const SITEMAP_LIMIT = 2000;

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`data.json not found at ${DATA_FILE}. Run \`npm run build:rising-shows\` first.`);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(data.matches)) {
    throw new Error('data.json has no `matches` array — bad input.');
  }
  const series = groupBySeries(data.matches);
  console.log(`[build-show-pages] ${series.length} unique series · ${data.matches.length} seasons · builtAt=${data.builtAt}`);

  // Cast and per-episode titles live in show-modal-extras.json
  // (build-data.js strips them out of data.json's matches), keyed by
  // seriesId. Load it so each show page can render the same top-billed
  // cast strip the in-app modal shows, plus episode names in the
  // per-season tables. Missing file is non-fatal — pages just render
  // without cast and with blank episode-title cells.
  const extras = fs.existsSync(EXTRAS_FILE) ? JSON.parse(fs.readFileSync(EXTRAS_FILE, 'utf8')) : {};
  let castCount = 0;

  // Build shape → series lookup for recommendations panel.
  const shapeIndex = buildShapeIndex(series);

  fs.rmSync(SHOWS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOWS_DIR, { recursive: true });

  let pageCount = 0;
  const start = Date.now();
  for (const s of series) {
    const dir = path.join(SHOWS_DIR, showPath(s.title, s.seriesId));
    fs.mkdirSync(dir, { recursive: true });
    const { dominantShape, dominantShapeSlug } = computeDominantShape(s);
    const relatedShows = computeRelatedShows(s, dominantShape, shapeIndex, 4);
    const ex = extras[s.seriesId];
    const cast = ex && ex.cast ? ex.cast : null;
    if (cast) castCount++;
    // Merge per-episode titles back onto the season episode rows.
    // Guarded with `!ep.name` so a pre-split data.json (inline names)
    // keeps working while the daily refresh flips the format.
    if (ex && ex.seasons) {
      for (const season of s.seasons) {
        const sRec = ex.seasons[String(season.season)];
        if (!sRec || !sRec.eps || !Array.isArray(season.episodes)) continue;
        for (const ep of season.episodes) {
          const rec = sRec.eps[String(ep.episode)];
          if (rec && rec.n && !ep.name) ep.name = rec.n;
        }
      }
    }
    const html = renderShowPage({ ...s, cast, builtAt: data.builtAt, dominantShape, dominantShapeSlug, relatedShows });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    pageCount++;
    if (pageCount % 1000 === 0) {
      console.log(`[build-show-pages] ${pageCount}/${series.length}…`);
    }
  }

  fs.writeFileSync(
    path.join(SHOWS_DIR, 'index.html'),
    renderShowsIndex(series.map(toIndexEntry), data.builtAt),
  );

  // Per-shape topic hubs. Safe to nest inside SHOWS_DIR: show directories
  // always end in -tt<digits>, so "shape" can never collide with one.
  for (const slug of SHAPE_SLUGS) {
    const dir = path.join(SHOWS_DIR, 'shape', slug);
    fs.mkdirSync(dir, { recursive: true });
    const hubShows = selectHubShows(series, slug);
    fs.writeFileSync(path.join(dir, 'index.html'), renderShapeHub(slug, hubShows, data.builtAt));
    console.log(`[build-show-pages] shape hub /${slug}/ · ${hubShows.length} shows`);
  }

  const sitemapSeries = selectSitemapSeries(series, SITEMAP_LIMIT);
  fs.writeFileSync(SITEMAP_FILE, renderShowsSitemap(sitemapSeries.map(toIndexEntry), data.builtAt, SHAPE_SLUGS));
  console.log(`[build-show-pages] sitemap curated to top ${sitemapSeries.length} of ${series.length} series by votes; the rest stay crawlable via the A-Z index`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[build-show-pages] wrote ${pageCount} show pages (${castCount} with cast) + index + sitemap in ${elapsed}s`);
}

// data.json's `matches` is a flat list of seasons. Group them by series
// so each output page covers every season of that show. Within a series,
// sort seasons numerically.
function groupBySeries(matches) {
  const map = new Map();
  for (const m of matches) {
    if (!map.has(m.seriesId)) {
      map.set(m.seriesId, {
        seriesId: m.seriesId,
        title: m.title,
        year: m.year,
        type: m.type,
        genres: m.genres,
        seriesRating: m.seriesRating,
        seriesVotes: m.seriesVotes,
        poster: m.poster,
        overview: m.overview,
        language: m.language,
        providers: m.providers,
        tmdbId: m.tmdbId,
        seasons: [],
      });
    }
    const s = map.get(m.seriesId);
    s.seasons.push({
      season: m.season,
      seasonYear: m.seasonYear,
      episodes: m.episodes,
      firstRating: m.firstRating,
      lastRating: m.lastRating,
      avgRating: m.avgRating,
      avgRuntime: m.avgRuntime,
      shapes: m.shapes,
    });
    // Series-level fields may be present on any season's record; fill
    // any holes from later seasons so we don't lose data if season 1
    // happened to be enriched but season 2 wasn't, or vice versa.
    fillIfEmpty(s, m, ['poster', 'overview', 'language', 'providers', 'tmdbId', 'seriesRating', 'seriesVotes', 'genres']);
  }
  for (const s of map.values()) {
    s.seasons.sort((a, b) => a.season - b.season);
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function fillIfEmpty(target, src, keys) {
  for (const k of keys) {
    if (target[k] == null || (Array.isArray(target[k]) && target[k].length === 0)) {
      if (src[k] != null) target[k] = src[k];
    }
  }
}

function toIndexEntry(s) {
  return { seriesId: s.seriesId, title: s.title, year: s.year };
}

// Build an inverted index: shape slug → array of series objects sorted by
// seriesVotes descending so top-voted shows come first in recommendations.
function buildShapeIndex(series) {
  const index = new Map();
  for (const s of series) {
    const shapes = new Set();
    for (const season of s.seasons) {
      for (const sh of (season.shapes || [])) shapes.add(sh);
    }
    for (const sh of shapes) {
      if (!index.has(sh)) index.set(sh, []);
      index.get(sh).push(s);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => (b.seriesVotes || 0) - (a.seriesVotes || 0));
  }
  return index;
}

// Return up to `limit` other shows that share the dominant shape, ordered
// by seriesVotes descending. Excludes the show itself.
function computeRelatedShows(show, dominantShape, shapeIndex, limit) {
  if (!dominantShape) return [];
  const candidates = shapeIndex.get(dominantShape) || [];
  const result = [];
  for (const s of candidates) {
    if (s.seriesId === show.seriesId) continue;
    const { dominantShape: rShape, dominantShapeSlug: rSlug } = computeDominantShape(s);
    result.push({
      seriesId: s.seriesId,
      title: s.title,
      year: s.year,
      poster: s.poster,
      genres: s.genres,
      dominantShape: rShape,
      dominantShapeSlug: rSlug,
      slug: showPath(s.title, s.seriesId),
    });
    if (result.length >= limit) break;
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[build-show-pages] FAILED:', e.message);
    process.exit(1);
  }
}

module.exports = { groupBySeries, computeDominantShape, buildShapeIndex, computeRelatedShows };
