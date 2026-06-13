// Show Finder core: aggregate season records to show-level rows, parse a
// Finder URL-hash query into a filter object, and apply/sort those filters.
// Loaded by js/app.js in the browser AND by the Node export pipeline
// (scripts/export-integrations.js) so a Finder preset exported to Kometa is
// guaranteed to match exactly what the Show Finder view displays for the same
// hash. Keep this file free of Node-specific APIs (no fs/path/process) and
// free of DOM access - see the UMD-style export at the bottom.
'use strict';

// Defaults mirror `finderState` in js/app.js - a missing query param always
// means "filter inactive", so parse + serialize round-trip cleanly.
const FINDER_DEFAULTS = {
  search: '',
  minEpisodes: 0,
  minVotes: 0,
  minShowRating: 0,
  minAvgEpisode: 0,
  gapDir: 'any',
  minGap: 0,
  minYear: null,
  maxYear: null,
  sort: 'votes',
  sortDir: 'desc',
  view: 'grid',
  page: 1,
};

// Aggregate per-season records (data.json `matches`) into one row per series.
// `detectShapes` is the per-episode shape classifier from match.js - passed in
// rather than required so the browser can hand over its global and a missing
// classifier degrades to "no shapes" instead of throwing.
function buildShowAgg(matches, detectShapes) {
  const byId = new Map();
  for (const m of matches) {
    let s = byId.get(m.seriesId);
    if (!s) {
      s = {
        seriesId: m.seriesId,
        title: m.title,
        year: m.year,
        language: m.language,
        poster: m.poster,
        showRating: m.seriesRating,
        votes: m.seriesVotes,
        tmdbId: null,
        tvdbId: null,
        genres: new Set(),
        ratingSum: 0,
        episodes: 0,
        runtimeHrs: 0,
        seasonsCount: 0,
        seasonAvgs: [],
        seasonEpisodeSeries: [],
      };
      byId.set(m.seriesId, s);
    }
    // External IDs ride on every season record post-enrichment; keep the
    // first one seen so the Kometa export can build tmdb_show/tvdb_show lists.
    if (s.tmdbId == null && m.tmdbId != null) s.tmdbId = m.tmdbId;
    if (s.tvdbId == null && m.tvdbId != null) s.tvdbId = m.tvdbId;
    for (const g of (m.genres || [])) s.genres.add(g);
    let seasonRated = 0;
    let seasonRatingSum = 0;
    const seasonEpisodes = [];
    for (const e of m.episodes) {
      if (typeof e.rating === 'number') {
        s.ratingSum += e.rating;
        s.episodes++;
        seasonRated++;
        seasonRatingSum += e.rating;
        seasonEpisodes.push({ episode: e.episode, rating: e.rating, votes: e.votes });
      }
    }
    s.seasonEpisodeSeries.push(seasonEpisodes);
    s.seasonsCount++;
    const seasonAvg = typeof m.avgRating === 'number'
      ? m.avgRating
      : (seasonRated > 0 ? seasonRatingSum / seasonRated : null);
    if (typeof seasonAvg === 'number' && typeof m.season === 'number') {
      s.seasonAvgs.push({ season: m.season, year: (m.seasonYear ?? m.year), avg: seasonAvg });
    }
    if (typeof m.avgRuntime === 'number') {
      s.runtimeHrs += (seasonRated * m.avgRuntime) / 60;
    }
  }

  const out = [];
  for (const s of byId.values()) {
    if (s.episodes === 0) continue;
    if (typeof s.showRating !== 'number' || typeof s.votes !== 'number') continue;
    const avgEpisode = Math.round((s.ratingSum / s.episodes) * 100) / 100;
    const gap = Math.round((avgEpisode - s.showRating) * 100) / 100;
    const episodeSeries = s.seasonsCount === 1 ? s.seasonEpisodeSeries[0] : undefined;
    const seasonAvgs = s.seasonAvgs.slice().sort((a, b) => a.season - b.season);
    // Whole-show shape: feed the ordered per-season averages to the same shape
    // detectors the Seasons view uses per episode. A single season has no
    // cross-season trajectory, so such shows carry no shape and are excluded
    // when a shape filter is active.
    const shapes = (seasonAvgs.length >= 2 && typeof detectShapes === 'function')
      ? detectShapes(seasonAvgs.map((a) => ({ rating: a.avg })))
      : [];
    out.push({
      seriesId: s.seriesId,
      title: s.title,
      year: s.year,
      language: s.language,
      poster: s.poster,
      tmdbId: s.tmdbId,
      tvdbId: s.tvdbId,
      genres: [...s.genres].sort(),
      showRating: s.showRating,
      votes: s.votes,
      episodes: s.episodes,
      avgEpisode,
      gap,
      runtimeHrs: Math.round((s.runtimeHrs) * 10) / 10,
      seasonsCount: s.seasonsCount,
      seasonAvgs,
      shapes,
      episodeSeries,
    });
  }
  return out;
}

