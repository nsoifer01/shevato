// The PUBLISH GRAPH: what shevato.com serves, and what it must not.
//
// The deploy used to publish the whole tracked tree, so live GETs returned
// 200 for /FINDINGS.md, /TESTING-AUDIT.md and
// /netlify/functions/lib/tp-assist-quota.mjs (2026-09-05 audit F15).
// robots.txt said so in its own comments and used Disallow to hide them,
// which is a crawling hint, not an access control.
//
// scripts/build-publish-dir.mjs now assembles an explicit publish directory.
// The danger of a deny-by-default publish is the OTHER direction - a careless
// exclusion silently breaking generated pages, the service workers, the
// Google verification file or an app module - so this file checks both:
//
//   1. every local URL a committed page references is published;
//   2. every module a published module imports is published;
//   3. the named internal artifacts are gone;
//   4. the required public endpoints are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublished, publishedFiles, ROOT_FILES } from '../../scripts/build-publish-dir.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const published = new Set(await publishedFiles());

/** Repo-relative path for a URL referenced from `fromFile`, or null. */
function resolveRef(fromFile, url) {
  if (!url || /^(https?:|data:|blob:|mailto:|tel:|javascript:|#)/i.test(url)) return null;
  const clean = url.split('#')[0].split('?')[0];
  if (!clean) return null;
  const abs = clean.startsWith('/')
    ? clean.slice(1)
    : posix.normalize(posix.join(posix.dirname(fromFile), clean));
  if (abs.startsWith('..')) return null;          // outside the repo: not ours
  if (abs.endsWith('/')) return `${abs}index.html`;
  // Netlify Pretty URLs: /apps is served from apps.html, and /apps/arena/
  // from apps/arena/index.html. Resolve the same way production does, or an
  // extensionless link resolves to a DIRECTORY and looks unpublished.
  if (!/\.[a-z0-9]+$/i.test(abs)) {
    if (existsSync(join(REPO_ROOT, `${abs}.html`))) return `${abs}.html`;
    if (existsSync(join(REPO_ROOT, abs, 'index.html'))) return `${abs}/index.html`;
  }
  return abs;
}

const SKIP_TREE = /(^|\/)(node_modules|\.git|\.claude|\.features|\.screenshots|\.coverage|dist|shows|exercises)(\/|$)/;

function filesUnder(dir, match) {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = readdirSync(join(REPO_ROOT, d)); } catch { return; }
    for (const e of entries) {
      const rel = d ? `${d}/${e}` : e;
      if (SKIP_TREE.test(rel)) continue;
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) walk(rel);
      else if (match.test(e)) out.push(rel);
    }
  })(dir);
  return out;
}

test('every named public file exists and is published', () => {
  for (const f of ROOT_FILES) {
    assert.ok(existsSync(join(REPO_ROOT, f)), `${f} is named in the publish list but is not on disk`);
    assert.ok(published.has(f), `${f} must be published`);
  }
});

test('the verification endpoints are published (losing one de-verifies the property)', () => {
  // Search Console fetches the .html at its exact path; IndexNow fetches the
  // key file at its exact path. Neither failure is visible until weeks later.
  assert.ok(published.has('google10670283c9d04acd.html'));
  assert.ok(published.has('88a4ba641da1631f11e4d731434536ab.txt'));
  assert.ok(published.has('robots.txt'));
  assert.ok(published.has('sitemap.xml'));
  assert.ok(published.has('sitemap-pages.xml'));
});

