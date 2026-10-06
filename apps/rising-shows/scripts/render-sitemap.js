'use strict';

const { showPath } = require('./slugify.js');
const { SITE } = require('./render-show-page.js');
const { selectSitemapSeries, selectShowPageIds, SHOW_PAGE_LIMIT } = require('./show-pages.js');

// Emit a single sitemap.xml referencing the curated top show pages plus
// the /shows/ browse index. Only the curated shows have a page at all: the
// full-catalogue launch parked ~60k long-tail URLs in "Crawled - currently
// not indexed" (GSC, 2026-07 to 2026-10), and neither a curated sitemap nor
// `noindex, follow` drained it, so the tail is served 410 since 2026-10.
//
// `browsePaths` are the per-letter browse pages. Every show is still listed on
// one of them; a show without a page links into the app instead.
//
// No <lastmod>: the only date the builder has is the build time, and the
// build runs daily, so every URL used to claim it changed today (2,098 URLs,
// every day). Google discounts lastmod on sites where it is consistently
// wrong, which also cost the genuinely updated pages their signal. There is
// no per-show "content changed" date in the dataset; omitting the element
// is the honest option until one exists. (`builtAt` is kept in the signature
// so callers do not change.)
function renderShowsSitemap(series, builtAt, hubSlugs = [], browsePaths = []) {
  const urls = [
    `  <url>
    <loc>${SITE}/apps/rising-shows/shows/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
    ...browsePaths.map((p) => `  <url>
    <loc>${SITE}${p}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`),
    // The topic hubs (13 shapes plus the gap hub) sit above the individual
    // shows: they're the landing pages the show pages link back into.
    ...hubSlugs.map((slug) => `  <url>
    <loc>${SITE}/apps/rising-shows/shows/shape/${slug}/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`),
    ...series.map((s) => {
      const slug = showPath(s.title, s.seriesId);
      return `  <url>
    <loc>${SITE}/apps/rising-shows/shows/${slug}/</loc>
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

module.exports = { renderShowsSitemap, selectSitemapSeries, selectShowPageIds, SHOW_PAGE_LIMIT };
