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
// The payload is resolved exactly as app.js resolves it for a first-time
// visitor (engine/world.js with the shipped data/opening-baseline.json), so the
// projections judged here are the ones the app shows. Until 2026-09-16 the probe
// projected the bare payload, which stopped describing the app the day the
// previous season became a prior for the whole season.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan, projectionRowsFor } from '../js/engine/planner.js';
import { openingBaselineApplies, resolveGameState } from '../js/engine/world.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { goalkeeperPositionId } from '../js/engine/validate.js';
import { gameweekLifecycle } from '../js/engine/lifecycle.js';
import { assessBaseline } from '../js/engine/baseline.js';
import { validatePlan } from '../js/engine/validate.js';
import { assertShape, USER_AGENT, FPL_API } from './lib/archive.mjs';
import { spearman } from './lib/archive-scorecard.mjs';
import {
  assessReadiness, projectionVitals, MIN_EVER_PRESENT_START_MEDIAN, MAX_APPEARANCE_INVERSION_SHARE,
  MIN_GROUP_FOR_MINUTES_CHECKS,
} from '../js/engine/readiness.js';

const PROXY = 'https://shevato.com/.netlify/functions/fpl?path=';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};

const DIRECT = process.argv.includes('--direct');
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
// One minute past a deadline FPL still names that gameweek as next; it flips
// within minutes. A next deadline more than this far in the past is stale.
const DEADLINE_GRACE_HOURS = 3;
// Spearman between the engine's gameweek projection and FPL's own ep_next over
// every player with a fixture. Measured 0.835 over all 667 players (0.764 over
// the 421 with minutes) on the live payload before the 2026/27 GW6 deadline
// (2026-10-09, 12h out). Scrambling the projection of a random 10% of the pool
// read 0.765, 25% read 0.603, half 0.377, all of it -0.008. The floor is a
// tripwire for a pipeline that has lost track of WHO is good (a mis-joined id,
// a shuffled column, a minutes model gone wrong), not a quality bar. It cannot
// see a level fault: an order-preserving compression keeps every rank, which
// is what the best-eleven and top-median invariants above are for.
const MIN_EP_NEXT_SPEARMAN = 0.6;

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(HERE, '..', '.data', 'probe-baseline.json');
const flag = (name) => process.argv.includes(`--${name}`);

// The last recorded reading, used for change detection. Absent on a first run,
// which is not a failure: the invariants that need it simply do not apply.
const prev = existsSync(BASELINE_FILE)
  ? (() => { try { return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; } })()
  : null;

const bootstrap = await read('bootstrap-static', arg('bootstrap'));
const fixtures = await read('fixtures', arg('fixtures'));
const fetchedAt = new Date().toISOString();

// Shape first: everything below assumes it, and a payload without these arrays
// is an error page in disguise, which must fail as itself rather than as a
// TypeError three functions deep.
const shapeFailures = [];
for (const [name, body] of [['bootstrap', bootstrap], ['fixtures', fixtures]]) {
  try { assertShape(name, body); } catch (err) { shapeFailures.push(err.message); }
}
if (shapeFailures.length) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checks: [{ name: 'the payloads have the shape the app reads', ok: false, saw: shapeFailures, expected: 'bootstrap and fixtures arrays' }] }, null, 2));
    process.exit(1);
  }
  console.log(`FAIL  the payloads have the shape the app reads\n        ${shapeFailures.join('\n        ')}`);
  console.log(`\nPROBLEM: ${shapeFailures.length} payload shape failure${shapeFailures.length === 1 ? '' : 's'}`);
  process.exit(1);
}
const first = buildGameState(bootstrap, fixtures, { fetchedAt });
const shipped = openingBaselineApplies(first)
  ? JSON.parse(readFileSync(join(HERE, '..', 'data', 'opening-baseline.json'), 'utf8'))
  : null;
const { gameState, resolution } = resolveGameState(first, { bootstrap, fixtures, fetchedAt, kept: null, shipped });
const rules = gameState.rules;

