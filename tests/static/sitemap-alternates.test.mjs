// sitemap-pages.xml hreflang alternates point at canonical, extensionless
// URLs that are themselves <loc> entries. Shipped otherwise: moadon-alef's
// four alternates all targeted `/moadon-alef.html`, which production 301s
// and which matched neither its <loc> nor the page's own <link rel=alternate>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const XML = readFileSync(join(REPO_ROOT, 'sitemap-pages.xml'), 'utf8');
const LOCS = new Set([...XML.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
const ALTS = [...XML.matchAll(/<xhtml:link\b([^>]*)\/?>/g)].map((m) => {
  const attr = (n) => (m[1].match(new RegExp(`${n}="([^"]*)"`)) || [])[1];
  return { hreflang: attr('hreflang'), href: attr('href') };
});

test('sitemap-pages.xml declares hreflang alternates (moadon-alef is trilingual)', () => {
  assert.ok(ALTS.length >= 4, `found ${ALTS.length} xhtml:link alternates`);
  assert.ok(ALTS.some((a) => a.hreflang === 'x-default'), 'an x-default alternate is required');
});

test('no sitemap alternate targets a .html URL', () => {
  const bad = ALTS.filter((a) => /\.html$/i.test(a.href || '')).map((a) => `${a.hreflang} -> ${a.href}`);
  assert.deepEqual(bad, [], 'production 301s every .html URL; alternates must be extensionless');
});

test('every sitemap alternate href is itself a <loc> in the same sitemap', () => {
  const bad = ALTS.filter((a) => !LOCS.has(a.href)).map((a) => `${a.hreflang} -> ${a.href}`);
  assert.deepEqual(bad, [], 'alternates must match a declared <loc> exactly');
});

test('no <loc> in sitemap-pages.xml ends in .html', () => {
  assert.deepEqual([...LOCS].filter((l) => /\.html$/i.test(l)), []);
});
