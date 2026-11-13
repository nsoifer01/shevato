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
// Exit codes: 0 captured or nothing to do, 75 FPL is mid-update (the next run
// retries), 1 anything else.

import { mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  GATE, seasonLabelFrom, releaseTagFor, writeSnapshotFile, assertAppendOnly, decideCaptures,
  deadlineContext, fetchEndpoint, PHASES, captureRecords,
} from './lib/archive.mjs';
import { readRelease, pullStaged, loadManifest, syncRelease, readJson, writeAtomic } from './lib/archive-release.mjs';

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

const STAGED_DEFAULT = 'https://shevato.com/.netlify/functions/fpl-archive-export';

/* ---------------------------------------------------------------- capture */

async function captureOne({ season, dir, manifest, phase, gw, deadline, bootstrapFetch }) {
  const r = await captureRecords({ season, phase, gw, deadline, manifest, bootstrapFetch });
  for (const { file, gz } of r.files) {
    writeSnapshotFile(dir, file, gz);
    log(`  wrote ${file}  ${(gz.length / 1024).toFixed(0)} KB gz`);
  }
  for (const e of r.entries) if (!e.file) log(`  ${e.endpoint}: unchanged payload, recorded as a pointer to ${e.sameAs}`);
  return { manifest: r.manifest, written: r.files.map((f) => f.file) };
}

async function main() {
  const now = arg('now') || new Date().toISOString();
  const bootstrapFetch = await fetchEndpoint('bootstrap', 'bootstrap-static/', { onRetry });
  bootstrapFetch.capturedAt = new Date().toISOString();
  const bootstrap = bootstrapFetch.body;
  const season = arg('season-label') || seasonLabelFrom(bootstrap);
  const dir = join(OUT, season);
  mkdirSync(dir, { recursive: true });

  // The release first, so the staged pull below copies only what it lacks.
  const tag = releaseTagFor(season);
  const release = RELEASE ? await readRelease({ tag, gh, retry: RETRY }) : null;
  if (release && !release.exists) log(`release ${tag} does not exist yet`);
  // A run that died half way: its snapshots are indexed from their own
  // records, and an index copy ahead of manifest.json becomes the base. Both
  // are finished by this run's sync; anything left over needs a person.
  if (release && release.restoredFrom) console.warn(`::warning::release ${tag}'s manifest.json is behind ${release.restoredFrom} (an interrupted run); continuing from the copy`);
  if (release && release.recovered.length) console.warn(`::warning::release ${tag} held ${release.recovered.length} snapshot(s) its index did not list (an interrupted run); indexed from their records: ${release.recovered.join(', ')}`);
  if (release && release.orphans.length) console.warn(`::warning::release ${tag} has ${release.orphans.length} asset(s) that are not indexed and are not a whole archive record: ${release.orphans.slice(0, 5).join(', ')}${release.orphans.length > 5 ? ', ...' : ''}`);

  // --staged [url]: start from what Netlify captured on time
  // (netlify/functions/fpl-archive-capture.mjs) instead of an empty directory,
  // so this run's job is to copy it to the release. The gate below then sees
  // those captures and only fills a gap Netlify left. A failed pull does not
  // stop the run: when Netlify is down its capture may be down too, and the
  // gate's own capture is then the only one. The run still fails at the end.
  let stagedError = null;
  if (flag('staged')) {
    const given = arg('staged');
    const base = given && !given.startsWith('--') ? given : STAGED_DEFAULT;
    try {
      await pullStaged({ season, dir, base, remote: release ? release.manifest : null, net: { onRetry }, log });
    } catch (err) {
      stagedError = err;
      console.error(`::error::copying what Netlify staged failed: ${err.message}. Carrying on, so this run still captures what is due; it exits 1 at the end.`);
    }
  }

  const before = release ? release.manifest : null;
  let manifest = loadManifest({ season, dir, release });
  const written = [];

  let captures = [];
  let idle = null;
  if (flag('no-capture')) {
    idle = '--no-capture';
  } else if (PHASE === 'auto') {
    ({ captures, idle } = decideCaptures({ bootstrap, manifest, now }));
  } else {
    const { next, prev, all } = deadlineContext(bootstrap, now);
    const gwArg = arg('gw') ? Number(arg('gw')) : null;
    if (PHASE === 'live') {
      const ev = all.find((e) => e.gw === gwArg);
      if (!ev || !ev.finished) throw new Error(`--phase live needs --gw of a finished gameweek (got ${arg('gw')})`);
      captures = [{ phase: 'live', gw: ev.gw, deadline: ev.deadline, reason: 'requested' }];
    } else if (PHASE === 'pre') {
      if (!next) throw new Error('no deadline ahead: nothing is pre anything');
      const lead = (next.ms - Date.parse(now)) / 3600e3;
      // A "pre" snapshot means "what the deadline looked like shortly before
      // it". Outside the window it is filed as adhoc so the scorecard never
      // mistakes a week-old payload for a deadline payload.
      const phase = lead <= GATE.preWindowHours ? 'pre' : 'adhoc';
      if (phase === 'adhoc') log(`GW${next.gw} deadline is ${lead.toFixed(1)}h away, outside the ${GATE.preWindowHours}h window: filing as adhoc`);
      captures = [{ phase, gw: next.gw, deadline: next.deadline, reason: 'requested' }];
    } else if (PHASE === 'post') {
      if (!prev) throw new Error('no deadline has passed yet');
      captures = [{ phase: 'post', gw: prev.gw, deadline: prev.deadline, reason: 'requested' }];
    } else {
      const ref = gwArg ? all.find((e) => e.gw === gwArg) : next || prev;
      captures = [{ phase: 'adhoc', gw: ref ? ref.gw : 0, deadline: ref ? ref.deadline : null, reason: 'requested' }];
    }
  }

  if (!captures.length) log(`nothing to capture: ${idle}`);
  for (const c of captures) {
    log(`capturing ${c.phase} GW${c.gw} (${c.reason})`);
    const r = await captureOne({ season, dir, manifest, ...c, bootstrapFetch: c.phase === 'live' ? null : bootstrapFetch });
    manifest = r.manifest;
    written.push(...r.written);
  }

  assertAppendOnly(before, manifest);
  const local = readJson(join(dir, 'manifest.json'));
  const changed = JSON.stringify(local) !== JSON.stringify(manifest);
  if (changed) writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // What the release is missing: every stored file its manifest does not
  // list. That is this run's captures, what was staged, and any made locally.
  let uploaded = [];
  if (RELEASE) {
    ({ uploaded } = await syncRelease({ tag, season, dir, manifest, release, gh, dryRun: DRY, retry: RETRY, log }));
  }

  const summary = {
    season, now, captures, idle, written, uploaded, dryRun: DRY,
    dir, files: written.map((f) => ({ file: f, gzBytes: statSync(join(dir, f)).size })),
  };
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
  if (stagedError) throw stagedError;
  return summary;
}

main().then(() => process.exit(0), (err) => {
  if (err && err.gameUpdating) {
    console.error(`::warning::${err.message}; the next scheduled run retries`);
    process.exit(75);
  }
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

