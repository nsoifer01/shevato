'use strict';

// --- Feature 7: std dev helper (exported via window for tests) ---
function computeStdDev(episodes) {
  const n = episodes.length;
  if (n === 0) return 0;
  const ratings = episodes.map((e) => e.rating);
  const m = ratings.reduce((s, r) => s + r, 0) / n;
  return Math.sqrt(ratings.reduce((s, r) => s + (r - m) * (r - m), 0) / n);
}

// --- related-show selection helpers (exported via window for tests) ---

// Language-group matching for related suggestions. English stays strict
// (en only). Each non-English anchor language maps to a broader allowed-set
// of languages it may suggest from, grouped by linguistic/cultural family so a
// Korean season can surface other Asian-language shows, a German one other
// European shows, etc. Groups are derived from the actual data.json language
// distribution (every language with >=20 seasons is placed). Languages not in
// any group fall back to exact-match (including two empty-string languages,
// which match each other). The relation is per-anchor allowed-sets, not a
// symmetric equivalence class.
const LANGUAGE_GROUPS = {
  romance: ['es', 'pt', 'it', 'fr', 'ro', 'ca', 'gl'],
  european: [
    'de', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'sk', 'hu', 'ru', 'uk',
    'el', 'hr', 'sr', 'bg', 'is', 'et', 'lv', 'lt', 'bs', 'sh', 'sl', 'cy',
    'fr', 'it', 'es', 'pt', 'ro', 'ca', 'gl',
  ],
  asian: [
    'ko', 'ja', 'zh', 'cn', 'th', 'vi', 'id', 'ms', 'tl', 'fil', 'hi', 'ta',
    'te', 'ml', 'kn', 'bn', 'mr', 'ur',
  ],
  middleEastern: ['ar', 'he', 'fa', 'tr'],
};

// For each anchor language, the set of languages it may suggest from. English
// is intentionally absent so it keeps strict en-only matching.
const LANGUAGE_ALLOWED = (() => {
  const map = new Map();
  for (const langs of Object.values(LANGUAGE_GROUPS)) {
    const set = new Set(langs);
    for (const lang of langs) {
      if (!map.has(lang)) map.set(lang, new Set());
      for (const l of set) map.get(lang).add(l);
    }
  }
  return map;
})();

// True when candidateLang is an acceptable suggestion for anchorLang. Mapped
// anchors match any language in their group(s); unmapped anchors (and the
// empty-string language) require an exact match.
function languagesCompatible(anchorLang, candidateLang) {
  const anchor = anchorLang || '';
  const candidate = candidateLang || '';
  const allowed = LANGUAGE_ALLOWED.get(anchor);
  if (!allowed) return candidate === anchor;
  return allowed.has(candidate);
}

// Compute related shows for the show modal.
// d = mean(season avgRatings) - seriesRating. Requires seriesRating on both shows.
// Candidates: other series with seriesRating that share at least one genre,
// have a compatible original language (languagesCompatible), and sit within one order of magnitude of
// the current show's votes/episode (mean of its seasons' minVotes).
// Sort: |d_current - d_candidate| asc, then shared-genre count desc, then votes desc.
// Returns up to 10; caller hides section only when there are none.
function computeShowRelated(seriesId, matches) {
  const bySeriesId = new Map();
  for (const m of matches) {
    if (!bySeriesId.has(m.seriesId)) bySeriesId.set(m.seriesId, []);
    bySeriesId.get(m.seriesId).push(m);
  }
  const currentSeasons = bySeriesId.get(seriesId);
  if (!currentSeasons || currentSeasons.length === 0) return [];
  const currentMeta = currentSeasons[0];
  if (typeof currentMeta.seriesRating !== 'number') return [];
  const meanVotes = (seasons) =>
    seasons.reduce((s, m) => s + (m.minVotes || 0), 0) / seasons.length;
  const currentAvg = currentSeasons.reduce((s, m) => s + m.avgRating, 0) / currentSeasons.length;
  const currentDev = currentAvg - currentMeta.seriesRating;
  const currentGenres = currentMeta.genres || [];
  const currentLang = currentMeta.language || '';
  const voteAnchor = meanVotes(currentSeasons);

  const results = [];
  for (const [sid, seasons] of bySeriesId) {
    if (sid === seriesId) continue;
    const meta = seasons[0];
    if (typeof meta.seriesRating !== 'number') continue;
    if (!languagesCompatible(currentLang, meta.language)) continue;
    if (voteAnchor > 0) {
      const xv = meanVotes(seasons);
      if (xv < voteAnchor / 10 || xv > voteAnchor * 10) continue;
    }
    const xGenres = meta.genres || [];
    const sharedGenreCount = currentGenres.filter((g) => xGenres.includes(g)).length;
    if (sharedGenreCount === 0) continue;
    const avg = seasons.reduce((s, m) => s + m.avgRating, 0) / seasons.length;
    const dev = avg - meta.seriesRating;
    const devDiff = Math.abs(currentDev - dev);
    const voteProxy = typeof meta.seriesVotes === 'number' ? meta.seriesVotes : (meta.minVotes || 0);
    results.push({ meta, avg, devDiff, sharedGenreCount, voteProxy });
  }
  results.sort((a, b) => {
    if (a.devDiff !== b.devDiff) return a.devDiff - b.devDiff;
    if (b.sharedGenreCount !== a.sharedGenreCount) return b.sharedGenreCount - a.sharedGenreCount;
    return b.voteProxy - a.voteProxy;
  });
  return results.slice(0, 10).map((r) => ({ ...r.meta, _avg: r.avg }));
}

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
  'shape-drift': 'Shape drift',
};

const SHAPE_DESCS = {
  rising: 'Each episode at least as good as the last',
  consistent: 'Excellent throughout, no weak link',
  'slow-burn': 'Second half lifts off',
  'big-finale': 'The last episode is the peak',
  rebound: 'Dips, then comes back stronger',
  'front-loaded': 'Strong start, weaker back half',
  declining: 'Each episode no better than the last',
  'bad-finale': 'Finale is the worst episode',
  rollercoaster: 'Big swings episode to episode',
  'mid-peak': 'Climaxes mid-season, falls after',
  'u-shaped': 'Strong opener and finale, sag in the middle',
  'saved-best-for-last': 'Final season is the show\'s highest-rated',
  'shape-drift': 'Show\'s rating pattern or quality changed significantly late in its run',
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

// Legacy namespace kept as 'rising-seasons' (not 'rising-shows') on purpose so
// signed-in users' already-synced data (watched shows, compare set) carries over
// the rebrand instead of being orphaned. Matches the keys in
// sync-system/app-sync-init.js.
const STORAGE_NS = 'rising-seasons';
const KEY_WATCHED = `${STORAGE_NS}:watched`;
const KEY_COMPARE = `${STORAGE_NS}:compare`;
const KEY_SCROLL = `${STORAGE_NS}:scroll`;
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
  showModalProviders: document.getElementById('showModalProviders'),
  footerMeta: document.getElementById('footer-meta'),
  skeletonTpl: document.getElementById('skeleton-template'),
  modal: document.getElementById('detailModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalSubtitle: document.getElementById('modalSubtitle'),
  modalShapes: document.getElementById('modalShapes'),
  modalStats: document.getElementById('modalStats'),
  modalOverview: document.getElementById('modalOverview'),
  modalCurve: document.getElementById('modalCurve'),
  modalEpisodes: document.getElementById('modalEpisodes'),
  modalShareCard: document.getElementById('modalShareCard'),
  modalImdb: document.getElementById('modalImdb'),
  modalTvdb: document.getElementById('modalTvdb'),
  showModalShareCard: document.getElementById('showModalShareCard'),
  modalPoster: document.getElementById('modalPoster'),
  modalWatchBtn: document.getElementById('modalWatchBtn'),
  modalViewShow: document.getElementById('modalViewShow'),
  showModal: document.getElementById('showModal'),
  showModalTitle: document.getElementById('showModalTitle'),
  showModalSubtitle: document.getElementById('showModalSubtitle'),
  showModalStats: document.getElementById('showModalStats'),
  showModalShapes: document.getElementById('showModalShapes'),
  showModalOverview: document.getElementById('showModalOverview'),
  showModalCast: document.getElementById('showModalCast'),
  showModalCastList: document.getElementById('showModalCastList'),
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
  changelogFreshnessContent: document.getElementById('changelogFreshnessContent'),
  modalBack: document.getElementById('modalBack'),
  showModalBack: document.getElementById('showModalBack'),
  shortcutLegendBtn: document.getElementById('shortcutLegendBtn'),
  shortcutLegend: document.getElementById('shortcutLegend'),
  modalCurveAnnotation: document.getElementById('modalCurveAnnotation'),
  showModalWatchOn: document.getElementById('showModalWatchOn'),
  finderSearch: document.getElementById('finderSearch'),
  finderSuggestions: document.getElementById('finderSearchSuggestions'),
  finderViewToggle: document.getElementById('finderViewToggle'),
  finderSurprise: document.getElementById('finderSurprise'),
  finderPopularPick: document.getElementById('finderPopularPick'),
  finderActiveFilterBar: document.getElementById('finderActiveFilterBar'),
  finderMinEpisodes: document.getElementById('finderMinEpisodes'),
  finderMinVotes: document.getElementById('finderMinVotes'),
  finderVotesChips: document.getElementById('finderVotesChips'),
  finderGemsChip: document.getElementById('finderGemsChip'),
  finderMinShowRating: document.getElementById('finderMinShowRating'),
  finderMinAvgEpisode: document.getElementById('finderMinAvgEpisode'),
  finderGapDir: document.getElementById('finderGapDir'),
  finderMinGap: document.getElementById('finderMinGap'),
  finderMinYear: document.getElementById('finderMinYear'),
  finderMaxYear: document.getElementById('finderMaxYear'),
  finderDecadeRow: document.getElementById('finderDecadeRow'),
  finderShapes: document.getElementById('finderShapes'),
  finderMoodChips: document.getElementById('finderMoodChips'),
  finderGenres: document.getElementById('finderGenres'),
  finderLanguages: document.getElementById('finderLanguages'),
  finderSort: document.getElementById('finderSort'),
  finderSortDir: document.getElementById('finderSortDir'),
  finderReset: document.getElementById('finderReset'),
  finderCount: document.getElementById('finderCount'),
  finderResults: document.getElementById('finderResults'),
  finderPager: document.getElementById('finderPager'),
  finderPagerTop: document.getElementById('finderPagerTop'),
  finderCardTpl: document.getElementById('finder-card-template'),
};

// --- mutable state ---

let dataset = null;
// Show Finder is the only view. `mode` is retained as a constant so the
// finder's own render/URL helpers (which still read it) keep working; there
// is no longer a Seasons view to switch to.
let mode = 'finder';
let showAgg = null;
const finderState = {
  search: '',
  minEpisodes: 0,
  minVotes: 0,
  minShowRating: 0,
  minAvgEpisode: 0,
  gapDir: 'any',
  minGap: 0,
  minYear: null,
  maxYear: null,
  hiddenGems: false,
  genres: new Set(),
  genresExclude: new Set(),
  languages: new Set(),
  // Show-level rating shapes (AND semantics, like the Seasons view). A show's
  // shape is classified from the curve of its per-season episode averages.
  shapes: new Set(),
  sort: 'votes',
  sortDir: 'desc',
  view: 'grid',
  page: 1,
};
let seriesIndex = [];
// Series IDs carrying the IMDb "Adult" genre on any season — used to blur
// their posters even on lightweight surfaces (suggestions) where the item
// object doesn't include the genres array. Populated by buildSeriesIndex.
let adultSeriesIds = new Set();
let bestSeasonBySeries = new Map();
let worstSeasonBySeries = new Map();
let aboveImdbBySeries = new Map();
let pendingModalKey = null;
let pendingShowKey = null;
let modalState = { season: null, lastFocus: null, surprise: false, fromChangelog: false };
let showModalState = { seriesId: null, lastFocus: null, fromChangelog: false };
let changelog = null;
let changelogState = { lastFocus: null };
const finderSuggestState = { items: [], active: -1, open: false };

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

// --- sensitive (adult) posters ---
// The dataset carries no explicit adult flag, but IMDb tags adult titles with
// the "Adult" genre. Posters for those titles are blurred behind a tap-to-
// reveal overlay so explicit art never renders unprompted. Reveal is per-
// poster and per-session (re-blurs on reload) — the safe default for
// sensitive content.
function isAdultItem(item) {
  if (!item) return false;
  if (Array.isArray(item.genres) && item.genres.includes('Adult')) return true;
  // Fallback for lightweight items (e.g. search suggestions) that carry a
  // seriesId but no genres array.
  return !!item.seriesId && adultSeriesIds.has(item.seriesId);
}

// Blur `posterEl` and lay a reveal button over it when `item` is adult.
// No-ops otherwise, so it's safe to call at every poster render site. Call
// AFTER the <img>/fallback has been appended.
function markSensitivePoster(posterEl, item) {
  if (!posterEl || !isAdultItem(item)) return;
  // Only blur a real poster image. Fallback tiles are just the title on a
  // colored block — not explicit — so leave them legible.
  if (!posterEl.querySelector('img')) return;
  posterEl.classList.add('poster-sensitive');
  const overlay = document.createElement('button');
  overlay.type = 'button';
  overlay.className = 'poster-reveal';
  overlay.setAttribute('aria-label', 'Sensitive content - click to reveal poster');
  overlay.innerHTML =
    '<span class="poster-reveal-badge" aria-hidden="true">'
    + '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/>'
    + '<path d="M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61"/>'
    + '<path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="2" y1="2" x2="22" y2="22"/>'
    + '</svg></span>'
    + '<span class="poster-reveal-cta">Tap to reveal</span>';
  // Reveal without bubbling to the card/row click (which would open a modal).
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    posterEl.classList.add('revealed');
  });
  posterEl.appendChild(overlay);
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

// fuzzy-search: character-bigram set used by the Dice-coefficient
// scorer. Run on already-normalized strings so "The Bear" and "bear"
// hash to identical bigram sets.
function searchBigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// fuzzy-search: Sørensen–Dice coefficient over two bigram sets.
// Returns 1.0 for identical strings, ~0.67 for "beat" vs "bear",
// trending to 0 as the strings diverge.
function searchDice(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const bg of a) if (b.has(bg)) inter++;
  return (2 * inter) / (a.size + b.size);
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

// --- scroll restoration ---
// The grid renders only after data.json is fetched, so at the moment the
// browser would natively restore scroll position the document is still just
// skeletons and short. Native 'auto' restoration clamps the saved offset to
// that short height, stranding a bottom-of-page refresh in the middle once
// the real content expands the document. We take it over: switch to 'manual',
// stash the offset in sessionStorage as the user scrolls / leaves, and restore
// it ourselves once the height-defining content has rendered.
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

// Clamp a stored offset to what the now-rendered document can actually reach.
// Pulled out as a pure function so the restore math is unit-testable without a
// live layout.
function clampScrollY(stored, maxScrollY) {
  if (!Number.isFinite(stored) || stored <= 0) return 0;
  if (!Number.isFinite(maxScrollY) || maxScrollY <= 0) return 0;
  return Math.min(stored, maxScrollY);
}

const ScrollMemory = {
  save() {
    try {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      if (y > 0) sessionStorage.setItem(KEY_SCROLL, String(y));
      else sessionStorage.removeItem(KEY_SCROLL);
    } catch { /* sessionStorage disabled — position just won't persist */ }
  },
  read() {
    try {
      const raw = sessionStorage.getItem(KEY_SCROLL);
      if (raw == null) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  },
  // Restore after the grid (the content that defines page height) has been
  // appended. A bare `#key=value` hash is RS's own filter state, not an
  // anchor; only skip restoration when the hash targets a real element id so
  // genuine deep-link anchors win over the saved offset.
  //
  // The grid's cards lay out (and the fonts/SVG curves settle) over a few
  // frames after replaceChildren, so scrollHeight can still be growing when we
  // first try. Re-apply across a handful of frames until the document is tall
  // enough to reach the stored offset, then stop. Capped so a genuinely short
  // result set (stored offset unreachable) settles instead of looping.
  restore() {
    const hash = location.hash.replace(/^#/, '');
    if (hash) {
      let target = null;
      try { target = document.getElementById(decodeURIComponent(hash)); }
      catch { target = null; }
      if (target) return;
    }
    const stored = this.read();
    if (stored == null || stored <= 0) return;
    let attempts = 0;
    const apply = () => {
      const maxScrollY = document.documentElement.scrollHeight - window.innerHeight;
      const y = clampScrollY(stored, maxScrollY);
      if (y > 0) window.scrollTo(0, y);
      attempts++;
      // Keep re-applying while the page is still too short to reach the saved
      // offset (layout hasn't finished growing), up to a frame budget.
      if (maxScrollY < stored && attempts < 20) {
        requestAnimationFrame(apply);
      }
    };
    apply();
  },
};

function bindScrollMemory() {
  let raf = 0;
  window.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; ScrollMemory.save(); });
  }, { passive: true });
  // pagehide covers both real unloads and bfcache freezes (and fires on
  // mobile where 'beforeunload' is unreliable).
  window.addEventListener('pagehide', () => ScrollMemory.save());
}

