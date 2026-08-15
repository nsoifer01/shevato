// Every <script type="application/ld+json"> block on the root pages is
// valid JSON and structurally sane (@context + @type).
//
// Scope note: sync-system/tests/app-naming-consistency.test.mjs already
// asserts the CONTENT of apps.html's CollectionPage JSON-LD (A-Z ordering,
// one hasPart per app). This file deliberately checks only VALIDITY, across
// all root pages, so a stray comma in any structured-data block fails the
// build instead of silently killing rich results.

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

// Apps' index pages carry JSON-LD too; validate them with the same rule.
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'assets', 'apps-manifest.json'), 'utf8'));
const APP_PAGES = manifest.apps.map((a) => join('apps', a.slug, 'index.html'));

function extractJsonLdBlocks(html) {
  return [...html.matchAll(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]);
}

/** A node is valid when it (or each entry of an array / @graph) has @type. */
function assertNodeShape(node, where) {
  if (Array.isArray(node)) {
    assert.ok(node.length > 0, `${where}: empty JSON-LD array`);
    for (const entry of node) assertNodeShape(entry, where);
    return;
  }
  assert.equal(typeof node, 'object', `${where}: JSON-LD root must be an object`);
  if (node['@graph']) {
    assert.ok(node['@context'], `${where}: @graph document needs @context`);
    assertNodeShape(node['@graph'], where);
    return;
  }
  assert.ok(node['@type'], `${where}: missing @type`);
}

let totalBlocks = 0;

for (const page of [...ROOT_PAGES, ...APP_PAGES]) {
  test(`JSON-LD blocks in ${page} are valid`, () => {
    const html = readFileSync(join(REPO_ROOT, page), 'utf8');
    const blocks = extractJsonLdBlocks(html);
    totalBlocks += blocks.length;

    blocks.forEach((raw, i) => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        assert.fail(`${page} JSON-LD block #${i + 1} is not valid JSON: ${err.message}`);
      }
      const where = `${page} block #${i + 1}`;
      // Top-level @context is required unless the root is an array of
      // self-contained nodes (each then needs its own @context).
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          assert.ok(entry['@context'], `${where}: array entry missing @context`);
        }
      } else {
        assert.ok(parsed['@context'], `${where}: missing @context`);
      }
      assertNodeShape(parsed, where);
    });
  });
}

test('the sweep actually saw JSON-LD blocks', () => {
  // If the extraction regex rots (attribute order, quoting), every page test
  // above would pass vacuously. The site is known to carry structured data.
  assert.ok(totalBlocks >= 5, `expected at least 5 JSON-LD blocks site-wide, saw ${totalBlocks}`);
});
