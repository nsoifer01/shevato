#!/usr/bin/env node
// Chip decision calibration: what every chip evaluator saw at every historical
// deadline, what the chip would actually have returned, and how each timing
// rule would have done (registry entry 30).
//
// WHY THIS EXISTS
//
// The chip bars in engine/chips.js (bench boost 8 points, free hit 12, wildcard
// 12, triple captain a 2.5 margin) were written with the engine on 2026-08-12,
// each with a sentence of reasoning and no measurement, on projections that were
// later shown to be compressed and 20-30% low (registry entry 29). A full-season
// replay with chips on plays each chip once or twice a season, which is far too
// few decisions to calibrate anything on. This instrument instead replays the
// planner with chips OFF, so the squad path is the planner's ordinary one, and at
// every deadline records:
//
//   - what each chip evaluator would see for the squad the plan fields: the
//     bench and its projections, the captain, the estimated value of every later
//     legal week, the wildcard and free hit gains, and what the engine decided;
//   - what the gameweek then produced for that squad: the bench's actual points,
//     what auto-substitutions recovered, the armband's actual points.
//
// Bench boost and triple captain do not change the squad, so their value in ANY
// week along the path is observed rather than counterfactual, and a timing rule
// can be scored on every deadline of every replay instead of on the one week it
// happened to fire. Only information available at each deadline enters a rule:
// the production evidence regime rebuilds the payloads the app would have read,
// and outcomes are joined only to score a decision already taken.
//
// HOW `analyze` SCORES A RULE. Every chip window is cut into episodes that start
// every third gameweek (a manager arriving with the chip unspent at that point)
// and run to the window's end. A rule walks an episode's deadlines in order and
// plays the chip at the first one it accepts; the episode is worth what the chip
// then added (bench points for a bench boost, one more armband copy for a triple
// captain), or 0 when the rule never played it. Every fitted quantity (estimate
// bias, revision noise, the optimal-stopping curve) is fitted on the OTHER
// seasons and scored on the held-out one. "bad" counts episodes whose chip
// returned less than the average week of that episode, "regret" is the best week
// of the episode less the chosen one.
//
// The rules shipped before entry 30 are rebuilt from the recorded facts; on the
// two recordings made with that engine (analytic-1 and analytic-2, 684
// deadlines) the rebuild agrees with the old evaluator at every deadline.
//
//   node apps/fpl-planner/scripts/calibration/calibrate-chips.mjs record [--tree <label>] [--seeds 1,2,3] [--seasons ...]
//   node apps/fpl-planner/scripts/calibration/calibrate-chips.mjs analyze [--tree <label>]
//
// Records land in apps/fpl-planner/.data/calibration/chips-<label>/ (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadSeason, loadRules, previousSeason, KNOWN_SEASONS } from '../backtest.mjs';
import { DATA_DIR } from '../fetch-history.mjs';
import { replaySeason, EVIDENCE_REGIMES } from '../../js/engine/backtest.js';
import { evaluateChips, estimateXp, CHIP_PARAMS } from '../../js/engine/chips.js';
import { chipAvailableAt } from '../../js/engine/rules.js';
import { hitCost, transferStateOf } from '../../js/engine/transfer-state.js';

const HERE = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const mode = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : fallback;
};
const TREE = flag('tree', 'current');
const OUT_DIR = path.join(DATA_DIR, 'calibration', `chips-${TREE}`);

// The season's own chip catalogue, and the contiguous window of one chip
// instance that contains `gw` (two per season from 2025-26).
function windowOf(rules, chip, gw) {
  const w = rules.chips.find(c => c.name === chip && gw >= c.startEvent && gw <= c.stopEvent);
  return w ? { from: w.startEvent, to: w.stopEvent } : null;
}