// Chrome (header / footer / menu / auth UI) is loaded by
// ../../assets/js/main.js — see the script block in index.html. We
// deliberately do not run a second include loader here: parallel AJAX
// includes would race main.js and overwrite the just-injected auth UI.

// --- bootstrap ---

async function load() {
  showSkeletons(8);
  let extras = null;
  try {
    // data.json carries everything needed to filter, sort, and render the
    // grid. show-modal-extras.json carries cast, per-season plot overviews,
    // and per-episode IMDb deep-link IDs / runtimes / titles — kept separate
    // so data.json stays under GitHub's 100 MB file-size cap. Fetched in
    // parallel; the extras file is optional, so a failure there doesn't
    // block the grid (episode rows just lose their titles).
    const [dataRes, extrasRes] = await Promise.all([
      fetch('data.json', { cache: 'no-store' }),
      fetch('data/show-modal-extras.json', { cache: 'no-store' }).catch(() => null),
    ]);
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status}`);
    dataset = await dataRes.json();
    if (extrasRes && extrasRes.ok) {
      try { extras = await extrasRes.json(); }
      catch (_) { extras = null; }
    }
  } catch (err) {
    showError(err);
    return;
  }
  // Precompute normalized title once per match so the search hot path doesn't
  // re-derive it on every filter pass. [[normalizeSearch]] for the rule.
  // Same pass attaches per-match modal extras (cast, season overview, per-episode
  // tt + runtime + title) from show-modal-extras.json. The fields are placed directly
  // on each match object so downstream code can keep reading `m.cast`, `m.seasonOverview`,
  // `e.tt`, `e.runtime`, and `e.name` exactly as it did when everything lived in data.json.
  for (const m of dataset.matches) {
    m.titleSearch = normalizeSearch(m.title);
    // Feature 7: precompute std dev once so the volatility sort is O(1) per comparison.
    m._stddev = computeStdDev(m.episodes);
    if (extras) {
      const e = extras[m.seriesId];
      if (e) {
        if (e.cast) m.cast = e.cast;
        const sRec = e.seasons && e.seasons[String(m.season)];
        if (sRec) {
          if (sRec.ov) m.seasonOverview = sRec.ov;
          if (sRec.eps && Array.isArray(m.episodes)) {
            for (const ep of m.episodes) {
              const rec = sRec.eps[String(ep.episode)];
              if (rec) {
                if (rec.tt) ep.tt = rec.tt;
                if (rec.rt !== undefined) ep.runtime = rec.rt;
                // Guarded so a pre-split data.json (inline names, no rec.n)
                // keeps working while the daily refresh flips the format.
                if (rec.n && !ep.name) ep.name = rec.n;
              }
            }
          }
        }
      }
    }
  }
  loadChangelog();
  Watched.load();
  Compare.load();
  applyStateFromURL();
  warnIfStale();
  buildSeriesIndex();
  buildBestSeasonMap();
  buildAboveImdbMap();
  syncCompareFab();
  bindEvents();
  bindKeyboard();
  bindAdvancedDrawer();
  bindShapeTagTouchTooltips();
  bindShortcutLegend();
  showAgg = buildShowAgg();
  renderFinderShapes();
  renderFinderMoods();
  renderFinderGenres();
  renderFinderLanguages();
  renderFinderDecadeRow();
  bindFinder();
  // Show Finder is the only view. finderState was populated by applyStateFromURL
  // (which ran before showAgg existed); now that the finder controls are in the
  // DOM, push that state onto them and render.
  syncFinderControls();
  syncFinderSortControls();
  applyFinderViewClasses();
  renderFinder();
  bindScrollMemory();
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
  } else {
    // Restore the saved scroll position now that the grid (which defines the
    // page height) is in the DOM. A modal deep-link opens at the top instead,
    // so this only runs for the plain grid view. rAF lets layout settle so
    // scrollHeight reflects the freshly appended cards.
    requestAnimationFrame(() => ScrollMemory.restore());
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
    if (Array.isArray(m.genres) && m.genres.includes('Adult')) adultSeriesIds.add(m.seriesId);
  }
  seriesIndex = [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// --- URL state ---

function applyStateFromURL() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));

  // Show Finder is the only view. Its filters live in the hash (fSort=...&fMinVotes=...);
  // parseFinderQuery resets to defaults for any key that's absent, so a bare hash
  // just opens the default finder. Legacy keys like view=finder are ignored, so
  // old bookmarks keep working. The DOM controls are synced separately by
  // syncFinderControls once they exist.
  mode = 'finder';
  applyFinderStateFromParams(p);

  // Deep links that open a modal on load: a show permalink (?show=) opens the
  // show modal; a legacy season link (?season=) opens that season's detail
  // (still reachable as an in-show drill-down).
  if (p.has('season')) pendingModalKey = p.get('season');
  if (p.has('show'))   pendingShowKey = p.get('show');
}

// Decade ranges — used by the Show Finder decade filter.
const DECADE_RANGES = {
  '80s':  [1980, 1989],
  '90s':  [1990, 1999],
  '00s':  [2000, 2009],
  '10s':  [2010, 2019],
  '20s':  [2020, 2029],
};

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

// --- filter + sort ---

function passesShapeAnd(m, shapeSet) {
  if (shapeSet.size === 0) return true;
  for (const s of shapeSet) if (!m.shapes.includes(s)) return false;
  return true;
}

// --- render ---

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
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Loading skeletons painted into the finder results grid while data.json loads.
function showSkeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.appendChild(els.skeletonTpl.content.firstElementChild.cloneNode(true));
  }
  els.finderResults.replaceChildren(frag);
}

function showError(err) {
  const div = document.createElement('div');
  div.className = 'empty';
  const p1 = document.createElement('p');
  p1.textContent = "Couldn't load show data.";
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
  els.finderResults.replaceChildren(div);
}

// --- pagination ---

// True if anything in `state` differs from its default. Used to gate the
// Reset-all-filters button — there's nothing to reset if every knob is
// already at its default value.
// Two surprise modes:
//   'any'     — true random across every filtered season.
//   'popular' — random from the top 50 by current sort (popularity by
//               default), so the user always lands on something with
//               enough audience to have an opinion about.
// Reroll inside the modal honors whichever mode the user clicked.
// --- shared shape-tag + best-badge helpers ---

// Render read-only shape pills into a container (season detail modal).
function fillShapeTags(container, shapes) {
  container.replaceChildren();
  // No "No pattern" placeholder — an empty shape container just renders
  // nothing, which keeps the card/list cleaner for seasons that don't fit
  // a recognized trajectory shape.
  if (shapes.length === 0) return;
  for (const s of shapes) {
    const desc = SHAPE_DESCS[s] || '';
    const tag = document.createElement('span');
    tag.className = 'shape-tag';
    tag.textContent = SHAPE_LABELS[s] || s;
    if (desc) tag.title = desc;
    container.appendChild(tag);
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
function avgVotesPerEpisode(m) {
  return Math.round(m.episodes.reduce((s, e) => s + e.votes, 0) / m.episodes.length);
}

// Renders the top-billed cast strip inside the show modal. `cast` is
// the array stashed on the series by enrich-tmdb.js — each entry is
// { name, character, profile_path }. Empty/missing cast hides the
// whole section so the modal flow stays clean.
function renderShowModalCast(cast) {
  const section = els.showModalCast;
  const list = els.showModalCastList;
  if (!section || !list) return;
  list.replaceChildren();
  if (!Array.isArray(cast) || cast.length === 0) {
    section.hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const person of cast) {
    const li = document.createElement('li');
    li.className = 'cast-card';

    // Inner container: <a> when we have a TMDB person id so the whole
    // card is a clickable link to their TMDB person page (which links
    // out to IMDb / Wikipedia / etc.). Falls back to <div> for cache
    // entries written before person.id was stored.
    let inner;
    if (Number.isFinite(person.id)) {
      inner = document.createElement('a');
      inner.href = `https://www.themoviedb.org/person/${person.id}`;
      inner.target = '_blank';
      inner.rel = 'noopener noreferrer';
      inner.title = `View ${person.name || 'cast member'} on TMDB`;
    } else {
      inner = document.createElement('div');
    }
    inner.className = 'cast-card-inner';

    const photo = document.createElement('div');
    photo.className = 'cast-photo';
    if (person.profile_path) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w185${person.profile_path}`;
      img.alt = '';
      img.loading = 'lazy';
      photo.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'cast-photo-fallback';
      fb.textContent = (person.name || '?').charAt(0).toUpperCase();
      photo.appendChild(fb);
    }
    const name = document.createElement('span');
    name.className = 'cast-name';
    name.textContent = person.name || '';
    inner.appendChild(photo);
    inner.appendChild(name);
    if (person.character) {
      const ch = document.createElement('span');
      ch.className = 'cast-character';
      ch.textContent = person.character;
      inner.appendChild(ch);
    }
    li.appendChild(inner);
    frag.appendChild(li);
  }
  list.appendChild(frag);
  section.hidden = false;
}

// Set aria-pressed=true on any mood chip whose href params exactly match
// the current filter state. The pressed state drives the yellow styling
// in the CSS, and is also what the click handler reads to decide whether
// a click "toggles off" the preset.
// The mood rail shows the first MOOD_CHIP_LIMIT presets; the rest collapse
// behind a "More moods +N" toggle so the section scales to dozens of moods
// without dominating the page. An ACTIVE mood is never hidden, even when it
// sits past the limit — collapsing away the user's current selection would
// make the pressed state invisible. Same interaction family as the shape
// bar's "More shapes" overflow.
const MOOD_CHIP_LIMIT = 6;

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

function aboveImdbBadge(m) {
  if (typeof m.seriesRating !== 'number') return null;
  if (m.avgRating <= m.seriesRating) return null;
  const badge = document.createElement('span');
  badge.className = 'above-imdb';
  badge.textContent = '↑';
  badge.title =
    `Episodes average ${m.avgRating.toFixed(1)} - higher than the show's IMDb rating of ${m.seriesRating.toFixed(1)}`;
  return badge;
}

// --- card builder (grid view) ---

// --- row builder (list view) ---

// Compare lives on the show-modal, not on each card — so toggling it has
// to reach back into the grid/list and update every card/row matching
// that seriesId (a show may be visible as multiple seasons).
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
  else drawMiniAxisLabels(svg, ratings, padY, W, H);

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

// Add lightweight shape-specific annotations to the modal episode-rating SVG.
// Only fires for shapes that actually match the season.
function drawCurveAnnotations(svg, episodes, shapes) {
  const NS = 'http://www.w3.org/2000/svg';
  let group = svg.querySelector('.curve-annotations');
  if (group) group.remove();
  if (!shapes || !shapes.length) return;

  group = document.createElementNS(NS, 'g');
  group.setAttribute('class', 'curve-annotations');
  svg.appendChild(group);

  const W = 600, H = 180;
  const padXLeft = 36, padXRight = 4, padY = 6;
  const n = episodes.length;
  if (n < 2) return;
  const ratings = episodes.map((e) => e.rating);
  const lo = Math.max(0, Math.min(...ratings) - 0.3);
  const hi = Math.min(10, Math.max(...ratings) + 0.3);
  const span = Math.max(0.1, hi - lo);
  const xStep = (W - padXLeft - padXRight) / (n - 1);

  function px(i) {
    return padXLeft + i * xStep;
  }
  function py(r) {
    return padY + (1 - (r - lo) / span) * (H - padY * 2);
  }

  function addLabel(x, y, text, anchor = 'auto') {
    // Auto-pick anchor so labels never spill past the chart bounds. Because
    // the SVG uses preserveAspectRatio="none", glyphs render at native pixel
    // size while x stretches non-uniformly — at the rightmost data point a
    // middle-anchored label would extend past the right edge and get clipped.
    if (anchor === 'auto') {
      const usableLeft = padXLeft;
      const usableRight = W - padXRight;
      const usable = usableRight - usableLeft;
      if (x < usableLeft + usable * 0.18) anchor = 'start';
      else if (x > usableLeft + usable * 0.82) anchor = 'end';
      else anchor = 'middle';
    }
    // Keep the label within the vertical plot area too — at a top/bottom
    // extreme the caller's y offset can land outside the SVG.
    const yClamped = Math.max(padY + 8, Math.min(H - padY - 2, y));
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x.toFixed(1));
    t.setAttribute('y', yClamped.toFixed(1));
    t.setAttribute('text-anchor', anchor);
    t.setAttribute('class', 'curve-annotation-label');
    t.textContent = text;
    group.appendChild(t);
  }

  function addArrow(x1, y1, x2, y2) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x1.toFixed(1));
    line.setAttribute('y1', y1.toFixed(1));
    line.setAttribute('x2', x2.toFixed(1));
    line.setAttribute('y2', y2.toFixed(1));
    line.setAttribute('class', 'curve-annotation-arrow');
    line.setAttribute('marker-end', 'url(#ann-arrow)');
    group.appendChild(line);
  }

  // Arrow marker definition (shared)
  if (!svg.querySelector('#ann-arrow')) {
    const defs = document.createElementNS(NS, 'defs');
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'ann-arrow');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('refX', '5');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M0,0 L0,6 L6,3 Z');
    path.setAttribute('class', 'curve-annotation-arrowhead');
    marker.appendChild(path);
    defs.appendChild(marker);
    svg.insertBefore(defs, svg.firstChild);
  }

  const finaleIdx = n - 1;
  const finaleX = px(finaleIdx);
  const finaleY = py(ratings[finaleIdx]);

  if (shapes.includes('big-finale')) {
    addArrow(finaleX, finaleY - 22, finaleX, finaleY - 10);
    addLabel(finaleX, finaleY - 26, 'Peak finale');
  }

  if (shapes.includes('bad-finale')) {
    addArrow(finaleX, finaleY + 22, finaleX, finaleY + 10);
    addLabel(finaleX, finaleY + 30, 'Weakest finale');
  }

  if (shapes.includes('rebound')) {
    let minIdx = 1, minR = Infinity;
    for (let i = 1; i < n - 1; i++) {
      if (ratings[i] < minR) { minR = ratings[i]; minIdx = i; }
    }
    const dipX = px(minIdx);
    const dipY = py(minR);
    addArrow(dipX, dipY + 18, dipX, dipY + 8);
    addLabel(dipX, dipY + 24, 'Dip');
  }

  if (shapes.includes('slow-burn')) {
    const mid = Math.floor(n / 2);
    const midX = px(mid);
    const braceY = H - padY + 12;
    const lineR = document.createElementNS(NS, 'line');
    lineR.setAttribute('x1', midX.toFixed(1));
    lineR.setAttribute('y1', (braceY).toFixed(1));
    lineR.setAttribute('x2', px(finaleIdx).toFixed(1));
    lineR.setAttribute('y2', (braceY).toFixed(1));
    lineR.setAttribute('class', 'curve-annotation-bracket');
    group.appendChild(lineR);
    addLabel((midX + px(finaleIdx)) / 2, braceY + 12, 'Lifts off');
  }

  if (shapes.includes('mid-peak')) {
    let maxIdx = 0, maxR = -Infinity;
    for (let i = 0; i < n; i++) {
      if (ratings[i] > maxR) { maxR = ratings[i]; maxIdx = i; }
    }
    const pkX = px(maxIdx);
    const pkY = py(maxR);
    addArrow(pkX, pkY - 22, pkX, pkY - 10);
    addLabel(pkX, pkY - 26, 'Mid-peak');
  }
}

