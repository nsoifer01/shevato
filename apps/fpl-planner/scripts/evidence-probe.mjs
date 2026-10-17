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
//   node apps/fpl-planner/scripts/evidence-probe.mjs --direct --sample 12        # + 12 real managers
//   node apps/fpl-planner/scripts/evidence-probe.mjs ... --summary FILE          # Markdown report
//   node apps/fpl-planner/scripts/evidence-probe.mjs ... --save-failures DIR     # failing payloads
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
// EVERY FAILURE EXITS NON-ZERO, says what failed, and says WHOSE it is:
//
//   UPSTREAM     FPL could not be read: a network error, no answer in time,
//                HTTP 403/429 (a refusal), 404, 5xx, or a body that is not
//                the payload (not JSON, not the shape the app reads). Exit 2
//                when every failure is of this class.
//   APPLICATION  the app read FPL and got something wrong: any invariant, any
//                real-entry or consistency check, a plan that throws. Exit 1
//                whenever there is at least one, whatever else failed.
//
// The split exists so a failure email says, before anyone opens it, whether
// the planner has a defect or FPL had a bad hour. Anything that throws (a dead
// network before the payloads arrive, a plan that throws) is reported as the
// failed check "the probe runs to completion" rather than as a stack trace.
// A check that was ASKED FOR and could not run is never "OK": an entry FPL
// will not serve, a manager with no squad in a live season, or a sample that
// read fewer managers than requested is an UPSTREAM failure.
//
// `--sample N` (with `--direct`) is the pre-gameweek readiness gate (added
// 2026-10-16). One monitored manager exercises one path through the engine,
// and of the 29 live-season defects many lived on paths his state never
// takes: three banked transfers, a Free Hit just played, a late joiner, a
// history that lags. So after the payload checks the CLI reads N REAL
// managers and runs every real-entry check on each, his plan included
// (entrySquadVerdict, planEntryVerdict and entryVerdictChecks of
// scripts/lib/probe.mjs, the code runProbe judges the monitored entry with).
// Who is read ROTATES with the six-hour UTC slot of the run's clock (`--now`
// or now) and is fixed within it, so a red run can be re-run on the same
// managers: three pages of the overall league's standings (one in the top
// thousand, one log-uniform below it, one anywhere down to the last page,
// so deep ranks are covered and not only the elite), plus about a quarter of
// N as random entry ids, one of them from the newest 3% of ids (late joiners),
// with two spares for ids that turn out empty. It is polite by construction:
// one request at a time, at least a second apart, a timeout on each, the
// total bounded and printed, and the first 403 or 429 ends the sample (what
// was not read is reported as UPSTREAM, never as passed). Each manager prints
// the PATH he exercises (free transfers held, a chip just played, a Free Hit
// revert, a late joiner, hits taken, a lagging history, what his plan does)
// and a coverage line totals them, so a green run says which paths it saw.
// Team ids are printed only for managers who fail (they are needed to
// reproduce), and `--save-failures DIR` writes their payloads in the
// `--entry-dir` layout beside the bootstrap and fixtures, which replays them
// offline with `--bootstrap --fixtures --entry-dir --now`.
//
// `--summary FILE` appends a short Markdown report (verdict, each failed
// check and its class, the managers and paths covered) for the GitHub step
// summary, so the failure email is actionable without the log.
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


import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { USER_AGENT, FPL_API } from './lib/archive.mjs';
import {
  runProbe, payloadShapeFailures, resolveProbeWorld, entrySquadVerdict, planEntryVerdict, entryVerdictChecks,
} from './lib/probe.mjs';
import { freeHitPicksInfo } from '../js/engine/squad.js';

const PROXY = 'https://shevato.com/.netlify/functions/fpl?path=';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const DIRECT = flag('direct');
const UPSTREAM = 'UPSTREAM';
const APPLICATION = 'APPLICATION';

