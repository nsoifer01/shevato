#!/usr/bin/env node
// Score a stored model artifact against the historical test block.
//
// train-model.mjs writes the metrics it measured; this script RE-MEASURES them
// from the artifact's stored weights and the raw data, which is the check that
// the artifact is self contained and that nothing about the feature builder has
// drifted since it was written. A mismatch is reported as a failure, not as a
// footnote.
//
// Usage:
//   node apps/fpl-planner/scripts/evaluate-model.mjs
//   node apps/fpl-planner/scripts/evaluate-model.mjs --model fpl-planner-v1.json
//   node apps/fpl-planner/scripts/evaluate-model.mjs --split validation

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { metrics, calibratorFromJSON, linearPredict } from '../js/engine/ml.js';
import { ensureSeasons } from './fetch-history.mjs';
import {
  MODELS_DIR,
  FEATURE_NAMES,
  FEATURE_VERSION,
  buildDataset,
  splitRows,
  applyScaler,
} from './train-model.mjs';

// The reported and re-measured numbers should agree to floating point. Anything
// above this means the feature builder or the data changed under the artifact.
const AGREEMENT_TOLERANCE = 1e-6;

export async function loadArtifact(name) {
  if (name) return JSON.parse(await fs.readFile(path.join(MODELS_DIR, name), 'utf8'));
  const index = JSON.parse(await fs.readFile(path.join(MODELS_DIR, 'index.json'), 'utf8'));
  if (!index.models || !index.models.length) throw new Error('models/index.json lists no models. Run train-model.mjs first.');
  const latest = index.models.reduce((a, b) => (b.version > a.version ? b : a));
  return JSON.parse(await fs.readFile(path.join(MODELS_DIR, latest.file), 'utf8'));
}

function rebuildModel(stored) {
  if (!stored) return null;
  return {
    intercept: stored.intercept,
    weights: FEATURE_NAMES.map(n => stored.byFeature[n]),
  };
}

const sigmoid = (eta) => 1 / (1 + Math.exp(-Math.min(30, Math.max(-30, eta))));

function predictorFor(candidate) {
  if (candidate.kind === 'baseline') return null;
  const model = rebuildModel(candidate.weights);
  if (!model) return null;
  if (candidate.kind === 'poisson') {
    return (x) => Math.exp(Math.min(30, Math.max(-30, linearPredict(model, x))));
  }
  if (candidate.kind === 'logistic') {
    return (x) => sigmoid(linearPredict(model, x));
  }
  if (candidate.kind === 'hurdle') {
    const appear = rebuildModel(candidate.appearWeights);
    if (!appear) return null;
    return (x) => sigmoid(linearPredict(appear, x)) * linearPredict(model, x);
  }
  return (x) => linearPredict(model, x);
}

function fmt(v) {
  return typeof v === 'number' ? v.toFixed(4) : String(v);
}

function agreement(reported, measured) {
  if (measured === null) return 'not re-scorable';
  const gap = Math.abs(reported - measured);
  return gap <= AGREEMENT_TOLERANCE ? 'ok' : `MISMATCH (${gap.toExponential(2)})`;
}

