'use strict';

const SHAPE_LABELS = {
  rising: 'Rising',
  consistent: 'Consistent',
  'slow-burn': 'Slow burn',
  'big-finale': 'Big finale',
  rebound: 'Rebound',
  'front-loaded': 'Front-loaded',
  declining: 'Declining',
  'bad-finale': 'Bad finale',
  rollercoaster: 'Rollercoaster',
  'mid-peak': 'Mid-peak',
  'u-shaped': 'U-shaped',
  'saved-best-for-last': 'Saved best for last',
};

// Mirrors scripts/slugify.js — keep both in sync so the SPA's permalink
// button and the build-script-generated static page URLs always agree.
function showSlug(title) {
  if (!title || typeof title !== 'string') return 'show';
  let s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, '');
  return s || 'show';
}

const STORAGE_NS = 'rising-seasons';
const KEY_WATCHED = `${STORAGE_NS}:watched`;
const KEY_VIEW = `${STORAGE_NS}:view`;
const KEY_COMPARE = `${STORAGE_NS}:compare`;
const COMPARE_LIMIT = 5;
const PAGE_SIZE = 24;
const STALE_DAYS = 30;
const MAX_SUGGESTIONS = 10;

// Only show these streaming services as filter chips and as provider tags
// on cards/rows. TMDB returns ~200 distinct providers including aggregator
// listings ("BritBox Amazon Channel"), bundlers (Spectrum / Philo / fuboTV),
// niche specialty channels (AMC+, Acorn TV), and free ad-supported services
// (Tubi, Pluto, The Roku Channel). Keeping the list to the major
// subscription services makes the metadata read at a glance and the filter
// chip row stay short.
const MAINSTREAM_PROVIDERS = new Set([
  'Netflix',
  'Hulu',
  'Amazon Prime Video',
  'HBO Max',
  'Max',
  'Disney+',
  'Peacock',
  'Paramount+',
  'Apple TV+',
  'Crunchyroll',
]);
function isMainstreamProvider(name) {
  return MAINSTREAM_PROVIDERS.has(name);
}

// --- DOM refs ---

const els = {
  shapes: document.getElementById('shapes'),
  search: document.getElementById('search'),
  minEpisodes: document.getElementById('minEpisodes'),
  maxEpisodes: document.getElementById('maxEpisodes'),
  minVotes: document.getElementById('minVotes'),
  minAvg: document.getElementById('minAvg'),
  minClimb: document.getElementById('minClimb'),
  minYear: document.getElementById('minYear'),
  maxYear: document.getElementById('maxYear'),
  sort: document.getElementById('sort'),
  labelFilters: document.querySelector('.label-filters'),
  surprise: document.getElementById('surprise'),
  resetFilters: document.getElementById('resetFilters'),
  genres: document.getElementById('genres'),
  languages: document.getElementById('languages'),
  providers: document.getElementById('providers'),
  showModalProviders: document.getElementById('showModalProviders'),
  results: document.getElementById('results'),
  pager: document.getElementById('pager'),
  pagerTop: document.getElementById('pager-top'),
  meta: document.getElementById('meta'),
  footerMeta: document.getElementById('footer-meta'),
  statsBar: document.getElementById('statsBar'),
  cardTpl: document.getElementById('card-template'),
  rowTpl: document.getElementById('row-template'),
  skeletonTpl: document.getElementById('skeleton-template'),
  modal: document.getElementById('detailModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalSubtitle: document.getElementById('modalSubtitle'),
  modalShapes: document.getElementById('modalShapes'),
  modalStats: document.getElementById('modalStats'),
  modalOverview: document.getElementById('modalOverview'),
  modalCurve: document.getElementById('modalCurve'),
  modalEpisodes: document.getElementById('modalEpisodes'),
  modalImdb: document.getElementById('modalImdb'),
  modalTvdb: document.getElementById('modalTvdb'),
  modalPoster: document.getElementById('modalPoster'),
  modalWatchBtn: document.getElementById('modalWatchBtn'),
  modalReroll: document.getElementById('modalReroll'),
  modalViewShow: document.getElementById('modalViewShow'),
  showModal: document.getElementById('showModal'),
  showModalTitle: document.getElementById('showModalTitle'),
  showModalSubtitle: document.getElementById('showModalSubtitle'),
  showModalStats: document.getElementById('showModalStats'),
  showModalShapes: document.getElementById('showModalShapes'),
  showModalOverview: document.getElementById('showModalOverview'),
  showModalSeasons: document.getElementById('showModalSeasons'),
  showModalPoster: document.getElementById('showModalPoster'),
  showModalImdb: document.getElementById('showModalImdb'),
  showModalTvdb: document.getElementById('showModalTvdb'),
  showModalPermalink: document.getElementById('showModalPermalink'),
  showModalOverlay: document.getElementById('showModalOverlay'),
  showModalOverlayCurve: document.getElementById('showModalOverlayCurve'),
  showModalOverlayLegend: document.getElementById('showModalOverlayLegend'),
  showModalCompare: document.getElementById('showModalCompare'),
  compareModal: document.getElementById('compareModal'),
  compareModalCurve: document.getElementById('compareModalCurve'),
  compareModalLegend: document.getElementById('compareModalLegend'),
  compareModalClear: document.getElementById('compareModalClear'),
  compareFab: document.getElementById('compareFab'),
  compareFabCount: document.getElementById('compareFabCount'),
  viewToggle: document.querySelector('.view-toggle'),
  suggestions: document.getElementById('searchSuggestions'),
  changelogModal: document.getElementById('changelogModal'),
  changelogSubtitle: document.getElementById('changelogSubtitle'),
  changelogTotals: document.getElementById('changelogTotals'),
  changelogShapesSection: document.getElementById('changelogShapes'),
  changelogShapesList: document.getElementById('changelogShapesList'),
  changelogAddedSection: document.getElementById('changelogAdded'),
  changelogAddedList: document.getElementById('changelogAddedList'),
  changelogRemovedSection: document.getElementById('changelogRemoved'),
  changelogRemovedList: document.getElementById('changelogRemovedList'),
  changelogSwingsSection: document.getElementById('changelogSwings'),
  changelogSwingsList: document.getElementById('changelogSwingsList'),
};

// --- mutable state ---

const state = {
  shapes: new Set(),
  search: '',
  // When the user picks a series from the search suggestions, we lock the
  // results to that exact seriesId. The displayed search value is the
  // title ("Sherlock"), but the filter ignores `search` and exact-matches
  // `lockedSeriesId` so we don't fuzzy-match other shows that share a
  // word in the title (e.g., "Sherlock Holmes"). Cleared the moment the
  // user edits the search input again.
  lockedSeriesId: null,
  minEpisodes: null,
  maxEpisodes: null,
  minVotes: null,
  minAvg: null,
  minClimb: null,
  minYear: null,
  maxYear: null,
  seriesType: 'all',
  watched: 'all',
  aboveImdb: 'all',
  hiddenGems: 'all',
  sort: 'popularity',
  genres: new Set(),
  excludeGenres: new Set(),
  languages: new Set(),
  providers: new Set(),
  view: 'grid',
  page: 1,
};

let dataset = null;
let filtered = [];
let seriesIndex = [];
let bestSeasonBySeries = new Map();
let worstSeasonBySeries = new Map();
let aboveImdbBySeries = new Map();
let pendingModalKey = null;
let pendingShowKey = null;
let modalState = { season: null, lastFocus: null, surprise: false, fromChangelog: false };
let showModalState = { seriesId: null, lastFocus: null, fromChangelog: false };
let changelog = null;
let changelogState = { lastFocus: null };
const suggestState = { items: [], active: -1, open: false };

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- poster placeholder ---
// 80% of series in the dataset have no TMDB poster (the build's TMDB
// enrichment is incremental and the catalog is huge), so the placeholder
// has to do real work. Render the show title prominently and tint the
// background by a stable hash of the title so a given show is always the
// same color across cards/modals.
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function populatePosterFallback(el, title) {
  if (!el || el.dataset.populated === '1') return;
  el.dataset.populated = '1';
  el.style.setProperty('--poster-hue', String(hashHue(title || 'unknown')));
  const label = document.createElement('span');
  label.className = 'poster-fallback-title';
  label.textContent = title || '?';
  el.appendChild(label);
}

// First meaningful character of the title — skips leading articles
// ("The X-Files" → "X", "A Quiet Place" → "Q") and falls back to the
// raw first char. Used by the suggestion dropdown where the full title
// won't fit in the 32×48 px poster slot.
function posterInitial(title) {
  if (!title) return '?';
  const cleaned = title.replace(/^(the|a|an)\s+/i, '').trim();
  const ch = (cleaned || title).charAt(0);
  return ch.toUpperCase() || '?';
}

// --- search normalization ---
// "The X-Files" → "x files", "Married... with Children" → "married with children",
// "The Office" → "office", "A Quiet Place" → "quiet place".
// Lets typed queries match titles whose punctuation/articles differ from how
// they're written. Leading "the/a/an " stripped so users typing the bare
// show name ("office" → The Office) get an exact match, not a contains hit
// behind unrelated titles that happen to start with the bare noun.
// Same form is applied to both query and indexed title before comparing.
function normalizeSearch(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

// --- localStorage helpers ---

const Watched = {
  set: new Set(),
  load() {
    try {
      const raw = localStorage.getItem(KEY_WATCHED);
      if (raw) this.set = new Set(JSON.parse(raw));
    } catch { /* corrupt or unavailable — start empty */ }
  },
  save() {
    try { localStorage.setItem(KEY_WATCHED, JSON.stringify([...this.set])); }
    catch { /* quota or disabled — silent */ }
  },
  key(season) { return `${season.seriesId}:${season.season}`; },
  has(season) { return this.set.has(this.key(season)); },
  toggle(season) {
    const k = this.key(season);
    if (this.set.has(k)) this.set.delete(k);
    else this.set.add(k);
    this.save();
    return this.set.has(k);
  },
};

const ViewPref = {
  load() {
    try {
      const v = localStorage.getItem(KEY_VIEW);
      if (v === 'grid' || v === 'list') return v;
    } catch { /* ignore */ }
    return 'grid';
  },
  save(v) {
    try { localStorage.setItem(KEY_VIEW, v); }
    catch { /* ignore */ }
  },
};

// Selected series for the "Compare" overlay. Stored as an array (preserves
// insertion order so the legend reads in the order the user added shows).
const Compare = {
  ids: [],
  load() {
    try {
      const raw = localStorage.getItem(KEY_COMPARE);
      if (raw) this.ids = JSON.parse(raw).slice(0, COMPARE_LIMIT);
    } catch { /* corrupt or unavailable — start empty */ }
  },
  save() {
    try { localStorage.setItem(KEY_COMPARE, JSON.stringify(this.ids)); }
    catch { /* quota or disabled — silent */ }
  },
  has(seriesId) { return this.ids.includes(seriesId); },
  size() { return this.ids.length; },
  add(seriesId) {
    if (this.ids.includes(seriesId)) return false;
    if (this.ids.length >= COMPARE_LIMIT) return false;
    this.ids.push(seriesId);
    this.save();
    return true;
  },
  remove(seriesId) {
    const i = this.ids.indexOf(seriesId);
    if (i < 0) return false;
    this.ids.splice(i, 1);
    this.save();
    return true;
  },
  clear() {
    this.ids = [];
    this.save();
  },
};

// Chrome (header / footer / menu / auth UI) is loaded by
// ../../assets/js/main.js — see the script block in index.html. We
// deliberately do not run a second include loader here: parallel AJAX
// includes would race main.js and overwrite the just-injected auth UI.

// --- bootstrap ---

async function load() {
  showSkeletons(8);
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dataset = await res.json();
  } catch (err) {
    showError(err);
    return;
  }
  // Precompute normalized title once per match so the search hot path doesn't
  // re-derive it on every filter pass. [[normalizeSearch]] for the rule.
  for (const m of dataset.matches) {
    m.titleSearch = normalizeSearch(m.title);
  }
  loadChangelog();
  Watched.load();
  Compare.load();
  state.view = ViewPref.load();
  applyViewClasses();
  applyStateFromURL();
  warnIfStale();
  buildSeriesIndex();
  buildBestSeasonMap();
  buildAboveImdbMap();
  renderGenreChips();
  renderLanguageChips();
  renderProviderChips();
  // Promote each chip's hidden description to a native browser tooltip
  // so the desktop nav stays calm but the teaching content is one
  // hover away.
  for (const chip of els.shapes.querySelectorAll('.shape-chip')) {
    const desc = chip.querySelector('.shape-desc');
    if (desc && desc.textContent.trim() && !chip.title) {
      chip.title = desc.textContent.trim();
    }
  }
  syncCompareFab();
  bindEvents();
  bindKeyboard();
  bindAdvancedDrawer();
  // Initial reset-button state: disabled unless the URL pre-populated some filters.
  syncResetButton();
  render();
  if (pendingModalKey) {
    const [sid, snStr] = pendingModalKey.split(':');
    const sn = parseInt(snStr, 10);
    const m = dataset.matches.find((x) => x.seriesId === sid && x.season === sn);
    if (m) openModal(m);
    pendingModalKey = null;
  } else if (pendingShowKey) {
    if (dataset.matches.some((x) => x.seriesId === pendingShowKey)) {
      openShowModal(pendingShowKey);
    }
    pendingShowKey = null;
  }
}

function buildAboveImdbMap() {
  // For each series: total all episode ratings across every season we have,
  // then mark the series as "above IMDb" only if the overall average exceeds
  // the show's IMDb rating. Per-season comparisons can flip on a single
  // strong season — we want a show-level signal here.
  const grouped = new Map();
  for (const m of dataset.matches) {
    if (typeof m.seriesRating !== 'number') continue;
    let entry = grouped.get(m.seriesId);
    if (!entry) {
      entry = { sumRating: 0, totalEps: 0, seriesRating: m.seriesRating };
      grouped.set(m.seriesId, entry);
    }
    for (const e of m.episodes) {
      entry.sumRating += e.rating;
      entry.totalEps++;
    }
  }
  aboveImdbBySeries = new Map();
  for (const [seriesId, info] of grouped) {
    if (info.totalEps === 0) continue;
    const overallAvg = info.sumRating / info.totalEps;
    aboveImdbBySeries.set(seriesId, overallAvg > info.seriesRating);
  }
}

function buildBestSeasonMap() {
  // For each series with 2+ qualifying seasons, identify the highest- and
  // lowest-avg one. Single-season series get no badge — there's no "best" or
  // "worst" without a contest.
  const byId = new Map();
  for (const m of dataset.matches) {
    let entry = byId.get(m.seriesId);
    if (!entry) {
      entry = {
        count: 0,
        bestSeason: m.season, bestAvg: m.avgRating,
        worstSeason: m.season, worstAvg: m.avgRating,
      };
      byId.set(m.seriesId, entry);
    }
    entry.count++;
    if (m.avgRating > entry.bestAvg) {
      entry.bestAvg = m.avgRating;
      entry.bestSeason = m.season;
    }
    if (m.avgRating < entry.worstAvg) {
      entry.worstAvg = m.avgRating;
      entry.worstSeason = m.season;
    }
  }
  bestSeasonBySeries = new Map();
  worstSeasonBySeries = new Map();
  for (const [seriesId, info] of byId) {
    if (info.count < 2) continue;
    bestSeasonBySeries.set(seriesId, info.bestSeason);
    // Skip when best === worst (all seasons tied on avg) — single badge is
    // meaningless in that case.
    if (info.bestSeason !== info.worstSeason) {
      worstSeasonBySeries.set(seriesId, info.worstSeason);
    }
  }
}

function buildSeriesIndex() {
  const map = new Map();
  for (const m of dataset.matches) {
    let entry = map.get(m.seriesId);
    if (!entry) {
      entry = {
        seriesId: m.seriesId,
        title: m.title,
        titleSearch: m.titleSearch,
        year: m.year || null,
        poster: m.poster || null,
        // Series-level IMDb vote count — used to rank suggestion buckets
        // so a popular show ("House") leads a long tail of obscure
        // titles that just happen to contain the query.
        seriesVotes: m.seriesVotes || 0,
      };
      map.set(m.seriesId, entry);
    } else {
      if (!entry.poster && m.poster) entry.poster = m.poster;
      if (!entry.year && m.year) entry.year = m.year;
      if (m.seriesVotes && m.seriesVotes > entry.seriesVotes) entry.seriesVotes = m.seriesVotes;
    }
  }
  seriesIndex = [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// --- URL state ---

function applyStateFromURL() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));

  // Reset every URL-backed field to its default first so that removing a
  // parameter from the hash (e.g. user deletes &gems=on) actually clears
  // the corresponding state, instead of leaving the previous value behind.
  state.shapes = new Set();
  state.search = '';
  state.minEpisodes = null;
  state.maxEpisodes = null;
  state.minVotes = null;
  state.minAvg = null;
  state.minClimb = null;
  state.minYear = null;
  state.maxYear = null;
  state.seriesType = 'all';
  state.sort = 'popularity';
  state.watched = 'all';
  state.aboveImdb = 'all';
  state.hiddenGems = 'all';
  state.genres = new Set();
  state.excludeGenres = new Set();
  state.languages = new Set();
  state.providers = new Set();
  state.page = 1;
  state.lockedSeriesId = null;

  if (p.has('shape')) {
    const val = p.get('shape');
    state.shapes = val === 'all' ? new Set() : new Set(val.split(',').filter(Boolean));
  }
  if (p.has('season'))    pendingModalKey = p.get('season');
  if (p.has('show'))      pendingShowKey = p.get('show');
  if (p.has('q'))         state.search = p.get('q');
  if (p.has('minEps'))    state.minEpisodes = parseInt(p.get('minEps'), 10) || null;
  if (p.has('maxEps'))    state.maxEpisodes = parseInt(p.get('maxEps'), 10) || null;
  if (p.has('minVotes'))  state.minVotes = parseInt(p.get('minVotes'), 10) || null;
  if (p.has('minAvg'))    state.minAvg = parseFloat(p.get('minAvg')) || null;
  if (p.has('minClimb'))  state.minClimb = parseFloat(p.get('minClimb')) || null;
  if (p.has('minYear'))   state.minYear = parseInt(p.get('minYear'), 10) || null;
  if (p.has('maxYear'))   state.maxYear = parseInt(p.get('maxYear'), 10) || null;
  if (p.has('type'))      state.seriesType = p.get('type');
  if (p.has('sort'))      state.sort = p.get('sort');
  if (p.has('watched'))   state.watched = p.get('watched');
  if (p.has('above'))     state.aboveImdb = p.get('above');
  if (p.has('gems'))      state.hiddenGems = p.get('gems');
  if (p.has('g'))         state.genres = new Set(p.get('g').split(',').filter(Boolean));
  if (p.has('xg'))        state.excludeGenres = new Set(p.get('xg').split(',').filter(Boolean));
  if (p.has('l'))         state.languages = new Set(p.get('l').split(',').filter(Boolean));
  if (p.has('p'))         state.providers = new Set(p.get('p').split(',').filter(Boolean));
  if (p.has('page'))      state.page = Math.max(1, parseInt(p.get('page'), 10) || 1);

  els.search.value = state.search;
  els.minEpisodes.value = state.minEpisodes ?? '';
  els.maxEpisodes.value = state.maxEpisodes ?? '';
  els.minVotes.value = state.minVotes ?? '';
  els.minAvg.value = state.minAvg ?? '';
  els.minClimb.value = state.minClimb ?? '';
  els.minYear.value = state.minYear ?? '';
  els.maxYear.value = state.maxYear ?? '';
  els.sort.value = state.sort;
  syncLabelFiltersAria();
  syncShapeChipsAria();
  for (const chip of els.genres.querySelectorAll('.genre-chip')) {
    syncGenreChipTriState(chip);
  }
  for (const chip of els.languages.querySelectorAll('.genre-chip')) {
    chip.setAttribute('aria-pressed', state.languages.has(chip.dataset.language) ? 'true' : 'false');
  }
  for (const chip of els.providers.querySelectorAll('.genre-chip')) {
    chip.setAttribute('aria-pressed', state.providers.has(chip.dataset.provider) ? 'true' : 'false');
  }
}

