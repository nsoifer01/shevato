// The browser suites' third-party answers (tests/browser/third-party.mjs),
// and the committed mirror behind them.
//
// The suites used to reach the live internet 3,072 times a run (Firebase SDK,
// Google Fonts, Font Awesome, TMDB, maptap.gg, tiles, trip APIs), so a result
// depended on those services and on the date. Now every third-party request
// is answered from a committed mirror or refused. That holds only while the
// mirror covers what the site references, which is what this file checks: a
// new font weight or an SDK bump fails HERE, in milliseconds, naming the
// refresh command, instead of turning into a mysteriously refused request in
// a browser run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  siteAssetUrls, readManifest, thirdPartyResponse, isFirstParty, MIRROR_DIR, REPO,
} from '../browser/third-party.mjs';

const REFRESH = 'node tests/browser/refresh-third-party.mjs';
const manifest = readManifest();

test('every CDN asset the site references is in the mirror', () => {
  const urls = siteAssetUrls();
  // Sanity: the scan found the SDK and the fonts. If it finds nothing, the
  // scan broke, and "nothing is missing" would be meaningless.
  assert.ok(urls.some((u) => /firebasejs\/[\d.]+\/firebase-app\.js$/.test(u)), `scan looks broken: ${urls.join(', ')}`);
  const missing = urls.filter((u) => !manifest[u]);
  assert.deepEqual(missing, [], `the site references CDN assets the browser suites cannot serve; run \`${REFRESH}\``);
});

test('every mirrored file exists and still has its recorded digest', () => {
  const bad = [];
  for (const [url, entry] of Object.entries(manifest)) {
    const file = path.join(MIRROR_DIR, entry.file);
    if (!existsSync(file)) { bad.push(`${url}: ${entry.file} is missing`); continue; }
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (digest !== entry.sha256) bad.push(`${url}: ${entry.file} was edited (digest ${digest})`);
    if (!entry.contentType) bad.push(`${url}: no content type`);
  }
  assert.deepEqual(bad, [], `the mirror must be exactly what ${REFRESH} wrote`);
});

test('what a mirrored stylesheet or script loads in turn is mirrored too', () => {
  const missing = [];
  for (const [url, entry] of Object.entries(manifest)) {
    const text = /css|javascript/.test(entry.contentType) ? readFileSync(path.join(MIRROR_DIR, entry.file), 'utf8') : '';
    if (/css/.test(entry.contentType)) {
      for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const ref = new URL(m[1], url).href;
        if (/\.woff2(\?|$)/.test(ref) && !manifest[ref]) missing.push(`${ref} (from ${url})`);
      }
    }
    if (/javascript/.test(entry.contentType)) {
      for (const m of text.matchAll(/["'](https:\/\/www\.gstatic\.com\/[^"']+\.js)["']/g)) {
        if (!manifest[m[1]]) missing.push(`${m[1]} (imported by ${url})`);
      }
    }
  }
  assert.deepEqual(missing, [], `run \`${REFRESH}\``);
});

test('first-party requests are never answered by the mirror', () => {
  for (const url of ['http://127.0.0.1:8099/home.html', 'http://localhost:8137/apps/arena/', 'http://[::1]:9000/x',
    'data:text/plain,hi', 'blob:http://127.0.0.1:8099/1234']) {
    assert.equal(isFirstParty(url), true, url);
    assert.equal(thirdPartyResponse(url), null, url);
  }
});

test('a mirrored asset is served with its recorded bytes and type', () => {
  const [url, entry] = Object.entries(manifest).find(([u]) => /firebase-app\.js$/.test(u));
  const r = thirdPartyResponse(url);
  assert.equal(r.status, 200);
  assert.equal(r.contentType, entry.contentType);
  assert.ok(Buffer.from(r.body).equals(readFileSync(path.join(MIRROR_DIR, entry.file))));
});

test('the MapTap daily puzzle is the same on every date', () => {
  const a = thirdPartyResponse('https://maptap.gg/data/this_day_in_history/September14.js');
  const b = thirdPartyResponse('https://maptap.gg/data/this_day_in_history/February29.js');
  assert.equal(a.status, 200);
  assert.equal(String(a.body), String(b.body));
  assert.match(String(a.body), /^const cities = \[/);
});

test('every other third-party request is refused, never passed to the internet', () => {
  for (const url of [
    'https://image.tmdb.org/t/p/w342/abc.jpg',
    'https://www.googletagmanager.com/gtag/js?id=G-TEST',
    'https://photon.komoot.io/api/?q=paris',
    'https://tile.openstreetmap.org/7/64/42.png',
    'https://maptap.gg/api/profile',
    // Same CDN, but not a referenced asset: refused, not fetched.
    'https://www.gstatic.com/firebasejs/0.0.1/firebase-app.js',
  ]) {
    assert.equal(thirdPartyResponse(url), 'fail', url);
  }
});

test('the browser driver answers every page\'s third-party requests from here', () => {
  // A static pin on the wiring: without it the module above could be perfect
  // and never consulted.
  const cdp = readFileSync(path.join(REPO, 'tests/browser/cdp.mjs'), 'utf8');
  assert.match(cdp, /import \{ thirdPartyResponse \} from '\.\/third-party\.mjs'/);
  assert.match(cdp, /export async function newPage[\s\S]*?await installThirdPartyAnswers\(s\);\s*return s;/);
  assert.match(cdp, /urlPattern: 'https:\/\/\*'/);
});
