'use strict';

const SHAPE_LABELS = {
  rising: 'Rising',
  consistent: 'Consistent',
  'slow-burn': 'Slow burn',
  'big-finale': 'Big finale',
  rebound: 'Rebound',
};

const STORAGE_NS = 'imdb-rising';
const KEY_WATCHED = `${STORAGE_NS}:watched`;
const KEY_VIEW = `${STORAGE_NS}:view`;
const PAGE_SIZE = 60;
const STALE_DAYS = 30;

// --- DOM refs ---

const els = {
  shapes: document.getElementById('shapes'),
  search: document.getElementById('search'),
  minEpisodes: document.getElementById('minEpisodes'),
  minVotes: document.getElementById('minVotes'),
  minYear: document.getElementById('minYear'),
  maxYear: document.getElementById('maxYear'),
  watchedFilter: document.getElementById('watchedFilter'),
  sort: document.getElementById('sort'),
  surprise: document.getElementById('surprise'),
  resetFilters: document.getElementById('resetFilters'),
  genres: document.getElementById('genres'),
  results: document.getElementById('results'),
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
  viewToggle: document.querySelector('.view-toggle'),
};

// --- mutable state ---

const state = {
  shape: 'all',
  search: '',
  minEpisodes: 4,
  minVotes: 1000,
  minYear: null,
  maxYear: null,
  sort: 'popularity',
  watched: 'all',
  genres: new Set(),
  view: 'grid',
};

let dataset = null;
let filtered = [];
let renderedCount = 0;
let lazyObserver = null;
let modalState = { season: null, lastFocus: null };

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
  state.view = ViewPref.load();
  applyViewClasses();
  applyStateFromURL();
  warnIfStale();
  renderShapeCounts();
  renderGenreChips();
  bindEvents();
  bindKeyboard();
  render();
}

// --- URL state ---

function applyStateFromURL() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (p.has('shape')) state.shape = p.get('shape');
  if (p.has('q')) state.search = p.get('q');
  if (p.has('minEps')) state.minEpisodes = parseInt(p.get('minEps'), 10) || state.minEpisodes;
  if (p.has('minVotes')) state.minVotes = parseInt(p.get('minVotes'), 10) || state.minVotes;
  if (p.has('minYear')) state.minYear = parseInt(p.get('minYear'), 10) || null;
  if (p.has('maxYear')) state.maxYear = parseInt(p.get('maxYear'), 10) || null;
  if (p.has('sort')) state.sort = p.get('sort');
  if (p.has('watched')) state.watched = p.get('watched');
  if (p.has('g')) state.genres = new Set(p.get('g').split(',').filter(Boolean));

  els.search.value = state.search;
  els.minEpisodes.value = state.minEpisodes;
  els.minVotes.value = state.minVotes;
  els.minYear.value = state.minYear ?? '';
  els.maxYear.value = state.maxYear ?? '';
  els.sort.value = state.sort;
  els.watchedFilter.value = state.watched;
  for (const btn of els.shapes.querySelectorAll('.shape-chip')) {
    btn.setAttribute('aria-pressed', btn.dataset.shape === state.shape ? 'true' : 'false');
  }
  for (const chip of els.genres.querySelectorAll('.genre-chip')) {
    chip.setAttribute('aria-pressed', state.genres.has(chip.dataset.genre) ? 'true' : 'false');
  }
}

function writeStateToURL() {
  const p = new URLSearchParams();
  if (state.shape !== 'all') p.set('shape', state.shape);
  if (state.search) p.set('q', state.search);
  if (state.minEpisodes !== 4) p.set('minEps', state.minEpisodes);
  if (state.minVotes !== 1000) p.set('minVotes', state.minVotes);
  if (state.minYear) p.set('minYear', state.minYear);
  if (state.maxYear) p.set('maxYear', state.maxYear);
  if (state.sort !== 'popularity') p.set('sort', state.sort);
  if (state.watched !== 'all') p.set('watched', state.watched);
  if (state.genres.size) p.set('g', [...state.genres].join(','));
  const hash = p.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
}

// --- shape counts + genre chips ---

function renderShapeCounts() {
  const counts = dataset.shapeCounts || {};
  for (const span of els.shapes.querySelectorAll('[data-count]')) {
    const key = span.dataset.count;
    const n = key === 'all' ? dataset.count : (counts[key] || 0);
    span.textContent = n.toLocaleString();
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
    btn.setAttribute('aria-pressed', state.genres.has(g.name) ? 'true' : 'false');
    btn.textContent = g.name;
    btn.addEventListener('click', () => {
      if (state.genres.has(g.name)) state.genres.delete(g.name);
      else state.genres.add(g.name);
      btn.setAttribute('aria-pressed', state.genres.has(g.name) ? 'true' : 'false');
      writeStateToURL();
      render();
    });
    frag.appendChild(btn);
  }
  els.genres.replaceChildren(frag);
}

