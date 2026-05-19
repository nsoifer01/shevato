'use strict';

const { showPath } = require('./slugify.js');
const { escapeHtml, SITE } = require('./render-show-page.js');

// Single A-Z browse index of every show. This is the crawler's primary
// entry point into the per-show pages — Google follows the links here to
// discover and rank each /shows/{slug}-{tt}/ page.
function renderShowsIndex(series, builtAt) {
  const sorted = [...series].sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)));
  const groups = new Map();
  for (const s of sorted) {
    const letter = firstLetter(sortTitle(s.title));
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(s);
  }
  const letters = [...groups.keys()];

  const canonical = `${SITE}/apps/rising-seasons/shows/`;
  const description = `Browse all ${sorted.length.toLocaleString()} TV shows in Rising Seasons. Episode-by-episode IMDb ratings and season-shape analysis for every series.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>All Shows | Rising Seasons — Browse Every TV Series by Episode Ratings</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Shevato LLC">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#0b0d12">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">

  <meta property="og:title" content="All Shows | Rising Seasons">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/full-logo.svg">
  <meta property="og:site_name" content="Shevato">

  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/home.html" },
        { "@type": "ListItem", "position": 2, "name": "Apps", "item": "${SITE}/apps.html" },
        { "@type": "ListItem", "position": 3, "name": "Rising Seasons", "item": "${SITE}/apps/rising-seasons/" },
        { "@type": "ListItem", "position": 4, "name": "All shows", "item": "${canonical}" }
      ]
    }
  </script>

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📈%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/rising-seasons/css/show-page.css">

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
      <a href="/apps/rising-seasons/shows/" aria-current="page">All shows</a>
      <a href="/apps.html">More apps</a>
    </nav>
  </header>

  <main id="main" class="shows-index">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Shevato</a> ›
      <a href="/apps/rising-seasons/">Rising Seasons</a> ›
      <span>All shows</span>
    </nav>

    <header class="index-hero">
      <h1>All shows</h1>
      <p class="lede">Every series in Rising Seasons (${sorted.length.toLocaleString()} shows). Each links to an episode-by-episode rating page with season-shape analysis.</p>
    </header>

    <nav class="alpha-jump" aria-label="Jump to letter">
      ${letters.map((l) => `<a href="#letter-${escapeHtml(l)}">${escapeHtml(l)}</a>`).join('')}
    </nav>

    ${letters
      .map((l) => {
        const items = groups.get(l);
        return `<section class="alpha-group" id="letter-${escapeHtml(l)}">
      <h2>${escapeHtml(l)}</h2>
      <ul class="shows-list">
        ${items
          .map((s) => {
            const slug = showPath(s.title, s.seriesId);
            return `<li><a href="/apps/rising-seasons/shows/${slug}/">${escapeHtml(s.title)}${s.year ? ` <span class="muted">(${s.year})</span>` : ''}</a></li>`;
          })
          .join('\n        ')}
      </ul>
    </section>`;
      })
      .join('\n    ')}

    <p class="index-footer">Refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}. Source: <a href="https://datasets.imdbws.com/" rel="noopener" target="_blank">IMDb datasets</a>.</p>
  </main>

  <footer class="page-footer">
    <p>© Shevato LLC · <a href="/">shevato.com</a> · <a href="/contact.html">Contact</a></p>
  </footer>
</body>
</html>
`;
}

function sortTitle(s) {
  return String(s || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();
}

function firstLetter(s) {
  const c = (s || '#').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

module.exports = { renderShowsIndex, sortTitle, firstLetter };