// One request may take this long. FPL answers in well under a second; a read
// that hangs is an upstream fault, and without a bound it would hold the
// GitHub job until its own timeout and say nothing about why.
const REQUEST_TIMEOUT_MS = 20000;
// At least this long between two requests while a sample is read (the
// politeness promise above). FPL_PROBE_REQUEST_GAP_MS lowers it for the tests,
// which answer from stubs; nothing else sets it.
const SAMPLE_GAP_MS = 1000;
const LEAGUE_OVERALL = 314;
const PAGE_SIZE = 50;
const SPARES = 2;
const MAX_SAMPLE = 40;

/** A read FPL did not answer with the payload: always UPSTREAM. */
class UpstreamError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const kindOfStatus = (status) => (status === 403 || status === 429 ? 'refused'
  : status === 404 ? 'missing' : status >= 500 ? 'server' : 'http');
// A local file that is not JSON is a malformed payload too.
const classOf = (err) => (err instanceof UpstreamError || err instanceof SyntaxError ? UPSTREAM : APPLICATION);

const responses = {};
let requests = 0;
let refused = null;
let gate = Promise.resolve();
let lastRequestAt = 0;
let gapMs = 0;

async function fetchOnce(name) {
  // After a refusal nothing more is asked: FPL said stop.
  if (refused) throw new UpstreamError('refused', `${name}: not asked, FPL refused ${refused}`);
  requests += 1;
  let res;
  try {
    res = DIRECT
      ? await fetch(`${FPL_API}${name}${name.includes('?') ? '' : '/'}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      : await fetch(PROXY + encodeURIComponent(name), { headers: { Origin: 'https://shevato.com', Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new UpstreamError('timeout', `${name}: no answer in ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw new UpstreamError('network', `${name}: ${err && err.message}`);
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) refused = refused || `${name} with HTTP ${res.status}`;
    throw new UpstreamError(kindOfStatus(res.status), `${name}: HTTP ${res.status}`);
  }
  responses[name] = res.headers;
  try {
    return await res.json();
  } catch {
    throw new UpstreamError('malformed', `${name}: the body is not JSON`);
  }
}

async function read(name, file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  if (!gapMs) return fetchOnce(name);
  // One at a time, `gapMs` after the previous one finished, even when the
  // caller asks for several at once (readEntry's Promise.all).
  const run = gate.then(async () => {
    const wait = lastRequestAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fetchOnce(name); } finally { lastRequestAt = Date.now(); }
  });
  gate = run.catch(() => {});
  return run;
}
const SOURCE = arg('bootstrap') ? 'files' : DIRECT ? 'fpl' : 'proxy';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(HERE, '..', '.data', 'probe-baseline.json');
const loadShipped = async () => JSON.parse(readFileSync(join(HERE, '..', 'data', 'opening-baseline.json'), 'utf8'));

// The last recorded reading, used for change detection. Absent on a first run,
// which is not a failure: the invariants that need it simply do not apply.
const prev = existsSync(BASELINE_FILE)
  ? (() => { try { return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; } })()
  : null;

const SUMMARY_FILE = arg('summary');
const summary = (lines) => { if (SUMMARY_FILE) appendFileSync(SUMMARY_FILE, `${lines.join('\n')}\n`); };

const SAMPLE_ARG = arg('sample');
const SAMPLE_N = SAMPLE_ARG === null ? 0 : Number(SAMPLE_ARG);

// A failure that ends the probe before the invariants are judged.
function fail(name, saw, expected, cls = APPLICATION) {
  const notRun = SAMPLE_N > 0 ? `the sample of ${SAMPLE_N} managers did not run` : null;
  if (flag('json')) {
    console.log(JSON.stringify({ checks: [{ name, ok: false, class: cls, saw, expected }], counts: { [cls]: 1 }, sample: notRun }, null, 2));
  } else {
    console.log(`FAIL  ${name}\n        ${[].concat(saw).join('\n        ')}`);
    if (notRun) console.log(`\n${notRun}`);
    console.log(`\nfailures        application ${cls === APPLICATION ? 1 : 0}   upstream ${cls === UPSTREAM ? 1 : 0}`);
    console.log(`PROBLEM (${cls}): ${name}`);
  }
  summary([`### FPL health probe: PROBLEM (${cls})`, '', `- **${cls}** ${name}: ${[].concat(saw).join('; ')}`, ...(notRun ? ['', notRun] : [])]);
  process.exit(cls === UPSTREAM ? 2 : 1);
}

