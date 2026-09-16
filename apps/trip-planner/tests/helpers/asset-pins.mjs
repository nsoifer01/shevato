// Where the three pinned assets are declared, and what they hash to.
//
// Trip Planner versions its shell per FILE (`css/styles.css?v=69`,
// `js/trip-logic.js?v=54`, `js/app.js?v=81`) rather than with one global
// number, and the pin is part of the service worker's cache key. So a pin has
// two jobs and two ways to go wrong:
//
//   index.html vs sw.js  - the two must name the SAME pin, or an offline load
//                          asks for a URL the precache does not hold. Covered
//                          by sw-precache-completeness.test.mjs (the v=67 vs
//                          v=66 drift, which shipped).
//   pin vs CONTENT       - the pin must MOVE when the file it names changes,
//                          or installed workers keep serving the old file from
//                          a cache key that still matches. Covered here.
//
// The second one shipped on 2026-09-15: PR #550 changed app.js and
// trip-logic.js and left every pin alone, and PR #551 half an hour later was a
// pure pin bump. Nothing was red in between, because agreeing with each other
// is exactly what the two files still did.
//
// Same shape as gym-tracker's precache-manifest helper: hashes live in a
// committed fixture, and a script regenerates it in the same change that bumps
// a pin.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST = join(APP, 'tests', 'fixtures', 'asset-pins.json');

/** The files that carry a `?v=` pin, in the order index.html declares them. */
export const PINNED = ['css/styles.css', 'js/trip-logic.js', 'js/app.js'];

const read = (rel) => readFileSync(join(APP, rel), 'utf8');

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/** The pin index.html declares for `rel`, or null when it declares none. */
export function pinInIndex(rel, html = read('index.html')) {
  // Literal scan rather than a built regex: the paths carry `.` and `/`, and
  // escaping them into a template only invites the escaping bug this helper
  // exists to prevent.
  const needle = `${rel}?v=`;
  const at = html.indexOf(needle);
  if (at < 0) return null;
  const digits = /^\d+/.exec(html.slice(at + needle.length));
  return digits ? Number(digits[0]) : null;
}

/** The `TP_BUILD` constant app.js reports in the UI. */
export function tpBuild(js = read('js/app.js')) {
  const m = /const TP_BUILD = (\d+);/.exec(js);
  return m ? Number(m[1]) : null;
}

/** { "<rel>": { pin, sha256 } } for the tree as it stands now. */
export function computePins() {
  const html = read('index.html');
  const out = {};
  for (const rel of PINNED) out[rel] = { pin: pinInIndex(rel, html), sha256: sha256(read(rel)) };
  return out;
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}
