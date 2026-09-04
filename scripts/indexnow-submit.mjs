#!/usr/bin/env node
// Tell IndexNow (Bing, Yandex, Seznam, Naver) that specific URLs changed.
//
// Run it by hand after a change worth announcing - a new app, a batch of
// retitled hub pages, a redirect. It is deliberately NOT wired into
// `npm run build:site`: that runs on every deploy including the daily Rising
// Shows data refresh, and re-submitting the same couple of thousand URLs
// every day is exactly the behaviour IndexNow asks callers not to have.
// Google does not participate in IndexNow at all; this is Bing and friends.
//
//   node scripts/indexnow-submit.mjs https://shevato.com/apps/rising-shows/ ...
//   node scripts/indexnow-submit.mjs --from-sitemap apps/rising-shows/sitemap-shows.xml
//   node scripts/indexnow-submit.mjs --dry-run <urls...>
//
// The key is the basename of the *.txt key file at the repo root, and that
// file's only content is the key itself. It is public by design: hosting it
// is what proves control of the domain.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'shevato.com';
const ENDPOINT = 'https://api.indexnow.org/IndexNow';
const MAX_URLS = 10000; // protocol cap per request

/** The IndexNow key, read from the single <key>.txt file at the repo root. */
export function readKey(root = ROOT) {
  const candidates = fs.readdirSync(root)
    .filter((f) => /^[0-9a-f]{8,128}\.txt$/i.test(f));
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one IndexNow key file at the repo root, found ${candidates.length}`);
  }
  const key = candidates[0].replace(/\.txt$/i, '');
  const body = fs.readFileSync(path.join(root, candidates[0]), 'utf8').trim();
  if (body !== key) {
    throw new Error(`${candidates[0]} must contain exactly its own key; found ${JSON.stringify(body)}`);
  }
  return key;
}

/** Every <loc> in a sitemap, as absolute URLs. */
export function urlsFromSitemap(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/** Reject anything that is not an https URL on this host. */
export function validate(urls) {
  const bad = urls.filter((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol !== 'https:' || parsed.hostname !== HOST;
    } catch { return true; }
  });
  if (bad.length) throw new Error(`not https://${HOST} URLs: ${bad.slice(0, 3).join(', ')}`);
  return urls;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => a !== '--dry-run');

  let urls;
  const fromIdx = args.indexOf('--from-sitemap');
  if (fromIdx !== -1) {
    const file = args[fromIdx + 1];
    if (!file) throw new Error('--from-sitemap needs a path');
    urls = urlsFromSitemap(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } else {
    urls = args;
  }

  if (!urls.length) {
    console.error('usage: indexnow-submit.mjs [--dry-run] <url>... | --from-sitemap <path>');
    process.exitCode = 1;
    return;
  }
  validate(urls);
  if (urls.length > MAX_URLS) throw new Error(`${urls.length} URLs exceeds the ${MAX_URLS} per-request cap`);

  const key = readKey();
  const payload = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: urls };

  if (dryRun) {
    console.log(`[indexnow] would submit ${urls.length} URL(s) with key ${key}`);
    for (const u of urls.slice(0, 10)) console.log('  ' + u);
    if (urls.length > 10) console.log(`  ... and ${urls.length - 10} more`);
    return;
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  // 200 accepted, 202 accepted but key still being validated. Anything else
  // is worth seeing rather than swallowing.
  console.log(`[indexnow] ${res.status} ${res.statusText} for ${urls.length} URL(s)`);
  if (!res.ok && res.status !== 202) {
    console.error(await res.text());
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('[indexnow] ' + err.message);
    process.exitCode = 1;
  });
}
