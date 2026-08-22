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
//
// With no arguments it reads the live proxy. With files it reads a captured
// pair, which is how a payload saved during a gameweek is diagnosed afterwards.
// `--record` writes the reading to .data/probe-baseline.json so the next run
// can compare against it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { goalkeeperPositionId } from '../js/engine/validate.js';
import { gameweekLifecycle } from '../js/engine/lifecycle.js';
import { assessBaseline } from '../js/engine/baseline.js';
import { assessReadiness, projectionVitals } from '../js/engine/readiness.js';

const PROXY = 'https://shevato.com/.netlify/functions/fpl?path=';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};

async function read(name, file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(PROXY + encodeURIComponent(name), {
    headers: { Origin: 'https://shevato.com', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

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
const gameState = buildGameState(bootstrap, fixtures, { fetchedAt: new Date().toISOString() });
const rules = gameState.rules;

const evidence = seasonEvidence(gameState);
const lifecycle = gameweekLifecycle(gameState);
const baseline = assessBaseline(gameState);
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
  denominator: evidence.teamMatches,
  activeShare: baseline.activeShare,
  startsPerActive: baseline.startsPerActive,
  baselineComplete: baseline.complete,
};

let vitals = null;
let captainPosition = null;
let medianStart = null;
let pinnedHigh = null;

if (evidence.usable) {
  const strength = buildStrength(gameState, { asOfGw: gw });
  const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
  const rows = [];
  for (const [, list] of projections.byPlayer) {
    const row = list.find(r => r.gw === gw);
    if (row) rows.push(row);
  }
  vitals = projectionVitals(rows);

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
  const plan = await buildPlan({ gameState, squadState, options: { horizon: 3 } });
  const captain = gameState.players.get(plan.current.captain);
  captainPosition = captain ? captain.position : null;
  reading.planXp = plan.current.xPointsGw;
  reading.captain = captain ? captain.webName : null;
  reading.chip = plan.current.chip || 'hold';
  reading.transfers = (plan.current.transfersOut || []).length;
}

reading.best11 = vitals && !vitals.empty ? vitals.best11 : null;
reading.topMedianGap = vitals && !vitals.empty ? vitals.topMedianGap : null;
reading.medianStart = medianStart;
reading.pinnedHigh = pinnedHigh;

const readiness = assessReadiness({
  evidence, lifecycle, vitals,
  baseline: { source: gameState.baselineSource },
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

check('the totals describe a season, or are refused',
  reading.baselineComplete || !reading.evidenceUsable,
  `complete=${reading.baselineComplete} usable=${reading.evidenceUsable}`,
  'an incomplete payload must not be projected from');

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
  console.log(`evidence        ${evidence.kind}   usable=${evidence.usable}   denominator ${evidence.teamMatches}`);
  console.log(`baseline        complete=${baseline.complete}   ${baseline.active}/${baseline.pool} with minutes (${(baseline.activeShare * 100).toFixed(1)}%)   ${baseline.startsPerActive.toFixed(1)} starts each`);
  if (evidence.message) console.log(`note            ${evidence.message}`);
  console.log(`readiness       ${readiness.level}   display=${readiness.allow.display} lineup=${readiness.allow.lineup} transfers=${readiness.allow.transfers} chips=${readiness.allow.chips}`);
  for (const b of readiness.blocked) console.log(`                blocked ${b.code} (ceiling ${b.ceiling})`);
  if (evidence.usable) {
    console.log(`plan            ${reading.planXp.toFixed(1)} xP for GW${gw}   captain ${reading.captain}   chip ${reading.chip}   transfers ${reading.transfers}`);
    console.log(`pool            best-11 ${reading.best11.toFixed(1)}   top-median gap ${reading.topMedianGap.toFixed(2)}   median start ${medianStart.toFixed(3)}   pinned ${pinnedHigh}`);
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