test('every local URL a committed page references is published', () => {
  const missing = [];
  for (const page of filesUnder('', /\.html$/)) {
    if (!published.has(page)) continue;            // an unpublished page's refs do not matter
    const html = readFileSync(join(REPO_ROOT, page), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const rel = resolveRef(page, m[1]);
      if (!rel) continue;
      // Generated trees are built before the publish step and are gitignored,
      // so they are not on disk in a bare checkout.
      if (/^apps\/(rising-shows\/shows|gym-tracker\/exercises)\//.test(rel)) continue;
      if (!existsSync(join(REPO_ROOT, rel))) continue;   // a dead link is internal-links.test's job
      if (!published.has(rel)) missing.push(`${page} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'published pages referencing unpublished files:\n' + missing.join('\n'));
});

test('every module a published module imports is published', () => {
  const missing = [];
  for (const file of filesUnder('', /\.(js|mjs)$/)) {
    if (!published.has(file)) continue;
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of src.matchAll(/(?:^|[\s({=])(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // bare or URL
      const rel = resolveRef(file, spec);
      if (!rel || !existsSync(join(REPO_ROOT, rel))) continue;
      if (!published.has(rel)) missing.push(`${file} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, [], 'published modules importing unpublished files:\n' + missing.join('\n'));
});

test('every asset a published service worker precaches is published', () => {
  // A precache entry that is not on the deploy 404s on install, which for the
  // gym worker (atomic addAll) means no offline app at all.
  const missing = [];
  for (const sw of ['apps/gym-tracker/sw.js', 'apps/trip-planner/sw.js']) {
    const src = readFileSync(join(REPO_ROOT, sw), 'utf8');
    for (const m of src.matchAll(/'(\.\.?\/[^']+|\.\/)'/g)) {
      const rel = resolveRef(sw, m[1] === './' ? './index.html' : m[1]);
      if (!rel || !existsSync(join(REPO_ROOT, rel))) continue;
      if (!published.has(rel)) missing.push(`${sw} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('the four dual-exposed Rising Shows scripts are published, and nothing else under scripts/', () => {
  const dual = [
    'apps/rising-shows/scripts/match.js',
    'apps/rising-shows/scripts/finder-lib.js',
    'apps/rising-shows/scripts/providers-lib.js',
    'apps/rising-shows/scripts/integrations-lib.js',
  ];
  for (const f of dual) assert.ok(published.has(f), `${f} is loaded with <script src> and must ship`);
  const leaked = [...published].filter((f) => /^apps\/[^/]+\/scripts\//.test(f) && !dual.includes(f));
  assert.deepEqual(leaked, [], 'build tooling must not ship: ' + leaked.join(', '));
});

test('internal artifacts are NOT published', () => {
  // Each of these returned 200 in production before the publish directory,
  // or would have on the next commit that added one like it.
  const mustNotShip = [
    'FINDINGS.md', 'README.md', 'TESTING-AUDIT.md', 'CLAUDE.md',
    'package.json', 'package-lock.json', 'netlify.toml',
    'firestore.rules', 'firebase.json', 'database.rules.json', 'eslint.config.mjs',
    'netlify/functions/fpl.mjs',
    'netlify/functions/lib/tp-assist-quota.mjs',
    'netlify/functions/lib/tp-places-lookup.mjs',
    'tests/browser/run.mjs',
    'tests/coverage/run.mjs',
    'scripts/build-publish-dir.mjs',
    'scripts/stamp-sitemap-index.mjs',
    'apps/arena/tests-rules/rules.test.mjs',
    'apps/arena/e2e/emulator.mjs',
    'apps/trip-planner/tests/trip-logic.test.js',
    'apps/fpl-planner/experiments/registry.md',
    'assets/seo/organization.jsonld',
    'assets/og/build-og-cards.mjs',
    'sync-system/tests/storage-sync-behavior.test.mjs',
  ];
  for (const f of mustNotShip) {
    assert.equal(published.has(f), false, `${f} must not be published`);
  }
});

test('no test, e2e or markdown file is published, anywhere', () => {
  const leaked = [...published].filter((f) =>
    /\.md$/.test(f)
    || /(^|\/)(tests?|e2e|tests-rules|experiments)(\/|$)/.test(f)
    || /\.test\.(js|mjs|cjs)$/.test(f));
  assert.deepEqual(leaked, [], leaked.join(', '));
});

test('no package manifest is published, at any depth', () => {
  // The root ones never could be - the root is an explicit allow list - but an
  // app can carry its own (apps/quotescout does), and that one sits inside a
  // published tree. It shipped until the deny rule reached any depth. A
  // manifest names dependencies, scripts and internal paths, and no page
  // fetches one.
  const leaked = [...published].filter((f) => /(^|\/)package(-lock)?\.json$/.test(f));
  assert.deepEqual(leaked, [], leaked.join(', '));
});

test('isPublished is deny-by-default for anything outside the named roots', () => {
  // The property that makes this an allow list rather than a deny list: a new
  // top-level directory is not published until somebody says so.
  for (const rel of ['netlify/functions/new.mjs', 'secrets/keys.json', 'scripts/new.mjs', 'notes.md']) {
    const inRoots = ['apps/', 'assets/', 'images/', 'partials/', 'sync-system/']
      .some((r) => rel.startsWith(r));
    if (!inRoots) {
      assert.equal([...published].includes(rel), false, `${rel} is not in a published root`);
    }
  }
  assert.equal(isPublished('apps/arena/tests/scoring.test.js'), false);
  assert.equal(isPublished('apps/arena/js/app.js'), true);
});

test('robots.txt still describes the tree that actually ships', () => {
  // The comment that the deploy publishes everything is no longer true, and
  // a robots.txt that describes a deploy shape the site does not have is the
  // kind of drift the audit's F23 is about.
  const robots = readFileSync(join(REPO_ROOT, 'robots.txt'), 'utf8');
  assert.equal(/Netlify publishes the whole tracked tree/.test(robots), false,
    'robots.txt must not claim the deploy publishes the whole tree any more');
});
