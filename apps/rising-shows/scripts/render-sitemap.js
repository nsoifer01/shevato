'use strict';

const { showPath } = require('./slugify.js');
const { SITE } = require('./render-show-page.js');

// Emit a single sitemap.xml referencing every show page plus the
// /shows/ browse index. Spec caps a sitemap at 50,000 URLs or 50 MB —
// ~7k entries fits comfortably, so no chunking yet.
function renderShowsSitemap(series, builtAt) {
  const lastmod = builtAt ? new Date(builtAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const urls = [
    `  <url>
    <loc>${SITE}/apps/rising-shows/shows/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
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

module.exports = { renderShowsSitemap };