const ENTRY_ARG = arg('entry');
const ENTRY_ID = ENTRY_ARG && ENTRY_ARG.trim().toLowerCase() !== 'none' ? ENTRY_ARG.trim() : null;
if (ENTRY_ID && !/^\d+$/.test(ENTRY_ID)) {
  fail('the entry to probe is an FPL team id', `--entry "${ENTRY_ARG}"`, 'a number, or "none" to probe without one');
}
if (SAMPLE_ARG !== null && !(Number.isInteger(SAMPLE_N) && SAMPLE_N >= 0 && SAMPLE_N <= MAX_SAMPLE)) {
  fail('the sample size is a whole number', `--sample "${SAMPLE_ARG}"`, `0 to ${MAX_SAMPLE}`);
}
// The proxy serves only the paths the app reads, never the league standings.
if (SAMPLE_N > 0 && !DIRECT) fail('the sample reads FPL directly', '--sample without --direct', '--direct --sample N');
if (SAMPLE_N > 0) {
  const env = Number(process.env.FPL_PROBE_REQUEST_GAP_MS);
  gapMs = Number.isFinite(env) && env >= 0 ? env : SAMPLE_GAP_MS;
}

let bootstrap;
let fixtures;
try {
  bootstrap = await read('bootstrap-static', arg('bootstrap'));
  fixtures = await read('fixtures', arg('fixtures'));
} catch (err) {
  fail('the probe runs to completion', `reading the payloads threw: ${err && err.message}`, 'bootstrap-static and fixtures read', classOf(err));
}
const fetchedAt = new Date().toISOString();

const shapeFailures = payloadShapeFailures(bootstrap, fixtures);
if (shapeFailures.length) fail('the payloads have the shape the app reads', shapeFailures, 'bootstrap and fixtures arrays', UPSTREAM);

// One manager, read the way js/app.js loadTeam reads him. The monitored entry
// and every sampled manager come through here.
async function readEntry(id) {
  const optional = async (path) => { try { return await read(path); } catch (err) { if (err.kind === 'missing') return null; throw err; } };
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
    return { id, error: err.message, errorClass: classOf(err), errorKind: err.kind || null };
  }
}
async function readMonitoredEntry() {
  const dir = arg('entry-dir');
  if (dir) {
    const f = (n) => (existsSync(join(dir, n)) ? JSON.parse(readFileSync(join(dir, n), 'utf8')) : null);
    const entry = f('entry.json');
    return { id: entry ? entry.id : 'files', entry, history: f('history.json'), transfers: f('transfers.json'), picks: f('picks.json'), revertPicks: f('revert-picks.json') };
  }
  return ENTRY_ID ? readEntry(ENTRY_ID) : null;
}

let result;
let monitored;
try {
  monitored = await readMonitoredEntry();
  result = await runProbe({
    bootstrap, fixtures, fetchedAt, now: arg('now'), source: SOURCE, responses, prev, entry: monitored, loadShipped,
  });
} catch (err) {
  fail('the probe runs to completion', `threw: ${err && err.message}`, 'no exception');
}

// Every failed check with its class. The only UPSTREAM one runProbe can raise
// is the monitored entry FPL would not serve; everything else it judges is
// the application's.
const currentEvent = bootstrap.events.find((e) => e.is_current) || null;
const failures = result.checks.filter((c) => c.ok === false).map((c) => ({
  ...c, class: monitored && monitored.error && c.name === `the proxy serves entry ${monitored.id}` ? monitored.errorClass : APPLICATION,
}));
// Asked for, and in a live season, but no squad came back: the entry checks
// could not run, which must not read as passing.
if (monitored && !monitored.error && !monitored.picks && currentEvent) {
  failures.push({ name: `entry ${monitored.id} has a squad for GW${currentEvent.id}`, ok: false, class: UPSTREAM,
    saw: 'no picks for the current gameweek', expected: 'the current picks, so the entry checks can run' });
}

