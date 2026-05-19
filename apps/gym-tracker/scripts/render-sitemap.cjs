'use strict';

const { SITE } = require('./render-exercise-page.cjs');

// Sitemap entries: the /exercises/ landing page, every per-exercise
// page, every muscle-group taxonomy page, and every equipment page.
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
  for (const ex of exercises) {
    urls.push(url(`${SITE}/apps/gym-tracker/exercises/${slugs.get(ex.id)}/`, lastmod, 'monthly', '0.5'));
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