// --- filter + sort ---

function filterAndSort() {
  const q = state.search.trim().toLowerCase();
  const minEps = state.minEpisodes;
  const minVotes = state.minVotes;
  const { minYear, maxYear, watched: watchedFilter } = state;
  const wantGenres = state.genres;

  let rows = dataset.matches.filter((m) => {
    if (state.shape !== 'all' && !m.shapes.includes(state.shape)) return false;
    if (m.episodes.length < minEps) return false;
    if (m.minVotes < minVotes) return false;
    if (minYear && m.year && m.year < minYear) return false;
    if (maxYear && m.year && m.year > maxYear) return false;
    if (q && !m.title.toLowerCase().includes(q)) return false;
    if (wantGenres.size) {
      let ok = false;
      for (const g of m.genres) if (wantGenres.has(g)) { ok = true; break; }
      if (!ok) return false;
    }
    if (watchedFilter !== 'all') {
      const isWatched = Watched.has(m);
      if (watchedFilter === 'watched' && !isWatched) return false;
      if (watchedFilter === 'unwatched' && isWatched) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    switch (state.sort) {
      case 'length': return b.episodes.length - a.episodes.length;
      case 'climb':  return (b.lastRating - b.firstRating) - (a.lastRating - a.firstRating);
      case 'finale': return b.lastRating - a.lastRating;
      case 'avg':    return b.avgRating - a.avgRating;
      case 'recent': return (b.year || 0) - (a.year || 0);
      case 'popularity':
      default:       return b.minVotes - a.minVotes;
    }
  });

  return rows;
}

// --- render ---

function render() {
  filtered = filterAndSort();
  renderedCount = 0;
  els.results.replaceChildren();
  disconnectLazy();

  renderStatsBar();
  els.meta.textContent = `${filtered.length.toLocaleString()} of ${dataset.count.toLocaleString()} seasons match your filters`;

  if (filtered.length === 0) {
    showEmptyState();
    els.footerMeta.textContent = '';
    return;
  }

  renderNextPage();
  els.footerMeta.textContent = `Built ${new Date(dataset.builtAt).toLocaleDateString()} · ${dataset.count.toLocaleString()} seasons indexed across all of IMDb`;
}

function renderNextPage() {
  const end = Math.min(renderedCount + PAGE_SIZE, filtered.length);
  const frag = document.createDocumentFragment();
  for (let i = renderedCount; i < end; i++) {
    frag.appendChild(buildItem(filtered[i]));
  }
  els.results.appendChild(frag);
  renderedCount = end;

  // (Re)create the sentinel that triggers the next page.
  let sentinel = els.results.querySelector('.lazy-sentinel');
  if (sentinel) sentinel.remove();
  if (renderedCount < filtered.length) {
    sentinel = document.createElement('div');
    sentinel.className = 'lazy-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
    els.results.appendChild(sentinel);
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) renderNextPage();
      }, { rootMargin: '600px 0px' });
    }
    lazyObserver.observe(sentinel);
  } else if (lazyObserver) {
    disconnectLazy();
  }
}

function disconnectLazy() {
  if (lazyObserver) {
    lazyObserver.disconnect();
    lazyObserver = null;
  }
}

function buildItem(m) {
  return state.view === 'list' ? buildRow(m) : buildCard(m);
}

function showEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty';
  div.innerHTML = '<p>No seasons match these filters.</p><p>Try lowering minimum votes, removing genre filters, or pressing Reset.</p>';
  els.results.appendChild(div);
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
  div.innerHTML = `
    <p>Couldn't load season data.</p>
    <p style="font-size:0.85em;color:var(--muted-2);">${escapeHtml(err.message || String(err))}</p>
    <button type="button" class="retry-btn">Retry</button>
  `;
  div.querySelector('.retry-btn').addEventListener('click', load);
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
    warn.title = `Data is over ${STALE_DAYS} days old. Re-run npm run build:imdb-rising or wait for the weekly auto-refresh.`;
    warn.textContent = '⚠ data may be outdated';
    frag.appendChild(warn);
  }

  els.statsBar.replaceChildren(frag);
}

function stat(html) {
  const span = document.createElement('span');
  span.innerHTML = html;
  return span;
}

