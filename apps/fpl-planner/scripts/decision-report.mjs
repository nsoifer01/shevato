#!/usr/bin/env node
// DECISION QUALITY of a replayed strategy: what its captaincy and its transfers
// actually returned, not only how many points the season added up to.
//
// WHY THIS EXISTS
//
// Season points are what decide an experiment (experiments/registry.md), but
// a season total cannot say whether the captain was the squad's best player,
// whether a transfer beat the player it replaced, or how many free transfers
// were thrown away at the cap. The 2026-10-09 backend audit measured those
// with a throwaway wrapper around the replay; this is that probe promoted. The
// replay (js/engine/backtest.js) now records every gameweek's squad, eleven,
// bench order, captain, vice, transfers and free transfers in its report, so
// everything here is computed AFTER the fact from the report. Nothing wraps or
// alters a decision: the replays below are the same `runBacktest` call
// scripts/backtest.mjs makes, so season points match it exactly.
//
// METRICS, per season, strategy and seed:
//   - captain = the squad's top scorer that gameweek (ties count), captain in
//     the squad's top 3, captain points (the armband after vice succession,
//     single-counted) against the squad's best;
//   - transfers (Wildcard and Free Hit weeks excluded): count, the gain of each
//     over the next 1, 3 and 5 gameweeks (points of the player in minus the
//     player out, paired in the order the plan listed them, truncated at the
//     season's end), and the share with a positive 3-gameweek gain;
//   - bench points left on the bench, hits taken, their cost and their
//     realized gain (the replay's own `hitGain`, 5 gameweeks);
//   - weeks that started with 3+ free transfers, free transfers lost at the
//     cap (a non-chip week whose bank could not grow), and rolled weeks (a
//     non-chip week from gameweek 2 with no transfer).
//
// Usage:
//   node apps/fpl-planner/scripts/decision-report.mjs
//   node apps/fpl-planner/scripts/decision-report.mjs --seasons 2024-25 --strategies planner,greedy-xp --seeds 1,2,3
//   node apps/fpl-planner/scripts/decision-report.mjs --plan-options '{"transferOptions":{"hitMargin":2}}'
//   node apps/fpl-planner/scripts/decision-report.mjs --compare-plan-options '{"transferOptions":{"hitMargin":2}}' --no-chips
//   node apps/fpl-planner/scripts/decision-report.mjs --report apps/fpl-planner/.data/backtests/backtest-2024-25-gw1-38-v3.json
//
// --compare-plan-options B replays every cell a second time with planner
// options B (the first arm uses --plan-options, or none) and prints the paired
// differences B minus A. Seeds are averaged inside a season before the
// season-level statistics, the same rule experiment.mjs applies to windows.
// --metrics-from N scores captaincy and transfers from gameweek N only (the
// audit probe started at 2, because its wrapper saw no squad at gameweek 1).
// This is a decision-quality report, not the deciding instrument: a plan
// change is still measured with scripts/experiment.mjs.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runBacktest, loadSeason, KNOWN_SEASONS } from './backtest.mjs';

const HORIZONS = [1, 3, 5];
const DEFAULT_STRATEGIES = ['planner', 'greedy-xp'];

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const standardError = (a) => (a.length > 1
  ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length)
  : NaN);

function pointsIn(dataset, gw, id) {
  const gwMap = dataset.byGw.get(gw);
  const rows = gwMap ? gwMap.get(id) : null;
  return rows ? rows.reduce((s, r) => s + r.totalPoints, 0) : 0;
}

const TRANSFER_CHIPS = new Set(['wildcard', 'freehit']);

/**
 * Decision metrics for one replay, from its per-gameweek rows alone (each row
 * carrying the `decision` block the replay records) and the season's actual
 * points.
 *
 * @param {object} args
 * @param {Array<object>} args.gws        report.gws (or a saved report's `gameweeks`)
 * @param {object}        args.dataset    the season's dataset (actual points)
 * @param {object}        [args.totals]   the replay's totals (season points, hits, hit gain)
 * @param {number}        [args.fromGw]   first gameweek captaincy and transfers are scored from
 */
