// The live accuracy scorecard: every archived pre-deadline payload, projected
// exactly as the app projects it, scored against what the gameweek produced,
// beside points-per-club-match and FPL's own ep_next from the same payload.
//
//   node apps/fpl-planner/scripts/scorecard.mjs                       # local archive (.data/archive)
//   node apps/fpl-planner/scripts/scorecard.mjs --download --season 2026-27   # fetch the release first (gh)
//   node apps/fpl-planner/scripts/scorecard.mjs --fixtures            # the committed 2026 captures
//
// Options: --archive DIR, --season LABEL, --out DIR (report.md + report.json;
// default <archive>/<season>/scorecard, or .data/scorecard/fixtures-2026),
// --history FILE (default <archive>/<season>/scorecard-history.json),
// --offline (never fetch event/{gw}/live; a gameweek with no archived actuals
// is then left pending), --strict (exit 2 on a drift flag).
//
// Every pre snapshot is scored; the history keeps one row per snapshot and
// drift is judged on the newest snapshot of each gameweek. A snapshot captured
// at or after its deadline is refused (lib/archive-scorecard.mjs).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decodeRecord, storedFileOf, releaseTagFor, fetchEndpoint, livePath } from './lib/archive.mjs';
import {
  assertPreDeadline, deadlineRows, actualsFromLive, scoreRows, upsertHistory, driftFlags, renderMarkdown,
} from './lib/archive-scorecard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const flag = (name) => argv.includes(`--${name}`);
const SHIPPED = JSON.parse(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'));
const ARCHIVE = arg('archive') || join(APP, '.data', 'archive');
const HOUR = 3600e3;

const readJson = (file, fallback = null) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

function scoreOne({ season, gw, snapshot, capturedAt, serverDate, deadline, bootstrap, fixtures, actuals, actualsSource }) {
  assertPreDeadline({ capturedAt, serverDate }, deadline, snapshot);
  const { rows } = deadlineRows({ bootstrap, fixtures, capturedAt, gw, actuals, shipped: SHIPPED });
  const scored = scoreRows(rows);
  return {
    season, gw, snapshot, capturedAt, deadline,
    hoursBeforeDeadline: (Date.parse(deadline) - Date.parse(capturedAt)) / HOUR,
    actualsSource, ...scored,
  };
}

/* ------------------------------------------------------ the real archive */

async function scoreArchive(season) {
  const dir = join(ARCHIVE, season);
  if (flag('download')) {
    const tag = releaseTagFor(season);
    mkdirSync(dir, { recursive: true });
    // --skip-existing: a local file of the same name is the same exclusive-
    // created record, so there is nothing to replace.
    execFileSync('gh', ['release', 'download', tag, '--dir', dir, '--skip-existing'], { stdio: 'inherit' });
    execFileSync('gh', ['release', 'download', tag, '--dir', dir, '--pattern', 'manifest.json', '--clobber'], { stdio: 'inherit' });
  }
  const manifest = readJson(join(dir, 'manifest.json'));
  if (!manifest) throw new Error(`no manifest at ${dir}/manifest.json (use --download, or run archive-snapshot.mjs first)`);
  const load = (entry) => decodeRecord(readFileSync(join(dir, storedFileOf(entry))));

  const results = [];
  const refused = [];
  const pending = [];
  const pre = manifest.entries.filter((e) => e.phase === 'pre' && e.endpoint === 'bootstrap');
  const liveCache = new Map();
  for (const b of pre) {
    const snapshot = b.captureId;
    try {
      assertPreDeadline(b, b.deadline, snapshot);
    } catch (err) { refused.push(err.message); continue; }
    const fx = manifest.entries.find((e) => e.captureId === b.captureId && e.endpoint === 'fixtures');
    if (!fx) { refused.push(`${snapshot}: refused, no fixtures captured with it`); continue; }
    if (!liveCache.has(b.gw)) {
      const live = manifest.entries.filter((e) => e.phase === 'live' && e.gw === b.gw).pop();
      if (live) liveCache.set(b.gw, { body: load(live).body, source: `archived ${live.file || live.sameAs}` });
      else if (!flag('offline')) {
        try {
          const got = await fetchEndpoint('live', livePath(b.gw));
          const anyMinutes = got.body.elements.some((e) => e.stats && e.stats.minutes > 0);
          liveCache.set(b.gw, anyMinutes
            ? { body: got.body, source: `NOT ARCHIVED: fetched ${got.url} at ${new Date().toISOString()}` }
            : { missing: 'FPL has no minutes for it yet' });
        } catch (err) {
          // Before a gameweek is played FPL serves {"elements": []}, which the
          // shape check refuses; either way there is nothing to score yet.
          liveCache.set(b.gw, { missing: `no usable live stats (${err.message})` });
        }
      } else liveCache.set(b.gw, { missing: 'not archived, and --offline' });
    }
    const live = liveCache.get(b.gw);
    if (!live.body) { pending.push(`${snapshot}: GW${b.gw} has no actuals yet: ${live.missing}`); continue; }
    const bootstrap = load(b).body;
    const fixtures = load(fx).body;
    try {
      results.push(scoreOne({
        season, gw: b.gw, snapshot, capturedAt: b.capturedAt, serverDate: b.serverDate, deadline: b.deadline,
        bootstrap, fixtures, actuals: actualsFromLive(live.body), actualsSource: live.source,
      }));
    } catch (err) {
      if (err.leakage) refused.push(err.message); else throw err;
    }
  }
  return { results, refused, pending };
}

/* ---------------------------------------------- the committed 2026 captures */

async function scoreFixtures() {
  // The calibration capture rebuilds the GW3 and GW4 deadlines from the payload
  // served after GW4 was signed off (tests/helpers/xp-calibration-fixture.mjs).
  // Reconstructed, not archived: injury flags are GW5's and reset to available,
  // ep_next is not kept, and fetchedAt is set an hour before the deadline.
  const xp = await import('../tests/helpers/xp-calibration-fixture.mjs');
  const results = [];
  const refused = [];
  for (const gw of xp.DEADLINES) {
    const { bootstrap, fixtures, fetchedAt } = xp.deadlinePayload(gw);
    const stats = xp.liveStats(gw);
    const actuals = new Map([...stats].map(([id, s]) => [id, { points: s.total_points, minutes: s.minutes, started: s.starts > 0 ? 1 : 0 }]));
    const deadline = bootstrap.events.find((e) => e.id === gw).deadline_time;
    results.push(scoreOne({
      season: '2026-27', gw, snapshot: `xp-calibration-2026 rebuilt GW${gw} deadline`, capturedAt: fetchedAt, deadline,
      bootstrap, fixtures, actuals, actualsSource: `tests/fixtures/xp-calibration-2026/live-gw${gw}.json`,
    }));
  }
  // The GW4 capture is a payload served with MUN v MCI in play, a day after
  // the GW4 deadline. It is exactly what the leakage guard exists to refuse.
  const gw4 = readJson(join(APP, 'tests', 'fixtures', 'gw4-2026', 'manifest.json'));
  const ft = readJson(join(APP, 'tests', 'fixtures', 'gw4-2026', 'full-time.json'));
  for (const state of gw4.states) {
    const name = Object.keys(state.sha256).find((k) => k.startsWith('bootstrap'));
    const m = /(\d{8})T(\d{4})Z/.exec(name);
    const capturedAt = m
      ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2].slice(0, 2)}:${m[2].slice(2)}:00Z`
      : '2026-09-13T16:27:00Z'; // the manifest's "served at 16:27 UTC"; full time came later still
    const deadline = ft.events.find((e) => e.id === gw4.gameweek).deadline_time;
    try {
      assertPreDeadline({ capturedAt }, deadline, `gw4-2026 ${state.name}`);
      refused.push(`gw4-2026 ${state.name}: passed the guard, which it should not have`);
    } catch (err) { refused.push(err.message); }
  }
  return { results, refused, pending: [] };
}

/* -------------------------------------------------------------------- run */

async function main() {
  const generatedAt = new Date().toISOString();
  let seasonOut;
  let batches = [];
  if (flag('fixtures')) {
    batches = [{ season: '2026-27', ...(await scoreFixtures()) }];
    seasonOut = arg('out') || join(APP, '.data', 'scorecard', 'fixtures-2026');
  } else {
    const seasons = arg('season') ? [arg('season')]
      : (existsSync(ARCHIVE) ? readdirSync(ARCHIVE).filter((d) => /^\d{4}-\d{2}$/.test(d)) : []);
    if (!seasons.length) throw new Error(`no season under ${ARCHIVE}; pass --season (with --download) or capture first`);
    for (const season of seasons) batches.push({ season, ...(await scoreArchive(season)) });
    seasonOut = arg('out') || join(ARCHIVE, seasons[seasons.length - 1], 'scorecard');
  }

  const results = batches.flatMap((b) => b.results);
  const refused = batches.flatMap((b) => b.refused);
  const pending = batches.flatMap((b) => b.pending);
  const historyFile = arg('history') || (flag('fixtures')
    ? join(seasonOut, 'scorecard-history.json')
    : join(ARCHIVE, batches[batches.length - 1].season, 'scorecard-history.json'));
  let history = readJson(historyFile, []);
  for (const r of results) {
    history = upsertHistory(history, {
      season: r.season, gw: r.gw, snapshot: r.snapshot, capturedAt: r.capturedAt,
      hoursBeforeDeadline: r.hoursBeforeDeadline, n: r.n, methods: r.methods, scoredAt: generatedAt,
    });
  }
  const drift = driftFlags(history);
  const notes = [];
  if (flag('fixtures')) {
    notes.push('Committed captures, not the live archive: the GW3 and GW4 deadlines are REBUILT from the payload served after GW4 (injury flags reset to available, so the engine sees no team news; ep_next is not in the capture, so the FPL reference is unavailable).');
  }
  for (const p of pending) notes.push(`pending: ${p}`);
  const markdown = renderMarkdown({ title: 'FPL Planner live accuracy scorecard', generatedAt, results, refused, drift, notes });

  mkdirSync(seasonOut, { recursive: true });
  mkdirSync(dirname(historyFile), { recursive: true });
  writeFileSync(join(seasonOut, 'report.md'), markdown);
  writeFileSync(join(seasonOut, 'report.json'), `${JSON.stringify({ generatedAt, results, refused, pending, drift }, null, 2)}\n`);
  writeFileSync(historyFile, `${JSON.stringify(history, null, 2)}\n`);
  console.log(markdown);
  console.log(`wrote ${join(seasonOut, 'report.md')}, report.json and ${historyFile}`);
  if (drift.length && flag('strict')) process.exit(2);
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