// Lightweight min/max labels for non-axis sparklines (card + row + show-modal
// per-season sparks). Skipped when the rating range is too narrow for labels
// to be informative — flat curves don't benefit from "8.0 / 8.1".
//
// Rendered as HTML spans on a sibling overlay rather than SVG <text> nodes:
// the parent SVG uses preserveAspectRatio="none" so the X and Y scales
// differ on mobile, which would stretch inline <text> into the distorted
// "huge wide digits over the chart" look the legacy implementation had.
// HTML labels stay at exactly the CSS font-size on every viewport.
function drawMiniAxisLabels(svg, ratings, padY, W, H) {
  const wrap = svg.parentElement && svg.parentElement.classList.contains('curve-wrap')
    ? svg.parentElement
    : null;
  if (!wrap) return; // older render paths without a wrapper — skip silently
  let overlay = wrap.querySelector(':scope > .spark-axis-labels');
  if (overlay) overlay.remove();
  if (!ratings || ratings.length === 0) return;
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  if (max - min < 0.3) return;

  // Place each label at the actual y of its value on the curve. drawCurve
  // pads the Y range (lo = min - 0.3, hi = max + 0.3) so the line doesn't
  // touch the chart edges; positioning labels at the wrap's edges left a
  // visible gap between "7.5" and where 7.5 actually lives on the curve.
  const lo = Math.max(0, min - 0.3);
  const hi = Math.min(10, max + 0.3);
  const span = Math.max(0.1, hi - lo);
  const yMaxPct = ((padY + (1 - (max - lo) / span) * (H - 2 * padY)) / H) * 100;
  const yMinPct = ((padY + (1 - (min - lo) / span) * (H - 2 * padY)) / H) * 100;

  overlay = document.createElement('div');
  overlay.className = 'spark-axis-labels';
  overlay.setAttribute('aria-hidden', 'true');
  const top = document.createElement('span');
  top.className = 'spark-axis-label spark-axis-label-top';
  top.textContent = max.toFixed(1);
  top.style.top = `${yMaxPct.toFixed(2)}%`;
  const bot = document.createElement('span');
  bot.className = 'spark-axis-label spark-axis-label-bot';
  bot.textContent = min.toFixed(1);
  bot.style.top = `${yMinPct.toFixed(2)}%`;
  overlay.append(top, bot);
  wrap.appendChild(overlay);
}

// Attach mousemove / touchmove to the modal curve SVG and show a floating
// label for the nearest episode dot. Cleans up the previous handler on
// each openModal call so there's no accumulation across re-opens.
let _curveHoverCleanup = null;
function bindModalCurveHover(svg, episodes) {
  if (_curveHoverCleanup) { _curveHoverCleanup(); _curveHoverCleanup = null; }

  let tip = svg.parentElement && svg.parentElement.querySelector('.curve-hover-tip');
  if (!tip) {
    const wrap = svg.closest('.curve-with-axis') || svg.parentElement;
    tip = document.createElement('div');
    tip.className = 'curve-hover-tip';
    tip.hidden = true;
    if (wrap) wrap.style.position = 'relative';
    (wrap || svg.parentElement).appendChild(tip);
  }

  const dots = [...(svg.querySelector('.curve-dots')?.children || [])];
  let activeIdx = -1;

  function setActiveDot(idx) {
    if (activeIdx >= 0 && activeIdx < dots.length) {
      dots[activeIdx].classList.remove('is-active');
    }
    activeIdx = idx;
    if (idx >= 0 && idx < dots.length) {
      dots[idx].classList.add('is-active');
    }
  }

  function getNearestEpIndex(svgX, svgW) {
    if (dots.length === 0) return -1;
    const fracX = (svgX - 36) / (svgW - 36 - 4);
    const idx = Math.round(fracX * (dots.length - 1));
    return Math.max(0, Math.min(dots.length - 1, idx));
  }

  function showTipForIdx(idx) {
    if (idx < 0 || idx >= dots.length) return;
    const rect = svg.getBoundingClientRect();
    const svgW = parseFloat(svg.getAttribute('viewBox').split(' ')[2]) || 600;
    const svgH = parseFloat(svg.getAttribute('viewBox').split(' ')[3]) || 180;
    const ep = episodes[idx];
    const epLabel = ep.episode === 0 ? 'Ep 0' : `Ep ${ep.episode}`;
    const namePart = ep.name ? ` · ${ep.name}` : '';
    const votesPart = ep.votes ? `  ${ep.votes.toLocaleString()} votes` : '';
    tip.textContent = `${epLabel}${namePart}  ${ep.rating.toFixed(1)}★${votesPart}`;
    tip.hidden = false;
    setActiveDot(idx);

    const dotEl = dots[idx];
    const dotCx = parseFloat(dotEl.getAttribute('cx'));
    const dotCy = parseFloat(dotEl.getAttribute('cy'));
    const pxX = (dotCx / svgW) * rect.width;
    const pxY = (dotCy / svgH) * rect.height;
    const tipW = 200;
    const left = Math.min(Math.max(0, pxX - tipW / 2), rect.width - tipW);
    const top = pxY - 44;
    tip.style.left = `${left}px`;
    tip.style.top = `${top < 0 ? pxY + 8 : top}px`;
  }

  function showTip(e) {
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const relX = clientX - rect.left;
    const svgW = parseFloat(svg.getAttribute('viewBox').split(' ')[2]) || 600;
    const scaleX = svgW / rect.width;
    const svgX = relX * scaleX;
    const idx = getNearestEpIndex(svgX, svgW);
    showTipForIdx(idx);
  }

  function hideTip() { tip.hidden = true; setActiveDot(-1); }

  function onKeyDown(e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = activeIdx < 0
        ? (e.key === 'ArrowRight' ? 0 : dots.length - 1)
        : Math.max(0, Math.min(dots.length - 1, activeIdx + (e.key === 'ArrowRight' ? 1 : -1)));
      showTipForIdx(next);
    } else if (e.key === 'Home') {
      e.preventDefault();
      showTipForIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      showTipForIdx(dots.length - 1);
    }
  }

  svg.addEventListener('mousemove', showTip);
  svg.addEventListener('mouseleave', hideTip);
  svg.addEventListener('touchmove', showTip, { passive: true });
  svg.addEventListener('touchend', hideTip, { passive: true });
  svg.addEventListener('keydown', onKeyDown);
  svg.addEventListener('blur', hideTip);

  _curveHoverCleanup = () => {
    svg.removeEventListener('mousemove', showTip);
    svg.removeEventListener('mouseleave', hideTip);
    svg.removeEventListener('touchmove', showTip);
    svg.removeEventListener('touchend', hideTip);
    svg.removeEventListener('keydown', onKeyDown);
    svg.removeEventListener('blur', hideTip);
    setActiveDot(-1);
    tip.hidden = true;
  };
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
    path.dataset.season = s.season;
    const title = document.createElementNS(NS, 'title');
    title.textContent = `Season ${s.season} - avg ${s.avgRating.toFixed(1)}`;
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
    ? `Compare set is full (${COMPARE_LIMIT} max) - remove one first`
    : inSet ? 'Remove this show from the compare set' : 'Add this show to the compare set';
}

// Round a raw axis step up to a "nice" 1/2/5 × 10^n value so rating
// gridlines land on readable numbers (…0.5, 1, 2…) instead of arbitrary
// fractions.
function niceStep(rawStep) {
  if (!(rawStep > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}

// Trajectory chart: for each selected series, plot one line whose x is the
// actual season number (so S1..Sn line up across shows and the magnitude of
// each season-to-season change reads honestly) and y is that season's avg
// rating. The SVG (preserveAspectRatio="none") carries only vector geometry —
// gridlines, axis lines, area fills, the trend lines — while crisp dots and
// all text live in an HTML overlay positioned by percent, so nothing is
// stretched and labels stay at their CSS size on every viewport.
function drawCompareChart(svg, seriesEntries, W, H) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const host = svg.parentElement;
  if (host) {
    const old = host.querySelector(':scope > .compare-overlay');
    if (old) old.remove();
  }
  if (!seriesEntries.length) return;

  const NS = 'http://www.w3.org/2000/svg';
  // Plot margins (viewBox units): left holds rating labels, bottom holds
  // season labels, top leaves room for single-series value callouts.
  const mL = 40, mR = 16, mT = 18, mB = 30;
  const x0 = mL, x1 = W - mR, y0 = mT, y1 = H - mB;
  const plotW = x1 - x0, plotH = y1 - y0;

  // --- domains -------------------------------------------------------------
  let lo = Infinity, hi = -Infinity, maxSeason = 1;
  for (const { seasons } of seriesEntries) {
    for (const s of seasons) {
      if (s.avgRating < lo) lo = s.avgRating;
      if (s.avgRating > hi) hi = s.avgRating;
      if (s.season > maxSeason) maxSeason = s.season;
    }
  }
  // Snap the rating domain to half-points and guarantee at least a 1.0 span
  // so a tight cluster of seasons still gets readable gridlines.
  lo = Math.max(0, Math.floor((lo - 0.4) * 2) / 2);
  hi = Math.min(10, Math.ceil((hi + 0.4) * 2) / 2);
  if (hi - lo < 1) hi = Math.min(10, lo + 1);
  const span = Math.max(0.1, hi - lo);

  const xMin = 1, xMax = Math.max(2, maxSeason);
  const xPx = (season) => x0 + (xMax === xMin ? plotW / 2 : (season - xMin) / (xMax - xMin) * plotW);
  const yPx = (r) => y0 + (1 - (r - lo) / span) * plotH;

  const overlay = document.createElement('div');
  overlay.className = 'compare-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const xPct = (px) => (px / W * 100).toFixed(3);
  const yPct = (py) => (py / H * 100).toFixed(3);

  const mkLine = (xa, ya, xb, yb, cls) => {
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', xa.toFixed(1)); ln.setAttribute('y1', ya.toFixed(1));
    ln.setAttribute('x2', xb.toFixed(1)); ln.setAttribute('y2', yb.toFixed(1));
    ln.setAttribute('class', cls);
    ln.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(ln);
  };
  const mkLabel = (cls, left, top, text) => {
    const el = document.createElement('span');
    el.className = cls;
    el.style.left = `${left}%`;
    el.style.top = `${top}%`;
    el.textContent = text;
    overlay.appendChild(el);
  };

  // --- Y gridlines + rating labels ----------------------------------------
  const yStep = niceStep((hi - lo) / 4);
  const fmtRating = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1));
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi + 1e-6; v += yStep) {
    const y = yPx(v);
    mkLine(x0, y, x1, y, 'compare-grid');
    mkLabel('compare-axis-label compare-axis-y', xPct(x0 - 8), yPct(y), fmtRating(v));
  }

  // --- X gridlines + season labels ----------------------------------------
  const seasonSpan = xMax - xMin + 1;
  const xStep = Math.max(1, Math.ceil(seasonSpan / 12));
  const seasonTicks = [];
  for (let s = xMin; s <= xMax; s += xStep) seasonTicks.push(s);
  if (seasonTicks[seasonTicks.length - 1] !== xMax) seasonTicks.push(xMax);
  for (const s of seasonTicks) {
    const x = xPx(s);
    mkLine(x, y0, x, y1, 'compare-grid compare-grid-v');
    mkLabel('compare-axis-label compare-axis-x', xPct(x), yPct(y1 + 9), `S${s}`);
  }

  // --- axis lines ----------------------------------------------------------
  mkLine(x0, y0, x0, y1, 'compare-axis-line');
  mkLine(x0, y1, x1, y1, 'compare-axis-line');

  // --- series --------------------------------------------------------------
  const single = seriesEntries.length === 1;
  seriesEntries.forEach(({ title, seasons }, idx) => {
    const color = seasonColor(idx, seriesEntries.length);
    const pts = seasons.map((s) => [xPx(s.season), yPx(s.avgRating), s]);

    // Soft area fill under a lone series so the trajectory (and its final-
    // season cliff) reads as a deliberate shape rather than a stray line.
    if (single && pts.length > 1) {
      const grad = document.createElementNS(NS, 'linearGradient');
      const gid = 'compareFill';
      grad.setAttribute('id', gid);
      grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
      grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
      const stops = [['0%', 0.28], ['100%', 0.02]];
      for (const [off, op] of stops) {
        const st = document.createElementNS(NS, 'stop');
        st.setAttribute('offset', off);
        st.setAttribute('stop-color', color);
        st.setAttribute('stop-opacity', String(op));
        grad.appendChild(st);
      }
      svg.appendChild(grad);
      const area = document.createElementNS(NS, 'path');
      const dArea = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
        + ` L${pts[pts.length - 1][0].toFixed(1)},${y1.toFixed(1)} L${pts[0][0].toFixed(1)},${y1.toFixed(1)} Z`;
      area.setAttribute('d', dArea);
      area.setAttribute('fill', `url(#${gid})`);
      area.setAttribute('stroke', 'none');
      svg.appendChild(area);
    }

    const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    const ttl = document.createElementNS(NS, 'title');
    ttl.textContent = title;
    path.appendChild(ttl);
    svg.appendChild(path);

    // Crisp HTML dots (round on every viewport) + per-point tooltip.
    pts.forEach(([x, y, s], i) => {
      const dot = document.createElement('span');
      dot.className = 'compare-dot';
      dot.style.left = `${xPct(x)}%`;
      dot.style.top = `${yPct(y)}%`;
      dot.style.background = color;
      dot.title = `${title} — S${s.season}: avg ${s.avgRating.toFixed(1)}`;
      overlay.appendChild(dot);
      // For a lone series, call out each season's value above its dot.
      if (single) {
        const above = y - mT * 0.55 > y0;
        mkLabel(
          `compare-val-label${above ? '' : ' compare-val-label-below'}`,
          xPct(x),
          yPct(above ? y - 11 : y + 11),
          s.avgRating.toFixed(1),
        );
        const last = overlay.lastChild;
        if (last) last.style.color = color;
      }
    });
  });

  if (host) host.appendChild(overlay);
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
    item.title = `Remove ${e.title} from compare`;
    item.setAttribute('aria-label', `Remove ${e.title} from comparison`);
    const swatch = document.createElement('span');
    swatch.className = 'overlay-legend-swatch';
    swatch.style.background = colors[i];
    const label = document.createElement('span');
    label.className = 'compare-legend-name';
    label.textContent = e.title;
    const x = document.createElement('span');
    x.className = 'compare-legend-x';
    x.setAttribute('aria-hidden', 'true');
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
  drawCompareChart(els.compareModalCurve, entries, 600, 260);
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
    const panel = els.compareModal.querySelector('.modal-panel');
    if (panel) panel.focus();
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

// --- In-app modal view history ------------------------------------------
// Drilling through "More seasons/shows like this", season rows, or "View
// show" stacks up views; the "← Back" button in both modals pops the stack.
// Kept in-app (not history.pushState) so it composes with the existing
// replaceState-based filter/URL sync instead of fighting it. The stack
// clears when the user actually closes a modal (×, backdrop, Esc) — not on
// the internal close that happens when one modal chains into another.

const modalViewHistory = [];

function currentModalView() {
  if (!els.modal.hidden && modalState.season) {
    return { type: 'season', season: modalState.season };
  }
  if (!els.showModal.hidden && showModalState.seriesId) {
    return { type: 'show', seriesId: showModalState.seriesId };
  }
  return null;
}

function modalViewKey(view) {
  return view.type === 'season'
    ? `season:${view.season.seriesId}:${view.season.season}`
    : `show:${view.seriesId}`;
}

// Record the CURRENT view before a new one replaces it. No-ops when the
// navigation came from the Back button itself, when no modal is open
// (fresh open from the result list), or when the "new" view is the one
// already showing (e.g. a reroll landing on the same season).
function pushModalHistory(opts, nextKey) {
  if (opts.fromHistory) return;
  const prev = currentModalView();
  if (!prev || modalViewKey(prev) === nextKey) return;
  modalViewHistory.push(prev);
  // Safety cap — nobody steps back through more than this anyway.
  if (modalViewHistory.length > 50) modalViewHistory.shift();
  syncModalBackButtons();
}

function clearModalHistory() {
  modalViewHistory.length = 0;
  syncModalBackButtons();
}

function syncModalBackButtons() {
  const show = modalViewHistory.length > 0;
  if (els.modalBack) els.modalBack.hidden = !show;
  if (els.showModalBack) els.showModalBack.hidden = !show;
}

