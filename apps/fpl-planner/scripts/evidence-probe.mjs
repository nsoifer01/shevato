// What the app makes of the live payload, right now, and whether it is healthy.
//
// WHY THIS FILE IS SHAPED THIS WAY
//
// It used to end in four hand-written comparisons, one of which was "is the
// projected gameweek total between 30 and 100". On 2026-08-21 the pipeline
// broke, that number read 14.5 and the probe correctly shouted PROBLEM - and
// then, as more minutes accumulated, the same broken pipeline drifted to 31.5
// and the probe went green. Nothing had been fixed. A threshold cannot tell
// "healthy" from "wrong by a factor" because both sides of it contain both.
//
// So health is now a set of NAMED INVARIANTS, each of which says what it
// checks, what it saw, and what it expected, plus a comparison against the last
// recorded reading so a large unexplained move is itself a failure. The exit
// code is the verdict; the output names which invariant failed.
//
//   node apps/fpl-planner/scripts/evidence-probe.mjs
//   node apps/fpl-planner/scripts/evidence-probe.mjs --bootstrap FILE --fixtures FILE
//   node apps/fpl-planner/scripts/evidence-probe.mjs --record        # save this reading
//   node apps/fpl-planner/scripts/evidence-probe.mjs --json          # machine readable
//   node apps/fpl-planner/scripts/evidence-probe.mjs --direct        # FPL itself, not the proxy (CI)
//   node apps/fpl-planner/scripts/evidence-probe.mjs --now ISO       # judge freshness at this time
//   node apps/fpl-planner/scripts/evidence-probe.mjs --entry 3855835 # also plan a real manager
//   node apps/fpl-planner/scripts/evidence-probe.mjs --entry-dir DIR # ... from saved files
//
// With no arguments it reads the live proxy. With files it reads a captured
// pair, which is how a payload saved during a gameweek is diagnosed afterwards.
// `--direct` reads fantasy.premierleague.com with a polite User-Agent, because
// the proxy refuses any origin but shevato.com, which is every GitHub runner
// (.github/workflows/fpl-health.yml runs it that way). Freshness is judged
// against the wall clock for a live read and against `--now` for files (and
// skipped for files without it: a captured pair is old by definition).
// `--record` writes the reading to .data/probe-baseline.json so the next run
// can compare against it.
//
// `--entry ID` reads one manager's entry, history, transfers and current picks
// (and the revert squad after a Free Hit) the way the app does and plans HIM
// instead of a squad the probe builds, which adds the real-entry invariants of
// scripts/lib/plan-audit.mjs. `--entry-dir` reads them from entry.json,
// history.json, transfers.json, picks.json and, if present, revert-picks.json.
// `--entry none` probes without a manager, the meaning FPL_HEALTH_ENTRY=none
// has on Netlify (the GitHub workflow passes that variable straight through,
// and until 2026-10-16 asked FPL for entry "none", a 404 and a red run). Any
// other ID that is not a number is refused before anything is fetched.
//
// EVERY FAILURE EXITS NON-ZERO, and says what failed: a failed invariant, an
// entry FPL will not serve (404, 403, a network error: its own failed check),
// and anything that throws (a dead network before the payloads arrive, a plan
// that throws), which is reported as the failed check "the probe runs to
// completion" rather than as a stack trace.
//
// The invariants themselves live in scripts/lib/probe.mjs, shared with the
// scheduled Netlify function that runs them against production every six hours
// (netlify/functions/fpl-health.mjs); this file reads the inputs, prints and
// records.
//
// The payload is resolved exactly as app.js resolves it for a first-time
// visitor (engine/world.js with the shipped data/opening-baseline.json), so the
// projections judged here are the ones the app shows. Until 2026-09-16 the probe
// projected the bare payload, which stopped describing the app the day the
// previous season became a prior for the whole season.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_AGENT, FPL_API } from './lib/archive.mjs';
import { runProbe, payloadShapeFailures } from './lib/probe.mjs';
import { freeHitPicksInfo } from '../js/engine/squad.js';

