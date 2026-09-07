#!/usr/bin/env node
// Build the PUBLISH DIRECTORY: the explicit set of files shevato.com serves.
//
// WHY (2026-09-05 audit F15): Netlify published the whole tracked tree, so
// live GETs returned 200 for /FINDINGS.md, /TESTING-AUDIT.md and
// /netlify/functions/lib/tp-assist-quota.mjs. robots.txt said as much in its
// own comments ("Repo-internal material the deploy still serves") and used
// Disallow to hide it - but Disallow is a crawling hint, not an access
// control, and it left every future internal file one commit away from being
// a public artifact by default.
//
// This inverts that. Nothing is published unless a rule below says so, and
// adding a new asset directory means adding it here in the same change -
// which is the point. The alternative, a deny list, has to anticipate every
// kind of file that should not ship; an allow list only has to describe the
// site, and the site is a thing we know.
//
// HOW: hard links, not copies. The generated Rising Shows and Gym Tracker
// trees are ~35,000 files and ~120 MB together, and linking them costs a
// directory entry each. Falls back to copying where linking is refused.
//
// NOT PUBLISHED, and each for a reason:
//   netlify/         function SOURCE. Netlify bundles functions from the repo
//                    root, not from the publish directory, so they still
//                    deploy - they just stop being downloadable.
//   tests/, scripts/, apps/*/tests/, apps/*/e2e/, apps/*/tests-rules/
//                    the test estate.
//   *.md             README, FINDINGS, TESTING-AUDIT, CLAUDE.
//   package*.json, netlify.toml, firebase*, *.rules, eslint.config.mjs
//                    build and infrastructure configuration.
//   assets/seo/, assets/og/
//                    sources for content that is INLINED into pages at build
//                    time, plus the OG card generator. Nothing fetches them.
//
// The four dual-exposed Rising Shows scripts ARE published: they are node
// build scripts that the Show Finder and the Kometa exporter also load with
// <script src>, and robots.txt carries four matching Allow lines for the same
// reason.

import { mkdir, rm, readdir, link, copyFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLISH_DIR = 'dist';

// Individual root files that are part of the site.
export const ROOT_FILES = [
  '404.html', 'about.html', 'apps.html', 'contact.html', 'home.html',
  'index.html', 'moadon-alef.html', 'privacy.html', 'work.html',
  'favicon.ico', 'robots.txt', 'site.webmanifest',
  'sitemap.xml', 'sitemap-pages.xml',
  // Loaded by every app page for auth + sync.
  'firebase-config.js',
  // Search Console fetches this exact path to verify domain ownership;
  // netlify.toml's redirect inventory names it for the same reason.
  'google10670283c9d04acd.html',
  // IndexNow key file. The API fetches it at this exact path to verify that
  // submissions come from the site's owner.
  '88a4ba641da1631f11e4d731434536ab.txt',
];

// Directory trees that are part of the site, minus DENY below.
export const ROOT_DIRS = ['apps', 'assets', 'images', 'partials', 'sync-system'];

// Paths (repo-relative, forward slashes) that never ship.
export const DENY = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.features(\/|$)/,
  /(^|\/)\.reports(\/|$)/,
  /(^|\/)\.screenshots(\/|$)/,
  /(^|\/)\.coverage(\/|$)/,
  /(^|\/)tests?(\/|$)/,
  /(^|\/)tests-rules(\/|$)/,
  /(^|\/)e2e(\/|$)/,
  /(^|\/)experiments(\/|$)/,
  /^assets\/seo(\/|$)/,
  /^assets\/og(\/|$)/,
  /\.md$/,
  /\.log$/,
  /\.bak$/,
  /\.map$/,
];

// Exceptions to DENY, matched first. LITERAL PATHS rather than patterns, so
// the walk can tell that a denied directory still has to be descended into -
// the first draft skipped apps/rising-shows/scripts/ wholesale and the four
// files below never shipped, which would have rendered the Show Finder
// without its shape matcher.
//
// These four are node build scripts that the Show Finder and the Kometa
// exporter ALSO load with <script src>; robots.txt carries four matching
// Allow lines for the same reason.
export const ALLOW_ANYWAY = [
  'apps/rising-shows/scripts/match.js',
  'apps/rising-shows/scripts/finder-lib.js',
  'apps/rising-shows/scripts/providers-lib.js',
  'apps/rising-shows/scripts/integrations-lib.js',
];

// `apps/*/scripts/` is node build tooling except for the four above; the same
// applies to the repo-level ones. Handled as a DENY with the ALLOW_ANYWAY
// escape rather than a special case, so the rule reads in one place.
DENY.push(/^apps\/[^/]+\/scripts(\/|$)/);

export function isPublished(rel) {
  if (ALLOW_ANYWAY.includes(rel)) return true;
  return !DENY.some((re) => re.test(rel));
}

/**
 * Whether the walk must descend into a directory. A denied directory still
 * has to be entered when an explicitly allowed file lives under it.
 */
export function shouldDescend(rel) {
  if (isPublished(rel)) return true;
  return ALLOW_ANYWAY.some((p) => p.startsWith(`${rel}/`));
}

async function walk(dir, out) {
  let entries;
  try { entries = await readdir(join(ROOT, dir), { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (shouldDescend(rel)) await walk(rel, out);
      continue;
    }
    if (!isPublished(rel)) continue;
    if (entry.isFile() || entry.isSymbolicLink()) out.push(rel);
  }
  return out;
}

/** Every repo-relative path that ships. Exported so a test can assert it. */
export async function publishedFiles() {
  const files = [];
  for (const f of ROOT_FILES) {
    try { await stat(join(ROOT, f)); files.push(f); } catch { /* absent is reported below */ }
  }
  for (const d of ROOT_DIRS) await walk(d, files);
  return files;
}

async function place(rel, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try { await link(join(ROOT, rel), dest); }
  catch { await copyFile(join(ROOT, rel), dest); }
}

async function main() {
  const missing = [];
  for (const f of ROOT_FILES) {
    try { await stat(join(ROOT, f)); } catch { missing.push(f); }
  }
  if (missing.length) {
    // A named public file that is not there is a broken deploy, not a warning:
    // the Search Console verification page and the IndexNow key are both in
    // this list, and losing either silently is exactly the kind of failure
    // that shows up weeks later as a de-verified property.
    throw new Error(`publish list names files that do not exist: ${missing.join(', ')}`);
  }

  const out = join(ROOT, PUBLISH_DIR);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const files = await publishedFiles();
  for (const rel of files) await place(rel, join(out, rel));

  await writeFile(join(out, '.publish-manifest.json'), JSON.stringify({
    builtAt: new Date().toISOString(),
    fileCount: files.length,
  }, null, 2) + '\n');

  console.log(`[publish] ${files.length} files -> ${PUBLISH_DIR}/`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`[publish] FAILED: ${err.message}`);
    process.exit(1);
  });
}

export { ROOT };