// Parse a Finder URL hash (the part after `#`, with or without the leading
// `#`) or a URLSearchParams into a full filter-state object. Unknown params
// are ignored; missing params fall back to the inactive-filter defaults, so
// pasting any shared Finder link reproduces that exact view.
function parseFinderQuery(query) {
  const p = (typeof query === 'string')
    ? new URLSearchParams(query.replace(/^#/, ''))
    : query;
  return {
    search: p.get('q') || '',
    view: p.get('fView') === 'list' ? 'list' : 'grid',
    sort: p.get('fSort') || 'votes',
    sortDir: p.get('fDir') === 'asc' ? 'asc' : 'desc',
    minEpisodes: parseFloat(p.get('fMinEps')) || 0,
    minVotes: parseFloat(p.get('fMinVotes')) || 0,
    minShowRating: parseFloat(p.get('fMinShow')) || 0,
    minAvgEpisode: parseFloat(p.get('fMinAvg')) || 0,
    gapDir: ['up', 'down'].includes(p.get('fGapDir')) ? p.get('fGapDir') : 'any',
    minGap: parseFloat(p.get('fMinGap')) || 0,
    minYear: p.has('fMinYear') ? (parseInt(p.get('fMinYear'), 10) || null) : null,
    maxYear: p.has('fMaxYear') ? (parseInt(p.get('fMaxYear'), 10) || null) : null,
    genres: new Set((p.get('fg') || '').split(',').filter(Boolean)),
    genresExclude: new Set((p.get('fxg') || '').split(',').filter(Boolean)),
    languages: new Set((p.get('fl') || '').split(',').filter(Boolean)),
    shapes: new Set((p.get('fShape') || '').split(',').filter(Boolean)),
    page: Math.max(1, parseInt(p.get('page'), 10) || 1),
  };
}

// Every Finder filter EXCEPT the shape filter (shape chips need live counts of
// rows passing everything else - see finderRowsBeforeShape in app.js).
function passesFinderFilters(s, f) {
  const q = (f.search || '').trim().toLowerCase();
  if (q && !s.title.toLowerCase().includes(q) && !s.seriesId.toLowerCase().includes(q)) return false;
  if (s.episodes < f.minEpisodes) return false;
  if (s.votes < f.minVotes) return false;
  if (s.showRating < f.minShowRating) return false;
  if (s.avgEpisode < f.minAvgEpisode) return false;
  if (f.gapDir === 'up') {
    if (s.gap <= 0) return false;
    if (s.gap < f.minGap) return false;
  } else if (f.gapDir === 'down') {
    if (s.gap >= 0) return false;
    if (-s.gap < f.minGap) return false;
  } else if (f.minGap > 0 && Math.abs(s.gap) < f.minGap) {
    return false;
  }
  if (f.minYear != null && (s.year == null || s.year < f.minYear)) return false;
  if (f.maxYear != null && (s.year == null || s.year > f.maxYear)) return false;
  if (f.genres.size) {
    for (const g of f.genres) if (!s.genres.includes(g)) return false;
  }
  if (f.genresExclude.size) {
    for (const g of s.genres) if (f.genresExclude.has(g)) return false;
  }
  if (f.languages.size && !f.languages.has(s.language)) return false;
  return true;
}

// AND semantics: the row must carry every selected shape.
function passesShapeAnd(s, shapeSet) {
  if (shapeSet.size === 0) return true;
  for (const sh of shapeSet) if (!s.shapes.includes(sh)) return false;
  return true;
}

// The Finder's sort comparator. Unknown years always sink to the bottom,
// independent of sort direction; votes break every other tie.
function finderComparator(key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    if (key === 'year' && (a.year == null || b.year == null)) {
      if (a.year == null && b.year == null) return b.votes - a.votes;
      return a.year == null ? 1 : -1;
    }
    let d = key === 'title' ? a.title.localeCompare(b.title) : a[key] - b[key];
    if (d === 0 && key !== 'votes') d = b.votes - a.votes;
    return d * mul;
  };
}

// One-call convenience for the export pipeline: full filter + shape + sort.
function filterAndSortRows(rows, f) {
  return rows
    .filter((s) => passesFinderFilters(s, f) && passesShapeAnd(s, f.shapes))
    .sort(finderComparator(f.sort, f.sortDir));
}

const API = {
  FINDER_DEFAULTS,
  buildShowAgg,
  parseFinderQuery,
  passesFinderFilters,
  passesShapeAnd,
  finderComparator,
  filterAndSortRows,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else if (typeof window !== 'undefined') {
  window.RisingSeasonsFinder = API;
}
