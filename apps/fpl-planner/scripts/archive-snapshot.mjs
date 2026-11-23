// Capture FPL's public payloads around each deadline into the season archive.
//
//   node apps/fpl-planner/scripts/archive-snapshot.mjs                 # auto: decide, capture, write locally
//   node apps/fpl-planner/scripts/archive-snapshot.mjs --phase pre     # capture the next deadline now
//   node apps/fpl-planner/scripts/archive-snapshot.mjs --phase live --gw 5
//   node apps/fpl-planner/scripts/archive-snapshot.mjs --release       # also sync with the GitHub release
//   node apps/fpl-planner/scripts/archive-snapshot.mjs --release --dry-run   # print the gh commands only
//   node apps/fpl-planner/scripts/archive-snapshot.mjs --release --no-capture  # upload local captures not yet on the release
//
// Options: --out DIR (default apps/fpl-planner/.data/archive), --season-label
// 2026-27 (default: from the bootstrap), --now ISO (gating clock only; every
// record's capturedAt is always this machine's real clock), --json.
//
// WHAT IT WRITES
//
// <out>/<season>/<phase>-gw<NN>-<stamp>-<endpoint>.json.gz, one per endpoint,
// each a gzip JSON record carrying the body exactly as served (`raw`), its
// sha256, the URL, this machine's capture time, FPL's Date header and the
// deadline it relates to. Files are created exclusively and never overwritten.
// <out>/<season>/manifest.json lists every capture, append-only; a payload
// whose sha256 is already stored is recorded as a pointer (`sameAs`) instead of
// being stored twice.
//
// THE RELEASE (--release)
//
// One GitHub release per season, tagged fpl-archive-<season>, created as a
// prerelease, which GitHub never makes the repository's latest release (no
// --latest flag: gh 2.4.0 rejects it). The manifest is downloaded first so deduplication and gating work
// across runs; new snapshot files are uploaded WITHOUT --clobber, so an asset
// that already exists makes the upload fail rather than replace it. The only
// assets that are replaced are manifest.json, the index, and its two copies,
// one at a time and only with an index that keeps every entry of the old one.
// scripts/lib/archive-release.mjs does the reading, the staged pull and the
// upload: with --staged it downloads only the staged files the release does
// not already hold, every network and gh call is retried with backoff, a run
// that died half way is finished by the next, and every index written is read
// back before the run counts as done.
//
// Exit codes: 0 done, 1 a failure someone has to look at, 75 FPL could not be
// read (mid-update, refusing or unreachable) on a run that still copied
// everything staged: a warning, because the next run retries.
// scripts/lib/archive-run.mjs runs the steps and says which applies (exitCodeFor).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PHASES } from './lib/archive.mjs';
import { runArchive, exitCodeFor, STAGED_DEFAULT } from './lib/archive-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const flag = (name) => argv.includes(`--${name}`);

const OUT = arg('out') || join(HERE, '..', '.data', 'archive');
const PHASE = arg('phase') || 'auto';
const DRY = flag('dry-run');
const RELEASE = flag('release');
const JSON_OUT = flag('json');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };
// Every retry is logged as a warning, so a run that recovered says so.
const onRetry = (msg) => console.warn(`::warning::${msg}`);
const RETRY = { log: onRetry };

if (PHASE !== 'auto' && !PHASES.includes(PHASE)) {
  console.error(`--phase must be auto, ${PHASES.join(', ')}`);
  process.exit(1);
}

/* ------------------------------------------------------------- gh, or not */

/** stdout of one gh command, or an Error carrying its stderr. Writes only print under --dry-run. */
function gh(args) {
  const shown = `gh ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  const read = args[0] === 'release' && (args[1] === 'view' || args[1] === 'download');
  if (DRY && !read) { log(`[dry-run] ${shown}`); return ''; }
  try {
    // A hung gh fails the attempt (and is retried) instead of the whole job.
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (err) {
    throw new Error(`${shown} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

/* -------------------------------------------------------------------- run */

const given = arg('staged');
runArchive({
  out: OUT,
  phase: PHASE,
  gw: arg('gw') ? Number(arg('gw')) : null,
  now: arg('now'),
  seasonLabel: arg('season-label'),
  release: RELEASE,
  staged: flag('staged') ? (given && !given.startsWith('--') ? given : STAGED_DEFAULT) : null,
  noCapture: flag('no-capture'),
  dryRun: DRY,
  gh,
  net: { onRetry },
  retry: RETRY,
  log,
  warn: (msg) => console.warn(`::warning::${msg}`),
  error: (msg) => console.error(`::error::${msg}`),
}).then((result) => {
  if (JSON_OUT) console.log(JSON.stringify(result.summary, null, 2));
  const code = exitCodeFor({ phase: PHASE, ...result });
  // Every failure was reported as it happened; only a requested capture FPL
  // refused has not been reported as an error yet.
  if (code === 1 && result.fplError && !result.stagedError && !result.captureErrors.length) {
    console.error(`::error::the ${PHASE} capture asked for was not taken: ${result.fplError.message}`);
  }
  process.exit(code);
}, (err) => {
  if (err && err.gameUpdating) {
    console.error(`::warning::${err.message}; the next scheduled run retries`);
    process.exit(75);
  }
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
