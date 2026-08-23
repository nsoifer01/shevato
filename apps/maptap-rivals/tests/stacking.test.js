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
  assert.equal(zIndexOf(SYNC_CSS, '.sync-banner'), 10100);
});

test('every app dialog covers the shared site header', () => {
  const modal = zIndexOf(APP_CSS, '.modal');
  const header = zIndexOf(MAIN_CSS, '#header');
  assert.ok(modal > header, `.modal z-index ${modal} must beat #header ${header}`);
});

test('the toast covers an open dialog and stays under the offline banner', () => {
  const toast = zIndexOf(APP_CSS, '.share-toast');
  const modal = zIndexOf(APP_CSS, '.modal');
  const banner = zIndexOf(SYNC_CSS, '.sync-banner');
  assert.ok(toast > modal, `.share-toast ${toast} must beat .modal ${modal}`);
  assert.ok(toast < banner, `.share-toast ${toast} must stay under .sync-banner ${banner}`);
});

test('.share-toast declares its z-index exactly once', () => {
  // A second declaration in a later block is how the toast silently dropped
  // from 9999 to 2000 (under the header) in the 2026-08-22 pass.
  assert.equal(zIndexDecls(APP_CSS, '.share-toast').length, 1,
    'set .share-toast z-index on its base rule only');
});

test('all five dialogs share the .modal class, so one rule covers them all', () => {
  const html = fs.readFileSync(path.join(REPO, 'apps', 'maptap-rivals', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/<div class="modal" id="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(ids, ['clear-games-modal', 'delete-game-modal', 'delete-rival-modal', 'rival-modal', 'wa-modal']);
});