// --- card builder (grid view) ---

function buildCard(m) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);

  node.querySelector('.card-title').textContent = m.title;
  node.querySelector('.card-season').textContent = `S${m.season} · ${m.episodes.length} eps`;
  node.querySelector('.card-year').textContent = m.year || 'year unknown';
  node.querySelector('.card-genres').textContent = m.genres.slice(0, 3).join(' · ');

  const shapesEl = node.querySelector('.card-shapes');
  for (const s of m.shapes) {
    const tag = document.createElement('span');
    tag.className = 'shape-tag' + (s === state.shape ? ' active' : '');
    tag.textContent = SHAPE_LABELS[s] || s;
    shapesEl.appendChild(tag);
  }

  drawCurve(node.querySelector('.curve'), m.episodes, 300, 80);

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr})`;
  node.querySelector('.stat-avg').textContent = `avg ${m.avgRating.toFixed(1)}`;
  node.querySelector('.stat-votes').textContent = `${m.minVotes.toLocaleString()}+ votes/ep`;
  node.querySelector('.card-overview').textContent = m.overview || '';

  const posterEl = node.querySelector('.card-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w500${m.poster}`;
    img.alt = '';
    img.loading = 'lazy';
    posterEl.appendChild(img);
  }

  applyWatchedState(node, node.querySelector('.watch-toggle'), m);

  // Card click → modal; watch button click → toggle (and stop propagation).
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
  node.querySelector('.row-year').textContent = m.year || '';

  const shapesEl = node.querySelector('.row-shapes');
  for (const s of m.shapes) {
    const tag = document.createElement('span');
    tag.className = 'shape-tag' + (s === state.shape ? ' active' : '');
    tag.textContent = SHAPE_LABELS[s] || s;
    shapesEl.appendChild(tag);
  }

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr})`;
  node.querySelector('.stat-avg').textContent = `avg ${m.avgRating.toFixed(1)}`;
  node.querySelector('.stat-votes').textContent = `${m.minVotes.toLocaleString()}+ votes/ep`;

  drawCurve(node.querySelector('.row-curve'), m.episodes, 200, 56);

  const posterEl = node.querySelector('.row-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w185${m.poster}`;
    img.alt = '';
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
  // Re-filter if we're hiding watched/unwatched, the card may need to leave.
  if (state.watched !== 'all') render();
}

// --- curve drawing (shared) ---

function drawCurve(svg, episodes, W, H) {
  const pad = 6;
  const ratings = episodes.map((e) => e.rating);
  const lo = Math.max(0, Math.min(...ratings) - 0.3);
  const hi = Math.min(10, Math.max(...ratings) + 0.3);
  const span = Math.max(0.1, hi - lo);
  const n = episodes.length;
  const xStep = n > 1 ? (W - pad * 2) / (n - 1) : 0;

  const points = episodes.map((e, i) => {
    const x = pad + (n > 1 ? i * xStep : (W - pad * 2) / 2);
    const y = pad + (1 - (e.rating - lo) / span) * (H - pad * 2);
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

// --- modal ---

function openModal(m) {
  modalState.season = m;
  modalState.lastFocus = document.activeElement;

  els.modalTitle.textContent = m.title;
  const yearStr = m.year ? ` · ${m.year}` : '';
  els.modalSubtitle.textContent = `Season ${m.season} · ${m.episodes.length} episodes${yearStr} · ${m.genres.join(', ') || 'No genre listed'}`;

  const shapesEl = els.modalShapes;
  shapesEl.replaceChildren();
  for (const s of m.shapes) {
    const tag = document.createElement('span');
    tag.className = 'shape-tag' + (s === state.shape ? ' active' : '');
    tag.textContent = SHAPE_LABELS[s] || s;
    shapesEl.appendChild(tag);
  }

  const climb = m.lastRating - m.firstRating;
  const climbStr = climb >= 0 ? `+${climb.toFixed(1)}` : climb.toFixed(1);
  els.modalStats.textContent =
    `Climb ${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr}) · ` +
    `avg ${m.avgRating.toFixed(1)} · ${m.minVotes.toLocaleString()}+ votes/episode`;

  els.modalOverview.textContent = m.overview || '';

  // Poster.
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

  // Episode list.
  const epFrag = document.createDocumentFragment();
  for (const e of m.episodes) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'ep-number';
    num.textContent = `Ep ${e.episode}`;
    const rating = document.createElement('span');
    rating.className = 'ep-rating';
    rating.textContent = `★ ${e.rating.toFixed(1)}`;
    const votes = document.createElement('span');
    votes.className = 'ep-votes';
    votes.textContent = `${e.votes.toLocaleString()} votes`;
    li.append(num, rating, votes);
    epFrag.appendChild(li);
  }
  els.modalEpisodes.replaceChildren(epFrag);

  els.modalImdb.href = `https://www.imdb.com/title/${m.seriesId}/episodes/?season=${m.season}`;
  syncModalWatchBtn();

  els.modal.hidden = false;
  els.modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  // Focus close button after the next paint so the modal is visible.
  requestAnimationFrame(() => {
    const close = els.modal.querySelector('.modal-close');
    if (close) close.focus();
  });
}

function closeModal() {
  if (els.modal.hidden) return;
  els.modal.hidden = true;
  els.modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (modalState.lastFocus && typeof modalState.lastFocus.focus === 'function') {
    modalState.lastFocus.focus();
  }
  modalState.season = null;
  modalState.lastFocus = null;
}

function syncModalWatchBtn() {
  if (!modalState.season) return;
  const isWatched = Watched.has(modalState.season);
  els.modalWatchBtn.classList.toggle('is-watched', isWatched);
  els.modalWatchBtn.textContent = isWatched ? '✓ Watched' : 'Mark as watched';
}

function trapModalFocus(e) {
  if (els.modal.hidden || e.key !== 'Tab') return;
  const focusable = els.modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
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
      `Run npm run build:imdb-rising or wait for the next scheduled refresh.`,
    );
  }
}

