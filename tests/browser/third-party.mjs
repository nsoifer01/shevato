// Third-party requests in the browser suites: answered locally, never live.
//
// WHY (measured 2026-09-14). One run of the estate made 5,495 requests to
// third-party hosts and 3,072 of them reached the real internet: the Firebase
// SDK from www.gstatic.com (903), Google Fonts (935), Font Awesome from cdnjs
// (194), TMDB posters (406), the MapTap daily puzzle (168, a different file
// every day), map tiles and trip-planner APIs. So the result of a run depended
// on those services being up and fast at that minute, and on the date. It did
// fail that way: on 2026-09-13 a stalled www.gstatic.com request kept Gym
// Tracker from booting on CI, reported as six unrelated failures.
//
// Every page opened through cdp.mjs's newPage() now answers third-party
// requests from here:
//   - the static CDN assets the site references (the SDK, fonts, icon font)
//     come from a committed mirror, byte for byte what the CDN served, so
//     code, layout and font metrics are the same on every run and every host;
//   - the MapTap daily puzzle, which varies by date, gets a fixed stand-in;
//   - everything else third-party (analytics, posters, tiles, live APIs) is
//     refused at once, the way a blocked network refuses it. A suite that needs
//     one to answer says so with its own interceptNetwork() rule, which is
//     consulted first.
//
// The mirror is complete by test: tests/static/browser-third-party.test.mjs
// fails when the site references a CDN asset that is not in it, and names
// the command that refreshes it (node tests/browser/refresh-third-party.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const MIRROR_DIR = path.join(HERE, 'vendor', 'third-party');
export const MANIFEST_PATH = path.join(MIRROR_DIR, 'manifest.json');

// The CDNs whose referenced assets are mirrored. fonts.gstatic.com is reached
// only through the Google Fonts stylesheets, so it is followed, not scanned.
export const SCANNED_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'cdnjs.cloudflare.com'];

const FIRST_PARTY = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

/** Requests this module never answers: first-party, and anything not http(s). */
export const isFirstParty = (url) => FIRST_PARTY.test(url) || !/^https?:\/\//.test(url);

/**
 * Every mirrored-CDN asset URL a served source file references, sorted.
 * Served means tracked html/js/mjs/css outside test, build and vendor trees.
 */
export function siteAssetUrls(repo = REPO) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '*.html', '*.js', '*.mjs', '*.css'],
    { cwd: repo, encoding: 'utf8' });
  const files = listed.split('\0').filter(Boolean)
    .filter((f) => !/(^|\/)(tests?|e2e|tests-rules|scripts|experiments|vendor|node_modules)(\/|$)/.test(f));
  const hosts = SCANNED_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|');
  const re = new RegExp(`https://(?:${hosts})/[^\\s"'\`<>\\\\)]+`, 'g');
  const out = new Set();
  for (const f of files) {
    for (const m of readFileSync(path.join(repo, f), 'utf8').matchAll(re)) {
      const url = m[0].replace(/&amp;/g, '&');
      // Template literals and prose ellipses are not requests.
      if (url.includes('${') || url.includes('…')) continue;
      out.add(url);
    }
  }
  return [...out].sort();
}

let manifest = null;
const bodies = new Map();

export function readManifest() {
  if (!manifest) {
    manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).assets || {} : {};
  }
  return manifest;
}

// A fixed daily puzzle in the shape maptap.gg serves (five cities), so the
// MapTap Rivals predictions card renders the same rows on every date.
export const MAPTAP_DAILY = 'const cities = [' + [
  [-12.0464, -77.0428, 'Lima'], [30.0444, 31.2357, 'Cairo'], [28.6139, 77.209, 'Delhi'],
  [21.3099, -157.8581, 'Honolulu'], [64.1466, -21.9426, 'Reykjavik'],
].map(([lat, lng, name]) => `{ name: "${name}", lat: ${lat}, lng: ${lng}, labelLat: ${lat + 1}, labelLng: ${lng + 1} }`).join(',') + '];';
const MAPTAP_DAILY_URL = /^https:\/\/maptap\.gg\/data\/this_day_in_history\/[A-Za-z]+\d{1,2}\.js$/;

/**
 * The answer for one request:
 *   null          first-party, let it through
 *   { status, contentType, body, headers }   serve this
 *   'fail'        refuse it
 */
export function thirdPartyResponse(url) {
  if (isFirstParty(url)) return null;
  const entry = readManifest()[url];
  if (entry) {
    let body = bodies.get(url);
    if (!body) {
      body = readFileSync(path.join(MIRROR_DIR, entry.file));
      bodies.set(url, body);
    }
    return { status: 200, contentType: entry.contentType, body, headers: { 'Cache-Control': 'public, max-age=31536000' } };
  }
  if (MAPTAP_DAILY_URL.test(url)) {
    return { status: 200, contentType: 'application/javascript', body: MAPTAP_DAILY };
  }
  return 'fail';
}