function postTransferSquadState(squadState, plan, gameState, rules) {
  const selling = new Map(squadState.picks.map(p => [p.playerId, p.sellingTenths]));
  const picks = plan.squad.map((playerId, i) => {
    const player = gameState.players.get(playerId);
    const tenths = selling.has(playerId) ? selling.get(playerId) : (player ? player.nowCost : 0);
    return { playerId, slot: i + 1, multiplier: i < rules.starters ? 1 : 0, purchaseTenths: tenths, sellingTenths: tenths };
  });
  return {
    ...squadState,
    picks,
    bankTenths: plan.bankAfterTenths,
    transferState: null,
    freeTransfers: plan.freeTransfersAfter,
    chipsUsed: [],
  };
}

function benchFacts(projections, gameState, ids, gw) {
  return ids.map((id) => {
    const row = projections.get(id, gw);
    const p = gameState.players.get(id);
    return {
      id,
      xp: row ? row.xPoints : 0,
      pAppear: row ? row.pAppear : 0,
      pStart: row ? row.pStart : 0,
      fixtures: row && row.fixtures ? row.fixtures.length : 0,
      status: p ? p.status : null,
    };
  });
}

// The estimated value of every later week the chip is legal in, across the
// whole season: projections inside the horizon, the fixture-scaled estimate
// past it (what the pre-change evaluator compared against, and what a revision
// measurement needs).
function laterWeekValues({ rules, chip, gw, horizon, projections, gameState, ids, combine }) {
  const out = [];
  for (let g = gw + 1; g <= rules.totalEvents; g++) {
    if (!chipAvailableAt(rules, chip, g, [])) continue;
    const values = ids.map((id) => {
      const player = gameState.players.get(id);
      return player ? estimateXp(projections, gameState, player, g, gw, horizon) : 0;
    });
    out.push({ gw: g, value: combine(values) });
  }
  return out;
}

