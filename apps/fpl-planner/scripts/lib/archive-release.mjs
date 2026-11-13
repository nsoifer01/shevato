// The GitHub side of the deadline archive: read the season's release, pull
// only what Netlify staged that the release does not already hold, and upload
// so that a failed or interrupted run never costs a snapshot and the next run
// finishes the job. scripts/archive-snapshot.mjs wires it to the real `gh` and
// fetch; tests/archive-release.test.mjs drives exactly this code against a
// fake release and a failing network.
//
// WHY (2026-11-12, run 43330644438). One dropped connection on one of the 42
// staged files the job downloaded EVERY hour failed the whole run: the pull
// fetched every staged snapshot afresh into an empty runner directory, and
// nothing in it retried. Reading the code behind it found three more ways to
// wedge or damage the archive, each fixed here:
//   - a run that uploaded some snapshots and died before the manifest left
//     assets the manifest does not list, and the next run tried to upload them
//     again without --clobber, which gh refuses ("asset under the same name
//     already exists"), so every later run failed until someone stepped in;
//   - gh's --clobber DELETES the old asset before uploading the new one
//     (cli/cli pkg/cmd/release/shared/upload.go, uploadWithDelete), so a
//     manifest upload that failed half way left the release with no index, and
//     the next run would have rebuilt one from the staged copy alone;
//   - any failure of `gh release view` (a 5xx, a rate limit) was read as "the
//     release does not exist yet".
//
// The rules: a snapshot counts as archived only when the release's manifest
// lists it AND the release holds an uploaded asset of the listed size. Nothing
// on the release is ever replaced except manifest.json, and that only after
// re-reading it unchanged since this run began, then reading the new one back.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addToManifest, emptyManifest, decodeRecord, writeSnapshotFile, fetchWithRetry, backoffMs, sleepMs,
} from './archive.mjs';

/** GitHub caps a release at 1000 assets; a season stores about 420. */
export const ASSET_SOFT_CAP = 900;

/** One capture, the same in the release's manifest, the staged one and a local one. */
export const entryKey = (e) => `${e.endpoint}|${e.capturedAt}|${e.sha256}`;

/** gh failures that asking again cannot fix. */
const PERMANENT_GH = /release not found|already exists|no assets match/i;

const firstLine = (text) => String(text).split('\n').find((l) => l.trim()) || String(text);

export function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Run one gh command, asking again with backoff and jitter when it fails for a
 * reason that may pass (a 5xx, a rate limit, a timeout, a dropped connection).
 * `gh(args)` returns stdout or throws an Error carrying gh's stderr.
 */
