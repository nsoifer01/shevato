'use strict';

const { showPath } = require('./slugify.js');
const {
  escapeHtml,
  SITE,
  SHAPE_LABELS,
  SHAPE_DESCS,
  GAP_HUB_SLUG,
  GAP_HUB_LABEL,
  computeDominantShape,
  computeOverallAvgRating,
  jsonLd,
} = require('./render-show-page.js');
const { renderMoreFooter } = require('./render-footer.js');

// Every shape a season can carry, in the app's chip order (the last two are
// series-level tags). One static hub page is generated per entry.
const SHAPE_SLUGS = [
  'rising',
  'consistent',
  'slow-burn',
  'big-finale',
  'rebound',
  'front-loaded',
  'declining',
  'bad-finale',
  'rollercoaster',
  'mid-peak',
  'u-shaped',
  'saved-best-for-last',
  'shape-drift',
];

// Every hub page under /shows/shape/: the 13 shape hubs plus the gap hub,
// which ranks by a metric instead of by shape membership. This is the list
// the sitemap and the browse strips walk.
const HUB_SLUGS = [...SHAPE_SLUGS, GAP_HUB_SLUG];

// Visible ranking depth. The ItemList in JSON-LD stops earlier so the
// structured-data payload stays small.
const HUB_LIMIT = 100;
const HUB_SCHEMA_LIMIT = 25;

// Minimum IMDb votes to qualify for the gap hub. 15,000 is roughly where the
// curated sitemap cuts off (top 2,000 shows by votes), so nearly every ranked
// show is itself an indexable page, and it sits near the 94th percentile of
// rated shows. Lower floors hand the top of the list to review-bombed titles:
// with no floor the leader is a 451-vote show averaging 9.9 per episode
// against a 1.3 series rating.
const GAP_MIN_VOTES = 15000;

function hubPath(slug) {
  return `/apps/rising-shows/shows/shape/${slug}/`;
}

