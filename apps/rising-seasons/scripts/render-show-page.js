'use strict';

const { renderCurve, escapeXml } = require('./render-curve.js');
const { showPath } = require('./slugify.js');
const { renderMoreFooter } = require('./render-footer.js');

const SITE = 'https://shevato.com';
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w500';

function shapeToSlug(shape) {
  if (!shape) return '';
  return shape.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

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
function renderShowPage({ seriesId, title, year, type, genres, seriesRating, seriesVotes, poster, overview, language, providers, tmdbId, cast, seasons, builtAt, dominantShape, dominantShapeSlug, relatedShows }) {
  const path = `/apps/rising-seasons/shows/${showPath(title, seriesId)}/`;
  const canonical = `${SITE}${path}`;
  const numberOfSeasons = seasons.length;
  const yearLabel = year ? ` (${year})` : '';
  const pageTitle = `${title}${yearLabel} — Episode Ratings & Season Trajectories | Rising Seasons`;
  const cleanOverview = (overview || '').trim();
  const description = buildDescription(title, year, numberOfSeasons, seriesRating, seriesVotes, cleanOverview);

  const posterUrl = poster ? `${TMDB_POSTER}${poster}` : null;
  const ogImage = posterUrl || `${SITE}/images/og-card.png`;

  const dominantShapeLabel = dominantShape ? (SHAPE_LABELS[dominantShape] || dominantShape) : null;
  const overallAvgRating = computeOverallAvgRating(seasons);

  // Feature 10: richer OG/Twitter meta
  // When a poster is available, replace the basic alt with a richer one (parens, no em dashes).
  const ogImageAlt = posterUrl
    ? escapeHtml(`${title} poster (${dominantShapeLabel || 'TV show'} shape, avg episode ${overallAvgRating})`)
    : escapeHtml(`${title} poster`);
  const ogPosterDimensions = posterUrl
    ? `\n  <meta property="og:image:width" content="500">\n  <meta property="og:image:height" content="750">` : '';
  const twitterCardMeta = dominantShapeLabel
    ? `\n  <meta name="twitter:label1" content="Shape">\n  <meta name="twitter:data1" content="${escapeHtml(dominantShapeLabel)}">\n  <meta name="twitter:label2" content="Avg episode rating">\n  <meta name="twitter:data2" content="${escapeHtml(String(overallAvgRating))}">` : '';

  // Feature 4: per-season TVSeason JSON-LD blocks
  const seasonSchemas = seasons.map((s) => buildTvSeasonSchema(s, title, canonical)).join('\n');

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
  <meta property="og:image:alt" content="${ogImageAlt}">${ogPosterDimensions}
  <meta property="og:site_name" content="Shevato">
  <meta property="og:locale" content="en_US">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`${title}${yearLabel} — Episode Ratings`)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${ogImage}">
  <meta name="twitter:site" content="@shevato">${twitterCardMeta}

  <!-- Breadcrumbs -->
  <script type="application/ld+json">
${jsonLd(buildBreadcrumbs(title, path))}
  </script>

  <!-- TVSeries -->
  <script type="application/ld+json">
${jsonLd(buildTvSeriesSchema({ seriesId, title, year, canonical, posterUrl, cleanOverview, genres, seriesRating, seriesVotes, seasons, tmdbId, cast }))}
  </script>

  <!-- TVSeason per-season rating blocks -->
${seasonSchemas}

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
    <div class="page-header-right">
      <nav class="page-nav" aria-label="Primary">
        <a href="/apps/rising-seasons/">Explorer</a>
        <a href="/apps/rising-seasons/shows/">All shows</a>
        <a href="/apps.html">More apps</a>
      </nav>
      <a class="header-launch-btn" href="/apps/rising-seasons/">Launch app →</a>
    </div>
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
          ${renderPrimaryCtaBtn(dominantShape, dominantShapeSlug)}
          <a class="app-btn" href="/apps/rising-seasons/#show=${escapeHtml(seriesId)}">Open in Rising Seasons app →</a>
          <a class="secondary-btn" href="https://www.imdb.com/title/${seriesId}/" rel="noopener" target="_blank">View on IMDb</a>
        </div>
        ${renderFreshnessLine(builtAt, seasons.length)}
      </div>
    </section>

    ${renderSeasonNav(seasons)}

    ${renderCast(cast)}

    <section class="seasons" aria-labelledby="seasons-heading">
      <h2 id="seasons-heading">Seasons</h2>
      ${seasons.map((s) => renderSeasonSection(s, seriesId)).join('\n')}
    </section>

    ${renderRelatedShows(relatedShows, dominantShape, dominantShapeSlug)}

    <section class="page-footer-meta">
      <p class="attribution">Episode ratings and vote counts from <a href="https://www.imdb.com/title/${seriesId}/" rel="noopener" target="_blank">IMDb</a>${tmdbId ? `. Poster, overview, and streaming data from <a href="https://www.themoviedb.org/tv/${tmdbId}" rel="noopener" target="_blank">TMDB</a>` : ''}. Data refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}.</p>
      <p>Want to discover more shows by their rating shape? <a href="/apps/rising-seasons/">Browse Rising Seasons →</a></p>
    </section>
  </main>

  ${renderMoreFooter()}
  ${renderStickyBanner(title, dominantShape, dominantShapeSlug)}
  ${renderScrollToTop()}
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

