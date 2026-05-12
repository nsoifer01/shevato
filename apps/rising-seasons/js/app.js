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
};

const STORAGE_NS = 'rising-seasons';
const KEY_WATCHED = `${STORAGE_NS}:watched`;
const KEY_VIEW = `${STORAGE_NS}:view`;
const KEY_COMPARE = `${STORAGE_NS}:compare`;
const COMPARE_LIMIT = 5;
const PAGE_SIZE = 24;
const STALE_DAYS = 30;
const MAX_SUGGESTIONS = 10;

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
let modalState = { season: null, lastFocus: null, surprise: false };
let showModalState = { seriesId: null, lastFocus: null };
const suggestState = { items: [], active: -1, open: false };

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
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
        year: m.year || null,
        poster: m.poster || null,
      };
      map.set(m.seriesId, entry);
    } else {
      if (!entry.poster && m.poster) entry.poster = m.poster;
      if (!entry.year && m.year) entry.year = m.year;
    }
  }
  seriesIndex = [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// --- URL state ---

function applyStateFromURL() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
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

  for (const btn of els.shapes.querySelectorAll('.shape-chip')) {
    const shape = btn.dataset.shape;
    const span = btn.querySelector('[data-count]');

    if (shape === 'all') {
      if (span) span.textContent = baseNoShape.length.toLocaleString();
      btn.disabled = false;
      btn.classList.remove('is-disabled');
      continue;
    }

    let n;
    if (state.shapes.has(shape)) {
      // Active: every result already has this shape, so n == result total.
      n = currentResults.length;
    } else {
      // Inactive: how many current results would survive adding this filter.
      n = 0;
      for (const m of currentResults) if (m.shapes.includes(shape)) n++;
    }
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
  const top = (dataset.providers || []).slice(0, 10);
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
  const q = state.search.trim().toLowerCase();
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
      const titleHit = m.title.toLowerCase().includes(q);
      const idHit = m.seriesId.toLowerCase().includes(q);
      let epHit = false;
      // Episode-title fallback — only run when the cheaper title/id checks
      // missed, since this scans every episode in the season.
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
      // High-rated (avg >= 8.0) and under the radar (each episode has fewer
      // than 1,000 votes, i.e. minVotes < 1000 across the season).
      if (m.avgRating < 8.0) return false;
      if (m.minVotes >= 1000) return false;
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
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;

  renderStatsBar();
  els.meta.textContent = filtered.length
    ? `${filtered.length.toLocaleString()} of ${dataset.count.toLocaleString()} seasons match your filters · page ${state.page} of ${totalPages.toLocaleString()}`
    : `0 of ${dataset.count.toLocaleString()} seasons match your filters`;

  if (filtered.length === 0) {
    showEmptyState();
    renderPager(0, 1);
    els.footerMeta.textContent = '';
    return;
  }

  const start = (state.page - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, filtered.length);

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(buildItem(filtered[i]));
  els.results.replaceChildren(frag);

  renderPager(totalPages, state.page);
  els.footerMeta.textContent = `Last updated: ${formatBuiltAt(dataset.builtAt)}`;
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
  if (totalPages <= 1) {
    els.pager.replaceChildren();
    els.pager.hidden = true;
    return;
  }
  els.pager.hidden = false;

  const frag = document.createDocumentFragment();
  frag.appendChild(pageButton('Prev', current - 1, current === 1));

  for (const n of pageNumbers(current, totalPages)) {
    if (n === '…') {
      const span = document.createElement('span');
      span.className = 'page-ellipsis';
      span.textContent = '…';
      span.setAttribute('aria-hidden', 'true');
      frag.appendChild(span);
    } else {
      const btn = pageButton(String(n), n, false);
      if (n === current) btn.setAttribute('aria-current', 'page');
      btn.setAttribute('aria-label', `Page ${n}`);
      frag.appendChild(btn);
    }
  }

  frag.appendChild(pageButton('Next', current + 1, current === totalPages));
  els.pager.replaceChildren(frag);
}

function pageButton(label, target, disabled) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'page-btn';
  btn.textContent = label;
  if (disabled) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.addEventListener('click', () => goToPage(target));
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

function goToPage(n) {
  state.page = n;
  writeStateToURL();
  render();
  const top = els.results.getBoundingClientRect().top + window.scrollY - 70;
  window.scrollTo({ top, behavior: 'smooth' });
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
  if (shapes.length === 0) {
    const tag = document.createElement('span');
    tag.className = 'shape-tag';
    tag.textContent = 'No pattern';
    tag.title = 'This season does not match any shape pattern.';
    container.appendChild(tag);
    return;
  }
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

  const badge = maybeBestBadge(m) || maybeWorstBadge(m);
  // Live next to the season metadata ("S2 · 10 eps") rather than at the
  // far end of the title row — keeps the title clean and aligns the badge
  // with the smaller-typography row it visually belongs in.
  if (badge) node.querySelector('.card-season').appendChild(badge);

  fillShapeTags(node.querySelector('.card-shapes'), m.shapes, { clickable: false });

  drawCurve(node.querySelector('.curve'), m.episodes, 300, 70);

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr})`;
  const avgEl = node.querySelector('.stat-avg');
  avgEl.textContent = `Avg ${m.avgRating.toFixed(1)}`;
  const cardBadge = aboveImdbBadge(m);
  if (cardBadge) avgEl.appendChild(cardBadge);
  node.querySelector('.stat-votes').textContent = `${m.minVotes.toLocaleString()} votes/ep min`;

  const posterEl = node.querySelector('.card-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w342${m.poster}`;
    img.alt = `${m.title} poster`;
    img.loading = 'lazy';
    posterEl.appendChild(img);
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

  const badge = maybeBestBadge(m) || maybeWorstBadge(m);
  if (badge) node.querySelector('.row-season').appendChild(badge);

  fillShapeTags(node.querySelector('.row-shapes'), m.shapes, { clickable: false });

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr})`;
  const rowAvgEl = node.querySelector('.stat-avg');
  rowAvgEl.textContent = `Avg ${m.avgRating.toFixed(1)}`;
  const rowBadge = aboveImdbBadge(m);
  if (rowBadge) rowAvgEl.appendChild(rowBadge);
  node.querySelector('.stat-votes').textContent = `${m.minVotes.toLocaleString()} votes/ep min`;

  drawCurve(node.querySelector('.row-curve'), m.episodes, 200, 56, 0);

  const posterEl = node.querySelector('.row-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w185${m.poster}`;
    img.alt = `${m.title} poster`;
    img.loading = 'lazy';
    posterEl.appendChild(img);
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