function goBackModalView() {
  const prev = modalViewHistory.pop();
  if (!prev) return;
  if (prev.type === 'season') openModal(prev.season, { fromHistory: true });
  else openShowModal(prev.seriesId, { fromHistory: true });
  syncModalBackButtons();
}

function openModal(m, opts = {}) {
  pushModalHistory(opts, `season:${m.seriesId}:${m.season}`);
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
  // Carry the surprise mode forward so the in-modal Reroll button can
  // re-pick from the same pool the user originally chose.
  modalState.surprise = opts.surprise === true ? 'any' :
                        (opts.surprise === 'any' || opts.surprise === 'popular' ? opts.surprise : false);
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

  // Prefer the per-season overview when TMDB has one — it usually frames
  // *this* season's arc rather than restating the pilot premise. Falls
  // back to the series overview for unenriched seasons or shows where
  // TMDB only has show-level text.
  els.modalOverview.textContent = m.seasonOverview || m.overview || '';

  let driftNoteEl = els.modal.querySelector('.modal-drift-note');
  if (m.driftNote) {
    if (!driftNoteEl) {
      driftNoteEl = document.createElement('p');
      driftNoteEl.className = 'modal-drift-note';
      els.modalOverview.insertAdjacentElement('afterend', driftNoteEl);
    }
    driftNoteEl.textContent = `⇌ ${m.driftNote}`;
    driftNoteEl.hidden = false;
  } else if (driftNoteEl) {
    driftNoteEl.hidden = true;
  }

  els.modalPoster.replaceChildren();
  els.modalPoster.classList.remove('poster-sensitive', 'revealed');
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
  markSensitivePoster(els.modalPoster, m);

  drawCurve(els.modalCurve, m.episodes, 600, 180, { showAxis: true });
  drawCurveAnnotations(els.modalCurve, m.episodes, m.shapes);
  bindModalCurveHover(els.modalCurve, m.episodes);
  renderShapeAnnotationText(m);

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

    // When we have an IMDb episode ID, overlay a stretched link so the
    // entire row deep-links to the episode's IMDb page. Older data.json
    // builds without per-episode tt fall back to a non-clickable row.
    if (e.tt) {
      li.classList.add('has-link');
      const link = document.createElement('a');
      link.className = 'ep-link';
      link.href = `https://www.imdb.com/title/${e.tt}/`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('aria-label', `Open ${num.textContent}${e.name ? ' - ' + e.name : ''} on IMDb`);
      li.appendChild(link);
    }

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

  els.modal.hidden = false;
  els.modal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  const modalPanel = els.modal.querySelector('.modal-panel');
  if (modalPanel) modalPanel.scrollTop = 0;
  syncModalInert();
  writeFinderStateToURL();
  if (!wasOpen) {
    requestAnimationFrame(() => {
      if (modalPanel) modalPanel.focus();
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
  // A real close (×, backdrop, Esc) ends the drill-down session; an
  // internal close chaining into another modal keeps the trail alive.
  if (!opts.suppressReopen && els.showModal.hidden) clearModalHistory();
  modalState.season = null;
  modalState.lastFocus = null;
  modalState.surprise = false;
  modalState.fromChangelog = false;
  writeFinderStateToURL();
  if (reopenChangelog) openChangelogModal();
}

function openShowModal(seriesId, opts = {}) {
  const seasons = dataset.matches
    .filter((m) => m.seriesId === seriesId)
    .sort((a, b) => a.season - b.season);
  if (seasons.length === 0) return;

  pushModalHistory(opts, `show:${seriesId}`);
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
  syncShowModalWatchOnLink(meta);

  els.showModalOverview.textContent = meta.overview || '';

  // Cast strip — populated from data.json by the TMDB enrichment.
  // Section stays hidden when the series has no cast field.
  renderShowModalCast(meta.cast);

  els.showModalPoster.replaceChildren();
  els.showModalPoster.classList.remove('poster-sensitive', 'revealed');
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
  markSensitivePoster(els.showModalPoster, meta);

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
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'overlay-legend-item overlay-legend-toggle';
      item.setAttribute('aria-pressed', 'true');
      item.title = `Toggle Season ${season} line`;
      // Expose the line color to CSS so the chip's filled active state and
      // swatch glow can derive from the same hue as the chart line.
      item.style.setProperty('--season-color', color);
      const swatch = document.createElement('span');
      swatch.className = 'overlay-legend-swatch';
      swatch.style.background = color;
      const label = document.createElement('span');
      label.textContent = `S${season}`;
      item.append(swatch, label);
      item.addEventListener('click', () => {
        const visible = item.getAttribute('aria-pressed') === 'true';
        const nowVisible = !visible;
        item.setAttribute('aria-pressed', String(nowVisible));
        item.classList.toggle('overlay-legend-toggle--off', !nowVisible);
        const path = els.showModalOverlayCurve.querySelector(`[data-season="${season}"]`);
        if (path) path.classList.toggle('overlay-season-hidden', !nowVisible);
      });
      legendFrag.appendChild(item);
    }
    els.showModalOverlayLegend.replaceChildren(legendFrag);
  } else {
    els.showModalOverlay.hidden = true;
  }

  els.showModalImdb.href = `https://www.imdb.com/title/${seriesId}/`;
  if (els.showModalPermalink) {
    els.showModalPermalink.href = `/apps/rising-shows/shows/${showSlug(meta.title)}-${seriesId}/`;
  }
  if (meta.tvdbId) {
    els.showModalTvdb.href = `https://thetvdb.com/dereferrer/series/${meta.tvdbId}`;
    els.showModalTvdb.hidden = false;
  } else {
    els.showModalTvdb.removeAttribute('href');
    els.showModalTvdb.hidden = true;
  }

  renderShowRelated(seriesId);

  els.showModal.hidden = false;
  els.showModal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  const showModalPanel = els.showModal.querySelector('.modal-panel');
  if (showModalPanel) showModalPanel.scrollTop = 0;
  syncModalInert();
  writeFinderStateToURL();
  requestAnimationFrame(() => {
    if (showModalPanel) showModalPanel.focus();
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
      tag.className = 'shape-tag';
      tag.textContent = SHAPE_LABELS[s] || s;
      shapeRow.appendChild(tag);
    }
    meta.appendChild(shapeRow);
  }

  // Wrap the SVG so HTML min/max labels can overlay it without going
  // through the SVG's preserveAspectRatio="none" stretch (which distorts
  // inline <text> on narrow mobile widths).
  const sparkWrap = document.createElement('div');
  sparkWrap.className = 'curve-wrap ss-spark-wrap';
  const sparkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sparkSvg.setAttribute('class', 'ss-spark curve');
  sparkSvg.setAttribute('viewBox', '0 0 200 36');
  sparkSvg.setAttribute('preserveAspectRatio', 'none');
  for (const cls of ['curve-area', 'curve-line']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', cls);
    sparkSvg.appendChild(path);
  }
  sparkWrap.appendChild(sparkSvg);
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

  li.append(num, meta, sparkWrap, stats);
  li.addEventListener('click', () => openModal(m));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(m);
    }
  });
  return li;
}

// TASK D: Render "More shows like this" in the show modal.
// Shows first 4 immediately; extra rows (up to 6 more) behind a toggle.
function renderShowRelated(seriesId) {
  const container = document.getElementById('showModalRelated');
  if (!container) return;
  if (!dataset) { container.hidden = true; return; }
  const related = computeShowRelated(seriesId, dataset.matches);
  if (related.length < 1) { container.hidden = true; return; }
  container.hidden = false;

  const grid = container.querySelector('.show-related-grid') || container;
  const visible = related.slice(0, 4);
  const extra = related.slice(4);

  const frag = document.createDocumentFragment();
  for (const r of visible) {
    frag.appendChild(buildShowRelatedRow(r, null));
  }
  for (const r of extra) {
    frag.appendChild(buildShowRelatedRow(r, 'show-related-row-extra'));
  }
  grid.replaceChildren(frag);
  grid.classList.remove('show-related-extra-expanded');

  const existingToggle = container.querySelector('.related-more-toggle');
  if (existingToggle) existingToggle.remove();

  if (extra.length > 0) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost related-more-toggle';
    toggle.textContent = `${extra.length} more`;
    toggle.addEventListener('click', () => {
      const expanded = grid.classList.toggle('show-related-extra-expanded');
      toggle.textContent = expanded ? 'Show less' : `${extra.length} more`;
    });
    container.appendChild(toggle);
  }
}