const evidence = seasonEvidence(gameState);
const lifecycle = gameweekLifecycle(gameState);
// The payload's own completeness, before any prior is attached.
const baseline = assessBaseline(first);
const gw = lifecycle.planGw ?? gameState.nextEvent ?? gameState.currentEvent ?? 1;

/* ------------------------------------------------------------ the reading */

// Everything the invariants are judged on, gathered once so the printed report
// and the recorded baseline cannot describe different runs.
const reading = {
  at: new Date().toISOString(),
  season: rules.season,
  pool: gameState.players.size,
  phase: lifecycle.phase,
  gw,
  clubsPlayed: lifecycle.clubsPlayed,
  clubsTotal: lifecycle.clubsTotal,
  evidenceKind: evidence.kind,
  evidenceUsable: evidence.usable,
  prior: resolution && resolution.snapshot ? `${resolution.origin} (${resolution.source})` : null,
  denominator: evidence.teamMatches,
  activeShare: baseline.activeShare,
  startsPerActive: baseline.startsPerActive,
  baselineComplete: baseline.complete,
  finishedGameweeks: gameState.events.filter(e => e.finished).length,
};

let vitals = null;
let captainPosition = null;
let medianStart = null;
let pinnedHigh = null;

let projectionError = null;
let unprojected = null;
let epSpearman = null;
let epCompared = 0;
let planVerdict = null;
let planSeconds = null;
let projections = null;

if (evidence.usable) {
  try {
    const strength = buildStrength(gameState, { asOfGw: gw });
    projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
  } catch (err) {
    projectionError = err && err.message ? err.message : String(err);
  }
  if (projections) {
    // Every player in the pool gets a row, finite and non-negative, blank
    // gameweeks included (a blank is 0, not a missing row).
    unprojected = [];
    for (const p of gameState.players.values()) {
      const row = projections.get(p.id, gw);
      if (!row || !Number.isFinite(row.xPoints) || row.xPoints < 0) unprojected.push(p.webName || p.id);
    }
    // FPL's ep_next is for its own next event; compare only when that is the
    // gameweek being planned.
    const nextId = (bootstrap.events.find((e) => e.is_next) || {}).id;
    if (nextId === gw) {
      const ep = new Map(bootstrap.elements.map((e) => [e.id, Number(e.ep_next)]));
      const xs = []; const ys = [];
      for (const [id, list] of projections.byPlayer) {
        const r = list.find((x) => x.gw === gw);
        if (!r || !r.fixtures.length || !Number.isFinite(ep.get(id))) continue;
        xs.push(r.xPoints); ys.push(ep.get(id));
      }
      epCompared = xs.length;
      epSpearman = spearman(xs, ys);
    }
  }
}
reading.epNextSpearman = epSpearman;

if (evidence.usable && projections) {
  vitals = projectionVitals(projectionRowsFor(projections, gw, gameState));

  const owned = [...gameState.players.values()]
    .sort((a, b) => b.selectedByPercent - a.selectedByPercent)
    .slice(0, 260);
  const ps = [];
  for (const p of owned) {
    const row = projections.get(p.id, gw);
    if (row && Number.isFinite(row.pStart)) ps.push(row.pStart);
  }
  ps.sort((a, b) => a - b);
  medianStart = ps.length ? ps[Math.floor(ps.length / 2)] : null;
  pinnedHigh = ps.filter(v => v >= 0.9999).length;

  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState, gw });
  const t0 = process.hrtime.bigint();
  const plan = await buildPlan({ gameState, squadState, options: { horizon: 3 } });
  planSeconds = Number(process.hrtime.bigint() - t0) / 1e9;
  planVerdict = validatePlan(plan.current, squadState, gameState, rules);
  const captain = gameState.players.get(plan.current.captain);
  captainPosition = captain ? captain.position : null;
  reading.planXp = plan.current.xPointsGw;
  reading.captain = captain ? captain.webName : null;
  reading.chip = plan.current.chip || 'hold';
  reading.transfers = (plan.current.transfersOut || []).length;
}

