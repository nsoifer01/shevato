'use strict';

const { renderCurve, escapeXml } = require('./render-curve.js');
const { showPath } = require('./slugify.js');

const SITE = 'https://shevato.com';
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w500';

// Shape descriptions doubled as alt-text for the curve and as
// human-readable copy in the season header. Mirrors the shape rules
// documented in apps/rising-seasons/README.md.
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

// Build a single static HTML page for one TV series, given every season's
// data (already grouped from data.json's flat `matches` array). Returns a
// complete HTML string.
function renderShowPage({ seriesId, title, year, type, genres, seriesRating, seriesVotes, poster, overview, language, providers, tmdbId, seasons, builtAt }) {
  const path = `/apps/rising-seasons/shows/${showPath(title, seriesId)}/`;
  const canonical = `${SITE}${path}`;
  const numberOfSeasons = seasons.length;
  const yearLabel = year ? ` (${year})` : '';
  const pageTitle = `${title}${yearLabel} — Episode Ratings & Season Trajectories | Rising Seasons`;
  const cleanOverview = (overview || '').trim();
  const description = buildDescription(title, year, numberOfSeasons, seriesRating, seriesVotes, cleanOverview);

  const posterUrl = poster ? `${TMDB_POSTER}${poster}` : null;
  const ogImage = posterUrl || `${SITE}/images/full-logo.svg`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Shevato LLC">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#0b0d12">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">

  <link rel="preconnect" href="https://image.tmdb.org" crossorigin>
  <link rel="dns-prefetch" href="https://www.google-analytics.com">

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(`${title}${yearLabel} — Episode Ratings & Season Trajectories`)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="video.tv_show">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:alt" content="${escapeHtml(`${title} poster`)}">
  <meta property="og:site_name" content="Shevato">
  <meta property="og:locale" content="en_US">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`${title}${yearLabel} — Episode Ratings`)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${ogImage}">
  <meta name="twitter:site" content="@shevato">

  <!-- Breadcrumbs -->
  <script type="application/ld+json">
${jsonLd(buildBreadcrumbs(title, path))}
  </script>

  <!-- TVSeries -->
  <script type="application/ld+json">
${jsonLd(buildTvSeriesSchema({ seriesId, title, year, canonical, posterUrl, cleanOverview, genres, seriesRating, seriesVotes, seasons, tmdbId }))}
  </script>

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📈%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/rising-seasons/css/show-page.css">

  <!-- Google Analytics — shared site tag -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-GEQGY35JJN"></script>
  <script defer src="/assets/js/analytics.js"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>

  <header class="page-header">
    <a class="brand" href="/apps/rising-seasons/" aria-label="Rising Seasons home">
      <span aria-hidden="true">📈</span> Rising Seasons
    </a>
    <nav class="page-nav" aria-label="Primary">
      <a href="/apps/rising-seasons/">Explorer</a>
      <a href="/apps/rising-seasons/shows/">All shows</a>
      <a href="/apps.html">More apps</a>
    </nav>
  </header>

  <main id="main" class="show-page">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Shevato</a> ›
      <a href="/apps/rising-seasons/">Rising Seasons</a> ›
      <a href="/apps/rising-seasons/shows/">All shows</a> ›
      <span>${escapeHtml(title)}</span>
    </nav>

    <section class="show-hero">
      ${renderHeroPoster(posterUrl, title)}
      <div class="show-meta">
        <h1>${escapeHtml(title)}${year ? ` <span class="show-year">(${year})</span>` : ''}</h1>
        ${genres && genres.length ? `<p class="show-genres">${genres.map(escapeHtml).join(' · ')}</p>` : ''}
        ${cleanOverview ? `<p class="show-overview">${escapeHtml(cleanOverview)}</p>` : ''}
        <dl class="show-stats">
          ${seriesRating ? `<div><dt>IMDb rating</dt><dd><strong>${seriesRating.toFixed(1)}</strong>${seriesVotes ? ` <span class="muted">(${seriesVotes.toLocaleString()} votes)</span>` : ''}</dd></div>` : ''}
          <div><dt>Seasons</dt><dd>${numberOfSeasons}</dd></div>
          ${providers && providers.length ? `<div><dt>Streaming (US)</dt><dd>${providers.map(escapeHtml).join(' · ')}</dd></div>` : ''}
          ${language ? `<div><dt>Language</dt><dd>${escapeHtml(language.toUpperCase())}</dd></div>` : ''}
          ${type ? `<div><dt>Type</dt><dd>${escapeHtml(formatType(type))}</dd></div>` : ''}
        </dl>
        <div class="hero-actions">
          <a class="primary-btn" href="/apps/rising-seasons/#series=${seriesId}">Open in interactive explorer →</a>
          <a class="secondary-btn" href="https://www.imdb.com/title/${seriesId}/" rel="noopener" target="_blank">View on IMDb</a>
        </div>
      </div>
    </section>

    <section class="seasons" aria-labelledby="seasons-heading">
      <h2 id="seasons-heading">Seasons</h2>
      ${seasons.map((s) => renderSeasonSection(s, seriesId)).join('\n')}
    </section>

    <section class="page-footer-meta">
      <p class="attribution">Episode ratings and vote counts from <a href="https://www.imdb.com/title/${seriesId}/" rel="noopener" target="_blank">IMDb</a>${tmdbId ? `. Poster, overview, and streaming data from <a href="https://www.themoviedb.org/tv/${tmdbId}" rel="noopener" target="_blank">TMDB</a>` : ''}. Data refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}.</p>
      <p>Want to discover more shows by their rating shape? <a href="/apps/rising-seasons/">Browse Rising Seasons →</a></p>
    </section>
  </main>

  <footer class="page-footer">
    <p>© Shevato LLC · <a href="/">shevato.com</a> · <a href="/contact.html">Contact</a></p>
  </footer>