export async function ghRetrying(gh, args, {
  attempts = 4, baseDelayMs = 5000, maxDelayMs = 60000, sleep = sleepMs, random = Math.random, log = () => {},
} = {}) {
  for (let n = 1; ; n++) {
    try {
      return await gh(args);
    } catch (err) {
      if (PERMANENT_GH.test(err.message) || n >= attempts) throw err;
      const delay = backoffMs(n, { baseDelayMs, maxDelayMs, random });
      log(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(err.message)}; attempt ${n + 1} of ${attempts} in ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }
}

/** One asset's bytes, or an error (gh's "no assets match" when it is not there). */
export async function downloadAsset(gh, tag, name, retry = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'fpl-archive-'));
  try {
    await ghRetrying(gh, ['release', 'download', tag, '--pattern', name, '--dir', tmp], retry);
    return readFileSync(join(tmp, name));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function listAssets(gh, tag, retry) {
  const out = await ghRetrying(gh, ['release', 'view', tag, '--json', 'assets'], retry);
  return new Map((JSON.parse(out).assets || []).map((a) => [a.name, a]));
}

/**
 * The release as it stands: { exists, assets, manifest, orphans }. Throws when
 * the release cannot be read, or when it does not hold what its manifest
 * lists, rather than build on a state it does not understand.
 */
export async function readRelease({ tag, gh, retry = {} }) {
  let assets;
  try {
    assets = await listAssets(gh, tag, retry);
  } catch (err) {
    if (/release not found/i.test(err.message)) return { exists: false, assets: new Map(), manifest: null, orphans: [] };
    throw err;
  }
  // A tripwire, not a plan: stop well short of GitHub's cap with a message
  // that says what to do, rather than fail half way through an upload.
  if (assets.size >= ASSET_SOFT_CAP) {
    const season = tag.replace(/^fpl-archive-/, '');
    throw new Error(`release ${tag} holds ${assets.size} assets, at the ${ASSET_SOFT_CAP} safety line under GitHub's 1000 per release: start a second release for the season (--season-label ${season}-b) before capturing more`);
  }
  const snapshots = [...assets.keys()].filter((n) => n !== 'manifest.json');
  let manifest = null;
  if (assets.has('manifest.json')) {
    // A release that HAS a manifest we cannot read must stop the run: going
    // on would replace the index with a shorter one and forget the season.
    const buf = await downloadAsset(gh, tag, 'manifest.json', retry);
    try { manifest = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`release ${tag} has a manifest.json that is not JSON`); }
    if (!manifest || !Array.isArray(manifest.entries)) throw new Error(`release ${tag} has a manifest.json with no entries list`);
  } else if (snapshots.length) {
    // Snapshots without an index: a manifest upload died between gh's delete
    // and its upload. Rebuilding the index from the staged copy would drop
    // every capture Netlify never staged, so this is for a human.
    throw new Error(`release ${tag} holds ${snapshots.length} snapshot(s) but no manifest.json, so its index was lost (an interrupted --clobber upload); restore manifest.json from the last good run's copy before syncing again`);
  }
  const listed = new Set();
  const problems = [];
  for (const e of (manifest ? manifest.entries : [])) {
    if (!e.file) continue;
    listed.add(e.file);
    const a = assets.get(e.file);
    if (!a) problems.push(`${e.file} is not on the release`);
    else if (a.state && a.state !== 'uploaded') problems.push(`${e.file} is in state ${a.state}`);
    else if (Number.isFinite(e.gzBytes) && e.gzBytes > 0 && a.size !== e.gzBytes) problems.push(`${e.file} is ${a.size} bytes, the manifest says ${e.gzBytes}`);
  }
  if (problems.length) throw new Error(`release ${tag} does not hold what its manifest lists: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; ...' : ''}`);
  return { exists: true, assets, manifest, orphans: snapshots.filter((n) => !listed.has(n)) };
}

/**
 * The staged files this run has to download: those of entries the release's
 * manifest does not know yet, and only when the release does not already
 * store the same bytes (the fold in archive-snapshot.mjs's loadManifest then
 * records that entry as a pointer). Pure.
 */
export function planStagedPull({ staged, remote }) {
  const entries = remote ? remote.entries : [];
  const known = new Set(entries.map(entryKey));
  const stored = new Set(entries.filter((e) => e.file).map((e) => e.sha256));
  const need = new Map();
  for (const e of staged.entries) {
    if (known.has(entryKey(e)) || stored.has(e.sha256)) continue;
    const file = e.file || e.sameAs;
    if (!file) throw new Error(`staged entry ${entryKey(e)} names no file`);
    need.set(file, e.sha256);
  }
  return [...need].map(([file, sha256]) => ({ file, sha256 }));
}

/**
 * Copy what Netlify staged into `dir`: the staged manifest (merged into a
 * local one if there is one) and the files planStagedPull says are needed.
 * Every file is checked against its manifest hash before it is written.
 */