const PROXY = 'https://shevato.com/.netlify/functions/fpl?path=';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const DIRECT = flag('direct');
const responses = {};
async function read(name, file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = DIRECT
    ? await fetch(`${FPL_API}${name}/`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
    : await fetch(PROXY + encodeURIComponent(name), { headers: { Origin: 'https://shevato.com', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  responses[name] = res.headers;
  return res.json();
}
const SOURCE = arg('bootstrap') ? 'files' : DIRECT ? 'fpl' : 'proxy';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(HERE, '..', '.data', 'probe-baseline.json');

// The last recorded reading, used for change detection. Absent on a first run,
// which is not a failure: the invariants that need it simply do not apply.
const prev = existsSync(BASELINE_FILE)
  ? (() => { try { return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; } })()
  : null;

// A failure that ends the probe before the invariants are judged.
function fail(name, saw, expected) {
  if (flag('json')) {
    console.log(JSON.stringify({ checks: [{ name, ok: false, saw, expected }] }, null, 2));
  } else {
    console.log(`FAIL  ${name}\n        ${[].concat(saw).join('\n        ')}`);
    console.log(`\nPROBLEM: ${name}`);
  }
  process.exit(1);
}

const ENTRY_ARG = arg('entry');
const ENTRY_ID = ENTRY_ARG && ENTRY_ARG.trim().toLowerCase() !== 'none' ? ENTRY_ARG.trim() : null;
if (ENTRY_ID && !/^\d+$/.test(ENTRY_ID)) {
  fail('the entry to probe is an FPL team id', `--entry "${ENTRY_ARG}"`, 'a number, or "none" to probe without one');
}

let bootstrap;
let fixtures;
try {
  bootstrap = await read('bootstrap-static', arg('bootstrap'));
  fixtures = await read('fixtures', arg('fixtures'));
} catch (err) {
  fail('the probe runs to completion', `reading the payloads threw: ${err && err.message}`, 'bootstrap-static and fixtures read');
}
const fetchedAt = new Date().toISOString();

const shapeFailures = payloadShapeFailures(bootstrap, fixtures);
if (shapeFailures.length) fail('the payloads have the shape the app reads', shapeFailures, 'bootstrap and fixtures arrays');

// One manager, read the way js/app.js loadTeam reads him.
async function readEntry() {
  const dir = arg('entry-dir');
  if (dir) {
    const f = (n) => (existsSync(join(dir, n)) ? JSON.parse(readFileSync(join(dir, n), 'utf8')) : null);
    const entry = f('entry.json');
    return { id: entry ? entry.id : 'files', entry, history: f('history.json'), transfers: f('transfers.json'), picks: f('picks.json'), revertPicks: f('revert-picks.json') };
  }
  const id = ENTRY_ID;
  if (!id) return null;
  const optional = async (path) => { try { return await read(path); } catch (err) { if (/HTTP 404/.test(err.message)) return null; throw err; } };
  try {
    const current = bootstrap.events.find((e) => e.is_current);
    const [entry, history, transfers, picks] = await Promise.all([
      read(`entry/${id}`), read(`entry/${id}/history`), read(`entry/${id}/transfers`),
      current ? optional(`entry/${id}/event/${current.id}/picks`) : null,
    ]);
    const fh = freeHitPicksInfo({ picks, history });
    const next = bootstrap.events.find((e) => e.is_next);
    const revertPicks = picks && fh.isFreeHit && fh.event > 1 && next && next.id > fh.event
      ? await optional(`entry/${id}/event/${fh.event - 1}/picks`) : null;
    return { id, entry, history, transfers, picks, revertPicks };
  } catch (err) {
    return { id, error: err.message };
  }
}

let result;
try {
  result = await runProbe({
    bootstrap, fixtures, fetchedAt, now: arg('now'), source: SOURCE, responses, prev, entry: await readEntry(),
    loadShipped: async () => JSON.parse(readFileSync(join(HERE, '..', 'data', 'opening-baseline.json'), 'utf8')),
  });
} catch (err) {
  fail('the probe runs to completion', `threw: ${err && err.message}`, 'no exception');
}

if (flag('json')) {
  console.log(JSON.stringify({ reading: result.reading, checks: result.checks, readiness: result.readiness, blocked: result.blocked }, null, 2));
} else {
  const okLines = result.lines;
  const cut = okLines.lastIndexOf('');
  for (const line of okLines.slice(0, cut)) console.log(line);
}

if (flag('record')) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify(result.reading, null, 2));
  if (!flag('json')) console.log(`\nrecorded to ${BASELINE_FILE}`);
}

if (!flag('json')) for (const line of result.lines.slice(result.lines.lastIndexOf(''))) console.log(line);
process.exit(result.failed.length ? 1 : 0);
