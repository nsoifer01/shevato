'use strict';

const { renderCurve, escapeXml } = require('./render-curve.js');
const { showPath } = require('./slugify.js');
const { renderMoreFooter } = require('./render-footer.js');
// Shape classification is shared with the browser Finder so the static pages
// and the app can never label the same show differently. deriveShowShapes owns
// the definition; detectShapes is the per-episode classifier it runs over the
// per-season averages. Neither module requires this one, so no cycle.
const { deriveShowShapes } = require('./finder-lib.js');
const { detectShapes } = require('./match.js');

const SITE = 'https://shevato.com';
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w500';

function shapeToSlug(shape) {
  if (!shape) return '';
  return shape.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Shape descriptions doubled as alt-text for the curve and as
// human-readable copy in the season header. Mirrors the shape rules
// documented in apps/rising-shows/README.md.
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

// The one hub that ranks by a metric instead of by shape membership: shows
// whose episodes average higher than the series' own IMDb rating. Lives next
// to the shape hubs under /shows/shape/ and is defined here (rather than in
// render-shape-hub.js) so show pages can link to it without a require cycle.
const GAP_HUB_SLUG = 'outshines-reputation';
const GAP_HUB_LABEL = 'Outshines its reputation';

// One-line plain-English definition per shape, kept verbatim in sync with
// SHAPE_DESCS in js/app.js so the static shape hubs describe a shape the
// same way the in-app chips do.
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
  'shape-drift': 'Rating pattern or quality changed significantly late in the run',
};

// The show's whole-run trajectory shape, from the SAME derivation the browser
// Finder uses (finder-lib's deriveShowShapes, also called by buildShowAgg), so
// a page's badge, its hub membership and the app's shape chips can never
// disagree. Returns nulls when the show has no shape at all. Drives the show
// page's CTA/recommendations and the per-shape hub membership.
//
// This used to read the FIRST shape of the show's single highest-rated season,
// which is the shape of the EPISODES inside that one season, not of the show.
// The two answered different questions and disagreed on 83.5% of the catalogue
// (6,497 of 7,780 shows where both produced a label). Game of Thrones read
// "slow-burn" here and "front-loaded, bad-finale, shape-drift" in the app;
// Stranger Things read "big-finale" against the app's "bad-finale", an
// outright contradiction. Because this function also decides hub membership,
// /shows/shape/big-finale/ was listing 1,915 of 5,411 shows that the app's own
// big-finale filter would reject, so visitors arriving from search hit a
// filtered view missing a third of what they had just been shown.
//
// `shapes[0]` is the dominant one: deriveShowShapes returns trajectory shapes
// before categorical tags, so a show with a real trajectory is filed under it
// and only tag-only shows (a single season that saved its best for last) land
// on a categorical hub.
function computeDominantShape(show) {
  const seasons = show.seasons || [];
  const seasonAvgs = seasons
    .map((s) => s.avgRating)
    .filter((r) => typeof r === 'number');
  const categoricalTags = new Set();
  for (const s of seasons) {
    for (const t of (s.shapes || [])) categoricalTags.add(t);
  }
  const shapes = deriveShowShapes(seasonAvgs, categoricalTags, detectShapes);
  const shape = shapes[0];
  if (!shape) return { dominantShape: null, dominantShapeSlug: null };
  return { dominantShape: shape, dominantShapeSlug: shapeToSlug(shape) };
}

// --- sensitive (adult) posters ---
// Titles carrying the IMDb "Adult" genre get their poster blurred behind a
// CSS-only (checkbox) reveal - these static pages ship no app JS, so the
// reveal must not depend on it. Social/search previews can't be blurred, so
// the OG/Twitter/JSON-LD image is swapped for the neutral site card instead.
function isAdultGenres(genres) {
  return Array.isArray(genres) && genres.includes('Adult');
}

// Small corner "sensitive" flag (eye-off icon).
const REVEAL_BADGE =
  '<span class="poster-reveal-badge" aria-hidden="true">'
  + '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/>'
  + '<path d="M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61"/>'
  + '<path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><line x1="2" y1="2" x2="22" y2="22"/>'
  + '</svg></span>';

