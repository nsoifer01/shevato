#!/usr/bin/env node
// One replay per message. Forked by scripts/experiment.mjs; never run directly.
//
// The worker owns exactly two pieces of state, and both are caches: the parsed
// season datasets and the rules object. Parsing a season costs about a second
// and a thirteen-gameweek replay costs twenty, so a worker that keeps its
// datasets between cells is roughly 5% faster and a worker that keeps them
// FOREVER runs out of memory. The cache is therefore bounded.
//
// Everything else is per-cell and derived from the message, so two cells in one
// worker cannot leak state into each other beyond the datasets they share, and
// a dataset is immutable once parsed.

import { replaySeason } from '../js/engine/backtest.js';
import { loadSeason, loadRules, previousSeason } from './backtest.mjs';

const DATASET_CACHE_MAX = 6;
const datasets = new Map();

function dataset(season) {
  if (datasets.has(season)) {
    const hit = datasets.get(season);
    datasets.delete(season);
    datasets.set(season, hit);
    return hit;
  }
  const loaded = loadSeason(season);
  datasets.set(season, loaded);
  while (datasets.size > DATASET_CACHE_MAX) datasets.delete(datasets.keys().next().value);
  return loaded;
}

let baseRules = null;
function rulesFor({ chips }) {
  if (!baseRules) baseRules = loadRules();
  return chips ? baseRules : { ...baseRules, chips: [] };
}

// A season with no downloaded predecessor seeds nothing, which is a different
// experiment from one that seeds everything. The runner reports which.
function priorFor(season, usePrior) {
  if (!usePrior) return null;
  const name = previousSeason(season);
  if (!name) return null;
  try {
    return dataset(name);
  } catch {
    return null;
  }
}

async function runCell({ cell, config, arm }) {
  const data = dataset(cell.season);
  const prior = priorFor(cell.season, config.usePrior !== false);
  const rules = rulesFor({ chips: config.chips });

  // Arm environment, applied around this cell only. FPL_AVAILABILITY is read
  // synchronously inside replaySeason, so a scoped assignment is enough and no
  // other cell can observe it: a worker runs one cell at a time.
  const saved = new Map();
  for (const [key, value] of Object.entries(arm.env || {})) {
    saved.set(key, process.env[key]);
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  try {
    const report = await replaySeason({
      dataset: data,
      season: cell.season,
      // An arm may swap the DECISION RULE rather than a parameter, which is how
      // "planner against greedy on the same trajectories" gets measured with
      // the same pairing as everything else.
      strategy: arm.strategy || config.strategy,
      rules,
      opts: {
        gwFrom: cell.window[0],
        gwTo: cell.window[1],
        horizon: config.horizon === null ? undefined : config.horizon,
        risk: config.risk,
        seed: cell.seed,
        priorDataset: prior,
        ...(config.poolSize ? { poolSize: config.poolSize } : {}),
        ...(arm.opts || {}),
      },
    });

    return {
      id: cell.id,
      trajectory: cell.trajectory,
      season: cell.season,
      window: cell.window,
      seed: cell.seed,
      arm: cell.arm,
      points: report.totals.seasonPoints,
      grossPoints: report.totals.grossPoints,
      transfers: report.totals.transfers,
      hits: report.totals.hits,
      chips: report.totals.chips.map(c => `${c.chip}@${c.gw}`),
      benchPoints: report.totals.benchPoints,
      captaincyValue: report.totals.captaincyValue,
      projectionBias: report.totals.projectionBias,
      priorJoin: report.opts.priorJoin
        ? { resolved: report.opts.priorJoin.resolved, candidates: report.opts.priorJoin.candidates }
        : null,
      availability: report.opts.availability ? report.opts.availability.matchedRecords : null,
      durationMs: report.durationMs,
    };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

process.on('message', (msg) => {
  if (msg.type === 'exit') {
    process.exit(0);
    return;
  }
  if (msg.type !== 'cell') return;
  runCell(msg)
    .then(result => process.send({ type: 'result', result }))
    .catch(err => process.send({
      type: 'error',
      id: msg.cell.id,
      cell: msg.cell,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    }));
});

process.send({ type: 'ready' });
