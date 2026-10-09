#!/usr/bin/env node
// The two fixture-model candidates, measured on PREDICTION targets only:
//
//   1. ODDS BLEND. Expected goals w * odds + (1 - w) * model for the decided
//      gameweek, odds from football-data.co.uk pre-closing market averages
//      (scripts/fetch-odds.mjs) gated to those collected before the deadline
//      (odds.js fixtureOddsAtDeadline). w is fitted leave-one-season-out on the
//      Poisson log-likelihood of the observed team goals.
//   2. GOAL DISPERSION. The team goal count as Conway-Maxwell-Poisson with the
//      model's expected goals as its MEAN (fixtures.js goalCountVector). nu is
//      fitted leave-one-season-out by maximum likelihood of the observed goals.
//
// The model's expected goals are exactly what the replay's planner sees: the
// production evidence regime (productionGameStateAt) and buildStrength at each
// deadline, on the fixtures of the gameweek being decided as the calendar stood
// at that deadline. Nothing here reads planner points; they decide elsewhere
// (experiments/configs/odds-blend.mjs and goal-dispersion.mjs).
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-goal-model.mjs
//
// Writes apps/fpl-planner/.data/calibration/goal-model.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';

import { loadSeason, loadRules, previousSeason } from '../backtest.mjs';
import { DATA_DIR } from '../fetch-history.mjs';
import {
  createAccumulator, preseasonTotalsFor, priorSeasonAsset, eventDeadlines, productionGameStateAt,
} from '../../js/engine/backtest.js';
import { buildStrength } from '../../js/engine/strength.js';
import { expectedGoals, goalCountVector } from '../../js/engine/fixtures.js';
import { fixtureOddsAtDeadline, outcomeProbs } from '../../js/engine/odds.js';
import { loadReplayOdds } from '../lib/odds-football-data.mjs';

const TARGETS = ['2023-24', '2024-25', '2025-26'];
const OUT_FILE = path.join(DATA_DIR, 'calibration', 'goal-model.json');
const W_GRID = Array.from({ length: 21 }, (_, i) => i / 20);
const NU_GRID = Array.from({ length: 61 }, (_, i) => +(0.8 + i * 0.01).toFixed(2));
const CS_BINS = 10;

const LOG_FACT = [0];
for (let k = 1; k <= 40; k++) LOG_FACT[k] = LOG_FACT[k - 1] + Math.log(k);
const poissonLL = (k, lam) => k * Math.log(lam) - lam - LOG_FACT[Math.min(k, 40)];
const cmpLL = (k, mean, nu) => Math.log(Math.max(1e-300, goalCountVector(mean, nu, 60)[Math.min(k, 60)]));
const pZero = (mean, nu) => goalCountVector(mean, nu, 1)[0];

// One record per fixture of each decided gameweek.
function collect(season) {
  const dataset = loadSeason(season);
  const prior = loadSeason(previousSeason(season));
  const rules = loadRules(season);
  const accumulator = createAccumulator(dataset, {});
  const preseasonTotals = preseasonTotalsFor(dataset, prior);
  const asset = priorSeasonAsset(dataset, prior, { firstDeadline: eventDeadlines(dataset).get(1) });
  const oddsRows = loadReplayOdds(dataset, season);
  const actual = new Map(dataset.fixtures.map(f => [f.id, f]));
  const out = [];
  let withheld = 0;
  for (let gw = 1; gw <= dataset.maxGw; gw++) {
    const { gameState } = productionGameStateAt(dataset, gw, { rules, accumulator, preseasonTotals, asset });
    const strength = buildStrength(gameState, { asOfGw: gw });
    const gate = fixtureOddsAtDeadline(oddsRows, gameState, gw);
    withheld += gate.withheld.length;
    for (const f of gameState.fixtures) {
      if (f.event !== gw) continue;
      const a = actual.get(f.id);
      // Decided this week as the calendar stood, but played later: its goals
      // are not this deadline's target.
      if (!a || a.event !== gw || a.teamHScore === null) continue;
      const m = expectedGoals(strength, f.teamH, f.teamA);
      const o = gate.odds.get(f.id) || null;
      out.push({
        season, gw, id: f.id, mH: m.xGH, mA: m.xGA, oH: o ? o.xGH : null, oA: o ? o.xGA : null,
        market: o ? [o.pHomeMarket, o.pDrawMarket, o.pAwayMarket] : null,
        gH: a.teamHScore, gA: a.teamAScore,
      });
    }
    accumulator.absorb(gw);
  }
  return { records: out, withheld };
}