function syncLabelFiltersAria() {
  if (!els.labelFilters) return;
  const map = {
    seriesType: state.seriesType,
    watched: state.watched,
    aboveImdb: state.aboveImdb,
    hiddenGems: state.hiddenGems,
  };
  for (const btn of els.labelFilters.querySelectorAll('.label-chip')) {
    const filter = btn.dataset.filter;
    const val = btn.dataset.value;
    btn.setAttribute('aria-pressed', map[filter] === val ? 'true' : 'false');
  }
}

function syncShapeChipsAria() {
  for (const btn of els.shapes.querySelectorAll('.shape-chip')) {
    const shape = btn.dataset.shape;
    const pressed = shape === 'all' ? state.shapes.size === 0 : state.shapes.has(shape);
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
}

function toggleShape(shape) {
  if (shape === 'all') {
    state.shapes.clear();
  } else if (state.shapes.has(shape)) {
    state.shapes.delete(shape);
  } else {
    state.shapes.add(shape);
  }
  syncShapeChipsAria();
  onFilterChange();
}

function writeStateToURL() {
  const p = new URLSearchParams();
  if (state.shapes.size) p.set('shape', [...state.shapes].join(','));
  if (state.search) p.set('q', state.search);
  if (state.minEpisodes) p.set('minEps', state.minEpisodes);
  if (state.maxEpisodes) p.set('maxEps', state.maxEpisodes);
  if (state.minVotes) p.set('minVotes', state.minVotes);
  if (state.minAvg) p.set('minAvg', state.minAvg);
  if (state.minClimb) p.set('minClimb', state.minClimb);
  if (state.minYear) p.set('minYear', state.minYear);
  if (state.maxYear) p.set('maxYear', state.maxYear);
  if (state.seriesType !== 'all') p.set('type', state.seriesType);
  if (state.sort !== 'popularity') p.set('sort', state.sort);
  if (state.watched !== 'all') p.set('watched', state.watched);
  if (state.aboveImdb !== 'all') p.set('above', state.aboveImdb);
  if (state.hiddenGems !== 'all') p.set('gems', state.hiddenGems);
  if (state.genres.size) p.set('g', [...state.genres].join(','));
  if (state.excludeGenres.size) p.set('xg', [...state.excludeGenres].join(','));
  if (state.languages.size) p.set('l', [...state.languages].join(','));
  if (state.providers.size) p.set('p', [...state.providers].join(','));
  if (state.page > 1) p.set('page', state.page);
  if (els.modal && !els.modal.hidden && modalState.season) {
    p.set('season', `${modalState.season.seriesId}:${modalState.season.season}`);
  } else if (els.showModal && !els.showModal.hidden && showModalState.seriesId) {
    p.set('show', showModalState.seriesId);
  }
  const hash = p.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
}

// --- shape counts + genre chips ---

// Each chip's number reflects the CURRENT filtered result set rather than
// a hypothetical "after-click" count. Concretely:
//   - "All"          : count of all seasons passing non-shape filters
//                      (i.e. what you'd see if you cleared shape filters).
//   - Active chip    : count of current results — always equal to the
//                      overall result total (every current result already
//                      matches this shape by construction).
//   - Inactive chip  : count of current results that ALSO have this shape
//                      (i.e. what you'd see if you ADDED this filter on
//                      top of the current selection).
// Inactive chips whose addition would yield zero get disabled so the user
// can't drive the result count to 0 by accident.
function updateShapeChipCounts() {
  const passesNonShape = buildNonShapeChecker();
  const baseNoShape = dataset.matches.filter(passesNonShape);
  const currentResults = baseNoShape.filter(m => passesShapeAnd(m, state.shapes));

  // Tally per-shape hits in a single pass instead of one pass per chip —
  // a season's shapes[] is short (typically 0-3), so this is roughly
  // currentResults * 1.5 work versus currentResults * 11 work before.
  const shapeCounts = Object.create(null);
  for (const m of currentResults) {
    for (const s of m.shapes) {
      shapeCounts[s] = (shapeCounts[s] || 0) + 1;
    }
  }

  for (const btn of els.shapes.querySelectorAll('.shape-chip')) {
    const shape = btn.dataset.shape;
    const span = btn.querySelector('[data-count]');

    if (shape === 'all') {
      if (span) span.textContent = baseNoShape.length.toLocaleString();
      btn.disabled = false;
      btn.classList.remove('is-disabled');
      continue;
    }

    const n = state.shapes.has(shape) ? currentResults.length : (shapeCounts[shape] || 0);
    if (span) span.textContent = n.toLocaleString();

    // Disable an inactive chip that would drive results to zero. Active
    // chips are always clickable (clicking removes the shape → widens
    // the result set, so it never lands on zero).
    const disable = !state.shapes.has(shape) && n === 0;
    btn.disabled = disable;
    btn.classList.toggle('is-disabled', disable);
  }
}

// Three click states per genre chip: off → include → exclude → off. The
// "exclude" state hides any series carrying that genre, which is useful
// for filters like "Crime AND NOT Reality-TV".
function syncGenreChipTriState(btn) {
  const name = btn.dataset.genre;
  if (state.excludeGenres.has(name)) {
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.exclude = 'true';
    btn.title = `Excluded — click to clear (currently hiding ${name})`;
  } else if (state.genres.has(name)) {
    btn.setAttribute('aria-pressed', 'true');
    btn.dataset.exclude = 'false';
    btn.title = `Required — click again to exclude ${name}`;
  } else {
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.exclude = 'false';
    btn.title = `Click to require ${name}; click again to exclude it`;
  }
}

function cycleGenreState(name) {
  if (!state.genres.has(name) && !state.excludeGenres.has(name)) {
    state.genres.add(name);
  } else if (state.genres.has(name)) {
    state.genres.delete(name);
    state.excludeGenres.add(name);
  } else {
    state.excludeGenres.delete(name);
  }
}

function renderGenreChips() {
  const top = (dataset.genres || []).slice(0, 14);
  const frag = document.createDocumentFragment();
  for (const g of top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-chip';
    btn.dataset.genre = g.name;
    btn.textContent = g.name;
    syncGenreChipTriState(btn);
    btn.addEventListener('click', () => {
      cycleGenreState(g.name);
      syncGenreChipTriState(btn);
      onFilterChange();
    });
    frag.appendChild(btn);
  }
  els.genres.replaceChildren(frag);
}

// TMDB stores `original_language` as ISO 639-1 codes (en, ja, ko, ...).
// The UI shows the English name so users don't need to know codes.
const LANGUAGE_NAMES = {
  en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', zh: 'Chinese',
  fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
  tr: 'Turkish', hi: 'Hindi', ar: 'Arabic', th: 'Thai', id: 'Indonesian',
  pl: 'Polish', nl: 'Dutch', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
  fi: 'Finnish', he: 'Hebrew', cs: 'Czech', el: 'Greek', hu: 'Hungarian',
  ro: 'Romanian', uk: 'Ukrainian', vi: 'Vietnamese', tl: 'Filipino',
  ms: 'Malay', fa: 'Persian', bn: 'Bengali', ta: 'Tamil', te: 'Telugu',
  ur: 'Urdu', ml: 'Malayalam', mr: 'Marathi', is: 'Icelandic', sk: 'Slovak',
  bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian',
  ca: 'Catalan', et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', ga: 'Irish',
  cy: 'Welsh', mt: 'Maltese', sq: 'Albanian',
};
function languageLabel(code) {
  return LANGUAGE_NAMES[code] || code.toUpperCase();
}

function renderProviderChips() {
  // Filter the dataset's provider list to the mainstream whitelist before
  // taking the top N — otherwise the chip row gets dominated by aggregator
  // listings (Spectrum, Philo, Roku Channel) that aren't real streaming
  // homes for the content.
  const top = (dataset.providers || [])
    .filter((p) => isMainstreamProvider(p.name))
    .slice(0, 10);
  const frag = document.createDocumentFragment();
  for (const p of top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-chip';
    btn.dataset.provider = p.name;
    btn.setAttribute('aria-pressed', state.providers.has(p.name) ? 'true' : 'false');
    btn.textContent = p.name;
    btn.addEventListener('click', () => {
      if (state.providers.has(p.name)) state.providers.delete(p.name);
      else state.providers.add(p.name);
      btn.setAttribute('aria-pressed', state.providers.has(p.name) ? 'true' : 'false');
      onFilterChange();
    });
    frag.appendChild(btn);
  }
  els.providers.replaceChildren(frag);
}

function renderLanguageChips() {
  const top = (dataset.languages || []).slice(0, 12);
  const frag = document.createDocumentFragment();
  for (const l of top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-chip';
    btn.dataset.language = l.code;
    btn.setAttribute('aria-pressed', state.languages.has(l.code) ? 'true' : 'false');
    btn.textContent = languageLabel(l.code);
    btn.addEventListener('click', () => {
      if (state.languages.has(l.code)) state.languages.delete(l.code);
      else state.languages.add(l.code);
      btn.setAttribute('aria-pressed', state.languages.has(l.code) ? 'true' : 'false');
      onFilterChange();
    });
    frag.appendChild(btn);
  }
  els.languages.replaceChildren(frag);
}

// --- filter + sort ---

function buildNonShapeChecker() {
  const qRaw = state.search.trim();
  const q = qRaw.toLowerCase();
  const qNorm = normalizeSearch(qRaw);
  const minEps = state.minEpisodes;
  const maxEps = state.maxEpisodes;
  const minVotes = state.minVotes;
  const minAvg = state.minAvg;
  const minClimb = state.minClimb;
  const { minYear, maxYear, seriesType, watched: watchedFilter } = state;
  const wantGenres = state.genres;
  const excludeGenres = state.excludeGenres;
  const wantLanguages = state.languages;
  const wantProviders = state.providers;

  return function (m) {
    if (minEps && m.episodes.length < minEps) return false;
    if (maxEps && m.episodes.length > maxEps) return false;
    if (minVotes && m.minVotes < minVotes) return false;
    if (minAvg && m.avgRating < minAvg) return false;
    if (minClimb && (m.lastRating - m.firstRating) < minClimb) return false;
    // Year filter compares against the season's own air year (falls back
    // to the show's start year if the season year is missing) so users
    // searching "year >= 2020" see the seasons that actually aired in 2020+,
    // not just shows that PREMIERED before then.
    const yearForFilter = m.seasonYear || m.year;
    if (minYear && yearForFilter && yearForFilter < minYear) return false;
    if (maxYear && yearForFilter && yearForFilter > maxYear) return false;
    if (seriesType !== 'all' && m.type !== seriesType) return false;
    if (state.lockedSeriesId) {
      // Suggestion-locked: exact-match the chosen series; ignore the
      // (display-only) search text. The lock is cleared the moment the
      // user edits the search input.
      if (m.seriesId !== state.lockedSeriesId) return false;
    } else if (q) {
      // Title match runs on normalized form so punctuation/whitespace
      // differences don't block a match (e.g. "the x files" matches
      // "The X-Files"). IMDb-ID match stays plain since IDs are alnum.
      const titleHit = qNorm.length > 0 && m.titleSearch.includes(qNorm);
      const idHit = m.seriesId.toLowerCase().includes(q);
      // Episode-title fallback — only run when the cheaper title/id checks
      // missed, since this scans every episode in the season. Gated at
      // q.length >= 3 so single-character noise queries don't iterate.
      let epHit = false;
      if (!titleHit && !idHit && q.length >= 3) {
        for (const ep of m.episodes) {
          if (ep.name && ep.name.toLowerCase().includes(q)) { epHit = true; break; }
        }
      }
      if (!titleHit && !idHit && !epHit) return false;
    }
    if (wantLanguages.size && (!m.language || !wantLanguages.has(m.language))) {
      return false;
    }
    if (wantProviders.size) {
      if (!m.providers || m.providers.length === 0) return false;
      let ok = false;
      for (const p of m.providers) if (wantProviders.has(p)) { ok = true; break; }
      if (!ok) return false;
    }
    if (wantGenres.size) {
      // AND across selected genres: the season's series must carry every
      // selected genre (e.g. "Drama" + "Crime" returns only crime-dramas,
      // not anything that's just one or the other).
      for (const g of wantGenres) {
        if (!m.genres.includes(g)) return false;
      }
    }
    if (excludeGenres.size) {
      for (const g of m.genres) {
        if (excludeGenres.has(g)) return false;
      }
    }
    if (watchedFilter !== 'all') {
      const isWatched = Watched.has(m);
      if (watchedFilter === 'watched' && !isWatched) return false;
      if (watchedFilter === 'unwatched' && isWatched) return false;
    }
    if (state.aboveImdb === 'above' && !aboveImdbBySeries.get(m.seriesId)) return false;
    if (state.hiddenGems === 'on') {
      // High-rated (avg >= 8.5) and under the radar (each episode has fewer
      // than 500 votes, i.e. minVotes < 500 across the season).
      if (m.avgRating < 8.5) return false;
      if (m.minVotes >= 500) return false;
    }
    return true;
  };
}

function passesShapeAnd(m, shapeSet) {
  if (shapeSet.size === 0) return true;
  for (const s of shapeSet) if (!m.shapes.includes(s)) return false;
  return true;
}

function filterAndSort() {
  const q = state.search.trim().toLowerCase();
  const passesNonShape = buildNonShapeChecker();
  let rows = dataset.matches.filter((m) => passesNonShape(m) && passesShapeAnd(m, state.shapes));

  rows.sort((a, b) => {
    if (q) {
      const ay = a.year ?? Infinity;
      const by = b.year ?? Infinity;
      if (ay !== by) return ay - by;
      return a.season - b.season;
    }
    let primary;
    switch (state.sort) {
      case 'length': primary = b.episodes.length - a.episodes.length; break;
      case 'climb':  primary = (b.lastRating - b.firstRating) - (a.lastRating - a.firstRating); break;
      case 'finale': primary = b.lastRating - a.lastRating; break;
      case 'avg':    primary = b.avgRating - a.avgRating; break;
      case 'recent': primary = ((b.seasonYear || b.year) || 0) - ((a.seasonYear || a.year) || 0); break;
      case 'popularity':
      default:       primary = b.minVotes - a.minVotes; break;
    }
    if (primary !== 0) return primary;
    if (state.sort !== 'popularity' && b.minVotes !== a.minVotes) return b.minVotes - a.minVotes;
    if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
    return a.title.localeCompare(b.title);
  });

  return rows;
}

// --- render ---

function render() {
  filtered = filterAndSort();
  updateShapeChipCounts();

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const requestedPage = state.page;
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  // If the URL asked for a page that doesn't exist (e.g. ?page=50 but only
  // 5 pages are available after filtering), sync the URL back to the page
  // we're actually showing so it's not lying about position.
  if (requestedPage !== state.page) writeStateToURL();

  renderStatsBar();
  els.meta.textContent = filtered.length
    ? `${filtered.length.toLocaleString()} of ${dataset.count.toLocaleString()} seasons match your filters · page ${state.page} of ${totalPages.toLocaleString()}`
    : `0 of ${dataset.count.toLocaleString()} seasons match your filters`;

  if (filtered.length === 0) {
    showEmptyState();
    renderPager(0, 1);
    renderFooterMeta();
    return;
  }

  const start = (state.page - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, filtered.length);

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(buildItem(filtered[i]));
  els.results.replaceChildren(frag);

  renderPager(totalPages, state.page);
  renderFooterMeta();
}

function renderFooterMeta() {
  els.footerMeta.replaceChildren();
  if (!dataset?.builtAt) return;

  const text = document.createElement('span');
  text.className = 'footer-meta-text';
  text.textContent = `Last updated: ${formatBuiltAt(dataset.builtAt)}`;
  els.footerMeta.appendChild(text);

  const latest = changelog?.updates?.[0];
  if (!latest) return;
  // Only show the chip when the *most recent* entry corresponds to the
  // dataset we're displaying. Mismatches (data.json ahead of, or behind,
  // the changelog) shouldn't surface a misleading summary.
  if (latest.builtAt !== dataset.builtAt) return;
  if (!hasMeaningfulChange(latest)) return;

  const sep = document.createElement('span');
  sep.className = 'footer-meta-sep';
  sep.setAttribute('aria-hidden', 'true');
  sep.textContent = '·';
  els.footerMeta.appendChild(sep);

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'whats-new-chip';
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.setAttribute('aria-controls', 'changelogModal');
  const added = latest.added?.length || 0;
  const removed = latest.removed?.length || 0;
  const counts = document.createElement('span');
  counts.className = 'whats-new-chip-counts';
  if (added) {
    const a = document.createElement('span');
    a.className = 'whats-new-chip-added';
    a.textContent = `+${added}`;
    counts.append(a, ' new');
  }
  if (added && removed) counts.append(' · ');
  if (removed) {
    const r = document.createElement('span');
    r.className = 'whats-new-chip-removed';
    r.textContent = `−${removed}`;
    counts.append(r, ' dropped');
  }
  if (!added && !removed) counts.textContent = 'refreshed';
  const cta = document.createElement('span');
  cta.className = 'whats-new-chip-cta';
  cta.textContent = "What's new";
  const caret = document.createElement('span');
  caret.className = 'whats-new-chip-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  chip.append(counts, cta, caret);
  chip.addEventListener('click', () => openChangelogModal());
  els.footerMeta.appendChild(chip);
}

function hasMeaningfulChange(entry) {
  if (!entry) return false;
  if ((entry.added?.length || 0) > 0) return true;
  if ((entry.removed?.length || 0) > 0) return true;
  if (entry.totals?.delta) return true;
  if (entry.shapeDeltas && Object.keys(entry.shapeDeltas).length) return true;
  if ((entry.ratingSwings?.length || 0) > 0) return true;
  return false;
}

function formatBuiltAt(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function buildItem(m) {
  return state.view === 'list' ? buildRow(m) : buildCard(m);
}

function showEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty';
  div.innerHTML = '<p>No seasons match these filters.</p><p>Try lowering minimum votes, removing genre filters, or pressing Reset.</p>';
  els.results.replaceChildren(div);
}

function showSkeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.appendChild(els.skeletonTpl.content.firstElementChild.cloneNode(true));
  }
  els.results.replaceChildren(frag);
}