function buildShowRelatedRow(r, extraClass) {
  const row = document.createElement('div');
  row.className = 'show-related-row' + (extraClass ? ' ' + extraClass : '');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `${r.title}`);

  const posterEl = document.createElement('div');
  posterEl.className = 'related-poster';
  if (r.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w92${r.poster}`;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 40;
    img.height = 60;
    posterEl.appendChild(img);
  } else {
    posterEl.classList.add('related-poster-fallback');
    posterEl.style.setProperty('--poster-hue', String(hashHue(r.title)));
    const init = document.createElement('span');
    init.textContent = posterInitial(r.title);
    posterEl.appendChild(init);
  }
  markSensitivePoster(posterEl, r);

  const info = document.createElement('div');
  info.className = 'show-related-info';
  const title = document.createElement('span');
  title.className = 'show-related-title';
  title.textContent = r.title;
  const yearVal = r.year || '';
  const imdbPart = typeof r.seriesRating === 'number' ? `IMDb ${r.seriesRating.toFixed(1)}` : '';
  const avgPart = typeof r._avg === 'number' ? `avg ep ${r._avg.toFixed(1)}` : '';
  const metaParts = [imdbPart, avgPart, yearVal].filter(Boolean);
  const meta = document.createElement('span');
  meta.className = 'show-related-meta';
  meta.textContent = metaParts.join(' · ');
  info.append(title, meta);

  row.append(posterEl, info);
  row.addEventListener('click', () => openShowModal(r.seriesId));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openShowModal(r.seriesId); }
  });
  return row;
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
  // Same rule as closeModal: only a real close ends the drill-down trail.
  if (!opts.suppressReopen && els.modal.hidden) clearModalHistory();
  showModalState.seriesId = null;
  showModalState.lastFocus = null;
  showModalState.fromChangelog = false;
  writeFinderStateToURL();
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
    // The sitewide back-to-top button is a body child too, but while a modal
    // is open it acts as that modal's own scroll-to-top control, so it must
    // stay interactive and Tab-reachable instead of going inert.
    if (node.classList.contains('back-to-top')) continue;
    if (openModal && node !== openModal) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
  }
}

// --- view toggle (grid/list) ---

// --- Show Finder ---

// Compact vote formatting: 721000 -> "721k", 2620000 -> "2.6M".
function formatCompactVotes(n) {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(n);
}

// Group season-matches by seriesId into one row per show. Computed once after
// data.json loads (memoized in showAgg) so live filtering never re-aggregates.
// The aggregation itself lives in finder-lib.js - shared with the Node export
// pipeline (scripts/export-integrations.js) so Finder presets exported to
// Kometa are built from exactly the rows this view shows. `detectShapes` comes
// from match.js, loaded before this script; guard so a missing global never
// breaks the finder.
function buildShowAgg() {
  return RisingShowsFinder.buildShowAgg(
    dataset.matches,
    typeof detectShapes === 'function' ? detectShapes : null,
  );
}

// Genre tri-state chips mirror the Seasons quick-genre row: click once to
// require, again to exclude (rendered RED via [data-exclude]), again to clear.
function renderFinderGenres() {
  const seen = new Set();
  for (const s of showAgg) for (const g of s.genres) seen.add(g);
  const genres = [...seen].sort();
  const frag = document.createDocumentFragment();
  for (const g of genres) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-chip';
    btn.dataset.genre = g;
    btn.textContent = g;
    syncFinderGenreChipTriState(btn);
    frag.appendChild(btn);
  }
  els.finderGenres.replaceChildren(frag);
}

function syncFinderGenreChipTriState(btn) {
  const name = btn.dataset.genre;
  if (finderState.genresExclude.has(name)) {
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.exclude = 'true';
    btn.title = `Excluded - click to clear (currently hiding ${name})`;
  } else if (finderState.genres.has(name)) {
    btn.setAttribute('aria-pressed', 'true');
    btn.dataset.exclude = 'false';
    btn.title = `Required - click again to exclude ${name}`;
  } else {
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.exclude = 'false';
    btn.title = `Click to require ${name}; click again to exclude it`;
  }
}

function cycleFinderGenreState(name) {
  if (!finderState.genres.has(name) && !finderState.genresExclude.has(name)) {
    finderState.genres.add(name);
  } else if (finderState.genres.has(name)) {
    finderState.genres.delete(name);
    finderState.genresExclude.add(name);
  } else {
    finderState.genresExclude.delete(name);
  }
}

// ---- Finder: show-level shape chips ----

// Core shapes detectShapes() can emit, in display order. (saved-best-for-last
// and shape-drift are season-level tags, never produced by detectShapes, so
// they don't apply at the whole-show level and are intentionally omitted.)
const FINDER_SHAPE_ORDER = [
  'rising', 'consistent', 'slow-burn', 'big-finale', 'rebound',
  'front-loaded', 'declining', 'bad-finale', 'rollercoaster', 'mid-peak', 'u-shaped',
];

const FINDER_SHAPE_ICONS = {
  rising: '↗', consistent: '═', 'slow-burn': '⤴', 'big-finale': '⇧', rebound: '∪',
  'front-loaded': '↘', declining: '↘↘', 'bad-finale': '⇩', rollercoaster: '∿',
  'mid-peak': '∩', 'u-shaped': '⌣',
};

// Whole-show wording for each shape (the Seasons descriptions are per-episode;
// at the show level every data point is one season's average).
const FINDER_SHAPE_DESCS = {
  rising: 'Each season at least as good as the last',
  consistent: 'Great across every season, no weak one',
  'slow-burn': 'Later seasons lift off',
  'big-finale': 'The final season is the peak',
  rebound: 'Dips, then comes back stronger',
  'front-loaded': 'Strong early seasons, weaker later',
  declining: 'Each season no better than the last',
  'bad-finale': 'The final season is the worst',
  rollercoaster: 'Big swings from season to season',
  'mid-peak': 'Peaks mid-run, falls after',
  'u-shaped': 'Strong first and last seasons, a sag between',
};

function finderShapeCounts(rows) {
  const counts = {};
  for (const s of rows) for (const sh of s.shapes) counts[sh] = (counts[sh] || 0) + 1;
  return counts;
}

// Build the show-shape chip row once: an "All" chip plus every shape that
// occurs anywhere in the catalogue. Per-filter counts and pressed-state are
// applied by syncFinderShapeChips so chips don't churn on every keystroke.
function renderFinderShapes() {
  if (!els.finderShapes || !showAgg) return;
  const universe = finderShapeCounts(showAgg);
  const frag = document.createDocumentFragment();
  frag.appendChild(makeFinderShapeChip('all', 'All', null));
  for (const sh of FINDER_SHAPE_ORDER) {
    if (!universe[sh]) continue;
    frag.appendChild(makeFinderShapeChip(sh, SHAPE_LABELS[sh] || sh, FINDER_SHAPE_ICONS[sh]));
  }
  els.finderShapes.replaceChildren(frag);
  syncFinderShapeChips();
}

function makeFinderShapeChip(shape, name, icon) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'shape-chip';
  btn.dataset.shape = shape;
  if (shape !== 'all') btn.title = FINDER_SHAPE_DESCS[shape] || '';
  if (icon) {
    const i = document.createElement('span');
    i.className = 'shape-icon';
    i.setAttribute('aria-hidden', 'true');
    i.textContent = icon;
    btn.appendChild(i);
  }
  const nm = document.createElement('span');
  nm.className = 'shape-name';
  nm.textContent = name;
  btn.appendChild(nm);
  const c = document.createElement('span');
  c.className = 'shape-count';
  btn.appendChild(c);
  return btn;
}

// Refresh pressed-state + live counts. Counts mirror the Seasons view so they
// update as shapes are picked:
//   - "All"          = result set with no shape filter (clear-shapes count).
//   - active shape   = the current result total (every result already has it).
//   - inactive shape = how many current results ALSO carry it — i.e. what
//                      you'd get by adding it on top of the current selection.
// An inactive shape that would drop results to zero is disabled (greyed), not
// hidden, so the row stays stable as you select.
function syncFinderShapeChips() {
  if (!els.finderShapes) return;
  const base = finderRowsBeforeShape();
  const current = base.filter((s) => passesShapeAnd(s, finderState.shapes));
  const counts = finderShapeCounts(current);
  for (const btn of els.finderShapes.querySelectorAll('.shape-chip')) {
    const shape = btn.dataset.shape;
    const isAll = shape === 'all';
    const selected = isAll ? finderState.shapes.size === 0 : finderState.shapes.has(shape);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');

    let n;
    if (isAll) n = base.length;
    else if (finderState.shapes.has(shape)) n = current.length;
    else n = counts[shape] || 0;
    const c = btn.querySelector('.shape-count');
    if (c) c.textContent = n.toLocaleString();

    if (!isAll) {
      const disable = !finderState.shapes.has(shape) && n === 0;
      btn.disabled = disable;
      btn.classList.toggle('is-disabled', disable);
    }
  }
}

function toggleFinderShape(shape) {
  if (shape === 'all') {
    finderState.shapes.clear();
  } else if (finderState.shapes.has(shape)) {
    finderState.shapes.delete(shape);
  } else {
    finderState.shapes.add(shape);
  }
}

// ---- Finder: mood presets ----
// Fresh, whole-show-oriented presets (the Seasons moods are season-level and
// reference per-episode climb / mini-series, which don't map to show stats).
// Each preset is an absolute filter set: applying it replaces the current
// filters. A couple lean on the new show-level shapes (rising / rebound).
const FINDER_MOODS = [
  { id: 'modern-prestige', icon: '★', label: 'Modern prestige',
    desc: 'Recent shows critics and audiences both love',
    filters: { minYear: 2020, minAvgEpisode: 8.5, sort: 'avgEpisode' } },
  { id: 'crowd-favorites', icon: '◉', label: 'Crowd favorites',
    desc: 'Hugely popular and still highly rated',
    filters: { minVotes: 100000, minAvgEpisode: 8, sort: 'votes' } },
  { id: 'kept-climbing', icon: '↗', label: 'Kept climbing',
    desc: 'Each season topped the one before',
    filters: { shapes: ['rising'], minAvgEpisode: 7.5, sort: 'seasonsCount' } },
  { id: 'comeback-stories', icon: '∪', label: 'Comeback stories',
    desc: 'Dipped, then bounced back stronger',
    filters: { shapes: ['rebound'], sort: 'seasonsCount' } },
  { id: 'marathon-worthy', icon: '❯❯❯', label: 'Marathon-worthy',
    desc: 'Long shows that stay good throughout',
    filters: { minEpisodes: 60, minAvgEpisode: 7.5, sort: 'episodes' } },
  { id: 'outshines-reputation', icon: '⇈', label: 'Outshines its reputation',
    desc: 'Episodes rate higher than the show overall',
    filters: { gapDir: 'up', minAvgEpisode: 8, sort: 'gap' } },
];

// Canonical comparison of a filter set, defaults filled in, so a mood reads as
// "active" only when the live finder filters exactly equal its preset (and no
// stray search). Sets and arrays both normalise to sorted arrays.
function finderFilterSignature(src) {
  return JSON.stringify({
    search: (src.search || '').trim().toLowerCase(),
    minEpisodes: src.minEpisodes || 0,
    minVotes: src.minVotes || 0,
    minShowRating: src.minShowRating || 0,
    minAvgEpisode: src.minAvgEpisode || 0,
    gapDir: src.gapDir || 'any',
    minGap: src.minGap || 0,
    minYear: src.minYear ?? null,
    maxYear: src.maxYear ?? null,
    genres: [...(src.genres || [])].sort(),
    genresExclude: [...(src.genresExclude || [])].sort(),
    languages: [...(src.languages || [])].sort(),
    shapes: [...(src.shapes || [])].sort(),
    sort: src.sort || 'votes',
    sortDir: src.sortDir || 'desc',
  });
}

// How many shows a preset yields. Presets are absolute (clicking one replaces
// the current filters), so these counts are independent of the live filters
// and computed once at render. Covers exactly the fields the presets use.
function countShowsForFilters(ff) {
  const shapes = ff.shapes || [];
  let n = 0;
  for (const s of showAgg) {
    if (ff.minEpisodes && s.episodes < ff.minEpisodes) continue;
    if (ff.minVotes && s.votes < ff.minVotes) continue;
    if (ff.minShowRating && s.showRating < ff.minShowRating) continue;
    if (ff.minAvgEpisode && s.avgEpisode < ff.minAvgEpisode) continue;
    if (ff.gapDir === 'up' && s.gap <= 0) continue;
    if (ff.gapDir === 'down' && s.gap >= 0) continue;
    if (ff.minYear != null && (s.year == null || s.year < ff.minYear)) continue;
    if (ff.maxYear != null && (s.year == null || s.year > ff.maxYear)) continue;
    let ok = true;
    for (const sh of shapes) if (!s.shapes.includes(sh)) { ok = false; break; }
    if (ok) n++;
  }
  return n;
}

function renderFinderMoods() {
  if (!els.finderMoodChips || !showAgg) return;
  const frag = document.createDocumentFragment();
  for (const mood of FINDER_MOODS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mood-chip';
    btn.dataset.mood = mood.id;
    btn.title = mood.desc;
    btn.setAttribute('aria-pressed', 'false');
    const i = document.createElement('span');
    i.className = 'mood-chip-icon';
    i.setAttribute('aria-hidden', 'true');
    i.textContent = mood.icon;
    const l = document.createElement('span');
    l.className = 'mood-chip-label';
    l.textContent = mood.label;
    const c = document.createElement('span');
    c.className = 'mood-chip-count';
    c.textContent = countShowsForFilters(mood.filters).toLocaleString();
    btn.append(i, l, c);
    frag.appendChild(btn);
  }
  els.finderMoodChips.replaceChildren(frag);
  updateFinderMoodActive();
}

function updateFinderMoodActive() {
  if (!els.finderMoodChips) return;
  const current = finderFilterSignature(finderState);
  for (const btn of els.finderMoodChips.querySelectorAll('.mood-chip')) {
    const mood = FINDER_MOODS.find((m) => m.id === btn.dataset.mood);
    const active = !!mood && finderFilterSignature(mood.filters) === current;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// Apply a preset by resetting to defaults then overlaying the preset's filters.
// Does not render — the caller follows with onFinderFilterChange().
function applyFinderMood(mood) {
  resetFinderState();
  const ff = mood.filters;
  if (ff.minEpisodes) finderState.minEpisodes = ff.minEpisodes;
  if (ff.minVotes) finderState.minVotes = ff.minVotes;
  if (ff.minShowRating) finderState.minShowRating = ff.minShowRating;
  if (ff.minAvgEpisode) finderState.minAvgEpisode = ff.minAvgEpisode;
  if (ff.gapDir) finderState.gapDir = ff.gapDir;
  if (ff.minGap) finderState.minGap = ff.minGap;
  if (ff.minYear != null) finderState.minYear = ff.minYear;
  if (ff.maxYear != null) finderState.maxYear = ff.maxYear;
  if (ff.shapes) finderState.shapes = new Set(ff.shapes);
  if (ff.sort) finderState.sort = ff.sort;
  if (ff.sortDir) finderState.sortDir = ff.sortDir;
  syncFinderControls();
  syncFinderSortControls();
}

function renderFinderLanguages() {
  const top = (dataset.languages || []).slice(0, 12);
  const frag = document.createDocumentFragment();
  for (const l of top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-chip';
    btn.dataset.language = l.code;
    btn.setAttribute('aria-pressed', finderState.languages.has(l.code) ? 'true' : 'false');
    btn.textContent = languageLabel(l.code);
    btn.addEventListener('click', () => {
      if (finderState.languages.has(l.code)) finderState.languages.delete(l.code);
      else finderState.languages.add(l.code);
      btn.setAttribute('aria-pressed', finderState.languages.has(l.code) ? 'true' : 'false');
      onFinderFilterChange();
    });
    frag.appendChild(btn);
  }
  els.finderLanguages.replaceChildren(frag);
}

function finderActiveDecadeKey() {
  for (const [key, [min, max]] of Object.entries(DECADE_RANGES)) {
    if (finderState.minYear === min && finderState.maxYear === max) return key;
  }
  if (finderState.minYear == null && finderState.maxYear == null) return 'all';
  return null;
}

function syncFinderDecadeRowAria() {
  const row = els.finderDecadeRow;
  if (!row) return;
  const active = finderActiveDecadeKey();
  for (const btn of row.querySelectorAll('.label-chip')) {
    btn.setAttribute('aria-pressed', btn.dataset.decade === active ? 'true' : 'false');
  }
}

function renderFinderDecadeRow() {
  const row = els.finderDecadeRow;
  if (!row) return;
  const frag = document.createDocumentFragment();
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'label-chip';
  all.dataset.decade = 'all';
  all.textContent = 'All';
  all.addEventListener('click', () => {
    finderState.minYear = null;
    finderState.maxYear = null;
    els.finderMinYear.value = '';
    els.finderMaxYear.value = '';
    syncFinderDecadeRowAria();
    onFinderFilterChange();
  });
  frag.appendChild(all);
  for (const [key, [min, max]] of Object.entries(DECADE_RANGES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'label-chip';
    btn.dataset.decade = key;
    btn.textContent = key;
    btn.addEventListener('click', () => {
      finderState.minYear = min;
      finderState.maxYear = max;
      els.finderMinYear.value = String(min);
      els.finderMaxYear.value = String(max);
      syncFinderDecadeRowAria();
      onFinderFilterChange();
    });
    frag.appendChild(btn);
  }
  row.replaceChildren(frag);
  syncFinderDecadeRowAria();
}

const FINDER_COLUMNS = [
  { key: 'title', label: 'Show' },
  { key: 'showRating', label: 'Show rating' },
  { key: 'avgEpisode', label: 'Avg episode' },
  { key: 'gap', label: 'Gap' },
  { key: 'episodes', label: 'Episodes' },
  { key: 'seasonsCount', label: 'Seasons' },
  { key: 'year', label: 'Year' },
  { key: 'votes', label: 'Votes' },
  { key: 'runtimeHrs', label: 'Runtime' },
];

// Rows passing every finder filter EXCEPT the shape filter. Kept separate so
// the shape chips can show live counts (how many shows of each shape survive
// the other active filters) — the same pattern the Seasons view uses.
// Predicate + comparator live in finder-lib.js, shared with the Node export
// pipeline (one source of truth - Kometa preset exports cannot drift).
function finderRowsBeforeShape() {
  return showAgg.filter((s) => RisingShowsFinder.passesFinderFilters(s, finderState));
}

function filterAndSortFinder() {
  const f = finderState;
  const rows = finderRowsBeforeShape()
    .filter((s) => passesShapeAnd(s, f.shapes));
  rows.sort(RisingShowsFinder.finderComparator(f.sort, f.sortDir));
  return rows;
}

function renderFinder() {
  if (!showAgg) return;
  renderFinderActiveFilterBar();
  syncFinderResetButton();
  syncFinderShapeChips();
  updateFinderMoodActive();
  const rows = filterAndSortFinder();
  els.finderCount.textContent = rows.length === 1
    ? '1 show matches your filters'
    : `${rows.length.toLocaleString()} shows match your filters`;

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'finder-empty';
    empty.textContent = 'No shows match these filters.';
    els.finderResults.replaceChildren(empty);
    renderFinderPager(0, 1);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const requested = finderState.page;
  if (finderState.page > totalPages) finderState.page = totalPages;
  if (finderState.page < 1) finderState.page = 1;
  if (requested !== finderState.page) writeFinderStateToURL();

  const start = (finderState.page - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, rows.length);
  const page = rows.slice(start, end);

  if (finderState.view === 'list') {
    els.finderResults.classList.add('finder-list-view');
    els.finderResults.replaceChildren(buildFinderTable(page));
  } else {
    els.finderResults.classList.remove('finder-list-view');
    const frag = document.createDocumentFragment();
    for (const s of page) frag.appendChild(buildFinderCard(s));
    els.finderResults.replaceChildren(frag);
  }

  renderFinderPager(totalPages, finderState.page);
}

function buildFinderTable(page) {
  const table = document.createElement('table');
  table.className = 'finder-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of FINDER_COLUMNS) {
    const th = document.createElement('th');
    th.dataset.sort = col.key;
    if (col.key === 'title') th.className = 'finder-col-show';
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    const active = finderState.sort === col.key;
    th.setAttribute('aria-sort', active ? (finderState.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    const labelEl = document.createElement('span');
    labelEl.className = 'finder-th-label';
    labelEl.textContent = col.label;
    th.appendChild(labelEl);
    const arrow = document.createElement('span');
    arrow.className = 'finder-th-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = active ? (finderState.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    th.appendChild(arrow);
    headRow.appendChild(th);
  }
  const trendTh = document.createElement('th');
  trendTh.className = 'finder-col-trend';
  const trendLabel = document.createElement('span');
  trendLabel.className = 'finder-th-label';
  trendLabel.textContent = 'Trend';
  trendTh.appendChild(trendLabel);
  headRow.appendChild(trendTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const s of page) {
    const tr = document.createElement('tr');
    tr.className = 'finder-row';
    tr.tabIndex = 0;
    tr.dataset.seriesId = s.seriesId;

    const gapClass = s.gap > 0 ? 'finder-gap-pos' : (s.gap < 0 ? 'finder-gap-neg' : '');
    const gapStr = `${s.gap > 0 ? '+' : ''}${s.gap.toFixed(2)}`;

    const showCell = document.createElement('td');
    showCell.className = 'finder-col-show';
    showCell.dataset.label = 'Show';

    // Inner flex wrapper so the <td> itself stays a table-cell (its
    // border-bottom aligns with the rest of the row); flexing the td
    // directly shrinks its box and strands a short divider under only
    // this column.
    const showInner = document.createElement('div');
    showInner.className = 'finder-show-inner';

    const posterEl = document.createElement('div');
    posterEl.className = 'row-poster finder-row-poster';
    if (s.poster) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w185${s.poster}`;
      img.alt = `${s.title} poster`;
      img.loading = 'lazy';
      posterEl.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'poster-fallback';
      posterEl.appendChild(fb);
      populatePosterFallback(fb, s.title);
    }
    markSensitivePoster(posterEl, s);
    showInner.appendChild(posterEl);

    const showText = document.createElement('div');
    showText.className = 'finder-show-text';
    const titleEl = document.createElement('span');
    titleEl.className = 'finder-show-title';
    titleEl.textContent = s.title;
    showText.appendChild(titleEl);
    if (s.genres.length) {
      const genreEl = document.createElement('span');
      genreEl.className = 'finder-genre-line';
      genreEl.textContent = s.genres.join(', ');
      showText.appendChild(genreEl);
    }
    showInner.appendChild(showText);
    showCell.appendChild(showInner);
    tr.appendChild(showCell);

    const cells = [
      { label: 'Show rating', text: s.showRating.toFixed(1) },
      { label: 'Avg episode', text: s.avgEpisode.toFixed(2) },
      { label: 'Gap', text: gapStr, cls: gapClass },
      { label: 'Episodes', text: s.episodes.toLocaleString() },
      { label: 'Seasons', text: s.seasonsCount.toLocaleString() },
      { label: 'Year', text: s.year != null ? String(s.year) : '—' },
      { label: 'Votes', text: formatCompactVotes(s.votes) },
      { label: 'Runtime', text: `${s.runtimeHrs.toFixed(1)}h` },
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.dataset.label = c.label;
      if (c.cls) td.className = c.cls;
      td.textContent = c.text;
      tr.appendChild(td);
    }

    const trendTd = document.createElement('td');
    trendTd.className = 'finder-col-trend';
    trendTd.dataset.label = 'Trend';
    const svgNS = 'http://www.w3.org/2000/svg';
    const spark = document.createElementNS(svgNS, 'svg');
    spark.setAttribute('class', 'curve finder-spark finder-row-spark');
    spark.setAttribute('viewBox', '0 0 200 56');
    spark.setAttribute('preserveAspectRatio', 'none');
    spark.setAttribute('aria-hidden', 'true');
    const area = document.createElementNS(svgNS, 'path');
    area.setAttribute('class', 'curve-area');
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('class', 'curve-line');
    const dot = document.createElementNS(svgNS, 'g');
    dot.setAttribute('class', 'finder-spark-dot');
    spark.append(area, line, dot);
    trendTd.appendChild(spark);
    drawFinderSpark(spark, s.seasonAvgs, s.episodeSeries, 200, 56);
    tr.appendChild(trendTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Show-level trajectory. Multi-season shows draw one point per season's
// average rating, in season order (yellow). Reuses drawCurve (no .curve-dots
// in the markup, so no misleading "Ep N" tooltips). Single-season shows have
// no season line to draw, so they show that season's within-season EPISODE
// curve (amber, .finder-spark--single) instead; a season with a single rated
// episode has no line either, so it falls back to a visible centered dot.
function drawFinderSpark(svg, seasonAvgs, episodeSeries, W = 300, H = 70) {
  const dotGroup = svg.querySelector('.finder-spark-dot');
  if (dotGroup) dotGroup.replaceChildren();
  const single = seasonAvgs.length === 1;
  svg.classList.toggle('finder-spark--single', single);

  if (single) {
    if (episodeSeries && episodeSeries.length > 1) {
      drawCurve(svg, episodeSeries, W, H, 0);
      return;
    }
    svg.querySelector('.curve-line').setAttribute('d', '');
    svg.querySelector('.curve-area').setAttribute('d', '');
    if (dotGroup) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(W / 2));
      c.setAttribute('cy', String(H / 2));
      c.setAttribute('r', '5');
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      const sa = seasonAvgs[0];
      t.textContent = `S${sa.season}: ${sa.avg.toFixed(2)}`;
      c.appendChild(t);
      dotGroup.appendChild(c);
    }
    return;
  }

  drawCurve(svg, seasonAvgs.map((s) => ({ rating: s.avg, episode: s.season, votes: 0 })), W, H, 0);
}

