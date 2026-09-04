// scripts/inline-partials.mjs stamps the header and footer into the HTML at
// deploy, so the site's navigation is in the served bytes rather than behind
// a runtime fetch (see the script header for the outage that motivated it).
//
// These tests run against the pure transform, not the filesystem, so they
// pass in a clean clone where the build has never run. What they pin:
//   - the placeholder is replaced, keeps its name, and swaps to the
//     `data-include-inlined` attribute main.js activates;
//   - the operation is idempotent, so a second build in a working clone
//     cannot double-stamp a page;
//   - an unknown partial name is reported rather than silently emptied;
//   - every partial the pages reference actually exists on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlinePartials, readPartials } from '../../scripts/inline-partials.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const PARTIALS = { header: '<header id="header">nav</header>\n', footer: '<footer id="footer">end</footer>\n' };

test('the placeholder is replaced with the partial markup', () => {
  const src = '<body>\n  <div data-include="header"></div>\n  <main>hi</main>\n</body>';
  const { html, inlined, missing } = inlinePartials(src, PARTIALS);

  assert.deepEqual(inlined, ['header']);
  assert.deepEqual(missing, []);
  assert.match(html, /<div data-include-inlined="header">/);
  assert.match(html, /<header id="header">nav<\/header>/);
  assert.doesNotMatch(html, /data-include="header"/,
    'the fetch-triggering attribute must be gone, or main.js loads the partial on top of itself');
  assert.match(html, /<main>hi<\/main>/, 'the rest of the page is untouched');
});

test('indentation of the placeholder is carried onto the inlined markup', () => {
  const { html } = inlinePartials('    <div data-include="footer"></div>', PARTIALS);
  assert.match(html, /^ {4}<div data-include-inlined="footer">\n {6}<footer id="footer">end<\/footer>\n {4}<\/div>$/);
});

test('stamping twice changes nothing the second time', () => {
  const src = '<div data-include="header"></div>\n<div data-include="footer"></div>';
  const once = inlinePartials(src, PARTIALS).html;
  const twice = inlinePartials(once, PARTIALS);
  assert.equal(twice.html, once);
  assert.deepEqual(twice.inlined, [], 'nothing left to stamp on a second pass');
});

test('a placeholder naming a partial that does not exist is reported, not emptied', () => {
  const src = '<div data-include="sidebar"></div>';
  const { html, inlined, missing } = inlinePartials(src, PARTIALS);
  assert.deepEqual(missing, ['sidebar']);
  assert.deepEqual(inlined, []);
  assert.equal(html, src, 'left untouched so the runtime fetch still has a chance');
});

test('other attributes on the placeholder survive', () => {
  // apps/mario-kart/index.html carries
  // `<div data-include="footer" class="mario-kart-footer"></div>`; an early
  // version of the transform required data-include to be the only attribute
  // and silently skipped that page's footer.
  const { html, inlined } = inlinePartials(
    '<div data-include="footer" class="mario-kart-footer"></div>', PARTIALS);
  assert.deepEqual(inlined, ['footer']);
  assert.match(html, /class="mario-kart-footer"/);
  assert.match(html, /data-include-inlined="footer"/);
});

test('an empty div with no data-include is not touched', () => {
  const src = '<div class="spacer"></div>';
  assert.equal(inlinePartials(src, PARTIALS).html, src);
});

test('a placeholder with content is left alone', () => {
  // Only the empty `<div data-include="x"></div>` form is a placeholder;
  // anything already carrying markup is not ours to overwrite.
  const src = '<div data-include="header"><b>already here</b></div>';
  assert.equal(inlinePartials(src, PARTIALS).html, src);
});

test('every partial referenced by a page exists in partials/', () => {
  const available = new Set(Object.keys(readPartials(join(REPO_ROOT, 'partials'))));
  const manifest = JSON.parse(read('assets/apps-manifest.json'));
  const pages = [
    'index.html', 'home.html', 'work.html', 'apps.html', 'about.html',
    'contact.html', 'privacy.html', 'moadon-alef.html', '404.html',
    ...manifest.apps.map((a) => `apps/${a.slug}/index.html`),
    'apps/rising-shows/kometa/index.html'
  ].filter((p) => existsSync(join(REPO_ROOT, p)));

  const dangling = [];
  for (const page of pages) {
    for (const m of read(page).matchAll(/data-include(?:-inlined)?="([A-Za-z0-9._-]+)"/g)) {
      if (!available.has(m[1])) dangling.push(`${page} -> ${m[1]}`);
    }
  }
  assert.deepEqual(dangling, [], 'the deploy build throws on a dangling include');
});

test('nothing selects data-include without also selecting data-include-inlined', () => {
  // The stamping step renames the attribute, and it only runs at deploy. A
  // CSS selector or a piece of JS that names only `data-include` therefore
  // works in every local check and silently stops working in production.
  // main.css's sticky-footer rules shipped exactly that way for one commit
  // during this round: `body:has(> [data-include="footer"])` matched nothing
  // once the footer had been stamped in.
  //
  // The one legitimate exception is main.js's own runtime-fetch loop, which
  // must match ONLY the un-stamped form or it would re-fetch a partial that
  // is already inlined.
  const FETCH_LOOP = "jQuery.each($('[data-include]')";
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const cssFiles = ['assets/css/main.css',
    ...['arena', 'football-h2h', 'fpl-planner', 'gym-tracker', 'maptap-rivals',
      'mario-kart', 'rising-shows', 'trip-planner'].map((s) => `apps/${s}/css/styles.css`)
  ].filter((p) => existsSync(join(REPO_ROOT, p)));
  const jsFiles = ['assets/js/main.js',
    ...['arena', 'football-h2h', 'fpl-planner', 'gym-tracker', 'maptap-rivals',
      'mario-kart', 'rising-shows', 'trip-planner'].map((s) => `apps/${s}/js/app.js`)
  ].filter((p) => existsSync(join(REPO_ROOT, p)));

  const offenders = [];

  // CSS: the unit is the whole selector GROUP, not a line - a group listing
  // both attribute forms spans two lines and each line alone looks wrong.
  for (const rel of cssFiles) {
    for (const block of stripComments(read(rel)).split('}')) {
      const selector = block.slice(0, block.indexOf('{'));
      if (!/\[data-include="/.test(selector)) continue;
      if (selector.includes('data-include-inlined')) continue;
      offenders.push(`${rel}: ${selector.trim().replace(/\s+/g, ' ')}`);
    }
  }

  for (const rel of jsFiles) {
    for (const line of stripComments(read(rel)).split('\n')) {
      if (!/\[data-include="/.test(line)) continue;
      if (line.includes(FETCH_LOOP) || line.includes('data-include-inlined')) continue;
      offenders.push(`${rel}: ${line.trim()}`);
    }
  }

  assert.deepEqual(offenders, [],
    'these match the placeholder but not the stamped form, so they break only on production');
});

test('partials/ holds only the three partials the site uses', () => {
  // A new partial is fine, but it has to be a deliberate act: this catches a
  // stray file landing in a directory the build reads wholesale.
  assert.deepEqual(
    readdirSync(join(REPO_ROOT, 'partials')).filter((f) => f.endsWith('.html')).sort(),
    ['footer-moadon-alef.html', 'footer.html', 'header.html']
  );
});
