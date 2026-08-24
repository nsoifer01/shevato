// The app's dialogs and toast have to sit above the SHARED site chrome, which
// this app does not own and must not restyle. e2e/quality.mjs proves it in a
// real browser by hit-testing; this file is the cheap half of the same
// guarantee, so a regression fails in `npm test` (every PR) and not only in
// the slower browser job. It reads the shipped stylesheets rather than a
// hardcoded table, so raising #header in assets/css/main.css fails here too.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const APP_CSS = fs.readFileSync(path.join(REPO, 'apps', 'maptap-rivals', 'css', 'styles.css'), 'utf8');
const MAIN_CSS = fs.readFileSync(path.join(REPO, 'assets', 'css', 'main.css'), 'utf8');
const SYNC_CSS = fs.readFileSync(path.join(REPO, 'assets', 'css', 'sync-status.css'), 'utf8');

// Last declaration wins for a plain selector at equal specificity, so read the
// LAST rule whose selector list contains this exact selector. Comments are
// stripped first, and the selector list is compared exactly so `.modal` never
// picks up `.modal-backdrop`.
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ sels: m[1].split(',').map(x => x.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

function zIndexDecls(css, selector) {
  const found = [];
  for (const r of rules(css)) {
    if (!r.sels.includes(selector)) continue;
    const hit = [...r.body.matchAll(/z-index:\s*(-?\d+)/g)].pop();
    if (hit) found.push(Number(hit[1]));
  }
  return found;
}

function zIndexOf(css, selector) {
  const found = zIndexDecls(css, selector);
  return found.length ? found[found.length - 1] : null;
}

test('the shared site header still sits where the app expects it', () => {
  assert.equal(zIndexOf(MAIN_CSS, '#header'), 10001);
  // The banner used to sit at 10100, ABOVE the header, which made the logo,
  // the Menu toggle and Sign In unclickable for as long as it showed, and for
  // the whole offline period on every app page (site audit, 2026-08-22). It is
  // now under the header and JS positions it at the header's bottom edge, so
  // the two no longer overlap. This asserts that order rather than a literal,
  // because the ladder is what matters.
  const banner = zIndexOf(SYNC_CSS, '.sync-banner');
  const header = zIndexOf(MAIN_CSS, '#header');
  assert.ok(banner < header, `.sync-banner ${banner} must stay under #header ${header}`);
});

test('every app dialog covers the shared site header', () => {
  const modal = zIndexOf(APP_CSS, '.modal');
  const header = zIndexOf(MAIN_CSS, '#header');
  assert.ok(modal > header, `.modal z-index ${modal} must beat #header ${header}`);
});

test('the toast covers an open dialog and stays under the offline banner', () => {
  const toast = zIndexOf(APP_CSS, '.share-toast');
  const modal = zIndexOf(APP_CSS, '.modal');
  const header = zIndexOf(MAIN_CSS, '#header');
  assert.ok(toast > modal, `.share-toast ${toast} must beat .modal ${modal}`);
  // The toast used to be required to stay under the banner, which was then the
  // top layer. Now that the banner sits under the header the pair no longer
  // overlaps: the banner is a strip at the header's bottom edge and the toast
  // is an app-level message. What still has to hold is that the toast clears
  // the shared header, so it can never be half-hidden behind it. The hit-test
  // that proves the banner itself stays visible lives in e2e/quality.mjs.
  assert.ok(toast > header, `.share-toast ${toast} must clear #header ${header}`);
});

test('.share-toast declares its z-index exactly once', () => {
  // A second declaration in a later block is how the toast silently dropped
  // from 9999 to 2000 (under the header) in the 2026-08-22 pass.
  assert.equal(zIndexDecls(APP_CSS, '.share-toast').length, 1,
    'set .share-toast z-index on its base rule only');
});

test('a route change closes open dialogs', () => {
  // The rendered behaviour is pinned in e2e/quality.mjs; this is the static
  // half, so removing the call fails `npm test` too. applyUrlHash is the ONLY
  // route entry point (init and the hashchange listener both go through it),
  // so closing there covers browser Back/Forward and hand-edited URLs alike.
  const app = fs.readFileSync(path.join(REPO, 'apps', 'maptap-rivals', 'js', 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function applyUrlHash()'));
  assert.ok(/^function applyUrlHash\(\) \{\s*closeAllModals\(\);/m.test(body.replace(/^\s+/gm, '')),
    'applyUrlHash must close open dialogs before swapping the view under them');
  assert.match(app, /window\.addEventListener\('hashchange', applyUrlHash\)/);
  // Every dialog id in the markup needs a closer, or one would route away
  // through bare closeModal and leave its editing state behind.
  const html = fs.readFileSync(path.join(REPO, 'apps', 'maptap-rivals', 'index.html'), 'utf8');
  const closerBlock = app.slice(app.indexOf('function modalCloser('), app.indexOf('function modalCloser(') + 700);
  for (const m of html.matchAll(/<div class="modal" id="([^"]+)"/g)) {
    assert.ok(closerBlock.includes(`'${m[1]}'`), `modalCloser has no branch for ${m[1]}`);
  }
});

test('all five dialogs share the .modal class, so one rule covers them all', () => {
  const html = fs.readFileSync(path.join(REPO, 'apps', 'maptap-rivals', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/<div class="modal" id="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(ids, ['clear-games-modal', 'delete-game-modal', 'delete-rival-modal', 'rival-modal', 'wa-modal']);
});
