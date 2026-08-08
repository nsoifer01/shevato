'use strict';

const { SITE } = require('./render-exercise-page.cjs');

// Sitemap entries: the /exercises/ landing page, every muscle-group taxonomy
// page, and every equipment page.
//
// The 513 individual exercise pages are deliberately NOT listed. They carry
// `noindex, follow` (see render-exercise-page.cjs), and a sitemap is a request
// to index: listing a page while telling the crawler not to index it is a
// contradiction that wastes crawl budget on URLs that can never appear in
// results. Rising Shows solves the same problem the same way, by curating its
// sitemap down from ~34,600 pages to the 2,000 it actually wants indexed.
//
// `exercises` and `slugs` are still accepted so the caller does not change and
// so restoring per-exercise entries later is a one-line edit rather than a
// signature change.
function renderExercisesSitemap({ exercises, slugs, muscles, equipment, builtAt }) {
  const lastmod = (builtAt ? new Date(builtAt) : new Date()).toISOString().slice(0, 10);
  const urls = [];

  urls.push(url(`${SITE}/apps/gym-tracker/exercises/`, lastmod, 'weekly', '0.7'));

  for (const m of muscles) {
    urls.push(url(`${SITE}/apps/gym-tracker/exercises/muscle/${m}/`, lastmod, 'monthly', '0.6'));
  }
  for (const e of equipment) {
    urls.push(url(`${SITE}/apps/gym-tracker/exercises/equipment/${e}/`, lastmod, 'monthly', '0.6'));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

function url(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

module.exports = { renderExercisesSitemap };
