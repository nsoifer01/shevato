// Each app's `.app-about` intro is shown once, on the landing view, never
// under every tab.
//
// The blocks used to sit at the end of <main>, after every view, so in the
// tabbed apps the same ~250 words trailed the Gym Tracker calendar, the
// MapTap matrix and the Arena leaderboard alike. Gym Tracker and Arena now
// keep the block inside their landing panel; MapTap Rivals keeps it after its
// settings strip and lets setView() hide it off the Dashboard, which only
// works because main.css overrides the reset's `section { display: block }`
// for `.app-about[hidden]`. Account in the root FINDINGS.md, "App pages need
// prose".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

function assertBetween(html, startMarker, endMarker, label) {
  const about = html.indexOf('class="app-about"');
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  assert.ok(about > 0 && start > 0 && end > 0, `${label}: markers missing`);
  assert.equal(html.split('class="app-about"').length - 1, 1, `${label}: exactly one .app-about`);
  assert.ok(start < about && about < end,
    `${label}: .app-about must sit between ${startMarker} and ${endMarker}`);
}

test('Gym Tracker keeps its intro inside the Dashboard view', () => {
  assertBetween(read('apps/gym-tracker/index.html'),
    'id="home-view"', 'id="programs-view"', 'gym-tracker');
});

test('Arena keeps its intro inside the Play tab lobby', () => {
  assertBetween(read('apps/arena/index.html'),
    'id="lobby-panel"', 'id="room-panel"', 'arena');
});

test('MapTap Rivals shows its intro on the Dashboard only', () => {
  const html = read('apps/maptap-rivals/index.html');
  assert.match(html, /<section class="app-about" id="app-about"/);
  const js = read('apps/maptap-rivals/js/app.js');
  const setView = js.slice(js.indexOf('function setView('), js.indexOf('// ---------- URL routing'));
  assert.match(setView, /getElementById\('app-about'\)/);
  assert.match(setView, /\.hidden = view !== 'dashboard'/);
});

test('main.css lets `hidden` actually hide an .app-about section', () => {
  assert.match(read('assets/css/main.css'), /\.app-about\[hidden\]\s*\{\s*display:\s*none;/);
});