export async function pullStaged({ season, dir, base, remote, fetchImpl = fetch, net = {}, log = () => {} }) {
  const q = `${base}?season=${encodeURIComponent(season)}`;
  const got = await fetchWithRetry(q, { label: 'staged manifest', init: { headers: { Accept: 'application/json' } }, accept: [404], fetchImpl, ...net });
  if (got.res.status === 404) { log(`nothing staged for ${season}`); return { staged: null, needed: [], pulled: [] }; }
  let staged;
  try { staged = JSON.parse(got.body); } catch { throw new Error('staged manifest is not JSON'); }
  if (!staged || !Array.isArray(staged.entries)) throw new Error('staged manifest is malformed');

  const needed = planStagedPull({ staged, remote });
  const pulled = [];
  for (const { file, sha256 } of needed) {
    // Already here (a local machine's earlier run): syncRelease re-verifies it
    // against the manifest before anything is uploaded.
    if (existsSync(join(dir, file))) continue;
    const { body: buf } = await fetchWithRetry(`${q}&file=${encodeURIComponent(file)}`, {
      label: `staged ${file}`, read: async (r) => Buffer.from(await r.arrayBuffer()), fetchImpl, ...net,
    });
    let meta;
    // decodeRecord re-hashes the body against the record's own sha256.
    try { ({ meta } = decodeRecord(buf)); } catch (err) { throw new Error(`staged ${file} is not a valid archive record: ${err.message}`); }
    if (meta.sha256 !== sha256) throw new Error(`staged ${file} does not match its manifest hash`);
    writeSnapshotFile(dir, file, buf);
    pulled.push(file);
  }

  // A local manifest wins (a machine with its own captures); the staged one
  // is folded in by loadManifest's merge exactly as local captures are.
  const local = readJson(join(dir, 'manifest.json'));
  let merged = staged;
  if (local) {
    merged = local;
    const known = new Set(local.entries.map(entryKey));
    for (const e of staged.entries) {
      if (known.has(entryKey(e))) continue;
      const { sameAs, ...entry } = e;
      ({ manifest: merged } = addToManifest(merged, { ...entry, file: e.file || sameAs }));
    }
  }
  writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(merged, null, 2)}\n`);
  log(`staged: ${staged.entries.length} entries, ${needed.length} file(s) the release lacks, ${pulled.length} downloaded`);
  return { staged, needed, pulled };
}

/**
 * The manifest to build on: the release's when syncing (the truth across runs),
 * with any local captures the release does not have yet folded in on top.
 * Without a release (no --release), the local manifest as it is.
 */
export function loadManifest({ season, dir, release }) {
  const local = readJson(join(dir, 'manifest.json'));
  if (!release) return local || emptyManifest(season);
  let manifest = release.manifest || emptyManifest(season);
  const known = new Set(manifest.entries.map(entryKey));
  // A local capture the release has not seen is re-added, so deduplication
  // is re-decided against the release (it may already hold the same bytes).
  for (const e of (local ? local.entries : [])) {
    if (known.has(entryKey(e))) continue;
    const { sameAs, ...entry } = e;
    ({ manifest } = addToManifest(manifest, { ...entry, file: e.file || sameAs }));
  }
  return manifest;
}

/** Throws unless `dir/<entry.file>` is a whole record holding the entry's payload. */
function verifyLocal(dir, entry) {
  let meta;
  try { ({ meta } = decodeRecord(readFileSync(join(dir, entry.file)))); } catch (err) {
    throw new Error(`${entry.file} on this machine is not a valid archive record (${err.message}); refusing to upload it`);
  }
  if (meta.sha256 !== entry.sha256) throw new Error(`${entry.file} on this machine does not hold the payload its manifest entry names; refusing to upload it`);
}

/**
 * Upload one snapshot without --clobber. An asset of that name already on the
 * release (an earlier run that died before its manifest, or this run's own
 * attempt that failed after landing) is accepted only when its bytes are the
 * local ones; anything else is a conflict nobody may overwrite.
 */
async function uploadSnapshot({ tag, dir, file, state, gh, retry }) {
  const { attempts = 4, baseDelayMs = 5000, maxDelayMs = 60000, sleep = sleepMs, random = Math.random, log = () => {} } = retry;
  const local = readFileSync(join(dir, file));
  for (let n = 1; ; n++) {
    const existing = state.assets.get(file);
    if (existing) {
      if (existing.state && existing.state !== 'uploaded') {
        throw new Error(`release ${tag} holds ${file} in state ${existing.state} (an interrupted upload): delete that asset and the next run uploads it again`);
      }
      const remote = await downloadAsset(gh, tag, file, retry);
      if (remote.equals(local)) return 'already-there';
      throw new Error(`release ${tag} already holds a different ${file}; refusing to replace it`);
    }
    try {
      await gh(['release', 'upload', tag, join(dir, file)]);
      return 'uploaded';
    } catch (err) {
      if (n >= attempts) throw new Error(`uploading ${file} failed after ${attempts} attempts: ${firstLine(err.message)}`);
      const delay = backoffMs(n, { baseDelayMs, maxDelayMs, random });
      log(`uploading ${file} failed: ${firstLine(err.message)}; attempt ${n + 1} of ${attempts} in ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
      // The failed attempt may have landed: look before trying again.
      state.assets = await listAssets(gh, tag, retry);
    }
  }
}

/**
 * Replace manifest.json and read it back. gh's --clobber deletes the old asset
 * before uploading, so a failed attempt can leave no index at all: it is
 * retried until the release serves exactly these bytes.
 */