// Grid card mirrors the Seasons card layout but carries show-level data.
function buildFinderCard(s) {
  const node = els.finderCardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.seriesId = s.seriesId;

  node.querySelector('.card-title').textContent = s.title;
  node.querySelector('.finder-card-year').textContent =
    `${s.year || 'year unknown'} · ${s.seasonsCount} season${s.seasonsCount === 1 ? '' : 's'}`;
  node.querySelector('.finder-card-genres').textContent = s.genres.slice(0, 3).join(' · ');

  const gapStr = `${s.gap > 0 ? '+' : ''}${s.gap.toFixed(2)}`;
  const gapEl = node.querySelector('.stat-gap');
  gapEl.textContent = `Gap ${gapStr}`;
  if (s.gap > 0) gapEl.classList.add('finder-gap-pos');
  else if (s.gap < 0) gapEl.classList.add('finder-gap-neg');

  node.querySelector('.stat-show').textContent = `Show ${s.showRating.toFixed(1)}`;
  node.querySelector('.stat-avg').textContent = `Avg ep ${s.avgEpisode.toFixed(2)}`;
  node.querySelector('.stat-votes').textContent = `${formatCompactVotes(s.votes)} votes`;
  node.querySelector('.stat-runtime').textContent = `${s.runtimeHrs.toFixed(1)}h`;

  drawFinderSpark(node.querySelector('.finder-spark'), s.seasonAvgs, s.episodeSeries);

  const posterEl = node.querySelector('.card-poster');
  if (s.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w342${s.poster}`;
    img.alt = `${s.title} poster`;
    img.loading = 'lazy';
    posterEl.appendChild(img);
  } else {
    populatePosterFallback(posterEl.querySelector('.poster-fallback'), s.title);
  }
  markSensitivePoster(posterEl, s);

  node.setAttribute('aria-label', s.title);
  node.addEventListener('click', () => openShowModal(s.seriesId));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openShowModal(s.seriesId);
    }
  });
  return node;
}

// Compact page-number list with ellipses (1 … 4 5 6 … 20). Shared by the
// finder pager.
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

function renderFinderPager(totalPages, current) {
  const targets = [
    [els.finderPagerTop, false],
    [els.finderPager, true],
  ].filter(([t]) => t);
  if (totalPages <= 1) {
    for (const [t] of targets) {
      t.replaceChildren();
      t.hidden = true;
    }
    return;
  }
  for (const [t, scrollAfter] of targets) {
    const frag = document.createDocumentFragment();
    frag.appendChild(finderPageButton('Prev', current - 1, current === 1, scrollAfter));
    for (const n of pageNumbers(current, totalPages)) {
      if (n === '…') {
        const span = document.createElement('span');
        span.className = 'page-ellipsis';
        span.textContent = '…';
        span.setAttribute('aria-hidden', 'true');
        frag.appendChild(span);
      } else {
        const btn = finderPageButton(String(n), n, false, scrollAfter);
        if (n === current) btn.setAttribute('aria-current', 'page');
        btn.setAttribute('aria-label', `Page ${n}`);
        frag.appendChild(btn);
      }
    }
    frag.appendChild(finderPageButton('Next', current + 1, current === totalPages, scrollAfter));
    t.replaceChildren(frag);
    t.hidden = false;
  }
}

function finderPageButton(label, target, disabled, scrollAfter = true) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'page-btn';
  btn.textContent = label;
  if (disabled) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.addEventListener('click', () => goToFinderPage(target, scrollAfter));
  }
  return btn;
}

function goToFinderPage(n, scrollAfter = true) {
  finderState.page = n;
  writeFinderStateToURL();
  renderFinder();
  if (scrollAfter) {
    const top = els.finderResults.getBoundingClientRect().top + window.scrollY - 70;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

const renderFinderDebounced = debounce(renderFinder, 120);

// Page resets to 1 whenever a filter or sort changes (matches Seasons).
function onFinderFilterChange() {
  finderState.page = 1;
  writeFinderStateToURL();
  renderFinder();
}

function finderHasActiveFilters() {
  const f = finderState;
  if (f.search && f.search.trim()) return true;
  if (f.minEpisodes > 0) return true;
  if (f.minVotes > 0) return true;
  if (f.minShowRating > 0) return true;
  if (f.minAvgEpisode > 0) return true;
  if (f.gapDir !== 'any') return true;
  if (f.minGap > 0) return true;
  if (f.minYear != null) return true;
  if (f.maxYear != null) return true;
  if (f.hiddenGems) return true;
  if (f.genres.size) return true;
  if (f.genresExclude.size) return true;
  if (f.languages.size) return true;
  if (f.shapes.size) return true;
  if (f.sort !== 'votes') return true;
  if (f.sortDir !== 'desc') return true;
  return false;
}

function syncFinderResetButton() {
  if (!els.finderReset) return;
  const active = finderHasActiveFilters();
  els.finderReset.hidden = !active;
  els.finderReset.disabled = !active;
}

function resetFinderState() {
  finderState.search = '';
  finderState.minEpisodes = 0;
  finderState.minVotes = 0;
  finderState.minShowRating = 0;
  finderState.minAvgEpisode = 0;
  finderState.gapDir = 'any';
  finderState.minGap = 0;
  finderState.minYear = null;
  finderState.maxYear = null;
  finderState.hiddenGems = false;
  finderState.genres = new Set();
  finderState.genresExclude = new Set();
  finderState.languages = new Set();
  finderState.shapes = new Set();
  finderState.sort = 'votes';
  finderState.sortDir = 'desc';
  finderState.page = 1;
  els.finderSearch.value = '';
  els.finderMinEpisodes.value = '';
  els.finderMinVotes.value = '';
  els.finderMinShowRating.value = '';
  els.finderMinAvgEpisode.value = '';
  els.finderMinGap.value = '';
  els.finderMinYear.value = '';
  els.finderMaxYear.value = '';
  syncFinderSortControls();
  syncFinderControls();
  syncFinderDecadeRowAria();
  syncFinderShapeChips();
}

// Push finderState onto every control. Number inputs show blank for zero/null
// defaults (parity with Seasons' "any" placeholders) rather than a literal 0.
function syncFinderControls() {
  els.finderSearch.value = finderState.search;
  els.finderMinEpisodes.value = finderState.minEpisodes > 0 ? String(finderState.minEpisodes) : '';
  els.finderMinVotes.value = finderState.minVotes > 0 ? String(finderState.minVotes) : '';
  els.finderMinShowRating.value = finderState.minShowRating > 0 ? String(finderState.minShowRating) : '';
  els.finderMinAvgEpisode.value = finderState.minAvgEpisode > 0 ? String(finderState.minAvgEpisode) : '';
  els.finderMinGap.value = finderState.minGap > 0 ? String(finderState.minGap) : '';
  els.finderMinYear.value = finderState.minYear ?? '';
  els.finderMaxYear.value = finderState.maxYear ?? '';
  for (const chip of els.finderVotesChips.querySelectorAll('.finder-chip')) {
    chip.setAttribute('aria-pressed', Number(chip.dataset.votes) === finderState.minVotes ? 'true' : 'false');
  }
  if (els.finderGemsChip) {
    els.finderGemsChip.setAttribute('aria-pressed', finderState.hiddenGems ? 'true' : 'false');
  }
  for (const btn of els.finderGapDir.querySelectorAll('.finder-seg-btn')) {
    btn.setAttribute('aria-pressed', btn.dataset.dir === finderState.gapDir ? 'true' : 'false');
  }
  for (const chip of els.finderGenres.querySelectorAll('.genre-chip')) {
    syncFinderGenreChipTriState(chip);
  }
  for (const chip of els.finderLanguages.querySelectorAll('.genre-chip')) {
    chip.setAttribute('aria-pressed', finderState.languages.has(chip.dataset.language) ? 'true' : 'false');
  }
  syncFinderDecadeRowAria();
}

function syncFinderSortControls() {
  els.finderSort.value = finderState.sort;
  els.finderSortDir.value = finderState.sortDir;
}

function applyFinderViewClasses() {
  els.finderResults.classList.toggle('list-view', finderState.view === 'list');
  for (const btn of els.finderViewToggle.querySelectorAll('.view-btn')) {
    btn.setAttribute('aria-pressed', btn.dataset.view === finderState.view ? 'true' : 'false');
  }
}

function applyFinderSort(key, dir) {
  finderState.sort = key;
  if (dir) finderState.sortDir = dir;
  syncFinderSortControls();
  onFinderFilterChange();
}

// Header click-sort drives ordering in the list/table view.
function handleFinderHeaderActivate(key) {
  if (finderState.sort === key) {
    applyFinderSort(key, finderState.sortDir === 'desc' ? 'asc' : 'desc');
  } else {
    applyFinderSort(key, key === 'title' ? 'asc' : 'desc');
  }
}

function renderFinderActiveFilterBar() {
  const bar = els.finderActiveFilterBar;
  if (!bar) return;
  const chips = describeFinderActiveFilters();
  if (chips.length === 0) {
    bar.replaceChildren();
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const frag = document.createDocumentFragment();
  const label = document.createElement('span');
  label.className = 'active-filter-label';
  label.textContent = 'Active filters';
  frag.appendChild(label);
  for (const c of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'active-filter-chip';
    btn.title = `Remove ${c.key}: ${c.value}`;
    const k = document.createElement('span');
    k.className = 'chip-key';
    k.textContent = c.key;
    const v = document.createElement('span');
    v.className = 'chip-val';
    v.textContent = c.value;
    const x = document.createElement('span');
    x.className = 'chip-x';
    x.textContent = '×';
    btn.append(k, v, x);
    btn.addEventListener('click', c.remove);
    frag.appendChild(btn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn btn-ghost copy-link-btn';
  copyBtn.textContent = 'Copy link';
  copyBtn.addEventListener('click', () => {
    const orig = copyBtn.textContent;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(location.href)
        .then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = orig; }, 1800);
        })
        .catch(() => { copyBtn.textContent = orig; });
    } else {
      try { window.prompt('Copy this link:', location.href); }
      catch { /* ignore */ }
    }
  });
  frag.appendChild(copyBtn);

  bar.replaceChildren(frag);
}

function describeFinderActiveFilters() {
  const f = finderState;
  const chips = [];
  if (f.search) {
    chips.push({
      key: 'Search',
      value: f.search,
      remove: () => { f.search = ''; els.finderSearch.value = ''; onFinderFilterChange(); },
    });
  }
  for (const g of f.genres) {
    chips.push({
      key: 'Genre',
      value: g,
      remove: () => {
        f.genres.delete(g);
        const btn = els.finderGenres.querySelector(`.genre-chip[data-genre="${cssEscape(g)}"]`);
        if (btn) syncFinderGenreChipTriState(btn);
        onFinderFilterChange();
      },
    });
  }
  for (const g of f.genresExclude) {
    chips.push({
      key: 'Not',
      value: g,
      remove: () => {
        f.genresExclude.delete(g);
        const btn = els.finderGenres.querySelector(`.genre-chip[data-genre="${cssEscape(g)}"]`);
        if (btn) syncFinderGenreChipTriState(btn);
        onFinderFilterChange();
      },
    });
  }
  for (const l of f.languages) {
    chips.push({
      key: 'Language',
      value: languageLabel(l),
      remove: () => {
        f.languages.delete(l);
        const btn = els.finderLanguages.querySelector(`.genre-chip[data-language="${l}"]`);
        if (btn) btn.setAttribute('aria-pressed', 'false');
        onFinderFilterChange();
      },
    });
  }
  for (const sh of f.shapes) {
    chips.push({
      key: 'Shape',
      value: SHAPE_LABELS[sh] || sh,
      remove: () => { f.shapes.delete(sh); onFinderFilterChange(); },
    });
  }
  if (f.gapDir !== 'any') {
    chips.push({
      key: 'Gap',
      value: f.gapDir === 'up' ? 'Episodes beat show' : 'Show beats episodes',
      remove: () => { f.gapDir = 'any'; syncFinderControls(); onFinderFilterChange(); },
    });
  }
  if (f.minEpisodes > 0) chips.push(finderNumericChip('Min eps', f.minEpisodes, 'minEpisodes', els.finderMinEpisodes));
  if (f.minVotes > 0) chips.push(finderNumericChip('Min votes', f.minVotes.toLocaleString(), 'minVotes', els.finderMinVotes));
  if (f.minShowRating > 0) chips.push(finderNumericChip('Min show', f.minShowRating, 'minShowRating', els.finderMinShowRating));
  if (f.minAvgEpisode > 0) chips.push(finderNumericChip('Min avg ep', f.minAvgEpisode, 'minAvgEpisode', els.finderMinAvgEpisode));
  if (f.minGap > 0) chips.push(finderNumericChip('Min gap', f.minGap, 'minGap', els.finderMinGap));
  if (f.hiddenGems) {
    chips.push({
      key: 'Hidden gems',
      value: 'On',
      remove: () => {
        f.hiddenGems = false;
        if (els.finderGemsChip) els.finderGemsChip.setAttribute('aria-pressed', 'false');
        onFinderFilterChange();
      },
    });
  }
  if (f.minYear != null) chips.push(finderYearChip('Year ≥', f.minYear, 'minYear', els.finderMinYear));
  if (f.maxYear != null) chips.push(finderYearChip('Year ≤', f.maxYear, 'maxYear', els.finderMaxYear));
  // Sort deliberately does NOT get a chip: it narrows nothing, so it is not an
  // active filter. The sort dropdown (and table-header arrows) already show it.
  return chips;
}

function finderNumericChip(label, displayValue, prop, el) {
  return {
    key: label,
    value: String(displayValue),
    remove: () => { finderState[prop] = 0; if (el) el.value = ''; onFinderFilterChange(); },
  };
}

function finderYearChip(label, displayValue, prop, el) {
  return {
    key: label,
    value: String(displayValue),
    remove: () => {
      finderState[prop] = null;
      if (el) el.value = '';
      syncFinderDecadeRowAria();
      onFinderFilterChange();
    },
  };
}

function bindFinder() {
  els.finderSearch.addEventListener('input', () => {
    finderState.search = els.finderSearch.value;
    updateFinderSuggestions();
    onFinderFilterChangeDebounced();
  });
  els.finderSearch.addEventListener('focus', () => {
    if (els.finderSearch.value.trim()) updateFinderSuggestions();
  });
  els.finderSearch.addEventListener('blur', () => {
    closeFinderSuggestions();
  });
  els.finderSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!finderSuggestState.open && els.finderSearch.value.trim()) updateFinderSuggestions();
      if (moveFinderSuggestionActive(1)) e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      if (moveFinderSuggestionActive(-1)) e.preventDefault();
    } else if (e.key === 'Enter') {
      if (finderSuggestState.open && finderSuggestState.active >= 0) {
        e.preventDefault();
        selectFinderSuggestion(finderSuggestState.active);
      }
    } else if (e.key === 'Escape' && finderSuggestState.open) {
      e.preventDefault();
      e.stopPropagation();
      closeFinderSuggestions();
    }
  });

  const numHandler = (el, prop, allowNull) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (allowNull) finderState[prop] = Number.isFinite(v) ? v : null;
      else finderState[prop] = Number.isFinite(v) ? v : 0;
      if (prop === 'minVotes') {
        for (const chip of els.finderVotesChips.querySelectorAll('.finder-chip')) {
          chip.setAttribute('aria-pressed', Number(chip.dataset.votes) === finderState.minVotes ? 'true' : 'false');
        }
      }
      if (prop === 'minYear' || prop === 'maxYear') syncFinderDecadeRowAria();
      onFinderFilterChangeDebounced();
    });
  };
  numHandler(els.finderMinEpisodes, 'minEpisodes', false);
  numHandler(els.finderMinVotes, 'minVotes', false);
  numHandler(els.finderMinShowRating, 'minShowRating', false);
  numHandler(els.finderMinAvgEpisode, 'minAvgEpisode', false);
  numHandler(els.finderMinGap, 'minGap', false);
  numHandler(els.finderMinYear, 'minYear', true);
  numHandler(els.finderMaxYear, 'maxYear', true);

  els.finderVotesChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.finder-chip');
    if (!chip) return;
    finderState.minVotes = Number(chip.dataset.votes);
    els.finderMinVotes.value = finderState.minVotes > 0 ? String(finderState.minVotes) : '';
    for (const c of els.finderVotesChips.querySelectorAll('.finder-chip')) {
      c.setAttribute('aria-pressed', Number(c.dataset.votes) === finderState.minVotes ? 'true' : 'false');
    }
    onFinderFilterChange();
  });

  els.finderGemsChip.addEventListener('click', () => {
    finderState.hiddenGems = !finderState.hiddenGems;
    els.finderGemsChip.setAttribute('aria-pressed', finderState.hiddenGems ? 'true' : 'false');
    onFinderFilterChange();
  });

  els.finderSurprise.addEventListener('click', () => {
    const rows = filterAndSortFinder();
    if (rows.length === 0) return;
    const pick = rows[Math.floor(Math.random() * rows.length)];
    openShowModal(pick.seriesId);
  });

  els.finderPopularPick.addEventListener('click', () => {
    const rows = filterAndSortFinder();
    if (rows.length === 0) return;
    const top = rows.slice().sort((a, b) => b.votes - a.votes).slice(0, 50);
    const pick = top[Math.floor(Math.random() * top.length)];
    openShowModal(pick.seriesId);
  });

  els.finderGapDir.addEventListener('click', (e) => {
    const btn = e.target.closest('.finder-seg-btn');
    if (!btn) return;
    finderState.gapDir = btn.dataset.dir;
    for (const b of els.finderGapDir.querySelectorAll('.finder-seg-btn')) {
      b.setAttribute('aria-pressed', b.dataset.dir === finderState.gapDir ? 'true' : 'false');
    }
    onFinderFilterChange();
  });

  els.finderGenres.addEventListener('click', (e) => {
    const chip = e.target.closest('.genre-chip');
    if (!chip) return;
    cycleFinderGenreState(chip.dataset.genre);
    syncFinderGenreChipTriState(chip);
    onFinderFilterChange();
  });

  els.finderShapes.addEventListener('click', (e) => {
    const btn = e.target.closest('.shape-chip');
    if (!btn) return;
    toggleFinderShape(btn.dataset.shape);
    onFinderFilterChange();
  });

  els.finderMoodChips.addEventListener('click', (e) => {
    const btn = e.target.closest('.mood-chip');
    if (!btn) return;
    const mood = FINDER_MOODS.find((m) => m.id === btn.dataset.mood);
    if (!mood) return;
    // Clicking the active preset clears it; otherwise apply it.
    if (btn.getAttribute('aria-pressed') === 'true') resetFinderState();
    else applyFinderMood(mood);
    onFinderFilterChange();
  });

  els.finderSort.addEventListener('change', () => {
    applyFinderSort(els.finderSort.value);
  });

  els.finderSortDir.addEventListener('change', () => {
    applyFinderSort(finderState.sort, els.finderSortDir.value);
  });

  for (const btn of els.finderViewToggle.querySelectorAll('.view-btn')) {
    btn.addEventListener('click', () => {
      finderState.view = btn.dataset.view;
      applyFinderViewClasses();
      writeFinderStateToURL();
      renderFinder();
    });
  }

  els.finderReset.addEventListener('click', () => {
    resetFinderState();
    // Clearing every finder filter drops the hash entirely (back to the bare
    // finder URL).
    writeFinderStateToURL();
    renderFinder();
  });

  els.finderResults.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) { handleFinderHeaderActivate(th.dataset.sort); return; }
    const row = e.target.closest('.finder-row');
    if (row) { openShowModal(row.dataset.seriesId); return; }
  });
  els.finderResults.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const th = e.target.closest('th[data-sort]');
    if (th) { e.preventDefault(); handleFinderHeaderActivate(th.dataset.sort); return; }
    const row = e.target.closest('.finder-row');
    if (row) { e.preventDefault(); openShowModal(row.dataset.seriesId); }
  });
}

const onFinderFilterChangeDebounced = debounce(onFinderFilterChange, 200);

// --- Show Finder URL state ---

function writeFinderStateToURL() {
  const f = finderState;
  const p = new URLSearchParams();
  if (f.search) p.set('q', f.search);
  if (f.view !== 'grid') p.set('fView', f.view);
  if (f.sort !== 'votes') p.set('fSort', f.sort);
  if (f.sortDir !== 'desc') p.set('fDir', f.sortDir);
  if (f.minEpisodes > 0) p.set('fMinEps', f.minEpisodes);
  if (f.minVotes > 0) p.set('fMinVotes', f.minVotes);
  if (f.minShowRating > 0) p.set('fMinShow', f.minShowRating);
  if (f.minAvgEpisode > 0) p.set('fMinAvg', f.minAvgEpisode);
  if (f.gapDir !== 'any') p.set('fGapDir', f.gapDir);
  if (f.minGap > 0) p.set('fMinGap', f.minGap);
  if (f.minYear != null) p.set('fMinYear', f.minYear);
  if (f.maxYear != null) p.set('fMaxYear', f.maxYear);
  if (f.hiddenGems) p.set('fGems', 'on');
  if (f.genres.size) p.set('fg', [...f.genres].join(','));
  if (f.genresExclude.size) p.set('fxg', [...f.genresExclude].join(','));
  if (f.languages.size) p.set('fl', [...f.languages].join(','));
  if (f.shapes.size) p.set('fShape', [...f.shapes].join(','));
  if (f.page > 1) p.set('page', f.page);
  // Append the open-modal deep-link key so a shared/refreshed link reopens the
  // finder AND the modal. A season detail (in-show drill-down) wins over the
  // show modal when both flags somehow linger.
  if (els.modal && !els.modal.hidden && modalState.season) {
    p.set('season', `${modalState.season.seriesId}:${modalState.season.season}`);
  } else if (els.showModal && !els.showModal.hidden && showModalState.seriesId) {
    p.set('show', showModalState.seriesId);
  }
  // With everything at defaults there is nothing to encode: drop the hash
  // entirely instead of leaving a dangling `#`.
  const q = p.toString();
  history.replaceState(null, '', q ? `#${q}` : location.pathname + location.search);
}

// Read finder params off the hash into finderState. Called from
// applyStateFromURL for every hash. Does NOT touch the DOM
// controls (they may not exist yet at first load); syncFinderControls handles
// that once the controls are rendered. Parsing lives in finder-lib.js so the
// Node export pipeline reads preset queries with identical semantics.
function applyFinderStateFromParams(p) {
  Object.assign(finderState, RisingShowsFinder.parseFinderQuery(p));
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
      `Rising Shows data is older than ${STALE_DAYS} days (built ${dataset.builtAt}). ` +
      `Run npm run build:rising-shows or wait for the next scheduled refresh.`,
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
  renderChangelogFreshness(latest);

  els.changelogModal.hidden = false;
  els.changelogModal.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  syncModalInert();
  requestAnimationFrame(() => {
    const panel = els.changelogModal.querySelector('.modal-panel');
    if (panel) panel.focus();
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

function renderChangelogFreshness(entry) {
  if (!els.changelogFreshnessContent) return;
  const frag = document.createDocumentFragment();

  const builtAt = entry.builtAt || dataset?.builtAt;
  if (builtAt) {
    const row = document.createElement('div');
    row.className = 'freshness-row';
    const label = document.createElement('span');
    label.className = 'freshness-label';
    label.textContent = 'Dataset built:';
    const val = document.createElement('span');
    val.className = 'freshness-value';
    val.textContent = formatBuiltAt(builtAt);
    row.append(label, val);
    frag.appendChild(row);
  }

  const ratingChanges = entry.modifiedCounts?.avgRating || 0;
  if (ratingChanges > 0) {
    const row = document.createElement('div');
    row.className = 'freshness-row';
    const label = document.createElement('span');
    label.className = 'freshness-label';
    label.textContent = 'Avg ratings changed:';
    const val = document.createElement('span');
    val.className = 'freshness-value';
    val.textContent = `${ratingChanges.toLocaleString()} season${ratingChanges === 1 ? '' : 's'}`;
    row.append(label, val);
    frag.appendChild(row);
  }

  const bigSwings = (entry.ratingSwings || []).length;
  if (bigSwings > 0) {
    const row = document.createElement('div');
    row.className = 'freshness-row';
    const label = document.createElement('span');
    label.className = 'freshness-label';
    label.textContent = 'Notable rating swings (≥0.2):';
    const val = document.createElement('span');
    val.className = 'freshness-value';
    val.textContent = `${bigSwings} season${bigSwings === 1 ? '' : 's'}`;
    row.append(label, val);
    frag.appendChild(row);
  }

  if (!frag.childNodes.length) {
    const p = document.createElement('p');
    p.className = 'freshness-label';
    p.textContent = 'No freshness data available for this refresh.';
    frag.appendChild(p);
  }

  els.changelogFreshnessContent.replaceChildren(frag);
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

// --- finder search suggestions (autocomplete, scoped to whole shows) ---
// Parallel to the Seasons suggestion machinery: same .search-suggestion CSS,
// but it ranks rows from showAgg (one per series) and matches title or IMDb
// series id only — no episode-name or fuzzy fallback.
function computeFinderSuggestions(rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (!q || !showAgg) return [];
  const titleStarts = [];
  const titleContains = [];
  const idMatches = [];
  for (const s of showAgg) {
    const titleL = s.title.toLowerCase();
    const idL = s.seriesId.toLowerCase();
    if (titleL.startsWith(q)) titleStarts.push(s);
    else if (titleL.includes(q)) titleContains.push(s);
    else if (idL.includes(q)) idMatches.push(s);
  }
  const byVotes = (a, b) => (b.votes || 0) - (a.votes || 0);
  titleStarts.sort(byVotes);
  titleContains.sort(byVotes);
  idMatches.sort(byVotes);
  const strictAll = [...titleStarts, ...titleContains, ...idMatches];
  const out = strictAll.slice(0, MAX_SUGGESTIONS);

  // fuzzy-search: mirror the Seasons suggestion builder, but over whole
  // shows. Append up to FUZZY_MAX_RESULTS typo-tolerant titles under a
  // "Did you mean?" subheader. Runs even when the strict bucket is full,
  // and is suppressed when a multi-word query exactly matches a real
  // title ("Breaking Bad" shouldn't suggest "Breaking In").
  const FUZZY_MIN_QUERY_LEN = 4;
  const FUZZY_DICE_THRESHOLD = 0.6;
  const FUZZY_MAX_RESULTS = 3;
  const matchedIds = new Set(strictAll.map((s) => s.seriesId));
  const hasExactTitle = showAgg.some((s) => s.title.toLowerCase() === q);
  const suppressFuzzy = hasExactTitle && q.includes(' ');
  if (q.length >= FUZZY_MIN_QUERY_LEN && !suppressFuzzy) {
    const qBigrams = searchBigrams(q);
    const scored = [];
    for (const s of showAgg) {
      if (matchedIds.has(s.seriesId)) continue;
      const titleL = s.title.toLowerCase();
      if (titleL === q) continue;
      const score = searchDice(qBigrams, searchBigrams(titleL));
      if (score >= FUZZY_DICE_THRESHOLD) scored.push({ s, score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.s.votes || 0) - (a.s.votes || 0);
    });
    for (let i = 0; i < scored.length && i < FUZZY_MAX_RESULTS; i++) {
      out.push({ ...scored[i].s, isFuzzy: true });
    }
  }

  return out;
}

function renderFinderSuggestionItems() {
  const items = finderSuggestState.items;
  const ul = els.finderSuggestions;
  if (!items.length) {
    closeFinderSuggestions();
    return;
  }
  const q = els.finderSearch.value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  // fuzzy-search: only the very first fuzzy item gets a preceding
  // "Did you mean?" subheader; later fuzzy items share that section.
  let fuzzyHeaderRendered = false;
  items.forEach((s, i) => {
    if (s.isFuzzy && !fuzzyHeaderRendered) {
      const head = document.createElement('li');
      head.className = 'search-suggestion-subheader';
      head.setAttribute('aria-hidden', 'true');
      head.textContent = 'Did you mean?';
      frag.appendChild(head);
      fuzzyHeaderRendered = true;
    }
    const li = document.createElement('li');
    li.className = 'search-suggestion';
    li.setAttribute('role', 'option');
    li.id = `fss-${i}`;
    li.dataset.index = String(i);
    li.setAttribute('aria-selected', i === finderSuggestState.active ? 'true' : 'false');

    const poster = document.createElement('div');
    poster.className = 'ss-poster';
    if (s.poster) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w92${s.poster}`;
      img.alt = '';
      img.loading = 'lazy';
      poster.appendChild(img);
    } else {
      poster.classList.add('ss-poster-fallback');
      poster.style.setProperty('--poster-hue', String(hashHue(s.title || 'unknown')));
      const initial = document.createElement('span');
      initial.className = 'ss-poster-initial';
      initial.textContent = posterInitial(s.title);
      poster.appendChild(initial);
    }
    markSensitivePoster(poster, s);

    const text = document.createElement('div');
    text.className = 'ss-text';

    const title = document.createElement('span');
    title.className = 'ss-title';
    for (const node of highlightFragment(s.title, q)) title.appendChild(node);

    const meta = document.createElement('span');
    meta.className = 'ss-meta';
    const seasonLabel = s.seasonsCount === 1 ? 'season' : 'seasons';
    if (s.year) meta.appendChild(document.createTextNode(`${s.year} · ${s.seasonsCount} ${seasonLabel}`));
    else meta.appendChild(document.createTextNode(`${s.seasonsCount} ${seasonLabel}`));

    text.append(title, meta);
    li.append(poster, text);

    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', (e) => {
      e.preventDefault();
      selectFinderSuggestion(i);
    });
    frag.appendChild(li);
  });
  ul.replaceChildren(frag);
  ul.hidden = false;
  els.finderSearch.setAttribute('aria-expanded', 'true');
  if (finderSuggestState.active >= 0) {
    els.finderSearch.setAttribute('aria-activedescendant', `fss-${finderSuggestState.active}`);
  } else {
    els.finderSearch.removeAttribute('aria-activedescendant');
  }
  finderSuggestState.open = true;
}

function updateFinderSuggestions() {
  const q = els.finderSearch.value.trim();
  if (!q) {
    closeFinderSuggestions();
    return;
  }
  finderSuggestState.items = computeFinderSuggestions(q);
  finderSuggestState.active = -1;
  if (!finderSuggestState.items.length) {
    renderFinderEmptySuggestion();
    return;
  }
  renderFinderSuggestionItems();
}

function renderFinderEmptySuggestion() {
  const ul = els.finderSuggestions;
  const li = document.createElement('li');
  li.className = 'search-suggestion search-suggestion-empty';
  li.setAttribute('role', 'option');
  li.setAttribute('aria-disabled', 'true');
  li.textContent = 'No matches';
  ul.replaceChildren(li);
  ul.hidden = false;
  els.finderSearch.setAttribute('aria-expanded', 'true');
  els.finderSearch.removeAttribute('aria-activedescendant');
  finderSuggestState.open = true;
}

function closeFinderSuggestions() {
  els.finderSuggestions.hidden = true;
  els.finderSuggestions.replaceChildren();
  els.finderSearch.setAttribute('aria-expanded', 'false');
  els.finderSearch.removeAttribute('aria-activedescendant');
  finderSuggestState.items = [];
  finderSuggestState.active = -1;
  finderSuggestState.open = false;
}

function moveFinderSuggestionActive(delta) {
  if (!finderSuggestState.open) return false;
  const n = finderSuggestState.items.length;
  if (n === 0) return false;
  let next = finderSuggestState.active + delta;
  if (next < -1) next = n - 1;
  if (next >= n) next = -1;
  finderSuggestState.active = next;
  for (const li of els.finderSuggestions.querySelectorAll('.search-suggestion')) {
    const idx = parseInt(li.dataset.index, 10);
    const isActive = idx === finderSuggestState.active;
    li.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) li.scrollIntoView({ block: 'nearest' });
  }
  if (finderSuggestState.active >= 0) {
    els.finderSearch.setAttribute('aria-activedescendant', `fss-${finderSuggestState.active}`);
  } else {
    els.finderSearch.removeAttribute('aria-activedescendant');
  }
  return true;
}

function selectFinderSuggestion(i) {
  const s = finderSuggestState.items[i];
  if (!s) return;
  closeFinderSuggestions();
  // Mirror the Seasons "pick a series" behavior: jump straight to the
  // picked show's modal.
  openShowModal(s.seriesId);
}

function shareSeasonCard(m) {
  shareText(buildSeasonShareText(m), els.modalShareCard);
}

// Show-level variant — title, year range, season/episode counts,
// IMDb + avg-episode line, link to the show's static page.
function shareShowCard(seriesId) {
  const seasons = dataset.matches
    .filter((s) => s.seriesId === seriesId)
    .sort((a, b) => a.season - b.season);
  if (!seasons.length) return;
  shareText(buildShowShareText(seasons), els.showModalShareCard);
}

function shareText(text, buttonEl) {
  const flashLabel = (label) => {
    if (!buttonEl) return;
    const orig = buttonEl.dataset.origLabel || buttonEl.textContent;
    buttonEl.dataset.origLabel = orig;
    buttonEl.textContent = label;
    setTimeout(() => {
      buttonEl.textContent = orig;
      delete buttonEl.dataset.origLabel;
    }, 1800);
  };
  const manualFallback = () => {
    // Last-ditch: pop a prompt with the text pre-selected so the user
    // can ⌘C / Ctrl-C manually. Better than silently doing nothing.
    try { window.prompt('Copy this:', text); flashLabel('Copy manually'); }
    catch { flashLabel('Copy failed'); }
  };

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text)
      .then(() => flashLabel('Copied!'))
      .catch(manualFallback);
  } else {
    manualFallback();
  }
}

function buildSeasonShareText(m) {
  const lines = [];
  const seasonYear = m.seasonYear || m.year;
  lines.push(`${m.title} - Season ${m.season}` + (seasonYear ? ` (${seasonYear})` : ''));
  const shapeLabels = (m.shapes || [])
    .filter((s) => s !== 'saved-best-for-last')
    .map((s) => SHAPE_LABELS[s] || s);
  if (shapeLabels.length) lines.push(shapeLabels.join(' · '));
  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  lines.push(
    `Avg ${m.avgRating.toFixed(1)} · Climb ${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr}) · ${m.episodes.length} eps`,
  );
  // Link to the show's static page (not the SPA hash) so chat apps see
  // og:image and unfurl a poster thumbnail. The season # is in the text
  // above so recipients still know which season was shared.
  lines.push(showPageUrl(m));
  return lines.join('\n');
}

function buildShowShareText(seasons) {
  const meta = seasons[0];
  const lines = [];
  const years = seasons.map((s) => s.seasonYear || s.year).filter(Boolean);
  const yearStr = years.length === 0 ? ''
    : years[0] === years[years.length - 1] ? `${years[0]}`
    : `${years[0]}–${years[years.length - 1]}`;
  lines.push(`${meta.title}` + (yearStr ? ` (${yearStr})` : ''));
  const totalEps = seasons.reduce((s, m) => s + m.episodes.length, 0);
  const overallAvg = seasons.reduce((s, m) => s + m.avgRating, 0) / seasons.length;
  const head = `${seasons.length} season${seasons.length === 1 ? '' : 's'} · ${totalEps} episodes · avg episode ${overallAvg.toFixed(1)}`;
  lines.push(typeof meta.seriesRating === 'number'
    ? `${head} · IMDb ${meta.seriesRating.toFixed(1)}`
    : head);
  lines.push(showPageUrl(meta));
  return lines.join('\n');
}

// URL of the show's static page on the current origin. Static pages
// carry og:image/og:title/og:description tags (see render-show-page.js)
// so chat apps unfurl them into thumbnails.
function showPageUrl(m) {
  return `${location.origin}/apps/rising-shows/shows/${showSlug(m.title)}-${m.seriesId}/`;
}

function bindEvents() {
  // Season detail modal (reachable as an in-show drill-down) + show modal +
  // compare + changelog: close / back buttons.
  for (const closer of els.modal.querySelectorAll('[data-close="modal"]')) {
    closer.addEventListener('click', closeModal);
  }
  for (const closer of els.showModal.querySelectorAll('[data-close="show-modal"]')) {
    closer.addEventListener('click', closeShowModal);
  }
  if (els.modalBack) els.modalBack.addEventListener('click', goBackModalView);
  if (els.showModalBack) els.showModalBack.addEventListener('click', goBackModalView);

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
  });

  if (els.modalShareCard) {
    els.modalShareCard.addEventListener('click', () => {
      if (!modalState.season) return;
      shareSeasonCard(modalState.season);
    });
  }
  if (els.showModalShareCard) {
    els.showModalShareCard.addEventListener('click', () => {
      if (!showModalState.seriesId) return;
      shareShowCard(showModalState.seriesId);
    });
  }

  // Hash navigation (back/forward, or a pasted finder link) re-applies the
  // finder state from the URL and re-renders. writeFinderStateToURL uses
  // history.replaceState so our own writes don't fire this event.
  window.addEventListener('hashchange', () => {
    applyStateFromURL();
    syncFinderControls();
    syncFinderSortControls();
    applyFinderViewClasses();
    renderFinder();
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      els.finderSearch.focus();
      els.finderSearch.select();
      return;
    }
    if (e.key === '?' && !isTypingTarget(e.target)) {
      e.preventDefault();
      toggleShortcutLegend();
      return;
    }
    if (e.key === 'Escape') {
      if (els.shortcutLegend && !els.shortcutLegend.hidden) {
        toggleShortcutLegend(false);
        return;
      }
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
      }
      return;
    }
  });
}

// Touch tooltip for shape tags on result cards (UI-4).
// On touchstart on a .shape-tag[title], show a floating label near the touch
// point for 2 seconds. Works on iOS where title tooltips don't show on tap.
let _touchTooltipEl = null;
let _touchTooltipTimer = null;
function bindShapeTagTouchTooltips() {
  function show(text, x, y) {
    hide();
    const el = document.createElement('div');
    el.className = 'shape-touch-tooltip';
    el.textContent = text;
    el.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
    el.style.top = `${y - 44}px`;
    document.body.appendChild(el);
    _touchTooltipEl = el;
    _touchTooltipTimer = setTimeout(hide, 2000);
  }
  function hide() {
    if (_touchTooltipEl) { _touchTooltipEl.remove(); _touchTooltipEl = null; }
    if (_touchTooltipTimer) { clearTimeout(_touchTooltipTimer); _touchTooltipTimer = null; }
  }
  document.addEventListener('touchstart', (e) => {
    const tag = e.target.closest('.shape-tag:not(.is-clickable)');
    if (tag && tag.title) {
      const touch = e.touches[0];
      show(tag.title, touch.clientX, touch.clientY + window.scrollY);
    } else {
      hide();
    }
  }, { passive: true });
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

// ===== UI improvement helpers (chip bar, sticky bar, shortcut legend,
// shape annotation, JustWatch link, intersection-hover counts) =====

function cssEscape(s) {
  // CSS.escape is widely supported, but guard for older browsers.
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

// Sticky filter bar: a compact, scroll-pinned strip of shape chips +
// search input that appears once the main filter section leaves the
// viewport. Backed by an IntersectionObserver on the .filters element.
let _stickyObserver = null;
// Shape chip hover: when a shape is already active and the user hovers
// another, swap the hovered chip's count badge to show the size of the
// intersection (i.e. "how many would survive if I added this too?").
// Generate a one-line, data-driven sentence per recognized shape on the
// season and stack them under the modal curve. Skips "consistent" because
// the curve itself communicates it.
function renderShapeAnnotationText(m) {
  const el = els.modalCurveAnnotation;
  if (!el) return;
  el.replaceChildren();
  if (!m.shapes || !m.shapes.length) { el.hidden = true; return; }

  const ratings = m.episodes.map((e) => e.rating);
  const n = ratings.length;
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  const minIdx = ratings.indexOf(min);
  const maxIdx = ratings.indexOf(max);
  const half = Math.floor(n / 2);
  const firstAvg = mean(ratings.slice(0, half));
  const secondAvg = mean(ratings.slice(half));

  function sentence(shape) {
    switch (shape) {
      case 'rising':
        return `Each episode is rated at least as high as the one before - climbs from ${m.firstRating.toFixed(1)} to ${m.lastRating.toFixed(1)}.`;
      case 'slow-burn':
        return `Second half (eps ${half + 1}–${n}) averages ${secondAvg.toFixed(1)}, vs. ${firstAvg.toFixed(1)} in the first half - a lift of ${(secondAvg - firstAvg).toFixed(1)}.`;
      case 'big-finale':
        return `Finale (Ep ${n}) lands at ${ratings[n - 1].toFixed(1)} - the season high, vs. an average of ${m.avgRating.toFixed(1)}.`;
      case 'rebound':
        return `Dips to ${min.toFixed(1)} at Ep ${minIdx + 1}, then recovers to ${m.lastRating.toFixed(1)} by the finale.`;
      case 'front-loaded':
        return `Opens strong (${m.firstRating.toFixed(1)}) then trends down to ${m.lastRating.toFixed(1)} - a drop of ${(m.firstRating - m.lastRating).toFixed(1)}.`;
      case 'declining':
        return `Each episode is rated no higher than the one before - slides from ${m.firstRating.toFixed(1)} to ${m.lastRating.toFixed(1)}.`;
      case 'bad-finale':
        return `Finale (Ep ${n}) is the season's weakest - ${ratings[n - 1].toFixed(1)} vs. an average of ${m.avgRating.toFixed(1)}.`;
      case 'rollercoaster':
        return `Range spans ${(max - min).toFixed(1)} points (${min.toFixed(1)}–${max.toFixed(1)}) - big swings episode to episode.`;
      case 'mid-peak':
        return `Peak at Ep ${maxIdx + 1} (${max.toFixed(1)}); first half avg ${firstAvg.toFixed(1)}, finale ${m.lastRating.toFixed(1)}.`;
      case 'u-shaped':
        return `Strong opener (${m.firstRating.toFixed(1)}) and finale (${m.lastRating.toFixed(1)}); midpoint dips to ${min.toFixed(1)} at Ep ${minIdx + 1}.`;
      case 'saved-best-for-last':
        return `This is the show's highest-rated season - final run averages ${m.avgRating.toFixed(1)}.`;
      case 'shape-drift':
        return `Late-run shape or quality shifted relative to earlier seasons.`;
      default:
        return null;
    }
  }

  for (const shape of m.shapes) {
    if (shape === 'consistent') continue;
    const text = sentence(shape);
    if (!text) continue;
    const p = document.createElement('span');
    p.style.display = 'block';
    const label = document.createElement('span');
    label.className = 'ann-shape';
    label.textContent = `${SHAPE_LABELS[shape] || shape} - `;
    p.append(label, document.createTextNode(text));
    el.appendChild(p);
  }
  el.hidden = el.childElementCount === 0;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

// Each provider's own search page so the user lands directly on the streamer
// instead of an aggregator. Fallback to the provider's homepage if we don't
// have a search-URL pattern for it.
const PROVIDER_URLS = {
  'Netflix':            (q) => `https://www.netflix.com/search?q=${q}`,
  'Hulu':               (q) => `https://www.hulu.com/search?q=${q}`,
  'Amazon Prime Video': (q) => `https://www.amazon.com/s?k=${q}&i=instant-video`,
  'HBO Max':            (q) => `https://www.max.com/search?q=${q}`,
  'Max':                (q) => `https://www.max.com/search?q=${q}`,
  'Disney+':            (q) => `https://www.disneyplus.com/search?q=${q}`,
  'Peacock':            (q) => `https://www.peacocktv.com/search?q=${q}`,
  'Paramount+':         (q) => `https://www.paramountplus.com/search/?searchTerm=${q}`,
  'Apple TV+':          (q) => `https://tv.apple.com/search?term=${q}`,
  'Crunchyroll':        (q) => `https://www.crunchyroll.com/search?q=${q}`,
};

// "Watch on …" deep-link on the show modal. Picks the first mainstream
// provider on the show and sends the user directly to that provider's
// search page for the title.
function syncShowModalWatchOnLink(meta) {
  const btn = els.showModalWatchOn;
  if (!btn) return;
  const provider = (meta.providers || []).find((p) => isMainstreamProvider(p));
  const urlFor = provider ? PROVIDER_URLS[provider] : null;
  if (!provider || !urlFor) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = `Watch on ${provider} →`;
  btn.title = `Search for "${meta.title}" on ${provider}`;
  btn.href = urlFor(encodeURIComponent(meta.title));
}

// Shortcut legend popover: ?-button + ? key both toggle. Click-outside +
// Escape dismiss. Tracks aria-expanded on the trigger button.
let _legendOutsideHandler = null;
function toggleShortcutLegend(forceOpen) {
  const el = els.shortcutLegend;
  const btn = els.shortcutLegendBtn;
  if (!el || !btn) return;
  const willOpen = typeof forceOpen === 'boolean' ? forceOpen : el.hidden;
  el.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    setTimeout(() => {
      _legendOutsideHandler = (e) => {
        if (el.contains(e.target) || btn.contains(e.target)) return;
        toggleShortcutLegend(false);
      };
      document.addEventListener('click', _legendOutsideHandler);
    }, 0);
  } else if (_legendOutsideHandler) {
    document.removeEventListener('click', _legendOutsideHandler);
    _legendOutsideHandler = null;
  }
}

function bindShortcutLegend() {
  if (!els.shortcutLegendBtn) return;
  els.shortcutLegendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleShortcutLegend();
  });
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
    renderFinder();
  }, 750);
});

