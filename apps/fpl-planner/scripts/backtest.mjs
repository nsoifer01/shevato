#!/usr/bin/env node
// Replay a historical season through the real planner and write down what
// happened.
//
// WHAT THIS DOES
//   1. Loads a season of per-gameweek rows downloaded by fetch-history.mjs
//      (gitignored, never committed), plus the season before it, which seeds
//      every player's rates at gameweek 1 the way FPL itself carries last
//      season's totals into the new one.
//   2. Replays it gameweek by gameweek through js/engine/backtest.js, which
//      drives the actual planner: the same projections, lineup, captain,
//      transfer and chip code the app ships.
//   3. Runs the three baselines alongside it on identical data, so the only
//      difference between them is the decision rule.
//   4. Writes a VERSIONED report file and appends to an index. A report is
//      never overwritten, because a number you cannot go back to is a number
//      you cannot check.
//
// Reports are written under .data/ by default, which is gitignored: they are
// outputs of a specific machine and a specific dataset version, not source.
// Point --out somewhere else to keep one.
//
// Usage:
//   node apps/fpl-planner/scripts/backtest.mjs
//   node apps/fpl-planner/scripts/backtest.mjs --season 2023-24
//   node apps/fpl-planner/scripts/backtest.mjs --season 2024-25 --gw-from 1 --gw-to 10
//   node apps/fpl-planner/scripts/backtest.mjs --strategies planner,hold --horizon 3
//   node apps/fpl-planner/scripts/backtest.mjs --risk aggressive --seed 7 --no-prior
//
// Exits non-zero with the exact download command when the data is missing.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { buildDataset, replaySeason, compareStrategies, STRATEGIES, BACKTEST_VERSION } from '../js/engine/backtest.js';
import { PLANNER_PARAMS } from '../js/engine/planner.js';
import { DATA_DIR, seasonPath, identityPath } from './fetch-history.mjs';
import { buildIdentityIndex } from '../js/engine/player-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..');

export const REPORT_VERSION = 'backtest-report-1';
export const DEFAULT_REPORT_DIR = path.join(DATA_DIR, 'backtests');

const DEFAULT_SEASON = '2024-25';

// A replay with no --horizon runs the horizon the app ships with, so the report
// measures what a user actually gets. planner.js owns the number and the three
// season sweep behind it.
const DEFAULT_HORIZON = PLANNER_PARAMS.defaultHorizon;
// The seasons every experiment in experiments/registry.md is measured over:
// the three complete archives with the columns the model needs. 2025-26 is
// downloaded but in progress, and anything before 2022-23 has no xG, xA or
// starts at all (FINDINGS.md, "Historical data"). Exported because the
// experiment runner reports on the same three and there must be one list.
export const KNOWN_SEASONS = ['2022-23', '2023-24', '2024-25'];

// The primary strategy first, then the three baselines SPEC 14.2 asks for.
const DEFAULT_STRATEGIES = ['planner', 'hold', 'greedy-xp', 'fdr'];

// The rules the replay is scored under. The archive carries no game settings,
// so they come from the committed bootstrap fixture: squad size, club limit,
// budget, free-transfer cap, hit cost and the chip windows.
const RULES_FIXTURE = path.join(APP_DIR, 'tests', 'fixtures', 'bootstrap.json');

// ---------------------------------------------------------------------------

