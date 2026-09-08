#!/usr/bin/env node
'use strict';

// Download the Rising Shows dataset pair into the app directory.
//
// The two files are deliberately NOT tracked in git: each refresh used to
// add a ~100 MB blob pair to history, which bloated the repo past 1.5 GB
// and made pushes painfully slow. The daily refresh workflow uploads them
// to a GitHub release instead (see .github/workflows/refresh-rising-shows.yml),
// and this script pulls them back down wherever a working copy needs them:
//
//   - Netlify build: `npm run build:site` runs this first, so the page
//     generator has data.json and the deployed site serves both files at
//     the same URLs as before.
//   - Local dev: `npm run fetch:rising-shows-data` after a fresh clone.
//
// ---------------------------------------------------------------------------
// IMMUTABLE RELEASES (2026-09-05 audit F13)
//
// This script used to download two FIXED urls from a rolling release that the
// refresh workflow overwrites with --clobber, and it checked each file's JSON
// syntax independently. Three things followed from that, and all three were
// real:
//
//   1. A build had no way to ask for a PARTICULAR dataset. Any deploy - a
//      documentation fix, a rollback to last week's commit - picked up
//      whatever data happened to be on the release at that minute, including
//      data uploaded by a refresh whose pull request had not been reviewed.
//      The workflow's own comment, "nothing deploys until this PR merges", was
//      true of the derived files and false of the data.
//   2. The two files could come from DIFFERENT refreshes. They are uploaded
//      one after another, so a build starting between the two uploads gets a
//      new data.json and yesterday's extras.
//   3. `skip if it already exists` applied per file, so one stale local file
//      and one fresh one silently mixed two releases.
//
// So: the workflow now also publishes each asset under an IMMUTABLE,
// release-stamped name, plus a manifest naming that release and the SHA-256 of
// both files. The manifest is committed to the repo (data-release.json) in the
// same pull request as the derived files, which is what makes a source commit
// resolve to an exact approved dataset - and makes a rollback of the code a
// rollback of the data.
//
// Compatibility: a checkout with no data-release.json (or a release that
// predates the immutable names) falls back to the rolling urls, exactly as
// before. The fallback still verifies the digests when a manifest is present,
// so it can be behind but never wrong.
//
// Pure node, no deps: global fetch plus zlib and node:crypto.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const RELEASE_BASE =
  'https://github.com/nsoifer01/shevato/releases/download/rising-shows-data';

const APP_DIR = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(APP_DIR, 'data-release.json');

const TARGETS = [
  { asset: 'data.json.gz', dest: path.join(APP_DIR, 'data.json') },
  {
    asset: 'show-modal-extras.json.gz',
    dest: path.join(APP_DIR, 'data', 'show-modal-extras.json'),
  },
];

// A download that hangs costs the whole build; three tries with a growing
// pause covers a transient CDN blip without turning a real outage into a
// twenty-minute wait.
const REQUEST_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;

/** The committed pin, or null when this checkout has none. */
function readManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') return null;
    if (typeof m.releaseId !== 'string' || !m.releaseId) return null;
    if (!m.assets || typeof m.assets !== 'object') return null;
    return m;
  } catch {
    return null;
  }
}

/** `data.json.gz` + `2026-09-07-abc1234` -> `data-2026-09-07-abc1234.json.gz` */
function immutableName(asset, releaseId) {
  const dot = asset.indexOf('.');
  return `${asset.slice(0, dot)}-${releaseId}${asset.slice(dot)}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (resp.status === 404) return null;   // a real answer, never retried
      if (!resp.ok) throw new Error(`GET ${url} failed: ${resp.status} ${resp.statusText}`);
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = RETRY_BASE_MS * attempt;
      console.log(`[fetch-data] ${err.message}; retrying in ${wait}ms (${attempt}/${MAX_ATTEMPTS - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/**
 * Download one asset and return its decompressed bytes, WITHOUT writing
 * anything. Nothing reaches disk until both halves of the release have been
 * fetched and verified, so a failure half way through cannot leave a mixed
 * pair behind.
 */
async function fetchAsset({ asset, releaseId, expected }) {
  const names = releaseId ? [immutableName(asset, releaseId), asset] : [asset];
  for (const name of names) {
    const url = `${RELEASE_BASE}/${name}`;
    console.log(`[fetch-data] downloading ${url}`);
    const gz = await fetchBuffer(url);
    if (gz === null) {
      console.log(`[fetch-data] ${name} is not on the release`);
      continue;
    }
    if (expected && expected.sha256) {
      const got = sha256(gz);
      if (got !== expected.sha256) {
        throw new Error(
          `${name} does not match the committed release manifest.\n`
          + `  expected sha256 ${expected.sha256}\n`
          + `  received sha256 ${got}\n`
          + 'Refusing to build: the data on the release is not the data this commit was approved with.'
        );
      }
    }
    const raw = zlib.gunzipSync(gz);
    // Parse before anything is written, so a truncated or corrupt download can
    // never replace a good file with garbage.
    JSON.parse(raw.toString('utf8'));
    return { raw, name };
  }
  throw new Error(
    `Neither the immutable nor the rolling name for ${asset} is on the release. `
    + 'Check the rising-shows-data release, or run the refresh workflow.'
  );
}

async function main() {
  const force = process.argv.includes('--force');
  const manifest = readManifest();

  if (manifest) {
    console.log(`[fetch-data] release ${manifest.releaseId} (pinned by data-release.json)`);
  } else {
    console.log('[fetch-data] no data-release.json in this checkout: falling back to the '
      + 'rolling asset names. The build will use whatever is on the release right now, '
      + 'which is not necessarily the data this commit was approved with.');
  }

  // ALL OR NOTHING, per release. The old script skipped each existing file
  // independently, so one stale local file plus one fresh download silently
  // mixed two refreshes. A present pair is either complete or replaced.
  const present = TARGETS.filter(({ dest }) => fs.existsSync(dest));
  if (!force && present.length === TARGETS.length) {
    console.log('[fetch-data] both files already exist, skipping (use --force to re-download)');
    return;
  }
  if (!force && present.length) {
    console.log(`[fetch-data] ${present.length} of ${TARGETS.length} files present: `
      + 're-downloading the whole pair rather than mixing two releases');
  }

  const fetched = [];
  for (const target of TARGETS) {
    fetched.push({
      ...target,
      ...(await fetchAsset({
        asset: target.asset,
        releaseId: manifest ? manifest.releaseId : null,
        expected: manifest ? manifest.assets[target.asset] : null,
      })),
    });
  }

  // Both halves are in hand and verified; only now does anything land.
  for (const { raw, dest } of fetched) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, dest);
    const mb = (raw.length / 1024 / 1024).toFixed(1);
    console.log(`[fetch-data] wrote ${path.relative(APP_DIR, dest)} (${mb} MB)`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[fetch-data] FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { immutableName, readManifest, MANIFEST_PATH, TARGETS, RELEASE_BASE };