function showError(err) {
  const div = document.createElement('div');
  div.className = 'empty';
  const p1 = document.createElement('p');
  p1.textContent = "Couldn't load season data.";
  const p2 = document.createElement('p');
  p2.style.cssText = 'font-size:0.85em;color:var(--muted-2);';
  p2.textContent = err.message || String(err);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.style.marginTop = '0.75rem';
  btn.textContent = 'Retry';
  btn.addEventListener('click', load);
  div.append(p1, p2, btn);
  els.results.replaceChildren(div);
}

function renderStatsBar() {
  if (!filtered.length) { els.statsBar.replaceChildren(); return; }
  const total = filtered.length;
  let watched = 0;
  let ratingSum = 0;
  for (const m of filtered) {
    if (Watched.has(m)) watched++;
    ratingSum += m.avgRating;
  }
  const avg = (ratingSum / total).toFixed(1);
  const pct = total > 0 ? Math.round((watched / total) * 100) : 0;
  const stale = isStale();

  const frag = document.createDocumentFragment();
  frag.appendChild(stat(`<strong>${total.toLocaleString()}</strong> seasons`));
  frag.appendChild(stat(`<strong>${watched.toLocaleString()}</strong> watched (${pct}%)`));
  frag.appendChild(stat(`avg rating <strong>${avg}</strong>`));

  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuenow', String(pct));
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-label', 'Watched progress');
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${pct}%`;
  progress.appendChild(fill);
  frag.appendChild(progress);

  if (stale) {
    const warn = document.createElement('span');
    warn.className = 'stale';
    warn.title = `Data is over ${STALE_DAYS} days old. Re-run npm run build:rising-seasons or wait for the weekly auto-refresh.`;
    warn.textContent = 'data may be outdated';
    frag.appendChild(warn);
  }

  els.statsBar.replaceChildren(frag);
}

function stat(html) {
  const span = document.createElement('span');
  span.innerHTML = html;
  return span;
}

// --- pagination ---

function renderPager(totalPages, current) {
  // [target, scrollAfter] — the top pager leaves the user where they are
  // (so the page-bar above the results stays in view as they click);
  // the bottom pager scrolls back up to the start of the results, which
  // is what they expect after reaching the end of a page.
  const targets = [
    [els.pagerTop, false],
    [els.pager, true],
  ].filter(([t]) => t);
  if (totalPages <= 1) {
    for (const [t] of targets) {
      t.replaceChildren();
      t.hidden = true;
    }
    return;
  }

  // Build a fresh fragment per target — DocumentFragments are consumed by
  // replaceChildren, so a single fragment can't populate both pagers.
  for (const [t, scrollAfter] of targets) {
    const frag = document.createDocumentFragment();
    frag.appendChild(pageButton('Prev', current - 1, current === 1, scrollAfter));
    for (const n of pageNumbers(current, totalPages)) {
      if (n === '…') {
        const span = document.createElement('span');
        span.className = 'page-ellipsis';
        span.textContent = '…';
        span.setAttribute('aria-hidden', 'true');
        frag.appendChild(span);
      } else {
        const btn = pageButton(String(n), n, false, scrollAfter);
        if (n === current) btn.setAttribute('aria-current', 'page');
        btn.setAttribute('aria-label', `Page ${n}`);
        frag.appendChild(btn);
      }
    }
    frag.appendChild(pageButton('Next', current + 1, current === totalPages, scrollAfter));
    t.replaceChildren(frag);
    t.hidden = false;
  }
}

function pageButton(label, target, disabled, scrollAfter = true) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'page-btn';
  btn.textContent = label;
  if (disabled) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.addEventListener('click', () => goToPage(target, scrollAfter));
  }
  return btn;
}

function pageNumbers(current, total) {
  const set = new Set([1, total]);
  for (let i = current - 1; i <= current + 1; i++) {
    if (i >= 1 && i <= total) set.add(i);
  }
  if (total <= 7) {
    for (let i = 1; i <= total; i++) set.add(i);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
}

function goToPage(n, scrollAfter = true) {
  state.page = n;
  writeStateToURL();
  render();
  // Only the bottom pager opts into scrolling — clicking the top pager
  // should leave the user looking at the same vertical position so the
  // pager they clicked stays under their cursor.
  if (scrollAfter) {
    const top = els.results.getBoundingClientRect().top + window.scrollY - 70;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

function onFilterChange() {
  state.page = 1;
  writeStateToURL();
  syncResetButton();
  render();
}

// True if anything in `state` differs from its default. Used to gate the
// Reset-all-filters button — there's nothing to reset if every knob is
// already at its default value.
function hasActiveFilters() {
  if (state.shapes && state.shapes.size > 0) return true;
  if (state.search && state.search.trim()) return true;
  if (state.minEpisodes != null) return true;
  if (state.maxEpisodes != null) return true;
  if (state.minVotes != null) return true;
  if (state.minAvg != null) return true;
  if (state.minClimb != null) return true;
  if (state.minYear != null) return true;
  if (state.maxYear != null) return true;
  if (state.seriesType && state.seriesType !== 'all') return true;
  if (state.watched && state.watched !== 'all') return true;
  if (state.aboveImdb && state.aboveImdb !== 'all') return true;
  if (state.hiddenGems && state.hiddenGems !== 'all') return true;
  if (state.sort && state.sort !== 'popularity') return true;
  if (state.genres && state.genres.size > 0) return true;
  if (state.excludeGenres && state.excludeGenres.size > 0) return true;
  if (state.languages && state.languages.size > 0) return true;
  if (state.providers && state.providers.size > 0) return true;
  return false;
}

function syncResetButton() {
  if (!els.resetFilters) return;
  const active = hasActiveFilters();
  // Button lives inside <summary>, so we hide it entirely when there's
  // nothing to clear rather than leaving a disabled control taking space
  // next to the "More filters" chip.
  els.resetFilters.hidden = !active;
  els.resetFilters.disabled = !active;
  els.resetFilters.setAttribute('aria-disabled', String(!active));
  els.resetFilters.title = active
    ? 'Clear every active filter and start fresh'
    : 'No filters are currently active';
}

function surprisePick() {
  if (filtered.length === 0) return null;
  return filtered[Math.floor(Math.random() * Math.min(filtered.length, 50))];
}

// --- shared shape-tag + best-badge helpers ---

function fillShapeTags(container, shapes, { clickable = true } = {}) {
  container.replaceChildren();
  // No "No pattern" placeholder — an empty shape container just renders
  // nothing, which keeps the row/card cleaner for seasons that don't fit
  // a recognized trajectory shape.
  if (shapes.length === 0) return;
  for (const s of shapes) {
    if (clickable) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'shape-tag is-clickable' + (state.shapes.has(s) ? ' active' : '');
      tag.textContent = SHAPE_LABELS[s] || s;
      tag.title = state.shapes.has(s) ? 'Remove this shape filter' : 'Filter by this shape';
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleShape(s);
      });
      container.appendChild(tag);
    } else {
      const tag = document.createElement('span');
      tag.className = 'shape-tag' + (state.shapes.has(s) ? ' active' : '');
      tag.textContent = SHAPE_LABELS[s] || s;
      container.appendChild(tag);
    }
  }
}

// Format an avg-runtime value as "52 min" / "1h 5m" depending on length.
// Returns '' when no runtime is available so the caller can hide the slot.
function formatAvgRuntime(min) {
  if (!min || !Number.isFinite(min)) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min - h * 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Compact, fixed-width-friendly variant for the result-tile stats grid —
// always returns minutes ("72 min", "112 min") so the runtime cell doesn't
// wrap awkwardly compared to its neighbors. The longer formatAvgRuntime is
// still used in modals and free-text contexts.
function formatAvgRuntimeShort(min) {
  if (!min || !Number.isFinite(min)) return '';
  return `${min} min`;
}

function avgVotesPerEpisode(m) {
  return Math.round(m.episodes.reduce((s, e) => s + e.votes, 0) / m.episodes.length);
}

function setRuntimeStat(node, m) {
  const el = node.querySelector('.stat-runtime');
  if (!el) return;
  const text = formatAvgRuntimeShort(m.avgRuntime);
  el.textContent = text ? `${text}/ep` : '';
  el.hidden = !text;
}

// Append streaming-platform chips into an existing shapes container so the
// trajectory patterns and the platforms read as one row of metadata.
// Distinct .provider-tag styling keeps them visually separable from the
// pattern tags without forcing a second row.
function fillProviderTags(container, providers) {
  if (!providers || !providers.length) return;
  // Same whitelist as the filter chips — only major streaming services get
  // a chip on the card/row. Channels like AMC+, Philo, The Roku Channel,
  // Spectrum, and the *-Amazon-Channel aggregator entries are dropped.
  const filtered = providers.filter(isMainstreamProvider);
  for (const p of filtered) {
    const tag = document.createElement('span');
    tag.className = 'provider-tag';
    tag.textContent = p;
    container.appendChild(tag);
  }
}

function buildRankBadge(className, glyph, label, title) {
  const badge = document.createElement('span');
  badge.className = className;
  badge.title = title;
  const icon = document.createElement('span');
  icon.className = 'rank-badge-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = glyph;
  const text = document.createElement('span');
  text.className = 'rank-badge-label';
  text.textContent = label;
  badge.append(icon, text);
  return badge;
}

function maybeBestBadge(m) {
  if (bestSeasonBySeries.get(m.seriesId) !== m.season) return null;
  return buildRankBadge('best-badge', '★', 'Best',
    "Highest-rated season of this series in our dataset");
}

function maybeWorstBadge(m) {
  if (worstSeasonBySeries.get(m.seriesId) !== m.season) return null;
  return buildRankBadge('worst-badge', '▼', 'Worst',
    'Lowest-rated season of this series in our dataset');
}

function aboveImdbBadge(m) {
  if (typeof m.seriesRating !== 'number') return null;
  if (m.avgRating <= m.seriesRating) return null;
  const badge = document.createElement('span');
  badge.className = 'above-imdb';
  badge.textContent = '↑';
  badge.title =
    `Episodes average ${m.avgRating.toFixed(1)} — higher than the show's IMDb rating of ${m.seriesRating.toFixed(1)}`;
  return badge;
}