export function previousSeason(season) {
  const m = /^(\d{4})-(\d{2})$/.exec(season);
  if (!m) return null;
  const start = Number(m[1]) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function requireSeasonFile(season) {
  const file = seasonPath(season);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No historical data for ${season} at ${file}\n\n`
      + 'Download it first:\n'
      + `  node apps/fpl-planner/scripts/fetch-history.mjs ${season}\n\n`
      + `Files land in ${DATA_DIR}, which is gitignored on purpose.`,
    );
  }
  return file;
}

// The permanent-code table for a season, when it has been downloaded. Absent, a
// replay still runs and the cross-season prior seeding falls back to matching
// names, which is measurably worse and says so in the report rather than
// pretending it joined on an id.
function loadIdentity(season) {
  const file = identityPath(season);
  if (!fs.existsSync(file)) return null;
  return buildIdentityIndex(fs.readFileSync(file, 'utf8'), { season });
}

export function loadSeason(season) {
  const file = requireSeasonFile(season);
  const csv = fs.readFileSync(file, 'utf8');
  const dataset = buildDataset({ csv, season, identity: loadIdentity(season) });
  if (!dataset.maxGw || dataset.players.size === 0) {
    throw new Error(`The file for ${season} parsed to ${dataset.players.size} players and ${dataset.maxGw} gameweeks, which is not a season.`);
  }
  return dataset;
}

export function loadRules() {
  return buildRules(JSON.parse(fs.readFileSync(RULES_FIXTURE, 'utf8')));
}

// ---------------------------------------------------------------------------

export async function runBacktest({
  season = DEFAULT_SEASON,
  gwFrom = 1,
  gwTo = null,
  horizon = DEFAULT_HORIZON,
  risk = 'balanced',
  poolSize = undefined,
  seed = 1,
  strategies = DEFAULT_STRATEGIES,
  usePrior = true,
  rules = null,
  onProgress = null,
  modelPath = null,
} = {}) {
  const R = rules || loadRules();
  const dataset = loadSeason(season);

  // Optional, and refused unless it is provably leakage-free.
  //
  // The default replay uses analytic projections, because the shipped artifact
  // was trained across every season we hold and replaying one of them with it
  // would measure the model remembering the answer. Passing --model is how the
  // trained model's real contribution gets measured: train an artifact that
  // excludes the replayed season, then replay that season. The guard below is
  // what makes that safe, and it is deliberately a hard failure rather than a
  // warning, because a silently leaking backtest produces numbers that look
  // like a result.
  let model = null;
  if (modelPath) {
    const artifact = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const trainedOn = artifact.seasons || [];
    if (trainedOn.includes(season)) {
      throw new Error(
        `Refusing to replay ${season} with ${path.basename(modelPath)}: that artifact was trained on `
        + `[${trainedOn.join(', ')}], which includes the season being replayed. The result would be leakage, `
        + `not a measurement. Retrain excluding it, for example:\n`
        + `  node apps/fpl-planner/scripts/train-model.mjs --seasons ${trainedOn.filter(s => s !== season).join(',')}`,
      );
    }
    model = artifact;
  }

  const priorName = usePrior ? previousSeason(season) : null;
  const priorDataset = priorName && fs.existsSync(seasonPath(priorName)) ? loadSeason(priorName) : null;

  const lastGw = Math.min(gwTo || dataset.maxGw, dataset.maxGw);
  const opts = {
    gwFrom,
    gwTo: lastGw,
    horizon,
    risk,
    seed,
    priorDataset,
    model,
    ...(poolSize ? { poolSize } : {}),
  };

  const reports = [];
  for (const strategy of strategies) {
    if (!STRATEGIES[strategy]) {
      throw new Error(`Unknown strategy "${strategy}". Known strategies: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    if (onProgress) onProgress({ strategy, label: STRATEGIES[strategy].label });
    reports.push(await replaySeason({ dataset, season, strategy, rules: R, opts }));
  }

  const primary = reports[0];
  const baselines = reports.slice(1);

  return {
    version: REPORT_VERSION,
    engineVersion: BACKTEST_VERSION,
    generatedAt: new Date().toISOString(),
    season,
    priorSeason: priorDataset ? priorName : null,
    // Identical for every strategy (they share the dataset pair), so it is
    // recorded once, at the top, as a property of the data rather than of a
    // decision rule.
    priorJoin: primary.opts.priorJoin,
    dataset: {
      players: dataset.players.size,
      teams: dataset.teams.size,
      fixtures: dataset.fixtures.length,
      gameweeks: dataset.maxGw,
    },
    window: { gwFrom, gwTo: lastGw },
    settings: { horizon, risk, seed, poolSize: primary.opts.poolSize, strategies },
    comparison: baselines.length ? compareStrategies({ primary, baselines }) : null,
    strategies: reports.map(report => ({
      strategy: report.strategy,
      label: report.label,
      modelVersion: report.modelVersion,
      durationMs: report.durationMs,
      totals: report.totals,
    })),
    // The primary run keeps its per-gameweek detail, because "how" matters as
    // much as "how many" when a season goes wrong somewhere specific.
    gameweeks: primary.gws,
  };
}