/* ------------------------------------------------------------- the sample */

// FNV-1a then mulberry32: the same slot draws the same managers on any
// machine, and the next slot draws others.
function rngFor(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function slotOf(iso) {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${String(Math.floor(d.getUTCHours() / 6) * 6).padStart(2, '0')}:00Z`;
}

/** Which standings pages and random ids this slot reads; pure in (slot, totalPlayers). */
function samplePlan(slot, totalPlayers, n) {
  const rng = rngFor(`fpl-sample ${slot}`);
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const total = Math.max(1, Number(totalPlayers) || 1);
  const lastPage = Math.max(1, Math.floor(total / PAGE_SIZE));
  const tenth = Math.max(21, Math.floor(lastPage / 10));
  const pages = [...new Set([
    int(1, Math.min(20, lastPage)),
    Math.min(lastPage, Math.round(Math.exp(Math.log(21) + rng() * (Math.log(tenth) - Math.log(21))))),
    int(Math.min(tenth, lastPage), lastPage),
  ])];
  const randomCount = Math.max(1, Math.round(n / 4));
  const fromPages = Math.max(0, n - randomCount);
  const perPage = pages.map((_, i) => Math.floor(fromPages / pages.length) + (i < fromPages % pages.length ? 1 : 0));
  const randomIds = [int(Math.max(1, Math.floor(total * 0.97)), total)];
  while (randomIds.length < randomCount + SPARES) randomIds.push(int(1, total));
  return { rng, pages, perPage, randomIds, randomCount, budget: pages.length + (n + SPARES) * 5 };
}

const fmtRank = (r) => (!Number.isFinite(r) ? 'rank ?' : r >= 1e6 ? `rank ${(r / 1e6).toFixed(1)}M` : r >= 1e3 ? `rank ${(r / 1e3).toFixed(0)}k` : `rank ${r}`);

/** The engine path this manager's state exercises, as short tags. */
function pathOf(e, squadState, verdict, plan) {
  const tags = [`${verdict.freeTransfers} FT`];
  const cur = currentEvent ? currentEvent.id : null;
  const played = ((e.history && e.history.chips) || []).filter((c) => c.event === cur).map((c) => c.name);
  if (played.length) tags.push(`just played ${played.join('+')}`);
  if (squadState.freeHitGw) tags.push('Free Hit revert');
  const started = e.entry && e.entry.started_event;
  if (started > 1) tags.push(`late joiner GW${started}`);
  const weeks = (e.history && e.history.current) || [];
  const hits = weeks.reduce((s, w) => s + (Number(w.event_transfers_cost) || 0), 0);
  if (hits) tags.push(`hits -${hits}`);
  const lastWeek = weeks.reduce((m, w) => Math.max(m, w.event || 0), 0);
  if (cur && lastWeek < cur) tags.push(`history lags ${cur - lastWeek} wk`);
  tags.push(`${verdict.offered.length} chip${verdict.offered.length === 1 ? '' : 's'} left`);
  if (plan) {
    const p = plan.current;
    tags.push(`plan ${p.transferCount} transfer${p.transferCount === 1 ? '' : 's'}${p.hits ? ` ${p.hits} hit${p.hits === 1 ? '' : 's'}` : ''}${p.chip ? ` ${p.chip}` : ''}`);
  }
  return { tags, played, revert: !!squadState.freeHitGw, late: started > 1, hits: hits > 0, lag: !!(cur && lastWeek < cur),
    planHit: !!(plan && plan.current.hits), planChip: plan && plan.current.chip ? plan.current.chip : null };
}

function saveFailure(dir, e) {
  const out = join(dir, String(e.id));
  mkdirSync(out, { recursive: true });
  for (const [file, body] of [['entry', e.entry], ['history', e.history], ['transfers', e.transfers], ['picks', e.picks], ['revert-picks', e.revertPicks]]) {
    if (body) writeFileSync(join(out, `${file}.json`), JSON.stringify(body));
  }
  if (!existsSync(join(dir, 'bootstrap.json'))) {
    writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify(bootstrap));
    writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures));
    writeFileSync(join(dir, 'now.txt'), `${fetchedAt}\n`);
  }
}

async function runSample(n) {
  const slot = slotOf(arg('now') || fetchedAt);
  const plan = samplePlan(slot, bootstrap.total_players, n);
  const out = { slot, requested: n, pages: plan.pages, managers: [], skipped: [], failures: [], budget: plan.budget };
  const requestsBefore = requests;
  const seen = new Set(monitored && monitored.id ? [String(monitored.id)] : []);
  const candidates = [];
  const upstream = (name, saw) => out.failures.push({ name, ok: false, class: UPSTREAM, saw, expected: 'FPL answers the read' });

  for (const [i, page] of plan.pages.entries()) {
    if (refused) break;
    let body;
    try {
      body = await read(`leagues-classic/${LEAGUE_OVERALL}/standings/?page_standings=${page}`);
    } catch (err) {
      upstream(`the overall league's standings page ${page} is served`, err.message);
      continue;
    }
    const rows = body && body.standings && Array.isArray(body.standings.results) ? body.standings.results : null;
    if (!rows) { upstream(`the overall league's standings page ${page} is served`, 'no standings.results array'); continue; }
    const pool = rows.filter((r) => Number.isInteger(r.entry) && !seen.has(String(r.entry)));
    for (let k = 0; k < plan.perPage[i] && pool.length; k++) {
      const [r] = pool.splice(Math.floor(plan.rng() * pool.length), 1);
      seen.add(String(r.entry));
      candidates.push({ id: r.entry, origin: `page ${page}`, rank: r.rank });
    }
  }
  plan.randomIds.forEach((id, i) => {
    if (seen.has(String(id))) return;
    seen.add(String(id));
    candidates.push({ id, origin: i === 0 ? 'newest ids' : i < plan.randomCount ? 'random id' : 'spare id', rank: null });
  });

  const world = candidates.length && !refused ? await resolveProbeWorld({ bootstrap, fixtures, fetchedAt, loadShipped }) : null;
  const rules = world && world.gameState.rules;
  for (const c of candidates) {
    // The spares come last, so one is read only to replace a candidate that
    // turned out empty or unreadable.
    if (out.managers.length >= n || refused) break;
    const e = await readEntry(c.id);
    const rank = c.rank ?? (e.entry && e.entry.summary_overall_rank);
    if (e.error) {
      if (e.errorKind === 'missing') {
        // Ids are not dense, and an account can go between the standings
        // read and this one: an id with no entry is no fault.
        out.skipped.push({ origin: c.origin, why: 'no such entry' });
        continue;
      }
      upstream(`sampled manager (${c.origin}, ${fmtRank(rank)}) is served`, e.error);
      if (e.errorClass === APPLICATION) out.failures[out.failures.length - 1].class = APPLICATION;
      continue;
    }
    if (!e.picks) { out.skipped.push({ origin: c.origin, why: 'no squad for the current gameweek yet' }); continue; }

    const m = { id: c.id, origin: c.origin, rank, checks: [], seconds: null, path: null, payload: e };
    out.managers.push(m);
    const label = `sampled manager #${out.managers.length} (${c.origin}, ${fmtRank(rank)})`;
    try {
      const { squadState, verdict } = entrySquadVerdict({ entry: e, gameState: world.gameState, bootstrap, gw: world.gameState.currentEvent ?? 1 });
      let planned = null;
      if (result.usable) {
        planned = await planEntryVerdict({ gameState: world.gameState, squadState, verdict });
        m.seconds = planned.seconds;
        m.checks.push({ name: `entry ${c.id}: the plan passes validatePlan`, ok: planned.planVerdict.ok,
          saw: planned.planVerdict.ok ? 'valid' : planned.planVerdict.violations.map((v) => v.code).join(', '), expected: 'no violations' });
      }
      m.checks.push(...entryVerdictChecks(verdict, rules));
      m.path = pathOf(e, squadState, verdict, planned && planned.plan);
    } catch (err) {
      m.checks.push({ name: `entry ${c.id}: the squad reads and plans`, ok: false, saw: `threw: ${err && err.message}`, expected: 'no exception' });
    }
    // The manager's id is printed once, on his own line, not in every check.
    for (const f of m.checks.filter((x) => !x.ok)) out.failures.push({ ...f, name: `${label}: ${f.name.replace(/^entry \d+: /, '')}`, class: APPLICATION });
  }

  if (out.managers.length < n) {
    const why = refused ? `FPL refused ${refused}` : `${out.skipped.length} empty, ${out.failures.filter((f) => f.class === UPSTREAM).length} unreadable`;
    out.failures.push({ name: `the sample reads ${n} real managers`, ok: false, class: UPSTREAM,
      saw: `${out.managers.length} read (${why})`, expected: `${n} managers checked; an unread one is never a pass` });
  }
  out.requests = requests - requestsBefore;
  return out;
}

