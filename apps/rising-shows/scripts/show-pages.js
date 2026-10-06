'use strict';

// Which Rising Shows series get a static page. Its own dependency-free module
// because two builders must agree on the set exactly and one of them,
// split-data.js, must not drag in the page renderer: build-show-pages.js
// (which pages to write, where links may point, the sitemap) and split-data.js
// (`page: true` on the shows-index row, which gates the app's Permalink).
// render-sitemap.js re-exports all three for its existing callers.

// How many series get a static page. At 2,000 the cutoff sits around 15k IMDb
// votes, i.e. shows with real search demand. Since 2026-10 this is ALSO the
// set of pages that exist at all: every other /shows/<slug>/ URL answers 410
// Gone (netlify.toml), see selectShowPageIds.
const SHOW_PAGE_LIMIT = 2000;

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

module.exports = { SHOW_PAGE_LIMIT, selectSitemapSeries, selectShowPageIds };
