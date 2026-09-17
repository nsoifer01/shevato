#!/usr/bin/env node
// CALIBRATION OF THE PROJECTIONS, deadline by deadline, in the production regime.
//
// WHY THIS EXISTS
//
// Planner points are what decide an experiment (experiments/registry.md), but
// points cannot tell you that every nailed starter is projected to play 70% of
// the time, or that the best player in the league projects 3.9. The xP audit of
// 2026-09-16 found exactly that in production while every test was green,
// because nothing compared a projection with what then happened at the level a
// manager reads it: this player, this gameweek.
//
// This script replays each season's deadlines through the SAME resolution the
// app runs (`productionGameStateAt`: the payloads production would have read,
// the shipped previous-season asset, engine/world.js), projects every player
// for that gameweek, and scores the projections against the gameweek's actual
// rows. Nothing is fitted here and nothing is tuned against it; it is the
// instrument that says whether the projections describe football.
//
// Usage:
//   node apps/fpl-planner/scripts/calibration-report.mjs
//   node apps/fpl-planner/scripts/calibration-report.mjs --seasons 2024-25,2025-26 --gw 1-12
//   node apps/fpl-planner/scripts/calibration-report.mjs --json out.json
//   node apps/fpl-planner/scripts/calibration-report.mjs --check
//
// --check applies the calibration bands (scripts/lib/calibration-guard.mjs, the
// same bands tests/xp-calibration-guard.test.mjs holds the captured 2026/27
// deadlines to) to every season's gameweek buckets separately, prints each band
// a bucket breaks, and exits 1 if any bucket from gameweek 2 on does. It is the
// archive-wide form of the hermetic test: run it after any change to the
// minutes, rates, strength or resolution code.
//
// Gameweek 1 is printed and never gated. It is one deadline, and the archive
// carries no injury or availability flags, which is what separates the bottom
// of a pre-season pool in production: in the replay the bottom fifth projects
// about 0.43 points above what it scores under the shipped model and the
// repaired one alike.
//
// Seasons without a downloaded predecessor are skipped: production always has
// one (the shipped opening baseline), so a replay without it is not production.

import fs from 'node:fs';
import { loadSeason, loadRules, previousSeason, KNOWN_SEASONS } from './backtest.mjs';
import {
  createAccumulator, productionGameStateAt, priorSeasonAsset, preseasonTotalsFor, eventDeadlines,
} from '../js/engine/backtest.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { matchesKickedOffByClub } from '../js/engine/lifecycle.js';
import { bestEleven, calibrationFacts, calibrationViolations } from './lib/calibration-guard.mjs';

const POSITION = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const BUCKETS = [[1, 1], [2, 3], [4, 8], [9, 19], [20, 38]];