async function recordOne(season, seed) {
  const dataset = loadSeason(season);
  const priorName = previousSeason(season);
  const priorDataset = priorName ? loadSeason(priorName) : null;
  const chipRules = loadRules(season);
  const rules = { ...chipRules, chips: [] };
  const decisions = [];

  const onPlanBundle = async ({ gw, gameState, squadState, projections, bundle }) => {
    const plan = bundle.current;
    if (!plan || !plan.squad || plan.squad.length !== rules.squadSize) return;
    const horizon = projections.gwTo - gw + 1;
    const squad = postTransferSquadState(squadState, plan, gameState, chipRules);
    const evaluation = evaluateChips({ squadState: squad, projections, gameState, rules: chipRules, horizon, discount: 0.85 });
    const base = evaluation.baseline && evaluation.baseline.gws[0];
    const bb = evaluation.perChip.bboost;
    const tc = evaluation.perChip['3xc'];
    const benchIds = base ? [base.bench.gk, ...base.bench.order] : [];
    const bench = benchFacts(projections, gameState, benchIds, gw);
    const weak = bench.filter(b => !(b.pAppear >= CHIP_PARAMS.benchUsablePAppear)).length;
    const shared = { rules: chipRules, gw, horizon, projections, gameState };
    decisions.push({
      gw,
      plan: {
        transfers: plan.transferCount, hits: plan.hits,
        bench: [plan.bench.gk, ...plan.bench.order], captain: plan.captain, vice: plan.viceCaptain,
        xPointsGw: plan.xPointsGw,
      },
      bb: {
        window: windowOf(chipRules, 'bboost', gw),
        valueNow: base ? base.xPointsBench : 0,
        autosubXp: base ? base.xPointsAutosubs : 0,
        bench,
        sameBenchAsPlan: JSON.stringify(benchIds) === JSON.stringify([plan.bench.gk, ...plan.bench.order]),
        perGw: laterWeekValues({ ...shared, chip: 'bboost', ids: benchIds, combine: v => v.reduce((s, x) => s + x, 0) }),
        weak,
        // What the pre-change evaluator charged a later week: one transfer per
        // weak bench player, at the hit rate once free transfers run out.
        structureCost: hitCost(transferStateOf(squad, chipRules), weak, chipRules),
        engine: bb.available ? { status: bb.status, recommended: bb.recommended, netValue: bb.netValue } : null,
      },
      tc: {
        window: windowOf(chipRules, '3xc', gw),
        valueNow: base ? base.captainExtra : 0,
        captainXp: base ? base.captainExtra : 0,
        xPointsCaptaincy: base ? base.xPointsCaptaincy : 0,
        captain: base ? base.captain : null,
        perGw: laterWeekValues({ ...shared, chip: '3xc', ids: squad.picks.map(p => p.playerId), combine: v => Math.max(0, ...v) }),
        engine: tc.available ? { status: tc.status, recommended: tc.recommended, netValue: tc.netValue } : null,
      },
      wc: { window: windowOf(chipRules, 'wildcard', gw), gain: evaluation.perChip.wildcard.valueNow, recommended: evaluation.perChip.wildcard.recommended },
      fh: { window: windowOf(chipRules, 'freehit', gw), gain: evaluation.perChip.freehit.valueNow, recommended: evaluation.perChip.freehit.recommended },
    });
  };

  const report = await replaySeason({
    dataset, season, strategy: 'planner', rules,
    opts: { gwFrom: 1, gwTo: dataset.maxGw, seed, priorDataset, evidenceRegime: EVIDENCE_REGIMES.PRODUCTION, onPlanBundle },
  });
  const realized = new Map(report.gws.map(g => [g.gw, g]));
  for (const d of decisions) {
    const g = realized.get(d.gw);
    d.realized = g ? {
      benchPoints: g.benchPoints, autoSubPoints: g.autoSubPoints, captainBase: g.captainBase,
      captainExtra: g.captainExtra, points: g.points, netPoints: g.netPoints,
    } : null;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${season}-seed${seed}.json`);
  fs.writeFileSync(file, JSON.stringify({
    season, seed, tree: TREE, modelVersion: report.modelVersion, totalEvents: chipRules.totalEvents,
    chips: chipRules.chips, seasonPoints: report.totals.seasonPoints, hits: report.totals.hits,
    hitEfficiency: report.totals.hitEfficiency, decisions,
  }));
  console.log(`${season} seed ${seed}: ${decisions.length} deadlines, ${report.totals.seasonPoints} points, model ${report.modelVersion} -> ${file}`);
}

async function recordAll() {
  const seeds = (flag('seeds', '1,2,3')).split(',').map(Number);
  const seasons = flag('seasons') ? flag('seasons').split(',') : KNOWN_SEASONS.filter(s => KNOWN_SEASONS.includes(previousSeason(s)));
  const jobs = [];
  for (const season of seasons) for (const seed of seeds) jobs.push({ season, seed });
  await Promise.all(jobs.map(({ season, seed }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HERE, 'record-one', '--tree', TREE, '--season', season, '--seed', String(seed)], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${season} seed ${seed} exited ${code}`))));
  })));
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

// The horizon the engine plans over by default; a bench boost hold only looks
// at weeks inside it.
const NEAR_WEEKS = 5;
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
};
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const patience = (g, from) => Math.pow(CHIP_PARAMS.chipPatiencePerGw, Math.max(0, g - from));
const usable = d => d.bb.bench.every(b => b.pAppear >= CHIP_PARAMS.benchUsablePAppear);
const inWindow = (d, r, to) => r.gw > d.gw && r.gw <= to;

// The rules shipped before entry 30, rebuilt: the bench boost played at 8 points
// when this week beat every later legal week of the SEASON (patience-discounted,
// less the weak-bench structure cost); the triple captain when this week beat
// every later legal week by 2.5. Neither played the last week of a window.
const PRE_CHANGE = { benchBoostThreshold: 8, tripleCaptainMargin: 2.5 };
function bestLater(d, rows, cost = 0) {
  let best = -Infinity;
  for (const r of rows) best = Math.max(best, r.value * patience(r.gw, d.gw) - cost);
  return Number.isFinite(best) ? best : 0;
}
const preChangeBenchBoost = (d) => {
  const cost = d.bb.structureCost ?? d.bb.old.structureCost;
  return d.bb.valueNow >= PRE_CHANGE.benchBoostThreshold && d.bb.valueNow >= bestLater(d, d.bb.perGw, cost);
};
const preChangeTripleCaptain = d => d.tc.valueNow - bestLater(d, d.tc.perGw) >= PRE_CHANGE.tripleCaptainMargin;

