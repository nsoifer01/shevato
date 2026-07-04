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

module.exports = { slugify, showPath };