// --- card builder (grid view) ---

function buildCard(m) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);

  node.querySelector('.card-title').textContent = m.title;
  node.querySelector('.card-season').textContent = `S${m.season} · ${m.episodes.length} eps`;
  node.querySelector('.card-year').textContent = (m.seasonYear || m.year) || 'year unknown';
  node.querySelector('.card-genres').textContent = m.genres.slice(0, 3).join(' · ');

  const cardShapes = node.querySelector('.card-shapes');
  // Suppress 'saved-best-for-last' here — the ★ Best badge already conveys it
  // (a final-season shape only fires when that season is also the show's
  // best, which always earns the ★).
  fillShapeTags(cardShapes, m.shapes.filter((s) => s !== 'saved-best-for-last'), { clickable: false });
  // Best/Worst badge prepended to the shapes row so it reads as a season
  // descriptor alongside the trajectory pattern, rather than crowding the
  // title with a big colored chip.
  const badge = maybeBestBadge(m) || maybeWorstBadge(m);
  if (badge) cardShapes.insertBefore(badge, cardShapes.firstChild);
  fillProviderTags(cardShapes, m.providers);

  drawCurve(node.querySelector('.curve'), m.episodes, 300, 70, 0);

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)}→${m.lastRating.toFixed(1)} (${climbStr})`;
  const avgEl = node.querySelector('.stat-avg');
  avgEl.textContent = `Avg ${m.avgRating.toFixed(1)}`;
  const cardBadge = aboveImdbBadge(m);
  if (cardBadge) avgEl.appendChild(cardBadge);
  setRuntimeStat(node, m);
  node.querySelector('.stat-votes').textContent = `${avgVotesPerEpisode(m).toLocaleString()} votes/ep`;

  const posterEl = node.querySelector('.card-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w342${m.poster}`;
    img.alt = `${m.title} poster`;
    img.loading = 'lazy';
    posterEl.appendChild(img);
  } else {
    populatePosterFallback(posterEl.querySelector('.poster-fallback'), m.title);
  }

  applyWatchedState(node, node.querySelector('.watch-toggle'), m);

  node.addEventListener('click', () => openModal(m));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(m);
    }
  });
  node.querySelector('.watch-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    onToggleWatched(m, node);
  });

  node.setAttribute('aria-label', `${m.title}, season ${m.season}`);
  return node;
}

// --- row builder (list view) ---

function buildRow(m) {
  const node = els.rowTpl.content.firstElementChild.cloneNode(true);

  node.querySelector('.row-title').textContent = m.title;
  node.querySelector('.row-season').textContent = `S${m.season} · ${m.episodes.length} eps`;
  node.querySelector('.row-year').textContent = (m.seasonYear || m.year) || '';

  const rowShapes = node.querySelector('.row-shapes');
  // Suppress 'saved-best-for-last' here — see buildCard for rationale.
  fillShapeTags(rowShapes, m.shapes.filter((s) => s !== 'saved-best-for-last'), { clickable: false });
  // Best/Worst badge moves out of the title row and into the shapes row so
  // it reads as a season descriptor (matches the grid card layout).
  const badge = maybeBestBadge(m) || maybeWorstBadge(m);
  if (badge) rowShapes.insertBefore(badge, rowShapes.firstChild);
  fillProviderTags(rowShapes, m.providers);

  // Genre line, mirroring the grid card's .card-meta. Hidden when there
  // are no genres on the season (rare but possible).
  const rowGenres = node.querySelector('.row-genres');
  if (rowGenres) {
    const text = (m.genres || []).slice(0, 3).join(' · ');
    rowGenres.textContent = text;
    rowGenres.hidden = !text;
  }

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr})`;
  const rowAvgEl = node.querySelector('.stat-avg');
  rowAvgEl.textContent = `Avg ${m.avgRating.toFixed(1)}`;
  const rowBadge = aboveImdbBadge(m);
  if (rowBadge) rowAvgEl.appendChild(rowBadge);
  setRuntimeStat(node, m);
  node.querySelector('.stat-votes').textContent = `${avgVotesPerEpisode(m).toLocaleString()} votes/ep`;

  drawCurve(node.querySelector('.row-curve'), m.episodes, 200, 56, 0);

  const posterEl = node.querySelector('.row-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w185${m.poster}`;
    img.alt = `${m.title} poster`;
    img.loading = 'lazy';
    posterEl.appendChild(img);
  } else {
    populatePosterFallback(posterEl.querySelector('.poster-fallback'), m.title);
  }

  applyWatchedState(node, node.querySelector('.watch-toggle'), m);

  node.addEventListener('click', (e) => {
    if (e.target.closest('.watch-toggle')) return;
    openModal(m);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(m);
    }
  });
  node.querySelector('.watch-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    onToggleWatched(m, node);
  });

  node.setAttribute('aria-label', `${m.title}, season ${m.season}`);
  return node;
}

function applyWatchedState(cardOrRow, toggleBtn, m) {
  const isWatched = Watched.has(m);
  cardOrRow.classList.toggle('is-watched', isWatched);
  toggleBtn.setAttribute('aria-pressed', isWatched ? 'true' : 'false');
  toggleBtn.title = isWatched ? 'Mark as unwatched' : 'Mark as watched';
  toggleBtn.setAttribute('aria-label', toggleBtn.title);
}

function onToggleWatched(m, cardOrRow) {
  Watched.toggle(m);
  applyWatchedState(cardOrRow, cardOrRow.querySelector('.watch-toggle'), m);
  renderStatsBar();
  if (state.watched !== 'all') render();
}

// --- curve drawing (shared) ---

