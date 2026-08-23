'use strict';

const { showPath } = require('./slugify.js');
const { escapeHtml, SITE } = require('./render-show-page.js');
const { renderHubNav } = require('./render-shape-hub.js');
const { renderMoreFooter } = require('./render-footer.js');

// The crawler's primary entry point into the per-show pages. The sitemap
// deliberately lists only the top ~2,000 shows by votes, so these browse pages
// are the ONLY crawl path to the other ~32,500 - splitting them must never drop
// a show.
//
// It used to be one page holding every show: 4.79 MB of HTML, 34,601 links and
// 535,383px tall. That is far past what a browser lays out comfortably, past
// the "few thousand links" a single page should carry, and so tall that a
// back-to-top click skipped six screens per animation frame.
//
// Now /shows/ is a small hub listing each letter, and the shows themselves live
// on paginated per-letter pages. PER_PAGE is set so a page stays near the
// 12,000px that back-to-top.js can animate without shortening the journey - at
// roughly 26px per row, 500 rows lands about there.
const PER_PAGE = 500;

// Sits under /shows/ alongside /shows/shape/. Safe from collisions for the same
// reason: show directories always end in -tt<digits>, so a show can never be
// named "letter".
const LETTER_BASE = '/apps/rising-shows/shows/letter';

// Shared head of every breadcrumb trail on these pages. Extensionless /home
// and /apps, matching the show pages and the shape hubs: prod rewrites the
// .html forms, so the structured data must not be the one surface still
// naming URLs the canonical pages never use.
const BREADCRUMB_TRUNK = [
  { name: 'Home', item: `${SITE}/home` },
  { name: 'Apps', item: `${SITE}/apps` },
  { name: 'Rising Shows', item: `${SITE}/apps/rising-shows/` },
];

function letterSlug(letter) {
  return letter === '#' ? 'other' : letter.toLowerCase();
}

// Page 1 lives at the letter root; later pages get a /2/, /3/ suffix. Keeping
// page 1 un-suffixed means the hub's links stay the canonical ones.
function letterPath(letter, pageNum = 1) {
  const base = `${LETTER_BASE}/${letterSlug(letter)}/`;
  return pageNum <= 1 ? base : `${base}${pageNum}/`;
}

// Groups every series under its display letter, each group sorted by title.
// Returns a Map so insertion order (A-Z then #) is preserved for callers.
function groupByLetter(series) {
  const sorted = [...series].sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)));
  const groups = new Map();
  for (const s of sorted) {
    const letter = firstLetter(sortTitle(s.title));
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(s);
  }
  return groups;
}

function pageCount(total) {
  return Math.max(1, Math.ceil(total / PER_PAGE));
}

// Every browse page that should exist, as { letter, pageNum, path, items }.
// The build script writes these and the sitemap lists them.
function letterPages(groups) {
  const out = [];
  for (const [letter, items] of groups) {
    const pages = pageCount(items.length);
    for (let n = 1; n <= pages; n++) {
      out.push({
        letter,
        pageNum: n,
        totalPages: pages,
        path: letterPath(letter, n),
        items: items.slice((n - 1) * PER_PAGE, n * PER_PAGE),
        letterTotal: items.length,
      });
    }
  }
  return out;
}

function shell({ title, description, canonical, breadcrumbs, ogImageAlt, head = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Shevato LLC">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#0b0d12">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">
${head}
  <!-- Open Graph. og-card.png, not the site logo these pages used to point at:
       that was an SVG, and social scrapers (Facebook, X, Slack, WhatsApp) do
       not render SVG, so the preview came out blank. Same card and same
       twitter block the show pages and the shape hubs use. -->
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/og-card.png">
  <meta property="og:image:alt" content="${escapeHtml(ogImageAlt || title)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="Shevato">
  <meta property="og:locale" content="en_US">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${SITE}/images/og-card.png">
  <meta name="twitter:site" content="@shevato">

  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
${breadcrumbs.map((b, i) => `        { "@type": "ListItem", "position": ${i + 1}, "name": ${JSON.stringify(b.name)}, "item": "${b.item}" }`).join(',\n')}
      ]
    }
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
    <nav class="page-nav" aria-label="Primary">
      <a href="/apps/rising-shows/">Explorer</a>
      <a href="/apps/rising-shows/shows/"${canonical.endsWith('/shows/') ? ' aria-current="page"' : ''}>All shows</a>
      <a href="/apps">More apps</a>
    </nav>
  </header>

  <main id="main" class="shows-index">
${body}
  </main>

  ${renderMoreFooter()}
  <script src="/assets/js/back-to-top.js" defer></script>