reading.best11 = vitals && !vitals.empty ? vitals.best11 : null;
reading.topMedianGap = vitals && !vitals.empty ? vitals.topMedianGap : null;
reading.everPresent = vitals && !vitals.empty ? vitals.everPresentCount : null;
reading.everPresentStartMedian = vitals && !vitals.empty ? vitals.everPresentStartMedian : null;
reading.appearanceInversionShare = vitals && !vitals.empty ? vitals.appearanceInversionShare : null;
reading.medianStart = medianStart;
reading.pinnedHigh = pinnedHigh;

const readiness = assessReadiness({
  evidence, lifecycle, vitals,
  baseline: { source: gameState.baselineSource, rates: gameState.baselineRates },
});
reading.readiness = readiness.level;

/* --------------------------------------------------------- the invariants */

// Each one is a claim about football or about the pipeline, named so a failure
// says WHICH claim broke rather than that a number left a range.
const checks = [];
const check = (name, ok, saw, expected, { skip = false } = {}) => {
  checks.push({ name, ok: skip ? null : !!ok, saw, expected });
};

check('season identity is stable',
  !prev || prev.season === reading.season,
  reading.season, prev ? `unchanged from ${prev.season}` : 'no prior reading');

check('the pool is a whole league',
  reading.pool > 300,
  `${reading.pool} players`, 'more than 300');

// A payload that is not a complete season in its own right may still be
// projected from once this season has enough matches of its own, which is
// exactly what `current-season` means: seasonEvidence returns it only for a
// complete payload or once every club has played three matches. Until
// 2026-09-13 this check failed on every healthy in-season payload from the day
// the baseline retired, so the probe was red whether the pipeline was broken or
// not, and a red that never turns green is not a signal.
check('the totals describe a season, or are refused',
  reading.baselineComplete || !reading.evidenceUsable || reading.evidenceKind === 'current-season',
  `complete=${reading.baselineComplete} usable=${reading.evidenceUsable} kind=${reading.evidenceKind}`,
  'an incomplete payload is refused unless this season has enough matches of its own');

// Once a gameweek has finished the totals cannot be last season's: FPL clears
// them when GW1 goes current, and the probe builds its game state without a
// baseline, so nothing can have put the payload into that shape on purpose.
// This is the reading that was wrong in every match window of GW4 of 2026/27.
check('an in-season payload is not read as last season',
  !(reading.finishedGameweeks > 0 && reading.evidenceKind === 'previous-season'),
  `${reading.evidenceKind} with ${reading.finishedGameweeks} finished gameweeks`,
  'previous-season only before the first gameweek has finished');

check('the start-rate denominator matches the season the totals belong to',
  reading.evidenceKind !== 'previous-season' || reading.denominator === rules.totalEvents,
  `${reading.evidenceKind} over ${reading.denominator}`,
  `previous-season totals read over ${rules.totalEvents}`);

