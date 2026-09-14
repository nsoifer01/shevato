#!/usr/bin/env node
// Refreshes the committed third-party mirror the browser suites serve from
// (tests/browser/vendor/third-party/, see tests/browser/third-party.mjs).
//
//   node tests/browser/refresh-third-party.mjs
//
// Run it when tests/static/browser-third-party.test.mjs says the site
// references a CDN asset the mirror does not have (a new font weight, an SDK
// version bump). It re-derives the URL list from the site's own sources,
// downloads each with a headless-Chrome user agent (Google Fonts serves a
// different stylesheet per browser), follows every woff2 a stylesheet names
// and every gstatic module a script imports, and rewrites the mirror and its
// manifest. It is the ONLY thing in the browser test tree that touches the
// network, and nothing runs it automatically.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { siteAssetUrls, MIRROR_DIR, MANIFEST_PATH } from './third-party.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36';
const EXT = { 'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'font/woff2': '.woff2' };

function fileFor(url, contentType) {
  const u = new URL(url);
  let rel = `${u.host}${u.pathname}`;
  if (u.search) {
    const base = contentType.split(';')[0].trim();
    const ext = path.extname(u.pathname) || EXT[base] || '';
    const hash = createHash('sha1').update(u.search).digest('hex').slice(0, 10);
    rel = `${u.host}${u.pathname.replace(/\.[^./]+$/, '')}@${hash}${ext}`;
  }
  return rel;
}

const assets = new Map();

async function fetchAsset(url) {
  if (assets.has(url)) return;
  let res;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
      if (res.ok) break;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === 3) throw new Error(`could not download ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  let body = Buffer.from(await res.arrayBuffer());
  // woff2 from cdnjs is served as octet-stream; the browser only needs a font type.
  let contentType = res.headers.get('content-type') || 'application/octet-stream';
  if (/\.woff2$/.test(new URL(url).pathname)) contentType = 'font/woff2';
  // Stored with LF line endings. The repository checks text out as LF
  // (.gitattributes `* text=auto eol=lf`), and firebase-app.js ships 2,170
  // CRLF licence-comment lines, so a byte-exact copy would change on commit and
  // never match its recorded digest again. JavaScript and CSS treat CRLF and LF
  // as the same line terminator, so this changes no behaviour.
  if (/css|javascript/.test(contentType)) body = Buffer.from(body.toString('utf8').replace(/\r\n/g, '\n'));
  assets.set(url, { body, contentType });
  const text = /css|javascript/.test(contentType) ? body.toString('utf8') : '';
  if (/css/.test(contentType)) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const ref = new URL(m[1], url).href;
      if (/\.woff2(\?|$)/.test(ref)) await fetchAsset(ref);
    }
  }
  if (/javascript/.test(contentType)) {
    for (const m of text.matchAll(/["'](https:\/\/www\.gstatic\.com\/[^"']+\.js)["']/g)) await fetchAsset(m[1]);
  }
}

const roots = siteAssetUrls();
for (const url of roots) await fetchAsset(url);

for (const dir of ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']) {
  await rm(path.join(MIRROR_DIR, dir), { recursive: true, force: true });
}
const manifest = {};
let bytes = 0;
for (const url of [...assets.keys()].sort()) {
  const { body, contentType } = assets.get(url);
  const rel = fileFor(url, contentType);
  await mkdir(path.dirname(path.join(MIRROR_DIR, rel)), { recursive: true });
  await writeFile(path.join(MIRROR_DIR, rel), body);
  manifest[url] = { file: rel, contentType, sha256: createHash('sha256').update(body).digest('hex') };
  bytes += body.length;
}
await writeFile(MANIFEST_PATH, `${JSON.stringify({
  note: 'Written by node tests/browser/refresh-third-party.mjs. Served by tests/browser/third-party.mjs. Do not edit by hand.',
  roots,
  assets: manifest,
}, null, 2)}\n`);
console.log(`mirrored ${assets.size} files (${(bytes / 1024).toFixed(0)} KB) for ${roots.length} referenced URLs`);
