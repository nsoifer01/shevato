'use strict';

const { showPath } = require('./slugify.js');
const { SITE } = require('./render-show-page.js');

// How many series get a static page. At 2,000 the cutoff sits around 15k IMDb
// votes, i.e. shows with real search demand. Since 2026-10 this is ALSO the
// set of pages that exist at all: every other /shows/<slug>/ URL answers 410
// Gone (netlify.toml), see selectShowPageIds.
const SHOW_PAGE_LIMIT = 2000;

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

// Pick the `limit` series with the most IMDb votes (ties broken by
// title, then id, so output is deterministic whatever order the input
// arrives in). Series without a vote count sort last. Callers pass the
// full grouped-series list; the returned subset is what goes into the
// sitemap.
function selectSitemapSeries(series, limit) {
  return [...series]
    .sort((a, b) => (b.seriesVotes || 0) - (a.seriesVotes || 0)
      || a.title.localeCompare(b.title)
      || (a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0))
    .slice(0, limit);
}

// The ids of the series that get a static page, straight from data.json's flat
// season `matches`. Two builders need this set and must agree on it exactly:
// build-show-pages.js (which pages to write, and where links may point) and
// split-data.js (which shows the app may offer a Permalink for, since any
// other show URL is a 410). Both call this one function on the same input.
// Grouped the way build-show-pages' groupBySeries does it: title from the
// first season record, seriesVotes from the first season that carries one.
function selectShowPageIds(matches, limit = SHOW_PAGE_LIMIT) {
  const byId = new Map();
  for (const m of matches) {
    const s = byId.get(m.seriesId);
    if (!s) byId.set(m.seriesId, { seriesId: m.seriesId, title: m.title || '', seriesVotes: m.seriesVotes });
    else if (s.seriesVotes == null && m.seriesVotes != null) s.seriesVotes = m.seriesVotes;
  }
  return new Set(selectSitemapSeries([...byId.values()], limit).map((s) => s.seriesId));
}

module.exports = { renderShowsSitemap, selectSitemapSeries, selectShowPageIds, SHOW_PAGE_LIMIT };
