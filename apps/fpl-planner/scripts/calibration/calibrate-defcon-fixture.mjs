#!/usr/bin/env node
// Fixture-aware defensive contribution: fit and held-out evaluation.
//
// THE QUESTION (backend audit 2026-10-09, design weakness b3). A player's
// defensive-contribution count (clearances, blocks, interceptions and tackles,
// plus recoveries outside defence) is projected from his own per-90 rate and
// nothing about the opponent, while a side that is pinned back makes more of
// those actions. After the fact, defenders made 0.92 of their own average in
// matches whose xG against was under 0.75 and 1.04 above 2.25. Before kickoff
// the signal is the fixture model's expectation of the opponent's goals.
//
// THE CANDIDATE. The count's mean is scaled by the opponent's expected goals
// relative to what the player's club usually concedes (projections.js
// `defenceScale`, the factor saves already use), raised to a power beta:
//
//   lambda = rate * share * defenceScale ^ beta
//
// beta = 0 is the shipped model. Fitted by Poisson maximum likelihood of the
// actual action counts of outfield players who started, on the production-
// regime GameState at each deadline (js/engine/backtest.js), so only what the
// app holds at the deadline is read.
//
// HOW IT IS SCORED. Defensive contribution exists in the 2025-26 archive only,
// so there is one season: beta is fitted on gameweeks 2-19 and scored on 20-38
// (log likelihood of counts, Brier of the threshold award), and then fitted on
// the whole season for the experiment arm. One season is weak evidence; the
// replay experiment (experiments/configs/defcon-fixture.mjs) decides.
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-defcon-fixture.mjs
//
// Writes apps/fpl-planner/.data/calibration/defcon-fixture.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';

import { loadSeason, loadRules, previousSeason } from '../backtest.mjs';
import { DATA_DIR } from '../fetch-history.mjs';
import {
  createAccumulator, productionGameStateAt, priorSeasonAsset, preseasonTotalsFor, eventDeadlines, actualRows,
} from '../../js/engine/backtest.js';
import { buildStrength } from '../../js/engine/strength.js';
import { fixtureContext, baselineOpponentGoals } from '../../js/engine/fixtures.js';
import { playerRates, positionRatePriors } from '../../js/engine/projections.js';
import { poissonTail } from '../../js/engine/ml.js';

const SEASON = '2025-26';
const OUT = path.join(DATA_DIR, 'calibration', 'defcon-fixture.json');
const THRESHOLD = { 2: 10, 3: 12, 4: 12 };
const BETAS = [];
for (let b = -0.5; b <= 1.5001; b += 0.05) BETAS.push(Math.round(b * 100) / 100);

function lgamma(x) {
  // Stirling with corrections; x >= 1 here.
  if (x < 7) { let s = 0; while (x < 7) { s -= Math.log(x); x += 1; } return s + lgamma(x); }
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x) - 1 / (360 * x ** 3);
}

function collect() {
  const dataset = loadSeason(SEASON);
  const prior = loadSeason(previousSeason(SEASON));
  const rules = loadRules(SEASON);
  const accumulator = createAccumulator(dataset, {});
  const preseasonTotals = preseasonTotalsFor(dataset, prior);
  const asset = priorSeasonAsset(dataset, prior, { firstDeadline: eventDeadlines(dataset).get(1) });
  const rows = [];
  for (let gw = 1; gw <= dataset.maxGw; gw++) {
    if (gw >= 2) {
      const { gameState } = productionGameStateAt(dataset, gw, { rules, accumulator, preseasonTotals, asset });
      const strength = buildStrength(gameState, { asOfGw: gw });
      const priors = positionRatePriors(gameState);
      for (const player of gameState.players.values()) {
        if (player.position === 1) continue;
        const actual = actualRows(dataset, gw, player.id);
        if (actual.length !== 1 || !(actual[0].starts > 0) || !(actual[0].minutes > 0)) continue;
        const contexts = fixtureContext(gameState, strength, player.teamId, gw);
        if (contexts.length !== 1) continue;
        const oppBase = baselineOpponentGoals(strength, player.teamId);
        const scale = oppBase > 0 ? contexts[0].opponentXg / oppBase : 1;
        const rate = playerRates(player, { gameState, gw, priors }).defCon;
        if (!(rate > 0)) continue;
        const r = actual[0];
        const count = player.position === 2
          ? (r.cbit || 0) + (r.tackles || 0)
          : (r.cbit || 0) + (r.tackles || 0) + (r.recoveries || 0);
        rows.push({ gw, position: player.position, rate, share: r.minutes / 90, scale, count });
      }
    }
    accumulator.absorb(gw);
  }
  return rows;
}

function evaluate(rows, beta) {
  let ll = 0;
  let brier = 0;
  for (const r of rows) {
    const lam = r.rate * r.share * r.scale ** beta;
    ll += r.count * Math.log(lam) - lam - lgamma(r.count + 1);
    const p = poissonTail(THRESHOLD[r.position], lam);
    const y = r.count >= THRESHOLD[r.position] ? 1 : 0;
    brier += (p - y) ** 2;
  }
  return { ll: ll / rows.length, brier: brier / rows.length };
}

function best(rows) {
  let top = null;
  for (const beta of BETAS) {
    const e = evaluate(rows, beta);
    if (!top || e.ll > top.ll) top = { beta, ...e };
  }
  return top;
}

function main() {
  const rows = collect();
  const first = rows.filter(r => r.gw <= 19);
  const second = rows.filter(r => r.gw >= 20);
  const fitFirst = best(first);
  const heldShipped = evaluate(second, 0);
  const heldFitted = evaluate(second, fitFirst.beta);
  const full = best(rows);
  const byPosition = {};
  for (const pos of [2, 3, 4]) byPosition[pos] = best(rows.filter(r => r.position === pos));
  const out = {
    season: SEASON, n: rows.length,
    fittedOnFirstHalf: fitFirst,
    secondHalf: { n: second.length, shipped: heldShipped, fitted: heldFitted },
    fullSeason: full,
    byPosition,
  };
  console.log(`${SEASON}: ${rows.length} starts by outfield players`);
  console.log(`fit on GW2-19: beta ${fitFirst.beta}`);
  console.log(`held out GW20-38 (n=${second.length}): loglik/row shipped ${heldShipped.ll.toFixed(5)} -> ${heldFitted.ll.toFixed(5)}; award Brier ${heldShipped.brier.toFixed(5)} -> ${heldFitted.brier.toFixed(5)}`);
  console.log(`full season beta ${full.beta}; by position ${Object.entries(byPosition).map(([p, b]) => `${p}:${b.beta}`).join(' ')}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

main();