function parseArgs(argv) {
  const out = { seasons: null, gwFrom: 1, gwTo: 38, json: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seasons') out.seasons = argv[++i].split(',');
    else if (a === '--gw') {
      const [from, to] = argv[++i].split('-').map(Number);
      out.gwFrom = from;
      out.gwTo = to || from;
    } else if (a === '--json') out.json = argv[++i];
    else if (a === '--check') out.check = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const quantile = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];

const COMPONENTS = ['appearance', 'goals', 'assists', 'cleanSheets', 'conceded', 'saves', 'penaltySaves', 'defcon', 'bonus', 'cards'];

// The points a player actually scored in one archive row, split into the same
// components the projection reports, from the rules the season was scored
// under. Penalty misses and own goals are not projected and land in `other`.
function actualComponents(row, position, rules) {
  const pts = (key) => {
    const v = rules.scoring[key];
    if (v === undefined || v === null) return 0;
    return typeof v === 'number' ? v : (typeof v[position] === 'number' ? v[position] : 0);
  };
  const out = Object.fromEntries(COMPONENTS.map(k => [k, 0]));
  if (row.minutes > 0) out.appearance = row.minutes >= 60 ? pts('long_play') : pts('short_play');
  out.goals = row.goalsScored * pts('goals_scored');
  out.assists = row.assists * pts('assists');
  out.cleanSheets = row.cleanSheets * pts('clean_sheets');
  out.conceded = Math.floor(row.goalsConceded / 2) * pts('goals_conceded');
  out.saves = Math.floor(row.saves / 3) * pts('saves');
  out.penaltySaves = row.penaltiesSaved * pts('penalties_saved');
  const threshold = rules.defConThresholds ? rules.defConThresholds[position] : undefined;
  const actions = position === 2 ? (row.cbit || 0) + (row.tackles || 0)
    : position === 3 || position === 4 ? (row.cbit || 0) + (row.recoveries || 0) + (row.tackles || 0) : 0;
  out.defcon = threshold && actions >= threshold ? pts('defensive_contribution') : 0;
  out.bonus = row.bonus * pts('bonus');
  out.cards = row.yellowCards * pts('yellow_cards') + row.redCards * pts('red_cards');
  out.other = row.penaltiesMissed * pts('penalties_missed') + row.ownGoals * pts('own_goals');
  return out;
}

// Spearman's rank correlation with tied values given their average rank, which
// matters here: most players score exactly 1 or 2 in a gameweek.
export function rankCorrelation(x, y) {
  const rank = (v) => {
    const idx = v.map((val, i) => [val, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let j = 0; j < idx.length;) {
      let e = j;
      while (e + 1 < idx.length && idx[e + 1][0] === idx[j][0]) e++;
      for (let t = j; t <= e; t++) r[idx[t][1]] = (j + e) / 2;
      j = e + 1;
    }
    return r;
  };
  if (x.length < 3) return NaN;
  const rx = rank(x);
  const ry = rank(y);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

// One row per player with a fixture this gameweek: what was projected and what
// happened. Actual points and minutes sum a double gameweek, as FPL scores it.
export function scoreDeadline({ dataset, gw, gameState, projections, rankable = null }) {
  const clubMatches = matchesKickedOffByClub(gameState);
  const actualByPlayer = dataset.byGw.get(gw) || new Map();
  const rows = [];
  for (const [id, list] of projections.byPlayer) {
    const r = list[0];
    if (!r || !r.fixtures || !r.fixtures.length) continue;
    const player = gameState.players.get(id);
    const actual = actualByPlayer.get(id) || [];
    const m = clubMatches.get(player.teamId) || 0;
    const components = Object.fromEntries([...COMPONENTS, 'other'].map(k => [k, 0]));
    for (const a of actual) {
      const c = actualComponents(a, player.position, gameState.rules);
      for (const k of Object.keys(components)) components[k] += c[k];
    }
    rows.push({
      projectedComponents: r.pointsBreakdown || null,
      actualComponents: components,
      // Anyone with minutes this season or last is a player a model has to rank.
      // Decided from the archive by the caller, never from a model's own
      // GameState, so two engines are ranked over the same players.
      rankable: rankable ? rankable.has(id) : player.minutes > 0,
      gw,
      id,
      position: player.position,
      fixtures: r.fixtures.length,
      xPoints: r.xPoints,
      pStart: r.pStart,
      pAppear: r.pAppear,
      xMins: r.xMins,
      points: actual.reduce((s, x) => s + x.totalPoints, 0),
      minutes: actual.reduce((s, x) => s + x.minutes, 0),
      started: actual.some(x => x.starts > 0) ? 1 : 0,
      appeared: actual.some(x => x.minutes > 0) ? 1 : 0,
      // Started every club match so far THIS season, read off the payload's own
      // current-season totals, which is what a manager calls nailed.
      everPresent: m > 0 && (player.seasonStarts || 0) >= m,
      clubMatches: m,
    });
  }
  return rows;
}

function logLoss(rows, key, outcome) {
  const eps = 1e-6;
  return mean(rows.map(r => {
    const p = Math.min(1 - eps, Math.max(eps, r[key]));
    return -(r[outcome] ? Math.log(p) : Math.log(1 - p));
  }));
}

export function summarize(rows, xiList) {
  const single = rows.filter(r => r.fixtures === 1);
  const ever = single.filter(r => r.everPresent);
  const pool = rows.filter(r => r.xPoints > 0.5).sort((a, b) => a.xPoints - b.xPoints);
  const q = Math.floor(pool.length / 5);
  const quint = (i) => pool.slice(i * q, i === 4 ? pool.length : (i + 1) * q);
  const likely = rows.filter(r => r.pStart > 0.5).map(r => r.xPoints).sort((a, b) => a - b);
  const group = (set) => ({
    n: set.length,
    pStart: mean(set.map(r => r.pStart)),
    started: mean(set.map(r => r.started)),
    pAppear: mean(set.map(r => r.pAppear)),
    appeared: mean(set.map(r => r.appeared)),
    xMins: mean(set.map(r => r.xMins)),
    minutes: mean(set.map(r => r.minutes)),
    xPoints: mean(set.map(r => r.xPoints)),
    points: mean(set.map(r => r.points)),
  });
  const calibration = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const set = single.filter(r => r.pStart >= lo && (i === 9 ? r.pStart <= 1 : r.pStart < hi));
    if (set.length) calibration.push({ bin: `${lo.toFixed(1)}-${hi.toFixed(1)}`, n: set.length, predicted: mean(set.map(r => r.pStart)), observed: mean(set.map(r => r.started)) });
  }
  const componentsFor = (set) => Object.fromEntries([...COMPONENTS, 'other'].map(k => [k, {
    projected: mean(set.map(r => (r.projectedComponents && Number.isFinite(r.projectedComponents[k]) ? r.projectedComponents[k] : 0))),
    actual: mean(set.map(r => r.actualComponents[k])),
  }]));
  // Rank correlation per deadline over a population fixed by the data, not by
  // either model (see `rankable`), then averaged.
  const byDeadline = new Map();
  for (const r of rows) {
    if (!r.rankable) continue;
    const key = `${r.season || ''}|${r.gw}`;
    if (!byDeadline.has(key)) byDeadline.set(key, []);
    byDeadline.get(key).push(r);
  }
  const correlations = [...byDeadline.values()]
    .map(set => rankCorrelation(set.map(r => r.xPoints), set.map(r => r.points)))
    .filter(Number.isFinite);
  const top = pool.length >= 5 ? quint(4) : [];
  return {
    players: rows.length,
    rankCorrelation: correlations.length ? mean(correlations) : NaN,
    components: {
      everPresent: componentsFor(ever),
      topQuintile: componentsFor(top),
      byPosition: Object.fromEntries([1, 2, 3, 4].map(p => [POSITION[p], componentsFor(single.filter(r => r.position === p && r.minutes > 0))])),
    },
    everPresent: group(ever),
    everPresentByPosition: Object.fromEntries([1, 2, 3, 4].map(p => [POSITION[p], group(ever.filter(r => r.position === p))])),
    rotation: group(single.filter(r => !r.everPresent && r.clubMatches > 0 && r.pStart > 0.05)),
    bottomQuintile: pool.length >= 5 ? group(quint(0)) : null,
    topQuintile: pool.length >= 5 ? group(quint(4)) : null,
    startCalibration: calibration,
    startLogLoss: logLoss(single, 'pStart', 'started'),
    appearLogLoss: logLoss(single, 'pAppear', 'appeared'),
    likelyStarters: likely.length
      ? { n: likely.length, p10: quantile(likely, 0.1), median: quantile(likely, 0.5), p90: quantile(likely, 0.9), max: likely[likely.length - 1] }
      : null,
    bestEleven: xiList.length
      ? { projected: mean(xiList.map(x => x.projected)), actual: mean(xiList.map(x => x.actual)) }
      : null,
  };
}

export function runSeason(season, { gwFrom = 1, gwTo = 38 } = {}) {
  const priorName = previousSeason(season);
  const dataset = loadSeason(season);
  let prior = null;
  try { prior = priorName ? loadSeason(priorName) : null; } catch { prior = null; }
  if (!prior) return null;
  const rules = loadRules(season);
  const accumulator = createAccumulator(dataset, {});
  const preseasonTotals = preseasonTotalsFor(dataset, prior);
  const asset = priorSeasonAsset(dataset, prior, { firstDeadline: eventDeadlines(dataset).get(1) });
  const byGw = new Map();
  const last = Math.min(gwTo, dataset.maxGw);
  for (let gw = 1; gw <= last; gw++) {
    if (gw >= gwFrom) {
      const { gameState } = productionGameStateAt(dataset, gw, { rules, accumulator, preseasonTotals, asset });
      const strength = buildStrength(gameState, { asOfGw: gw });
      const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
      const rankable = new Set();
      for (const p of dataset.players.values()) {
        const now = accumulator.totalsFor(p.id);
        const last = preseasonTotals.get(p.id);
        if ((now && now.minutes > 0) || (last && last.minutes > 0)) rankable.add(p.id);
      }
      const rows = scoreDeadline({ dataset, gw, gameState, projections, rankable }).map(r => ({ ...r, season }));
      byGw.set(gw, { rows, xi: bestEleven(rows) });
    }
    accumulator.absorb(gw);
  }
  return { season, byGw };
}

function fmt(v, d = 2) {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}

function printSummary(label, s) {
  const e = s.everPresent;
  console.log(`\n${label}  (${s.players} player-gameweeks)`);
  console.log(`  ever-present starters  n=${e.n}  pStart ${fmt(e.pStart)} vs started ${fmt(e.started)} | pAppear ${fmt(e.pAppear)} vs appeared ${fmt(e.appeared)} | xMins ${fmt(e.xMins, 1)} vs ${fmt(e.minutes, 1)} | xP ${fmt(e.xPoints)} vs ${fmt(e.points)}`);
  for (const [pos, g] of Object.entries(s.everPresentByPosition)) {
    console.log(`    ${pos.padEnd(3)} n=${String(g.n).padStart(4)}  pStart ${fmt(g.pStart)} vs ${fmt(g.started)} | xP ${fmt(g.xPoints)} vs ${fmt(g.points)}`);
  }
  const r = s.rotation;
  console.log(`  rotation / fringe      n=${r.n}  pStart ${fmt(r.pStart)} vs ${fmt(r.started)} | pAppear ${fmt(r.pAppear)} vs ${fmt(r.appeared)} | xP ${fmt(r.xPoints)} vs ${fmt(r.points)}`);
  if (s.topQuintile) console.log(`  top projection quintile     xP ${fmt(s.topQuintile.xPoints)} vs ${fmt(s.topQuintile.points)}`);
  if (s.bottomQuintile) console.log(`  bottom projection quintile  xP ${fmt(s.bottomQuintile.xPoints)} vs ${fmt(s.bottomQuintile.points)}`);
  if (s.likelyStarters) {
    const l = s.likelyStarters;
    console.log(`  xP of likely starters (pStart>0.5): p10 ${fmt(l.p10)} median ${fmt(l.median)} p90 ${fmt(l.p90)} max ${fmt(l.max)}`);
  }
  if (s.bestEleven) console.log(`  best XI by projection: projected ${fmt(s.bestEleven.projected, 1)}, those eleven scored ${fmt(s.bestEleven.actual, 1)}`);
  console.log(`  log loss: start ${fmt(s.startLogLoss, 4)}, appear ${fmt(s.appearLogLoss, 4)} | rank correlation xP vs points (per deadline) ${fmt(s.rankCorrelation, 3)}`);
  const line = (label, comps) => console.log(`  ${label.padEnd(26)} ${Object.entries(comps).map(([k, v]) => `${k} ${fmt(v.projected)}/${fmt(v.actual)}`).join('  ')}`);
  line('components, ever-present', s.components.everPresent);
  line('components, top quintile', s.components.topQuintile);
  for (const [pos, comps] of Object.entries(s.components.byPosition)) line(`components, ${pos} who played`, comps);
  console.log(`  start calibration: ${s.startCalibration.map(c => `${c.bin} ${fmt(c.predicted)}/${fmt(c.observed)} (${c.n})`).join('; ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seasons = args.seasons || KNOWN_SEASONS;
  const results = [];
  for (const season of seasons) {
    const t0 = Date.now();
    const run = runSeason(season, { gwFrom: args.gwFrom, gwTo: args.gwTo });
    if (!run) {
      console.log(`${season}: skipped, no downloaded predecessor (production always has one)`);
      continue;
    }
    results.push(run);
    console.log(`${season}: replayed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const out = { generatedAt: new Date().toISOString(), buckets: {} };
  for (const [from, to] of BUCKETS) {
    if (to < args.gwFrom || from > args.gwTo) continue;
    const rows = [];
    const xis = [];
    for (const run of results) {
      for (const [gw, v] of run.byGw) {
        if (gw < from || gw > to) continue;
        rows.push(...v.rows);
        if (v.xi) xis.push(v.xi);
      }
    }
    if (!rows.length) continue;
    const s = summarize(rows, xis);
    out.buckets[`gw${from}-${to}`] = s;
    printSummary(`GW ${from}-${to}, seasons ${results.map(r => r.season).join(', ')}`, s);
  }
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(out, null, 1)}\n`);

  if (args.check) {
    // Per season, never pooled across seasons: a band a season breaks is a
    // finding, and pooling would let two seasons' errors cancel.
    let broken = 0;
    console.log('\ncalibration bands (scripts/lib/calibration-guard.mjs):');
    for (const run of results) {
      for (const [from, to] of BUCKETS) {
        const deadlines = [...run.byGw].filter(([gw]) => gw >= from && gw <= to).map(([, v]) => v.rows);
        if (!deadlines.length) continue;
        const violations = calibrationViolations(calibrationFacts(deadlines));
        const gated = from >= 2;
        if (gated) broken += violations.length;
        console.log(`  ${run.season} GW ${from}-${to}: ${violations.length ? 'BREAKS' : 'ok'}${gated ? '' : ' (not gated: see the header)'}`);
        for (const v of violations) console.log(`    ${v.code}: ${v.message}`);
      }
    }
    if (broken) process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
