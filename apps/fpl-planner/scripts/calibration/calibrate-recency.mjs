#!/usr/bin/env node
// Recent-form start model: fit and held-out evaluation.
//
// THE QUESTION (backend audit 2026-10-09, design weakness b1). The start model
// reads a player's season starts over his club's matches with last season as
// the prior, and nothing about the order those starts came in. On the archive,
// players with a season start rate of 0.7 or more who had NOT started any of
// their last three club gameweeks started the next one 0.39 to 0.49 of the
// time, against a season rate near 0.76; a player who has just lost his place
// is over-projected, which is exactly the sell-or-hold decision.
//
// WHAT IS PREDICTED. For every registered player whose club has exactly one
// fixture in gameweek g (doubles are left out: pStart there is per fixture with
// a congestion factor on top), whether he STARTED it.
//
// WHAT A PREDICTION MAY READ. The production-regime GameState at the gameweek
// g deadline (js/engine/backtest.js productionGameStateAt, the same payloads
// and previous-season asset the app resolves) and `player.recentGws`, his last
// three gameweeks before g with his club in action (attachRecentForm). The
// archive carries no injury flags, so every player counts as available.
//
// THE MODEL. A logistic correction ON TOP of the shipped start probability:
//
//   logit(p) = a + b * logit(base) + c * (recentShare - base) + d * startedLast
//              + e * benchedButUsed
//
// recentShare  starts over fixtures across the recent gameweeks
// startedLast  1 if he started in the most recent of them
// benchedButUsed share of the recent gameweeks he came off the bench (minutes
//              but no start)
//
// With no recent gameweeks the shipped probability is used unchanged.
//
// HOW IT IS SCORED. Leave-one-season-out over every season with a downloaded
// predecessor: fitted on the others, scored on the held-out one, log loss and
// calibration against the shipped probability on the same rows. Prediction
// metrics do not decide anything in this project (registry Methodology); this
// script exists to fit the coefficients the replay experiment then judges on
// planner points (experiments/configs/recency-start.mjs).
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-recency.mjs
//
// Writes apps/fpl-planner/.data/calibration/recency.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';

import { loadSeason, loadRules, previousSeason, KNOWN_SEASONS } from '../backtest.mjs';
import { DATA_DIR } from '../fetch-history.mjs';
import {
  createAccumulator, productionGameStateAt, priorSeasonAsset, preseasonTotalsFor, eventDeadlines, actualRows,
} from '../../js/engine/backtest.js';
import { projectMinutes, recencyFeatures } from '../../js/engine/minutes.js';
import { logisticRegression, predictLogistic } from '../../js/engine/ml.js';

const OUT = path.join(DATA_DIR, 'calibration', 'recency.json');
const EPS = 1e-4;
const clampP = (p) => (p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p);
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
const BUCKETS = [[2, 3], [4, 8], [9, 19], [20, 38]];

function rowsFor(season) {
  const priorName = previousSeason(season);
  let prior = null;
  try { prior = priorName ? loadSeason(priorName) : null; } catch { prior = null; }
  if (!prior) return null;
  const dataset = loadSeason(season);
  const rules = loadRules(season);
  const accumulator = createAccumulator(dataset, {});
  const preseasonTotals = preseasonTotalsFor(dataset, prior);
  const asset = priorSeasonAsset(dataset, prior, { firstDeadline: eventDeadlines(dataset).get(1) });
  const out = [];
  for (let gw = 1; gw <= dataset.maxGw; gw++) {
    if (gw >= 2) {
      const { gameState } = productionGameStateAt(dataset, gw, { rules, accumulator, preseasonTotals, asset });
      for (const player of gameState.players.values()) {
        const rows = actualRows(dataset, gw, player.id);
        if (rows.length !== 1) continue;
        const mins = projectMinutes(player, { gameState, gw, fixtureCount: 1 });
        const base = mins.pStart;
        const f = recencyFeatures(player, base);
        out.push({ season, gw, id: player.id, base, started: rows[0].starts > 0 ? 1 : 0, f });
      }
    }
    accumulator.absorb(gw);
  }
  return out;
}

