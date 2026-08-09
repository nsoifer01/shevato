'use strict';

const { showPath } = require('./slugify.js');
const { SITE } = require('./render-show-page.js');

// Emit a single sitemap.xml referencing the curated top show pages plus
// the /shows/ browse index. Every show page is still built and served;
// the sitemap deliberately lists only the most-voted subset so Google
// spends its crawl budget on shows people actually search for instead
// of parking 30k+ long-tail pages in "Discovered - currently not
// indexed" (GSC, 2026-07). The rest stay reachable via the A-Z index.
//
// `browsePaths` are the per-letter browse pages. They are listed because they
// ARE the crawl path to the ~32,500 shows the sitemap omits: /shows/ alone only
// links to the letter roots, so without these the later pages of each letter
// would sit two hops from anything a crawler is told about.
function renderShowsSitemap(series, builtAt, hubSlugs = [], browsePaths = []) {
  const lastmod = builtAt ? new Date(builtAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const urls = [
    `  <url>
    <loc>${SITE}/apps/rising-shows/shows/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
    ...browsePaths.map((p) => `  <url>
    <loc>${SITE}${p}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`),
    // The topic hubs (13 shapes plus the gap hub) sit above the individual
    // shows: they're the landing pages the show pages link back into.
    ...hubSlugs.map((slug) => `  <url>
    <loc>${SITE}/apps/rising-shows/shows/shape/${slug}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`),
    ...series.map((s) => {
      const slug = showPath(s.title, s.seriesId);
      return `  <url>
    <loc>${SITE}/apps/rising-shows/shows/${slug}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

// Pick the `limit` series with the most IMDb votes (ties broken by
// title so output is deterministic). Series without a vote count sort
// last. Callers pass the full grouped-series list; the returned subset
// is what goes into the sitemap.
function selectSitemapSeries(series, limit) {
  return [...series]
    .sort((a, b) => (b.seriesVotes || 0) - (a.seriesVotes || 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

module.exports = { renderShowsSitemap, selectSitemapSeries };