// How far a later week's estimate is from the value that week has once it
// arrives, by distance: the bias of an estimate and the noise a decision has
// to see through.
function revisions(files, chip) {
  const byDistance = new Map();
  for (const file of files) {
    const at = new Map(file.decisions.map(d => [d.gw, d]));
    for (const d of file.decisions) {
      if (!d[chip].window) continue;
      for (const r of d[chip].perGw) {
        const later = at.get(r.gw);
        if (!later || r.gw > d[chip].window.to) continue;
        const k = r.gw - d.gw;
        if (!byDistance.has(k)) byDistance.set(k, []);
        byDistance.get(k).push(r.value - later[chip].valueNow);
      }
    }
  }
  const pool = test => [...byDistance].filter(([k]) => test(k)).flatMap(([, v]) => v);
  const near = pool(k => k < NEAR_WEEKS);
  const mid = pool(k => k >= NEAR_WEEKS && k <= 8);
  const far = pool(k => k > 8);
  const sdAt = k => sd(k < NEAR_WEEKS ? near : k <= 8 ? mid : far);
  return {
    nearBias: mean(near), nearSd: sd(near), nearN: near.length,
    midBias: mean(mid), midSd: sd(mid), midN: mid.length,
    farBias: mean(far), farSd: sd(far), farN: far.length,
    sdAt,
  };
}

function episodes(files, chip) {
  const out = [];
  for (const file of files) {
    const at = new Map(file.decisions.map(d => [d.gw, d]));
    const maxGw = Math.max(...file.decisions.map(d => d.gw));
    for (const w of file.chips.filter(c => c.name === chip)) {
      const to = Math.min(w.stopEvent, maxGw);
      for (let from = Math.max(2, w.startEvent); from <= to; from += 3) {
        const weeks = [];
        for (let g = from; g <= to; g++) if (at.get(g) && at.get(g).realized) weeks.push(at.get(g));
        if (weeks.length >= 2) out.push({ from, to, weeks });
      }
    }
  }
  return out;
}

// The optimal-stopping bar for a bench boost: with g(x) the linear fit of what
// a bench of projected x adds, V_0 = E[g(X)] and V_r = E[max(g(X), V_{r-1})],
// play with r weeks left once g(x) reaches V_r. REJECTED (see entry 30).
function stoppingBars(train) {
  const pts = [];
  for (const file of train) {
    for (const d of file.decisions) {
      if (d.realized && d.gw > 1 && usable(d)) pts.push([d.bb.valueNow, d.realized.benchPoints]);
    }
  }
  const mx = mean(pts.map(p => p[0]));
  const my = mean(pts.map(p => p[1]));
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  const g = x => a + b * x;
  const values = [mean(pts.map(p => g(p[0])))];
  for (let r = 1; r <= 40; r++) values.push(mean(pts.map(p => Math.max(g(p[0]), values[r - 1]))));
  return values.map(v => (v - a) / b);
}

const realizedOf = chip => d => (chip === 'bboost' ? d.realized.benchPoints : d.realized.captainExtra);

function play(ep, accept) {
  return ep.weeks.find(d => accept(d, { last: d.gw === ep.to, later: ep.to - d.gw, to: ep.to })) || null;
}

// A parameter chosen on the training seasons alone: the grid value whose rule
// realizes the most on their episodes. Scoring what it picks on the held-out
// season measures the selection, not a value seen in hindsight.
function chooseOnTraining(train, chip, grid, ruleFor) {
  const eps = episodes(train, chip);
  const value = realizedOf(chip);
  let best = null;
  for (const v of grid) {
    const accept = ruleFor(v);
    const m = mean(eps.map((ep) => {
      const chosen = play(ep, accept);
      return chosen ? value(chosen) : 0;
    }));
    if (best === null || m > best.m + 1e-9) best = { v, m };
  }
  return best.v;
}