function drawCurve(svg, episodes, W, H, opts) {
  // Charts with hover dots need a small inset so the dots don't get
  // clipped at the viewport edge. Sparklines without dots (the list-view
  // row and the show-modal per-season mini-spark) pass padX=0 so the
  // line/fill plot literally edge-to-edge — symmetric by construction,
  // no perceived left-bias from a 2-6 px gap on the left.
  // Backward-compat: a numeric 5th arg is treated as padX.
  if (typeof opts === 'number') opts = { padX: opts };
  opts = opts || {};
  const showAxis = opts.showAxis === true;
  const defaultPad = showAxis ? 4 : 4;
  const padX = typeof opts.padX === 'number' ? opts.padX : defaultPad;
  const padXLeft = showAxis ? 36 : padX;
  const padXRight = padX;
  const padY = 6;
  const ratings = episodes.map((e) => e.rating);
  const lo = Math.max(0, Math.min(...ratings) - 0.3);
  const hi = Math.min(10, Math.max(...ratings) + 0.3);
  const span = Math.max(0.1, hi - lo);
  const n = episodes.length;
  const xStep = n > 1 ? (W - padXLeft - padXRight) / (n - 1) : 0;

  const points = episodes.map((e, i) => {
    const x = padXLeft + (n > 1 ? i * xStep : (W - padXLeft - padXRight) / 2);
    const y = padY + (1 - (e.rating - lo) / span) * (H - padY * 2);
    return [x, y];
  });

  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${H} L${points[0][0].toFixed(1)},${H} Z`;

  svg.querySelector('.curve-line').setAttribute('d', linePath);
  svg.querySelector('.curve-area').setAttribute('d', areaPath);

  if (showAxis) drawYAxis(svg, lo, hi, padXLeft, padXRight, padY, W, H);

  const dots = svg.querySelector('.curve-dots');
  if (dots) {
    dots.replaceChildren();
    for (let i = 0; i < points.length; i++) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', points[i][0].toFixed(1));
      c.setAttribute('cy', points[i][1].toFixed(1));
      c.setAttribute('r', H > 100 ? '4' : '2.5');
      if (episodes[i].episode === 0) c.classList.add('special-ep');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      const epLabel = episodes[i].episode === 0 ? 'Ep 0 (pre-season special)' : `Ep ${episodes[i].episode}`;
      title.textContent = `${epLabel}: ${episodes[i].rating.toFixed(1)} · ${episodes[i].votes.toLocaleString()} votes`;
      c.appendChild(title);
      dots.appendChild(c);
    }
  }
}

// Draw IMDb-rating gridlines + labels along the left edge of a curve SVG.
// 5 evenly-spaced ticks across the actual [lo, hi] range — snapped to 0.1
// (IMDb's own precision) so the labels read like real rating values.
//
// Gridlines render inside the SVG (horizontal lines can safely stretch
// under preserveAspectRatio="none"). Labels are placed as HTML in a sibling
// overlay so they're never horizontally squished by the SVG's non-uniform
// scale — that's what caused "9.3" to read as "0.3" before.
function drawYAxis(svg, lo, hi, padXLeft, padXRight, padY, W, H) {
  const NS = 'http://www.w3.org/2000/svg';
  const labelsEl = ensureAxisLabelContainer(svg);
  while (labelsEl.firstChild) labelsEl.removeChild(labelsEl.firstChild);

  let group = svg.querySelector('.curve-axis');
  if (!group) {
    group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'curve-axis');
    svg.insertBefore(group, svg.firstChild);
  } else {
    while (group.firstChild) group.removeChild(group.firstChild);
  }

  const span = Math.max(0.1, hi - lo);
  const ticks = 5;
  const plotTop = padY;
  const plotBottom = H - padY;
  const plotRight = W - padXRight;

  for (let i = 0; i < ticks; i++) {
    const v = lo + (span * i) / (ticks - 1);
    const y = plotTop + (1 - (v - lo) / span) * (plotBottom - plotTop);

    // Gridline — SVG, free to stretch.
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', padXLeft);
    line.setAttribute('x2', plotRight);
    line.setAttribute('y1', y.toFixed(1));
    line.setAttribute('y2', y.toFixed(1));
    line.setAttribute('class', 'axis-grid');
    group.appendChild(line);

    // Label — HTML, positioned by percentage so SVG scaling doesn't
    // distort the glyphs.
    const yPct = (y / H * 100).toFixed(2);
    const label = document.createElement('span');
    label.className = 'axis-label';
    label.style.top = yPct + '%';
    label.textContent = v.toFixed(1);
    labelsEl.appendChild(label);
  }
}

// Wrap an axis-bearing SVG in a positioned container the first time we
// draw on it, so the HTML axis labels can layer over the SVG without being
// stretched by the SVG's non-uniform scale.
function ensureAxisLabelContainer(svg) {
  if (svg.parentElement && svg.parentElement.classList.contains('curve-with-axis')) {
    let labels = svg.parentElement.querySelector('.curve-axis-labels');
    if (!labels) {
      labels = document.createElement('div');
      labels.className = 'curve-axis-labels';
      svg.parentElement.appendChild(labels);
    }
    return labels;
  }
  const wrap = document.createElement('div');
  wrap.className = 'curve-with-axis';
  svg.parentNode.insertBefore(wrap, svg);
  wrap.appendChild(svg);
  const labels = document.createElement('div');
  labels.className = 'curve-axis-labels';
  wrap.appendChild(labels);
  return labels;
}

// Picks a visually distinct stroke color per season. HSL spread across the
// hue wheel keeps adjacent seasons easy to tell apart even at 10+ seasons.
function seasonColor(i, total) {
  const hue = (i * 360) / Math.max(total, 1);
  return `hsl(${hue.toFixed(0)} 80% 62%)`;
}

// Draw every season's curve on a shared chart so the user can visually
// compare per-season shape, slope, and absolute rating. X is normalized to
// 0..1 (episode index / season length) so seasons of different lengths align.
// Y range spans the global min/max across all seasons (slightly padded).
function drawSeasonOverlay(svg, seasons, W, H) {
  const padXLeft = 36;
  const padXRight = 10;
  const padY = 12;
  // Wipe previous content — this SVG is reused across openShowModal calls.
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!seasons.length) return [];

  let lo = Infinity, hi = -Infinity;
  for (const s of seasons) for (const e of s.episodes) {
    if (e.rating < lo) lo = e.rating;
    if (e.rating > hi) hi = e.rating;
  }
  lo = Math.max(0, lo - 0.3);
  hi = Math.min(10, hi + 0.3);
  const span = Math.max(0.1, hi - lo);

  // Axis first so the season curves draw on top of the gridlines.
  drawYAxis(svg, lo, hi, padXLeft, padXRight, padY, W, H);

  const NS = 'http://www.w3.org/2000/svg';
  const colors = [];
  seasons.forEach((s, idx) => {
    const color = seasonColor(idx, seasons.length);
    colors.push({ season: s.season, color });
    const n = s.episodes.length;
    const xStep = n > 1 ? (W - padXLeft - padXRight) / (n - 1) : 0;
    const points = s.episodes.map((e, i) => {
      const x = padXLeft + (n > 1 ? i * xStep : (W - padXLeft - padXRight) / 2);
      const y = padY + (1 - (e.rating - lo) / span) * (H - padY * 2);
      return [x, y];
    });
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('opacity', '0.85');
    const title = document.createElementNS(NS, 'title');
    title.textContent = `Season ${s.season} — avg ${s.avgRating.toFixed(1)}`;
    path.appendChild(title);
    svg.appendChild(path);
  });
  return colors;
}

// --- compare set ---

function syncCompareFab() {
  if (!els.compareFab) return;
  const n = Compare.size();
  els.compareFab.hidden = n === 0;
  els.compareFabCount.textContent = String(n);
  els.compareFab.setAttribute('aria-label', `Compare ${n} show${n === 1 ? '' : 's'}`);
}

function syncCompareButton() {
  if (!els.showModalCompare || !showModalState.seriesId) return;
  const inSet = Compare.has(showModalState.seriesId);
  const atLimit = !inSet && Compare.size() >= COMPARE_LIMIT;
  els.showModalCompare.textContent = inSet ? '✓ In compare' : '＋ Add to compare';
  els.showModalCompare.classList.toggle('is-in-compare', inSet);
  els.showModalCompare.disabled = atLimit;
  els.showModalCompare.title = atLimit
    ? `Compare set is full (${COMPARE_LIMIT} max) — remove one first`
    : inSet ? 'Remove this show from the compare set' : 'Add this show to the compare set';
}

// Trajectory chart: for each selected series, plot one polyline whose x is
// the season index (1..N for that show) and y is that season's avg rating.
// Series with different season counts share a normalized x so they overlay
// cleanly. Hover the line for series + season detail.
function drawCompareChart(svg, seriesEntries, W, H) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!seriesEntries.length) return;

  const padX = 14;
  const padY = 16;
  const NS = 'http://www.w3.org/2000/svg';

  let lo = Infinity, hi = -Infinity;
  for (const { seasons } of seriesEntries) {
    for (const s of seasons) {
      if (s.avgRating < lo) lo = s.avgRating;
      if (s.avgRating > hi) hi = s.avgRating;
    }
  }
  lo = Math.max(0, lo - 0.3);
  hi = Math.min(10, hi + 0.3);
  const span = Math.max(0.1, hi - lo);

  seriesEntries.forEach(({ title, seasons }, idx) => {
    const color = seasonColor(idx, seriesEntries.length);
    const n = seasons.length;
    const xStep = n > 1 ? (W - padX * 2) / (n - 1) : 0;
    const points = seasons.map((s, i) => {
      const x = padX + (n > 1 ? i * xStep : (W - padX * 2) / 2);
      const y = padY + (1 - (s.avgRating - lo) / span) * (H - padY * 2);
      return [x, y, s];
    });
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('opacity', '0.9');
    const title2 = document.createElementNS(NS, 'title');
    title2.textContent = title;
    path.appendChild(title2);
    svg.appendChild(path);
    for (const [x, y, s] of points) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('fill', color);
      const dotTitle = document.createElementNS(NS, 'title');
      dotTitle.textContent = `${title} — S${s.season}: avg ${s.avgRating.toFixed(1)}`;
      dot.appendChild(dotTitle);
      svg.appendChild(dot);
    }
  });
}

function buildCompareEntries() {
  const out = [];
  for (const id of Compare.ids) {
    const seasons = dataset.matches
      .filter((m) => m.seriesId === id)
      .sort((a, b) => a.season - b.season);
    if (!seasons.length) continue;
    out.push({ seriesId: id, title: seasons[0].title, seasons });
  }
  return out;
}

function renderCompareLegend(entries) {
  const colors = entries.map((_, i) => seasonColor(i, entries.length));
  const frag = document.createDocumentFragment();
  entries.forEach((e, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'overlay-legend-item compare-legend-remove';
    item.title = 'Remove from compare';
    const swatch = document.createElement('span');
    swatch.className = 'overlay-legend-swatch';
    swatch.style.background = colors[i];
    const label = document.createElement('span');
    label.textContent = e.title;
    const x = document.createElement('span');
    x.className = 'compare-legend-x';
    x.textContent = '×';
    item.append(swatch, label, x);
    item.addEventListener('click', () => {
      Compare.remove(e.seriesId);
      syncCompareFab();
      if (Compare.size() === 0) {
        closeCompareModal();
      } else {
        renderCompareModal();
      }
    });
    frag.appendChild(item);
  });
  els.compareModalLegend.replaceChildren(frag);
}

function renderCompareModal() {
  const entries = buildCompareEntries();
  if (entries.length === 0) {
    closeCompareModal();
    return;
  }
  drawCompareChart(els.compareModalCurve, entries, 600, 240);
  renderCompareLegend(entries);
}

let compareModalState = { lastFocus: null };

function openCompareModal() {
  if (!els.compareModal.hidden) return;
  if (Compare.size() === 0) return;
  compareModalState.lastFocus = document.activeElement;
  renderCompareModal();
  els.compareModal.hidden = false;
  els.compareModal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  syncModalInert();
  requestAnimationFrame(() => {
    const close = els.compareModal.querySelector('.modal-close');
    if (close) close.focus();
  });
}

function closeCompareModal() {
  if (els.compareModal.hidden) return;
  els.compareModal.hidden = true;
  els.compareModal.setAttribute('aria-hidden', 'true');
  if (els.modal.hidden && els.showModal.hidden) {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  syncModalInert();
  if (compareModalState.lastFocus && typeof compareModalState.lastFocus.focus === 'function') {
    compareModalState.lastFocus.focus();
  }
  compareModalState.lastFocus = null;
}

// --- modal ---

function openModal(m, opts = {}) {
  const wasOpen = !els.modal.hidden;
  const wasShowOpen = !els.showModal.hidden;
  // Inherit fromChangelog from the show modal we're closing, so closing
  // the (newly-opened) season modal still returns to the changelog.
  const inheritedFromChangelog = wasShowOpen && showModalState.fromChangelog;
  modalState.season = m;
  if (!wasOpen) {
    if (wasShowOpen) {
      // Transitioning from show → season; inherit show's lastFocus so
      // ultimately closing returns focus to whatever opened the chain.
      const inherited = showModalState.lastFocus;
      closeShowModal({ suppressReopen: true });
      modalState.lastFocus = inherited;
    } else {
      modalState.lastFocus = document.activeElement;
    }
  }
  modalState.surprise = !!opts.surprise;
  // Origin tracker — when set, closeModal reopens the changelog so the
  // user lands back in the "What's new" list they were browsing.
  modalState.fromChangelog = opts.fromChangelog === true || inheritedFromChangelog;

  els.modalTitle.textContent = m.title;
  const seasonYearStr = (m.seasonYear || m.year);
  const yearStr = seasonYearStr ? ` · ${seasonYearStr}` : '';
  els.modalSubtitle.textContent = `Season ${m.season} · ${m.episodes.length} episodes${yearStr} · ${m.genres.join(', ') || 'No genre listed'}`;

  // Shape pills + streaming chips in the modal-shapes row, matching the
  // chip row rendered on every result tile. Same suppression rule as
  // cards/rows/show-modal-season-list: 'saved-best-for-last' is a
  // show-level signal so it doesn't get a per-season pill.
  els.modalShapes.replaceChildren();
  fillShapeTags(
    els.modalShapes,
    m.shapes.filter((s) => s !== 'saved-best-for-last'),
    { clickable: false },
  );
  fillProviderTags(els.modalShapes, m.providers || []);

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  els.modalStats.replaceChildren();
  const statText = document.createElement('span');
  statText.textContent =
    `Climb ${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr}) · ` +
    `avg ${m.avgRating.toFixed(1)}`;
  els.modalStats.appendChild(statText);
  const seasonModalBadge = aboveImdbBadge(m);
  if (seasonModalBadge) els.modalStats.appendChild(seasonModalBadge);
  const runtimeStr = formatAvgRuntime(m.avgRuntime);
  els.modalStats.appendChild(document.createTextNode(
    ` · ${avgVotesPerEpisode(m).toLocaleString()} votes per episode (avg)` +
    (runtimeStr ? ` · ~${runtimeStr} per episode` : ''),
  ));

  els.modalOverview.textContent = m.overview || '';

  els.modalPoster.replaceChildren();
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w342${m.poster}`;
    img.alt = '';
    els.modalPoster.appendChild(img);
  } else {
    const fallback = document.createElement('div');
    fallback.className = 'poster-fallback';
    populatePosterFallback(fallback, m.title);
    els.modalPoster.appendChild(fallback);
  }

  drawCurve(els.modalCurve, m.episodes, 600, 180, { showAxis: true });

  const epFrag = document.createDocumentFragment();
  for (const e of m.episodes) {
    const li = document.createElement('li');
    // IMDb tags pre-season specials, unaired pilots, and Christmas episodes
    // as ep 0 of a given season. Flag them so the curve isn't read as a
    // weak cold open from a regular ep 1.
    if (e.episode === 0) li.classList.add('ep-special');

    const num = document.createElement('span');
    num.className = 'ep-number';
    if (e.episode === 0) {
      num.textContent = '★ Ep 0';
      num.title = 'Pre-season special (IMDb episode 0)';
    } else {
      num.textContent = `Ep ${e.episode}`;
    }

    // Episode title — populated by build-data.js from IMDb's
    // title.basics.tsv. Falls back to empty (hidden via CSS) when the
    // data was built without title support.
    const name = document.createElement('span');
    name.className = 'ep-name';
    if (e.name) {
      name.textContent = e.name;
      name.title = e.name;     // tooltip when truncated
    }

    const meta = document.createElement('span');
    meta.className = 'ep-meta';
    const rating = document.createElement('span');
    rating.className = 'ep-rating';
    rating.textContent = e.rating.toFixed(1);
    const votes = document.createElement('span');
    votes.className = 'ep-votes';
    votes.textContent = `${e.votes.toLocaleString()} votes`;
    meta.append(rating, votes);
    if (e.runtime) {
      const rt = document.createElement('span');
      rt.className = 'ep-runtime';
      rt.textContent = formatAvgRuntime(e.runtime);
      meta.append(rt);
    }

    li.append(num, name, meta);
    epFrag.appendChild(li);
  }
  els.modalEpisodes.replaceChildren(epFrag);

  els.modalImdb.href = `https://www.imdb.com/title/${m.seriesId}/episodes/?season=${m.season}`;
  // Prefer the season-level dereferrer when we have a season tvdbId; otherwise
  // fall back to the series page (still useful, just not deep-linked).
  if (m.seasonTvdbId) {
    els.modalTvdb.href = `https://thetvdb.com/dereferrer/season/${m.seasonTvdbId}`;
    els.modalTvdb.textContent = 'View season on TVDB →';
    els.modalTvdb.hidden = false;
  } else if (m.tvdbId) {
    els.modalTvdb.href = `https://thetvdb.com/dereferrer/series/${m.tvdbId}`;
    els.modalTvdb.textContent = 'View series on TVDB →';
    els.modalTvdb.hidden = false;
  } else {
    els.modalTvdb.removeAttribute('href');
    els.modalTvdb.hidden = true;
  }
  syncModalWatchBtn();
  els.modalReroll.hidden = !modalState.surprise;

  els.modal.hidden = false;
  els.modal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  syncModalInert();
  writeStateToURL();
  if (!wasOpen) {
    requestAnimationFrame(() => {
      const close = els.modal.querySelector('.modal-close');
      if (close) close.focus();
    });
  }
}

