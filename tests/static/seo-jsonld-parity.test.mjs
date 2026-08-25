// The `assets/seo/*.jsonld` fragments must equal the JSON-LD the site actually
// ships, node for node.
//
// Why this exists. `assets/seo/README.md` calls those two files "the canonical
// JSON-LD fragments referenced from the site's HTML pages", but nothing checked
// the claim, and nothing loads them at runtime - pages inline their own
// `<script type="application/ld+json">` blocks. So they quietly stopped being
// canonical: both files sat untouched from 2026-05-04 while `home.html` moved on
// to 2026-08-22, and by the 2026-08-24 stale-file audit they had drifted in BOTH
// directions. `website.jsonld` carried an old description and had no
// `potentialAction` at all, while the live page ships a full SearchAction;
// `organization.jsonld` carried `founder` and `logo.contentUrl` that appear on no
// page. A reference file that disagrees with production is worse than no
// reference file, because someone will copy it into a new page.
//
// The fix is structural rather than a list of hand-written assertions: home.html
// is the single source of truth, and each fragment must deep-equal the node with
// the matching `@id` that home.html actually emits. `@context` is the one
// allowed difference - a standalone fragment needs it, an embedded node inherits
// it from its graph.
//
// To update a fragment, change the page and re-copy the node; never edit the
// fragment alone, or this test is the thing that will tell you so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_PAGE = 'home.html';

// Every @id that must round-trip, and the file that must mirror it.
const FRAGMENTS = [
  ['https://shevato.com/#organization', 'assets/seo/organization.jsonld'],
  ['https://shevato.com/#website', 'assets/seo/website.jsonld'],
];

function ldNodes(html) {
  const out = new Map();
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    // A bare `{ "@id": ... }` is a reference to a node, not a definition of one.
    if (typeof node['@id'] === 'string' && Object.keys(node).length > 1 && !out.has(node['@id'])) {
      out.set(node['@id'], node);
    }
    Object.values(node).forEach(visit);
  };
  for (const [, raw] of blocks) visit(JSON.parse(raw));
  return out;
}

const nodes = ldNodes(readFileSync(join(REPO_ROOT, SOURCE_PAGE), 'utf8'));

for (const [id, file] of FRAGMENTS) {
  test(`${file} matches the ${id} node in ${SOURCE_PAGE}`, () => {
    const shipped = nodes.get(id);
    assert.ok(shipped, `${SOURCE_PAGE} no longer emits a JSON-LD node with @id ${id}. Either restore it or drop ${file} and its entry here.`);

    const fragment = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8'));
    assert.equal(
      fragment['@context'],
      'https://schema.org',
      `${file} must declare "@context": "https://schema.org" - it is served standalone, so it cannot inherit one.`,
    );

    const { '@context': _ignored, ...withoutContext } = fragment;
    assert.deepEqual(
      withoutContext,
      shipped,
      `${file} has drifted from the ${id} node in ${SOURCE_PAGE}. The PAGE is the source of truth: copy the node out of it rather than editing the fragment.`,
    );
  });
}

test('the fragments are documented as page-derived, not as free-standing truth', () => {
  const readme = readFileSync(join(REPO_ROOT, 'assets/seo/README.md'), 'utf8');
  assert.match(
    readme,
    /seo-jsonld-parity/,
    'assets/seo/README.md must point at the parity test, so the next reader knows the fragments are pinned to home.html rather than maintained by hand.',
  );
});
