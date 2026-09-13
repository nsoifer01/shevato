// The apps hub category filters and the cards they filter must describe the
// same set of categories.
//
// A filter button is a promise that clicking it shows something. Quote Scout's
// removal (#511) deleted its card, the only `data-category="utilities"` on the
// page, but left the Utilities button behind: for two weeks production offered
// a filter that always emptied the grid, and `/apps?category=utilities` (which
// the loader honours) deep-linked straight into "No apps match your search".
// Nothing failed, because no test compared the buttons with the cards. The
// reverse drift is just as quiet: a card whose category has no button can be
// reached only through "All" and search.
//
// Everything is read from apps.html itself, so adding or retiring an app or a
// category needs no edit here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8');

const barStart = html.indexOf('class="app-filter-bar"');
const bar = barStart === -1 ? '' : html.slice(barStart, html.indexOf('</div>', barStart));
const filters = [...bar.matchAll(/<button\b[^>]*\bdata-filter="([^"]*)"/g)].map((m) => m[1]);

const grid = html.slice(html.indexOf('<div class="highlights">'));
const cardCategories = [...grid.matchAll(/<section\b[^>]*\bdata-category="([^"]*)"/g)].map((m) => m[1]);

test('the apps hub has a filter bar and cards to filter', () => {
  assert.ok(filters.length > 1, `filter buttons found: ${filters.length}`);
  assert.ok(cardCategories.length > 0, `app cards found: ${cardCategories.length}`);
  assert.ok(filters.includes('all'), 'the "All" filter must exist: it is the default and the reset');
});

test('every category filter on the apps hub matches at least one app card', () => {
  const dead = filters.filter((f) => f !== 'all' && !cardCategories.includes(f));
  assert.deepEqual(dead, [],
    `these filter buttons always show zero apps: ${dead.join(', ')}. Remove the button, or it is a card that lost its category`);
});

test('every app card on the apps hub is reachable through a category filter', () => {
  const orphaned = [...new Set(cardCategories.filter((c) => !filters.includes(c)))];
  assert.deepEqual(orphaned, [],
    `these card categories have no filter button: ${orphaned.join(', ')}`);
});

test('every filter value survives the ?category= deep-link sanitiser', () => {
  // The loader keeps only [a-z] from ?category= before looking the button up,
  // so a value with any other character could never be deep-linked.
  const script = html.slice(html.indexOf("initial.get('category')"));
  assert.match(script, /cat\.replace\(\/\[\^a-z\]\/g, ''\)/,
    'the deep-link sanitiser changed; re-derive the rule below from it');
  const unlinkable = filters.filter((f) => !/^[a-z]+$/.test(f));
  assert.deepEqual(unlinkable, [], `filter values that ?category= cannot select: ${unlinkable.join(', ')}`);
  assert.equal(new Set(filters).size, filters.length, 'a filter value is listed twice');
});
