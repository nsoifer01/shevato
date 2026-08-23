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
  minSeasons: 0,
  minVotes: 0,
  minShowRating: 0,
  minAvgEpisode: 0,
  gapDir: 'any',
  minGap: 0,
  minYear: null,
  maxYear: null,
  hiddenGems: false,
  sort: 'votes',
  sortDir: 'desc',
  view: 'grid',
  page: 1,
};

// A show is a "hidden gem" when it is highly rated yet under-watched:
// episode-weighted average episode rating >= 8.5 and fewer than 500 IMDb votes
// per rated episode. Mirrors the old per-season hidden-gem rule.
const HIDDEN_GEM_MIN_AVG = 8.5;
const HIDDEN_GEM_MAX_VOTES_PER_EP = 500;

// Categorical season-level tags the trajectory classifier never emits. A show
// carries one when any of its seasons does, so shape chips and #shape= links
// work for them (matching how the per-shape hub pages and Kometa treat them).
const CATEGORICAL_SHAPES = ['saved-best-for-last', 'shape-drift'];

/**
 * The single definition of "what shape is this show".
 *
 * Feeds the ordered per-SEASON averages to the same detectors match.js runs
 * per episode, then appends any categorical tag a season carries. The result
 * describes the show's trajectory across its run, which is the product's whole
 * premise.
 *
 * Extracted so the browser Finder (through buildShowAgg) and the static page
 * builder (through render-show-page's computeDominantShape) share one
 * implementation. They previously each had their own idea of a show's shape
 * and disagreed on 83.5% of the catalogue: the static side classified the
 * EPISODES inside a show's single highest-rated season and labelled that as
 * the show's shape, so Game of Thrones read "slow-burn" on its page and
 * "front-loaded, bad-finale, shape-drift" in the app, and a third of some hub
 * pages listed shows the app's own filter would reject.
 *
 * When the show's newest season is still airing, its average is a few episodes
 * deep and is NOT the show's last word, so the finale-dependent shapes
 * (big-finale, bad-finale, u-shaped) must not be derived from it - that is what
 * `options.inProgress` says, and detectShapes suppresses exactly those three.
 * The partial season stays in `seasonAvgs`, so the card sparkline and the
 * season list still show it; only the finale claim is withheld.
 *
 * @param {number[]} seasonAvgs per-season average ratings, ORDERED by season
 * @param {Set<string>} categoricalTags tags any season carries
 * @param {Function} detectShapes match.js's classifier, passed in so the
 *   browser can hand over its global and a missing one degrades to no shapes
 * @param {{inProgress?: boolean}} [options] inProgress: the last entry of
 *   seasonAvgs comes from a season that has not finished airing
 * @returns {string[]} trajectory shapes first, then categorical tags
 */