if (evidence.usable) {
  check('start rates keep a real spread',
    medianStart !== null && medianStart > 0.25 && medianStart < 0.95,
    medianStart === null ? 'none' : medianStart.toFixed(3), 'median between 0.25 and 0.95');

  check('no player is a certain starter on thin evidence',
    pinnedHigh === 0 || reading.denominator > 5,
    `${pinnedHigh} pinned at 1.000 over ${reading.denominator} matches`,
    'nothing pinned while the denominator is tiny');

  check('the projection pool has not collapsed',
    vitals && vitals.topMedianGap >= 1.0,
    vitals ? vitals.topMedianGap.toFixed(2) : 'n/a', 'best minus median at least 1.0');

  check('a legal eleven scores like a football team',
    vitals && vitals.best11 > 30 && vitals.best11 < 100,
    vitals ? vitals.best11.toFixed(1) : 'n/a', 'between 30 and 100');

  // The 2026-09-16 audit's two findings, which no aggregate above could see:
  // regulars read as rotation risks, and read as less likely to play than
  // substitutes. They only apply once clubs have played twice and the groups
  // are big enough to have a median (readiness.js).
  const minutesJudged = vitals && vitals.everPresentCount >= MIN_GROUP_FOR_MINUTES_CHECKS;
  check('players who have started every match are read as starters',
    !minutesJudged || vitals.everPresentStartMedian >= MIN_EVER_PRESENT_START_MEDIAN,
    minutesJudged ? `median ${vitals.everPresentStartMedian.toFixed(3)} over ${vitals.everPresentCount}` : 'n/a',
    `median start probability at least ${MIN_EVER_PRESENT_START_MEDIAN}`, { skip: !minutesJudged });
  check('nobody who starts every match is less likely to play than a substitute',
    !minutesJudged || !(vitals.appearanceInversionShare >= MAX_APPEARANCE_INVERSION_SHARE),
    minutesJudged && vitals.appearanceInversionShare !== null ? `${(vitals.appearanceInversionShare * 100).toFixed(0)}% below the bench median` : 'n/a',
    `under ${MAX_APPEARANCE_INVERSION_SHARE * 100}%`, { skip: !minutesJudged || vitals.appearanceInversionShare === null });

  check('the captain is not a goalkeeper',
    captainPosition !== goalkeeperPositionId(rules),
    reading.captain, 'an outfield player');

  // THE ONE THE OLD PROBE COULD NOT MAKE. A projection that moves a long way
  // without the football moving is the signature of a pipeline fault, and it is
  // invisible to any absolute threshold.
  if (prev && Number.isFinite(prev.best11) && Number.isFinite(reading.best11)) {
    const drift = Math.abs(reading.best11 - prev.best11) / Math.max(1, prev.best11);
    const explained = prev.evidenceKind !== reading.evidenceKind || prev.season !== reading.season;
    check('the best eleven has not moved without a reason',
      drift < 0.25 || explained,
      `${prev.best11.toFixed(1)} -> ${reading.best11.toFixed(1)} (${(drift * 100).toFixed(0)}%)`,
      'less than 25% between readings, unless the classification changed');
  }
}

/* ------------------------------------------- freshness and the pipeline */

const nowIso = arg('now') || (SOURCE === 'files' ? null : fetchedAt);
const nextEvent = bootstrap.events.find((e) => e.is_next) || null;
if (nowIso) {
  const lagHours = nextEvent ? (Date.parse(nowIso) - Date.parse(nextEvent.deadline_time)) / 3600e3 : null;
  check('the next deadline is in the future',
    !nextEvent ? bootstrap.events.every((e) => e.finished) : lagHours < DEADLINE_GRACE_HOURS,
    nextEvent ? `GW${nextEvent.id} deadline ${nextEvent.deadline_time}` : 'no next event',
    `after ${nowIso}, or under ${DEADLINE_GRACE_HOURS}h past it while FPL rolls over`);
}
// A postponed match leaves its gameweek with event null, so it never appears
// here; anything that does is a fixture list older than the bootstrap.
const finishedIds = new Set(bootstrap.events.filter((e) => e.finished).map((e) => e.id));
const unplayed = fixtures.filter((f) => finishedIds.has(f.event) && !f.finished && !f.finished_provisional);
check('every fixture of a finished gameweek has been played',
  unplayed.length === 0,
  unplayed.length ? `${unplayed.length} unplayed, first ${unplayed[0].id} in GW${unplayed[0].event}` : 'all played',
  'the fixture list agrees with the events (postponed matches carry no gameweek)');

if (evidence.usable) {
  check('projections build for every player',
    !projectionError && unprojected && unprojected.length === 0,
    projectionError ? `threw: ${projectionError}` : `${unprojected.length} without a finite row${unprojected.length ? ` (${unprojected.slice(0, 5).join(', ')})` : ''}`,
    `a finite, non-negative GW${gw} projection for all ${reading.pool}`);
  check("the projections rank-correlate with FPL's ep_next",
    epSpearman === null || epSpearman >= MIN_EP_NEXT_SPEARMAN,
    epSpearman === null ? 'n/a' : `Spearman ${epSpearman.toFixed(3)} over ${epCompared}`,
    `at least ${MIN_EP_NEXT_SPEARMAN}`, { skip: epSpearman === null });
  if (planVerdict) {
    check('the plan for a built squad passes validatePlan',
      planVerdict.ok,
      planVerdict.ok ? `valid, built in ${planSeconds.toFixed(1)}s` : planVerdict.violations.map((v) => v.code).join(', '),
      'no violations');
  }
}

