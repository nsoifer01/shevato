// No duplicate id="..." attributes within a page.
//
// Duplicate IDs are invalid HTML and break getElementById, label[for],
// aria-labelledby and anchor links in whichever way the browser feels like.
// Regex-level parse: script and style bodies are stripped first so ids
// inside inline JS template strings (modal markup built in JS, etc.) cannot
// false-positive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const ROOT_PAGES = [
  'index.html',
  'home.html',
  'work.html',
  'apps.html',
  'about.html',
  'contact.html',
  'privacy.html',
  'moadon-alef.html',
  '404.html'
];

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'assets', 'apps-manifest.json'), 'utf8'));
const APP_PAGES = manifest.apps.map((a) => join('apps', a.slug, 'index.html'));

function duplicateIds(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const counts = new Map();
  // \s before id= keeps this from matching data-grid="..." etc.
  for (const m of stripped.matchAll(/\s+id\s*=\s*["']([^"']+)["']/gi)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} (x${n})`);
}

for (const page of [...ROOT_PAGES, ...APP_PAGES]) {
  test(`no duplicate element ids in ${page}`, () => {
    const html = readFileSync(join(REPO_ROOT, page), 'utf8');
    assert.deepEqual(duplicateIds(html), [], `duplicate id attributes in ${page}`);
  });
}