// Top-billed cast strip. `cast` is the array stashed on the series by
// enrich-tmdb.js — each entry is { id, name, character, profile_path }.
// Mirrors the in-app show modal's cast cards (same class names) so the
// shared .cast-* styling applies. Returns '' when there's no cast so the
// section is omitted entirely.
const TMDB_PROFILE = 'https://image.tmdb.org/t/p/w185';
function renderCast(cast) {
  if (!Array.isArray(cast) || cast.length === 0) return '';
  const cards = cast.map((person) => {
    const photo = person.profile_path
      ? `<img src="${escapeHtml(`${TMDB_PROFILE}${person.profile_path}`)}" alt="" width="90" height="135" loading="lazy" decoding="async">`
      : `<div class="cast-photo-fallback" aria-hidden="true">${escapeHtml((person.name || '?').charAt(0).toUpperCase())}</div>`;
    const inner = `<div class="cast-photo">${photo}</div>
          <span class="cast-name">${escapeHtml(person.name || '')}</span>
          ${person.character ? `<span class="cast-character">${escapeHtml(person.character)}</span>` : ''}`;
    // Whole card links to the TMDB person page when we have an id, matching
    // the app modal. Falls back to a non-interactive card otherwise.
    const body = Number.isFinite(person.id)
      ? `<a class="cast-card-inner" href="https://www.themoviedb.org/person/${person.id}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(`View ${person.name || 'cast member'} on TMDB`)}">${inner}</a>`
      : `<div class="cast-card-inner">${inner}</div>`;
    return `<li class="cast-card">${body}</li>`;
  }).join('\n      ');
  return `<section class="show-cast" aria-labelledby="cast-heading">
      <h2 id="cast-heading">Cast</h2>
      <ul class="cast-list">
      ${cards}
      </ul>
    </section>`;
}

// Feature 8: season jump nav. Only rendered when there are 4+ seasons.
function renderSeasonNav(seasons) {
  if (!seasons || seasons.length < 4) return '';
  const links = seasons
    .map((s) => `<a href="#season-${s.season}">S${s.season}</a>`)
    .join('\n    ');
  return `<nav class="season-jump-nav" aria-label="Jump to season">
    ${links}
  </nav>`;
}

