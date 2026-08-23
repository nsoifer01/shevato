// Every URL the site advertises for itself is the extensionless / trailing-
// slash form, never a `.html` one.
//
// Netlify's Pretty URLs serves `foo.html` at both /foo.html and /foo, and
// netlify.toml now 301s the .html form onto the clean one (see
// tests/static/netlify-redirects.test.mjs). That only helps if nothing on
// the site keeps pointing search engines, social scrapers and browsers at
// the redirected variant: a canonical / og:url / JSON-LD / sitemap /
// manifest / redirect target written as `.html` is a self-inflicted
// redirect hop and a duplicate-URL signal (the 2026-08-22 audit found
// generator breadcrumbs still naming /home.html and /apps.html, a
// site.webmanifest start_url of /home.html, and the apex redirect landing
// on /home.html).
//
// Deliberately OUT of scope: plain <a href> / <link href> inside page bodies
// and partials. Those keep the `.html` form on purpose so the repo works
// under a plain static server (python http.server, the browser harness),
// and Netlify rewrites them at the edge. This file only checks the
// surfaces that declare a URL as "the" URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://shevato.com';

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// -- Pages under test --------------------------------------------------------

// 404.html carries neither a canonical nor an og:url (it is noindex and
// served at whatever URL missed); index.html is the apex stub and carries a
// canonical pointing at /home but no social tags. Both are checked only for
// what they do declare.
const ROOT_PAGES = ['index.html', 'home.html', 'work.html', 'apps.html', 'about.html',
  'contact.html', 'privacy.html', 'moadon-alef.html', '404.html'];
const OPTIONAL_TAGS = new Set(['index.html', '404.html']);

const manifest = JSON.parse(read('assets/apps-manifest.json'));
const APP_PAGES = [
  ...manifest.apps.map((a) => `apps/${a.slug}/index.html`),
  'apps/rising-shows/kometa/index.html',
];
const ALL_PAGES = [...ROOT_PAGES, ...APP_PAGES];

// -- Helpers ------------------------------------------------------------------

