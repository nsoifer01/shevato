#!/usr/bin/env node
// Re-stamp the <lastmod> entries in the root sitemap.xml index from the
// sub-sitemaps actually present on disk. Runs as the last step of
// `npm run build:site`, after the Rising Shows and Gym Tracker page
// builders have regenerated their sub-sitemaps, so the index always
// advertises fresh dates instead of whatever was committed (the shows
// entry sat at 2026-05-19 for two months while the data refreshed
// daily - GSC had no reason to re-fetch it).
//
// Rules:
//   - sitemap-pages.xml: each page's <lastmod> becomes the date of the last
//     commit that touched its HTML file (never older than the committed
//     value). The file was hand-maintained and stale on every entry. Skipped
//     in a shallow clone, where `git log` would report HEAD's date for every
//     file.
//   - sitemap.xml index: an entry's lastmod = the max per-URL <lastmod>
//     inside the referenced sub-sitemap. A sub-sitemap that carries no
//     lastmod at all (the generated show and exercise sitemaps, whose only
//     available date was the daily build time) gets its index <lastmod>
//     REMOVED rather than stamped with a build date. Sub-sitemaps missing
//     from disk (before a local build) keep their committed value.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_FILE = path.join(ROOT, 'sitemap.xml');
const PAGES_FILE = path.join(ROOT, 'sitemap-pages.xml');
const ORIGIN = 'https://shevato.com/';

// Max YYYY-MM-DD across every <lastmod> in a sitemap document, or null
// when it carries none. Full ISO timestamps are truncated to the date.
export function maxLastmod(xml) {
  let max = null;
  for (const [, value] of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
    const day = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && (max === null || day > max)) max = day;
  }
  return max;
}

// Rewrite the index XML so each <sitemap> block whose <loc> appears in
// lastmodByLoc gets that lastmod value. A value of null removes the block's
// <lastmod> element (the sub-sitemap carries no dates to summarise). Blocks
// whose loc is absent from the map are left untouched.
export function stampSitemapIndex(indexXml, lastmodByLoc) {
  return indexXml.replace(/<sitemap>[\s\S]*?<\/sitemap>/g, (block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/);
    if (!loc || !Object.prototype.hasOwnProperty.call(lastmodByLoc, loc[1].trim())) return block;
    const lastmod = lastmodByLoc[loc[1].trim()];
    if (lastmod === null) return block.replace(/\n\s*<lastmod>[^<]*<\/lastmod>/, '');
    if (!lastmod) return block;
    if (!/<lastmod>/.test(block)) {
      return block.replace(/(<loc>[^<]+<\/loc>)/, `$1\n    <lastmod>${lastmod}</lastmod>`);
    }
    return block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${lastmod}</lastmod>`);
  });
}

// Map a sitemap-pages.xml <loc> to the repo file that renders it, following
// the Pretty URLs convention (/home -> home.html, /apps/x/ -> apps/x/index.html).
export function pageFileForLoc(loc) {
  const rel = loc.trim().slice(ORIGIN.length);
  if (rel.endsWith('/')) return `${rel}index.html`;
  return /\.[a-z0-9]+$/i.test(rel) ? rel : `${rel}.html`;
}

// Rewrite each <url> block of the pages sitemap whose <loc> has an entry in
// lastmodByLoc, never moving a date backwards.
export function stampPagesSitemap(pagesXml, lastmodByLoc) {
  return pagesXml.replace(/<url>[\s\S]*?<\/url>/g, (block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/);
    const next = loc && lastmodByLoc[loc[1].trim()];
    if (!next) return block;
    const cur = block.match(/<lastmod>([^<]+)<\/lastmod>/);
    if (cur && cur[1].trim() >= next) return block;
    if (!cur) return block.replace(/(<loc>[^<]+<\/loc>)/, `$1\n    <lastmod>${next}</lastmod>`);
    return block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${next}</lastmod>`);
  });
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Refresh sitemap-pages.xml from git history. Returns the number of entries
// changed; 0 (with a log line) when git history is unavailable or shallow.
function stampPages() {
  if (!fs.existsSync(PAGES_FILE)) return 0;
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
    console.log('[stamp-sitemap-index] git history unavailable or shallow, keeping committed page lastmods');
    return 0;
  }
  const pagesXml = fs.readFileSync(PAGES_FILE, 'utf8');
  const lastmodByLoc = {};
  for (const [, loc] of pagesXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const file = pageFileForLoc(loc);
    if (git(['ls-files', '--error-unmatch', file]) === null) continue; // generated, not tracked
    const day = git(['log', '-1', '--format=%cs', '--', file]);
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) lastmodByLoc[loc.trim()] = day;
  }
  const stamped = stampPagesSitemap(pagesXml, lastmodByLoc);
  if (stamped === pagesXml) return 0;
  fs.writeFileSync(PAGES_FILE, stamped);
  const changed = (stamped.match(/<lastmod>/g) || []).length;
  console.log(`[stamp-sitemap-index] sitemap-pages.xml refreshed from git history (${changed} entries)`);
  return changed;
}

function main() {
  stampPages();
  const indexXml = fs.readFileSync(INDEX_FILE, 'utf8');
  const lastmodByLoc = {};
  for (const [, loc] of indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const file = path.join(ROOT, loc.trim().slice(ORIGIN.length));
    if (!fs.existsSync(file)) {
      console.log(`[stamp-sitemap-index] ${loc} not on disk, keeping committed lastmod`);
      continue;
    }
    // null = the sub-sitemap carries no dates: drop the index lastmod.
    lastmodByLoc[loc.trim()] = maxLastmod(fs.readFileSync(file, 'utf8'));
  }
  const stamped = stampSitemapIndex(indexXml, lastmodByLoc);
  if (stamped === indexXml) {
    console.log('[stamp-sitemap-index] sitemap.xml already up to date');
    return;
  }
  fs.writeFileSync(INDEX_FILE, stamped);
  for (const [loc, day] of Object.entries(lastmodByLoc)) {
    console.log(`[stamp-sitemap-index] ${loc} -> ${day === null ? '(no lastmod)' : day}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