const design = (r) => [logit(r.base), r.f.recentShare - r.base, r.f.startedLast, r.f.benchedButUsed];

function ll(p, y) {
  const q = clampP(p);
  return -(y ? Math.log(q) : Math.log(1 - q));
}

function score(rows, predict) {
  let n = 0;
  let base = 0;
  let model = 0;
  for (const r of rows) {
    n++;
    base += ll(r.base, r.started);
    model += ll(predict(r), r.started);
  }
  return { n, base: base / n, model: model / n };
}

function groupCalibration(rows, predict, filter) {
  const g = rows.filter(filter);
  if (!g.length) return null;
  const mean = (f) => g.reduce((s, r) => s + f(r), 0) / g.length;
  return { n: g.length, base: mean(r => r.base), model: mean(predict), started: mean(r => r.started) };
}

function main() {
  const seasons = KNOWN_SEASONS.filter((s) => previousSeason(s));
  const bySeason = new Map();
  for (const s of seasons) {
    const t0 = Date.now();
    const rows = rowsFor(s);
    if (!rows) continue;
    bySeason.set(s, rows);
    console.log(`${s}: ${rows.length} player-gameweeks (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const fitOn = (rows) => {
    const usable = rows.filter(r => r.f);
    return logisticRegression(usable.map(design), usable.map(r => r.started), { lambda: 1e-3 });
  };
  const predictWith = (model) => (r) => (r.f ? predictLogistic(model, design(r)) : r.base);

  const report = { seasons: {}, coefficients: null };
  for (const held of bySeason.keys()) {
    const train = [...bySeason].filter(([s]) => s !== held).flatMap(([, rows]) => rows);
    const model = fitOn(train);
    const test = bySeason.get(held);
    const predict = predictWith(model);
    const all = score(test, predict);
    const buckets = BUCKETS.map(([lo, hi]) => ({ lo, hi, ...score(test.filter(r => r.gw >= lo && r.gw <= hi), predict) }));
    const lostPlace = groupCalibration(test, predict, r => r.f && r.base >= 0.6 && r.f.recentStarts === 0 && r.f.recentFixtures >= 3);
    const benchedLast = groupCalibration(test, predict, r => r.f && r.base >= 0.6 && r.f.startedLast === 0);
    const nailed = groupCalibration(test, predict, r => r.f && r.base >= 0.6 && r.f.recentStarts === r.f.recentFixtures && r.f.recentFixtures >= 3);
    report.seasons[held] = { all, buckets, lostPlace, benchedLast, nailed, model: { intercept: model.intercept, weights: model.weights } };
    console.log(`\nheld out ${held}: log loss shipped ${all.base.toFixed(4)} -> recency ${all.model.toFixed(4)} (n=${all.n})`);
    for (const b of buckets) console.log(`  GW${b.lo}-${b.hi}: ${b.base.toFixed(4)} -> ${b.model.toFixed(4)} (n=${b.n})`);
    const line = (label, g) => g && console.log(`  ${label.padEnd(34)} n=${String(g.n).padStart(5)}  shipped ${g.base.toFixed(3)}  recency ${g.model.toFixed(3)}  started ${g.started.toFixed(3)}`);
    line('regular (pStart>=0.6), 0 of last 3', lostPlace);
    line('regular, did not start last', benchedLast);
    line('regular, started all of last 3', nailed);
  }
  const full = fitOn([...bySeason.values()].flat());
  report.coefficients = { intercept: full.intercept, weights: full.weights, features: ['logit(base)', 'recentShare - base', 'startedLast', 'benchedButUsed'] };
  console.log(`\nfull fit: intercept ${full.intercept.toFixed(4)}, weights ${full.weights.map(w => w.toFixed(4)).join(', ')}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

main();
