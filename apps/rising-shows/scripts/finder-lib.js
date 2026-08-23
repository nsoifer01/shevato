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

// Rating sorts need their own vote floor. The dataset keeps every episode
// with 5+ votes (`minVotes` in the index header), which is the right floor
// for a catalogue but the wrong one for a ranking: "Avg episode rating"
// descending opened on 7-vote titles at 10.00 and "Show rating" on a 5-vote
// 9.6. When a rating sort is active and the user has NOT set a votes floor
// of their own, rows under this many show votes are kept in the results but
// ranked after every row at or above it. Nothing is hidden, the count does
// not change, and a user who sets any minVotes takes over the floor.
const RATING_SORT_KEYS = ['avgEpisode', 'showRating'];
const RATING_SORT_VOTE_FLOOR = 1000;

// The "Above IMDb" badge is a claim that a show's episodes out-rate the show
// itself. Under this many show votes a handful of fans rating every episode
// 10.0 produces it trivially (Yagmurdan Kacarken: IMDb 5.8 on 125 votes,
// every episode 10.0 on ~50 votes), so the badge is not asserted below it.
const ABOVE_IMDB_MIN_VOTES = 1000;

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
 * @param {number[]} seasonAvgs per-season average ratings, ORDERED by season
 * @param {Set<string>} categoricalTags tags any season carries
 * @param {Function} detectShapes match.js's classifier, passed in so the
 *   browser can hand over its global and a missing one degrades to no shapes
 * @returns {string[]} trajectory shapes first, then categorical tags
 */
function deriveShowShapes(seasonAvgs, categoricalTags, detectShapes) {
  // A single season has no cross-season trajectory, so such shows carry no
  // trajectory shape (they can still carry categorical tags).
  const trajectoryShapes = (seasonAvgs.length >= 2 && typeof detectShapes === 'function')
    ? detectShapes(seasonAvgs.map((avg) => ({ rating: avg })))
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
      };
      byId.set(m.seriesId, s);
    }
    // saved-best-for-last and shape-drift are categorical season-level tags
    // (never produced by the trajectory classifier below); carry them up to
    // the show so the Finder's shape chips and #shape= links can match them.
    for (const tag of CATEGORICAL_SHAPES) {
      if ((m.shapes || []).includes(tag)) s.categoricalShapes.add(tag);
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
      seasonRated = m.ratedCount || 0;
      seasonRatingSum = m.ratingSum || 0;
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
    if (typeof s.showRating !== 'number' || typeof s.votes !== 'number') continue;
    const avgEpisode = Math.round((s.ratingSum / s.episodes) * 100) / 100;
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
    // Trimmed on the way in so `#q=++breaking++` and `#q=+++` (a whitespace
    // term that filters nothing) parse to the same state a clean link does.
    search: (p.get('q') || '').trim(),
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

// The inverse of parseFinderQuery: the URLSearchParams a Finder state
// serialises to. Only non-default values are written, so a default state
// yields an empty string and parse(serialise(state)) round-trips. The search
// term is trimmed here as well as on parse, so the hash never carries
// `q=++breaking++` or a whitespace-only `q=+++`. writeFinderStateToURL in
// app.js appends the open-modal keys on top of this.
function serializeFinderQuery(f) {
  const p = new URLSearchParams();
  const search = (f.search || '').trim();
  if (search) p.set('q', search);
  if (f.view !== 'grid') p.set('view', f.view);
  if (f.sort !== 'votes') p.set('sort', f.sort);
  if (f.sortDir !== 'desc') p.set('dir', f.sortDir);
  if (f.minEpisodes > 0) p.set('minEps', f.minEpisodes);
  if (f.minSeasons > 0) p.set('minSeasons', f.minSeasons);
  if (f.minVotes > 0) p.set('minVotes', f.minVotes);
  if (f.minShowRating > 0) p.set('minShow', f.minShowRating);
  if (f.minAvgEpisode > 0) p.set('minAvg', f.minAvgEpisode);
  if (f.gapDir !== 'any') p.set('gapDir', f.gapDir);
  if (f.minGap > 0) p.set('minGap', f.minGap);
  if (f.minYear != null) p.set('minYear', f.minYear);
  if (f.maxYear != null) p.set('maxYear', f.maxYear);
  if (f.hiddenGems) p.set('gems', 'on');
  if (f.genres.size) p.set('genres', [...f.genres].join(','));
  if (f.genresExclude.size) p.set('xgenres', [...f.genresExclude].join(','));
  if (f.languages.size) p.set('langs', [...f.languages].join(','));
  if (f.shapes.size) p.set('shape', [...f.shapes].join(','));
  if (f.page > 1) p.set('page', f.page);
  return p;
}

// Every Finder filter EXCEPT the shape filter (shape chips need live counts of
// rows passing everything else - see finderRowsBeforeShape in app.js).
function passesFinderFilters(s, f) {
  const q = (f.search || '').trim().toLowerCase();
  if (q && !s.title.toLowerCase().includes(q) && !s.seriesId.toLowerCase().includes(q)) return false;
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

// True when the rating-sort vote floor applies to this state: a rating sort
// with the votes filter at "Any". The UI shows a note chip for exactly the
// states this returns true for.
function ratingSortFloorActive(f) {
  return RATING_SORT_KEYS.includes(f.sort) && !(f.minVotes > 0);
}

// The Finder's sort comparator. Unknown years always sink to the bottom,
// independent of sort direction; votes break every other tie. `voteFloor`
// (see RATING_SORT_VOTE_FLOOR) banks rows under that many votes below every
// row at or above it, in both directions, before the key is compared.
function finderComparator(key, dir, voteFloor = 0) {
  const mul = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    if (voteFloor > 0) {
      const aLow = a.votes < voteFloor;
      const bLow = b.votes < voteFloor;
      if (aLow !== bLow) return aLow ? 1 : -1;
    }
    if (key === 'year' && (a.year == null || b.year == null)) {
      if (a.year == null && b.year == null) return b.votes - a.votes;
      return a.year == null ? 1 : -1;
    }
    let d = key === 'title' ? a.title.localeCompare(b.title) : a[key] - b[key];
    if (d === 0 && key !== 'votes') d = b.votes - a.votes;
    return d * mul;
  };
}

// The comparator the Finder uses for a given state, floor included.
function finderStateComparator(f) {
  return finderComparator(f.sort, f.sortDir, ratingSortFloorActive(f) ? RATING_SORT_VOTE_FLOOR : 0);
}

// One-call convenience for the export pipeline: full filter + shape + sort.
function filterAndSortRows(rows, f) {
  return rows
    .filter((s) => passesFinderFilters(s, f) && passesShapeAnd(s, f.shapes))
    .sort(finderStateComparator(f));
}

const API = {
  FINDER_DEFAULTS,
  HIDDEN_GEM_MIN_AVG,
  HIDDEN_GEM_MAX_VOTES_PER_EP,
  CATEGORICAL_SHAPES,
  RATING_SORT_KEYS,
  RATING_SORT_VOTE_FLOOR,
  ABOVE_IMDB_MIN_VOTES,
  deriveShowShapes,
  buildShowAgg,
  parseFinderQuery,
  serializeFinderQuery,
  passesFinderFilters,
  passesShapeAnd,
  ratingSortFloorActive,
  finderComparator,
  finderStateComparator,
  filterAndSortRows,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else if (typeof window !== 'undefined') {
  window.RisingShowsFinder = API;
}
