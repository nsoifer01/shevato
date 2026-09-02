// Turns bookmarklet/fpl-transfer.js into the `javascript:` URL the planner
// hands out, and writes it to js/ui/bookmarklet-url.js.
//
// The repo has no build step, so the URL is generated here and CHECKED IN, the
// way models/ and data/opening-baseline.json are. tests/bookmarklet.test.mjs
// regenerates it in memory and fails if the committed file disagrees, so the
// two can never drift: editing the bookmarklet without running this script is
// a red test, not a stale bookmarklet in a user's bookmarks bar.
//
//   node apps/fpl-planner/scripts/build-bookmarklet.mjs
//
// That same test then decodes the committed URL and runs THOSE bytes, so what
// is verified is what a user installs, minification included.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PATH = join(APP, 'bookmarklet', 'fpl-transfer.js');
export const OUTPUT_PATH = join(APP, 'js', 'ui', 'bookmarklet-url.js');

// Deliberately conservative: whole-line comments and indentation go, nothing
// else. No token-level minifier, because there is no dependency to do it with
// and a hand-rolled one that mangles a string literal would ship a bookmarklet
// that fails in the user's browser and nowhere else.
//
// A line-oriented strip is only safe while no string spans a line, so that is
// asserted rather than assumed.
export function minify(source) {
  const kept = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !(line.startsWith('/*') && line.endsWith('*/')));

  // The check runs on what survived, not on the raw file, so backticks inside
  // the source's own prose do not trip it. A real template literal still does:
  // its opening backtick sits on a code line, and code lines all survive.
  const offender = kept.findIndex((line) => line.includes('`'));
  if (offender >= 0) {
    throw new Error(`fpl-transfer.js must not use template literals, the line-based comment strip cannot see inside one: ${kept[offender]}`);
  }
  return kept.join('\n');
}

// `void` matters: a javascript: URL whose expression evaluates to anything but
// undefined navigates the tab to that value. The IIFE returns undefined today,
// and this makes that a property of the URL rather than of the last edit to the
// source.
export function toBookmarkletUrl(source) {
  return 'javascript:' + encodeURIComponent('void ' + minify(source) + ';');
}

export function generateModule(url) {
  return `// GENERATED FILE. Do not edit.
//
// Source: apps/fpl-planner/bookmarklet/fpl-transfer.js
// Rebuild: node apps/fpl-planner/scripts/build-bookmarklet.mjs
//
// The bookmarklet as a javascript: URL, so the planner can offer it as a link
// to drag to a bookmarks bar without fetching anything at runtime.
// tests/bookmarklet.test.mjs pins this file to its source and executes the
// bytes below, so it is the shipped artifact that is tested, not the source.

export const BOOKMARKLET_URL = ${JSON.stringify(url)};
`;
}

function main() {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const url = toBookmarkletUrl(source);
  writeFileSync(OUTPUT_PATH, generateModule(url), 'utf8');
  process.stdout.write(`wrote ${OUTPUT_PATH} (${url.length} chars)\n`);
}

if (process.argv[1] && process.argv[1].endsWith('build-bookmarklet.mjs')) main();