function deriveShowShapes(seasonAvgs, categoricalTags, detectShapes, options) {
  // A single season has no cross-season trajectory, so such shows carry no
  // trajectory shape (they can still carry categorical tags).
  const trajectoryShapes = (seasonAvgs.length >= 2 && typeof detectShapes === 'function')
    ? detectShapes(
      seasonAvgs.map((avg) => ({ rating: avg })),
      (options && options.inProgress) ? { inProgress: true } : undefined,
    )
    : [];
  return trajectoryShapes.concat(
    CATEGORICAL_SHAPES.filter((t) => categoricalTags.has(t) && !trajectoryShapes.includes(t)),
  );
}

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
        categoricalShapes: new Set(),
        // Highest season number seen, and whether that season is still airing
        // (build-data stamps `inProgress` on it). Drives the finale-dependent
        // half of deriveShowShapes below.
        lastSeason: null,
        lastSeasonInProgress: false,
      };
      byId.set(m.seriesId, s);
    }
    // saved-best-for-last and shape-drift are categorical season-level tags
    // (never produced by the trajectory classifier below); carry them up to
    // the show so the Finder's shape chips and #shape= links can match them.
    for (const tag of CATEGORICAL_SHAPES) {
      if ((m.shapes || []).includes(tag)) s.categoricalShapes.add(tag);
    }
    if (typeof m.season === 'number' && (s.lastSeason === null || m.season > s.lastSeason)) {
      s.lastSeason = m.season;
      s.lastSeasonInProgress = m.inProgress === true;
    }
    // External IDs ride on every season record post-enrichment; keep the
    // first one seen so the Kometa export can build tmdb_show/tvdb_show lists.
    if (s.tmdbId == null && m.tmdbId != null) s.tmdbId = m.tmdbId;
    if (s.tvdbId == null && m.tvdbId != null) s.tvdbId = m.tvdbId;
    for (const g of (m.genres || [])) s.genres.add(g);
    // Two input shapes are supported on purpose.
    //
    // Full records (`m.episodes` present) are what the Node side always has:
    // build-show-pages.js, export-integrations.js and every unit test read the
    // unsplit data.json. Those keep the original per-episode walk.
    //
    // Split records (no `m.episodes`, but `ratedCount` / `ratingSum` /
    // optional `epRatings`) are what the BROWSER now receives, because the
    // per-episode arrays were 40% of the payload and the grid never displayed
    // them. scripts/split-data.js folds the same sums down at build time, so
    // both paths produce identical aggregates.
    let seasonRated = 0;
    let seasonRatingSum = 0;
    const seasonEpisodes = [];
    if (Array.isArray(m.episodes)) {
      for (const e of m.episodes) {
        if (typeof e.rating === 'number') {
          s.ratingSum += e.rating;
          s.episodes++;
          seasonRated++;
          seasonRatingSum += e.rating;
          seasonEpisodes.push({ episode: e.episode, rating: e.rating, votes: e.votes });
        }
      }
    } else {
      // Numbers only. `|| 0` alone would let a string through and turn every
      // downstream += into string concatenation, poisoning the whole series
      // fold the way one unrated episode once NaN-poisoned aboveImdb.
      seasonRated = Number.isFinite(m.ratedCount) ? m.ratedCount : 0;
      seasonRatingSum = Number.isFinite(m.ratingSum) ? m.ratingSum : 0;
      s.ratingSum += seasonRatingSum;
      s.episodes += seasonRated;
      // epRatings is only shipped for single-season shows, which are the only
      // ones whose card sparkline is drawn from episodes rather than season
      // averages. Episode numbers are positional; votes are not read by the
      // sparkline, so they are not carried.
      if (Array.isArray(m.epRatings)) {
        for (let i = 0; i < m.epRatings.length; i++) {
          seasonEpisodes.push({ episode: i + 1, rating: m.epRatings[i], votes: 0 });
        }
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
    // A show with no IMDb SERIES rating cannot be scored on what this Finder
    // is for: the gap (avgEpisode - showRating) is its headline metric, and
    // the show-rating filter, the gap direction segments and the hidden-gems
    // rule all read it. Those series are dropped from the grid rather than
    // shown with blanks. On the 2026-08-22 catalogue that is exactly 77 of
    // 34,692 series (0.2%), which is why the Finder says "34,615 shows": every
    // one of them is a title IMDb itself has no series-level score for. They
    // are NOT lost: build-show-pages.js still renders each one a static page
    // (which omits aggregateRating rather than inventing one), the A-Z index
    // still links them, and a #show= deep link still opens the modal.
    if (typeof s.showRating !== 'number' || typeof s.votes !== 'number') continue;
    // Integer tenths, not float multiply-then-round. IMDb ratings carry one
    // decimal, so the sum is exactly a multiple of 0.1 and `sum * 10` is an
    // integer; going through it makes the result independent of the order the
    // sum was accumulated in. Without that, a show whose average lands exactly
    // on a .005 boundary (The Boys: 327.4 over 40 episodes) rounded to 8.18
    // from one accumulation order and 8.19 from another, so the static page and
    // the app printed different numbers for the same show. 545 shows did.
    const avgEpisode = Math.round((Math.round(s.ratingSum * 10) * 10) / s.episodes) / 100;
    const gap = Math.round((avgEpisode - s.showRating) * 100) / 100;
    const episodeSeries = s.seasonsCount === 1 ? s.seasonEpisodeSeries[0] : undefined;
    const seasonAvgs = s.seasonAvgs.slice().sort((a, b) => a.season - b.season);
    // Whole-show shape: feed the ordered per-season averages to the same shape
    // detectors the Seasons view uses per episode. See deriveShowShapes, which
    // the static page builder calls too so the two surfaces cannot disagree.
    const shapes = deriveShowShapes(
      seasonAvgs.map((a) => a.avg),
      s.categoricalShapes,
      detectShapes,
      { inProgress: s.lastSeasonInProgress },
    );
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
//
// Params use clean names (sort, minVotes, shape, ...). Each also accepts its
// legacy `f`-prefixed spelling (fSort, fMinVotes, fShape, ...) from the era
// when the Finder shared the hash with the Seasons view, so pre-rename shared
// links and bookmarks keep working. The clean name wins when both are present;
// writeFinderStateToURL emits clean names only.
function parseFinderQuery(query) {
  const p = (typeof query === 'string')
    ? new URLSearchParams(query.replace(/^#/, ''))
    : query;
  const get = (name, legacy) => (p.get(name) != null ? p.get(name) : p.get(legacy));
  const has = (name, legacy) => p.has(name) || p.has(legacy);
  // `view` is special: legacy links carry `view=finder` (a retired view
  // selector, not a layout), so only grid/list counts before falling back.
  const view = ['grid', 'list'].includes(p.get('view')) ? p.get('view') : p.get('fView');
  const gapDir = get('gapDir', 'fGapDir');
  return {
    search: p.get('q') || '',
    view: view === 'list' ? 'list' : 'grid',
    sort: get('sort', 'fSort') || 'votes',
    sortDir: get('dir', 'fDir') === 'asc' ? 'asc' : 'desc',
    minEpisodes: parseFloat(get('minEps', 'fMinEps')) || 0,
    // Newer than the rename, so there is no legacy `f`-prefixed spelling.
    minSeasons: parseFloat(p.get('minSeasons')) || 0,
    minVotes: parseFloat(get('minVotes', 'fMinVotes')) || 0,
    minShowRating: parseFloat(get('minShow', 'fMinShow')) || 0,
    minAvgEpisode: parseFloat(get('minAvg', 'fMinAvg')) || 0,
    gapDir: ['up', 'down'].includes(gapDir) ? gapDir : 'any',
    minGap: parseFloat(get('minGap', 'fMinGap')) || 0,
    minYear: has('minYear', 'fMinYear') ? (parseInt(get('minYear', 'fMinYear'), 10) || null) : null,
    maxYear: has('maxYear', 'fMaxYear') ? (parseInt(get('maxYear', 'fMaxYear'), 10) || null) : null,
    hiddenGems: get('gems', 'fGems') === 'on',
    genres: new Set((get('genres', 'fg') || '').split(',').filter(Boolean)),
    genresExclude: new Set((get('xgenres', 'fxg') || '').split(',').filter(Boolean)),
    languages: new Set((get('langs', 'fl') || '').split(',').filter(Boolean)),
    shapes: new Set((get('shape', 'fShape') || '').split(',').filter(Boolean)),
    page: Math.max(1, parseInt(p.get('page'), 10) || 1),
  };
}

// Every Finder filter EXCEPT the shape filter (shape chips need live counts of
// rows passing everything else - see finderRowsBeforeShape in app.js).
function passesFinderFilters(s, f) {
  const q = (f.search || '').trim().toLowerCase();
  if (q) {
    // Diacritic-folded compare when the caller supplies folded strings: the
    // browser precomputes f.searchFold (once per render) and s.titleFold (once
    // per row, in app.js indexShowAgg) so an ASCII query finds an accented
    // title ("Pokemon" finds the accented spelling, "Shogun" the macron one).
    // Node callers pass neither and keep the plain compare. Folding itself
    // lives in app.js; this side only consumes the fields.
    const needle = f.searchFold || q;
    const hay = s.titleFold || s.title.toLowerCase();
    if (!hay.includes(needle) && !s.seriesId.toLowerCase().includes(q)) return false;
  }
  if (s.episodes < f.minEpisodes) return false;
  if (s.seasonsCount < f.minSeasons) return false;
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
  if (f.hiddenGems) {
    if (s.avgEpisode < HIDDEN_GEM_MIN_AVG) return false;
    if (s.episodes === 0 || (s.votes / s.episodes) >= HIDDEN_GEM_MAX_VOTES_PER_EP) return false;
  }
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
    // Runtime is 0 for the ~14.6k shows IMDb has no episode runtimes for. That
    // is "unknown", not "zero hours", so those rows sink to the bottom in both
    // directions rather than owning the whole first page of a Runtime-ascending
    // sort. Same treatment as a null year above.
    if (key === 'runtimeHrs' && (!(a.runtimeHrs > 0) || !(b.runtimeHrs > 0))) {
      const aUnknown = !(a.runtimeHrs > 0);
      const bUnknown = !(b.runtimeHrs > 0);
      if (aUnknown && bUnknown) return b.votes - a.votes;
      return aUnknown ? 1 : -1;
    }
    let d = key === 'title' ? a.title.localeCompare(b.title) : a[key] - b[key];
    // A sort key that is not numeric on these rows (an unknown key out of a
    // hand-edited hash, or a nullable one) subtracts to NaN, and a comparator
    // returning NaN leaves the order up to the engine. Fall through to the
    // votes tie-break instead, so the grid is always deterministic.
    if (!Number.isFinite(d)) d = 0;
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
  HIDDEN_GEM_MIN_AVG,
  HIDDEN_GEM_MAX_VOTES_PER_EP,
  CATEGORICAL_SHAPES,
  deriveShowShapes,
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
  window.RisingShowsFinder = API;
}
