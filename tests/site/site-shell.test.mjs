// Tests for the shevato.com site shell: partials, marketing-page metadata,
// home/apps-specific features, and the moadon-alef multilingual landing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function fileExists(rel) {
  try { statSync(join(REPO_ROOT, rel)); return true; } catch { return false; }
}

// ── 1. Partial structure tests ────────────────────────────────────────────────

const HEADER = read('partials/header.html');
const FOOTER = read('partials/footer.html');

test('header partial contains a .desktop-nav element', () => {
  assert.match(HEADER, /class="desktop-nav"/);
});

test('header desktop-nav has links to work, apps, about, and contact', () => {
  for (const page of ['work', 'apps', 'about', 'contact']) {
    assert.match(HEADER, new RegExp(`href="/\\w*${page}\\.html"`), `missing nav link to ${page}`);
  }
});

test('header desktop-nav links each carry a data-nav attribute matching their target page', () => {
  for (const page of ['home', 'work', 'apps', 'about', 'contact']) {
    assert.match(HEADER, new RegExp(`data-nav="${page}"`), `missing data-nav="${page}"`);
  }
});

test('header still contains the hamburger/menu toggle element', () => {
  assert.match(HEADER, /data-js="menu-toggle"/);
});

test('footer has a Site column with Home, Work, About, Contact links', () => {
  assert.match(FOOTER, /<h4>Site<\/h4>/);
  for (const label of ['Home', 'Work', 'About', 'Contact']) {
    assert.match(FOOTER, new RegExp(`>${label}</a>`), `footer Site column missing ${label}`);
  }
});

test('footer has an Apps column with all 6 apps', () => {
  assert.match(FOOTER, /<h4>Apps<\/h4>/);
  const apps = ['mario-kart', 'gym-tracker', 'football-h2h', 'rising-seasons', 'maptap-rivals', 'arena'];
  for (const app of apps) {
    assert.match(FOOTER, new RegExp(`href="/apps/${app}/"`), `footer missing link to ${app}`);
  }
});

// ── 2. Marketing page meta tests (loop) ───────────────────────────────────────

const MARKETING_PAGES = ['home', 'work', 'apps', 'about', 'contact'];

for (const page of MARKETING_PAGES) {
  const src = read(`${page}.html`);

  test(`${page}.html has <body data-page="${page}">`, () => {
    assert.match(src, new RegExp(`data-page="${page}"`));
  });

  test(`${page}.html has og:image:width, og:image:height, og:image:type`, () => {
    assert.match(src, /og:image:width/, `${page} missing og:image:width`);
    assert.match(src, /og:image:height/, `${page} missing og:image:height`);
    assert.match(src, /og:image:type/, `${page} missing og:image:type`);
  });

  test(`${page}.html has og:image:alt and twitter:image:alt`, () => {
    assert.match(src, /og:image:alt/, `${page} missing og:image:alt`);
    assert.match(src, /twitter:image:alt/, `${page} missing twitter:image:alt`);
  });

  test(`${page}.html has GA dns-prefetch for google-analytics.com`, () => {
    assert.match(src, /dns-prefetch.*google-analytics\.com/, `${page} missing GA dns-prefetch`);
  });

  test(`${page}.html has a canonical link`, () => {
    assert.match(src, /rel="canonical"/, `${page} missing canonical link`);
  });

  test(`${page}.html has data-include="header" placeholder`, () => {
    assert.match(src, /data-include="header"/, `${page} missing header partial placeholder`);
  });

  test(`${page}.html has data-include="footer" placeholder`, () => {
    assert.match(src, /data-include="footer"/, `${page} missing footer partial placeholder`);
  });
}

// ── 3. home.html-specific tests ───────────────────────────────────────────────

const HOME = read('home.html');
const APPS_DIR = join(REPO_ROOT, 'apps');

test('home.html has a .cta-banner element', () => {
  assert.match(HOME, /class="cta-banner"/);
});

test('home.html has the 6-icon app strip (.app-icon-strip)', () => {
  assert.match(HOME, /class="app-icon-strip"/);
});

test('home.html app icon strip has one link per app pointing to /apps/<name>/', () => {
  const apps = ['mario-kart', 'gym-tracker', 'football-h2h', 'rising-seasons', 'maptap-rivals', 'arena'];
  for (const app of apps) {
    assert.match(HOME, new RegExp(`href="/apps/${app}/"`), `home.html missing app strip link for ${app}`);
  }
});

