#!/usr/bin/env node
// Run a control/candidate experiment on the instrument that decides, in
// parallel, and write down everything needed to believe the answer.
//
// WHY. registry.md ranks 45 paired trajectories as the deciding instrument and
// then argues almost every verdict in the file from a weaker one, because the
// strong instrument was a manual afternoon: freeze a copy of the tree, edit a
// constant, run ninety replays by hand, transcribe the totals. That is how a
// project ends up with three verdicts that are void, wrong or under suspicion.
// This script makes the strong instrument a single command that finishes in
// minutes on ten cores, so there is no longer a reason to decide on a weak one.
//
// WHAT IT GUARANTEES, and each of these is a mistake this project has already
// made at least once:
//
//   1. Control and candidate run on ONE tree. The engine, the scripts and the
//      season data are fingerprinted before the run and again after it, and a
//      run whose fingerprint moved is reported as void rather than reported.
//   2. Control is re-measured every time. There is no stored baseline to
//      compare against and no way to ask for one.
//   3. Arms differ ONLY in the arm definition. Same seeds, same windows, same
//      rules object, same datasets, same code.
//   4. The split is reported with the total: wins, losses, ties, per season,
//      per trajectory, plus the standard error and the caveat that overlapping
//      windows make it optimistic.
//
// Usage:
//   node apps/fpl-planner/scripts/experiment.mjs --config <file.mjs|file.json>
//   node apps/fpl-planner/scripts/experiment.mjs --config x.mjs --instrument windows
//   node apps/fpl-planner/scripts/experiment.mjs --config x.mjs --dry-run
//
// A config is an object (JSON, or an .mjs with a default export):
//
//   {
//     name: 'availability-signal',
//     question: 'Does the historical injury signal win points?',
//     instrument: 'paired',            // paired | windows | seasons
//     strategy: 'planner',             // any key of STRATEGIES
//     arms: [
//       { name: 'control',   description: 'shipped behaviour' },
//       { name: 'candidate', description: 'availability on', env: { FPL_AVAILABILITY: '1' } },
//     ],
//   }
//
// An arm may carry `env` (environment applied around its cells) and `opts`
// (merged into the replay options). One arm MUST be named "control".

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { INSTRUMENTS, buildCells, pairArms, formatReport, CONTROL_ARM } from '../js/engine/experiment.js';
import { DATA_DIR, seasonPath } from './fetch-history.mjs';
import { previousSeason, KNOWN_SEASONS } from './backtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..');
const WORKER = path.join(HERE, 'experiment-worker.mjs');
const OUT_ROOT = path.join(DATA_DIR, 'experiments');

// Ten cores means eight workers: one is left for the orchestrator and one for
// the machine, and oversubscribing measurably slows the whole run.
const DEFAULT_WORKERS = Math.max(1, Math.min(8, os.cpus().length - 2));

// ---------------------------------------------------------------------------
// Fingerprint: what "the same tree" means, made checkable
// ---------------------------------------------------------------------------

function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const file of files.slice().sort()) {
    h.update(path.basename(file));
    h.update(fs.readFileSync(file));
  }
  return h.digest('hex').slice(0, 12);
}

function gitState() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
    return { head, dirty: status.length > 0 };
  } catch {
    return { head: 'unknown', dirty: false };
  }
}

export function fingerprint(seasons) {
  const engineDir = path.join(APP_DIR, 'js', 'engine');
  const engineFiles = fs.readdirSync(engineDir).filter(f => f.endsWith('.js')).map(f => path.join(engineDir, f));
  const scriptFiles = ['backtest.mjs', 'experiment.mjs', 'experiment-worker.mjs', 'fetch-history.mjs']
    .map(f => path.join(HERE, f))
    .filter(f => fs.existsSync(f));

  const dataFiles = [];
  for (const season of seasons) {
    for (const s of [season, previousSeason(season)]) {
      const file = s && seasonPath(s);
      if (file && fs.existsSync(file) && !dataFiles.includes(file)) dataFiles.push(file);
    }
  }

  const git = gitState();
  return {
    engine: hashFiles([...engineFiles, ...scriptFiles]),
    data: `${dataFiles.length} season files, ${hashFiles(dataFiles)}`,
    git: git.head,
    dirty: git.dirty,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`No such config: ${abs}`);
  if (abs.endsWith('.json')) return JSON.parse(await fsp.readFile(abs, 'utf8'));
  const mod = await import(pathToFileURL(abs).href);
  return mod.default || mod.config;
}

