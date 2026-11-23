// One run of the deadline archive, as scripts/archive-snapshot.mjs runs it:
// read the release, copy what Netlify staged, run the gate's own capture, sync.
// Kept here, with every effect injected (gh, fetch, the clock, the log), so
// tests/archive-run.test.mjs drives exactly the sequence production runs.
//
// WHY (2026-11-23, run 45087799507). The run read FPL's bootstrap before
// anything else, because the season label came from it, so one 403 from FPL
// ended the run before it looked at the release or the staged snapshots. The
// copy does not need FPL at all: Netlify took the snapshots on time, and the
// export lists its seasons. Now an FPL that cannot be read costs only the
// gate's backup capture, and the copy still runs. The tests of #665 never saw
// this, because they rebuilt the production sequence by hand without the
// bootstrap read that failed.
//
// Outcomes, as runArchive reports them and exitCodeFor maps them:
//   - the copy failed (staged pull or release sync): 1, always;
//   - a capture the gate found due failed: 1, unless FPL said it is updating
//     (75). The gate runs after the copy, so a due capture here is one Netlify
//     did not stage, and losing it matters;
//   - FPL could not be read at all (a refusal, a network failure, or the
//     update notice) on a scheduled `auto` run whose copy completed: 75, a
//     warning. Whether a deadline went uncaptured is the Netlify health run's
//     check (archiveCoverageFailures, which alerts), and the next run retries;
//   - the same on a requested phase: 1 (75 for the update notice), since a
//     person asked for that capture and did not get it.

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE, seasonLabelFrom, releaseTagFor, writeSnapshotFile, assertAppendOnly, decideCaptures,
  deadlineContext, fetchEndpoint, fetchWithRetry, captureRecords,
} from './archive.mjs';
import { readRelease, pullStaged, loadManifest, syncRelease, readJson, writeAtomic } from './archive-release.mjs';

export const STAGED_DEFAULT = 'https://shevato.com/.netlify/functions/fpl-archive-export';
const SEASON_RE = /^\d{4}-\d{2}$/;

/**
 * The newest season the staging store holds, from the export's own list, for
 * a run that cannot read FPL's bootstrap. null when nothing is staged.
 */
export async function newestStagedSeason({ base, fetchImpl = fetch, net = {} }) {
  const { body } = await fetchWithRetry(base, { label: 'staged seasons', init: { headers: { Accept: 'application/json' } }, fetchImpl, ...net });
  let seasons;
  try { ({ seasons } = JSON.parse(body)); } catch { throw new Error('the staged season list is not JSON'); }
  if (!Array.isArray(seasons)) throw new Error('the staged season list is malformed');
  const season = seasons[0];
  if (season === undefined) return null;
  if (!SEASON_RE.test(season)) throw new Error(`the staged season list names ${JSON.stringify(season)}, not a season`);
  return season;
}

/** The capture a person asked for with --phase, checked against the bootstrap's deadlines. */
function requestedCaptures({ phase, gw, bootstrap, now, log }) {
  const { next, prev, all } = deadlineContext(bootstrap, now);
  if (phase === 'live') {
    const ev = all.find((e) => e.gw === gw);
    if (!ev || !ev.finished) throw new Error(`--phase live needs --gw of a finished gameweek (got ${gw})`);
    return [{ phase: 'live', gw: ev.gw, deadline: ev.deadline, reason: 'requested' }];
  }
  if (phase === 'pre') {
    if (!next) throw new Error('no deadline ahead: nothing is pre anything');
    const lead = (next.ms - Date.parse(now)) / 3600e3;
    // A "pre" snapshot means "what the deadline looked like shortly before
    // it". Outside the window it is filed as adhoc so the scorecard never
    // mistakes a week-old payload for a deadline payload.
    const filed = lead <= GATE.preWindowHours ? 'pre' : 'adhoc';
    if (filed === 'adhoc') log(`GW${next.gw} deadline is ${lead.toFixed(1)}h away, outside the ${GATE.preWindowHours}h window: filing as adhoc`);
    return [{ phase: filed, gw: next.gw, deadline: next.deadline, reason: 'requested' }];
  }
  if (phase === 'post') {
    if (!prev) throw new Error('no deadline has passed yet');
    return [{ phase: 'post', gw: prev.gw, deadline: prev.deadline, reason: 'requested' }];
  }
  const ref = gw ? all.find((e) => e.gw === gw) : next || prev;
  return [{ phase: 'adhoc', gw: ref ? ref.gw : 0, deadline: ref ? ref.deadline : null, reason: 'requested' }];
}

/**
 * One run. Throws only when the run cannot go on safely (the release cannot
 * be read or does not hold what it lists, the manifest would lose entries, a
 * season cannot be named); everything else is reported in the result, after
 * the copy has been done, so one failure never costs another part's work.
 * @returns {Promise<{ summary: object, fplError: Error|null, stagedError: Error|null, captureErrors: Error[] }>}
 */