// Wrap an <img> HTML string in a blur + reveal overlay: a small corner badge
// flags the content and (for non-compact posters) a centred "Tap to reveal"
// pill is the action. `id` must be unique per page (drives the checkbox/label
// pair); `compact` drops the pill for small thumbnails (badge only).
function wrapSensitivePoster(imgHtml, id, compact) {
  return `<span class="poster-sensitive${compact ? ' poster-sensitive-sm' : ''}">`
    + `<input type="checkbox" class="poster-reveal-toggle" id="${escapeHtml(id)}">`
    + imgHtml
    + `<label class="poster-reveal" for="${escapeHtml(id)}">`
    + REVEAL_BADGE
    + (compact ? '' : '<span class="poster-reveal-cta">Tap to reveal</span>')
    + '</label></span>';
}

// Build a single static HTML page for one TV series, given every season's
// data (already grouped from data.json's flat `matches` array). Returns a
// complete HTML string.
function renderShowPage({ seriesId, title, year, type, genres, seriesRating, seriesVotes, poster, overview, language, providers, tmdbId, cast, seasons, builtAt, dominantShape, dominantShapeSlug, relatedShows, inSitemap = true, inGapHub = false }) {
  const path = `/apps/rising-shows/shows/${showPath(title, seriesId)}/`;
  const canonical = `${SITE}${path}`;
  const numberOfSeasons = seasons.length;
  const yearLabel = year ? ` (${year})` : '';
  const pageTitle = `${title}${yearLabel} - Episode Ratings & Season Trajectories | Rising Shows`;
  // Only curated (sitemap-listed) pages ask to be indexed. The long tail
  // keeps noindex,FOLLOW so its links still pass equity to curated pages
  // while Google drains ~60k thin pages out of "Crawled - not indexed".
  const robots = inSitemap
    ? 'index, follow, max-image-preview:large'
    : 'noindex, follow';
  const cleanOverview = (overview || '').trim();
  const description = buildDescription(title, year, numberOfSeasons, seriesRating, seriesVotes, cleanOverview);

  const posterUrl = poster ? `${TMDB_POSTER}${poster}` : null;
  const isAdult = isAdultGenres(genres);
  // Adult posters are never exposed in link/search previews (which can't be
  // blurred) - fall back to the neutral site card instead.
  const exposePoster = !!posterUrl && !isAdult;
  const ogImage = exposePoster ? posterUrl : `${SITE}/images/og-card.png`;

  const dominantShapeLabel = dominantShape ? (SHAPE_LABELS[dominantShape] || dominantShape) : null;
  const overallAvgRating = computeOverallAvgRating(seasons);

  // Feature 10: richer OG/Twitter meta
  // When a real poster is exposed, use a richer alt; otherwise describe the
  // neutral fallback card (no poster wording, since none is shown).
  const ogImageAlt = exposePoster
    ? escapeHtml(`${title} poster (${dominantShapeLabel || 'TV show'} shape, avg episode ${overallAvgRating})`)
    : escapeHtml(`${title} on Rising Shows`);
  const ogPosterDimensions = exposePoster
    ? `\n  <meta property="og:image:width" content="500">\n  <meta property="og:image:height" content="750">`
    : `\n  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">`;
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
  <meta name="robots" content="${robots}">
  <meta name="theme-color" content="#0b0d12">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">

  <link rel="preconnect" href="https://image.tmdb.org" crossorigin>
  <link rel="dns-prefetch" href="https://www.google-analytics.com">

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(`${title}${yearLabel} - Episode Ratings & Season Trajectories`)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="video.tv_show">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:alt" content="${ogImageAlt}">${ogPosterDimensions}
  <meta property="og:site_name" content="Shevato">
  <meta property="og:locale" content="en_US">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`${title}${yearLabel} - Episode Ratings`)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${ogImage}">
  <meta name="twitter:site" content="@shevato">${twitterCardMeta}

  <!-- Breadcrumbs -->
  <script type="application/ld+json">
${jsonLd(buildBreadcrumbs(title, path))}
  </script>

  <!-- TVSeries -->
  <script type="application/ld+json">
${jsonLd(buildTvSeriesSchema({ seriesId, title, year, canonical, posterUrl: exposePoster ? posterUrl : null, cleanOverview, genres, seriesRating, seriesVotes, seasons, tmdbId, cast }))}
  </script>

  <!-- TVSeason per-season rating blocks -->