export function decisionMetrics({ gws, dataset, totals = null, fromGw = 1 }) {
  const maxGw = dataset.maxGw;
  const captainBest = [];
  const captainTop3 = [];
  const captainPoints = [];
  const squadBest = [];
  const gains = Object.fromEntries(HORIZONS.map(h => [h, []]));
  let weeksThreePlus = 0;
  let lostAtCap = 0;
  let rolled = 0;
  let missingDecision = 0;

  for (const g of gws) {
    const d = g.decision;
    if (!d) { missingDecision++; continue; }
    const chip = g.chip || null;
    const ftBefore = g.freeTransfers;
    if (Number.isFinite(ftBefore) && ftBefore >= 3) weeksThreePlus++;
    if (!chip && g.gw >= 2 && Number.isFinite(ftBefore)) {
      if (!g.transfers) rolled++;
      if (Number.isFinite(d.freeTransfersAfter)) {
        const banked = Math.max(0, ftBefore - (g.transfers || 0)) + 1;
        lostAtCap += Math.max(0, banked - d.freeTransfersAfter);
      }
    }
    if (g.gw < fromGw) continue;

    if (d.squad && d.squad.length) {
      const actual = d.squad.map(id => pointsIn(dataset, g.gw, id)).sort((a, b) => b - a);
      const c = pointsIn(dataset, g.gw, g.captain);
      captainPoints.push(c);
      squadBest.push(actual[0]);
      captainBest.push(c >= actual[0] ? 1 : 0);
      captainTop3.push(c >= actual[Math.min(2, actual.length - 1)] ? 1 : 0);
    }

    if (TRANSFER_CHIPS.has(chip)) continue;
    const ins = d.transfersIn || [];
    const outs = d.transfersOut || [];
    for (let i = 0; i < Math.min(ins.length, outs.length); i++) {
      for (const h of HORIZONS) {
        let s = 0;
        for (let k = 0; k < h && g.gw + k <= maxGw; k++) s += pointsIn(dataset, g.gw + k, ins[i]) - pointsIn(dataset, g.gw + k, outs[i]);
        gains[h].push(s);
      }
    }
  }

  const transferGain = Object.fromEntries(HORIZONS.map(h => [`gw${h}`, mean(gains[h])]));
  return {
    seasonPoints: totals ? totals.seasonPoints : gws.reduce((s, g) => s + (g.netPoints || 0), 0),
    gameweeks: gws.length,
    missingDecision,
    captain: {
      weeks: captainPoints.length,
      bestRate: mean(captainBest),
      top3Rate: mean(captainTop3),
      points: mean(captainPoints),
      squadBest: mean(squadBest),
    },
    transfers: {
      count: gains[1].length,
      gain: transferGain,
      sharePositive3: gains[3].length ? gains[3].filter(x => x > 0).length / gains[3].length : NaN,
    },
    benchPoints: gws.reduce((s, g) => s + (g.benchPoints || 0), 0),
    hits: totals ? totals.hits : gws.reduce((s, g) => s + (g.hits || 0), 0),
    hitPoints: totals ? totals.hitPoints : gws.reduce((s, g) => s + (g.hitCostPoints || 0), 0),
    hitGain: totals ? totals.hitGain : null,
    weeksThreePlusFt: weeksThreePlus,
    ftLostAtCap: lostAtCap,
    rolledWeeks: rolled,
  };
}

// The numbers a paired comparison differences, by name.
const PAIRED_KEYS = {
  seasonPoints: m => m.seasonPoints,
  captainPoints: m => m.captain.points,
  captainBestRate: m => m.captain.bestRate,
  transfers: m => m.transfers.count,
  transferGain3: m => m.transfers.gain.gw3,
  transferGain5: m => m.transfers.gain.gw5,
  benchPoints: m => m.benchPoints,
  hits: m => m.hits,
  ftLostAtCap: m => m.ftLostAtCap,
};

/**
 * Arm B minus arm A on identical (season, strategy, seed) cells. Seeds are
 * averaged inside a season first; the statistics are over seasons.
 *
 * @param {Array<{season, strategy, seed, metrics}>} a
 * @param {Array<{season, strategy, seed, metrics}>} b
 */
export function pairedComparison(a, b) {
  const key = c => `${c.season}|${c.strategy}|${c.seed}`;
  const byKey = new Map(a.map(c => [key(c), c]));
  const groups = new Map();
  for (const cb of b) {
    const ca = byKey.get(key(cb));
    if (!ca) continue;
    const g = `${cb.strategy}|${cb.season}`;
    if (!groups.has(g)) groups.set(g, { strategy: cb.strategy, season: cb.season, cells: [] });
    groups.get(g).cells.push({ seed: cb.seed, a: ca.metrics, b: cb.metrics });
  }
  const perSeason = [...groups.values()].map(({ strategy, season, cells }) => ({
    strategy,
    season,
    seeds: cells.map(c => c.seed),
    diff: Object.fromEntries(Object.entries(PAIRED_KEYS).map(([k, f]) => [k, mean(cells.map(c => f(c.b) - f(c.a)))])),
  }));
  const overall = {};
  for (const strategy of new Set(perSeason.map(p => p.strategy))) {
    const rows = perSeason.filter(p => p.strategy === strategy);
    overall[strategy] = Object.fromEntries(Object.keys(PAIRED_KEYS).map((k) => {
      const d = rows.map(r => r.diff[k]).filter(Number.isFinite);
      return [k, {
        n: d.length, mean: mean(d), se: standardError(d),
        wins: d.filter(x => x > 0).length, losses: d.filter(x => x < 0).length, ties: d.filter(x => x === 0).length,
      }];
    }));
  }
  return { perSeason, overall };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    seasons: null, strategies: DEFAULT_STRATEGIES, seeds: [1], planOptions: null, comparePlanOptions: null,
    chips: true, gwFrom: 1, gwTo: null, metricsFrom: 1, json: null, report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seasons') out.seasons = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--strategies') out.strategies = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--seeds') out.seeds = argv[++i].split(',').map(Number);
    else if (a === '--plan-options') out.planOptions = JSON.parse(argv[++i]);
    else if (a === '--compare-plan-options') out.comparePlanOptions = JSON.parse(argv[++i]);
    else if (a === '--no-chips') out.chips = false;
    else if (a === '--gw-from') out.gwFrom = Number(argv[++i]);
    else if (a === '--gw-to') out.gwTo = Number(argv[++i]);
    else if (a === '--metrics-from') out.metricsFrom = Number(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const pct = v => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '-');