// The proxy's own promises (README, "The data layer"): browsers never cache
// it, a stale copy says so, and a fresh copy is minutes old, not hours.
if (SOURCE === 'proxy') {
  for (const [name, h] of Object.entries(responses)) {
    const age = Number(h.get('x-fpl-age-seconds')) + (Number(h.get('age')) || 0);
    const cc = String(h.get('cache-control') || '');
    check(`the proxy serves ${name} fresh and uncached by browsers`,
      cc.includes('no-store') && h.get('x-fpl-stale') !== 'true' && Number.isFinite(age) && age < 3600,
      `cache-control "${cc}", stale ${h.get('x-fpl-stale')}, age ${age}s`,
      'no-store, not stale, under an hour old');
  }
}

check('the readiness ladder agrees with the evidence',
  !(readiness.allow.chips && !evidence.usable),
  `${readiness.level}`, 'a chip is never licensed on unusable evidence');

/* -------------------------------------------------------------- reporting */

if (flag('json')) {
  console.log(JSON.stringify({ reading, checks, readiness: readiness.level, blocked: readiness.blocked }, null, 2));
} else {
  console.log(`season          ${rules.season}`);
  console.log(`players         ${reading.pool}`);
  console.log(`lifecycle       ${lifecycle.phase}   gw ${lifecycle.gw} -> planning ${gw}   clubs played ${lifecycle.clubsPlayed}/${lifecycle.clubsTotal}`);
  console.log(`evidence        ${evidence.kind}   usable=${evidence.usable}   denominator ${evidence.teamMatches}   prior ${reading.prior || 'none'}`);
  console.log(`baseline        complete=${baseline.complete}   ${baseline.active}/${baseline.pool} with minutes (${(baseline.activeShare * 100).toFixed(1)}%)   ${baseline.startsPerActive.toFixed(1)} starts each`);
  if (evidence.message) console.log(`note            ${evidence.message}`);
  console.log(`readiness       ${readiness.level}   display=${readiness.allow.display} lineup=${readiness.allow.lineup} transfers=${readiness.allow.transfers} chips=${readiness.allow.chips}`);
  for (const b of readiness.blocked) console.log(`                blocked ${b.code} (ceiling ${b.ceiling})`);
  if (evidence.usable) {
    console.log(`plan            ${reading.planXp.toFixed(1)} xP for GW${gw}   captain ${reading.captain}   chip ${reading.chip}   transfers ${reading.transfers}   built in ${planSeconds.toFixed(1)}s`);
    if (epSpearman !== null) console.log(`ep_next         Spearman ${epSpearman.toFixed(3)} over ${epCompared} players with a GW${gw} fixture`);
    console.log(`pool            best-11 ${reading.best11.toFixed(1)}   top-median gap ${reading.topMedianGap.toFixed(2)}   median start ${medianStart.toFixed(3)}   pinned ${pinnedHigh}`);
    if (reading.everPresent) {
      const share = reading.appearanceInversionShare;
      console.log(`regulars        ${reading.everPresent} started every match   median start ${reading.everPresentStartMedian.toFixed(3)}   below bench appearance ${share === null ? 'n/a' : `${(share * 100).toFixed(0)}%`}`);
    }
  }
  console.log('');
  for (const c of checks) {
    if (c.ok === null) continue;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!c.ok) console.log(`        saw ${c.saw}, expected ${c.expected}`);
  }
}

if (flag('record')) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify(reading, null, 2));
  if (!flag('json')) console.log(`\nrecorded to ${BASELINE_FILE}`);
}

const failed = checks.filter(c => c.ok === false);
if (!flag('json')) {
  console.log('');
  if (failed.length) {
    console.log(`PROBLEM: ${failed.length} invariant${failed.length === 1 ? '' : 's'} failed`);
    for (const f of failed) console.log(`  - ${f.name}: saw ${f.saw}, expected ${f.expected}`);
  } else if (!evidence.usable) {
    console.log('OK: the payload is refused, which is the designed behaviour, and every invariant that applies holds.');
  } else {
    console.log('OK: every invariant holds.');
  }
}
process.exit(failed.length ? 1 : 0);
