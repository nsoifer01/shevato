#!/usr/bin/env node
// Re-stamp the <lastmod> entries in the root sitemap.xml index from the
// sub-sitemaps actually present on disk. Runs as the last step of
// `npm run build:site`, after the Rising Shows and Gym Tracker page
// builders have regenerated their sub-sitemaps, so the index always
// advertises fresh dates instead of whatever was committed (the shows
// entry sat at 2026-05-19 for two months while the data refreshed
// daily - GSC had no reason to re-fetch it).
//
// Rule: an index entry's lastmod = the max per-URL <lastmod> inside the
// referenced sub-sitemap. Sub-sitemaps missing from disk (e.g. the
// generated ones, before a local build) keep their committed value.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_FILE = path.join(ROOT, 'sitemap.xml');
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
// lastmodByLoc gets that lastmod value. Blocks with unknown locs are
// left untouched.
export function stampSitemapIndex(indexXml, lastmodByLoc) {
  return indexXml.replace(/<sitemap>[\s\S]*?<\/sitemap>/g, (block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/);
    const lastmod = loc && lastmodByLoc[loc[1].trim()];
    if (!lastmod) return block;
    return block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${lastmod}</lastmod>`);
  });
}

function main() {
  const indexXml = fs.readFileSync(INDEX_FILE, 'utf8');
  const lastmodByLoc = {};
  for (const [, loc] of indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const file = path.join(ROOT, loc.trim().slice(ORIGIN.length));
    if (!fs.existsSync(file)) {
      console.log(`[stamp-sitemap-index] ${loc} not on disk, keeping committed lastmod`);
      continue;
    }
    const stamp = maxLastmod(fs.readFileSync(file, 'utf8'));
    if (stamp) lastmodByLoc[loc.trim()] = stamp;
  }
  const stamped = stampSitemapIndex(indexXml, lastmodByLoc);
  if (stamped === indexXml) {
    console.log('[stamp-sitemap-index] sitemap.xml already up to date');
    return;
  }
  fs.writeFileSync(INDEX_FILE, stamped);
  for (const [loc, day] of Object.entries(lastmodByLoc)) {
    console.log(`[stamp-sitemap-index] ${loc} -> ${day}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