// "Explore by mood" is a <details> that ships open (desktop shows the chips
// as a plain always-visible section; its summary is pointer-events:none
// there). On mobile the summary becomes a real toggle, collapsed by
// default. CSS alone can't force a closed <details> open (modern engines
// hide closed-details content via content-visibility, which child rules
// can't override), so the open state is synced to the viewport here.
// Both mood rails (Seasons + Show Finder) use .mood-collapsible, so sync them
// together: mobile starts collapsed behind the toggle pill, desktop expanded.
const moodCollapsibles = document.querySelectorAll('.mood-collapsible');
if (moodCollapsibles.length && typeof window.matchMedia === 'function') {
  const moodMq = window.matchMedia('(max-width: 600px)');
  const syncMoodCollapsible = () => {
    for (const el of moodCollapsibles) el.open = !moodMq.matches;
  };
  syncMoodCollapsible();
  if (typeof moodMq.addEventListener === 'function') {
    moodMq.addEventListener('change', syncMoodCollapsible);
  }
}

// Expose pure helpers for unit tests (node:vm loads this file into a sandbox
// that provides a `window` stub; same pattern as mario-kart/js/).
if (typeof window !== 'undefined') {
  window._rsTestExports = {
    computeStdDev,
    computeShowRelated,
    languagesCompatible,
    clampScrollY,
    ScrollMemory,
    buildSeasonShareText,
  };
}

load();