function scoreRules(files, chip, rulesFor) {
  const value = realizedOf(chip);
  const key = chip === 'bboost' ? 'bb' : 'tc';
  const pooled = new Map();
  const fits = [];
  for (const season of [...new Set(files.map(f => f.season))]) {
    const train = files.filter(f => f.season !== season);
    const rev = revisions(train, key);
    const chosen = {};
    fits.push({ season, rev, chosen });
    const rules = rulesFor({ rev, train, chosen });
    for (const ep of episodes(files.filter(f => f.season === season), chip)) {
      const values = ep.weeks.map(value);
      for (const [label, accept] of Object.entries(rules)) {
        const week = play(ep, accept);
        if (!pooled.has(label)) pooled.set(label, []);
        pooled.get(label).push({
          season,
          value: week ? value(week) : 0,
          chosen: week,
          last: week !== null && week.gw === ep.to,
          average: mean(values),
          best: Math.max(...values),
        });
      }
    }
  }
  return { pooled, fits };
}

function printRules({ pooled, fits }) {
  for (const { season, rev, chosen } of fits) {
    const picks = Object.entries(chosen).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`    fitted without ${season}: near-week bias ${fmt(rev.nearBias)} and SD ${fmt(rev.nearSd)}; 5-8 weeks SD ${fmt(rev.midSd)}${picks ? `; chosen ${picks}` : ''}`);
  }
  const seasons = fits.map(f => f.season);
  console.log(`    ${'rule'.padEnd(62)} episodes   mean    se median  bad expired last regret  ${seasons.join('  ')}`);
  for (const [label, rows] of pooled) {
    const v = rows.map(r => r.value);
    const bySeason = seasons.map(s => fmt(mean(rows.filter(r => r.season === s).map(r => r.value))).padStart(7)).join('');
    console.log(`    ${label.padEnd(62)} ${String(rows.length).padStart(8)} ${fmt(mean(v)).padStart(6)} ${fmt(sd(v) / Math.sqrt(v.length)).padStart(5)} ${fmt(median(v)).padStart(6)} ${String(rows.filter(r => r.value < r.average).length).padStart(4)} ${String(rows.filter(r => !r.chosen).length).padStart(7)} ${String(rows.filter(r => r.last).length).padStart(4)} ${fmt(mean(rows.map(r => r.best - r.value))).padStart(6)} ${bySeason}`);
  }
}