test('every app linked from the home.html icon strip exists as a directory on disk', () => {
  const apps = ['mario-kart', 'gym-tracker', 'football-h2h', 'rising-seasons', 'maptap-rivals', 'arena'];
  const missing = apps.filter(app => !fileExists(`apps/${app}`));
  assert.deepEqual(missing, [], `app directories missing: ${missing.join(', ')}`);
});

// ── 4. apps.html-specific tests ───────────────────────────────────────────────

const APPS = read('apps.html');

test('apps.html loads site.css', () => {
  assert.match(APPS, /href=".*site\.css"/);
});

test('apps.html has 6 .app-tile elements', () => {
  const tileCount = (APPS.match(/class="app-tile"/g) || []).length;
  assert.equal(tileCount, 6, `expected 6 .app-tile elements, got ${tileCount}`);
});

test('apps.html app tiles each use a <picture> with WebP + PNG sources', () => {
  const pictureCount = (APPS.match(/<picture>/g) || []).length;
  assert.equal(pictureCount, 6, `expected 6 <picture> elements, got ${pictureCount}`);
  const webpCount = (APPS.match(/type="image\/webp"/g) || []).length;
  assert.equal(webpCount, 6, `expected 6 WebP <source> elements, got ${webpCount}`);
  assert.match(APPS, /\.png"/, 'expected PNG fallback <img>');
});

test('apps.html has a .data-explainer band', () => {
  assert.match(APPS, /class="data-explainer"/);
});

test('apps.html has a .cta-banner linking to work.html', () => {
  assert.match(APPS, /class="cta-banner"/);
  assert.match(APPS, /href="work\.html"/);
});

test('all app screenshot images referenced by apps.html exist on disk', () => {
  const apps = ['mario-kart', 'gym-tracker', 'football-h2h', 'rising-seasons', 'maptap-rivals', 'arena'];
  const missing = [];
  for (const app of apps) {
    if (!fileExists(`images/apps/${app}.png`)) missing.push(`images/apps/${app}.png`);
    if (!fileExists(`images/apps/${app}.webp`)) missing.push(`images/apps/${app}.webp`);
  }
  assert.deepEqual(missing, [], `screenshot files missing: ${missing.join(', ')}`);
});

// ── 5. moadon-alef.html tests ─────────────────────────────────────────────────

const MOADON = read('moadon-alef.html');

test('moadon-alef.html root <html> is lang="he" dir="rtl"', () => {
  assert.match(MOADON, /<html[^>]+lang="he"[^>]*dir="rtl"/);
});

test('moadon-alef.html explicit English elements have dir="ltr"', () => {
  // Every element with lang="en" that carries inline text should also declare
  // dir="ltr" so it renders left-to-right inside the RTL document.
  const enLtrCount = (MOADON.match(/lang="en"[^>]*dir="ltr"|dir="ltr"[^>]*lang="en"/g) || []).length;
  assert.ok(enLtrCount >= 3, `expected at least 3 lang="en" dir="ltr" elements, got ${enLtrCount}`);
});

test('moadon-alef.html explicit Russian elements have dir="ltr"', () => {
  const ruLtrCount = (MOADON.match(/lang="ru"[^>]*dir="ltr"|dir="ltr"[^>]*lang="ru"/g) || []).length;
  assert.ok(ruLtrCount >= 3, `expected at least 3 lang="ru" dir="ltr" elements, got ${ruLtrCount}`);
});

test('moadon-alef.html primary meta description contains Hebrew characters', () => {
  const descMatch = MOADON.match(/<meta name="description" content="([^"]+)"/);
  assert.ok(descMatch, 'moadon-alef.html missing meta description');
  const HEBREW_RANGE = /[֐-׿]/;
  assert.match(descMatch[1], HEBREW_RANGE, 'primary meta description does not contain Hebrew characters');
});

test('moadon-alef.html moadon-alef-theme.css does not hide <html> or <body> via overbroad [lang] selector', () => {
  const css = read('assets/css/moadon-alef-theme.css');
  // The old bug was `[lang]:not([lang="en"]) { display: none; }` which matched
  // the root <html lang="he"> and blanked the entire page. The selector must
  // now be scoped so <html> and <body> are never targeted.
  const badSelector = /^\s*\[lang\]\s*:not\(\[lang="en"\]\)\s*\{/m;
  assert.doesNotMatch(css, badSelector,
    'moadon-alef-theme.css still contains the overbroad [lang] selector that hides <html>');
});

// ── 6. SEO README resource hints section ─────────────────────────────────────

test('assets/seo/README.md contains a "Resource hints" section', () => {
  const readme = read('assets/seo/README.md');
  assert.match(readme, /Resource hints/i);
});