const HEADER = '| season | strategy | seed | points | capt = best | capt top 3 | capt pts | best pts | transfers | gain 1 GW | gain 3 GW | gain 5 GW | positive over 3 | bench pts | hits (cost, gain) | weeks 3+ FT | FT lost at cap | rolled |';

function row({ season, strategy, seed, metrics: m }) {
  return `| ${season} | ${strategy} | ${seed} | ${m.seasonPoints} | ${pct(m.captain.bestRate)} | ${pct(m.captain.top3Rate)} | `
    + `${fmt(m.captain.points)} | ${fmt(m.captain.squadBest)} | ${m.transfers.count} | ${fmt(m.transfers.gain.gw1)} | `
    + `${fmt(m.transfers.gain.gw3)} | ${fmt(m.transfers.gain.gw5)} | ${pct(m.transfers.sharePositive3)} | ${m.benchPoints} | `
    + `${m.hits} (${m.hitPoints}, ${fmt(m.hitGain, 0)}) | ${m.weeksThreePlusFt} | ${m.ftLostAtCap} | ${m.rolledWeeks} |`;
}

function printTable(title, cells) {
  console.log(`\n### ${title}\n`);
  console.log(HEADER);
  console.log(`|${'---|'.repeat(18)}`);
  for (const c of cells) console.log(row(c));
}

async function runArm(args, planOptions, label) {
  const seasons = args.seasons || KNOWN_SEASONS;
  const cells = [];
  for (const season of seasons) {
    const dataset = loadSeason(season);
    for (const strategy of args.strategies) {
      for (const seed of args.seeds) {
        const t0 = Date.now();
        const report = await runBacktest({
          season, strategies: [strategy], seed, planOptions, chips: args.chips, gwFrom: args.gwFrom, gwTo: args.gwTo,
        });
        const totals = report.strategies[0].totals;
        const metrics = decisionMetrics({ gws: report.gameweeks, dataset, totals, fromGw: args.metricsFrom });
        cells.push({ season, strategy, seed, metrics, durationMs: Date.now() - t0 });
        console.error(`${label} ${season} ${strategy} seed ${seed}: ${metrics.seasonPoints} points, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
    }
  }
  return cells;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = { generatedAt: new Date().toISOString(), settings: { ...args } };

  if (args.report) {
    const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
    const dataset = loadSeason(report.season);
    const metrics = decisionMetrics({
      gws: report.gameweeks, dataset, totals: report.strategies[0].totals, fromGw: args.metricsFrom,
    });
    if (metrics.missingDecision) {
      console.log(`${metrics.missingDecision} gameweeks carry no decision block: the report predates decision recording.`);
    }
    const cell = { season: report.season, strategy: report.strategies[0].strategy, seed: report.settings.seed, metrics };
    printTable(`From ${args.report}`, [cell]);
    out.cells = [cell];
  } else {
    const a = await runArm(args, args.planOptions, 'A');
    out.cells = a;
    printTable(`Decision quality${args.planOptions ? `, plan options ${JSON.stringify(args.planOptions)}` : ''}${args.chips ? '' : ', chips off'}`, a);
    if (args.comparePlanOptions) {
      const b = await runArm(args, args.comparePlanOptions, 'B');
      out.compareCells = b;
      printTable(`Decision quality, plan options ${JSON.stringify(args.comparePlanOptions)}${args.chips ? '' : ', chips off'}`, b);
      const paired = pairedComparison(a, b);
      out.paired = paired;
      console.log('\n### Paired, B minus A, seeds averaged inside a season\n');
      const keys = Object.keys(PAIRED_KEYS);
      console.log(`| strategy | season | ${keys.join(' | ')} |`);
      console.log(`|---|---|${'---:|'.repeat(keys.length)}`);
      for (const p of paired.perSeason) console.log(`| ${p.strategy} | ${p.season} | ${keys.map(k => fmt(p.diff[k])).join(' | ')} |`);
      for (const [strategy, stats] of Object.entries(paired.overall)) {
        console.log(`| ${strategy} | mean (se) W/L/T | ${keys.map(k => `${fmt(stats[k].mean)} (${fmt(stats[k].se)}) ${stats[k].wins}/${stats[k].losses}/${stats[k].ties}`).join(' | ')} |`);
      }
    }
  }
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(out, null, 1)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