// ---------------------------------------------------------------------------
// Versioned output. Same contract as the model artifacts: a new file every
// time, an index that grows, and a refusal to overwrite.
// ---------------------------------------------------------------------------

export async function writeReport(report, { dir = DEFAULT_REPORT_DIR } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.json');

  let index = { reports: [] };
  try {
    index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  } catch {
    // No index yet: this is the first report in this directory.
  }
  index.reports = index.reports || [];

  const version = (index.reports.length ? Math.max(...index.reports.map(r => r.version || 0)) : 0) + 1;
  const name = `backtest-${report.season}-gw${report.window.gwFrom}-${report.window.gwTo}-v${version}.json`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    throw new Error(`Refusing to overwrite an existing report: ${file}`);
  }

  const full = { ...report, version, file: name };
  await fsp.writeFile(file, `${JSON.stringify(full, null, 2)}\n`);

  const primary = full.strategies[0];
  index.reports.push({
    version,
    file: name,
    generatedAt: full.generatedAt,
    season: full.season,
    priorSeason: full.priorSeason,
    window: full.window,
    settings: full.settings,
    strategy: primary.strategy,
    seasonPoints: primary.totals.seasonPoints,
    meanGwPoints: primary.totals.meanGwPoints,
    aboveBaseline: full.comparison
      ? Object.fromEntries(Object.entries(full.comparison.aboveBaseline).map(([k, v]) => [k, v.delta]))
      : null,
  });
  index.updatedAt = full.generatedAt;
  await fsp.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  return { file, version };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    season: DEFAULT_SEASON,
    gwFrom: 1,
    gwTo: null,
    horizon: DEFAULT_HORIZON,
    risk: 'balanced',
    seed: 1,
    poolSize: undefined,
    strategies: DEFAULT_STRATEGIES,
    usePrior: true,
    outDir: DEFAULT_REPORT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--season') out.season = argv[++i];
    else if (arg === '--gw-from') out.gwFrom = Number(argv[++i]);
    else if (arg === '--gw-to') out.gwTo = Number(argv[++i]);
    else if (arg === '--horizon') out.horizon = Number(argv[++i]);
    else if (arg === '--risk') out.risk = argv[++i];
    else if (arg === '--seed') out.seed = Number(argv[++i]);
    else if (arg === '--pool-size') out.poolSize = Number(argv[++i]);
    else if (arg === '--strategies') out.strategies = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--no-prior') out.usePrior = false;
    else if (arg === '--out') out.outDir = path.resolve(argv[++i]);
    else if (arg === '--model') out.modelPath = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument "${arg}". Known seasons: ${KNOWN_SEASONS.join(', ')}`);
  }
  return out;
}

const points = n => (Math.round(n * 10) / 10).toFixed(1);

async function main(argv) {
  const args = parseArgs(argv);
  const started = Date.now();

  console.log(`Season:     ${args.season}   (from ${DATA_DIR})`);
  console.log(`Window:     gameweeks ${args.gwFrom} to ${args.gwTo || 'the end of the season'}`);
  console.log(`Settings:   horizon ${args.horizon}, risk ${args.risk}, seed ${args.seed}`);
  console.log(`Strategies: ${args.strategies.join(', ')}`);
  console.log(`Model:      ${args.modelPath ? path.basename(args.modelPath) : 'none (analytic projections, the leakage-free default)'}`);
  console.log('');

  const report = await runBacktest({
    ...args,
    onProgress: ({ strategy, label }) => process.stdout.write(`  replaying ${strategy.padEnd(10)} ${label}\n`),
  });

  console.log('');
  console.log(`Dataset:    ${report.dataset.players} players, ${report.dataset.teams} clubs, ${report.dataset.fixtures} fixtures, ${report.dataset.gameweeks} gameweeks`);
  console.log(`Prior:      ${report.priorSeason || 'none (players start the season with no history at all)'}`);
  const priorJoin = report.priorJoin;
  if (priorJoin) {
    const rungs = Object.entries(priorJoin.byRung).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(
      `Identity:   ${priorJoin.resolved} of ${priorJoin.candidates} players matched to ${report.priorSeason}`
      + ` (${rungs || 'none'}), ${priorJoin.newcomers} newcomers, ${priorJoin.collisions} refused as ambiguous`,
    );
  }
  console.log('');

  console.log('  strategy    label                                        points    mean    transfers  hits  chips');
  for (const entry of report.strategies) {
    const t = entry.totals;
    console.log(
      `  ${entry.strategy.padEnd(11)} ${entry.label.padEnd(44)} ${String(t.seasonPoints).padStart(6)}  ${points(t.meanGwPoints).padStart(6)}  ${String(t.transfers).padStart(9)}  ${String(t.hits).padStart(4)}  ${t.chips.length}`,
    );
  }
  console.log('');

  const primary = report.strategies[0];
  const totals = primary.totals;
  if (report.comparison) {
    console.log(`ABOVE BASELINE (${primary.label})`);
    for (const [key, above] of Object.entries(report.comparison.aboveBaseline)) {
      const sign = above.delta >= 0 ? '+' : '';
      console.log(`  vs ${key.padEnd(10)} ${above.label.padEnd(44)} ${sign}${above.delta} points  (${sign}${points(above.meanGwDelta)} per gameweek)`);
    }
    console.log('');
  }

  console.log(`SEASON (${primary.strategy})`);
  console.log(`  season points        ${totals.seasonPoints}   (gross ${totals.grossPoints}, hits -${totals.hitPoints})`);
  console.log(`  mean gameweek        ${points(totals.meanGwPoints)}`);
  console.log(`  best / worst         gameweek ${totals.bestGw.gw} with ${totals.bestGw.points}, gameweek ${totals.worstGw.gw} with ${totals.worstGw.points}`);
  console.log(`  captaincy value      ${points(totals.captaincyValue)} points above an average starter, ${totals.captainPoints} from the armband itself`);
  console.log(`  vice took over       ${totals.captainFromVice} times`);
  console.log(`  hits                 ${totals.hits} taken for ${totals.hitPoints} points, returning ${points(totals.hitGain)} (efficiency ${totals.hitEfficiency === null ? 'n/a, no hits taken' : points(totals.hitEfficiency)})`);
  console.log(`  bench and auto subs  ${totals.benchPoints} left on the bench, ${totals.autoSubs} substitutions worth ${totals.autoSubPoints}`);
  console.log(`  chip value           ${points(totals.chipPoints)} across ${totals.chips.length} chips`);
  for (const chip of totals.chips) {
    console.log(`    ${chip.chip.padEnd(9)} gameweek ${String(chip.gw).padStart(2)}   ${points(chip.value)}`);
  }
  console.log(`  projection bias      ${points(totals.projectionBias)} points per gameweek (positive means the model overprojected)`);
  console.log(`    like for like      ${points(totals.projectionBiasExAutosubs)} with auto-subs off the actual side, which is the calibration number`);
  console.log('');

  const written = await writeReport(report, { dir: args.outDir });
  console.log(`Report: ${written.file}`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