function closeModal(opts = {}) {
  if (els.modal.hidden) return;
  els.modal.hidden = true;
  els.modal.setAttribute('aria-hidden', 'true');
  if (els.showModal.hidden) {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  syncModalInert();
  if (modalState.lastFocus && typeof modalState.lastFocus.focus === 'function') {
    modalState.lastFocus.focus();
  }
  // Reopen the changelog if the user came from "What's new" AND we're
  // not chaining into another modal (e.g. season → show via "View show").
  const reopenChangelog = !opts.suppressReopen
    && modalState.fromChangelog
    && els.showModal.hidden;
  modalState.season = null;
  modalState.lastFocus = null;
  modalState.surprise = false;
  modalState.fromChangelog = false;
  writeStateToURL();
  if (reopenChangelog) openChangelogModal();
}

function openShowModal(seriesId, opts = {}) {
  const seasons = dataset.matches
    .filter((m) => m.seriesId === seriesId)
    .sort((a, b) => a.season - b.season);
  if (seasons.length === 0) return;

  const wasSeasonOpen = !els.modal.hidden;
  // Inherit origin from the season modal we're closing, so closing the
  // show modal still returns the user to the changelog.
  const inheritedFromChangelog = wasSeasonOpen && modalState.fromChangelog;
  if (wasSeasonOpen) closeModal({ suppressReopen: true });

  const meta = seasons[0];
  showModalState.seriesId = seriesId;
  showModalState.fromChangelog = inheritedFromChangelog || opts.fromChangelog === true;
  if (els.showModal.hidden) showModalState.lastFocus = document.activeElement;
  syncCompareButton();

  els.showModalTitle.textContent = meta.title;

  // Use each season's own air year (falling back to the show's start year)
  // so the range spans the show's full run — m.year is the show-level start
  // and is identical on every season record, which would otherwise collapse
  // the range to a single year.
  const years = seasons.map((s) => s.seasonYear || s.year).filter(Boolean);
  const yearStr = years.length === 0 ? ''
    : years[0] === years[years.length - 1] ? `${years[0]}`
    : `${years[0]}–${years[years.length - 1]}`;
  const typeLabel = meta.type === 'tvMiniSeries' ? 'Mini-series' : 'TV series';
  const subtitleParts = [typeLabel];
  if (yearStr) subtitleParts.push(yearStr);
  if (meta.genres && meta.genres.length) subtitleParts.push(meta.genres.join(', '));
  els.showModalSubtitle.textContent = subtitleParts.join(' · ');

  const totalEps = seasons.reduce((s, m) => s + m.episodes.length, 0);
  const overallAvg = seasons.reduce((s, m) => s + m.avgRating, 0) / seasons.length;
  // Show-level average runtime — averaged across every episode that has a
  // runtime in any season. Skipped entirely when none do.
  let showRuntimeSum = 0;
  let showRuntimeCount = 0;
  for (const s of seasons) {
    for (const e of s.episodes) {
      if (e.runtime) { showRuntimeSum += e.runtime; showRuntimeCount++; }
    }
  }
  const showAvgRuntime = showRuntimeCount > 0
    ? Math.round(showRuntimeSum / showRuntimeCount)
    : null;
  const watchedCount = seasons.filter((m) => Watched.has(m)).length;
  const statsParts = [
    `${seasons.length} season${seasons.length === 1 ? '' : 's'}`,
    `${totalEps} episodes`,
  ];
  if (typeof meta.seriesRating === 'number') {
    const votesStr = meta.seriesVotes ? ` (${meta.seriesVotes.toLocaleString()} votes)` : '';
    statsParts.push(`IMDb ${meta.seriesRating.toFixed(1)}${votesStr}`);
  }
  statsParts.push(`avg episode ${overallAvg.toFixed(1)}`);
  const showRuntimeStr = formatAvgRuntime(showAvgRuntime);
  if (showRuntimeStr) statsParts.push(`~${showRuntimeStr}/ep`);
  if (watchedCount > 0) statsParts.push(`${watchedCount} watched`);
  els.showModalStats.replaceChildren();
  els.showModalStats.appendChild(document.createTextNode(statsParts.join(' · ')));
  if (typeof meta.seriesRating === 'number' && overallAvg > meta.seriesRating) {
    const aboveBadge = document.createElement('span');
    aboveBadge.className = 'above-imdb above-imdb-pill';
    aboveBadge.textContent = '↑ Above IMDb';
    aboveBadge.title =
      `Average episode rating (${overallAvg.toFixed(1)}) is higher than the show's IMDb rating (${meta.seriesRating.toFixed(1)})`;
    els.showModalStats.appendChild(document.createTextNode(' '));
    els.showModalStats.appendChild(aboveBadge);
  }

  // Shape labels (Rising / Rebound / Big finale / etc.) live on the
  // per-season view only — they describe a single season's trajectory,
  // not a property of the whole show. Clear the show-modal shape slot
  // so it never renders an "intersection of every season's shapes"
  // pattern that doesn't really mean anything to a viewer.
  els.showModalShapes.replaceChildren();

  // Providers — use the same .provider-tag styling the cards and rows
  // render so streaming chips look identical across every surface. The
  // mainstream-provider filter happens inside fillProviderTags.
  els.showModalProviders.replaceChildren();
  fillProviderTags(els.showModalProviders, meta.providers || []);

  els.showModalOverview.textContent = meta.overview || '';

  els.showModalPoster.replaceChildren();
  if (meta.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w342${meta.poster}`;
    img.alt = '';
    els.showModalPoster.appendChild(img);
  } else {
    const fb = document.createElement('div');
    fb.className = 'poster-fallback';
    populatePosterFallback(fb, meta.title);
    els.showModalPoster.appendChild(fb);
  }

  const bestSeason = bestSeasonBySeries.get(seriesId);
  const worstSeason = worstSeasonBySeries.get(seriesId);
  const seasonsFrag = document.createDocumentFragment();
  for (const s of seasons) {
    seasonsFrag.appendChild(buildShowSeasonRow(s, bestSeason, worstSeason));
  }
  els.showModalSeasons.replaceChildren(seasonsFrag);

  // Overlay chart: only useful when there's >1 season to compare.
  if (seasons.length > 1) {
    els.showModalOverlay.hidden = false;
    const colors = drawSeasonOverlay(els.showModalOverlayCurve, seasons, 600, 200);
    const legendFrag = document.createDocumentFragment();
    for (const { season, color } of colors) {
      const item = document.createElement('span');
      item.className = 'overlay-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'overlay-legend-swatch';
      swatch.style.background = color;
      const label = document.createElement('span');
      label.textContent = `S${season}`;
      item.append(swatch, label);
      legendFrag.appendChild(item);
    }
    els.showModalOverlayLegend.replaceChildren(legendFrag);
  } else {
    els.showModalOverlay.hidden = true;
  }

  els.showModalImdb.href = `https://www.imdb.com/title/${seriesId}/`;
  if (els.showModalPermalink) {
    els.showModalPermalink.href = `/apps/rising-seasons/shows/${showSlug(meta.title)}-${seriesId}/`;
  }
  if (meta.tvdbId) {
    els.showModalTvdb.href = `https://thetvdb.com/dereferrer/series/${meta.tvdbId}`;
    els.showModalTvdb.hidden = false;
  } else {
    els.showModalTvdb.removeAttribute('href');
    els.showModalTvdb.hidden = true;
  }

  els.showModal.hidden = false;
  els.showModal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  syncModalInert();
  writeStateToURL();
  requestAnimationFrame(() => {
    const close = els.showModal.querySelector('.modal-close');
    if (close) close.focus();
  });
}

function buildShowSeasonRow(m, bestSeason, worstSeason) {
  const li = document.createElement('li');
  li.className = 'show-season';
  if (Watched.has(m)) li.classList.add('is-watched');
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-label', `Open season ${m.season} details`);

  const num = document.createElement('span');
  num.className = 'ss-num';
  num.textContent = `S${m.season}`;

  const meta = document.createElement('div');
  meta.className = 'ss-meta';
  const eps = document.createElement('span');
  eps.className = 'ss-eps';
  const ssYear = m.seasonYear || m.year;
  const yearStr = ssYear ? ` · ${ssYear}` : '';
  const ssRuntimeStr = formatAvgRuntime(m.avgRuntime);
  const ssRuntimeBit = ssRuntimeStr ? ` · ~${ssRuntimeStr}/ep` : '';
  eps.textContent = `${m.episodes.length} eps${yearStr}${ssRuntimeBit}`;
  meta.appendChild(eps);
  // Per-season shape labels inside the show modal's season list — these
  // belong to an individual season, not the show as a whole, so they stay
  // here. The show-level intersection rendered in els.showModalShapes
  // above is what gets suppressed (it's a property of the show).
  // Suppress 'saved-best-for-last' too — the ★ best marker rendered below
  // already conveys it.
  const rowShapes = m.shapes.filter((s) => s !== 'saved-best-for-last');
  if (rowShapes.length) {
    const shapeRow = document.createElement('span');
    shapeRow.className = 'ss-shape-row';
    for (const s of rowShapes) {
      const tag = document.createElement('span');
      tag.className = 'shape-tag' + (state.shapes.has(s) ? ' active' : '');
      tag.textContent = SHAPE_LABELS[s] || s;
      shapeRow.appendChild(tag);
    }
    meta.appendChild(shapeRow);
  }

  const sparkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sparkSvg.setAttribute('class', 'ss-spark curve');
  sparkSvg.setAttribute('viewBox', '0 0 200 36');
  sparkSvg.setAttribute('preserveAspectRatio', 'none');
  for (const cls of ['curve-area', 'curve-line']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', cls);
    sparkSvg.appendChild(path);
  }
  drawCurve(sparkSvg, m.episodes, 200, 36, 0);

  const stats = document.createElement('div');
  stats.className = 'ss-stats';
  const avg = document.createElement('span');
  avg.className = 'ss-avg';
  avg.textContent = `Avg ${m.avgRating.toFixed(1)}`;
  const ssAboveBadge = aboveImdbBadge(m);
  if (ssAboveBadge) avg.appendChild(ssAboveBadge);
  stats.appendChild(avg);
  if (bestSeason === m.season) {
    const best = document.createElement('span');
    best.className = 'ss-watched-tag';
    best.style.color = 'var(--accent)';
    best.textContent = '★ best';
    stats.appendChild(best);
  } else if (worstSeason === m.season) {
    const worst = document.createElement('span');
    worst.className = 'ss-watched-tag';
    worst.style.color = 'var(--danger)';
    worst.textContent = '▼ worst';
    stats.appendChild(worst);
  }
  if (Watched.has(m)) {
    const w = document.createElement('span');
    w.className = 'ss-watched-tag';
    w.textContent = '✓ watched';
    stats.appendChild(w);
  }

  li.append(num, meta, sparkSvg, stats);
  li.addEventListener('click', () => openModal(m));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(m);
    }
  });
  return li;
}

