import test from 'node:test';
import assert from 'node:assert/strict';

import { maxLastmod, stampSitemapIndex, stampPagesSitemap, pageFileForLoc } from '../../scripts/stamp-sitemap-index.mjs';

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

test('stampSitemapIndex removes the lastmod of an entry whose sub-sitemap carries no dates', () => {
  const out = stampSitemapIndex(INDEX, {
    'https://shevato.com/apps/rising-shows/sitemap-shows.xml': null,
  });
  assert.ok(out.includes('<loc>https://shevato.com/apps/rising-shows/sitemap-shows.xml</loc>\n  </sitemap>'));
  assert.ok(out.includes('<loc>https://shevato.com/sitemap-pages.xml</loc>\n    <lastmod>2026-07-20</lastmod>'));
  assert.ok(!/<lastmod>2026-05-19<\/lastmod>/.test(out));
});

test('stampSitemapIndex re-adds a lastmod to an entry that had none once data exists', () => {
  const bare = INDEX.replace('\n    <lastmod>2026-05-19</lastmod>', '');
  const out = stampSitemapIndex(bare, {
    'https://shevato.com/apps/rising-shows/sitemap-shows.xml': '2026-08-01',
  });
  assert.ok(out.includes('<loc>https://shevato.com/apps/rising-shows/sitemap-shows.xml</loc>\n    <lastmod>2026-08-01</lastmod>'));
});

const PAGES = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://shevato.com/home</loc>
    <lastmod>2026-05-28</lastmod>
    <changefreq>monthly</changefreq>
  </url>
  <url>
    <loc>https://shevato.com/apps/arena/</loc>
    <lastmod>2026-08-15</lastmod>
  </url>
</urlset>`;

test('stampPagesSitemap moves a page lastmod forward to its git date but never backwards', () => {
  const out = stampPagesSitemap(PAGES, {
    'https://shevato.com/home': '2026-08-12',
    'https://shevato.com/apps/arena/': '2026-06-01',
  });
  assert.ok(out.includes('<loc>https://shevato.com/home</loc>\n    <lastmod>2026-08-12</lastmod>'));
  assert.ok(out.includes('<loc>https://shevato.com/apps/arena/</loc>\n    <lastmod>2026-08-15</lastmod>'));
});

test('pageFileForLoc follows the Pretty URLs convention', () => {
  assert.equal(pageFileForLoc('https://shevato.com/home'), 'home.html');
  assert.equal(pageFileForLoc('https://shevato.com/apps/arena/'), 'apps/arena/index.html');
  assert.equal(pageFileForLoc('https://shevato.com/apps/gym-tracker/exercises/'), 'apps/gym-tracker/exercises/index.html');
});
