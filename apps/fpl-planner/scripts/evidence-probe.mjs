// What the app makes of the live payload, right now.
//
// The one input the app cannot observe before the season turns over is WHICH
// SEASON `bootstrap-static.elements` describes, and the failure it causes is
// silent: every projection stays finite and every probability stays inside
// [0,1] while the numbers underneath are wrong by a factor. This prints the
// classification and the two quantities that show whether it landed, so a human
// checking the app around the first deadline can read what it decided instead
// of inferring it from a recommendation.
//
//   node apps/fpl-planner/scripts/evidence-probe.mjs
//   node apps/fpl-planner/scripts/evidence-probe.mjs --bootstrap /tmp/gw1/bootstrap-before.json \
//                                                    --fixtures  /tmp/gw1/fixtures-before.json
//
// With no arguments it reads the live proxy. With files it reads a captured
// pair, which is how a payload saved during GW1 is diagnosed afterwards.

import { readFileSync } from 'node:fs';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { goalkeeperPositionId } from '../js/engine/validate.js';

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

const bootstrap = await read('bootstrap-static', arg('bootstrap'));
const fixtures = await read('fixtures', arg('fixtures'));
const gameState = buildGameState(bootstrap, fixtures, { fetchedAt: new Date().toISOString() });
const rules = gameState.rules;

const evidence = seasonEvidence(gameState);
const finished = gameState.fixtures.filter(f => f.finished).length;
const totalStarts = [...gameState.players.values()].reduce((s, p) => s + (p.starts || 0), 0);

console.log(`season          ${rules.season}`);
console.log(`players         ${gameState.players.size}`);
console.log(`fixtures played ${finished}`);
// Eleven starters for each of two clubs in every fixture: the arithmetic of the
// sport, and the cheapest way to see whether these totals belong to a season
// that has been played.
console.log(`sum(starts)     ${totalStarts}   (a fully played season is ${gameState.fixtures.length * 22})`);
console.log(`current / next  ${gameState.currentEvent ?? '-'} / ${gameState.nextEvent ?? '-'}   seasonStarted=${gameState.seasonStarted}`);
console.log('');
console.log(`evidence        ${evidence.kind}   usable=${evidence.usable}`);
console.log(`denominator     ${evidence.teamMatches} gameweeks   (finished: ${evidence.finishedMatches})`);
if (evidence.message) console.log(`note            ${evidence.message}`);

if (!evidence.usable) {
  console.log('\nThe app withholds the plan in this state, which is the designed behaviour.');
  process.exit(0);
}

// The two quantities that show whether the classification landed.
const gw = gameState.nextEvent ?? gameState.currentEvent ?? 1;
const strength = buildStrength(gameState, { asOfGw: gw });
const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
const pool = [...gameState.players.values()]
  .sort((a, b) => b.selectedByPercent - a.selectedByPercent)
  .slice(0, 260);
const ps = [];
for (const p of pool) {
  const row = projections.get(p.id, gw);
  if (row && Number.isFinite(row.pStart)) ps.push(row.pStart);
}
ps.sort((a, b) => a - b);
const median = ps[Math.floor(ps.length / 2)];
const pinned = ps.filter(v => v >= 0.9999).length;

console.log('');
console.log(`start rate      median ${median.toFixed(3)}   pinned at 1.000: ${pinned}/${ps.length}`);
console.log(`                expected: median 0.3-0.95, pinned 0`);

const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState, gw });
const plan = await buildPlan({ gameState, squadState, options: { horizon: 3 } });
const captain = gameState.players.get(plan.current.captain);
const gkId = goalkeeperPositionId(rules);
console.log('');
console.log(`opening plan    ${plan.current.xPointsGw.toFixed(1)} xP for GW${plan.current.gw}   captain ${captain.webName} (${rules.positions[captain.position].short})`);
console.log(`                expected: 30-100 xP, captain not a goalkeeper`);

const bad = [];
if (!(median > 0.3 && median < 0.95)) bad.push(`median start rate ${median.toFixed(3)} is outside 0.3-0.95`);
if (pinned > 0) bad.push(`${pinned} start rates pinned at 1.000`);
if (!(plan.current.xPointsGw > 30 && plan.current.xPointsGw < 100)) bad.push(`gameweek projection ${plan.current.xPointsGw.toFixed(1)} is implausible`);
if (captain.position === gkId) bad.push('the captain is a goalkeeper, which means outfield projections have collapsed');

console.log('');
if (bad.length) {
  console.log('PROBLEM');
  for (const b of bad) console.log(`  - ${b}`);
  process.exit(1);
}
console.log('OK: the payload was read the way it should be.');