function closeShowModal(opts = {}) {
  if (els.showModal.hidden) return;
  els.showModal.hidden = true;
  els.showModal.setAttribute('aria-hidden', 'true');
  if (els.modal.hidden) {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  syncModalInert();
  if (showModalState.lastFocus && typeof showModalState.lastFocus.focus === 'function') {
    showModalState.lastFocus.focus();
  }
  const reopenChangelog = !opts.suppressReopen
    && showModalState.fromChangelog
    && els.modal.hidden;
  showModalState.seriesId = null;
  showModalState.lastFocus = null;
  showModalState.fromChangelog = false;
  writeStateToURL();
  if (reopenChangelog) openChangelogModal();
}

function syncModalWatchBtn() {
  if (!modalState.season) return;
  const isWatched = Watched.has(modalState.season);
  els.modalWatchBtn.classList.toggle('is-watched', isWatched);
  els.modalWatchBtn.textContent = isWatched ? 'Watched ✓' : 'Mark as watched';
}

// Mark everything outside the open modal as `inert` so Tab can't reach
// background controls (and assistive tech / pointer events are blocked too).
// When both modals are closed, clears inert from all body children.
function syncModalInert() {
  const openModal = !els.changelogModal.hidden
    ? els.changelogModal
    : !els.compareModal.hidden
      ? els.compareModal
      : !els.modal.hidden
        ? els.modal
        : !els.showModal.hidden
          ? els.showModal
          : null;
  for (const node of document.body.children) {
    if (node.tagName === 'TEMPLATE' || node.tagName === 'SCRIPT') continue;
    if (openModal && node !== openModal) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
  }
}

// --- view toggle (grid/list) ---

function applyViewClasses() {
  els.results.classList.toggle('list-view', state.view === 'list');
  for (const btn of els.viewToggle.querySelectorAll('.view-btn')) {
    btn.setAttribute('aria-pressed', btn.dataset.view === state.view ? 'true' : 'false');
  }
}

// --- last-updated / stale ---

function isStale() {
  if (!dataset?.builtAt) return false;
  const days = (Date.now() - new Date(dataset.builtAt).getTime()) / 86_400_000;
  return days > STALE_DAYS;
}

function warnIfStale() {
  if (isStale()) {
    console.warn(
      `Rising Seasons data is older than ${STALE_DAYS} days (built ${dataset.builtAt}). ` +
      `Run npm run build:rising-seasons or wait for the next scheduled refresh.`,
    );
  }
}

// --- changelog (What's new) ---

async function loadChangelog() {
  try {
    const res = await fetch('changelog.json', { cache: 'no-store' });
    if (!res.ok) return; // file may not exist yet on a fresh checkout
    const json = await res.json();
    if (json && Array.isArray(json.updates)) {
      changelog = json;
      // The initial render may have already painted the footer before the
      // fetch resolved — refresh it now so the "What's new" chip appears.
      if (dataset && els.footerMeta) renderFooterMeta();
    }
  } catch {
    // Network or parse error — non-fatal; UI just doesn't get the chip.
  }
}

function openChangelogModal() {
  const latest = changelog?.updates?.[0];
  if (!latest) return;

  if (els.changelogModal.hidden) changelogState.lastFocus = document.activeElement;

  els.changelogSubtitle.textContent = formatChangelogSubtitle(latest);
  renderChangelogTotals(latest);
  renderChangelogShapes(latest);
  renderChangelogAdded(latest);
  renderChangelogRemoved(latest);
  renderChangelogSwings(latest);

  els.changelogModal.hidden = false;
  els.changelogModal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  syncModalInert();
  requestAnimationFrame(() => {
    const close = els.changelogModal.querySelector('.modal-close');
    if (close) close.focus();
  });
}

function closeChangelogModal() {
  if (els.changelogModal.hidden) return;
  els.changelogModal.hidden = true;
  els.changelogModal.setAttribute('aria-hidden', 'true');
  if (els.modal.hidden && els.showModal.hidden && els.compareModal.hidden) {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  syncModalInert();
  if (changelogState.lastFocus && typeof changelogState.lastFocus.focus === 'function') {
    changelogState.lastFocus.focus();
  }
  changelogState.lastFocus = null;
}

function formatChangelogSubtitle(entry) {
  const date = formatBuiltAt(entry.builtAt);
  const total = entry.totals?.seasons?.toLocaleString?.() ?? '?';
  return `Refresh on ${date} · ${total} seasons tracked`;
}

function renderChangelogTotals(entry) {
  const totalsParts = [];
  const delta = entry.totals?.delta || 0;
  if (delta) {
    const sign = delta > 0 ? '+' : '−';
    totalsParts.push(`<strong>${sign}${Math.abs(delta).toLocaleString()}</strong> total seasons`);
  }
  if (entry.added?.length) totalsParts.push(`<strong>${entry.added.length}</strong> added`);
  if (entry.removed?.length) totalsParts.push(`<strong>${entry.removed.length}</strong> dropped`);
  const m = entry.modifiedCounts || {};
  const modified = Object.values(m).reduce((s, v) => s + (v || 0), 0);
  if (modified) {
    totalsParts.push(`<strong>${modified.toLocaleString()}</strong> seasons with field updates`);
  }
  if (!totalsParts.length) totalsParts.push('No measurable changes this refresh.');
  els.changelogTotals.innerHTML = totalsParts.map((p) => `<span class="changelog-stat">${p}</span>`).join('');
}

function renderChangelogShapes(entry) {
  const deltas = entry.shapeDeltas || {};
  const keys = Object.keys(deltas);
  if (!keys.length) {
    els.changelogShapesSection.hidden = true;
    return;
  }
  els.changelogShapesSection.hidden = false;
  els.changelogShapesList.replaceChildren();
  // Sort by absolute magnitude so the biggest movers come first.
  keys.sort((a, b) => Math.abs(deltas[b]) - Math.abs(deltas[a]));
  for (const k of keys) {
    const d = deltas[k];
    const pill = document.createElement('span');
    pill.className = `changelog-shape-pill ${d > 0 ? 'is-up' : 'is-down'}`;
    pill.textContent = `${k} ${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()}`;
    els.changelogShapesList.appendChild(pill);
  }
}

function renderChangelogAdded(entry) {
  const items = entry.added || [];
  if (!items.length) { els.changelogAddedSection.hidden = true; return; }
  els.changelogAddedSection.hidden = false;
  els.changelogAddedList.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'changelog-item-link';
    const year = item.seasonYear ? ` (${item.seasonYear})` : '';
    btn.textContent = `${item.title} · S${item.season}${year}`;
    btn.addEventListener('click', () => jumpToSeason(item));
    li.appendChild(btn);
    els.changelogAddedList.appendChild(li);
  }
}

function renderChangelogRemoved(entry) {
  const items = entry.removed || [];
  if (!items.length) { els.changelogRemovedSection.hidden = true; return; }
  els.changelogRemovedSection.hidden = false;
  els.changelogRemovedList.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    const year = item.seasonYear ? ` (${item.seasonYear})` : '';
    li.textContent = `${item.title} · S${item.season}${year}`;
    els.changelogRemovedList.appendChild(li);
  }
}

function renderChangelogSwings(entry) {
  const items = entry.ratingSwings || [];
  if (!items.length) { els.changelogSwingsSection.hidden = true; return; }
  els.changelogSwingsSection.hidden = false;
  els.changelogSwingsList.replaceChildren();
  for (const s of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'changelog-item-link';
    const arrow = s.delta > 0 ? '↑' : '↓';
    btn.innerHTML = `<span>${s.title} · S${s.season}</span> <span class="changelog-swing-delta ${s.delta > 0 ? 'is-up' : 'is-down'}">${arrow} ${s.from.toFixed(2)} → ${s.to.toFixed(2)}</span>`;
    btn.addEventListener('click', () => jumpToSeason(s));
    li.appendChild(btn);
    els.changelogSwingsList.appendChild(li);
  }
}

// Open the season directly when a user clicks an added title or a rating
// swing. The match is found by (seriesId, season); if the season is
// missing (e.g. it was added then dropped before the user opened the
// popover), we fall back to opening the show modal so they still see
// something useful.
function jumpToSeason(item) {
  if (!dataset?.matches) return;
  const m = dataset.matches.find((x) => x.seriesId === item.seriesId && x.season === item.season);
  closeChangelogModal();
  // fromChangelog flag — when set, closing the opened modal returns
  // the user to the "What's new" list they were browsing.
  if (m) {
    openModal(m, { fromChangelog: true });
  } else if (dataset.matches.some((x) => x.seriesId === item.seriesId)) {
    openShowModal(item.seriesId, { fromChangelog: true });
  }
}

// --- events ---

// --- search suggestions (autocomplete) ---

function computeSuggestions(rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];
  const qNorm = normalizeSearch(rawQuery);
  const exact = [];
  const titleStarts = [];
  const titleContains = [];
  const idMatches = [];
  const matchedIds = new Set();
  // Full pass over the index (~34k entries, <5 ms). Earlier code broke at
  // 40 collected candidates, which silently dropped the exact match for
  // any query whose canonical title falls late alphabetically — typing
  // "house" matched 40 titles starting with A-B before reaching "House".
  for (const s of seriesIndex) {
    const idL = s.seriesId.toLowerCase();
    const titleN = s.titleSearch;
    if (titleN === qNorm || idL === q || idL === `tt${q}`) {
      exact.push(s); matchedIds.add(s.seriesId);
    } else if (qNorm && titleN.startsWith(qNorm)) {
      titleStarts.push(s); matchedIds.add(s.seriesId);
    } else if (qNorm && titleN.includes(qNorm)) {
      titleContains.push(s); matchedIds.add(s.seriesId);
    } else if (idL.includes(q)) {
      idMatches.push(s); matchedIds.add(s.seriesId);
    }
  }
  // Within each bucket, rank by series IMDb popularity desc — so the
  // marquee "House" (~592k votes) beats "House of Cards" beats the
  // long tail of obscure house-containing shows.
  const byVotes = (a, b) => (b.seriesVotes || 0) - (a.seriesVotes || 0);
  exact.sort(byVotes);
  titleStarts.sort(byVotes);
  titleContains.sort(byVotes);
  idMatches.sort(byVotes);
  // Episode-name fallback: if the title pass didn't fill the dropdown and
  // the query is specific (>= 3 chars), surface series whose episode list
  // contains the query (e.g. "Gray Matter" → Breaking Bad).
  const epHits = [];
  const titleHits = exact.length + titleStarts.length + titleContains.length + idMatches.length;
  if (q.length >= 3 && titleHits < MAX_SUGGESTIONS) {
    const seriesById = new Map(seriesIndex.map((s) => [s.seriesId, s]));
    const seen = new Set();
    for (const m of dataset.matches) {
      if (matchedIds.has(m.seriesId) || seen.has(m.seriesId)) continue;
      for (const ep of m.episodes) {
        if (ep.name && ep.name.toLowerCase().includes(q)) {
          seen.add(m.seriesId);
          const base = seriesById.get(m.seriesId);
          if (base) {
            epHits.push({
              ...base,
              episodeMatch: ep.name,
              episodeSeason: m.season,
              episodeNumber: ep.episode,
            });
          }
          break;
        }
      }
      if (epHits.length + titleHits >= MAX_SUGGESTIONS * 2) break;
    }
  }
  return [...exact, ...titleStarts, ...titleContains, ...idMatches, ...epHits].slice(0, MAX_SUGGESTIONS);
}