function renderSeasonSection(season, seriesId) {
  const shapeEntries = (season.shapes || []).map((s) => ({ label: SHAPE_LABELS[s] || s, slug: shapeToSlug(s) }));
  const shapesHtml = shapeEntries.length
    ? `<ul class="season-shapes" aria-label="Season shape classifications">${shapeEntries
        .map((e) => `<li><a class="shape-badge" href="/apps/rising-seasons/#shape=${escapeHtml(e.slug)}" target="_blank" rel="noopener">${escapeHtml(e.label)}</a></li>`)
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

function renderPrimaryCtaBtn(dominantShape, dominantShapeSlug) {
  if (dominantShape && dominantShapeSlug) {
    const label = SHAPE_LABELS[dominantShape] || dominantShape;
    return `<a class="primary-btn" href="/apps/rising-seasons/#shape=${escapeHtml(dominantShapeSlug)}">Browse all ${escapeHtml(label)} seasons in the explorer →</a>`;
  }
  return `<a class="primary-btn" href="/apps/rising-seasons/">Browse seasons by rating shape →</a>`;
}

function renderFreshnessLine(builtAt, seasonCount) {
  const dateStr = builtAt ? new Date(builtAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const text = dateStr
    ? `Ratings refreshed ${escapeHtml(dateStr)} · ${seasonCount} season${seasonCount === 1 ? '' : 's'} indexed`
    : `Data refreshed weekly · ${seasonCount} season${seasonCount === 1 ? '' : 's'} indexed`;
  return `<p class="hero-freshness">${text}</p>`;
}

function renderRelatedShows(relatedShows, dominantShape, dominantShapeSlug) {
  if (!relatedShows || relatedShows.length === 0 || !dominantShape) return '';
  const shapeLabel = SHAPE_LABELS[dominantShape] || dominantShape;
  const cards = relatedShows.map((s) => {
    const posterEl = s.poster
      ? `<img class="rec-poster" src="${escapeHtml(`https://image.tmdb.org/t/p/w185${s.poster}`)}" alt="${escapeHtml(`${s.title} poster`)}" width="92" height="138" loading="lazy" decoding="async">`
      : `<div class="rec-poster rec-poster-placeholder" aria-hidden="true"></div>`;
    const badge = s.dominantShape
      ? `<span class="shape-badge rec-shape-badge">${escapeHtml(SHAPE_LABELS[s.dominantShape] || s.dominantShape)}</span>`
      : '';
    const yearLabel = s.year ? ` <span class="rec-year">(${s.year})</span>` : '';
    return `<a class="rec-card" href="/apps/rising-seasons/shows/${escapeHtml(s.slug)}/">
        ${posterEl}
        <div class="rec-info">
          <span class="rec-title">${escapeHtml(s.title)}${yearLabel}</span>
          ${badge}
        </div>
      </a>`;
  }).join('\n');
  return `<section class="related-shows" aria-labelledby="related-heading">
    <h2 id="related-heading">Shows like this</h2>
    <div class="rec-strip">${cards}</div>
    <p class="rec-see-all"><a href="/apps/rising-seasons/#shape=${escapeHtml(dominantShapeSlug)}">See all ${escapeHtml(shapeLabel)} seasons in the explorer →</a></p>
  </section>`;
}

function renderStickyBanner(title, dominantShape, dominantShapeSlug) {
  if (!dominantShape || !dominantShapeSlug) return '';
  const shapeLabel = SHAPE_LABELS[dominantShape] || dominantShape;
  const link = `/apps/rising-seasons/#shape=${dominantShapeSlug}`;
  return `<div class="sticky-cta-banner" id="stickyCta" hidden aria-live="polite">
    <div class="sticky-cta-inner">
      <span class="sticky-cta-title">${escapeHtml(title)}</span>
      <span class="shape-badge sticky-cta-badge">${escapeHtml(shapeLabel)}</span>
      <a class="primary-btn sticky-cta-btn" href="${escapeHtml(link)}">Explore by shape in the app</a>
      <button type="button" class="sticky-cta-close" aria-label="Dismiss banner" onclick="sessionStorage.setItem('rs-cta-banner-dismissed','1');document.getElementById('stickyCta').hidden=true;document.body.style.paddingBottom='';var p=document.getElementById('pageScrollTop');if(p)p.style.bottom=''">×</button>
    </div>
  </div>
  <script>
  (function () {
    if (sessionStorage.getItem('rs-cta-banner-dismissed') === '1') return;
    var banner = document.getElementById('stickyCta');
    var hero = document.querySelector('.show-hero');
    if (!banner || !hero) return;
    var shown = false;
    function check() {
      if (!shown && window.scrollY > hero.offsetHeight) {
        shown = true;
        banner.hidden = false;
        document.body.style.paddingBottom = banner.offsetHeight + 'px';
      }
    }
    window.addEventListener('scroll', check, { passive: true });
    check();
  })();
  </script>`;
}

