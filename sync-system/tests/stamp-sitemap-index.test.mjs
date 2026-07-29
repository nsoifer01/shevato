import test from 'node:test';
import assert from 'node:assert/strict';

import { maxLastmod, stampSitemapIndex } from '../../scripts/stamp-sitemap-index.mjs';

const SUB_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shevato.com/a</loc><lastmod>2026-06-01</lastmod></url>
  <url><loc>https://shevato.com/b</loc><lastmod>2026-07-22</lastmod></url>
  <url><loc>https://shevato.com/c</loc><lastmod>2026-05-18</lastmod></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://shevato.com/sitemap-pages.xml</loc>
    <lastmod>2026-07-20</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://shevato.com/apps/rising-shows/sitemap-shows.xml</loc>
    <lastmod>2026-05-19</lastmod>
  </sitemap>
</sitemapindex>`;

test('maxLastmod returns the newest date in the document', () => {
  assert.equal(maxLastmod(SUB_SITEMAP), '2026-07-22');
});

test('maxLastmod truncates full ISO timestamps to the date', () => {
  assert.equal(maxLastmod('<lastmod>2026-07-29T08:39:00.000Z</lastmod>'), '2026-07-29');
});

test('maxLastmod returns null when no lastmod is present', () => {
  assert.equal(maxLastmod('<urlset><url><loc>x</loc></url></urlset>'), null);
});

test('maxLastmod ignores malformed values', () => {
  assert.equal(maxLastmod('<lastmod>soon</lastmod><lastmod>2026-01-02</lastmod>'), '2026-01-02');
});

test('stampSitemapIndex rewrites only the entries it has stamps for', () => {
  const out = stampSitemapIndex(INDEX, {
    'https://shevato.com/apps/rising-shows/sitemap-shows.xml': '2026-07-29',
  });
  assert.ok(out.includes('<loc>https://shevato.com/apps/rising-shows/sitemap-shows.xml</loc>\n    <lastmod>2026-07-29</lastmod>'));
  // The pages entry had no stamp and keeps its committed value.
  assert.ok(out.includes('<loc>https://shevato.com/sitemap-pages.xml</loc>\n    <lastmod>2026-07-20</lastmod>'));
});

test('stampSitemapIndex is a no-op when the stamps already match', () => {
  const out = stampSitemapIndex(INDEX, {
    'https://shevato.com/sitemap-pages.xml': '2026-07-20',
    'https://shevato.com/apps/rising-shows/sitemap-shows.xml': '2026-05-19',
  });
  assert.equal(out, INDEX);
});