async function main(argv) {
  let name = null;
  let splitName = 'test';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') name = argv[++i];
    else if (argv[i] === '--split') splitName = argv[++i];
  }

  const artifact = await loadArtifact(name);
  await ensureSeasons(artifact.seasons);

  // Re-scoring means rebuilding the features with TODAY'S builder. If the
  // artifact was written by a different one, every number below would be a
  // comparison between two different feature sets dressed up as a check. Refuse
  // instead of printing MISMATCH on every line and leaving the reader to guess
  // whether the model drifted or the builder did.
  if (artifact.featureVersion !== FEATURE_VERSION) {
    throw new Error(
      `${artifact.modelVersion} was built with feature version ${artifact.featureVersion}, `
      + `this checkout builds ${FEATURE_VERSION}.\n\n`
      + 'The artifact is still valid as a record of what was measured at the time. It just cannot\n'
      + 'be re-scored here, because the feature builder has changed since. Evaluate an artifact\n'
      + `built by this checkout instead:\n  node apps/fpl-planner/scripts/evaluate-model.mjs`,
    );
  }

  console.log(`Model:   ${artifact.modelVersion}`);
  console.log(`Trained: ${artifact.trainedAt}`);
  console.log(`Dataset: ${artifact.datasetVersion}   features: ${artifact.featureVersion}`);
  console.log(`Periods: train [${artifact.periods.train}]`);
  console.log(`         validation [${artifact.periods.validation}]`);
  console.log(`         test [${artifact.periods.test}]`);
  console.log('');

  const { rows } = buildDataset(artifact.seasons);
  const split = splitRows(rows, artifact.seasons);
  const target = split[splitName];
  if (!target) throw new Error(`Unknown split "${splitName}". Use train, validation or test.`);
  console.log(`Re-scoring the ${splitName} block: ${target.length} rows`);
  console.log('');

  const X = target.map(r => applyScaler(artifact.scaler, r.features));
  const yPoints = target.map(r => r.targetPoints);
  const yStart = target.map(r => r.targetStart);

  console.log('POINTS');
  console.log('  candidate                     reported RMSE  measured RMSE  reported MAE   measured MAE   check');
  for (const c of artifact.points.candidates) {
    const reported = c[splitName];
    const predict = predictorFor(c);
    let measured = null;
    if (c.kind === 'baseline') {
      measured = { rmse: metrics.rmse(yPoints, target.map(r => r.baselinePoints)), mae: metrics.mae(yPoints, target.map(r => r.baselinePoints)) };
    } else if (predict) {
      const pred = X.map(predict);
      measured = { rmse: metrics.rmse(yPoints, pred), mae: metrics.mae(yPoints, pred) };
    }
    console.log(
      `  ${c.name.padEnd(28)}  ${fmt(reported.rmse).padEnd(13)}  ${(measured ? fmt(measured.rmse) : '-').padEnd(13)}  `
      + `${fmt(reported.mae).padEnd(13)}  ${(measured ? fmt(measured.mae) : '-').padEnd(13)}  ${agreement(reported.rmse, measured ? measured.rmse : null)}`,
    );
  }
  console.log(`  winner: ${artifact.points.winner}  (baseline: ${artifact.points.baseline}, beats it on test: ${artifact.points.beatsBaselineOnTest})`);
  console.log('');

  console.log('STARTS');
  console.log('  candidate                     reported logLoss  measured logLoss  reported Brier  check');
  for (const c of artifact.starts.candidates) {
    const reported = c[splitName];
    const predict = predictorFor(c);
    let measured = null;
    if (c.kind === 'baseline') {
      const pred = target.map(r => r.baselineStartRate);
      measured = { logLoss: metrics.logLoss(yStart, pred), brier: metrics.brier(yStart, pred) };
    } else if (predict) {
      const pred = X.map(predict);
      measured = { logLoss: metrics.logLoss(yStart, pred), brier: metrics.brier(yStart, pred) };
    }
    console.log(
      `  ${c.name.padEnd(28)}  ${fmt(reported.logLoss).padEnd(16)}  ${(measured ? fmt(measured.logLoss) : '-').padEnd(16)}  `
      + `${fmt(reported.brier).padEnd(14)}  ${agreement(reported.logLoss, measured ? measured.logLoss : null)}`,
    );
  }
  console.log(`  winner: ${artifact.starts.winner}  (baseline: ${artifact.starts.baseline}, beats it on test: ${artifact.starts.beatsBaselineOnTest})`);
  console.log('');

  const winner = artifact.starts.candidates.find(c => c.name === artifact.starts.winner);
  const predict = predictorFor(winner);
  if (predict) {
    const raw = X.map(predict);
    const calibrator = calibratorFromJSON(artifact.startCalibratorJSON);
    const calibrated = raw.map(p => calibrator.predict(p));
    const before = metrics.calibrationBins(raw, yStart, 10);
    const after = metrics.calibrationBins(calibrated, yStart, 10);
    console.log('START CALIBRATION');
    console.log(`  ECE      ${before.ece.toFixed(4)} -> ${after.ece.toFixed(4)}`);
    console.log(`  max gap  ${before.maxGap.toFixed(4)} -> ${after.maxGap.toFixed(4)}`);
    console.log(`  logLoss  ${metrics.logLoss(yStart, raw).toFixed(4)} -> ${metrics.logLoss(yStart, calibrated).toFixed(4)}`);
    console.log(`  Brier    ${metrics.brier(yStart, raw).toFixed(4)} -> ${metrics.brier(yStart, calibrated).toFixed(4)}`);
    console.log('');
    console.log('  bin        n     predicted  observed');
    for (const b of after.bins) {
      if (!b.n) continue;
      console.log(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}  ${b.meanPredicted.toFixed(4).padStart(9)}  ${b.observedRate.toFixed(4).padStart(8)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
