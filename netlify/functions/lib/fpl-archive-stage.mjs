// The FPL deadline archive's staging store, written on time by Netlify.
//
// WHY THIS EXISTS (found 2026-10-10, the first day after PR #588 merged). The
// archive was captured by an hourly GitHub Actions schedule, and GitHub fires
// a free repository's schedules late or not at all: on 10 October the
// `17 * * * *` workflow ran ONCE between 03:17 and 14:17 UTC (09:46), and this
// repository's daily 06:00 job has started 5 to 8 hours late every day. A
// deadline snapshot that is not taken before the deadline is lost for good, so
// GW6's post-deadline capture (10:00 to 13:00) never happened. Netlify's
// scheduler fires on time (the cache prune ran at 04:00 sharp), so the
// CAPTURE now runs here, hourly, into this store; the GitHub workflow only
// copies what is staged here to the season's release whenever it does run
// (apps/fpl-planner/scripts/archive-snapshot.mjs --staged).
//
// LAYOUT, in the site-scoped `fpl-archive` store:
//   <season>/manifest.json   the same append-only manifest the release keeps
//   <season>/<file>          each stored snapshot, gzip, exactly the bytes the
//                            release will hold (scripts/lib/archive.mjs)
// A snapshot is written with onlyIfNew and the manifest with an etag
// condition, so nothing staged is ever overwritten and two overlapping runs
// cannot drop each other's entries (the loser retries next hour).
//
// The gating, the records and the dedupe are the archive library's, unchanged,
// so a snapshot staged here is the snapshot the script would have taken.

import {
  decideCaptures, captureRecords, emptyManifest, fetchEndpoint, seasonLabelFrom, assertAppendOnly,
  parseSnapshotFileName,
} from '../../../apps/fpl-planner/scripts/lib/archive.mjs';

export const ARCHIVE_STORE = 'fpl-archive';
export const manifestKey = (season) => `${season}/manifest.json`;
export const fileKey = (season, file) => `${season}/${file}`;

const SEASON_RE = /^\d{4}-\d{2}$/;
export const validSeason = (s) => typeof s === 'string' && SEASON_RE.test(s);
// Only an archive snapshot name (scripts/lib/archive.mjs NAME_RE) can be read
// back, so the export endpoint cannot be pointed at any other key.
export const validFile = (name) => typeof name === 'string' && !!parseSnapshotFileName(name);

async function readManifest(store, season) {
  const got = await store.getWithMetadata(manifestKey(season), { type: 'json' });
  return got && got.data ? { manifest: got.data, etag: got.etag || null } : { manifest: null, etag: null };
}

/**
 * One hourly run: read the bootstrap, decide what is due, capture it into the
 * store. Returns a summary for the log. `fetchImpl` and `now` are injectable so
 * tests drive it without the network or the clock.
 */
export async function stageCaptures({ store, fetchImpl = fetch, now = () => new Date().toISOString(), sleep } = {}) {
  const bootstrapFetch = await fetchEndpoint('bootstrap', 'bootstrap-static/', { fetchImpl, ...(sleep ? { sleep } : {}) });
  bootstrapFetch.capturedAt = now();
  const season = seasonLabelFrom(bootstrapFetch.body);
  const { manifest: stored, etag } = await readManifest(store, season);
  let manifest = stored || emptyManifest(season);

  const { captures, idle } = decideCaptures({ bootstrap: bootstrapFetch.body, manifest, now: now() });
  if (!captures.length) return { season, captures: [], idle, written: [] };

  const written = [];
  for (const c of captures) {
    const r = await captureRecords({
      season, phase: c.phase, gw: c.gw, deadline: c.deadline, manifest,
      bootstrapFetch: c.phase === 'live' ? null : bootstrapFetch, fetchImpl, sleep, now,
    });
    for (const { file, gz } of r.files) {
      const res = await store.set(fileKey(season, file), gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength), { onlyIfNew: true });
      if (res && res.modified === false) throw new Error(`staged ${file} already exists`);
      written.push(file);
    }
    manifest = r.manifest;
  }
  assertAppendOnly(stored, manifest);
  const res = await store.setJSON(manifestKey(season), manifest, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
  if (res && res.modified === false) throw new Error('the staged manifest changed underneath this run; the next run retries');
  return { season, captures, idle: null, written };
}

/** Seasons with a staged manifest, newest first. */
export async function stagedSeasons(store) {
  const out = await store.list({ prefix: '', directories: true });
  const dirs = (out && out.directories) || [];
  return dirs.map((d) => d.replace(/\/$/, '')).filter(validSeason).sort().reverse();
}

export async function stagedManifest(store, season) {
  return (await readManifest(store, season)).manifest;
}

export async function stagedFile(store, season, file) {
  const buf = await store.get(fileKey(season, file), { type: 'arrayBuffer' });
  return buf ? Buffer.from(buf) : null;
}
