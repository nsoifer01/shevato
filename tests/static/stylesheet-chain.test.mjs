// main.css has no @import chain; every page links its dependencies itself.
//
// assets/css/main.css used to @import the Raleway Google Fonts stylesheet
// and assets/css/firebase-auth.css. An @import inside a stylesheet is
// discovered only after main.css has downloaded and parsed, so both
// dependencies sat one full round trip behind the render-blocking chain on
// every page (the 2026-08-22 audit measured it). The fix moved both onto
// every page as explicit <link> tags placed before main.css, where the
// preload scanner finds them in the first HTML bytes, and deleted the
// @import lines.
//
// That fix is only as good as the last page somebody added: a new page that
// links main.css but forgets the two links loses the site font and the auth
// modal styling with no error anywhere, and a re-introduced @import quietly
// brings the chain back. So, for every git-tracked HTML page that links
// main.css: exactly one Raleway Google Fonts link, exactly one
// firebase-auth.css link, both before main.css; and main.css contains no
// @import at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const RALEWAY = 'https://fonts.googleapis.com/css?family=Raleway:300,400,500,600&display=swap';

const TRACKED_HTML = execFileSync('git', ['ls-files', '-z', '*.html'], { cwd: REPO_ROOT })
  .toString('utf8').split('\0').filter(Boolean);

// <link rel="stylesheet" href="..."> tags, in document order, with the
// position so ordering can be asserted. Comments are stripped first so a
// commented-out link cannot count.
function stylesheetLinks(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...clean.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => ({ href: (m[0].match(/\bhref=["']([^"']+)["']/i) || [])[1] || '', at: m.index }));
}

const PAGES_WITH_MAIN_CSS = TRACKED_HTML.filter((f) =>
  stylesheetLinks(read(f)).some((l) => /(^|\/)assets\/css\/main\.css(\?|$)/.test(l.href)));

test('the scan finds the pages that link main.css', () => {
  // Anchor: the homepage and every app index link the shared stylesheet.
  assert.ok(PAGES_WITH_MAIN_CSS.includes('home.html'), 'home.html should link main.css');
  assert.ok(PAGES_WITH_MAIN_CSS.length >= 15, `only ${PAGES_WITH_MAIN_CSS.length} pages link main.css`);
});

for (const page of PAGES_WITH_MAIN_CSS) {
  test(`${page} links Raleway and firebase-auth.css once each, before main.css`, () => {
    const links = stylesheetLinks(read(page));
    const fonts = links.filter((l) => l.href === RALEWAY);
    const auth = links.filter((l) => /(^|\/)assets\/css\/firebase-auth\.css(\?|$)/.test(l.href));
    const main = links.filter((l) => /(^|\/)assets\/css\/main\.css(\?|$)/.test(l.href));
    assert.equal(fonts.length, 1, `expected one Raleway stylesheet link (${RALEWAY}), found ${fonts.length}`);
    assert.equal(auth.length, 1, `expected one firebase-auth.css link, found ${auth.length}`);
    assert.equal(main.length, 1, `expected one main.css link, found ${main.length}`);
    assert.ok(fonts[0].at < main[0].at, 'the Raleway link must come before main.css');
    assert.ok(auth[0].at < main[0].at, 'the firebase-auth.css link must come before main.css');
  });
}

test('assets/css/main.css contains no @import', () => {
  const css = read('assets/css/main.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = css.split('\n').filter((line) => /@import\b/.test(line));
  assert.deepEqual(imports, [], '@import re-creates the render-blocking chain; link the dependency from the page instead');
});