</body>
</html>
`;
}

function renderHeroPoster(posterUrl, title) {
  if (!posterUrl) {
    return '<div class="show-poster poster-placeholder" aria-hidden="true"></div>';
  }
  return `<img class="show-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(`${title} poster`)}" width="300" height="450" loading="eager" decoding="async">`;
}

function renderSeasonSection(season, seriesId) {
  const shapes = (season.shapes || []).map((s) => SHAPE_LABELS[s] || s);
  const shapesHtml = shapes.length
    ? `<ul class="season-shapes" aria-label="Season shape classifications">${shapes
        .map((s) => `<li class="shape-badge">${escapeHtml(s)}</li>`)
        .join('')}</ul>`
    : '';
  const curveSvg = renderCurve(season.episodes, { width: 720, height: 220 });
  const yearLabel = season.seasonYear ? ` (${season.seasonYear})` : '';

  return `<article class="season-section" id="season-${season.season}">
        <header class="season-head">
          <h3>Season ${season.season}<span class="muted">${yearLabel}</span></h3>
          <p class="season-summary">
            <span><strong>${season.avgRating.toFixed(2)}</strong> avg</span>
            <span>${season.episodes.length} episodes</span>
            <span>${season.firstRating.toFixed(1)} → ${season.lastRating.toFixed(1)}</span>
            ${season.avgRuntime ? `<span>${season.avgRuntime} min avg</span>` : ''}
          </p>
          ${shapesHtml}
        </header>
        ${curveSvg}
        <table class="episode-table">
          <caption>Season ${season.season} episodes — IMDb ratings</caption>
          <thead><tr><th scope="col">#</th><th scope="col">Title</th><th scope="col">Rating</th><th scope="col">Votes</th></tr></thead>
          <tbody>
            ${season.episodes.map((ep) => `<tr><td>${ep.episode}</td><td>${escapeHtml(ep.name || '—')}</td><td><strong>${ep.rating.toFixed(1)}</strong></td><td>${ep.votes.toLocaleString()}</td></tr>`).join('\n            ')}
          </tbody>
        </table>
      </article>`;
}

function buildDescription(title, year, n, rating, votes, overview) {
  const yearLabel = year ? ` (${year})` : '';
  const ratingLabel = rating ? ` IMDb ${rating.toFixed(1)}/10${votes ? ` (${votes.toLocaleString()} votes)` : ''}.` : '';
  const seasonLabel = n === 1 ? '1 season' : `${n} seasons`;
  const lead = `${title}${yearLabel} — episode-by-episode IMDb ratings and season-shape analysis across ${seasonLabel}.${ratingLabel}`;
  if (!overview) return clip(lead, 300);
  return clip(`${lead} ${overview}`, 300);
}

function clip(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

function formatType(t) {
  if (t === 'tvSeries') return 'TV series';
  if (t === 'tvMiniSeries') return 'Mini-series';
  return t;
}

function buildBreadcrumbs(title, path) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/home.html` },
      { '@type': 'ListItem', position: 2, name: 'Apps', item: `${SITE}/apps.html` },
      { '@type': 'ListItem', position: 3, name: 'Rising Seasons', item: `${SITE}/apps/rising-seasons/` },
      { '@type': 'ListItem', position: 4, name: 'All shows', item: `${SITE}/apps/rising-seasons/shows/` },
      { '@type': 'ListItem', position: 5, name: title, item: `${SITE}${path}` },
    ],
  };
}

function buildTvSeriesSchema({ seriesId, title, year, canonical, posterUrl, cleanOverview, genres, seriesRating, seriesVotes, seasons, tmdbId }) {
  const sameAs = [`https://www.imdb.com/title/${seriesId}/`];
  if (tmdbId) sameAs.push(`https://www.themoviedb.org/tv/${tmdbId}`);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: title,
    url: canonical,
    sameAs,
    numberOfSeasons: seasons.length,
  };
  if (year) schema.startDate = String(year);
  if (cleanOverview) schema.description = cleanOverview;
  if (posterUrl) schema.image = posterUrl;
  if (genres && genres.length) schema.genre = genres;
  if (seriesRating) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: seriesRating,
      ratingCount: seriesVotes || undefined,
      bestRating: 10,
      worstRating: 1,
    };
  }
  schema.containsSeason = seasons.map((s) => ({
    '@type': 'TVSeason',
    seasonNumber: s.season,
    numberOfEpisodes: s.episodes.length,
    ...(s.seasonYear ? { startDate: String(s.seasonYear) } : {}),
  }));
  return schema;
}

function jsonLd(obj) {
  // Escape `</` so a hostile title containing `</script>` cannot break out
  // of the surrounding <script type="application/ld+json"> tag. The `\/`
  // is valid in JSON and round-trips back to `/` when parsed.
  return JSON.stringify(obj, null, 2)
    .replace(/<\/(script|style)/gi, '<\\/$1')
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { renderShowPage, escapeHtml, buildDescription, SITE };
