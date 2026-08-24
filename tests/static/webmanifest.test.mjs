// Web app manifests parse and carry the fields installability depends on.
//
// Discovers every first-party manifest: *.webmanifest / manifest.json at the
// repo root and at the top level of each apps/<slug>/ directory (canonical
// app list from assets/apps-manifest.json, so gitignored junk directories
// are never scanned). For each: valid JSON, required fields (name, icons,
// start_url, display), and every icon src resolves to a real file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function manifestsIn(dirRel) {
  const dir = join(REPO_ROOT, dirRel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.webmanifest') || f === 'manifest.json')
    .map((f) => join(dirRel, f))
    .filter((p) => statSync(join(REPO_ROOT, p)).isFile());
}

const appList = JSON.parse(readFileSync(join(REPO_ROOT, 'assets', 'apps-manifest.json'), 'utf8'));
const MANIFESTS = [
  ...manifestsIn('.'),
  ...appList.apps.flatMap((a) => manifestsIn(join('apps', a.slug)))
];

test('manifest discovery finds the known set', () => {
  // site.webmanifest plus the two PWA apps. If an app gains a manifest this
  // count grows and the new file is automatically under test; if discovery
  // silently breaks, this is the tripwire.
  assert.ok(MANIFESTS.length >= 3, `expected at least 3 manifests, found: ${MANIFESTS.join(', ') || 'none'}`);
  assert.ok(MANIFESTS.some((m) => m.endsWith('site.webmanifest')), 'site.webmanifest must exist');
});

for (const manifestPath of MANIFESTS) {
  test(`${manifestPath} is a valid installable manifest`, () => {
    const raw = readFileSync(join(REPO_ROOT, manifestPath), 'utf8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, `${manifestPath} must parse as JSON`);

    assert.equal(typeof parsed.name, 'string', 'name is required');
    assert.ok(parsed.name.trim().length > 0, 'name must not be empty');
    assert.equal(typeof parsed.start_url, 'string', 'start_url is required');
    assert.equal(typeof parsed.display, 'string', 'display is required');
    assert.ok(Array.isArray(parsed.icons) && parsed.icons.length > 0, 'icons array is required');

    const manifestDir = dirname(join(REPO_ROOT, manifestPath));
    const missing = [];
    for (const icon of parsed.icons) {
      assert.equal(typeof icon.src, 'string', 'every icon needs a src');
      const iconPath = icon.src.startsWith('/')
        ? join(REPO_ROOT, icon.src.slice(1))
        : resolve(manifestDir, icon.src);
      if (!existsSync(iconPath)) missing.push(icon.src);
    }
    assert.deepEqual(missing, [], `icon files missing on disk for ${manifestPath}`);
  });
}

// The site manifest must launch on the canonical URL and match the dark
// chrome. Shipped otherwise: start_url was `/home.html` (production 301s it,
// so every installed-app launch took a redirect hop; Netlify's Pretty URLs
// rewrite hrefs inside HTML but never JSON) and background_color was white
// behind a #181818 header.
test('site.webmanifest launches on the canonical /home and paints a dark splash', () => {
  const site = JSON.parse(readFileSync(join(REPO_ROOT, 'site.webmanifest'), 'utf8'));
  assert.equal(site.start_url, '/home', 'start_url must be the extensionless canonical URL');
  const m = /^#([0-9a-f]{6})$/i.exec(site.background_color || '');
  assert.ok(m, `background_color must be a 6-digit hex colour, got ${site.background_color}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  assert.ok(luminance < 0.35, `background_color ${site.background_color} is light (L=${luminance.toFixed(2)}); the site is dark-chrome only`);
});