let sample = null;
if (SAMPLE_N > 0) {
  try {
    sample = await runSample(SAMPLE_N);
  } catch (err) {
    failures.push({ name: 'the sample runs to completion', ok: false, class: classOf(err), saw: `threw: ${err && err.message}`, expected: 'no exception' });
  }
  if (sample) failures.push(...sample.failures);
}

/* ------------------------------------------------------------- the report */

const counts = { [APPLICATION]: failures.filter((f) => f.class === APPLICATION).length, [UPSTREAM]: failures.filter((f) => f.class === UPSTREAM).length };
const exitCode = counts[APPLICATION] ? 1 : counts[UPSTREAM] ? 2 : 0;
const verdict = exitCode === 0 ? 'OK' : exitCode === 1 ? `PROBLEM (${APPLICATION})` : `PROBLEM (${UPSTREAM} only)`;

function coverageLine(s) {
  const ms = s.managers.filter((m) => m.path);
  const ft = {};
  for (const m of ms) { const k = m.path.tags[0].replace(' FT', ''); ft[k] = (ft[k] || 0) + 1; }
  const count = (key) => ms.filter((m) => (Array.isArray(m.path[key]) ? m.path[key].length : m.path[key])).length;
  const playedKinds = {};
  for (const m of ms) for (const c of m.path.played) playedKinds[c] = (playedKinds[c] || 0) + 1;
  const chips = ms.filter((m) => m.path.planChip).map((m) => m.path.planChip);
  return `free transfers held ${Object.keys(ft).sort().map((k) => `${k}:${ft[k]}`).join(' ') || 'none'} | `
    + `just played a chip ${count('played') ? Object.entries(playedKinds).map(([k, v]) => `${k}:${v}`).join(' ') : 0} | `
    + `Free Hit revert ${count('revert')} | late joiners ${count('late')} | took hits ${count('hits')} | `
    + `history lag ${count('lag')} | plan takes a hit ${count('planHit')} | plan plays a chip ${chips.length ? chips.join(' ') : 0}`;
}

