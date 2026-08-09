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
const {
  renderShowsIndex, renderShowsLetterPage, groupByLetter, letterPages,
} = require('./render-shows-index.js');
const {
  renderShapeHub,
  renderGapHub,
  selectHubShows,
  selectGapHubShows,
  SHAPE_SLUGS,
  HUB_SLUGS,
  GAP_HUB_SLUG,
} = require('./render-shape-hub.js');
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

  // The curated set is decided BEFORE rendering: pages outside it are
  // rendered with a noindex,follow robots meta. The May 2026 full-catalogue
  // launch put ~34k templated pages in front of Google, which crawled the
  // lot and then declined to index nearly all of it (GSC "Crawled -
  // currently not indexed" ~60k by August), dragging sitewide quality
  // signals down with it. The long tail stays generated and linked for app
  // users and for link equity, but only the curated pages ask to be indexed.
  const sitemapSeries = selectSitemapSeries(series, SITEMAP_LIMIT);
  const curatedIds = new Set(sitemapSeries.map((s) => s.seriesId));

  // Decided before rendering too: only the shows that make the gap hub link
  // out to it from their recommendations block.
  const gapHubShows = selectGapHubShows(series);
  const gapHubIds = new Set(gapHubShows.map((s) => s.seriesId));

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
    const html = renderShowPage({ ...s, cast, builtAt: data.builtAt, dominantShape, dominantShapeSlug, relatedShows, inSitemap: curatedIds.has(s.seriesId), inGapHub: gapHubIds.has(s.seriesId) });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    pageCount++;
    if (pageCount % 1000 === 0) {
      console.log(`[build-show-pages] ${pageCount}/${series.length}…`);
    }
  }

  // The browse index: a small /shows/ hub plus paginated per-letter pages.
  // Every show appears on exactly one letter page, which matters because the
  // sitemap lists only the curated top ~2,000 and these pages are the sole
  // crawl path to the other ~32,500.
  const indexEntries = series.map(toIndexEntry);
  fs.writeFileSync(
    path.join(SHOWS_DIR, 'index.html'),
    renderShowsIndex(indexEntries, data.builtAt),
  );

  const letterGroups = groupByLetter(indexEntries);
  const browsePages = letterPages(letterGroups);
  let listedShows = 0;
  for (const page of browsePages) {
    // page.path is site-absolute (/apps/rising-shows/shows/letter/s/2/); the
    // segments below SHOWS_DIR are what gets created on disk.
    const rel = page.path.replace('/apps/rising-shows/shows/', '').replace(/\/$/, '');
    const dir = path.join(SHOWS_DIR, ...rel.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      renderShowsLetterPage({ ...page, groups: letterGroups, builtAt: data.builtAt }),
    );
    listedShows += page.items.length;
  }
  // Guard the property that matters: a split that silently drops shows would
  // orphan them from every crawl path, and nothing else here would notice.
  if (listedShows !== indexEntries.length) {
    throw new Error(`browse pages list ${listedShows} shows but there are ${indexEntries.length}; every show must stay reachable`);
  }
  console.log(`[build-show-pages] browse index · ${letterGroups.size} letters · ${browsePages.length} pages · ${listedShows} shows listed`);

  // Per-shape topic hubs. Safe to nest inside SHOWS_DIR: show directories
  // always end in -tt<digits>, so "shape" can never collide with one.
  for (const slug of SHAPE_SLUGS) {
    const dir = path.join(SHOWS_DIR, 'shape', slug);
    fs.mkdirSync(dir, { recursive: true });
    const hubShows = selectHubShows(series, slug);
    fs.writeFileSync(path.join(dir, 'index.html'), renderShapeHub(slug, hubShows, data.builtAt));
    console.log(`[build-show-pages] shape hub /${slug}/ · ${hubShows.length} shows`);
  }

  // The gap hub: same shell, ranked by avg episode rating minus the show's
  // own IMDb rating rather than by shape membership.
  const gapDir = path.join(SHOWS_DIR, 'shape', GAP_HUB_SLUG);
  fs.mkdirSync(gapDir, { recursive: true });
  fs.writeFileSync(path.join(gapDir, 'index.html'), renderGapHub(gapHubShows, data.builtAt));
  console.log(`[build-show-pages] gap hub /${GAP_HUB_SLUG}/ · ${gapHubShows.length} shows · gap ${gapHubShows[0] ? gapHubShows[0].gap : 0} down to ${gapHubShows.length ? gapHubShows.at(-1).gap : 0}`);

  fs.writeFileSync(SITEMAP_FILE, renderShowsSitemap(
    sitemapSeries.map(toIndexEntry), data.builtAt, HUB_SLUGS,
    browsePages.map((p) => p.path),
  ));
  console.log(`[build-show-pages] sitemap curated to top ${sitemapSeries.length} of ${series.length} series by votes; the rest stay reachable for app users but carry noindex,follow`);

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
