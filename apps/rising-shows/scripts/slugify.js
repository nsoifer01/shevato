'use strict';

// URL-safe slug from a TV show title. We use lowercase ASCII letters,
// digits, and single dashes, capped to 80 chars so URLs stay readable.
// The seriesId (tconst) is appended by the caller to guarantee uniqueness
// since titles like "The Office" exist multiple times.
function slugify(title) {
  if (!title || typeof title !== 'string') return 'show';
  let s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, '');
  return s || 'show';
}

function showPath(title, seriesId) {
  return `${slugify(title)}-${seriesId}`;
}

// Where a link to a show should point. Only the curated shows have a static
// page; every other /shows/<slug>/ URL answers 410 Gone (netlify.toml), so a
// show without one links into the app, whose `#show=<id>` deep link opens it
// in the show modal. build-show-pages.js stamps `hasPage` on every series it
// renders from; a record without the flag is treated as having a page.
// `inApp === false` marks a show the Finder drops (no IMDb series rating or no
// rated episode, see buildShowAgg), whose deep link would open nothing; with
// no page either, the title on IMDb is the only place left that describes it.
function showHref(s) {
  if (s.hasPage !== false) return `/apps/rising-shows/shows/${showPath(s.title, s.seriesId)}/`;
  if (s.inApp === false) return `https://www.imdb.com/title/${s.seriesId}/`;
  return `/apps/rising-shows/#show=${s.seriesId}`;
}

module.exports = { slugify, showPath, showHref };