if (flag('json')) {
  console.log(JSON.stringify({
    reading: result.reading, checks: result.checks, readiness: result.readiness, blocked: result.blocked,
    failures, counts, exitCode,
    sample: sample && { slot: sample.slot, requested: sample.requested, pages: sample.pages, requests: sample.requests, budget: sample.budget,
      skipped: sample.skipped, managers: sample.managers.map((m) => ({ origin: m.origin, rank: m.rank, path: m.path && m.path.tags, seconds: m.seconds, failed: m.checks.filter((c) => !c.ok) })) },
  }, null, 2));
} else {
  const lines = result.lines;
  const cut = lines.lastIndexOf('');
  for (const line of lines.slice(0, cut)) console.log(line);
}

if (flag('record')) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify(result.reading, null, 2));
  if (!flag('json')) console.log(`\nrecorded to ${BASELINE_FILE}`);
}

const SAVE_DIR = arg('save-failures');
if (sample && SAVE_DIR) {
  for (const m of sample.managers) if (m.checks.some((c) => !c.ok)) saveFailure(SAVE_DIR, m.payload);
}

const managerLine = (m, i) => {
  const bad = m.checks.filter((c) => !c.ok);
  return `${bad.length ? 'FAIL' : 'ok  '}  #${String(i + 1).padEnd(2)} ${m.origin.padEnd(11)} ${fmtRank(m.rank).padEnd(12)} ${m.path ? m.path.tags.join(', ') : 'not read'}`
    + `${m.seconds !== null ? `   (${m.seconds.toFixed(1)}s)` : ''}${bad.length ? `   team ${m.id}` : ''}`;
};