${seasonSchemas}

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📈%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/rising-shows/css/show-page.css">
  <link rel="stylesheet" href="/assets/css/back-to-top.css">

  <!-- Google Analytics - shared site tag -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-GEQGY35JJN"></script>
  <script defer src="/assets/js/analytics.js"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>

  <header class="page-header">
    <a class="brand" href="/apps/rising-shows/" aria-label="Rising Shows home">
      <span aria-hidden="true">📈</span> Rising Shows
    </a>
    <div class="page-header-right">
      <nav class="page-nav" aria-label="Primary">
        <a href="/apps/rising-shows/">Explorer</a>
        <a href="/apps/rising-shows/shows/">All shows</a>
        <a href="/apps">More apps</a>
      </nav>
      <a class="header-launch-btn" href="/apps/rising-shows/">Launch app →</a>
    </div>
  </header>

  <main id="main" class="show-page">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/home">Shevato</a> ›
      <a href="/apps/rising-shows/">Rising Shows</a> ›
      <a href="/apps/rising-shows/shows/">All shows</a> ›
      <span>${escapeHtml(title)}</span>
    </nav>

    <section class="show-hero">
      ${renderHeroPoster(posterUrl, title, isAdult)}
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
          <a class="app-btn" href="/apps/rising-shows/#show=${escapeHtml(seriesId)}">Open in Rising Shows app →</a>
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

    ${renderRelatedShows(relatedShows, dominantShape, dominantShapeSlug, inGapHub)}

    <section class="page-footer-meta">
      <p class="attribution">Episode ratings and vote counts from <a href="https://www.imdb.com/title/${seriesId}/" rel="noopener" target="_blank">IMDb</a>${tmdbId ? `. Poster, overview, and streaming data from <a href="https://www.themoviedb.org/tv/${tmdbId}" rel="noopener" target="_blank">TMDB</a>` : ''}. Data refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}.</p>
      <p>Want to discover more shows by their rating shape? <a href="/apps/rising-shows/">Browse Rising Shows →</a></p>
    </section>
  </main>

  ${renderMoreFooter()}
  ${renderStickyBanner(title, dominantShape, dominantShapeSlug)}
  <script src="/assets/js/back-to-top.js" defer></script>