// Every team side as (mean, goals): two per fixture.
const sides = (recs, meanOf) => recs.flatMap(r => {
  const [h, a] = meanOf(r);
  return [{ mean: h, goals: r.gH }, { mean: a, goals: r.gA }];
});
const blendOf = (w) => (r) => [w * r.oH + (1 - w) * r.mH, w * r.oA + (1 - w) * r.mA];
const modelOf = (r) => [r.mH, r.mA];

function llPoisson(s) { return s.reduce((t, x) => t + poissonLL(x.goals, x.mean), 0); }
function llCmp(s, nu) { return s.reduce((t, x) => t + cmpLL(x.goals, x.mean, nu), 0); }

function argmax(grid, f) {
  let best = grid[0];
  let bestV = -Infinity;
  for (const g of grid) {
    const v = f(g);
    if (v > bestV) { bestV = v; best = g; }
  }
  return best;
}

// Clean sheets: a side keeps one when the OTHER side scores zero.
function cleanSheetMetrics(s, nu) {
  let brier = 0;
  let logLoss = 0;
  const bins = Array.from({ length: CS_BINS }, () => ({ n: 0, p: 0, o: 0 }));
  for (const x of s) {
    const p = pZero(x.mean, nu);
    const o = x.goals === 0 ? 1 : 0;
    brier += (p - o) ** 2;
    logLoss -= o ? Math.log(p) : Math.log(1 - p);
    const b = bins[Math.min(CS_BINS - 1, Math.floor(p * CS_BINS))];
    b.n++; b.p += p; b.o += o;
  }
  const n = s.length;
  let ece = 0;
  const table = bins.filter(b => b.n).map((b) => {
    ece += (b.n / n) * Math.abs(b.p / b.n - b.o / b.n);
    return { n: b.n, predicted: b.p / b.n, observed: b.o / b.n };
  });
  return { n, brier: brier / n, logLoss: logLoss / n, ece, bins: table };
}

function outcomeLogLoss(recs, meanOf) {
  let ll = 0;
  for (const r of recs) {
    const [h, a] = meanOf(r);
    const p = outcomeProbs(h, a);
    const res = r.gH > r.gA ? p.pWinHome : r.gH === r.gA ? p.pDraw : p.pWinAway;
    ll -= Math.log(res);
  }
  return ll / recs.length;
}

