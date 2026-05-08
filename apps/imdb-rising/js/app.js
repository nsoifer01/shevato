'use strict';

const SHAPE_LABELS = {
  rising: 'Rising',
  consistent: 'Consistent',
  'slow-burn': 'Slow burn',
  'big-finale': 'Big finale',
  rebound: 'Rebound',
};

const els = {
  shapes: document.getElementById('shapes'),
  search: document.getElementById('search'),
  minEpisodes: document.getElementById('minEpisodes'),
  minVotes: document.getElementById('minVotes'),
  minYear: document.getElementById('minYear'),
  maxYear: document.getElementById('maxYear'),
  sort: document.getElementById('sort'),
  surprise: document.getElementById('surprise'),
  genres: document.getElementById('genres'),
  results: document.getElementById('results'),
  meta: document.getElementById('meta'),
  footerMeta: document.getElementById('footer-meta'),
  template: document.getElementById('card-template'),
};

const state = {
  shape: 'all',
  search: '',
  minEpisodes: 4,
  minVotes: 1000,
  minYear: null,
  maxYear: null,
  sort: 'popularity',
  genres: new Set(),
};

let dataset = null;
let filtered = [];

// --- bootstrap ---

async function load() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dataset = await res.json();
  } catch (err) {
    showEmpty(
      `<p>No <code>data.json</code> yet. Run the build:</p>` +
      `<pre>npm run build:imdb-rising</pre>` +
      `<p>See <code>apps/imdb-rising/README.md</code> for setup.</p>`,
    );
    return;
  }
  renderShapeCounts();
  renderGenreChips();
  applyStateFromURL();
  bindEvents();
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
  if (p.has('g')) state.genres = new Set(p.get('g').split(',').filter(Boolean));

  // Reflect into form inputs.
  els.search.value = state.search;
  els.minEpisodes.value = state.minEpisodes;
  els.minVotes.value = state.minVotes;
  els.minYear.value = state.minYear ?? '';
  els.maxYear.value = state.maxYear ?? '';
  els.sort.value = state.sort;
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
  if (state.genres.size) p.set('g', [...state.genres].join(','));
  const hash = p.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
}

// --- chip + genre rendering ---

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
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = g.name;
    btn.addEventListener('click', () => {
      if (state.genres.has(g.name)) state.genres.delete(g.name);
      else state.genres.add(g.name);
      btn.setAttribute('aria-pressed', state.genres.has(g.name) ? 'true' : 'false');
      onChange();
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
  const minYear = state.minYear;
  const maxYear = state.maxYear;
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

// --- rendering ---

function render() {
  filtered = filterAndSort();
  els.meta.textContent = `${filtered.length.toLocaleString()} of ${dataset.count.toLocaleString()} seasons match your filters`;

  if (filtered.length === 0) {
    showEmpty('<p>No seasons match these filters. Try lowering minimum votes or removing genre filters.</p>');
    els.footerMeta.textContent = '';
    return;
  }

  const max = Math.min(filtered.length, 200);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < max; i++) frag.appendChild(buildCard(filtered[i]));
  els.results.replaceChildren(frag);

  els.footerMeta.textContent = max < filtered.length
    ? `Showing top ${max}. Refine filters to narrow further. · Built ${new Date(dataset.builtAt).toLocaleDateString()}`
    : `Built ${new Date(dataset.builtAt).toLocaleDateString()}`;
}

function showEmpty(html) {
  els.results.innerHTML = `<div class="empty">${html}</div>`;
}

function buildCard(m) {
  const node = els.template.content.firstElementChild.cloneNode(true);

  node.querySelector('.card-title').textContent = m.title;
  node.querySelector('.card-season').textContent = `S${m.season} · ${m.episodes.length} eps`;
  node.querySelector('.card-year').textContent = m.year || 'year unknown';
  node.querySelector('.card-genres').textContent = m.genres.slice(0, 3).join(' · ');

  // Shape tags — highlight the active one.
  const shapesEl = node.querySelector('.card-shapes');
  for (const s of m.shapes) {
    const tag = document.createElement('span');
    tag.className = 'shape-tag' + (s === state.shape ? ' active' : '');
    tag.textContent = SHAPE_LABELS[s] || s;
    shapesEl.appendChild(tag);
  }

  drawCurve(node.querySelector('.curve'), m.episodes);

  const climb = (m.lastRating - m.firstRating).toFixed(1);
  const climbStr = climb >= 0 ? `+${climb}` : climb;
  node.querySelector('.stat-climb').textContent = `${m.firstRating.toFixed(1)} → ${m.lastRating.toFixed(1)} (${climbStr})`;
  node.querySelector('.stat-avg').textContent = `avg ${m.avgRating.toFixed(1)}`;
  node.querySelector('.stat-votes').textContent = `${m.minVotes.toLocaleString()}+ votes/ep`;

  node.querySelector('.card-overview').textContent = m.overview || '';

  // Poster: TMDB-enriched if present, otherwise gradient fallback.
  const posterEl = node.querySelector('.card-poster');
  if (m.poster) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w500${m.poster}`;
    img.alt = '';
    img.loading = 'lazy';
    posterEl.appendChild(img);
  }

  const link = node.querySelector('.card-imdb');
  link.href = `https://www.imdb.com/title/${m.seriesId}/episodes/?season=${m.season}`;

  return node;
}

function drawCurve(svg, episodes) {
  const W = 300;
  const H = 80;
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
  dots.replaceChildren();
  for (let i = 0; i < points.length; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', points[i][0].toFixed(1));
    c.setAttribute('cy', points[i][1].toFixed(1));
    c.setAttribute('r', '2.5');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `Ep ${episodes[i].episode}: ${episodes[i].rating.toFixed(1)} · ${episodes[i].votes.toLocaleString()} votes`;
    c.appendChild(title);
    dots.appendChild(c);
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

  for (const id of ['search', 'minEpisodes', 'minVotes', 'minYear', 'maxYear', 'sort']) {
    els[id].addEventListener('input', onChange);
    els[id].addEventListener('change', onChange);
  }

  els.surprise.addEventListener('click', () => {
    if (filtered.length === 0) return;
    const pick = filtered[Math.floor(Math.random() * Math.min(filtered.length, 50))];
    // Re-render with just this pick so the user can focus.
    els.results.replaceChildren(buildCard(pick));
    els.results.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

load();