// --- events ---

function onChange() {
  state.search = els.search.value.trim();
  state.minEpisodes = parseInt(els.minEpisodes.value, 10) || 1;
  state.minVotes = parseInt(els.minVotes.value, 10) || 0;
  state.minYear = parseInt(els.minYear.value, 10) || null;
  state.maxYear = parseInt(els.maxYear.value, 10) || null;
  state.sort = els.sort.value;
  state.watched = els.watchedFilter.value;
  writeStateToURL();
  render();
}

function bindEvents() {
  for (const btn of els.shapes.querySelectorAll('.shape-chip')) {
    btn.addEventListener('click', () => {
      state.shape = btn.dataset.shape;
      for (const b of els.shapes.querySelectorAll('.shape-chip')) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      }
      writeStateToURL();
      render();
    });
  }

  for (const id of ['search', 'minEpisodes', 'minVotes', 'minYear', 'maxYear', 'sort', 'watchedFilter']) {
    els[id].addEventListener('input', onChange);
    els[id].addEventListener('change', onChange);
  }

  els.surprise.addEventListener('click', () => {
    if (filtered.length === 0) return;
    const pick = filtered[Math.floor(Math.random() * Math.min(filtered.length, 50))];
    openModal(pick);
  });

  els.resetFilters.addEventListener('click', () => {
    state.shape = 'all';
    state.search = '';
    state.minEpisodes = 4;
    state.minVotes = 1000;
    state.minYear = null;
    state.maxYear = null;
    state.sort = 'popularity';
    state.watched = 'all';
    state.genres = new Set();
    els.search.value = '';
    els.minEpisodes.value = 4;
    els.minVotes.value = 1000;
    els.minYear.value = '';
    els.maxYear.value = '';
    els.sort.value = 'popularity';
    els.watchedFilter.value = 'all';
    for (const b of els.shapes.querySelectorAll('.shape-chip')) {
      b.setAttribute('aria-pressed', b.dataset.shape === 'all' ? 'true' : 'false');
    }
    for (const c of els.genres.querySelectorAll('.genre-chip')) {
      c.setAttribute('aria-pressed', 'false');
    }
    writeStateToURL();
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

  // Modal close handlers.
  for (const closer of els.modal.querySelectorAll('[data-close="modal"]')) {
    closer.addEventListener('click', closeModal);
  }

  els.modalWatchBtn.addEventListener('click', () => {
    if (!modalState.season) return;
    Watched.toggle(modalState.season);
    syncModalWatchBtn();
    renderStatsBar();
    // Re-render so the card behind the modal reflects the new watched state.
    render();
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Slash focuses search (unless already typing).
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    // Escape: close modal first, otherwise clear search.
    if (e.key === 'Escape') {
      if (!els.modal.hidden) {
        closeModal();
      } else if (document.activeElement === els.search && els.search.value) {
        els.search.value = '';
        onChange();
      }
      return;
    }
    if (!els.modal.hidden) trapModalFocus(e);
  });
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// --- utilities ---

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

load();