export function resolveConfig(raw, overrides = {}) {
  const instrumentKey = overrides.instrument || raw.instrument || 'paired';
  const instrument = INSTRUMENTS[instrumentKey];
  if (!instrument) {
    throw new Error(`Unknown instrument "${instrumentKey}". Known: ${Object.keys(INSTRUMENTS).join(', ')}`);
  }

  const config = {
    name: raw.name || 'unnamed',
    question: raw.question || null,
    instrument: instrument.key,
    instrumentLabel: instrument.label,
    instrumentRank: instrument.rank,
    seasons: overrides.seasons || raw.seasons || KNOWN_SEASONS,
    windows: raw.windows || instrument.windows,
    seeds: overrides.seeds || raw.seeds || instrument.seeds,
    chips: raw.chips === undefined ? instrument.chips : raw.chips,
    strategy: raw.strategy || 'planner',
    horizon: raw.horizon === undefined ? null : raw.horizon,
    risk: raw.risk || 'balanced',
    poolSize: raw.poolSize || null,
    usePrior: raw.usePrior !== false,
    arms: raw.arms,
  };

  if (!Array.isArray(config.arms) || !config.arms.length) {
    throw new Error('A config needs an `arms` array with at least a control arm.');
  }
  if (!config.arms.some(a => a.name === CONTROL_ARM)) {
    throw new Error(`One arm must be named "${CONTROL_ARM}".`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

function runPool({ cells, config, workers, onProgress }) {
  return new Promise((resolve, reject) => {
    const armByName = new Map(config.arms.map(a => [a.name, a]));
    const queue = cells.slice();
    const results = [];
    const failures = [];
    const children = [];
    let done = 0;

    const finish = () => {
      for (const child of children) child.kill();
      if (failures.length) {
        reject(new Error(
          `${failures.length} of ${cells.length} cells failed. First: ${failures[0].id}\n${failures[0].message}`,
        ));
        return;
      }
      resolve(results);
    };

    const feed = (child) => {
      const cell = queue.shift();
      if (!cell) {
        child.busy = false;
        if (children.every(c => !c.busy)) finish();
        return;
      }
      child.busy = true;
      child.send({ type: 'cell', cell, config, arm: armByName.get(cell.arm) });
    };

    const count = Math.max(1, Math.min(workers, cells.length));
    for (let i = 0; i < count; i++) {
      const child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.busy = false;
      children.push(child);
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          feed(child);
          return;
        }
        if (msg.type === 'result') {
          results.push(msg.result);
          done++;
          if (onProgress) onProgress({ done, total: cells.length, result: msg.result });
          feed(child);
          return;
        }
        if (msg.type === 'error') {
          failures.push(msg);
          done++;
          if (onProgress) onProgress({ done, total: cells.length, failure: msg });
          feed(child);
        }
      });
      child.on('error', err => failures.push({ id: 'fork', message: err.message }));
      child.on('exit', (code) => {
        if (code !== 0 && code !== null && child.busy) {
          failures.push({ id: 'worker', message: `A worker exited with code ${code}` });
          child.busy = false;
          if (children.every(c => !c.busy)) finish();
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { config: null, dryRun: false, workers: DEFAULT_WORKERS, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rerender') out.rerender = path.resolve(argv[++i]);
    else if (arg === '--config') out.config = argv[++i];
    else if (arg === '--instrument') out.instrument = argv[++i];
    else if (arg === '--seasons') out.seasons = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--seeds') out.seeds = argv[++i].split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    else if (arg === '--workers') out.workers = Number(argv[++i]);
    else if (arg === '--out') out.outDir = path.resolve(argv[++i]);
    else if (arg === '--dry-run') out.dryRun = true;
    else throw new Error(`Unknown argument "${arg}"`);
  }
  if (!out.config && !out.rerender) throw new Error('Pass --config <file.mjs|file.json>');
  return out;
}

// Recompute the statistics and the report from a finished run's stored cells.
//
// The replays are the expensive part and their results are facts; how they are
// summarized is a methodology question that changes. When it does (the
// seed-averaged window statistic was added after the availability run finished)
// re-deriving beats re-running: the numbers cannot drift, because they are the
// same numbers.
async function rerender(file) {
  const stored = JSON.parse(await fsp.readFile(file, 'utf8'));
  const comparisons = pairArms(stored.results, { arms: stored.config.arms.map(a => a.name) });
  const report = formatReport({
    config: stored.config,
    comparisons,
    results: stored.results,
    fingerprint: stored.fingerprint,
    runtimeMs: stored.runtimeMs,
  });
  const out = file.replace(/results-(.*)\.json$/, 'report-$1.md');
  await fsp.writeFile(out, `${report}\n`);
  await fsp.writeFile(file, `${JSON.stringify({ ...stored, comparisons }, null, 2)}\n`);
  console.log(report);
  console.log(`\nRe-rendered from ${path.basename(file)} (no replay was re-run).`);
  console.log(`Report: ${out}`);
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main(argv) {
  const args = parseArgs(argv);
  if (args.rerender) return rerender(args.rerender);
  const config = resolveConfig(await loadConfig(args.config), args);
  const cells = buildCells(config);

  console.log(`Experiment: ${config.name}`);
  if (config.question) console.log(`Question:   ${config.question}`);
  console.log(`Instrument: ${config.instrumentLabel}`);
  console.log(`Arms:       ${config.arms.map(a => a.name).join(', ')}`);
  console.log(`Cells:      ${cells.length} replays (${config.seasons.length} seasons x ${config.windows.length} windows x ${config.seeds.length} seeds x ${config.arms.length} arms)`);
  console.log(`Workers:    ${args.workers}`);

  for (const season of config.seasons) {
    if (!fs.existsSync(seasonPath(season))) {
      throw new Error(
        `No historical data for ${season}.\n\n  node apps/fpl-planner/scripts/fetch-history.mjs ${season}`,
      );
    }
  }

  const before = fingerprint(config.seasons);
  console.log(`Tree:       engine ${before.engine}, git ${before.git}${before.dirty ? ' (dirty working tree)' : ''}`);
  console.log(`Data:       ${before.data}`);
  console.log('');

  if (args.dryRun) {
    for (const cell of cells) console.log(`  ${cell.id}`);
    return;
  }

  const started = Date.now();
  const results = await runPool({
    cells,
    config,
    workers: args.workers,
    onProgress: ({ done, total, result, failure }) => {
      const elapsed = (Date.now() - started) / 1000;
      const eta = done ? (elapsed / done) * (total - done) : 0;
      if (failure) {
        console.log(`  [${String(done).padStart(3)}/${total}] FAILED ${failure.id}: ${failure.message}`);
        return;
      }
      console.log(
        `  [${String(done).padStart(3)}/${total}] ${result.id.padEnd(42)} ${String(result.points).padStart(5)} points`
        + `  (${(result.durationMs / 1000).toFixed(1)}s, eta ${Math.round(eta)}s)`,
      );
    },
  });
  const runtimeMs = Date.now() - started;

  // The tree must not have moved under the run. Every prior experiment in this
  // project that had to be voided was voided for a version of this.
  const after = fingerprint(config.seasons);
  if (after.engine !== before.engine || after.data !== before.data) {
    throw new Error(
      'The tree changed while the experiment was running, so control and candidate were not measured on the same code.\n'
      + `  engine ${before.engine} -> ${after.engine}\n  data   ${before.data} -> ${after.data}\n`
      + 'This result is void. Re-run it on a still tree.',
    );
  }

  const comparisons = pairArms(results, { arms: config.arms.map(a => a.name) });
  const report = formatReport({ config, comparisons, results, fingerprint: before, runtimeMs });

  const dir = args.outDir || path.join(OUT_ROOT, `${slug(config.name)}-${slug(config.instrument)}`);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(dir, `report-${stamp}.md`);
  const resultsPath = path.join(dir, `results-${stamp}.json`);
  await fsp.writeFile(reportPath, `${report}\n`);
  await fsp.writeFile(resultsPath, `${JSON.stringify({ config, fingerprint: before, runtimeMs, results, comparisons }, null, 2)}\n`);

  console.log('');
  console.log(report);
  console.log('');
  console.log(`Report:  ${reportPath}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Done in ${(runtimeMs / 1000).toFixed(1)}s.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