</body>
</html>
`;
}

// The A-Z strip. Rendered on the hub and on every letter page so a crawler (or
// a reader) can move between letters without going back to the hub first.
function alphaNav(groups, currentLetter) {
  return `<nav class="alpha-jump" aria-label="Browse by letter">
      ${[...groups.keys()]
    .map((l) => {
      const current = l === currentLetter;
      return `<a href="${letterPath(l)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(l)}</a>`;
    })
    .join('')}
    </nav>`;
}

function renderShowsIndex(series, builtAt) {
  const groups = groupByLetter(series);
  const total = series.length;
  const canonical = `${SITE}/apps/rising-shows/shows/`;
  const description = `Browse all ${total.toLocaleString()} TV shows in Rising Shows by first letter. Episode-by-episode IMDb ratings and season-shape analysis for every series.`;

  const body = `    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/home">Shevato</a> ›
      <a href="/apps/rising-shows/">Rising Shows</a> ›
      <span>All shows</span>
    </nav>

    <header class="index-hero">
      <h1>All shows</h1>
      <p class="lede">Every series in Rising Shows (${total.toLocaleString()} shows), grouped by first letter. Each links to an episode-by-episode rating page with season-shape analysis.</p>
    </header>

    <nav class="shape-nav" aria-label="Browse by shape">
      <span class="shape-nav-label">Browse by shape</span>
      ${renderHubNav()}
    </nav>

    ${alphaNav(groups, null)}

    <ul class="shows-list letter-directory">
      ${[...groups.entries()]
    .map(([letter, items]) => {
      const pages = pageCount(items.length);
      return `<li><a href="${letterPath(letter)}">${escapeHtml(letter)} <span class="muted">(${items.length.toLocaleString()} show${items.length === 1 ? '' : 's'}${pages > 1 ? `, ${pages} pages` : ''})</span></a></li>`;
    })
    .join('\n      ')}
    </ul>

    <p class="index-footer">Refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}. Source: <a href="https://datasets.imdbws.com/" rel="noopener" target="_blank">IMDb datasets</a>.</p>`;

  return shell({
    title: 'All Shows - Browse Every TV Series by Episode Ratings | Rising Shows',
    description,
    canonical,
    ogImageAlt: 'Every TV series in Rising Shows, browsable A-Z',
    breadcrumbs: BREADCRUMB_TRUNK.concat([
      { name: 'All shows', item: canonical },
    ]),
    body,
  });
}

function renderShowsLetterPage({ letter, items, pageNum, totalPages, letterTotal, groups, builtAt }) {
  const canonical = `${SITE}${letterPath(letter, pageNum)}`;
  const label = letter === '#' ? 'numbers and symbols' : `the letter ${letter}`;
  const pageSuffix = totalPages > 1 ? ` (page ${pageNum} of ${totalPages})` : '';
  const description = `TV shows starting with ${label}${pageSuffix}: ${letterTotal.toLocaleString()} series with episode-by-episode IMDb ratings and season-shape analysis.`;

  // Self-canonical on every page, with prev/next as the relationship hint.
  // Pointing later pages at page 1 would tell Google the shows listed here do
  // not need crawling, which is the opposite of what this page exists for.
  const head = [
    pageNum > 1 ? `  <link rel="prev" href="${SITE}${letterPath(letter, pageNum - 1)}">` : '',
    pageNum < totalPages ? `  <link rel="next" href="${SITE}${letterPath(letter, pageNum + 1)}">` : '',
  ].filter(Boolean).join('\n');

  const pager = totalPages > 1
    ? `<nav class="pager" aria-label="Pagination">
      ${pageNum > 1 ? `<a rel="prev" href="${letterPath(letter, pageNum - 1)}">← Previous</a>` : ''}
      <span class="pager-status">Page ${pageNum} of ${totalPages}</span>
      ${pageNum < totalPages ? `<a rel="next" href="${letterPath(letter, pageNum + 1)}">Next →</a>` : ''}
    </nav>`
    : '';

  const body = `    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/home">Shevato</a> ›
      <a href="/apps/rising-shows/">Rising Shows</a> ›
      <a href="/apps/rising-shows/shows/">All shows</a> ›
      <span>${escapeHtml(letter)}${pageSuffix}</span>
    </nav>

    <header class="index-hero">
      <h1>Shows starting with ${escapeHtml(letter)}${pageSuffix}</h1>
      <p class="lede">${letterTotal.toLocaleString()} series. Each links to an episode-by-episode rating page with season-shape analysis.</p>
    </header>

    ${alphaNav(groups, letter)}

    ${pager}

    <ul class="shows-list">
      ${items
    .map((s) => {
      const slug = showPath(s.title, s.seriesId);
      return `<li><a href="/apps/rising-shows/shows/${slug}/">${escapeHtml(s.title)}${s.year ? ` <span class="muted">(${s.year})</span>` : ''}</a></li>`;
    })
    .join('\n      ')}
    </ul>

    ${pager}

    <p class="index-footer">Refreshed ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : 'weekly'}. Source: <a href="https://datasets.imdbws.com/" rel="noopener" target="_blank">IMDb datasets</a>.</p>`;

  return shell({
    title: `Shows starting with ${letter}${pageSuffix} | Rising Shows`,
    description,
    canonical,
    head,
    ogImageAlt: `TV shows starting with ${label}, on Rising Shows`,
    breadcrumbs: BREADCRUMB_TRUNK.concat([
      { name: 'All shows', item: `${SITE}/apps/rising-shows/shows/` },
      { name: `${letter}${pageSuffix}`, item: canonical },
    ]),
    body,
  });
}

function sortTitle(s) {
  return String(s || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();
}

// Bucket letter for the A-Z directory. Latin diacritics are folded FOR
// BUCKETING ONLY - the row still prints the real title - so "Çilgin Dersane at
// the University" files under C (where a reader looking for it goes, and where
// its own slug already puts it) instead of sharing the "#" bucket with
// "¡Mucha Lucha!" and the 574 digit-initial titles.
//
// NFKD decomposes a precomposed letter into base + combining mark, so stripping
// the marks leaves the base letter: Ç->C, Ö->O, Å->A, Ñ->N. Characters with no
// Latin base survive the fold unchanged and stay in "#": digits and symbols
// (conventional), and genuinely non-Latin scripts (Japanese, Cyrillic, Arabic,
// Hebrew, Chinese). Transliterating those would be a guess about a romanisation
// the reader may not share, and IMDb primaryTitle is already romanised for the
// catalogue, so the case is rare by construction. "#" is the honest bucket for
// "does not sort under an English letter".
function firstLetter(s) {
  const c = (s || '#')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .charAt(0)
    .toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

module.exports = {
  renderShowsIndex,
  renderShowsLetterPage,
  groupByLetter,
  letterPages,
  letterPath,
  letterSlug,
  sortTitle,
  firstLetter,
  PER_PAGE,
};
