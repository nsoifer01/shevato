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
// that already exists makes the upload fail rather than replace it. The one
// asset that is replaced is manifest.json, the index, and only after the new
// one has been checked to contain every entry of the old one unchanged.
//
// Exit codes: 0 captured or nothing to do, 75 FPL is mid-update (the next run
// retries), 1 anything else.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  ENDPOINTS, GATE, livePath, seasonLabelFrom, releaseTagFor, snapshotFileName, compactStamp,
  buildRecord, encodeRecord, writeSnapshotFile, emptyManifest, addToManifest, assertAppendOnly, decideCaptures,
  deadlineContext, fetchEndpoint, PHASES, captureRecords, decodeRecord,
} from './lib/archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_SOFT_CAP = 900;
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const flag = (name) => argv.includes(`--${name}`);

const OUT = arg('out') || join(HERE, '..', '.data', 'archive');
const PHASE = arg('phase') || 'auto';
const DRY = flag('dry-run');
const RELEASE = flag('release');
const JSON_OUT = flag('json');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

if (PHASE !== 'auto' && !PHASES.includes(PHASE)) {
  console.error(`--phase must be auto, ${PHASES.join(', ')}`);
  process.exit(1);
}

/* ------------------------------------------------------------- gh, or not */

function gh(args, { read = false } = {}) {
  const shown = `gh ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (DRY && !read) { log(`[dry-run] ${shown}`); return { ok: true, dry: true }; }
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (err) {
    if (read) return { ok: false, err: String(err.stderr || err.message) };
    throw new Error(`${shown} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * The manifest to build on: the release's when syncing (the truth across runs),
 * with any local captures the release does not have yet folded in on top.
 */
function loadManifest(season, dir) {
  const local = readJson(join(dir, 'manifest.json'));
  if (!RELEASE) return { manifest: local || emptyManifest(season), remote: null, releaseExists: null };
  const tag = releaseTagFor(season);
  const tmp = mkdtempSync(join(tmpdir(), 'fpl-archive-'));
  try {
    const view = gh(['release', 'view', tag, '--json', 'assets'], { read: true });
    if (!view.ok) {
      log(`release ${tag} does not exist yet${DRY ? ' (or gh cannot see it)' : ''}`);
      return { manifest: local || emptyManifest(season), remote: null, releaseExists: false };
    }
    const assets = (JSON.parse(view.out).assets || []).map((a) => a.name);
    // GitHub caps a release at 1000 assets. A season stores about 420, so this
    // is a tripwire, not a plan: stop well short of the cap with a message that
    // says what to do, rather than fail half way through an upload.
    if (assets.length >= ASSET_SOFT_CAP) {
      throw new Error(`release ${tag} holds ${assets.length} assets, at the ${ASSET_SOFT_CAP} safety line under GitHub's 1000 per release: start a second release for the season (--season-label ${season}-b) before capturing more`);
    }
    let remote = null;
    if (assets.includes('manifest.json')) {
      const dl = gh(['release', 'download', tag, '--pattern', 'manifest.json', '--dir', tmp], { read: true });
      // A release that HAS a manifest we cannot read must stop the run: going
      // on would replace the index with a shorter one and forget the season.
      if (!dl.ok) throw new Error(`release ${tag} has a manifest.json that could not be downloaded: ${dl.err.trim()}`);
      remote = readJson(join(tmp, 'manifest.json'));
    }
    // An asset the manifest does not list is a run that uploaded its snapshots
    // and died before the manifest: the bytes are safe on the release, only
    // unindexed. Say so on every run until someone indexes them by hand
    // (download, then re-run with them in --out), never delete them.
    const listed = new Set(((remote && remote.entries) || []).map((e) => e.file).filter(Boolean));
    const orphans = assets.filter((a) => a !== 'manifest.json' && !listed.has(a));
    if (orphans.length) console.warn(`::warning::release ${tag} has ${orphans.length} asset(s) the manifest does not list (an interrupted run): ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', ...' : ''}`);
    let manifest = remote || emptyManifest(season);
    const key = (e) => `${e.endpoint}|${e.capturedAt}|${e.sha256}`;
    const known = new Set(manifest.entries.map(key));
    // A local capture the release has not seen is re-added, so deduplication
    // is re-decided against the release (it may already hold the same bytes).
    for (const e of (local ? local.entries : [])) {
      if (known.has(key(e))) continue;
      const { sameAs, ...entry } = e;
      ({ manifest } = addToManifest(manifest, { ...entry, file: e.file || sameAs }));
    }
    return { manifest, remote, releaseExists: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------------- staged */

const STAGED_DEFAULT = 'https://shevato.com/.netlify/functions/fpl-archive-export';

async function pullStaged(season, dir) {
  const given = arg('staged');
  const base = given && !given.startsWith('--') ? given : STAGED_DEFAULT;
  const res = await fetch(`${base}?season=${encodeURIComponent(season)}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) { log(`nothing staged for ${season}`); return; }
  if (!res.ok) throw new Error(`staged manifest: HTTP ${res.status}`);
  const manifest = await res.json();
  if (!manifest || !Array.isArray(manifest.entries)) throw new Error('staged manifest is malformed');
  const local = readJson(join(dir, 'manifest.json'));
  // A local manifest wins (a machine with its own captures); the staged one
  // is folded in by loadManifest's merge exactly as local captures are.
  let pulled = 0;
  for (const e of manifest.entries) {
    if (!e.file || existsSync(join(dir, e.file))) continue;
    const r = await fetch(`${base}?season=${encodeURIComponent(season)}&file=${encodeURIComponent(e.file)}`);
    if (!r.ok) throw new Error(`staged ${e.file}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    // decodeRecord re-hashes the body against the record's own sha256.
    const { meta } = decodeRecord(buf);
    if (meta.sha256 !== e.sha256) throw new Error(`staged ${e.file} does not match its manifest hash`);
    writeSnapshotFile(dir, e.file, buf);
    pulled++;
  }
  if (!local) writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  else {
    let merged = local;
    const key = (x) => `${x.endpoint}|${x.capturedAt}|${x.sha256}`;
    const known = new Set(local.entries.map(key));
    for (const e of manifest.entries) {
      if (known.has(key(e))) continue;
      const { sameAs, ...entry } = e;
      ({ manifest: merged } = addToManifest(merged, { ...entry, file: e.file || sameAs }));
    }
    writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(merged, null, 2)}\n`);
  }
  log(`staged: ${manifest.entries.length} entries, ${pulled} file(s) pulled`);
}

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
  const bootstrapFetch = await fetchEndpoint('bootstrap', 'bootstrap-static/');
  bootstrapFetch.capturedAt = new Date().toISOString();
  const bootstrap = bootstrapFetch.body;
  const season = arg('season-label') || seasonLabelFrom(bootstrap);
  const dir = join(OUT, season);
  mkdirSync(dir, { recursive: true });

  // --staged [url]: start from what Netlify captured on time
  // (netlify/functions/fpl-archive-capture.mjs) instead of an empty directory,
  // so this run's job is to copy it to the release. The gate below then sees
  // those captures and only fills a gap Netlify left.
  if (flag('staged')) await pullStaged(season, dir);

  const loaded = loadManifest(season, dir);
  const before = loaded.remote;
  let manifest = loaded.manifest;
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

  // What the release is missing: every stored file the remote manifest does
  // not list. That is this run's captures plus any made locally earlier.
  let uploaded = [];
  if (RELEASE) {
    const tag = releaseTagFor(season);
    const remoteFiles = new Set((before ? before.entries : []).map((e) => e.file).filter(Boolean));
    const pending = manifest.entries.map((e) => e.file).filter((f) => f && !remoteFiles.has(f));
    const missing = pending.filter((f) => !existsSync(join(dir, f)));
    if (missing.length) throw new Error(`the manifest lists files this machine does not have: ${missing.join(', ')}`);
    const manifestChanged = JSON.stringify(before) !== JSON.stringify(manifest);
    if (pending.length || manifestChanged) {
      if (loaded.releaseExists === false) {
        gh(['release', 'create', tag, '--prerelease',
          '--title', `FPL deadline archive ${season}`,
          '--notes', `Public FPL payloads captured around each ${season} deadline by .github/workflows/fpl-archive.yml (apps/fpl-planner/scripts/archive-snapshot.mjs). Assets are never replaced except manifest.json, the append-only index.`]);
      }
      if (pending.length) gh(['release', 'upload', tag, ...pending.map((f) => join(dir, f))]);
      gh(['release', 'upload', tag, join(dir, 'manifest.json'), '--clobber']);
      uploaded = pending;
    } else {
      log('release is already up to date');
    }
  }

  const summary = {
    season, now, captures, idle, written, uploaded, dryRun: DRY,
    dir, files: written.map((f) => ({ file: f, gzBytes: statSync(join(dir, f)).size })),
  };
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
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