function highlightFragment(text, q) {
  if (!q) return [document.createTextNode(text)];
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return [document.createTextNode(text)];
  const out = [];
  if (idx > 0) out.push(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(idx, idx + q.length);
  out.push(mark);
  if (idx + q.length < text.length) out.push(document.createTextNode(text.slice(idx + q.length)));
  return out;
}

function renderSuggestionItems() {
  const items = suggestState.items;
  const ul = els.suggestions;
  if (!items.length) {
    closeSuggestions();
    return;
  }
  const q = els.search.value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  items.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'search-suggestion';
    li.setAttribute('role', 'option');
    li.id = `ss-${i}`;
    li.dataset.index = String(i);
    li.setAttribute('aria-selected', i === suggestState.active ? 'true' : 'false');

    const poster = document.createElement('div');
    poster.className = 'ss-poster';
    if (s.poster) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w92${s.poster}`;
      img.alt = '';
      img.loading = 'lazy';
      poster.appendChild(img);
    } else {
      // Tinted initial placeholder — small enough that the full title
      // doesn't fit, so we show a single distinguishing character.
      poster.classList.add('ss-poster-fallback');
      poster.style.setProperty('--poster-hue', String(hashHue(s.title || 'unknown')));
      const initial = document.createElement('span');
      initial.className = 'ss-poster-initial';
      initial.textContent = posterInitial(s.title);
      poster.appendChild(initial);
    }

    const text = document.createElement('div');
    text.className = 'ss-text';

    const title = document.createElement('span');
    title.className = 'ss-title';
    for (const node of highlightFragment(s.title, q)) title.appendChild(node);

    const meta = document.createElement('span');
    meta.className = 'ss-meta';
    if (s.year) meta.appendChild(document.createTextNode(`${s.year} · `));
    for (const node of highlightFragment(s.seriesId, q)) meta.appendChild(node);

    text.append(title, meta);

    // If this match came from an episode-name hit, append a small line
    // explaining which episode caused the match — so the user understands
    // why Breaking Bad shows up when they typed "Gray Matter".
    if (s.episodeMatch) {
      const epHint = document.createElement('span');
      epHint.className = 'ss-ep-hint';
      epHint.appendChild(document.createTextNode(`S${s.episodeSeason}E${s.episodeNumber} · `));
      for (const node of highlightFragment(s.episodeMatch, q)) epHint.appendChild(node);
      text.appendChild(epHint);
    }
    li.append(poster, text);

    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', (e) => {
      e.preventDefault();
      selectSuggestion(i);
    });
    frag.appendChild(li);
  });
  ul.replaceChildren(frag);
  ul.hidden = false;
  els.search.setAttribute('aria-expanded', 'true');
  if (suggestState.active >= 0) {
    els.search.setAttribute('aria-activedescendant', `ss-${suggestState.active}`);
  } else {
    els.search.removeAttribute('aria-activedescendant');
  }
  suggestState.open = true;
}

function updateSuggestions() {
  const q = els.search.value.trim();
  if (!q) {
    closeSuggestions();
    return;
  }
  suggestState.items = computeSuggestions(q);
  suggestState.active = -1;
  if (!suggestState.items.length) {
    renderEmptySuggestion();
    return;
  }
  renderSuggestionItems();
}

function renderEmptySuggestion() {
  const ul = els.suggestions;
  const li = document.createElement('li');
  li.className = 'search-suggestion search-suggestion-empty';
  li.setAttribute('role', 'option');
  li.setAttribute('aria-disabled', 'true');
  li.textContent = 'No matches';
  ul.replaceChildren(li);
  ul.hidden = false;
  els.search.setAttribute('aria-expanded', 'true');
  els.search.removeAttribute('aria-activedescendant');
  suggestState.open = true;
}

function closeSuggestions() {
  els.suggestions.hidden = true;
  els.suggestions.replaceChildren();
  els.search.setAttribute('aria-expanded', 'false');
  els.search.removeAttribute('aria-activedescendant');
  suggestState.items = [];
  suggestState.active = -1;
  suggestState.open = false;
}

function moveSuggestionActive(delta) {
  if (!suggestState.open) return false;
  const n = suggestState.items.length;
  if (n === 0) return false;
  let next = suggestState.active + delta;
  if (next < -1) next = n - 1;
  if (next >= n) next = -1;
  suggestState.active = next;
  for (const li of els.suggestions.querySelectorAll('.search-suggestion')) {
    const idx = parseInt(li.dataset.index, 10);
    const isActive = idx === suggestState.active;
    li.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) li.scrollIntoView({ block: 'nearest' });
  }
  if (suggestState.active >= 0) {
    els.search.setAttribute('aria-activedescendant', `ss-${suggestState.active}`);
  } else {
    els.search.removeAttribute('aria-activedescendant');
  }
  return true;
}

function selectSuggestion(i) {
  const s = suggestState.items[i];
  if (!s) return;
  els.search.value = s.title;
  state.search = s.title;
  // Pin the results to this exact series — substring-match on title
  // would otherwise pull in unrelated shows that share a word
  // (e.g., picking BBC "Sherlock" would also surface "Sherlock Holmes"
  // and "The Case-Book of Sherlock Holmes").
  state.lockedSeriesId = s.seriesId;
  closeSuggestions();
  state.page = 1;
  render();
  // Open the show modal directly — the user picked a specific series, so
  // they want to see it. openShowModal calls writeStateToURL itself and
  // grabs focus, so we skip both here.
  openShowModal(s.seriesId);
}

function readToolbarInputs() {
  state.search = els.search.value.trim();
  state.minEpisodes = parseInt(els.minEpisodes.value, 10) || null;
  state.maxEpisodes = parseInt(els.maxEpisodes.value, 10) || null;
  state.minVotes = parseInt(els.minVotes.value, 10) || null;
  state.minAvg = parseFloat(els.minAvg.value) || null;
  state.minClimb = parseFloat(els.minClimb.value) || null;
  state.minYear = parseInt(els.minYear.value, 10) || null;
  state.maxYear = parseInt(els.maxYear.value, 10) || null;
  state.sort = els.sort.value;
}

function onToolbarChange() {
  readToolbarInputs();
  onFilterChange();
}

function bindEvents() {
  for (const btn of els.shapes.querySelectorAll('.shape-chip')) {
    btn.addEventListener('click', () => toggleShape(btn.dataset.shape));
  }

  const debouncedChange = debounce(onToolbarChange, 150);
  // Numeric inputs debounce on 'input' (mid-typing) but commit instantly on
  // 'change' (Tab out / blur) so users can still ENTER and see results.
  // Search also debounces — at 64k seasons the filter+chip-count work is
  // ~5-10 ms; per-keystroke renders made fast typing feel sticky.
  const debouncedInputIds = [
    'search', 'minEpisodes', 'maxEpisodes', 'minVotes', 'minAvg', 'minClimb', 'minYear', 'maxYear',
  ];
  for (const id of debouncedInputIds) {
    els[id].addEventListener('input', debouncedChange);
    els[id].addEventListener('change', onToolbarChange);
  }
  // Sort select still reacts instantly — it's a single click, not mid-typing.
  els.sort.addEventListener('input', onToolbarChange);
  els.sort.addEventListener('change', onToolbarChange);
  // Any direct keystroke in the search box releases the suggestion lock —
  // the user is now searching freeform, not riding a picked series.
  els.search.addEventListener('input', () => { state.lockedSeriesId = null; });

  if (els.labelFilters) {
    for (const btn of els.labelFilters.querySelectorAll('.label-chip')) {
      btn.addEventListener('click', () => {
        const filter = btn.dataset.filter;
        const val = btn.dataset.value;
        if (filter === 'seriesType') state.seriesType = val;
        else if (filter === 'watched') state.watched = val;
        else if (filter === 'aboveImdb') state.aboveImdb = val;
        else if (filter === 'hiddenGems') state.hiddenGems = val;
        syncLabelFiltersAria();
        onFilterChange();
      });
    }
  }

  els.search.addEventListener('input', updateSuggestions);
  els.search.addEventListener('focus', () => {
    if (els.search.value.trim()) updateSuggestions();
  });
  els.search.addEventListener('blur', () => {
    closeSuggestions();
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!suggestState.open && els.search.value.trim()) updateSuggestions();
      if (moveSuggestionActive(1)) e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      if (moveSuggestionActive(-1)) e.preventDefault();
    } else if (e.key === 'Enter') {
      if (suggestState.open && suggestState.active >= 0) {
        e.preventDefault();
        selectSuggestion(suggestState.active);
      }
    } else if (e.key === 'Escape' && suggestState.open) {
      e.preventDefault();
      e.stopPropagation();
      closeSuggestions();
    }
  });

  els.surprise.addEventListener('click', () => {
    const pick = surprisePick();
    if (pick) openModal(pick, { surprise: true });
  });

  els.modalReroll.addEventListener('click', () => {
    const pick = surprisePick();
    if (pick) openModal(pick, { surprise: true });
  });

  els.resetFilters.addEventListener('click', () => {
    state.shapes.clear();
    state.search = '';
    state.lockedSeriesId = null;
    state.minEpisodes = null;
    state.maxEpisodes = null;
    state.minVotes = null;
    state.minAvg = null;
    state.minClimb = null;
    state.minYear = null;
    state.maxYear = null;
    state.seriesType = 'all';
    state.sort = 'popularity';
    state.watched = 'all';
    state.aboveImdb = 'all';
    state.hiddenGems = 'all';
    state.genres = new Set();
    state.excludeGenres = new Set();
    state.languages = new Set();
    state.providers = new Set();
    state.page = 1;
    els.search.value = '';
    els.minEpisodes.value = '';
    els.maxEpisodes.value = '';
    els.minVotes.value = '';
    els.minAvg.value = '';
    els.minClimb.value = '';
    els.minYear.value = '';
    els.maxYear.value = '';
    els.sort.value = 'popularity';
    syncLabelFiltersAria();
    syncShapeChipsAria();
    for (const c of els.genres.querySelectorAll('.genre-chip')) {
      c.setAttribute('aria-pressed', 'false');
      c.dataset.exclude = 'false';
    }
    for (const c of els.languages.querySelectorAll('.genre-chip')) {
      c.setAttribute('aria-pressed', 'false');
    }
    for (const c of els.providers.querySelectorAll('.genre-chip')) {
      c.setAttribute('aria-pressed', 'false');
    }
    closeSuggestions();
    writeStateToURL();
    syncResetButton();
    render();
  });

  for (const btn of els.viewToggle.querySelectorAll('.view-btn')) {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      ViewPref.save(state.view);
      applyViewClasses();
      render();
    });
  }

  // When the URL hash changes (back/forward navigation, or user pasting a
  // new hash into the address bar), re-apply state from the URL and
  // re-render. writeStateToURL uses history.replaceState so our own URL
  // writes don't fire this event — only genuine user navigation does.
  window.addEventListener('hashchange', () => {
    applyStateFromURL();
    syncResetButton();
    render();
  });

  for (const closer of els.modal.querySelectorAll('[data-close="modal"]')) {
    closer.addEventListener('click', closeModal);
  }
  for (const closer of els.showModal.querySelectorAll('[data-close="show-modal"]')) {
    closer.addEventListener('click', closeShowModal);
  }
  for (const closer of els.compareModal.querySelectorAll('[data-close="compare-modal"]')) {
    closer.addEventListener('click', closeCompareModal);
  }
  for (const closer of els.changelogModal.querySelectorAll('[data-close="changelog-modal"]')) {
    closer.addEventListener('click', closeChangelogModal);
  }
  els.showModalCompare.addEventListener('click', () => {
    if (!showModalState.seriesId) return;
    if (Compare.has(showModalState.seriesId)) Compare.remove(showModalState.seriesId);
    else Compare.add(showModalState.seriesId);
    syncCompareButton();
    syncCompareFab();
  });
  els.compareFab.addEventListener('click', openCompareModal);
  els.compareModalClear.addEventListener('click', () => {
    Compare.clear();
    syncCompareFab();
    closeCompareModal();
  });
  els.modalViewShow.addEventListener('click', () => {
    if (!modalState.season) return;
    openShowModal(modalState.season.seriesId);
  });

  els.modalWatchBtn.addEventListener('click', () => {
    if (!modalState.season) return;
    Watched.toggle(modalState.season);
    syncModalWatchBtn();
    renderStatsBar();
    render();
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (e.key === 'Escape') {
      if (!els.changelogModal.hidden) {
        closeChangelogModal();
      } else if (!els.compareModal.hidden) {
        closeCompareModal();
      } else if (!els.modal.hidden) {
        closeModal();
      } else if (!els.showModal.hidden) {
        closeShowModal();
      } else if (document.body.classList.contains('advanced-drawer-open')) {
        closeAdvancedDrawer();
      } else if (document.body.classList.contains('is-menu-visible')) {
        document.body.classList.remove('is-menu-visible');
      } else if (document.activeElement === els.search && els.search.value) {
        els.search.value = '';
        state.lockedSeriesId = null;
        onToolbarChange();
      }
      return;
    }
  });
}

/* Advanced-filters drawer (mobile only).
   The <details class="advanced"> element is styled as a slide-up bottom
   sheet under 600px. This wires up:
     - body class so CSS can lock body scroll + show the backdrop
     - a real backdrop div so taps on the dimmed area close the drawer
     - ESC (handled in bindKeyboard above)
   Desktop keeps the original inline expand — the body class is only set
   when the viewport actually matches the mobile media query. */
const drawerMobileMQ = window.matchMedia('(max-width: 600px)');

function isDrawerMobile() {
  return drawerMobileMQ.matches;
}

function closeAdvancedDrawer() {
  const adv = document.querySelector('details.advanced');
  if (adv && adv.open) adv.open = false;
}

function bindAdvancedDrawer() {
  const adv = document.querySelector('details.advanced');
  if (!adv) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'advanced-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.addEventListener('click', closeAdvancedDrawer);
  document.body.appendChild(backdrop);

  // iOS-safe body scroll-lock. `overflow: hidden` alone doesn't stop the
  // page rubber-banding behind the drawer on iOS Safari, so we capture
  // the scroll position, pin <body> via position:fixed (CSS reads this
  // via the --scroll-lock-y custom property), and restore on close.
  let savedScrollY = 0;
  function lockScroll() {
    savedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.setProperty('--scroll-lock-y', `-${savedScrollY}px`);
  }
  function unlockScroll() {
    document.body.style.removeProperty('--scroll-lock-y');
    // Restore scroll position once the position:fixed is removed.
    window.scrollTo(0, savedScrollY);
  }

  function syncBodyClass() {
    const shouldLock = adv.open && isDrawerMobile();
    const isLocked = document.body.classList.contains('advanced-drawer-open');
    if (shouldLock && !isLocked) lockScroll();
    document.body.classList.toggle('advanced-drawer-open', shouldLock);
    if (!shouldLock && isLocked) unlockScroll();
  }

  adv.addEventListener('toggle', syncBodyClass);

  // If the viewport changes from mobile → desktop while open, drop the
  // body class so scroll-lock doesn't strand the user on the desktop view.
  drawerMobileMQ.addEventListener('change', syncBodyClass);
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Live remote-update channel: another device toggled a watched
// season. 750 ms debounce coalesces bursts after sign-in or
// reconnect. Re-loads the Watched set then re-renders.
let __rsRemoteRefreshTimer = null;
window.addEventListener('localStorageSync', (e) => {
  const key = e.detail?.key;
  if (typeof key !== 'string' || !key.startsWith(`${STORAGE_NS}:`)) return;
  if (e.detail?.source !== 'remote') return;
  clearTimeout(__rsRemoteRefreshTimer);
  __rsRemoteRefreshTimer = setTimeout(() => {
    Watched.load();
    render();
  }, 750);
});

load();