function drawCurve(svg, episodes, W, H, padXOverride) {
  // Charts with hover dots need a small inset so the dots don't get
  // clipped at the viewport edge. Sparklines without dots (the list-view
  // row and the show-modal per-season mini-spark) pass padX=0 so the
  // line/fill plot literally edge-to-edge — symmetric by construction,
  // no perceived left-bias from a 2-6 px gap on the left.
  const padX = typeof padXOverride === 'number' ? padXOverride : 4;
  const padY = 6;
  const ratings = episodes.map((e) => e.rating);
  const lo = Math.max(0, Math.min(...ratings) - 0.3);
  const hi = Math.min(10, Math.max(...ratings) + 0.3);
  const span = Math.max(0.1, hi - lo);
  const n = episodes.length;
  const xStep = n > 1 ? (W - padX * 2) / (n - 1) : 0;

  const points = episodes.map((e, i) => {
    const x = padX + (n > 1 ? i * xStep : (W - padX * 2) / 2);
    const y = padY + (1 - (e.rating - lo) / span) * (H - padY * 2);
    return [x, y];
  });

  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${H} L${points[0][0].toFixed(1)},${H} Z`;

  svg.querySelector('.curve-line').setAttribute('d', linePath);
  svg.querySelector('.curve-area').setAttribute('d', areaPath);

  const dots = svg.querySelector('.curve-dots');
  if (dots) {
    dots.replaceChildren();
    for (let i = 0; i < points.length; i++) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', points[i][0].toFixed(1));
      c.setAttribute('cy', points[i][1].toFixed(1));
      c.setAttribute('r', H > 100 ? '4' : '2.5');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `Ep ${episodes[i].episode}: ${episodes[i].rating.toFixed(1)} · ${episodes[i].votes.toLocaleString()} votes`;
      c.appendChild(title);
      dots.appendChild(c);
    }
  }
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
  const padX = 10;
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

  const NS = 'http://www.w3.org/2000/svg';
  const colors = [];
  seasons.forEach((s, idx) => {
    const color = seasonColor(idx, seasons.length);
    colors.push({ season: s.season, color });
    const n = s.episodes.length;
    const xStep = n > 1 ? (W - padX * 2) / (n - 1) : 0;
    const points = s.episodes.map((e, i) => {
      const x = padX + (n > 1 ? i * xStep : (W - padX * 2) / 2);
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
  modalState.season = m;
  if (!wasOpen) {
    if (wasShowOpen) {
      // Transitioning from show → season; inherit show's lastFocus so
      // ultimately closing returns focus to whatever opened the chain.
      const inherited = showModalState.lastFocus;
      closeShowModal();
      modalState.lastFocus = inherited;
    } else {
      modalState.lastFocus = document.activeElement;
    }
  }
  modalState.surprise = !!opts.surprise;

  els.modalTitle.textContent = m.title;
  const seasonYearStr = (m.seasonYear || m.year);
  const yearStr = seasonYearStr ? ` · ${seasonYearStr}` : '';
  els.modalSubtitle.textContent = `Season ${m.season} · ${m.episodes.length} episodes${yearStr} · ${m.genres.join(', ') || 'No genre listed'}`;

  fillShapeTags(els.modalShapes, m.shapes, { clickable: false });

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
  els.modalStats.appendChild(document.createTextNode(
    ` · ${m.minVotes.toLocaleString()} votes per episode (min)`,
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
    els.modalPoster.appendChild(fallback);
  }

  drawCurve(els.modalCurve, m.episodes, 600, 180);

  const epFrag = document.createDocumentFragment();
  for (const e of m.episodes) {
    const li = document.createElement('li');

    const num = document.createElement('span');
    num.className = 'ep-number';
    num.textContent = `Ep ${e.episode}`;

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

    li.append(num, name, meta);
    epFrag.appendChild(li);
  }
  els.modalEpisodes.replaceChildren(epFrag);

  els.modalImdb.href = `https://www.imdb.com/title/${m.seriesId}/episodes/?season=${m.season}`;
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

function closeModal() {
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
  modalState.season = null;
  modalState.lastFocus = null;
  modalState.surprise = false;
  writeStateToURL();
}

function openShowModal(seriesId) {
  const seasons = dataset.matches
    .filter((m) => m.seriesId === seriesId)
    .sort((a, b) => a.season - b.season);
  if (seasons.length === 0) return;

  const wasSeasonOpen = !els.modal.hidden;
  if (wasSeasonOpen) closeModal();

  const meta = seasons[0];
  showModalState.seriesId = seriesId;
  if (els.showModal.hidden) showModalState.lastFocus = document.activeElement;
  syncCompareButton();

  els.showModalTitle.textContent = meta.title;

  const years = seasons.map((s) => s.year).filter(Boolean);
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

  // Show-level shapes = INTERSECTION across seasons. A shape only belongs
  // at the show level if it's true of every season — anything else is a
  // per-season pattern (still rendered on each ss-shape-row below).
  let commonShapes = null;
  for (const s of seasons) {
    const set = new Set(s.shapes);
    if (commonShapes === null) {
      commonShapes = set;
    } else {
      for (const sh of [...commonShapes]) {
        if (!set.has(sh)) commonShapes.delete(sh);
      }
    }
  }
  fillShapeTags(els.showModalShapes, commonShapes ? [...commonShapes] : [], { clickable: false });

  // Providers badges (TMDB watch providers, US). Hidden when no data.
  const providersList = meta.providers || [];
  els.showModalProviders.replaceChildren();
  if (providersList.length) {
    for (const name of providersList) {
      const badge = document.createElement('span');
      badge.className = 'provider-badge';
      badge.textContent = name;
      els.showModalProviders.appendChild(badge);
    }
  }

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
  eps.textContent = `${m.episodes.length} eps${yearStr}`;
  meta.appendChild(eps);
  if (m.shapes.length) {
    const shapeRow = document.createElement('span');
    shapeRow.className = 'ss-shape-row';
    for (const s of m.shapes) {
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

function closeShowModal() {
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
  showModalState.seriesId = null;
  showModalState.lastFocus = null;
  writeStateToURL();
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
  const openModal = !els.compareModal.hidden
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

// --- events ---

// --- search suggestions (autocomplete) ---

function computeSuggestions(rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];
  const exact = [];
  const titleStarts = [];
  const titleContains = [];
  const idMatches = [];
  const matchedIds = new Set();
  for (const s of seriesIndex) {
    const titleL = s.title.toLowerCase();
    const idL = s.seriesId.toLowerCase();
    if (titleL === q || idL === q || idL === `tt${q}`) {
      exact.push(s); matchedIds.add(s.seriesId);
    } else if (titleL.startsWith(q)) {
      titleStarts.push(s); matchedIds.add(s.seriesId);
    } else if (titleL.includes(q)) {
      titleContains.push(s); matchedIds.add(s.seriesId);
    } else if (idL.includes(q)) {
      idMatches.push(s); matchedIds.add(s.seriesId);
    }
    if (exact.length + titleStarts.length + titleContains.length + idMatches.length >= MAX_SUGGESTIONS * 4) {
      break;
    }
  }
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
  const debouncedInputIds = [
    'minEpisodes', 'maxEpisodes', 'minVotes', 'minAvg', 'minClimb', 'minYear', 'maxYear',
  ];
  for (const id of debouncedInputIds) {
    els[id].addEventListener('input', debouncedChange);
    els[id].addEventListener('change', onToolbarChange);
  }
  // Search and the sort select react instantly.
  for (const id of ['search', 'sort']) {
    els[id].addEventListener('input', onToolbarChange);
    els[id].addEventListener('change', onToolbarChange);
  }
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

  for (const closer of els.modal.querySelectorAll('[data-close="modal"]')) {
    closer.addEventListener('click', closeModal);
  }
  for (const closer of els.showModal.querySelectorAll('[data-close="show-modal"]')) {
    closer.addEventListener('click', closeShowModal);
  }
  for (const closer of els.compareModal.querySelectorAll('[data-close="compare-modal"]')) {
    closer.addEventListener('click', closeCompareModal);
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
      if (!els.compareModal.hidden) {
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

load();