function attr(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}
const canonicalOf = (html) => attr(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
const ogUrlOf = (html) => attr(html, /<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);

// The problems with a self-declared page URL, as a list (empty = fine).
function urlProblems(url, { directoryPage }) {
  const out = [];
  if (!url.startsWith(`${ORIGIN}/`)) out.push(`not an absolute ${ORIGIN} URL`);
  if (/\.html(\?|#|$)/i.test(url)) out.push('ends in .html');
  if (/index\.html/i.test(url)) out.push('names index.html');
  if (/[?#]/.test(url)) out.push('carries a query or fragment');
  if (directoryPage && !url.endsWith('/')) out.push('directory page URL must end with "/"');
  if (!directoryPage && url.endsWith('/') && url !== `${ORIGIN}/`) out.push('root page URL must not end with "/"');
  return out;
}

// Every https://shevato.com/... string inside the page's JSON-LD blocks.
function jsonLdUrls(html) {
  const urls = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const u of m[1].matchAll(/https:\/\/shevato\.com[^"'\s<\\]*/g)) urls.push(u[0]);
  }
  return urls;
}

// -- Per-page canonical / og:url ----------------------------------------------

for (const page of ALL_PAGES) {
  test(`${page}: canonical and og:url are clean absolute URLs that agree`, () => {
    const html = read(page);
    const directoryPage = page.endsWith('/index.html') && page !== 'index.html';
    const canonical = canonicalOf(html);
    const ogUrl = ogUrlOf(html);

    if (!OPTIONAL_TAGS.has(page)) {
      assert.ok(canonical, `${page} has no <link rel="canonical">`);
      assert.ok(ogUrl, `${page} has no og:url`);
    }
    for (const [label, url] of [['canonical', canonical], ['og:url', ogUrl]]) {
      if (!url) continue;
      assert.deepEqual(urlProblems(url, { directoryPage }), [], `${page} ${label} "${url}"`);
    }
    if (canonical && ogUrl) {
      assert.equal(ogUrl, canonical, `${page}: og:url must equal the canonical`);
    }
  });

  test(`${page}: JSON-LD page URLs are extensionless`, () => {
    const bad = jsonLdUrls(read(page))
      .map((u) => u.split(/[?#]/)[0])
      .filter((u) => !u.startsWith(`${ORIGIN}/images/`))
      .filter((u) => /\.html$/i.test(u) || /index\.html/i.test(u));
    assert.deepEqual(bad, [], `${page}: JSON-LD names .html page URLs`);
  });
}

// -- Generator sources ---------------------------------------------------------
//
// The rising-shows and gym-tracker page builders emit ~35k pages at deploy
// time, each with breadcrumb JSON-LD pointing back at the site. A `.html`
// literal in one template is a `.html` URL on every generated page, so the
// templates are scanned at source level (their output is gitignored).

function filesIn(dir, ext) {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => `${dir}/${f}`);
}
const GENERATOR_SOURCES = [
  ...filesIn('apps/rising-shows/scripts', '.js'),
  ...filesIn('apps/gym-tracker/scripts', '.cjs'),
];
const HTML_LITERAL = /\/home\.html|\/apps\.html|SITE\}[^`'"\n]*\.html|shevato\.com[^`'"\s]*\.html/;

test('generator sources name no .html site URLs', () => {
  assert.ok(GENERATOR_SOURCES.length >= 5, 'generator source scan found too few files');
  const hits = [];
  for (const file of GENERATOR_SOURCES) {
    read(file).split('\n').forEach((line, i) => {
      if (HTML_LITERAL.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], 'generated pages would advertise .html URLs');
});

// -- Entry points that name the homepage ---------------------------------------

test('site.webmanifest start_url is /home', () => {
  const manifestJson = JSON.parse(read('site.webmanifest'));
  assert.equal(manifestJson.start_url, '/home');
});

test('index.html meta refresh and apex-redirect.js both target /home', () => {
  const refresh = attr(read('index.html'), /<meta\s+http-equiv=["']refresh["']\s+content=["']([^"']+)["']/i);
  assert.ok(refresh, 'index.html has no meta refresh fallback');
  assert.match(refresh, /^\s*0\s*;\s*url=\/home\s*$/i, `meta refresh "${refresh}" must target /home`);
  const apex = read('assets/js/apex-redirect.js');
  assert.match(apex, /location\.replace\(\s*'\/home'/, 'apex-redirect.js must land on /home');
  assert.ok(!/\.html/.test(apex.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'apex-redirect.js code names a .html URL');
});

// -- sitemap-pages.xml ----------------------------------------------------------

test('sitemap-pages.xml locs are extensionless or slash form, with no .html hreflang', () => {
  const xml = read('sitemap-pages.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  assert.ok(locs.length >= 10, `sitemap-pages.xml lists only ${locs.length} URLs`);
  const bad = locs.filter((loc) => urlProblems(loc, { directoryPage: loc.endsWith('/') }).length > 0);
  assert.deepEqual(bad, [], 'sitemap-pages.xml advertises non-canonical URL forms');
  const hreflangHtml = [...xml.matchAll(/<xhtml:link[^>]*hreflang[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\.html/.test(tag));
  assert.deepEqual(hreflangHtml, [], 'hreflang alternates must not point at .html URLs');
});

// -- netlify.toml ------------------------------------------------------------------

const NETLIFY_TOML = read('netlify.toml');
// Sections start at a line beginning with "["; keep the [[redirects]] ones.
const REDIRECTS = NETLIFY_TOML.split(/^(?=\[)/m)
  .filter((section) => section.startsWith('[[redirects]]'))
  .map((section) => ({
    from: (section.match(/^\s*from\s*=\s*"([^"]+)"/m) || [])[1],
    to: (section.match(/^\s*to\s*=\s*"([^"]+)"/m) || [])[1],
  }));

test('netlify.toml redirect targets never end in .html', () => {
  assert.ok(REDIRECTS.length >= 10, 'redirect parse found too few rules');
  const bad = REDIRECTS.filter((r) => !r.to || /\.html$/i.test(r.to)).map((r) => `${r.from} -> ${r.to}`);
  assert.deepEqual(bad, [], 'a redirect landing on .html creates a second hop onto the clean URL');
});

// A netlify `from` pattern matches a path the way Netlify matches it: literal
// segments, :name placeholders for one segment, a trailing * for the rest.
function fromMatches(from, path) {
  const re = new RegExp('^' + from
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z_]+/g, '[^/]+')
    .replace(/\*/g, '.*') + '$');
  return re.test(path);
}

test('no tracked HTML page declares an hreflang alternate that netlify.toml redirects', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '*.html'], { cwd: REPO_ROOT })
    .toString('utf8').split('\0').filter(Boolean);
  const problems = [];
  for (const file of tracked) {
    for (const m of read(file).matchAll(/<link\b[^>]*rel=["']alternate["'][^>]*>/gi)) {
      const tag = m[0];
      if (!/hreflang=/i.test(tag)) continue;
      const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1] || '';
      const path = href.startsWith(ORIGIN) ? href.slice(ORIGIN.length) : href;
      const hit = REDIRECTS.find((r) => r.from && fromMatches(r.from, path.split(/[?#]/)[0]));
      if (hit) problems.push(`${file}: hreflang href "${href}" is redirected by from="${hit.from}"`);
    }
  }
  assert.deepEqual(problems, [], 'hreflang alternates must name final URLs, not redirected ones');
});