async function uploadManifest({ tag, dir, gh, retry }) {
  const { attempts = 4, baseDelayMs = 5000, maxDelayMs = 60000, sleep = sleepMs, random = Math.random, log = () => {} } = retry;
  const path = join(dir, 'manifest.json');
  const want = readFileSync(path);
  let why = null;
  for (let n = 1; ; n++) {
    try { await gh(['release', 'upload', tag, path, '--clobber']); why = null; } catch (err) { why = firstLine(err.message); }
    let back = null;
    try { back = await downloadAsset(gh, tag, 'manifest.json', retry); } catch (err) { why = why || `reading it back: ${firstLine(err.message)}`; }
    if (back && back.equals(want)) return;
    why = why || 'the release serves different bytes';
    if (n >= attempts) throw new Error(`manifest.json did not reach release ${tag} after ${attempts} attempts (${why}); the snapshots are uploaded, and the next run uploads the index again`);
    const delay = backoffMs(n, { baseDelayMs, maxDelayMs, random });
    log(`manifest.json upload not confirmed (${why}); attempt ${n + 1} of ${attempts} in ${(delay / 1000).toFixed(1)}s`);
    await sleep(delay);
  }
}

/**
 * Bring the release up to `manifest`: create it if needed, upload every stored
 * file the release's manifest does not list, then the manifest. Returns
 * { uploaded, alreadyThere }.
 */
export async function syncRelease({ tag, season, dir, manifest, release, gh, dryRun = false, retry = {}, log = () => {} }) {
  const before = release.manifest;
  const remoteFiles = new Set((before ? before.entries : []).map((e) => e.file).filter(Boolean));
  const pending = manifest.entries.filter((e) => e.file && !remoteFiles.has(e.file));
  const missing = pending.filter((e) => !existsSync(join(dir, e.file)));
  if (missing.length) throw new Error(`the manifest lists files this machine does not have: ${missing.map((e) => e.file).join(', ')}`);
  for (const e of pending) verifyLocal(dir, e);
  if (!pending.length && JSON.stringify(before) === JSON.stringify(manifest)) {
    log('release is already up to date');
    return { uploaded: [], alreadyThere: [] };
  }
  // The index uploaded is exactly `manifest`, whatever the file on disk held.
  writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const createArgs = ['release', 'create', tag, '--prerelease',
    '--title', `FPL deadline archive ${season}`,
    '--notes', `Public FPL payloads captured around each ${season} deadline by .github/workflows/fpl-archive.yml (apps/fpl-planner/scripts/archive-snapshot.mjs). Assets are never replaced except manifest.json, the append-only index.`];
  if (dryRun) {
    if (!release.exists) await gh(createArgs);
    if (pending.length) await gh(['release', 'upload', tag, ...pending.map((e) => join(dir, e.file))]);
    await gh(['release', 'upload', tag, join(dir, 'manifest.json'), '--clobber']);
    return { uploaded: pending.map((e) => e.file), alreadyThere: [] };
  }

  const state = { assets: release.assets };
  if (!release.exists) {
    try {
      await ghRetrying(gh, createArgs, retry);
    } catch (err) {
      // A create that failed in transit may still have happened.
      try { state.assets = await listAssets(gh, tag, retry); } catch { throw err; }
    }
  }
  const uploaded = [];
  const alreadyThere = [];
  for (const e of pending) {
    const how = await uploadSnapshot({ tag, dir, file: e.file, state, gh, retry });
    (how === 'uploaded' ? uploaded : alreadyThere).push(e.file);
  }
  if (alreadyThere.length) log(`${alreadyThere.length} snapshot(s) were already on the release from an interrupted run, byte for byte: ${alreadyThere.join(', ')}`);

  // Only this run may replace the index it read: the workflow's concurrency
  // group keeps two jobs apart, and this keeps a hand run apart from a job.
  const now = (await listAssets(gh, tag, retry)).has('manifest.json')
    ? JSON.parse((await downloadAsset(gh, tag, 'manifest.json', retry)).toString('utf8'))
    : null;
  if (JSON.stringify(now) !== JSON.stringify(before)) {
    throw new Error(`release ${tag}'s manifest.json changed while this run was working; nothing was replaced, and the next run starts from the new one`);
  }
  await uploadManifest({ tag, dir, gh, retry });
  return { uploaded, alreadyThere };
}
