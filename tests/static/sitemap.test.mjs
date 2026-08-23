// The sitemap index and the hand-maintained pages sitemap stay truthful.
//
// sitemap.xml is the one URL registered in Search Console; it points at
// three sub-sitemaps, of which sitemap-pages.xml is committed by hand and
// the other two are generated at deploy. A pages sitemap that lists a URL
// whose canonical says something else, a noindex page, a page that does not
// exist in a clean clone, or a lastmod in the future, is a crawl-budget and
// trust problem Google only reports weeks later (the 2026-06 GSC round found
// /home listed with a stale lastmod while the canonical pointed elsewhere).
// Conversely an indexable page missing from the sitemap is invisible to the
// index's own freshness signal.
//
// So this file cross-checks sitemap-pages.xml against the pages themselves:
// every loc resolves (via the same pageFileForLoc the build's stamping
// script uses) to a tracked file or one of the two deploy-generated hubs,
// the page's canonical equals the loc byte for byte, no listed page is
// noindex, every indexable page is listed exactly once, and every lastmod
// is a plain YYYY-MM-DD no later than today. hreflang alternates are
// asserted absent: the site is single-language per URL and a stray
// xhtml:link would advertise alternates that do not exist.
//
// The robots.txt "exactly one Sitemap: line -> sitemap.xml" assertion lives
// in sync-system/tests/app-naming-consistency.test.mjs and is not repeated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { pageFileForLoc } from '../../scripts/stamp-sitemap-index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://shevato.com/';
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const INDEX_XML = read('sitemap.xml');
const PAGES_XML = read('sitemap-pages.xml');

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean)
);

// Hubs that exist on production only after `npm run build:site` (same two
// entries as tests/static/internal-links.test.mjs).
const GENERATED_HUBS = new Set([
  'apps/rising-shows/shows/index.html',
  'apps/gym-tracker/exercises/index.html',
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TODAY = new Date().toISOString().slice(0, 10);

const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
const urlBlocks = (xml) => [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);

// -- sitemap.xml (the index) ---------------------------------------------------------

test('sitemap.xml is a well-formed sitemapindex', () => {
  assert.ok(INDEX_XML.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'missing XML declaration');
  assert.match(INDEX_XML, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.ok(INDEX_XML.trim().endsWith('</sitemapindex>'), 'document must close the sitemapindex');
  const opens = (INDEX_XML.match(/<sitemap>/g) || []).length;
  const closes = (INDEX_XML.match(/<\/sitemap>/g) || []).length;
  assert.equal(opens, closes, 'unbalanced <sitemap> elements');
  assert.ok(!/<urlset/.test(INDEX_XML), 'the index must not also be a urlset');
});

test('sitemap.xml lists exactly the three sub-sitemaps', () => {
  assert.deepEqual(locsOf(INDEX_XML), [
    `${ORIGIN}sitemap-pages.xml`,
    `${ORIGIN}apps/rising-shows/sitemap-shows.xml`,
    `${ORIGIN}apps/gym-tracker/sitemap-exercises.xml`,
  ]);
});

test('sitemap.xml index lastmod values, where present, are YYYY-MM-DD', () => {
  const bad = [...INDEX_XML.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)]
    .map((m) => m[1].trim())
    .filter((v) => !DATE.test(v));
  assert.deepEqual(bad, [], 'index lastmod must be a plain date (the stamping script writes %cs)');
});

// -- sitemap-pages.xml ---------------------------------------------------------------

const PAGE_LOCS = locsOf(PAGES_XML);

test('sitemap-pages.xml is a well-formed urlset with no duplicate locs', () => {
  assert.ok(PAGES_XML.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'missing XML declaration');
  assert.match(PAGES_XML, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.ok(PAGES_XML.trim().endsWith('</urlset>'), 'document must close the urlset');
  assert.equal(urlBlocks(PAGES_XML).length, PAGE_LOCS.length, 'every <url> block carries exactly one <loc>');
  const dupes = PAGE_LOCS.filter((loc, i) => PAGE_LOCS.indexOf(loc) !== i);
  assert.deepEqual(dupes, [], 'duplicate <loc> entries');
});

test('sitemap-pages.xml carries no hreflang alternates', () => {
  assert.ok(!/hreflang|xhtml:link/.test(PAGES_XML), 'the pages sitemap must not declare hreflang alternates');
});

test('every pages entry has a lastmod that is a YYYY-MM-DD date not in the future', () => {
  const problems = [];
  for (const block of urlBlocks(PAGES_XML)) {
    const loc = (block.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    const lastmods = [...block.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map((m) => m[1].trim());
    if (lastmods.length !== 1) { problems.push(`${loc}: ${lastmods.length} lastmod elements`); continue; }
    if (!DATE.test(lastmods[0])) problems.push(`${loc}: lastmod "${lastmods[0]}" is not YYYY-MM-DD`);
    else if (lastmods[0] > TODAY) problems.push(`${loc}: lastmod ${lastmods[0]} is after today (${TODAY})`);
  }
  assert.deepEqual(problems, []);
});

for (const loc of PAGE_LOCS) {
  test(`sitemap-pages.xml entry ${loc} names a real, indexable page whose canonical matches`, () => {
    assert.ok(loc.startsWith(ORIGIN), `loc must be absolute under ${ORIGIN}`);
    const file = pageFileForLoc(loc);
    if (GENERATED_HUBS.has(file)) {
      assert.ok(!tracked.has(file), `${file} is tracked now; drop it from GENERATED_HUBS`);
      return; // generated at deploy, nothing on disk to cross-check
    }
    assert.ok(tracked.has(file), `${loc} maps to ${file}, which is not a git-tracked file`);
    const html = read(file);
    const canonical = (html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i) || [])[1];
    assert.equal(canonical, loc, `${file}: canonical must equal the sitemap loc exactly`);
    const robots = (html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i) || [])[1] || '';
    assert.ok(!/noindex/i.test(robots), `${file} is noindex ("${robots}") but listed in the sitemap`);
  });
}

// -- Coverage: every indexable page is listed exactly once --------------------------

const manifest = JSON.parse(read('assets/apps-manifest.json'));
// index.html is the apex stub (301'd at the edge, never a destination) and
// google10670283c9d04acd.html is the Search Console token; 404.html is
// noindex and drops out via the robots check below.
const CANDIDATE_PAGES = [
  'home.html', 'work.html', 'apps.html', 'about.html', 'contact.html', 'privacy.html',
  'moadon-alef.html', '404.html',
  ...manifest.apps.map((a) => `apps/${a.slug}/index.html`),
  'apps/rising-shows/kometa/index.html',
];

test('every indexable root and app page is listed exactly once in sitemap-pages.xml', () => {
  const problems = [];
  let indexable = 0;
  for (const page of CANDIDATE_PAGES) {
    const html = read(page);
    const robots = (html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i) || [])[1] || '';
    const canonical = (html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i) || [])[1];
    const wantsIndex = /(^|[\s,])index([\s,]|$)/i.test(robots) && !/noindex/i.test(robots);
    if (!wantsIndex || !canonical) continue;
    indexable += 1;
    const n = PAGE_LOCS.filter((loc) => loc === canonical).length;
    if (n !== 1) problems.push(`${page} (canonical ${canonical}) listed ${n} times`);
  }
  assert.ok(indexable >= 15, `only ${indexable} indexable pages found; the page scan is broken`);
  assert.deepEqual(problems, []);
});