function correlation(pairs) {
  const mx = mean(pairs.map(p => p[0]));
  const my = mean(pairs.map(p => p[1]));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function analyze() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`no recordings in ${OUT_DIR}; run record --tree ${TREE} first`);
    process.exit(2);
  }
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')));
  const deadlines = files.flatMap(f => f.decisions.filter(d => d.realized && d.gw > 1));
  const models = [...new Set(files.map(f => f.modelVersion))].join(', ');
  console.log(`chips-${TREE}: ${files.length} recordings, model ${models}, ${deadlines.length} scored deadlines`);

  console.log('\n== scale');
  const benchXp = deadlines.map(d => d.bb.valueNow);
  const captainXp = deadlines.map(d => d.tc.valueNow);
  const ready = deadlines.filter(usable);
  const notReady = deadlines.filter(d => !usable(d));
  console.log(`  bench xP median ${fmt(median(benchXp))} mean ${fmt(mean(benchXp))}; captain xP mean ${fmt(mean(captainXp))}`);
  console.log(`  bench xP against the points a boost added: r ${fmt(correlation(deadlines.map(d => [d.bb.valueNow, d.realized.benchPoints])))}`);
  console.log(`  a boost added ${fmt(mean(ready.map(d => d.realized.benchPoints)))} points with all four likely to play (${ready.length}), ${fmt(mean(notReady.map(d => d.realized.benchPoints)))} with one or more unlikely (${notReady.length})`);
  const bbRev = revisions(files, 'bb');
  const tcRev = revisions(files, 'tc');
  console.log(`  bench estimate less its week's value: under ${NEAR_WEEKS} weeks bias ${fmt(bbRev.nearBias)} SD ${fmt(bbRev.nearSd)} (${bbRev.nearN}); 5-8 weeks bias ${fmt(bbRev.midBias)} SD ${fmt(bbRev.midSd)} (${bbRev.midN}); 9+ weeks bias ${fmt(bbRev.farBias)} SD ${fmt(bbRev.farSd)} (${bbRev.farN})`);
  console.log(`  captain estimate less its week's value: under ${NEAR_WEEKS} weeks bias ${fmt(tcRev.nearBias)} SD ${fmt(tcRev.nearSd)} (${tcRev.nearN}); 5-8 weeks bias ${fmt(tcRev.midBias)} SD ${fmt(tcRev.midSd)} (${tcRev.midN}); 9+ weeks bias ${fmt(tcRev.farBias)} SD ${fmt(tcRev.farSd)} (${tcRev.farN})`);

  const engineRows = deadlines.filter(d => d.bb.engine);
  if (engineRows.length) {
    const agreeBb = engineRows.filter((d) => {
      const near = d.bb.perGw.filter(r => inWindow(d, r, d.bb.window.to) && r.gw - d.gw < NEAR_WEEKS);
      const last = d.gw === d.bb.window.to;
      const rule = last || (usable(d) && d.bb.valueNow >= CHIP_PARAMS.benchBoostBar
        && !near.some(r => r.value - d.bb.valueNow > CHIP_PARAMS.benchBoostHoldMargin));
      return rule === d.bb.engine.recommended;
    }).length;
    console.log(`  the engine's own bench boost decision agrees with the rule below at ${agreeBb} of ${engineRows.length} deadlines`);
  }

  console.log('\n== bench boost, held out by season');
  const bar = CHIP_PARAMS.benchBoostBar;
  printRules(scoreRules(files, 'bboost', ({ rev, train, chosen }) => {
    const near = (d, c) => d.bb.perGw.filter(r => inWindow(d, r, c.to) && r.gw - d.gw < NEAR_WEEKS);
    const holds = (d, c, margin) => near(d, c).some(r => r.value - d.bb.valueNow > margin);
    const gated = (d, u) => d.bb.bench.every(x => x.pAppear >= u);
    const engine = (b, margin, gate = CHIP_PARAMS.benchUsablePAppear, hold = true) => (d, c) => c.last
      || (gated(d, gate) && d.bb.valueNow >= b && (!hold || !holds(d, c, margin)));
    const T = stoppingBars(train);
    const rules = {
      'pre-change rule': preChangeBenchBoost,
      'first legal week': () => true,
      'ENGINE: bar 8, usable, hold at 4.7, last week': engine(bar, CHIP_PARAMS.benchBoostHoldMargin),
      'engine rule, bias + SD fitted on the other seasons': engine(bar, rev.nearBias + rev.nearSd),
      '  without the availability gate': engine(bar, rev.nearBias + rev.nearSd, 0),
      '  without the hold': engine(bar, 0, CHIP_PARAMS.benchUsablePAppear, false),
    };
    for (const u of [0.05, 0.2, 0.3, 0.7]) rules[`  gate at appearance probability ${u}`] = engine(bar, rev.nearBias + rev.nearSd, u);
    const hold = rev.nearBias + rev.nearSd;
    rules['  gate on the three outfield players only'] = (d, c) => c.last
      || (d.bb.bench.slice(1).every(x => x.pAppear >= CHIP_PARAMS.benchUsablePAppear) && d.bb.valueNow >= bar && !holds(d, c, hold));
    rules['  gate on expected appearances >= 3.25 of 4'] = (d, c) => c.last
      || (d.bb.bench.reduce((sum, x) => sum + x.pAppear, 0) >= 3.25 && d.bb.valueNow >= bar && !holds(d, c, hold));
    rules['REJECTED wait for two bench players with a double'] = (d, c) => c.last
      || (usable(d) && d.bb.valueNow >= bar && d.bb.bench.filter(x => x.fixtures >= 2).length >= 2 && !holds(d, c, hold));
    for (const b of [6, 7, 9, 10, 11, 12, 13, 14]) rules[`  bar ${b}`] = engine(b, rev.nearBias + rev.nearSd);
    chosen.bar = chooseOnTraining(train, 'bboost', [6, 7, 8, 9, 10, 11, 12, 13, 14], b => engine(b, rev.nearBias + rev.nearSd));
    rules['  bar chosen on the other seasons'] = engine(chosen.bar, rev.nearBias + rev.nearSd);
    chosen.hold = chooseOnTraining(train, 'bboost', [0, 1, 2, 3, 4, 5, 6, 8, 99], m => engine(bar, m));
    rules['  hold margin chosen on the other seasons'] = engine(bar, chosen.hold);
    rules['REJECTED save on a tie: beat every later window week by bias + SD'] = (d, c) => c.last || (usable(d) && d.bb.valueNow >= bar
      && d.bb.perGw.filter(r => inWindow(d, r, c.to)).every(r => d.bb.valueNow - (r.value - rev.nearBias) >= rev.nearSd));
    rules['REJECTED beat the mean of later window weeks'] = (d, c) => {
      const later = d.bb.perGw.filter(r => inWindow(d, r, c.to)).map(r => r.value - rev.nearBias);
      return c.last || (usable(d) && d.bb.valueNow >= (later.length ? mean(later) : 0));
    };
    rules['REJECTED optimal-stopping bar'] = (d, c) => c.last || (usable(d) && d.bb.valueNow >= T[Math.min(c.later, 40)]);
    return rules;
  }));

  console.log('\n== triple captain, held out by season');
  printRules(scoreRules(files, '3xc', ({ rev, train, chosen }) => {
    const beats = (d, c, margin, now = d.tc.valueNow) => d.tc.perGw
      .filter(r => inWindow(d, r, c.to))
      .every(r => now - r.value * patience(r.gw, d.gw) >= margin(r.gw - d.gw));
    const margins = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
    chosen.margin = chooseOnTraining(train, '3xc', margins, m => (d, c) => c.last || beats(d, c, () => m));
    const sweep = {};
    for (const m of margins) sweep[`  margin ${m}`] = (d, c) => c.last || beats(d, c, () => m);
    return {
      'pre-change rule': preChangeTripleCaptain,
      'ENGINE: window, margin 1.0, last week': (d, c) => c.last || beats(d, c, () => CHIP_PARAMS.tripleCaptainMargin),
      'engine rule, margin = 5-8 week SD fitted on the other seasons': (d, c) => c.last || beats(d, c, () => rev.midSd),
      '  margin by distance': (d, c) => c.last || beats(d, c, k => rev.sdAt(k)),
      '  margin 2.5 (pre-change)': (d, c) => c.last || beats(d, c, () => PRE_CHANGE.tripleCaptainMargin),
      '  with vice succession on this week\'s side': (d, c) => c.last || beats(d, c, () => rev.midSd, d.tc.xPointsCaptaincy),
      '  margin chosen on the other seasons': (d, c) => c.last || beats(d, c, () => chosen.margin),
      ...sweep,
    };
  }));

  console.log('\n== wildcard and free hit (the gain each evaluator reports, every deadline)');
  for (const [key, name, threshold] of [['wc', 'wildcard', CHIP_PARAMS.wildcardHorizonThreshold], ['fh', 'free hit', CHIP_PARAMS.freeHitThreshold]]) {
    const gains = deadlines.filter(d => d[key].window).map(d => d[key].gain);
    console.log(`  ${name}: mean gain ${fmt(mean(gains))}, median ${fmt(median(gains))}, at or above ${threshold}: ${fmt(100 * gains.filter(g => g >= threshold).length / gains.length, 1)}% of ${gains.length}`);
  }

  console.log('\n== hits in the chips-off replays');
  for (const f of files) console.log(`  ${f.season} seed ${f.seed}: ${f.seasonPoints} points, ${f.hits} hits, efficiency ${fmt(f.hitEfficiency)}`);
}

if (mode === 'record') await recordAll();
else if (mode === 'record-one') await recordOne(flag('season'), Number(flag('seed')));
else if (mode === 'analyze') analyze();
else {
  console.error('usage: calibrate-chips.mjs record|record-one|analyze [--tree label]');
  process.exit(2);
}
