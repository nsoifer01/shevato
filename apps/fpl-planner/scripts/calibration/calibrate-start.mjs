#!/usr/bin/env node
// A start calibrator fitted on the engine's own start probability: does one help?
//
// THE QUESTION (2026-10-09 pre-merge review, audit B15). The trained artifacts
// in models/ carry a calibrator fitted on the LOGISTIC start model's outputs,
// which the engine can no longer consume (minutes.js START_CALIBRATOR_INPUT).
// The honest re-test is a calibrator fitted on the quantity it would correct:
// minutes.js's base start probability, at each production-regime deadline.
//
// WHAT IS FITTED. Two calibrators, leave-one-season-out over every season with
// a downloaded predecessor, on single-fixture gameweeks (rows from
// calibrate-recency.mjs rowsFor, the same deadline rebuild):
//   bins   ml.js calibrate 'bins' (monotone binning, 20 bins)
//   platt  logistic on logit(p)
// Scored on the held-out season by log loss against the shipped probability,
// and by the top bins, where the calibration report found the model
// over-confident (0.94 predicted against 0.90 observed from gameweek 4).
//
// It writes the per-season held-out calibrators, tagged with the engine's
// input, for experiments/configs/start-calibration.mjs. Prediction metrics do
// not decide (registry Methodology); the replay experiment does.
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-start.mjs
//
// Writes apps/fpl-planner/.data/calibration/start-calibration.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';

import { KNOWN_SEASONS, previousSeason } from '../backtest.mjs';
import { DATA_DIR } from '../fetch-history.mjs';
import { calibrate } from '../../js/engine/ml.js';
import { START_CALIBRATOR_INPUT } from '../../js/engine/minutes.js';
import { rowsFor } from './calibrate-recency.mjs';

const OUT = path.join(DATA_DIR, 'calibration', 'start-calibration.json');
const EPS = 1e-4;
const clampP = (p) => (p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p);
const ll = (p, y) => -(y ? Math.log(clampP(p)) : Math.log(1 - clampP(p)));

function fit(rows, method) {
  return calibrate(rows.map(r => r.base), rows.map(r => r.started), method, { bins: 20 });
}

function topBin(rows, predict) {
  const g = rows.filter(r => r.base >= 0.9);
  const mean = (f) => g.reduce((s, r) => s + f(r), 0) / g.length;
  return { n: g.length, shipped: mean(r => r.base), calibrated: mean(r => predict(r.base)), started: mean(r => r.started) };
}

function main() {
  const bySeason = new Map();
  for (const s of KNOWN_SEASONS.filter(x => previousSeason(x))) {
    const rows = rowsFor(s);
    if (rows) bySeason.set(s, rows);
  }
  const out = { fittedOn: START_CALIBRATOR_INPUT, methods: {} };
  for (const method of ['bins', 'platt']) {
    const held = {};
    const calibrators = {};
    for (const season of bySeason.keys()) {
      const train = [...bySeason].filter(([s]) => s !== season).flatMap(([, rows]) => rows);
      const cal = fit(train, method);
      const test = bySeason.get(season);
      const shipped = test.reduce((s, r) => s + ll(r.base, r.started), 0) / test.length;
      const calibrated = test.reduce((s, r) => s + ll(cal.predict(r.base), r.started), 0) / test.length;
      held[season] = { n: test.length, shipped, calibrated, top: topBin(test, (p) => cal.predict(p)) };
      calibrators[season] = cal.toJSON();
      console.log(`${method} held out ${season}: log loss ${shipped.toFixed(4)} -> ${calibrated.toFixed(4)}; pStart>=0.9 n=${held[season].top.n} shipped ${held[season].top.shipped.toFixed(3)} calibrated ${held[season].top.calibrated.toFixed(3)} started ${held[season].top.started.toFixed(3)}`);
    }
    out.methods[method] = { heldOut: held, bySeason: calibrators };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

main();