// Feature 4: build a TVSeason JSON-LD block with aggregateRating.
function buildTvSeasonSchema(season, seriesTitle, seriesCanonical) {
  const ratingCount = (season.episodes || []).reduce((sum, ep) => sum + (ep.votes || 0), 0);
  const ratingValue = parseFloat(season.avgRating.toFixed(1));
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'TVSeason',
    name: `${seriesTitle} Season ${season.season}`,
    seasonNumber: season.season,
    url: `${seriesCanonical}#season-${season.season}`,
    partOfSeries: {
      '@type': 'TVSeries',
      url: seriesCanonical,
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: String(ratingValue),
      ratingCount,
      bestRating: 10,
      worstRating: 1,
    },
  };
  return `  <script type="application/ld+json">\n${jsonLd(schema)}\n  </script>`;
}

// Compute mean avgRating across all seasons (weighted by episode count).
function computeOverallAvgRating(seasons) {
  if (!seasons || seasons.length === 0) return '0.0';
  let totalWeight = 0;
  let weightedSum = 0;
  for (const s of seasons) {
    const epCount = (s.episodes || []).length || 1;
    weightedSum += s.avgRating * epCount;
    totalWeight += epCount;
  }
  return (weightedSum / totalWeight).toFixed(1);
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

function buildTvSeriesSchema({ seriesId, title, year, canonical, posterUrl, cleanOverview, genres, seriesRating, seriesVotes, seasons, tmdbId, cast }) {
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
  if (Array.isArray(cast) && cast.length) {
    schema.actor = cast.map((p) => {
      const person = { '@type': 'Person', name: p.name };
      if (Number.isFinite(p.id)) person.sameAs = `https://www.themoviedb.org/person/${p.id}`;
      return person;
    });
  }
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

function renderScrollToTop() {
  return `<button
    type="button"
    class="page-scroll-top"
    id="pageScrollTop"
    aria-label="Scroll back to top"
    title="Back to top"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 10.5 L8 5.5 L13 10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    Top
  </button>
  <script>
  (function () {
    var btn = document.getElementById('pageScrollTop');
    if (!btn) return;
    // Ride above the sticky CTA banner while it is visible; both elements
    // are fixed to the bottom and would otherwise overlap at the right
    // edge (the pill could cover the CTA's dismiss button).
    function liftAboveCta() {
      var cta = document.getElementById('stickyCta');
      if (cta && !cta.hidden) {
        btn.style.bottom = (cta.offsetHeight + 16) + 'px';
      } else {
        btn.style.bottom = '';
      }
    }
    window.addEventListener('scroll', function () {
      liftAboveCta();
      if (window.scrollY >= 400) {
        btn.classList.add('page-scroll-top--visible');
      } else {
        btn.classList.remove('page-scroll-top--visible');
      }
    }, { passive: true });
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  })();
  </script>`;
}

function jsonLd(obj) {
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

module.exports = { renderShowPage, escapeHtml, buildDescription, shapeToSlug, SITE, buildTvSeasonSchema, renderSeasonNav };
