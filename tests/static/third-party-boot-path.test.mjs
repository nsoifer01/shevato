// No page may put a third-party request on its boot path.
//
// A request that is refused fails fast and the page carries on. A request that
// is ACCEPTED AND NEVER ANSWERED (a lossy network, a captive portal, a firewall
// that drops Google or Cloudflare traffic) is different: whatever the browser is
// made to wait for waits for as long as the connection hangs. On 2026-09-13 a
// stalled www.gstatic.com request kept Gym Tracker's js/app.js from ever
// running on CI. Measured the same day with the host blackholed, every page
// that loaded a third-party resource in a blocking way stayed dead:
//
//   - a plain (deferred) module script: firebase-config.js imports the SDK
//     from www.gstatic.com, and deferred modules run in document order with
//     DOMContentLoaded waiting on them;
//   - a parser-inserted classic script without `async`: Chart.js from cdnjs in
//     Mario Kart's <head> left the page blank;
//   - a render-blocking stylesheet: Google Fonts and cdnjs Font Awesome links
//     also hold every later script, so DOMContentLoaded never fired;
//   - a stylesheet @import: it blocks the stylesheet that contains it.
//
// So: Firebase-dependent modules are `async`, a third-party script is `async`,
// a third-party stylesheet uses the site's existing non-blocking form
// (`media="print" onload="this.media='all'"`, with a <noscript> fallback), no
// CSS @imports a third-party URL, and anything a page genuinely needs in order
// is served from this origin (Chart.js is vendored as
// assets/js/chart-4.4.1.umd.min.js). The browser half,
// tests/browser/suites/site.mjs "boots with every third-party CDN stalled",
// holds every CDN request open and asserts each page still boots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rel = (file) => relative(REPO_ROOT, file).split(sep).join('/');

// Generated page trees (gitignored, tens of thousands of files) are stamped from
// the generator sources scanned below; `dist` is a hard-linked copy of the tree.
const SKIP_DIRS = new Set(['apps/gym-tracker/exercises', 'apps/rising-shows/shows']
  .map((d) => join(REPO_ROOT, ...d.split('/'))));
const GENERATOR_DIRS = ['apps/gym-tracker/scripts', 'apps/rising-shows/scripts'];

function walk(dir, keep, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(full)) walk(full, keep, acc);
    } else if (keep(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const MARKUP_FILES = [
  ...walk(REPO_ROOT, (name) => name.endsWith('.html')),
  ...GENERATOR_DIRS.flatMap((d) => walk(join(REPO_ROOT, ...d.split('/')), (name) => /\.(c?js|mjs)$/.test(name))),
];
const CSS_FILES = walk(REPO_ROOT, (name) => name.endsWith('.css'));

const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3]) : null;
};
const hasFlag = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?=\\s|=|/|$)`, 'i').test(attrs);
const isThirdParty = (url) => /^(https?:)?\/\//i.test(url || '');

const SCRIPTS = [];
const STYLESHEETS = [];
for (const file of MARKUP_FILES) {
  // Comments carry history; <noscript> fallbacks only apply with scripting off,
  // where nothing is waiting on DOMContentLoaded anyway.
  const text = readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  for (const m of text.matchAll(/<script\b([^>]*)>/gi)) {
    const src = attr(m[1], 'src');
    if (src) SCRIPTS.push({ file: rel(file), src, attrs: m[1] });
  }
  for (const m of text.matchAll(/<link\b([^>]*)>/gi)) {
    if (/(?:^|\s)stylesheet(?:\s|$)/i.test(attr(m[1], 'rel') || '')) {
      STYLESHEETS.push({ file: rel(file), href: attr(m[1], 'href'), attrs: m[1] });
    }
  }
}
const FIREBASE = SCRIPTS.filter((s) => /(?:^|\/)(firebase-config|storage-sync-robust|app-sync-init)\.js$/.test(s.src.split(/[?#]/)[0]));
const show = (t) => `${t.file}: ${t.src || t.href}`;

test('the scan finds the tags it is meant to guard', () => {
  // A walk or a regex that silently matched nothing would pass everything below.
  const gym = FIREBASE.filter((s) => s.file === 'apps/gym-tracker/index.html').map((s) => s.src.split('/').pop());
  assert.deepEqual(gym.sort(), ['app-sync-init.js', 'firebase-config.js', 'storage-sync-robust.js']);
  assert.ok(FIREBASE.length >= 30, `only ${FIREBASE.length} Firebase module tags found`);
  assert.ok(STYLESHEETS.filter((s) => isThirdParty(s.href)).length >= 20, 'expected the Google Fonts links on every page');
  assert.ok(SCRIPTS.some((s) => s.file === 'apps/mario-kart/index.html' && /chart/i.test(s.src)), 'expected Mario Kart to load Chart.js');
  assert.ok(MARKUP_FILES.some((f) => rel(f) === 'apps/gym-tracker/scripts/render-exercise-page.cjs'), 'expected the exercise-page generator in the scan');
});

test('Firebase-dependent module scripts are async modules', () => {
  const offenders = FIREBASE
    .filter((s) => attr(s.attrs, 'type') !== 'module' || !hasFlag(s.attrs, 'async'))
    .map(show);
  assert.deepEqual(offenders, [], 'a deferred module waits on www.gstatic.com and holds DOMContentLoaded; add `async`');
});

test('no third-party script is parser-blocking or deferred', () => {
  // `defer` is not enough: deferred scripts still run before DOMContentLoaded.
  const offenders = SCRIPTS.filter((s) => isThirdParty(s.src) && !hasFlag(s.attrs, 'async')).map(show);
  assert.deepEqual(offenders, [], 'make it `async` (and tolerate late arrival) or serve it from this origin');
});

test('no third-party stylesheet blocks rendering or scripts', () => {
  const offenders = STYLESHEETS
    .filter((s) => isThirdParty(s.href))
    .filter((s) => attr(s.attrs, 'media') !== 'print' || !/this\.media\s*=\s*'all'/.test(attr(s.attrs, 'onload') || ''))
    .map(show);
  assert.deepEqual(offenders, [],
    `use media="print" onload="this.media='all'" plus a <noscript> copy, as the site's own Font Awesome link does`);
});

test('no stylesheet @imports a third-party URL', () => {
  const offenders = CSS_FILES
    .filter((file) => /@import\s+(url\(\s*)?["']?(https?:)?\/\//i.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
    .map(rel);
  assert.deepEqual(offenders, [], 'an @import blocks its stylesheet; load the third-party sheet with a non-blocking <link>');
});