// Spearman rank correlation of two equal-length arrays.
function spearman(a, b) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - mean) * (rb[i] - mean);
    da += (ra[i] - mean) ** 2;
    db += (rb[i] - mean) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function main() {
  const t0 = Date.now();
  const bySeason = {};
  let withheldTotal = 0;
  for (const s of TARGETS) {
    const c = collect(s);
    bySeason[s] = c.records;
    withheldTotal += c.withheld;
    console.log(`${s}: ${c.records.length} fixtures decided and played that week, ${c.records.filter(r => r.oH !== null).length} with pre-deadline odds, ${c.withheld} withheld by the deadline gate (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // ---- 1. Odds blend ----------------------------------------------------
  const paired = (s) => bySeason[s].filter(r => r.oH !== null);
  const odds = { losO: {}, levels: {}, orderAgreement: {} };
  for (const held of TARGETS) {
    const train = TARGETS.filter(t => t !== held).flatMap(paired);
    const w = argmax(W_GRID, (g) => llPoisson(sides(train, blendOf(g))));
    const test = paired(held);
    const n = test.length * 2;
    const base = llPoisson(sides(test, modelOf));
    odds.losO[held] = {
      fittedW: w,
      sides: n,
      dllPerSideOddsVsModel: (llPoisson(sides(test, blendOf(1))) - base) / n,
      dllPerSideBlendVsModel: (llPoisson(sides(test, blendOf(w))) - base) / n,
      outcomeLogLoss: { model: outcomeLogLoss(test, modelOf), odds: outcomeLogLoss(test, blendOf(1)), blend: outcomeLogLoss(test, blendOf(w)) },
      cleanSheet: {
        model: cleanSheetMetrics(sides(test, modelOf), 1),
        odds: cleanSheetMetrics(sides(test, blendOf(1)), 1),
        blend: cleanSheetMetrics(sides(test, blendOf(w)), 1),
      },
    };
    const mm = test.reduce((t, r) => t + r.mH + r.mA, 0) / n;
    const om = test.reduce((t, r) => t + r.oH + r.oA, 0) / n;
    odds.levels[held] = { modelMeanXg: mm, oddsMeanXg: om, observedMeanGoals: test.reduce((t, r) => t + r.gH + r.gA, 0) / n };
    // Order: within each gameweek, does the market rank the sides' expected
    // goals the way the model does? A pure level change would read 1.000.
    const gws = new Map();
    for (const r of test) {
      if (!gws.has(r.gw)) gws.set(r.gw, []);
      gws.get(r.gw).push(r);
    }
    const rhos = [...gws.values()].filter(v => v.length >= 5).map(v => spearman(v.flatMap(r => [r.mH, r.mA]), v.flatMap(r => [r.oH, r.oA])));
    odds.orderAgreement[held] = { gameweeks: rhos.length, meanSpearman: rhos.reduce((t, x) => t + x, 0) / rhos.length };
  }
  odds.fullFitW = argmax(W_GRID, (g) => llPoisson(sides(TARGETS.flatMap(paired), blendOf(g))));

  // ---- 2. Goal dispersion -------------------------------------------------
  const dispersion = { loso: {} };
  for (const held of TARGETS) {
    const train = sides(TARGETS.filter(t => t !== held).flatMap(t => bySeason[t]), modelOf);
    const nu = argmax(NU_GRID, (g) => llCmp(train, g));
    const test = sides(bySeason[held], modelOf);
    dispersion.loso[held] = {
      fittedNu: nu,
      sides: test.length,
      dllPerSideCmpVsPoisson: (llCmp(test, nu) - llPoisson(test)) / test.length,
      cleanSheet: { poisson: cleanSheetMetrics(test, 1), cmp: cleanSheetMetrics(test, nu) },
    };
  }
  const allSides = sides(TARGETS.flatMap(t => bySeason[t]), modelOf);
  dispersion.fullFitNu = argmax(NU_GRID, (g) => llCmp(allSides, g));
  // The same fit on the market's means, for comparison with AIrsenal's 1.17.
  const oddsSides = sides(TARGETS.flatMap(paired), blendOf(1));
  dispersion.fullFitNuOnOddsMeans = argmax(NU_GRID, (g) => llCmp(oddsSides, g));

  const result = { generatedAt: new Date().toISOString(), targets: TARGETS, withheldByGate: withheldTotal, odds, dispersion, runtimeSeconds: (Date.now() - t0) / 1000 };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 1));

  const f4 = (x) => x.toFixed(4);
  console.log('\nODDS BLEND, held out (w fitted on the other two seasons)');
  for (const s of TARGETS) {
    const o = odds.losO[s];
    console.log(`${s} w=${o.fittedW.toFixed(2)} sides=${o.sides} dLL/side odds ${f4(o.dllPerSideOddsVsModel)} blend ${f4(o.dllPerSideBlendVsModel)} | 1X2 logloss model ${f4(o.outcomeLogLoss.model)} odds ${f4(o.outcomeLogLoss.odds)} blend ${f4(o.outcomeLogLoss.blend)} | CS Brier model ${f4(o.cleanSheet.model.brier)} odds ${f4(o.cleanSheet.odds.brier)} blend ${f4(o.cleanSheet.blend.brier)} | CS ECE model ${f4(o.cleanSheet.model.ece)} blend ${f4(o.cleanSheet.blend.ece)} | level model ${f4(odds.levels[s].modelMeanXg)} odds ${f4(odds.levels[s].oddsMeanXg)} observed ${f4(odds.levels[s].observedMeanGoals)} | order rho ${f4(odds.orderAgreement[s].meanSpearman)}`);
  }
  console.log(`full-fit w ${odds.fullFitW}`);
  console.log('\nGOAL DISPERSION, held out (nu fitted on the other two seasons)');
  for (const s of TARGETS) {
    const d = dispersion.loso[s];
    console.log(`${s} nu=${d.fittedNu} dLL/side CMP vs Poisson ${d.dllPerSideCmpVsPoisson.toFixed(5)} | CS Brier ${f4(d.cleanSheet.poisson.brier)} -> ${f4(d.cleanSheet.cmp.brier)} | logloss ${f4(d.cleanSheet.poisson.logLoss)} -> ${f4(d.cleanSheet.cmp.logLoss)} | ECE ${f4(d.cleanSheet.poisson.ece)} -> ${f4(d.cleanSheet.cmp.ece)}`);
    for (let i = 0; i < d.cleanSheet.poisson.bins.length; i++) {
      const p = d.cleanSheet.poisson.bins[i];
      console.log(`    poisson bin n=${String(p.n).padStart(4)} pred ${f4(p.predicted)} obs ${f4(p.observed)}`);
    }
    for (const c of d.cleanSheet.cmp.bins) console.log(`    cmp     bin n=${String(c.n).padStart(4)} pred ${f4(c.predicted)} obs ${f4(c.observed)}`);
  }
  console.log(`full-fit nu ${dispersion.fullFitNu} (on market means ${dispersion.fullFitNuOnOddsMeans})`);
  console.log(`\nwrote ${OUT_FILE} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