if (!flag('json')) {
  if (sample) {
    console.log('');
    console.log(`sample          slot ${sample.slot}   ${sample.requested} asked   standings pages ${sample.pages.join(', ')} of the overall league   ${sample.managers.length} checked`);
    sample.managers.forEach((m, i) => {
      console.log(`  ${managerLine(m, i)}`);
      for (const c of m.checks.filter((x) => !x.ok)) console.log(`          FAIL ${c.name}: saw ${c.saw}, expected ${c.expected}`);
    });
    for (const s of sample.skipped) console.log(`  skip  ${s.origin}: ${s.why}`);
    console.log(`coverage        ${coverageLine(sample)}`);
    console.log(`requests        ${sample.requests} to FPL for the sample, ${requests} in all (bounded at ${sample.budget} for the sample), at least ${gapMs / 1000}s apart`);
  }
  console.log('');
  console.log(`failures        application ${counts[APPLICATION]}   upstream ${counts[UPSTREAM]}`);
  if (exitCode === 0) {
    for (const line of result.lines.slice(result.lines.lastIndexOf('') + 1)) console.log(line);
    if (sample) console.log(`OK: all ${sample.managers.length} sampled managers hold every check.`);
  } else {
    console.log(`${verdict}: ${failures.length} check${failures.length === 1 ? '' : 's'} failed`);
    for (const f of failures) console.log(`  - [${f.class}] ${f.name}: saw ${f.saw}, expected ${f.expected}`);
  }
}

const md = [`### FPL health probe: ${verdict}`, '', `Application failures: **${counts[APPLICATION]}**, upstream failures: **${counts[UPSTREAM]}**.`];
if (exitCode === 2) md.push('', 'Upstream only: FPL could not be read, nothing says the planner is wrong. Re-run later; a repeat means FPL is refusing this runner.');
if (failures.length) {
  md.push('', '| Class | Failed check | Saw |', '| --- | --- | --- |');
  for (const f of failures) md.push(`| ${f.class} | ${f.name.replace(/\|/g, '/')} | ${String(f.saw).replace(/\|/g, '/').slice(0, 300)} |`);
}
if (sample) {
  md.push('', `**Sample** (slot ${sample.slot}): ${sample.managers.length} of ${sample.requested} managers checked, ${sample.requests} requests to FPL.`, '',
    '| # | From | Rank | Path | Result |', '| --- | --- | --- | --- | --- |');
  sample.managers.forEach((m, i) => {
    const bad = m.checks.filter((c) => !c.ok);
    md.push(`| ${i + 1} | ${m.origin} | ${fmtRank(m.rank)} | ${m.path ? m.path.tags.join(', ') : 'not read'} | ${bad.length ? `FAIL (team ${m.id})` : 'ok'} |`);
  });
  md.push('', `Coverage: ${coverageLine(sample)}`);
}
summary(md);
process.exit(exitCode);