// A show belongs to exactly one hub: the one matching its dominant shape, so
// the same title never appears on two hubs. Ranked by IMDb votes descending
// (ties broken by title for a deterministic build).
function selectHubShows(series, slug, limit = HUB_LIMIT) {
  return series
    .filter((s) => computeDominantShape(s).dominantShapeSlug === slug)
    .sort((a, b) => (b.seriesVotes || 0) - (a.seriesVotes || 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

// Shows whose episodes rate higher than the series' own IMDb score, ranked by
// that gap. Both numbers are used at the one decimal IMDb publishes, so the
// value a row prints is exactly the value that ranked it. Shows under the vote
// floor are dropped before ranking, and only positive gaps qualify.
function selectGapHubShows(series, limit = HUB_LIMIT, minVotes = GAP_MIN_VOTES) {
  return series
    .filter((s) => (s.seriesVotes || 0) >= minVotes && s.seriesRating)
    .map((s) => {
      const avgEpisode = parseFloat(computeOverallAvgRating(s.seasons));
      return { ...s, avgEpisode, gap: Math.round((avgEpisode - s.seriesRating) * 10) / 10 };
    })
    .filter((s) => s.gap > 0)
    .sort((a, b) => b.gap - a.gap || (b.seriesVotes || 0) - (a.seriesVotes || 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

// One static landing page per rating shape: a ranked list of the most-voted
// shows whose dominant season carries that shape. These are the topic hubs the
// per-season shape badges and the A-Z index link into.
function renderShapeHub(slug, shows, builtAt) {
  const label = SHAPE_LABELS[slug] || slug;
  const desc = SHAPE_DESCS[slug] || '';
  const count = shows.length;

  const rows = shows.map((s, i) => {
    const avg = computeOverallAvgRating(s.seasons);
    const stats = [
      `${avg} avg episode`,
      s.seriesVotes ? `${s.seriesVotes.toLocaleString()} votes` : null,
    ].filter(Boolean).join(' · ');
    return rankRow(s, i, stats);
  });

  return renderHubPage({
    slug,
    label,
    pageTitle: `Best ${label} TV shows - Rising Shows`,
    description: `The ${count} best ${label.toLowerCase()} TV shows, ranked by IMDb votes. ${desc}. Episode-by-episode ratings and season-shape analysis for every show.`,
    schemaName: `Best ${label} TV shows`,
    ogImageAlt: `Best ${label} TV shows on Rising Shows`,
    heading: `Best ${escapeHtml(label)} TV shows`,
    lede: `${escapeHtml(label)}: ${escapeHtml(desc.toLowerCase())}. These are the ${count} most-voted shows whose highest-rated season carries that shape, each with an episode-by-episode rating page.`,
    ctaHref: `/apps/rising-shows/#shape=${escapeHtml(slug)}`,
    ctaLabel: `Filter ${escapeHtml(label)} shows in the explorer →`,
    footerNote: 'Ranked by IMDb vote count.',
    rows,
    shows,
    builtAt,
  });
}

// The one hub ranked by a number rather than by shape: the gap between a
// show's episode-weighted average and its own IMDb series rating.
function renderGapHub(shows, builtAt, minVotes = GAP_MIN_VOTES) {
  const count = shows.length;
  const votesLabel = minVotes.toLocaleString();

  const rows = shows.map((s, i) => rankRow(
    s,
    i,
    `avg episode ${s.avgEpisode.toFixed(1)} · IMDb ${s.seriesRating.toFixed(1)} · +${s.gap.toFixed(1)} above IMDb`,
  ));

  return renderHubPage({
    slug: GAP_HUB_SLUG,
    label: GAP_HUB_LABEL,
    pageTitle: 'TV shows that outshine their reputation - Rising Shows',
    description: `${count} TV shows whose episodes score higher than the show's own IMDb rating, ranked by the size of that gap, among shows with at least ${votesLabel} IMDb votes.`,
    schemaName: 'TV shows that outshine their reputation',
    ogImageAlt: 'TV shows whose episodes outscore their IMDb rating, on Rising Shows',
    heading: 'TV shows that outshine their reputation',
    lede: `Every episode these shows aired rates higher, on average, than the show's own IMDb score. The ${count} biggest gaps among shows with at least ${votesLabel} IMDb votes, so the ranking reflects real audiences rather than a handful of votes.`,
    ctaHref: `/apps/rising-shows/#sort=gap&amp;gapDir=up&amp;minVotes=${minVotes}`,
    ctaLabel: 'Sort every show by this gap in the explorer →',
    footerNote: `Ranked by average episode rating minus the show's IMDb rating, among shows with at least ${votesLabel} votes.`,
    rows,
    shows,
    builtAt,
  });
}

function rankRow(s, i, stats) {
  return `<li>
        <a class="rank-row" href="/apps/rising-shows/shows/${showPath(s.title, s.seriesId)}/">
          <span class="rank-num">${i + 1}</span>
          <span class="rank-title">${escapeHtml(s.title)}${s.year ? ` <span class="muted">(${s.year})</span>` : ''}</span>
          <span class="rank-stats">${escapeHtml(stats)}</span>
        </a>
      </li>`;
}

function hubLabel(slug) {
  return slug === GAP_HUB_SLUG ? GAP_HUB_LABEL : (SHAPE_LABELS[slug] || slug);
}

// Browse strip shared by every hub and by the A-Z index: the current hub (if
// any) as plain text, then a link to each sibling hub.
function renderHubNav(currentSlug) {
  const links = HUB_SLUGS.filter((x) => x !== currentSlug).map((x) => {
    const cls = x === GAP_HUB_SLUG ? ' class="shape-nav-gap"' : '';
    return `<a${cls} href="${hubPath(x)}">${escapeHtml(hubLabel(x))}</a>`;
  });
  const current = currentSlug
    ? [`<span class="shape-nav-current" aria-current="page">${escapeHtml(hubLabel(currentSlug))}</span>`]
    : [];
  return [...current, ...links].join('\n      ');
}

// Shared page shell for every hub. Callers supply the copy, the ranked rows
// and the shows behind them; everything else (head, chrome, JSON-LD) is
// identical across hubs by design.
function renderHubPage({ slug, label, pageTitle, description, schemaName, ogImageAlt, heading, lede, ctaHref, ctaLabel, footerNote, rows, shows, builtAt }) {
  const canonical = `${SITE}${hubPath(slug)}`;

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

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/og-card.png">
  <meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="Shevato">
  <meta property="og:locale" content="en_US">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${SITE}/images/og-card.png">
  <meta name="twitter:site" content="@shevato">

  <!-- Breadcrumbs -->
  <script type="application/ld+json">
${jsonLd(buildBreadcrumbs(label, canonical))}
  </script>

  <!-- CollectionPage -->
  <script type="application/ld+json">
${jsonLd(buildCollectionSchema(schemaName, canonical, description, shows))}
  </script>

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📈%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/rising-shows/css/show-page.css">
  <link rel="stylesheet" href="/assets/css/back-to-top.css">

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
        <a href="/apps.html">More apps</a>
      </nav>
      <a class="header-launch-btn" href="/apps/rising-shows/">Launch app →</a>
    </div>
  </header>

  <main id="main" class="shape-hub">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/home">Shevato</a> ›
      <a href="/apps/rising-shows/">Rising Shows</a> ›
      <a href="/apps/rising-shows/shows/">All shows</a> ›
      <span>${escapeHtml(label)}</span>
    </nav>

    <header class="hub-hero">
      <h1>${heading}</h1>
      <p class="lede">${lede}</p>
      <a class="primary-btn" href="${ctaHref}">${ctaLabel}</a>
    </header>

    <nav class="shape-nav" aria-label="Browse by shape">
      <span class="shape-nav-label">Browse by shape</span>
      ${renderHubNav(slug)}
      <a class="shape-nav-all" href="/apps/rising-shows/shows/">All shows A-Z</a>
    </nav>

    <ol class="rank-list">
      ${rows.join('\n      ')}
    </ol>

    <p class="index-footer">${footerNote} Refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}. Source: <a href="https://datasets.imdbws.com/" rel="noopener" target="_blank">IMDb datasets</a>.</p>
  </main>

  ${renderMoreFooter()}
  <script src="/assets/js/back-to-top.js" defer></script>
</body>
</html>
`;
}

function buildBreadcrumbs(label, canonical) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/home.html` },
      { '@type': 'ListItem', position: 2, name: 'Apps', item: `${SITE}/apps.html` },
      { '@type': 'ListItem', position: 3, name: 'Rising Shows', item: `${SITE}/apps/rising-shows/` },
      { '@type': 'ListItem', position: 4, name: 'All shows', item: `${SITE}/apps/rising-shows/shows/` },
      { '@type': 'ListItem', position: 5, name: label, item: canonical },
    ],
  };
}

function buildCollectionSchema(name, canonical, description, shows) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    url: canonical,
    description,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Rising Shows',
      url: `${SITE}/apps/rising-shows/`,
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: shows.length,
      itemListElement: shows.slice(0, HUB_SCHEMA_LIMIT).map((s, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: s.title,
        url: `${SITE}/apps/rising-shows/shows/${showPath(s.title, s.seriesId)}/`,
      })),
    },
  };
}

module.exports = {
  renderShapeHub,
  renderGapHub,
  selectHubShows,
  selectGapHubShows,
  renderHubNav,
  hubPath,
  SHAPE_SLUGS,
  HUB_SLUGS,
  HUB_LIMIT,
  GAP_HUB_SLUG,
  GAP_HUB_LABEL,
  GAP_MIN_VOTES,
};
