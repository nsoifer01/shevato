#!/usr/bin/env node
'use strict';

// Download data.json and data/show-modal-extras.json from the rolling
// "rising-shows-data" GitHub release into the app directory.
//
// The two files are deliberately NOT tracked in git: each refresh used to
// add a ~100 MB blob pair to history, which bloated the repo past 1.5 GB
// and made pushes painfully slow. The daily refresh workflow uploads them
// to the release instead (see .github/workflows/refresh-rising-shows.yml),
// and this script pulls them back down wherever a working copy needs them:
//
//   - Netlify build: `npm run build:site` runs this first, so the page
//     generator has data.json and the deployed site serves both files at
//     the same URLs as before.
//   - Local dev: `npm run fetch:rising-shows-data` after a fresh clone.
//
// Files that already exist on disk are left alone (local checkouts often
// have a fresher copy from a local build). Pass --force to re-download.
//
// Pure node, no deps: global fetch (Node 18+) plus zlib for the gzip.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RELEASE_BASE =
  'https://github.com/nsoifer01/shevato/releases/download/rising-shows-data';

const APP_DIR = path.join(__dirname, '..');
const TARGETS = [
  { asset: 'data.json.gz', dest: path.join(APP_DIR, 'data.json') },
  {
    asset: 'show-modal-extras.json.gz',
    dest: path.join(APP_DIR, 'data', 'show-modal-extras.json'),
  },
];

async function download(asset, dest) {
  const url = `${RELEASE_BASE}/${asset}`;
  console.log(`[fetch-data] downloading ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`GET ${url} failed: ${resp.status} ${resp.statusText}`);
  }
  const gz = Buffer.from(await resp.arrayBuffer());
  const raw = zlib.gunzipSync(gz);
  // Parse before writing so a truncated or corrupt download can never
  // replace a good file with garbage.
  JSON.parse(raw.toString('utf8'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, raw);
  const mb = (raw.length / 1024 / 1024).toFixed(1);
  console.log(`[fetch-data] wrote ${path.relative(APP_DIR, dest)} (${mb} MB)`);
}

async function main() {
  const force = process.argv.includes('--force');
  for (const { asset, dest } of TARGETS) {
    if (!force && fs.existsSync(dest)) {
      console.log(
        `[fetch-data] ${path.relative(APP_DIR, dest)} already exists, skipping (use --force to re-download)`
      );
      continue;
    }
    await download(asset, dest);
  }
}

main().catch((err) => {
  console.error(`[fetch-data] FAILED: ${err.message}`);
  process.exit(1);
});