</body>
</html>
`;
}

function renderHeroPoster(posterUrl, title, isAdult) {
  if (!posterUrl) {
    return '<div class="show-poster poster-placeholder" aria-hidden="true"></div>';
  }
  const img = `<img class="show-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(`${title} poster`)}" width="300" height="450" loading="eager" decoding="async">`;
  return isAdult ? wrapSensitivePoster(img, 'rs-reveal-hero', false) : img;
}

// Top-billed cast strip. `cast` is the array stashed on the series by
// enrich-tmdb.js - each entry is { id, name, character, profile_path }.
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
        .map((e) => `<li><a class="shape-badge" href="/apps/rising-shows/shows/shape/${escapeHtml(e.slug)}/">${escapeHtml(e.label)}</a></li>`)
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
          <caption>Season ${season.season} episodes - IMDb ratings</caption>
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
    return `<a class="primary-btn" href="/apps/rising-shows/#shape=${escapeHtml(dominantShapeSlug)}">Browse all ${escapeHtml(label)} shows in the explorer →</a>`;
  }
  return `<a class="primary-btn" href="/apps/rising-shows/">Browse shows by rating shape →</a>`;
}

function renderFreshnessLine(builtAt, seasonCount) {
  const dateStr = builtAt ? new Date(builtAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  const text = dateStr
    ? `Ratings refreshed ${escapeHtml(dateStr)} · ${seasonCount} season${seasonCount === 1 ? '' : 's'} indexed`
    : `Data refreshed weekly · ${seasonCount} season${seasonCount === 1 ? '' : 's'} indexed`;
  return `<p class="hero-freshness">${text}</p>`;
}

// Only shows that actually made the gap hub link into it, so the link never
// points at a list this show is absent from.
const GAP_HUB_LINK = `<a href="/apps/rising-shows/shows/shape/${GAP_HUB_SLUG}/">See shows that outshine their reputation →</a>`;

function renderRelatedShows(relatedShows, dominantShape, dominantShapeSlug, inGapHub = false) {
  if (!relatedShows || relatedShows.length === 0 || !dominantShape) {
    // Shapeless shows get no recommendations block, but a gap-hub show still
    // links back to the one hub it appears on.
    return inGapHub ? `<p class="rec-see-all">${GAP_HUB_LINK}</p>` : '';
  }
  const shapeLabel = SHAPE_LABELS[dominantShape] || dominantShape;
  const gapHubLink = inGapHub ? ` · ${GAP_HUB_LINK}` : '';
  const cards = relatedShows.map((s) => {
    let posterEl = s.poster
      ? `<img class="rec-poster" src="${escapeHtml(`https://image.tmdb.org/t/p/w185${s.poster}`)}" alt="${escapeHtml(`${s.title} poster`)}" width="92" height="138" loading="lazy" decoding="async">`
      : `<div class="rec-poster rec-poster-placeholder" aria-hidden="true"></div>`;
    if (s.poster && isAdultGenres(s.genres)) {
      posterEl = wrapSensitivePoster(posterEl, `rs-reveal-${s.seriesId}`, true);
    }
    const badge = s.dominantShape
      ? `<span class="shape-badge rec-shape-badge">${escapeHtml(SHAPE_LABELS[s.dominantShape] || s.dominantShape)}</span>`
      : '';
    const yearLabel = s.year ? ` <span class="rec-year">(${s.year})</span>` : '';
    return `<a class="rec-card" href="/apps/rising-shows/shows/${escapeHtml(s.slug)}/">
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
    <p class="rec-see-all"><a href="/apps/rising-shows/shows/shape/${escapeHtml(dominantShapeSlug)}/">See all ${escapeHtml(shapeLabel)} shows →</a>${gapHubLink}</p>
  </section>`;
}

function renderStickyBanner(title, dominantShape, dominantShapeSlug) {
  if (!dominantShape || !dominantShapeSlug) return '';
  const shapeLabel = SHAPE_LABELS[dominantShape] || dominantShape;
  const link = `/apps/rising-shows/#shape=${dominantShapeSlug}`;
  return `<div class="sticky-cta-banner" id="stickyCta" hidden aria-live="polite">
    <div class="sticky-cta-inner">
      <span class="sticky-cta-title">${escapeHtml(title)}</span>
      <span class="shape-badge sticky-cta-badge">${escapeHtml(shapeLabel)}</span>
      <a class="primary-btn sticky-cta-btn" href="${escapeHtml(link)}">Explore by shape in the app</a>
      <button type="button" class="sticky-cta-close" aria-label="Dismiss banner" onclick="document.getElementById('stickyCta').dataset.dismissed='1';document.getElementById('stickyCta').hidden=true;document.body.style.paddingBottom=''">×</button>
    </div>
  </div>
  <script>
  (function () {
    var banner = document.getElementById('stickyCta');
    if (!banner) return;
    // Shown and hidden in lockstep with the shared back-to-top arrow: both
    // appear past the same 400px scroll threshold and both go away near the
    // top. Dismissing suppresses the banner for this page view only (the
    // flag lives on the element, so a reload starts fresh).
    var THRESHOLD = 400;
    function check() {
      if (banner.dataset.dismissed) return;
      if (window.scrollY > THRESHOLD) {
        if (banner.hidden) {
          banner.hidden = false;
          document.body.style.paddingBottom = banner.offsetHeight + 'px';
        }
      } else if (!banner.hidden) {
        banner.hidden = true;
        document.body.style.paddingBottom = '';
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
  const lead = `${title}${yearLabel} - episode-by-episode IMDb ratings and season-shape analysis across ${seasonLabel}.${ratingLabel}`;
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
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/home` },
      { '@type': 'ListItem', position: 2, name: 'Apps', item: `${SITE}/apps` },
      { '@type': 'ListItem', position: 3, name: 'Rising Shows', item: `${SITE}/apps/rising-shows/` },
      { '@type': 'ListItem', position: 4, name: 'All shows', item: `${SITE}/apps/rising-shows/shows/` },
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

module.exports = {
  renderShowPage,
  escapeHtml,
  buildDescription,
  shapeToSlug,
  SITE,
  buildTvSeasonSchema,
  renderSeasonNav,
  SHAPE_LABELS,
  SHAPE_DESCS,
  GAP_HUB_SLUG,
  GAP_HUB_LABEL,
  computeDominantShape,
  computeOverallAvgRating,
  jsonLd,
};