export async function runArchive({
  out, phase = 'auto', gw = null, now = null, seasonLabel = null, release: useRelease = false, staged = null,
  noCapture = false, dryRun = false, gh = null, fetchImpl = fetch, net = {}, retry = {},
  log = () => {}, warn = () => {}, error = () => {}, clock = () => new Date().toISOString(),
}) {
  const at = now || clock();

  // FPL first, as before, but its failure no longer ends the run: the copy
  // needs only the season, and the export can name it.
  // The season is derived inside the same handler: a bootstrap that passes
  // assertShape but has no readable first deadline used to throw here before
  // the copy (review of #687). Such a bootstrap is dropped, so the gate never
  // captures from it, and its error is not `upstream`, so the run fails.
  let bootstrapFetch = null;
  let bootstrapSeason = null;
  let fplError = null;
  try {
    const got = await fetchEndpoint('bootstrap', 'bootstrap-static/', { fetchImpl, ...net });
    got.capturedAt = clock();
    bootstrapSeason = seasonLabelFrom(got.body);
    bootstrapFetch = got;
  } catch (err) {
    fplError = err;
  }
  let season = seasonLabel || bootstrapSeason;
  if (!season && staged) {
    try { season = await newestStagedSeason({ base: staged, fetchImpl, net }); } catch (err) {
      error(`FPL's bootstrap could not be read (${fplError.message}) and neither could the staged season list (${err.message})`);
      throw fplError;
    }
    if (!season) log('nothing is staged yet');
  }
  // Nothing to copy and nothing to gate on: FPL's error is the run's.
  if (!season) throw fplError;
  if (fplError) warn(`FPL's bootstrap could not be read: ${fplError.message}. Copying what Netlify staged for ${season}; the gate's own capture waits for the next run`);

  const dir = join(out, season);
  mkdirSync(dir, { recursive: true });

  // The release first, so the staged pull below copies only what it lacks.
  const tag = releaseTagFor(season);
  const release = useRelease ? await readRelease({ tag, gh, retry }) : null;
  if (release && !release.exists) log(`release ${tag} does not exist yet`);
  // A run that died half way: its snapshots are indexed from their own
  // records, and an index copy ahead of manifest.json becomes the base. Both
  // are finished by this run's sync; anything left over needs a person.
  if (release && release.restoredFrom) warn(`release ${tag}'s manifest.json is behind ${release.restoredFrom} (an interrupted run); continuing from the copy`);
  if (release && release.recovered.length) warn(`release ${tag} held ${release.recovered.length} snapshot(s) its index did not list (an interrupted run); indexed from their records: ${release.recovered.join(', ')}`);
  if (release && release.orphans.length) warn(`release ${tag} has ${release.orphans.length} asset(s) that are not indexed and are not a whole archive record: ${release.orphans.slice(0, 5).join(', ')}${release.orphans.length > 5 ? ', ...' : ''}`);

  // Start from what Netlify captured on time (netlify/functions/
  // fpl-archive-capture.mjs) instead of an empty directory, so this run's job
  // is to copy it to the release. The gate below then sees those captures and
  // only fills a gap Netlify left. A failed pull does not stop the run: when
  // Netlify is down its capture may be down too, and the gate's own capture is
  // then the only one. The run still fails at the end.
  let stagedError = null;
  if (staged) {
    try {
      await pullStaged({ season, dir, base: staged, remote: release ? release.manifest : null, fetchImpl, net, log });
    } catch (err) {
      stagedError = err;
      error(`copying what Netlify staged failed: ${err.message}. Carrying on, so this run still captures what is due; it exits 1 at the end.`);
    }
  }

  const before = release ? release.manifest : null;
  let manifest = loadManifest({ season, dir, release });

  let captures = [];
  let idle = null;
  if (noCapture) idle = '--no-capture';
  else if (!bootstrapFetch) idle = 'FPL could not be read';
  else if (phase === 'auto') ({ captures, idle } = decideCaptures({ bootstrap: bootstrapFetch.body, manifest, now: at }));
  else captures = requestedCaptures({ phase, gw, bootstrap: bootstrapFetch.body, now: at, log });

  // Each capture stands alone: one that fails (FPL refusing event/N/live, say)
  // no longer throws away another taken in the same run.
  const written = [];
  const captureErrors = [];
  if (!captures.length) log(`nothing to capture: ${idle}`);
  for (const c of captures) {
    log(`capturing ${c.phase} GW${c.gw} (${c.reason})`);
    let r;
    try {
      r = await captureRecords({
        season, phase: c.phase, gw: c.gw, deadline: c.deadline, manifest, fetchImpl, now: clock,
        bootstrapFetch: c.phase === 'live' ? null : bootstrapFetch, ...(net.sleep ? { sleep: net.sleep } : {}),
      });
    } catch (err) {
      captureErrors.push(err);
      error(`capturing ${c.phase} GW${c.gw} failed: ${err.message}`);
      continue;
    }
    for (const { file, gz } of r.files) {
      writeSnapshotFile(dir, file, gz);
      log(`  wrote ${file}  ${(gz.length / 1024).toFixed(0)} KB gz`);
    }
    for (const e of r.entries) if (!e.file) log(`  ${e.endpoint}: unchanged payload, recorded as a pointer to ${e.sameAs}`);
    manifest = r.manifest;
    written.push(...r.files.map((f) => f.file));
  }

  assertAppendOnly(before, manifest);
  const local = readJson(join(dir, 'manifest.json'));
  if (JSON.stringify(local) !== JSON.stringify(manifest)) writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // What the release is missing: every stored file its manifest does not
  // list. That is this run's captures, what was staged, and any made locally.
  let uploaded = [];
  if (release) ({ uploaded } = await syncRelease({ tag, season, dir, manifest, release, gh, dryRun, retry, log }));

  const summary = {
    season, now: at, captures, idle, written, uploaded, dryRun,
    dir, files: written.map((f) => ({ file: f, gzBytes: statSync(join(dir, f)).size })),
  };
  return { summary, fplError, stagedError, captureErrors };
}

/** The process exit code for a run's result; see the header for why each. */
export function exitCodeFor({ phase = 'auto', fplError = null, stagedError = null, captureErrors = [] }) {
  if (stagedError) return 1;
  if (captureErrors.some((e) => !e.gameUpdating)) return 1;
  if (captureErrors.length) return 75;
  if (fplError) {
    if (fplError.gameUpdating) return 75;
    return phase === 'auto' && fplError.upstream ? 75 : 1;
  }
  return 0;
}
